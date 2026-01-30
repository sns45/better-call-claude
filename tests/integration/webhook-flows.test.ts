import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";

/**
 * Integration tests for webhook flows.
 * Tests full Twilio webhook → conversation manager → response flows
 * with mocked external services.
 */

// Minimal mock of PhoneCallManager for webhook integration
function createMockPhoneCallManager() {
  return {
    parseInboundWebhook: (_provider: string, body: any) => {
      const callStatus = body?.CallStatus || "";
      let type: string = "unknown";
      if (callStatus === "ringing") type = "call.initiated";
      else if (callStatus === "in-progress") type = "call.answered";
      else if (callStatus === "completed") type = "call.hangup";
      return {
        type,
        providerCallId: body?.CallSid || "",
        from: body?.From || "",
        to: body?.To || "",
      };
    },
    parseSpeechResult: (_provider: string, body: any) => ({
      transcript: body?.SpeechResult || null,
      confidence: body?.Confidence ? parseFloat(body.Confidence) : undefined,
    }),
    parseStatusWebhook: (_provider: string, body: any) => {
      const stateMap: Record<string, string> = {
        "in-progress": "answered",
        completed: "completed",
        failed: "failed",
      };
      return { state: stateMap[body?.CallStatus] || "completed" };
    },
    generateAnswerTwiML: (message: string, gatherUrl: string) =>
      `<Response><Say>${message}</Say><Gather action="${gatherUrl}"/></Response>`,
    generateGatherTwiML: (message: string, url: string) =>
      `<Response><Say>${message}</Say><Gather action="${url}"/></Response>`,
    generateHoldTwiML: (message: string, url: string, wait: number) =>
      `<Response>${message ? `<Say>${message}</Say>` : ""}<Pause length="${wait}"/><Redirect>${url}</Redirect></Response>`,
    speakToCall: mock(() => Promise.resolve()),
    initiateCall: mock(() => Promise.resolve("CA_NEW")),
    endCall: mock(() => Promise.resolve()),
  } as any;
}

function createMockMessagingManager() {
  return {
    parseInboundMessage: (_provider: string, body: any) => {
      if (!body?.Body) return null;
      const from = body.From || "";
      const type = from.startsWith("whatsapp:") ? "whatsapp" : "sms";
      return {
        type,
        messageId: body.MessageSid || "",
        from: from.replace("whatsapp:", ""),
        to: (body.To || "").replace("whatsapp:", ""),
        content: body.Body || "",
      };
    },
    sendSMS: mock(() => Promise.resolve("SM_INT")),
    sendWhatsApp: mock(() => Promise.resolve("SM_WA_INT")),
  } as any;
}

