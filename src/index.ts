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

import { TransportManager, type TransportType } from "./transport.js";
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

// Configuration
const config = {
  phoneProvider: (process.env.BETTERCALLCLAUDE_PHONE_PROVIDER || "telnyx") as "telnyx" | "twilio",
  phoneAccountSid: process.env.BETTERCALLCLAUDE_PHONE_ACCOUNT_SID || "",
  phoneAuthToken: process.env.BETTERCALLCLAUDE_PHONE_AUTH_TOKEN || "",
  phoneNumber: process.env.BETTERCALLCLAUDE_PHONE_NUMBER || "",
  userPhoneNumber: process.env.BETTERCALLCLAUDE_USER_PHONE_NUMBER || "",
  openaiApiKey: process.env.BETTERCALLCLAUDE_OPENAI_API_KEY || "",
  transport: (process.env.BETTERCALLCLAUDE_TRANSPORT || "ngrok") as TransportType,
  port: parseInt(process.env.BETTERCALLCLAUDE_PORT || "3333"),
  ttsVoice: process.env.BETTERCALLCLAUDE_TTS_VOICE || "onyx",
  transcriptTimeoutMs: parseInt(process.env.BETTERCALLCLAUDE_TRANSCRIPT_TIMEOUT_MS || "180000"),
  sttSilenceDurationMs: parseInt(process.env.BETTERCALLCLAUDE_STT_SILENCE_DURATION_MS || "800"),
  // ngrok specific
  ngrokAuthtoken: process.env.BETTERCALLCLAUDE_NGROK_AUTHTOKEN || "",
  ngrokDomain: process.env.BETTERCALLCLAUDE_NGROK_DOMAIN || "",
  // Tailscale specific
  tailscaleHostname: process.env.BETTERCALLCLAUDE_TAILSCALE_HOSTNAME || "",
  tailscaleUseFunnel: process.env.BETTERCALLCLAUDE_TAILSCALE_USE_FUNNEL === "true",
  tailscaleFunnelPort: parseInt(process.env.BETTERCALLCLAUDE_TAILSCALE_FUNNEL_PORT || "443"),
  // Security
  telnyxPublicKey: process.env.BETTERCALLCLAUDE_TELNYX_PUBLIC_KEY || "",
};

// Validate required config
function validateConfig(): void {
  const required = [
    "phoneAccountSid",
    "phoneAuthToken",
    "phoneNumber",
    "userPhoneNumber",
    "openaiApiKey",
  ];

  for (const key of required) {
    if (!config[key as keyof typeof config]) {
      throw new Error(`Missing required environment variable: BETTERCALLCLAUDE_${key.toUpperCase()}`);
    }
  }

  if (config.transport === "ngrok" && !config.ngrokAuthtoken) {
    throw new Error("BETTERCALLCLAUDE_NGROK_AUTHTOKEN is required when using ngrok transport");
  }
}

// Initialize managers
const conversationManager = new ConversationManager();
const webhookSecurity = new WebhookSecurity(config);

