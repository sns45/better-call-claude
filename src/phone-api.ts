/**
 * Phone API
 * HTTP endpoints that spawned Claude Code sessions call via curl
 * Enables Claude to communicate with users during phone calls
 */

import { Hono } from "hono";
import type { PhoneCallManager } from "./phone-call.js";
import { ConversationManager, ChannelType, ConversationDirection, ConversationState } from "./conversation-manager.js";
import type { TaskExecutor } from "./task-executor.js";
import type { MessagingManager } from "./messaging.js";
import type { WhatsAppChatManager } from "./whatsapp-chat.js";

export interface PendingQuestion {
  resolve: (answer: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PhoneAPIConfig {
  phoneProvider: "telnyx" | "twilio";
  userPhoneNumber: string;
}

export interface PendingWhatsAppWait {
  resolve: (message: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createPhoneAPI(
  phoneCallManager: PhoneCallManager,
  conversationManager: ConversationManager,
  config: PhoneAPIConfig,
  getPublicUrl: () => string,
  taskExecutor?: TaskExecutor,
  messagingManager?: MessagingManager,
  whatsappChatManager?: WhatsAppChatManager,
) {
  const api = new Hono();
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingWhatsAppWaits = new Map<string, PendingWhatsAppWait>();

  /**
   * POST /api/ask/:conversationId
   * Speak to user and wait for their response (blocking)
   * Body: { "message": "What tech stack?" }
   * Returns: { "response": "React and Hono" }
   */
  api.post("/ask/:conversationId", async (c) => {
    const conversationId = c.req.param("conversationId");
    const { message } = await c.req.json();
    const publicUrl = getPublicUrl();

    console.error(`[PhoneAPI] Ask: ${message}`);

    const conversation = conversationManager.getConversation(conversationId);

    if (!conversation || conversation.state === "ended") {
      return c.json({
        response: "[user not on call - proceed with your best judgment or use defaults]",
        userOnCall: false
      });
    }

    // Create a promise that will resolve when user responds
    const responsePromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        pendingQuestions.delete(conversationId);
        resolve("[no response within 60s - user may have hung up, proceed with defaults]");
      }, 60000); // 60 second timeout

      pendingQuestions.set(conversationId, { resolve, timeout });
    });

    // Try to speak to user and gather response
    try {
      const gatherUrl = `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`;
      await phoneCallManager.speakToCall(
        conversation.providerConversationId,
        message,
        true,
        gatherUrl
      );
    } catch (error) {
      // Call may have ended - clean up and return
      console.error(`[PhoneAPI] Ask failed (call may have ended): ${error}`);
      pendingQuestions.delete(conversationId);
      conversationManager.updateState(conversationId, ConversationState.ENDED);
      return c.json({
        response: "[call ended - proceed with your best judgment or use defaults]",
        userOnCall: false
      });
    }

    // Wait for user's response (webhook will call resolveQuestion)
    const response = await responsePromise;

    return c.json({ response, userOnCall: true });
  });

  /**
   * POST /api/say/:conversationId
   * Speak to user without waiting for response
   * Body: { "message": "Working on it..." }
   */
  api.post("/say/:conversationId", async (c) => {
    const conversationId = c.req.param("conversationId");
    const { message } = await c.req.json();

    console.error(`[PhoneAPI] Say: ${message}`);

    const conversation = conversationManager.getConversation(conversationId);

    if (!conversation || conversation.state === "ended") {
      // User not on call - just acknowledge, message won't be delivered
      return c.json({ success: true, delivered: false, reason: "user not on call" });
    }

    try {
      await phoneCallManager.speakToCall(
        conversation.providerConversationId,
        message,
        false
      );
      return c.json({ success: true, delivered: true });
    } catch (error) {
      // Call may have ended
      console.error(`[PhoneAPI] Say failed (call may have ended): ${error}`);
      conversationManager.updateState(conversationId, ConversationState.ENDED);
      return c.json({ success: true, delivered: false, reason: "call ended" });
    }
  });