describe("Webhook Flows (Twilio)", () => {
  let app: Hono;
  let conversationManager: ConversationManager;
  let phoneCallManager: ReturnType<typeof createMockPhoneCallManager>;
  let messagingManager: ReturnType<typeof createMockMessagingManager>;
  let mockTaskExecutor: any;
  let mockPhoneAPI: any;

  beforeEach(() => {
    conversationManager = new ConversationManager();
    phoneCallManager = createMockPhoneCallManager();
    messagingManager = createMockMessagingManager();
    mockTaskExecutor = {
      getExecution: mock(() => undefined),
      executeTask: mock(() => Promise.resolve()),
      getTaskContext: mock(() => undefined),
      getLatestTaskContext: mock(() => undefined),
    };
    mockPhoneAPI = {
      resolveQuestion: mock(() => false),
      resolveWhatsAppWait: mock(() => false),
      hasPendingWhatsAppWait: mock(() => false),
    };

    app = new Hono();

    // Simplified webhook security middleware (always pass)
    app.use("/webhook/*", async (c, next) => {
      const body = await c.req.text();
      try {
        (c as any).parsedBody = JSON.parse(body || "{}");
      } catch {
        try {
          (c as any).parsedBody = Object.fromEntries(new URLSearchParams(body));
        } catch {
          return c.json({ error: "Invalid body" }, 400);
        }
      }
      await next();
    });

    // Voice inbound
    app.post("/webhook/:provider/inbound", async (c) => {
      const body = (c as any).parsedBody;
      const callData = phoneCallManager.parseInboundWebhook("twilio", body);

      if (callData.type === "call.initiated") {
        const existingConversation = conversationManager.getConversationByProviderId(callData.providerCallId);
        if (existingConversation) {
          return c.text(phoneCallManager.generateAnswerTwiML("Hello!", `/webhook/twilio/gather/${existingConversation.id}`), 200, { "Content-Type": "text/xml" });
        }
        const conversationId = crypto.randomUUID();
        conversationManager.createConversation(conversationId, ChannelType.VOICE, ConversationDirection.INBOUND, callData.providerCallId, { from: callData.from, to: callData.to });
        return c.text(phoneCallManager.generateAnswerTwiML("Hello!", `/webhook/twilio/gather/${conversationId}`), 200, { "Content-Type": "text/xml" });
      }
      return c.text("OK", 200);
    });

    // Gather
    app.post("/webhook/:provider/gather/:conversationId", async (c) => {
      const conversationId = c.req.param("conversationId");
      const body = (c as any).parsedBody;
      const speechResult = phoneCallManager.parseSpeechResult("twilio", body);

      if (speechResult.transcript) {
        conversationManager.addMessage(conversationId, "user", speechResult.transcript);
        const wasQuestion = mockPhoneAPI.resolveQuestion(conversationId, speechResult.transcript);

        if (!wasQuestion) {
          const existing = mockTaskExecutor.getExecution(conversationId);
          if (!existing) {
            mockTaskExecutor.executeTask(conversationId, speechResult.transcript, "/tmp");
            return c.text(phoneCallManager.generateHoldTwiML("Got it...", `/webhook/twilio/hold/${conversationId}`, 10), 200, { "Content-Type": "text/xml" });
          }
        }
        return c.text(phoneCallManager.generateHoldTwiML("", `/webhook/twilio/hold/${conversationId}`, 30), 200, { "Content-Type": "text/xml" });
      }

      return c.text(phoneCallManager.generateGatherTwiML("I didn't catch that.", `/webhook/twilio/gather/${conversationId}`), 200, { "Content-Type": "text/xml" });
    });

    // SMS
    app.post("/webhook/:provider/sms", async (c) => {
      const body = (c as any).parsedBody;
      const message = messagingManager.parseInboundMessage("twilio", body);
      if (message && message.type === "sms") {
        const conversation = conversationManager.findOrCreateConversation(ChannelType.SMS, message.messageId, message.from, message.to);
        conversationManager.addMessage(conversation.id, "user", message.content);
      }
      return c.text("OK", 200);
    });

    // WhatsApp
    app.post("/webhook/:provider/whatsapp", async (c) => {
      const body = (c as any).parsedBody;
      const message = messagingManager.parseInboundMessage("twilio", body);
      if (message && message.type === "whatsapp") {
        const conversation = conversationManager.findOrCreateConversation(ChannelType.WHATSAPP, message.messageId, message.from, message.to);
        conversationManager.addMessage(conversation.id, "user", message.content);
      }
      return c.text("OK", 200);
    });

    // Status
    app.post("/webhook/:provider/status/:conversationId", async (c) => {
      const conversationId = c.req.param("conversationId");
      const body = (c as any).parsedBody;
      const status = phoneCallManager.parseStatusWebhook("twilio", body);
      if (status.state === "completed" || status.state === "failed") {
        conversationManager.updateState(conversationId, ConversationState.ENDED);
      } else if (status.state === "answered") {
        conversationManager.updateState(conversationId, ConversationState.ACTIVE);
      }
      return c.text("OK", 200);
    });
  });

  async function postWebhook(path: string, body: Record<string, string>) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  }

  async function postJSON(path: string, body: any) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("Inbound voice call flow", () => {
    it("creates conversation on inbound call", async () => {
      const res = await postJSON("/webhook/twilio/inbound", {
        CallSid: "CA_IN_1",
        CallStatus: "ringing",
        From: "+11111111111",
        To: "+12222222222",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Hello!");
      expect(text).toContain("<Gather");

      // Verify conversation created
      const conv = conversationManager.getConversationByProviderId("CA_IN_1");
      expect(conv).toBeDefined();
      expect(conv!.channel).toBe(ChannelType.VOICE);
      expect(conv!.direction).toBe(ConversationDirection.INBOUND);
    });

    it("handles duplicate inbound webhook (same CallSid)", async () => {
      // First call
      await postJSON("/webhook/twilio/inbound", {
        CallSid: "CA_DUP",
        CallStatus: "ringing",
        From: "+11111111111",
        To: "+12222222222",
      });

      // Second call with same SID
      const res = await postJSON("/webhook/twilio/inbound", {
        CallSid: "CA_DUP",
        CallStatus: "ringing",
        From: "+11111111111",
        To: "+12222222222",
      });

      expect(res.status).toBe(200);
      // Should reuse same conversation
      const text = await res.text();
      expect(text).toContain("Hello!");
    });
  });

  describe("Gather → task spawn flow", () => {
    it("spawns task on first speech input", async () => {
      // Create conversation
      const convId = crypto.randomUUID();
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_G1");

      const res = await postJSON(`/webhook/twilio/gather/${convId}`, {
        SpeechResult: "create a todo app",
        Confidence: "0.9",
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Got it");
      expect(text).toContain("<Pause");

      // Verify message recorded
      const conv = conversationManager.getConversation(convId)!;
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].content).toBe("create a todo app");

      // Verify task executor was called
      expect(mockTaskExecutor.executeTask).toHaveBeenCalled();
    });

    it("prompts again when no speech detected", async () => {
      const convId = crypto.randomUUID();
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_G2");

      const res = await postJSON(`/webhook/twilio/gather/${convId}`, {});
      const text = await res.text();
      expect(text).toContain("didn't catch");
    });
  });

  describe("SMS inbound", () => {
    it("creates conversation and records message", async () => {
      const res = await postJSON("/webhook/twilio/sms", {
        MessageSid: "SM_IN_1",
        From: "+13335551234",
        To: "+14445556789",
        Body: "Hello from SMS",
      });

      expect(res.status).toBe(200);

      // Find the conversation
      const convs = conversationManager.getActiveConversations(ChannelType.SMS);
      expect(convs).toHaveLength(1);
      expect(convs[0].messages[0].content).toBe("Hello from SMS");
      expect(convs[0].metadata?.from).toBe("+13335551234");
    });

    it("reuses existing conversation from same sender", async () => {
      await postJSON("/webhook/twilio/sms", {
        MessageSid: "SM1",
        From: "+13335551234",
        To: "+14445556789",
        Body: "First message",
      });
      await postJSON("/webhook/twilio/sms", {
        MessageSid: "SM2",
        From: "+13335551234",
        To: "+14445556789",
        Body: "Second message",
      });

      const convs = conversationManager.getActiveConversations(ChannelType.SMS);
      expect(convs).toHaveLength(1);
      expect(convs[0].messages).toHaveLength(2);
    });
  });

  describe("WhatsApp inbound", () => {
    it("creates WhatsApp conversation", async () => {
      const res = await postJSON("/webhook/twilio/whatsapp", {
        MessageSid: "SM_WA_1",
        From: "whatsapp:+13335551234",
        To: "whatsapp:+14445556789",
        Body: "Hello from WhatsApp",
      });

      expect(res.status).toBe(200);
      const convs = conversationManager.getActiveConversations(ChannelType.WHATSAPP);
      expect(convs).toHaveLength(1);
      expect(convs[0].messages[0].content).toBe("Hello from WhatsApp");
    });
  });

  describe("Status webhook", () => {
    it("marks conversation as ended on completed status", async () => {
      const convId = "status-test";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_S1");
      conversationManager.updateState(convId, ConversationState.ACTIVE);

      await postJSON(`/webhook/twilio/status/${convId}`, {
        CallStatus: "completed",
      });

      expect(conversationManager.getConversation(convId)!.state).toBe(ConversationState.ENDED);
    });

    it("marks conversation as active on answered status", async () => {
      const convId = "status-test-2";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_S2");

      await postJSON(`/webhook/twilio/status/${convId}`, {
        CallStatus: "in-progress",
      });

      expect(conversationManager.getConversation(convId)!.state).toBe(ConversationState.ACTIVE);
    });
  });

  describe("Security middleware rejection", () => {
    it("handles invalid body gracefully", async () => {
      // The simplified middleware will parse URLSearchParams as fallback
      const res = await app.request("/webhook/twilio/sms", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-valid-at-all{{{",
      });
      // Should still parse as URLSearchParams (empty) and return OK
      expect(res.status).toBe(200);
    });
  });
});