let phoneCallManager: PhoneCallManager;
let messagingManager: MessagingManager;
let transportManager: TransportManager;
let publicUrl: string = "";
let taskExecutor: TaskExecutor;
let phoneAPI: ReturnType<typeof createPhoneAPI>;

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
      // For form-encoded data (Twilio)
      (c as any).parsedBody = Object.fromEntries(new URLSearchParams(body));
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
  console.log(`[Inbound] Received call from ${provider}:`, JSON.stringify(body).slice(0, 200));

  try {
    const callData = phoneCallManager.parseInboundWebhook(provider, body);

    if (callData.type === "call.initiated") {
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
  console.log(`[Gather] Speech input for conversation ${conversationId}`);

  try {
    const speechResult = phoneCallManager.parseSpeechResult(provider, body);

    if (speechResult.transcript) {
      console.log(`[Gather] Transcript: "${speechResult.transcript}"`);

      // Store the message
      conversationManager.addMessage(conversationId, "user", speechResult.transcript);

      // Check if there's a pending question from spawned Claude
      const wasQuestionPending = phoneAPI.resolveQuestion(conversationId, speechResult.transcript);

      if (wasQuestionPending) {
        // Claude asked a question, we resolved it - keep call on hold
        console.log(`[Gather] Resolved pending question for ${conversationId}`);
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
        console.log(`[Gather] Spawning Claude for: ${speechResult.transcript}`);

        // Check if there's context from a previous task (callback follow-up)
        const context = taskExecutor.getTaskContext(conversationId);
        if (context) {
          console.log(`[Gather] Found prior context: ${context.completionSummary.slice(0, 50)}...`);
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
  console.log(`[Status] Conversation ${conversationId} status update:`, body);

  try {
    const status = phoneCallManager.parseStatusWebhook(provider, body);

    if (status.state === "completed" || status.state === "failed") {
      conversationManager.updateState(conversationId, ConversationState.ENDED);
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
  console.log(`[SMS] Received from ${provider}:`, JSON.stringify(body).slice(0, 200));

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
      console.log(`[SMS] Added message to conversation ${conversation.id}`);
    }

    return c.text("OK", 200);
  } catch (error) {
    console.error("[SMS] Error:", error);
    return c.text("Error", 500);
  }
});

// ============================================
// WHATSAPP WEBHOOKS
// ============================================

app.post("/webhook/:provider/whatsapp", async (c) => {
  const provider = c.req.param("provider") as "telnyx" | "twilio";
  const body = (c as any).parsedBody;
  console.log(`[WhatsApp] Received from ${provider}:`, JSON.stringify(body).slice(0, 200));

  try {
    const message = messagingManager.parseInboundMessage(provider, body);

    if (message && message.type === "whatsapp") {
      // Find or create conversation for this sender
      const conversation = conversationManager.findOrCreateConversation(
        ChannelType.WHATSAPP,
        message.messageId,
        message.from,
        message.to
      );

      // Add the message
      conversationManager.addMessage(conversation.id, "user", message.content);
      console.log(`[WhatsApp] Added message to conversation ${conversation.id}`);
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
  console.log(`[MessageStatus] Conversation ${conversationId}:`, body);

  try {
    const status = messagingManager.parseStatusWebhook(provider, body);
    if (status) {
      console.log(`[MessageStatus] Message ${status.messageId} status: ${status.status}`);
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
    transport: config.transport,
    publicUrl,
    activeConversations: {
      voice: conversationManager.getActiveConversations(ChannelType.VOICE).length,
      sms: conversationManager.getActiveConversations(ChannelType.SMS).length,
      whatsapp: conversationManager.getActiveConversations(ChannelType.WHATSAPP).length,
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
  console.log("[Init] Starting Better Call Claude MCP Server v2.0...");

  // Validate configuration
  validateConfig();
  console.log("[Init] Configuration validated");

  // Initialize transport
  transportManager = new TransportManager(config);
  publicUrl = await transportManager.start(config.port);
  console.log(`[Init] Transport ready: ${publicUrl}`);

  // Initialize managers
  phoneCallManager = new PhoneCallManager(config);
  messagingManager = new MessagingManager(config);
  console.log(`[Init] Phone provider: ${config.phoneProvider}`);
  console.log(`[Init] Channels enabled: Voice, SMS, WhatsApp`);

  // Initialize task executor and phone API for autonomous operation
  taskExecutor = new TaskExecutor(publicUrl);
  phoneAPI = createPhoneAPI(
    phoneCallManager,
    conversationManager,
    {
      phoneProvider: config.phoneProvider,
      userPhoneNumber: config.userPhoneNumber,
    },
    () => publicUrl,
    taskExecutor,  // Pass taskExecutor for context preservation
    messagingManager  // Pass messagingManager for SMS/WhatsApp
  );
  app.route("/api", phoneAPI.api);
  console.log(`[Init] Autonomous phone API ready at ${publicUrl}/api/*`);

  // Start HTTP server
  const httpServer = serve({
    port: config.port,
    fetch: app.fetch,
  });
  console.log(`[Init] HTTP server listening on port ${config.port}`);
  console.log(`[Init] Webhooks:`);
  console.log(`       Voice:    ${publicUrl}/webhook/${config.phoneProvider}/inbound`);
  console.log(`       SMS:      ${publicUrl}/webhook/${config.phoneProvider}/sms`);
  console.log(`       WhatsApp: ${publicUrl}/webhook/${config.phoneProvider}/whatsapp`);
  console.log(`[Init] Phone API (for spawned Claude):`);
  console.log(`       Ask:      POST ${publicUrl}/api/ask/:conversationId`);
  console.log(`       Say:      POST ${publicUrl}/api/say/:conversationId`);
  console.log(`       Complete: POST ${publicUrl}/api/complete/:conversationId`);

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[Init] MCP server connected via stdio");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("[Shutdown] Received SIGINT, cleaning up...");
    httpServer.stop();
    await transportManager.stop();
    await server.close();
    process.exit(0);
  });

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