  /**
   * POST /api/complete/:conversationId
   * Report task completion - speaks if on call, calls back if not
   * Body: { "summary": "Created todo app in ./todo-app" }
   */
  api.post("/complete/:conversationId", async (c) => {
    const conversationId = c.req.param("conversationId");
    const { summary } = await c.req.json();
    const publicUrl = getPublicUrl();

    console.error(`[PhoneAPI] Complete: ${summary}`);

    // Record the completion summary for future follow-ups
    if (taskExecutor) {
      taskExecutor.recordCompletion(conversationId, summary);
    }

    const conversation = conversationManager.getConversation(conversationId);

    // Try to speak to user if they appear to be on call
    if (conversation && conversation.state !== "ended") {
      try {
        const gatherUrl = `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`;
        await phoneCallManager.speakToCall(
          conversation.providerConversationId,
          `I've finished. ${summary}. Is there anything else you'd like me to do?`,
          true,
          gatherUrl
        );
        return c.json({ delivered: "spoken" });
      } catch (error) {
        // Speaking failed - user probably hung up but we didn't get the status webhook
        // Fall through to callback
        console.error(`[PhoneAPI] Speak failed (user likely hung up): ${error}`);
        conversationManager.updateState(conversationId, ConversationState.ENDED);
      }
    }

    // User hung up (or speak failed) - call them back
    console.error(`[PhoneAPI] Initiating callback to ${config.userPhoneNumber}`);
    const newConversationId = crypto.randomUUID();

    // Link the callback conversation to the original so follow-ups have context
    if (taskExecutor) {
      taskExecutor.linkCallback(newConversationId, conversationId);
    }

    try {
      await phoneCallManager.initiateCall(
        config.userPhoneNumber,
        `Hi, this is Claude. I finished the task you requested. ${summary}. Would you like me to do anything else?`,
        `${publicUrl}/webhook/${config.phoneProvider}/status/${newConversationId}`,
        `${publicUrl}/webhook/${config.phoneProvider}/gather/${newConversationId}`
      );
      return c.json({ delivered: "callback", newConversationId, originalConversationId: conversationId });
    } catch (callError) {
      console.error(`[PhoneAPI] Callback failed: ${callError}`);
      return c.json({
        delivered: "failed",
        error: "Could not reach user",
        summary
      }, 500);
    }
  });

  /**
   * POST /api/call
   * Initiate a new call to the user
   * Body: { "message": "Hi, I have a question about your request..." }
   */
  api.post("/call", async (c) => {
    const { message } = await c.req.json();
    const publicUrl = getPublicUrl();

    console.error(`[PhoneAPI] Initiating call: ${message}`);

    const conversationId = crypto.randomUUID();

    // Create conversation record BEFORE initiating call to track the conversation
    conversationManager.createConversation(
      conversationId,
      ChannelType.VOICE,
      ConversationDirection.OUTBOUND,
      "", // Provider ID will be updated when call is initiated
      { to: config.userPhoneNumber }
    );

    await phoneCallManager.initiateCall(
      config.userPhoneNumber,
      message,
      `${publicUrl}/webhook/${config.phoneProvider}/status/${conversationId}`,
      `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`
    );

    return c.json({ conversationId });
  });

  /**
   * GET /api/status/:conversationId
   * Check if user is still on call
   */
  api.get("/status/:conversationId", (c) => {
    const conversationId = c.req.param("conversationId");
    const conversation = conversationManager.getConversation(conversationId);

    return c.json({
      conversationId,
      active: conversation && conversation.state !== "ended",
      state: conversation?.state || "not_found"
    });
  });

