#!/usr/bin/env bun
/**
 * Better Call Claude - MCP Server
 * Bi-directional communication for Claude Code via Voice, SMS, and WhatsApp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { serve } from "bun";

import { TransportManager } from "./transport.js";
import { PhoneCallManager } from "./phone-call.js";
import {
  ConversationManager,
  ConversationState,
  ConversationDirection,
  ChannelType,
} from "./conversation-manager.js";
import { MessagingManager } from "./messaging.js";
import { WebhookSecurity } from "./webhook-security.js";
import { createPhoneAPI } from "./phone-api.js";
import { TaskExecutor } from "./task-executor.js";
import { updateTwilioWebhooks } from "./twilio-webhook-updater.js";
import { loadConfig, validateConfig } from "./config.js";
import { WhatsAppChatManager } from "./whatsapp-chat.js";
import type { InboundMessageData } from "./messaging.js";
import type { BaileysClient } from "./baileys.js";

// Configuration
const config = loadConfig();

// Determine mode: baileys-only has no phone provider credentials
const isBaileysOnly = config.whatsappProvider === "baileys" &&
  !config.phoneAccountSid && !config.phoneAuthToken && !config.phoneNumber;
const hasPhoneProvider = !!config.phoneAccountSid && !!config.phoneAuthToken && !!config.phoneNumber;

// Initialize managers
const conversationManager = new ConversationManager();
const webhookSecurity = new WebhookSecurity(config);

let phoneCallManager: PhoneCallManager;
let messagingManager: MessagingManager;
let transportManager: TransportManager;
let publicUrl: string = "";
let taskExecutor: TaskExecutor;
let phoneAPI: ReturnType<typeof createPhoneAPI>;
let baileysClient: BaileysClient | null = null;
let whatsappChatManager: WhatsAppChatManager | null = null;

// Hono app for webhooks
const app = new Hono();

// Webhook security middleware
app.use("/webhook/*", async (c, next) => {
  const body = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Get full URL for Twilio signature verification
  const url = c.req.url;

  if (webhookSecurity.verifyRequest(headers, body, url)) {
    // Re-parse body as JSON for downstream handlers
    try {
      (c as any).parsedBody = JSON.parse(body || "{}");
    } catch {
      try {
        // For form-encoded data (Twilio)
        (c as any).parsedBody = Object.fromEntries(new URLSearchParams(body));
      } catch (parseError) {
        console.error("[Security] Failed to parse webhook body:", parseError);
        return c.json({ error: "Invalid request body" }, 400);
      }
    }
    await next();
  } else {
    console.error("[Security] Invalid webhook signature");
    return c.json({ error: "Invalid signature" }, 403);
  }
});

// ============================================
// VOICE WEBHOOKS
// ============================================

// Inbound call webhook - user is calling Claude
app.post("/webhook/:provider/inbound", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const body = (c as any).parsedBody || (await c.req.json());
  console.error(`[Inbound] Received call from ${provider}:`, JSON.stringify(body).slice(0, 200));

  try {
    const callData = phoneCallManager.parseInboundWebhook(provider, body);

    if (callData.type === "call.initiated") {
      // Reset WhatsApp chat session — voice call is the only reset trigger
      whatsappChatManager?.resetForVoiceCall();

      // Check for existing conversation to prevent duplicates (race condition fix)
      const existingConversation = conversationManager.getConversationByProviderId(callData.providerCallId);
      if (existingConversation) {
        console.error(`[Inbound] Using existing conversation: ${existingConversation.id}`);
        // Use existing conversation ID for the response
        const twiml = phoneCallManager.generateAnswerTwiML(
          "Hello! This is Claude. What would you like me to work on?",
          `${publicUrl}/webhook/${provider}/gather/${existingConversation.id}`
        );
        return c.text(twiml, 200, { "Content-Type": "text/xml" });
      }

      // Create a new conversation for inbound call
      const conversationId = crypto.randomUUID();
      conversationManager.createConversation(
        conversationId,
        ChannelType.VOICE,
        ConversationDirection.INBOUND,
        callData.providerCallId,
        { from: callData.from, to: callData.to }
      );

      // Answer the call with greeting
      const twiml = phoneCallManager.generateAnswerTwiML(
        "Hello! This is Claude. What would you like me to work on?",
        `${publicUrl}/webhook/${provider}/gather/${conversationId}`
      );

      return c.text(twiml, 200, { "Content-Type": "text/xml" });
    } else {
      return c.text("OK", 200);
    }
  } catch (error) {
    console.error("[Inbound] Error processing webhook:", error);
    return c.text("Error", 500);
  }
});

// Gather user speech webhook
app.post("/webhook/:provider/gather/:conversationId", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const conversationId = c.req.param("conversationId");
  const body = (c as any).parsedBody || (await c.req.json());
  console.error(`[Gather] Speech input for conversation ${conversationId}`);

  try {
    const speechResult = phoneCallManager.parseSpeechResult(provider, body);

    if (speechResult.transcript) {
      console.error(`[Gather] Transcript: "${speechResult.transcript}"`);

      // Store the message
      conversationManager.addMessage(conversationId, "user", speechResult.transcript);

      // Check if there's a pending question from spawned Claude
      const wasQuestionPending = phoneAPI.resolveQuestion(conversationId, speechResult.transcript);

      if (wasQuestionPending) {
        // Claude asked a question, we resolved it - keep call on hold
        console.error(`[Gather] Resolved pending question for ${conversationId}`);
        const twiml = phoneCallManager.generateHoldTwiML(
          "",  // No message, Claude will speak via API
          `${publicUrl}/webhook/${provider}/hold/${conversationId}`,
          30
        );
        return c.text(twiml, 200, { "Content-Type": "text/xml" });
      }

      // Check if we've already spawned Claude for this conversation
      const existingExecution = taskExecutor.getExecution(conversationId);

      if (!existingExecution) {
        // First message - spawn Claude Code session
        console.error(`[Gather] Spawning Claude for: ${speechResult.transcript}`);

        // Check if there's context from a previous task (callback follow-up)
        const context = taskExecutor.getTaskContext(conversationId);
        if (context) {
          console.error(`[Gather] Found prior context: ${context.completionSummary.slice(0, 50)}...`);
        }

        taskExecutor.executeTask(
          conversationId,
          speechResult.transcript,
          context?.workingDir || process.cwd(),  // Use original working dir if available
          context  // Pass context for follow-ups
        );

        // Tell user we're starting and put on hold
        const twiml = phoneCallManager.generateHoldTwiML(
          "Got it. Let me think about that...",
          `${publicUrl}/webhook/${provider}/hold/${conversationId}`,
          10  // Short initial wait
        );
        return c.text(twiml, 200, { "Content-Type": "text/xml" });
      }

      // Claude already running but no pending question - maybe follow-up
      // Keep on hold, Claude will handle it
      const twiml = phoneCallManager.generateHoldTwiML(
        "",
        `${publicUrl}/webhook/${provider}/hold/${conversationId}`,
        30
      );
      return c.text(twiml, 200, { "Content-Type": "text/xml" });
    } else {
      // No speech detected, prompt again
      const twiml = phoneCallManager.generateGatherTwiML(
        "I didn't catch that. Could you please repeat?",
        `${publicUrl}/webhook/${provider}/gather/${conversationId}`
      );
      return c.text(twiml, 200, { "Content-Type": "text/xml" });
    }
  } catch (error) {
    console.error("[Gather] Error:", error);
    return c.text("Error", 500);
  }
});

// Hold webhook - keeps call alive while Claude works
app.post("/webhook/:provider/hold/:conversationId", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const conversationId = c.req.param("conversationId");

  // Keep waiting - Claude will use /api/* endpoints to communicate
  const twiml = phoneCallManager.generateHoldTwiML(
    "",
    `${publicUrl}/webhook/${provider}/hold/${conversationId}`,
    30
  );
  return c.text(twiml, 200, { "Content-Type": "text/xml" });
});

// Call status webhook
app.post("/webhook/:provider/status/:conversationId", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const conversationId = c.req.param("conversationId");
  const body = (c as any).parsedBody || (await c.req.json());
  console.error(`[Status] Conversation ${conversationId} status update:`, body);

  try {
    const status = phoneCallManager.parseStatusWebhook(provider, body);

    if (status.state === "completed" || status.state === "failed") {
      conversationManager.updateState(conversationId, ConversationState.ENDED);

      // Seed voice call context into WhatsApp chat for cross-channel continuity
      if (whatsappChatManager) {
        const taskContext = taskExecutor?.getTaskContext(conversationId);
        if (taskContext) {
          whatsappChatManager.setVoiceContext(
            `Task: "${taskContext.originalTask}"\nResult: "${taskContext.completionSummary}"\nWorking dir: ${taskContext.workingDir}`
          );
        }
      }
    } else if (status.state === "answered") {
      conversationManager.updateState(conversationId, ConversationState.ACTIVE);
    }

    return c.text("OK", 200);
  } catch (error) {
    console.error("[Status] Error:", error);
    return c.text("Error", 500);
  }
});

// ============================================
// SMS WEBHOOKS
// ============================================

app.post("/webhook/:provider/sms", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const body = (c as any).parsedBody;
  console.error(`[SMS] Received from ${provider}:`, JSON.stringify(body).slice(0, 200));

  try {
    const message = messagingManager.parseInboundMessage(provider, body);

    if (message && message.type === "sms") {
      // Find or create conversation for this sender
      const conversation = conversationManager.findOrCreateConversation(
        ChannelType.SMS,
        message.messageId,
        message.from,
        message.to
      );

      // Add the message
      conversationManager.addMessage(conversation.id, "user", message.content);
      console.error(`[SMS] Added message to conversation ${conversation.id}`);
    }

    return c.text("OK", 200);
  } catch (error) {
    console.error("[SMS] Error:", error);
    return c.text("Error", 500);
  }
});

// ============================================
// SHARED WHATSAPP INBOUND HANDLER
// ============================================

function handleInboundWhatsApp(message: InboundMessageData): void {
  // Find or create conversation for this sender
  const conversation = conversationManager.findOrCreateConversation(
    ChannelType.WHATSAPP,
    message.messageId,
    message.from,
    message.to
  );

  // Add the message
  conversationManager.addMessage(conversation.id, "user", message.content);
  console.error(`[WhatsApp] Added message to conversation ${conversation.id}`);

  // Priority 1: Check if there's a Claude session waiting for WhatsApp messages
  if (phoneAPI?.hasPendingWhatsAppWait()) {
    const wasResolved = phoneAPI.resolveWhatsAppWait(message.content);
    if (wasResolved) {
      console.error(`[WhatsApp] Routed message to waiting Claude session`);
      return;
    }
  }

  // Priority 2: Check if there's a pending question from spawned Claude
  const wasQuestionPending = phoneAPI?.resolveQuestion(conversation.id, message.content);

  if (!wasQuestionPending) {
    // No pending question - check if we should spawn Claude
    const existingExecution = taskExecutor?.getExecution(conversation.id);

    // Only skip spawning if there's an ACTIVE execution (still running)
    if (!existingExecution || existingExecution.status !== "running") {
      // Priority 3 check passed — no active task

      // Priority 4: Route to WhatsApp Chat Manager (always-on conversation)
      if (whatsappChatManager) {
        console.error(`[WhatsApp] Routing to ChatManager (session ${whatsappChatManager.getSessionId().slice(0, 8)}): ${message.content}`);
        whatsappChatManager.handleMessage(message.content);
      } else {
        // Fallback: original one-shot behavior (non-baileys mode)
        const voiceContext = taskExecutor?.getLatestTaskContext();

        if (voiceContext) {
          console.error(`[WhatsApp] Found voice context from ${voiceContext.conversationId?.slice(0, 8)}: ${voiceContext.originalTask.slice(0, 50)}...`);
        }

        console.error(`[WhatsApp] Spawning Claude for: ${message.content}`);
        taskExecutor?.executeTask(
          conversation.id,
          message.content,
          voiceContext?.workingDir || process.cwd(),
          voiceContext,
          "whatsapp"
        );
      }
    } else {
      console.error(`[WhatsApp] Claude already running for ${conversation.id.slice(0, 8)}`);
    }
  } else {
    console.error(`[WhatsApp] Resolved pending question for ${conversation.id.slice(0, 8)}`);
  }
}

// ============================================
// WHATSAPP WEBHOOKS
// ============================================

app.post("/webhook/:provider/whatsapp", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const body = (c as any).parsedBody;
  console.error(`[WhatsApp] Received from ${provider}:`, JSON.stringify(body).slice(0, 200));

  try {
    const message = messagingManager.parseInboundMessage(provider, body);

    if (message && message.type === "whatsapp") {
      handleInboundWhatsApp(message);
    }

    return c.text("OK", 200);
  } catch (error) {
    console.error("[WhatsApp] Error:", error);
    return c.text("Error", 500);
  }
});

// Message delivery status webhook
app.post("/webhook/:provider/message-status/:conversationId", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const conversationId = c.req.param("conversationId");
  const body = (c as any).parsedBody;
  console.error(`[MessageStatus] Conversation ${conversationId}:`, body);

  try {
    const status = messagingManager.parseStatusWebhook(provider, body);
    if (status) {
      console.error(`[MessageStatus] Message ${status.messageId} status: ${status.status}`);
    }
    return c.text("OK", 200);
  } catch (error) {
    console.error("[MessageStatus] Error:", error);
    return c.text("Error", 500);
  }
});

// ============================================
// HEALTH CHECK
// ============================================

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    transport: "tailscale",
    publicUrl,
    activeConversations: {
      voice: conversationManager.getActiveConversations(ChannelType.VOICE).length,
      sms: conversationManager.getActiveConversations(ChannelType.SMS).length,
      whatsapp: conversationManager.getActiveConversations(ChannelType.WHATSAPP).length,
    },
    baileys: {
      connected: baileysClient?.isConnected() ?? false,
      debugLog: baileysClient?.getDebugLog?.() ?? [],
      chatManagerSession: whatsappChatManager?.getSessionId()?.slice(0, 8) ?? null,
      chatManagerProcessing: whatsappChatManager?.getIsProcessing() ?? false,
      chatManagerPending: whatsappChatManager?.getPendingCount() ?? 0,
      chatManagerHistory: whatsappChatManager?.getHistory()?.length ?? 0,
    },
  });
});

// ============================================
// MCP SERVER
// ============================================

const server = new Server(
  {
    name: "better-call-claude",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define all tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // ============================================
      // VOICE TOOLS (existing)
      // ============================================
      {
        name: "receive_inbound_call",
        description:
          "Check for and receive an incoming phone call from the user. Returns the user's spoken message if a call is waiting.",
        inputSchema: {
          type: "object",
          properties: {
            timeout_ms: {
              type: "number",
              description: "How long to wait for an incoming call (default: 5000ms)",
            },
          },
        },
      },
      {
        name: "initiate_call",
        description:
          "Start a phone call to the user to communicate status, ask questions, or request decisions. The call will connect and Claude can speak first.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to speak when the user answers",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "continue_call",
        description:
          "Continue an active phone call by speaking a message and waiting for the user's response.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The ID of the active call conversation",
            },
            message: {
              type: "string",
              description: "The message to speak to the user",
            },
          },
          required: ["conversation_id", "message"],
        },
      },
      {
        name: "speak_to_user",
        description:
          "Speak to the user on an active call without waiting for a response. Good for acknowledgments or updates.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The ID of the active call conversation",
            },
            message: {
              type: "string",
              description: "The message to speak",
            },
          },
          required: ["conversation_id", "message"],
        },
      },
      {
        name: "end_call",
        description: "End an active phone call, optionally with a closing message.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The ID of the call conversation to end",
            },
            message: {
              type: "string",
              description: "Optional closing message before hanging up",
            },
          },
          required: ["conversation_id"],
        },
      },
      // ============================================
      // MESSAGING TOOLS (new)
      // ============================================
      {
        name: "receive_inbound_message",
        description:
          "Check for incoming SMS or WhatsApp messages from the user. Returns the message content if one is waiting.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              enum: ["sms", "whatsapp", "any"],
              description: "Which channel to check for messages (default: any)",
            },
            timeout_ms: {
              type: "number",
              description: "How long to wait for an incoming message (default: 5000ms)",
            },
          },
        },
      },
      {
        name: "send_sms",
        description:
          "Send an SMS message to the user. Can optionally wait for a reply.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send",
            },
            wait_for_reply: {
              type: "boolean",
              description: "Wait for user to reply (default: true)",
            },
            timeout_ms: {
              type: "number",
              description: "How long to wait for a reply (default: 180000ms / 3 minutes)",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "send_whatsapp",
        description:
          "Send a WhatsApp message to the user. Can optionally wait for a reply.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send",
            },
            wait_for_reply: {
              type: "boolean",
              description: "Wait for user to reply (default: true)",
            },
            timeout_ms: {
              type: "number",
              description: "How long to wait for a reply (default: 180000ms / 3 minutes)",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "reply_to_conversation",
        description:
          "Reply to an existing conversation (voice call, SMS, or WhatsApp). Continues the conversation thread.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The ID of the conversation to reply to",
            },
            message: {
              type: "string",
              description: "The message to send",
            },
            wait_for_reply: {
              type: "boolean",
              description: "Wait for user to reply (default: true)",
            },
            timeout_ms: {
              type: "number",
              description: "How long to wait for a reply",
            },
          },
          required: ["conversation_id", "message"],
        },
      },
      {
        name: "get_conversation_history",
        description:
          "Get the full message history for a conversation, including all messages exchanged.",
        inputSchema: {
          type: "object",
          properties: {
            conversation_id: {
              type: "string",
              description: "The ID of the conversation",
            },
          },
          required: ["conversation_id"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ============================================
      // VOICE TOOL HANDLERS
      // ============================================
      case "receive_inbound_call": {
        const timeoutMs = (args?.timeout_ms as number) || 5000;

        const pendingConversation = conversationManager.getPendingInbound(ChannelType.VOICE);

        if (pendingConversation) {
          const lastMessage = pendingConversation.messages[pendingConversation.messages.length - 1];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: pendingConversation.id,
                  channel: "voice",
                  user_message: lastMessage?.content || "",
                  direction: "inbound",
                }),
              },
            ],
          };
        }

        const conversation = await conversationManager.waitForInbound(timeoutMs, ChannelType.VOICE);

        if (conversation) {
          const lastMessage = conversation.messages[conversation.messages.length - 1];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: conversation.id,
                  channel: "voice",
                  user_message: lastMessage?.content || "",
                  direction: "inbound",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "No incoming call received within timeout",
              }),
            },
          ],
        };
      }

      case "initiate_call": {
        const message = args?.message as string;
        if (!message) {
          throw new Error("Message is required");
        }

        const conversationId = crypto.randomUUID();

        const providerCallId = await phoneCallManager.initiateCall(
          config.userPhoneNumber,
          message,
          `${publicUrl}/webhook/${config.phoneProvider}/status/${conversationId}`,
          `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`
        );

        conversationManager.createConversation(
          conversationId,
          ChannelType.VOICE,
          ConversationDirection.OUTBOUND,
          providerCallId,
          { to: config.userPhoneNumber }
        );
        conversationManager.addMessage(conversationId, "assistant", message);

        const response = await conversationManager.waitForResponse(
          conversationId,
          config.transcriptTimeoutMs
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                channel: "voice",
                response: response || "User did not respond",
              }),
            },
          ],
        };
      }

      case "continue_call": {
        const conversationId = args?.conversation_id as string;
        const message = args?.message as string;

        if (!conversationId || !message) {
          throw new Error("conversation_id and message are required");
        }

        const conversation = conversationManager.getConversation(conversationId);
        if (!conversation) {
          throw new Error(`Conversation ${conversationId} not found`);
        }

        if (conversation.channel !== ChannelType.VOICE) {
          throw new Error(`Conversation ${conversationId} is not a voice call`);
        }

        if (conversation.state === ConversationState.ENDED) {
          throw new Error(`Call ${conversationId} has already ended`);
        }

        const gatherUrl = `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`;
        await phoneCallManager.speakToCall(conversation.providerConversationId, message, true, gatherUrl);
        conversationManager.addMessage(conversationId, "assistant", message);

        const response = await conversationManager.waitForResponse(
          conversationId,
          config.transcriptTimeoutMs
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                response: response || "User did not respond",
              }),
            },
          ],
        };
      }

      case "speak_to_user": {
        const conversationId = args?.conversation_id as string;
        const message = args?.message as string;

        if (!conversationId || !message) {
          throw new Error("conversation_id and message are required");
        }

        const conversation = conversationManager.getConversation(conversationId);
        if (!conversation || conversation.state === ConversationState.ENDED) {
          throw new Error(`Conversation ${conversationId} not found or has ended`);
        }

        if (conversation.channel !== ChannelType.VOICE) {
          throw new Error(`Conversation ${conversationId} is not a voice call`);
        }

        // No gather URL needed since we're not waiting for a response
        await phoneCallManager.speakToCall(conversation.providerConversationId, message, false);
        conversationManager.addMessage(conversationId, "assistant", message);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                message: "Message delivered",
              }),
            },
          ],
        };
      }

      case "end_call": {
        const conversationId = args?.conversation_id as string;
        const message = args?.message as string;

        if (!conversationId) {
          throw new Error("conversation_id is required");
        }

        const conversation = conversationManager.getConversation(conversationId);
        if (!conversation) {
          throw new Error(`Conversation ${conversationId} not found`);
        }

        if (message) {
          await phoneCallManager.speakToCall(conversation.providerConversationId, message, false);
          conversationManager.addMessage(conversationId, "assistant", message);
        }

        await phoneCallManager.endCall(conversation.providerConversationId);
        conversationManager.updateState(conversationId, ConversationState.ENDED);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                message: "Call ended",
              }),
            },
          ],
        };
      }

      // ============================================
      // MESSAGING TOOL HANDLERS
      // ============================================
      case "receive_inbound_message": {
        const channelArg = (args?.channel as string) || "any";
        const timeoutMs = (args?.timeout_ms as number) || 5000;

        let channelFilter: ChannelType | undefined;
        if (channelArg === "sms") channelFilter = ChannelType.SMS;
        else if (channelArg === "whatsapp") channelFilter = ChannelType.WHATSAPP;
        // "any" leaves channelFilter undefined, but we only want messaging channels
        const messagingChannels = [ChannelType.SMS, ChannelType.WHATSAPP];

        // Check for pending messages
        let pendingConversation = conversationManager.getPendingInbound(channelFilter);
        if (!pendingConversation && channelArg === "any") {
          // Check both SMS and WhatsApp
          pendingConversation = conversationManager.getPendingInbound(ChannelType.SMS);
          if (!pendingConversation) {
            pendingConversation = conversationManager.getPendingInbound(ChannelType.WHATSAPP);
          }
        }

        if (pendingConversation && messagingChannels.includes(pendingConversation.channel)) {
          const lastMessage = pendingConversation.messages[pendingConversation.messages.length - 1];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: pendingConversation.id,
                  channel: pendingConversation.channel,
                  user_message: lastMessage?.content || "",
                  direction: "inbound",
                }),
              },
            ],
          };
        }

        // Wait for a message
        const conversation = await conversationManager.waitForInbound(timeoutMs, channelFilter);

        if (conversation && messagingChannels.includes(conversation.channel)) {
          const lastMessage = conversation.messages[conversation.messages.length - 1];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: conversation.id,
                  channel: conversation.channel,
                  user_message: lastMessage?.content || "",
                  direction: "inbound",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "No incoming message received within timeout",
              }),
            },
          ],
        };
      }

      case "send_sms": {
        const message = args?.message as string;
        const waitForReply = args?.wait_for_reply !== false; // Default true
        const timeoutMs = (args?.timeout_ms as number) || config.transcriptTimeoutMs;

        if (!message) {
          throw new Error("Message is required");
        }

        const conversationId = crypto.randomUUID();
        const messageId = await messagingManager.sendSMS(config.userPhoneNumber, message);

        conversationManager.createConversation(
          conversationId,
          ChannelType.SMS,
          ConversationDirection.OUTBOUND,
          messageId,
          { to: config.userPhoneNumber }
        );
        conversationManager.addMessage(conversationId, "assistant", message);

        if (waitForReply) {
          const response = await conversationManager.waitForResponse(conversationId, timeoutMs);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: conversationId,
                  channel: "sms",
                  response: response || "No reply received",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                channel: "sms",
                message: "SMS sent",
              }),
            },
          ],
        };
      }

      case "send_whatsapp": {
        const message = args?.message as string;
        const waitForReply = args?.wait_for_reply !== false;
        const timeoutMs = (args?.timeout_ms as number) || config.transcriptTimeoutMs;

        if (!message) {
          throw new Error("Message is required");
        }

        const conversationId = crypto.randomUUID();
        const messageId = await messagingManager.sendWhatsApp(config.userPhoneNumber, message);

        conversationManager.createConversation(
          conversationId,
          ChannelType.WHATSAPP,
          ConversationDirection.OUTBOUND,
          messageId,
          { to: config.userPhoneNumber }
        );
        conversationManager.addMessage(conversationId, "assistant", message);

        if (waitForReply) {
          const response = await conversationManager.waitForResponse(conversationId, timeoutMs);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: conversationId,
                  channel: "whatsapp",
                  response: response || "No reply received",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                channel: "whatsapp",
                message: "WhatsApp message sent",
              }),
            },
          ],
        };
      }

      case "reply_to_conversation": {
        const conversationId = args?.conversation_id as string;
        const message = args?.message as string;
        const waitForReply = args?.wait_for_reply !== false;
        const timeoutMs = (args?.timeout_ms as number) || config.transcriptTimeoutMs;

        if (!conversationId || !message) {
          throw new Error("conversation_id and message are required");
        }

        const conversation = conversationManager.getConversation(conversationId);
        if (!conversation) {
          throw new Error(`Conversation ${conversationId} not found`);
        }

        if (conversation.state === ConversationState.ENDED) {
          throw new Error(`Conversation ${conversationId} has ended`);
        }

        // Send message based on channel
        switch (conversation.channel) {
          case ChannelType.VOICE:
            const voiceGatherUrl = waitForReply
              ? `${publicUrl}/webhook/${config.phoneProvider}/gather/${conversationId}`
              : undefined;
            await phoneCallManager.speakToCall(conversation.providerConversationId, message, waitForReply, voiceGatherUrl);
            break;
          case ChannelType.SMS:
            await messagingManager.sendSMS(conversation.metadata?.from || config.userPhoneNumber, message);
            break;
          case ChannelType.WHATSAPP:
            await messagingManager.sendWhatsApp(conversation.metadata?.from || config.userPhoneNumber, message);
            break;
        }

        conversationManager.addMessage(conversationId, "assistant", message);

        if (waitForReply) {
          const response = await conversationManager.waitForResponse(conversationId, timeoutMs);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  conversation_id: conversationId,
                  channel: conversation.channel,
                  response: response || "No reply received",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                conversation_id: conversationId,
                channel: conversation.channel,
                message: "Message sent",
              }),
            },
          ],
        };
      }

      case "get_conversation_history": {
        const conversationId = args?.conversation_id as string;

        if (!conversationId) {
          throw new Error("conversation_id is required");
        }

        const conversation = conversationManager.getConversation(conversationId);
        if (!conversation) {
          throw new Error(`Conversation ${conversationId} not found`);
        }

        const duration = conversation.endedAt
          ? (conversation.endedAt.getTime() - conversation.startedAt.getTime()) / 1000
          : (Date.now() - conversation.startedAt.getTime()) / 1000;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                conversation_id: conversationId,
                channel: conversation.channel,
                state: conversation.state,
                direction: conversation.direction,
                duration_seconds: Math.round(duration),
                messages: conversation.messages,
              }),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Tool] Error in ${name}:`, errorMessage);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }),
        },
      ],
      isError: true,
    };
  }
});

// ============================================
// START SERVER
// ============================================

async function main(): Promise<void> {
  console.error("[Init] Starting Better Call Claude MCP Server v2.0...");

  // Validate configuration
  validateConfig(config);
  console.error("[Init] Configuration validated");

  // Initialize Baileys if configured (before transport — Baileys doesn't need a public URL)
  // Connection is non-blocking so MCP stdio transport starts immediately
  if (config.whatsappProvider === "baileys") {
    const { BaileysClient } = await import("./baileys.js");
    const { existsSync } = await import("fs");
    const hasAuth = existsSync(`${config.baileysAuthDir}/creds.json`);

    if (hasAuth) {
      baileysClient = new BaileysClient(config.baileysAuthDir);
      console.error("[Init] Connecting to WhatsApp via Baileys (session found)...");
      // Don't await — connect in the background so MCP server isn't blocked
      baileysClient.connect().then(() => {
        console.error(`[Init] Baileys connected (auth: ${config.baileysAuthDir})`);
      }).catch((err) => {
        console.error("[Init] Baileys connection failed:", err);
        console.error("[Init] WhatsApp will be unavailable. Re-pair with: npx tsx scripts/baileys-pair.ts");
      });
    } else {
      console.error("[Init] Baileys configured but no session found.");
      console.error("[Init] Run: npx tsx scripts/baileys-pair.ts");
      console.error("[Init] Then restart Claude Code to enable WhatsApp via Baileys.");
    }
  }

  // Initialize transport — skip Tailscale Funnel if Baileys-only mode
  if (isBaileysOnly) {
    publicUrl = `http://localhost:${config.port}`;
    console.error(`[Init] Baileys-only mode — no Tailscale Funnel needed`);
  } else {
    try {
      transportManager = new TransportManager();
      publicUrl = await transportManager.start(config.port);
      console.error(`[Init] Tailscale Funnel ready: ${publicUrl}`);

      // Auto-update Twilio webhooks if using Twilio provider
      if (config.phoneProvider === "twilio" && hasPhoneProvider) {
        await updateTwilioWebhooks(
          {
            accountSid: config.phoneAccountSid,
            authToken: config.phoneAuthToken,
            phoneNumber: config.phoneNumber,
            whatsappNumber: config.whatsappNumber || undefined,
          },
          publicUrl
        );
      }
    } catch (err) {
      // Tailscale failed — fall back to localhost so MCP server still starts
      publicUrl = `http://localhost:${config.port}`;
      console.error(`[Init] Tailscale Funnel unavailable: ${err instanceof Error ? err.message : err}`);
      console.error(`[Init] Voice/SMS webhooks won't work. Baileys WhatsApp will still work.`);
      console.error(`[Init] To enable webhooks, run: tailscale up`);
    }
  }

  // Initialize managers — PhoneCallManager only if phone provider credentials exist
  if (hasPhoneProvider) {
    phoneCallManager = new PhoneCallManager(config);
  }

  messagingManager = new MessagingManager({
    ...config,
    whatsappProvider: config.whatsappProvider,
    whatsappNumber: config.whatsappNumber || undefined,
  });

  // Wire Baileys into the messaging manager for outbound WhatsApp
  if (baileysClient) {
    messagingManager.setBaileysClient(baileysClient);
  }

  // Log channel status
  const channels: string[] = [];
  if (hasPhoneProvider) channels.push("Voice", "SMS");
  if (config.whatsappProvider === "baileys") channels.push("WhatsApp (Baileys)");
  else if (hasPhoneProvider) channels.push("WhatsApp");
  console.error(`[Init] Phone provider: ${hasPhoneProvider ? config.phoneProvider : "none"}`);
  console.error(`[Init] WhatsApp provider: ${config.whatsappProvider || config.phoneProvider}`);
  console.error(`[Init] Channels enabled: ${channels.join(", ")}`);
  if (config.whatsappNumber) {
    console.error(`[Init] WhatsApp number: ${config.whatsappNumber} (separate from voice)`);
  }

  // Initialize task executor and phone API for autonomous operation
  taskExecutor = new TaskExecutor(publicUrl);

  // Initialize WhatsApp Chat Manager for always-on conversation (Baileys mode only)
  if (config.whatsappProvider === "baileys") {
    whatsappChatManager = new WhatsAppChatManager(
      taskExecutor,
      publicUrl,
      process.cwd(),
      config.whatsappChatHistorySize,
    );
    console.error(`[Init] WhatsApp Chat Manager ready (session ${whatsappChatManager.getSessionId().slice(0, 8)})`);
  }

  phoneAPI = createPhoneAPI(
    phoneCallManager,
    conversationManager,
    {
      phoneProvider: config.phoneProvider,
      userPhoneNumber: config.userPhoneNumber,
    },
    () => publicUrl,
    taskExecutor,
    messagingManager,
    whatsappChatManager || undefined,
  );
  app.route("/api", phoneAPI.api);
  console.error(`[Init] Autonomous phone API ready at ${publicUrl}/api/*`);

  // Register Baileys inbound message handler
  if (baileysClient) {
    baileysClient.onInboundMessage(handleInboundWhatsApp);
    console.error("[Init] Baileys inbound handler registered");
  }

  // Start HTTP server (skip if port is already in use — another instance may be running)
  let httpServer: ReturnType<typeof serve> | null = null;
  try {
    httpServer = serve({
      port: config.port,
      fetch: app.fetch,
    });
    console.error(`[Init] HTTP server listening on port ${config.port}`);
    if (hasPhoneProvider) {
      console.error(`[Init] Webhooks:`);
      console.error(`       Voice:    ${publicUrl}/webhook/${config.phoneProvider}/inbound`);
      console.error(`       SMS:      ${publicUrl}/webhook/${config.phoneProvider}/sms`);
      if (config.whatsappProvider !== "baileys") {
        console.error(`       WhatsApp: ${publicUrl}/webhook/${config.phoneProvider}/whatsapp`);
      }
      console.error(`[Init] Phone API (for spawned Claude):`);
      console.error(`       Ask:      POST ${publicUrl}/api/ask/:conversationId`);
      console.error(`       Say:      POST ${publicUrl}/api/say/:conversationId`);
      console.error(`       Complete: POST ${publicUrl}/api/complete/:conversationId`);
    }
  } catch (e: any) {
    if (e?.code === "EADDRINUSE") {
      console.error(`[Init] Port ${config.port} already in use — running in MCP-only mode (HTTP server skipped)`);
    } else {
      throw e;
    }
  }

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Init] MCP server connected via stdio");

  // Graceful shutdown — handles SIGINT, SIGTERM, and MCP stdin close
  const cleanup = async (reason: string) => {
    console.error(`[Shutdown] ${reason}, cleaning up...`);
    baileysClient?.disconnect();
    taskExecutor.killAllRunning();
    httpServer?.stop();
    if (transportManager) await transportManager.stop();
    try { await server.close(); } catch {}
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("Received SIGINT"));
  process.on("SIGTERM", () => cleanup("Received SIGTERM"));

  // When MCP client disconnects (stdin closes), exit cleanly to prevent zombie processes
  process.stdin.on("end", () => cleanup("MCP stdin closed"));
  process.stdin.on("close", () => cleanup("MCP stdin closed"));

  // Cleanup old conversations and task executions periodically
  setInterval(() => {
    conversationManager.cleanupOld();
    taskExecutor.cleanup();
  }, 3600000);
}

main().catch((error) => {
  console.error("[Fatal] Failed to start server:", error);
  process.exit(1);
});
