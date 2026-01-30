import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { createPhoneAPI } from "../../src/phone-api";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";

// Mock PhoneCallManager
function createMockPhoneCallManager() {
  return {
    speakToCall: mock(() => Promise.resolve()),
    initiateCall: mock(() => Promise.resolve("CA_NEW")),
    endCall: mock(() => Promise.resolve()),
    generateAnswerTwiML: mock(() => "<Response/>"),
    generateGatherTwiML: mock(() => "<Response/>"),
    generateHoldTwiML: mock(() => "<Response/>"),
    parseInboundWebhook: mock(() => ({ type: "call.initiated", providerCallId: "p1", from: "+1", to: "+2" })),
    parseSpeechResult: mock(() => ({ transcript: "test" })),
    parseStatusWebhook: mock(() => ({ state: "completed" })),
  } as any;
}

function createMockMessagingManager() {
  return {
    sendSMS: mock(() => Promise.resolve("SM_123")),
    sendWhatsApp: mock(() => Promise.resolve("SM_456")),
  } as any;
}

function createMockTaskExecutor() {
  return {
    recordCompletion: mock(() => {}),
    linkCallback: mock(() => {}),
    getExecution: mock(() => undefined),
    getTaskContext: mock(() => undefined),
    getLatestTaskContext: mock(() => undefined),
    executeTask: mock(() => Promise.resolve()),
    killTask: mock(() => false),
  } as any;
}

describe("Phone API", () => {
  let conversationManager: ConversationManager;
  let phoneCallManager: ReturnType<typeof createMockPhoneCallManager>;
  let messagingManager: ReturnType<typeof createMockMessagingManager>;
  let taskExecutor: ReturnType<typeof createMockTaskExecutor>;
  let app: Hono;
  let phoneAPI: ReturnType<typeof createPhoneAPI>;

  beforeEach(() => {
    conversationManager = new ConversationManager();
    phoneCallManager = createMockPhoneCallManager();
    messagingManager = createMockMessagingManager();
    taskExecutor = createMockTaskExecutor();

    phoneAPI = createPhoneAPI(
      phoneCallManager,
      conversationManager,
      { phoneProvider: "twilio", userPhoneNumber: "+15551234567" },
      () => "https://example.com",
      taskExecutor,
      messagingManager
    );

    app = new Hono();
    app.route("/api", phoneAPI.api);
  });

  async function request(method: string, path: string, body?: any) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    return app.request(path, opts);
  }

  describe("GET /api/status/:conversationId", () => {
    it("returns not_found for unknown conversation", async () => {
      const res = await request("GET", "/api/status/unknown");
      const data = await res.json();
      expect(data.state).toBe("not_found");
      expect(data.active).toBeFalsy();
    });

    it("returns active for live conversation", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ACTIVE);

      const res = await request("GET", "/api/status/c1");
      const data = await res.json();
      expect(data.active).toBe(true);
      expect(data.state).toBe("active");
    });
  });

  describe("POST /api/say/:conversationId", () => {
    it("speaks to active call", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ACTIVE);

      const res = await request("POST", "/api/say/c1", { message: "Working on it" });
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.delivered).toBe(true);
      expect(phoneCallManager.speakToCall).toHaveBeenCalled();
    });

    it("returns delivered=false for ended conversation", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ENDED);

      const res = await request("POST", "/api/say/c1", { message: "test" });
      const data = await res.json();
      expect(data.delivered).toBe(false);
    });
  });

  describe("POST /api/sms", () => {
    it("sends SMS", async () => {
      const res = await request("POST", "/api/sms", { message: "Hello via SMS" });
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.messageId).toBe("SM_123");
      expect(messagingManager.sendSMS).toHaveBeenCalled();
    });
  });

  describe("POST /api/whatsapp", () => {
    it("sends WhatsApp message", async () => {
      const res = await request("POST", "/api/whatsapp", { message: "Hello via WhatsApp" });
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.messageId).toBe("SM_456");
      expect(messagingManager.sendWhatsApp).toHaveBeenCalled();
    });
  });

  describe("POST /api/complete/:conversationId", () => {
    it("speaks to active call and records completion", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ACTIVE);

      const res = await request("POST", "/api/complete/c1", { summary: "Built the app" });
      const data = await res.json();
      expect(data.delivered).toBe("spoken");
      expect(taskExecutor.recordCompletion).toHaveBeenCalledWith("c1", "Built the app");
    });

    it("initiates callback when user hung up", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ENDED);

      const res = await request("POST", "/api/complete/c1", { summary: "Done" });
      const data = await res.json();
      expect(data.delivered).toBe("callback");
      expect(phoneCallManager.initiateCall).toHaveBeenCalled();
    });
  });

  describe("resolveQuestion", () => {
    it("resolves pending question", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.updateState("c1", ConversationState.ACTIVE);

      // Start ask in background (it will block waiting for answer)
      const askPromise = request("POST", "/api/ask/c1", { message: "What stack?" });

      // Give it a tick to register the pending question
      await new Promise(r => setTimeout(r, 50));

      // Simulate user answering via webhook
      const resolved = phoneAPI.resolveQuestion("c1", "React");
      expect(resolved).toBe(true);

      const res = await askPromise;
      const data = await res.json();
      expect(data.response).toBe("React");
    });

    it("returns false when no pending question", () => {
      expect(phoneAPI.resolveQuestion("c1", "answer")).toBe(false);
    });
  });

  describe("WhatsApp wait", () => {
    it("hasPendingWhatsAppWait returns false initially", () => {
      expect(phoneAPI.hasPendingWhatsAppWait()).toBe(false);
    });

    it("resolves whatsapp-wait when message arrives", async () => {
      const waitPromise = request("POST", "/api/whatsapp-wait", { timeout_ms: 5000 });

      // Wait for request to register
      await new Promise(r => setTimeout(r, 50));
      expect(phoneAPI.hasPendingWhatsAppWait()).toBe(true);

      phoneAPI.resolveWhatsAppWait("Hello from WhatsApp");

      const res = await waitPromise;
      const data = await res.json();
      expect(data.received).toBe(true);
      expect(data.message).toBe("Hello from WhatsApp");
    });

    it("returns timeout when no message", async () => {
      const res = await request("POST", "/api/whatsapp-wait", { timeout_ms: 50 });
      const data = await res.json();
      expect(data.received).toBe(false);
      expect(data.reason).toBe("timeout");
    });
  });
});