  /**
   * POST /api/sms
   * Send an SMS to the user
   * Body: { "message": "Here is the URL: https://..." }
   */
  api.post("/sms", async (c) => {
    const { message } = await c.req.json();

    console.error(`[PhoneAPI] SMS: ${message}`);

    if (!messagingManager) {
      return c.json({ success: false, error: "Messaging not configured" }, 500);
    }

    try {
      const messageId = await messagingManager.sendSMS(config.userPhoneNumber, message);
      return c.json({ success: true, messageId });
    } catch (error) {
      console.error(`[PhoneAPI] SMS failed: ${error}`);
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  /**
   * POST /api/whatsapp
   * Send a WhatsApp message to the user
   * Body: { "message": "Here is the URL: https://..." }
   */
  api.post("/whatsapp", async (c) => {
    const { message } = await c.req.json();

    console.error(`[PhoneAPI] WhatsApp: ${message}`);

    if (!messagingManager) {
      return c.json({ success: false, error: "Messaging not configured" }, 500);
    }

    try {
      const messageId = await messagingManager.sendWhatsApp(config.userPhoneNumber, message);
      // Track outbound assistant messages in chat history
      whatsappChatManager?.recordAssistantMessage(message);
      return c.json({ success: true, messageId });
    } catch (error) {
      console.error(`[PhoneAPI] WhatsApp failed: ${error}`);
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  /**
   * POST /api/whatsapp-wait
   * Wait for an incoming WhatsApp message from the user (blocking)
   * Body: { "timeout_ms": 300000 } (optional, default 5 minutes)
   * Returns: { "message": "user's message", "received": true }
   *
   * Use this to keep a Claude session alive and listen for WhatsApp messages.
   * Call in a loop to continuously handle WhatsApp messages.
   */
  api.post("/whatsapp-wait", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const timeoutMs = body.timeout_ms || 300000; // 5 minutes default

    console.error(`[PhoneAPI] WhatsApp-Wait: Waiting for message (timeout: ${timeoutMs}ms)`);

    // Generate a unique wait ID for this request
    const waitId = crypto.randomUUID();

    // Create a promise that resolves when a WhatsApp message arrives
    const messagePromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingWhatsAppWaits.delete(waitId);
        resolve(null);
      }, timeoutMs);

      pendingWhatsAppWaits.set(waitId, { resolve: (msg) => resolve(msg), timeout });
    });

    const message = await messagePromise;

    if (message) {
      console.error(`[PhoneAPI] WhatsApp-Wait: Received message: ${message.slice(0, 50)}...`);
      return c.json({ message, received: true });
    } else {
      console.error(`[PhoneAPI] WhatsApp-Wait: Timeout - no message received`);
      return c.json({ message: null, received: false, reason: "timeout" });
    }
  });

  /**
   * Resolve a pending question when user responds
   * Called by the gather webhook handler
   */
  function resolveQuestion(conversationId: string, answer: string): boolean {
    const pending = pendingQuestions.get(conversationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(answer);
      pendingQuestions.delete(conversationId);
      return true;
    }
    return false;
  }

  /**
   * Resolve a pending WhatsApp wait when user sends a message
   * Called by the WhatsApp webhook handler
   * Returns true if a wait was resolved
   */
  function resolveWhatsAppWait(message: string): boolean {
    // Resolve the first (oldest) pending wait
    const firstEntry = pendingWhatsAppWaits.entries().next();
    if (!firstEntry.done) {
      const [waitId, pending] = firstEntry.value;
      clearTimeout(pending.timeout);
      pending.resolve(message);
      pendingWhatsAppWaits.delete(waitId);
      console.error(`[PhoneAPI] Resolved WhatsApp wait ${waitId.slice(0, 8)} with message`);
      return true;
    }
    return false;
  }

  /**
   * Check if there's a pending WhatsApp wait
   */
  function hasPendingWhatsAppWait(): boolean {
    return pendingWhatsAppWaits.size > 0;
  }

  return { api, resolveQuestion, resolveWhatsAppWait, hasPendingWhatsAppWait };
}
