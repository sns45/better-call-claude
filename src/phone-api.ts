/**
 * Phone API
 * HTTP endpoints that spawned Claude Code sessions call via curl
 * Enables Claude to communicate with users during phone calls
 */

import { Hono } from "hono";
import type { PhoneCallManager } from "./phone-call.js";
import type { ConversationManager } from "./conversation-manager.js";
import type { TaskExecutor } from "./task-executor.js";
import type { MessagingManager } from "./messaging.js";

export interface PendingQuestion {
  resolve: (answer: string) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface PhoneAPIConfig {
  phoneProvider: "telnyx" | "twilio";
  userPhoneNumber: string;
}

export function createPhoneAPI(
  phoneCallManager: PhoneCallManager,
  conversationManager: ConversationManager,
  config: PhoneAPIConfig,
  getPublicUrl: () => string,
  taskExecutor?: TaskExecutor,
  messagingManager?: MessagingManager
) {
  const api = new Hono();
  const pendingQuestions = new Map<string, PendingQuestion>();

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

    console.log(`[PhoneAPI] Ask: ${message}`);

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
      console.log(`[PhoneAPI] Ask failed (call may have ended): ${error}`);
      pendingQuestions.delete(conversationId);
      conversationManager.updateState(conversationId, "ended" as any);
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

    console.log(`[PhoneAPI] Say: ${message}`);

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
      console.log(`[PhoneAPI] Say failed (call may have ended): ${error}`);
      conversationManager.updateState(conversationId, "ended" as any);
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

    console.log(`[PhoneAPI] Complete: ${summary}`);

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
        console.log(`[PhoneAPI] Speak failed (user likely hung up): ${error}`);
        conversationManager.updateState(conversationId, "ended" as any);
      }
    }

    // User hung up (or speak failed) - call them back
    console.log(`[PhoneAPI] Initiating callback to ${config.userPhoneNumber}`);
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

    console.log(`[PhoneAPI] Initiating call: ${message}`);

    const conversationId = crypto.randomUUID();
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

    console.log(`[PhoneAPI] SMS: ${message}`);

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

    console.log(`[PhoneAPI] WhatsApp: ${message}`);

    if (!messagingManager) {
      return c.json({ success: false, error: "Messaging not configured" }, 500);
    }

    try {
      const messageId = await messagingManager.sendWhatsApp(config.userPhoneNumber, message);
      return c.json({ success: true, messageId });
    } catch (error) {
      console.error(`[PhoneAPI] WhatsApp failed: ${error}`);
      return c.json({ success: false, error: String(error) }, 500);
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

  return { api, resolveQuestion };
}
