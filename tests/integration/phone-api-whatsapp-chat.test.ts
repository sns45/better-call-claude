import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";
import { createPhoneAPI } from "../../src/phone-api";

/**
 * Integration tests for PhoneAPI + WhatsAppChatManager integration.
 * Tests POST /api/whatsapp, /api/whatsapp-wait, and cross-channel interactions.
 */

function createMockPhoneCallManager() {
  return {
    speakToCall: mock(() => Promise.resolve()),
    initiateCall: mock(() => Promise.resolve("CA_NEW")),
    endCall: mock(() => Promise.resolve()),
  } as any;
}

function createMockMessagingManager() {
  return {
    sendSMS: mock(() => Promise.resolve("SM_TEST")),
    sendWhatsApp: mock(() => Promise.resolve("WA_TEST")),
  } as any;
}

function createMockTaskExecutor() {
  return {
    recordCompletion: mock(() => {}),
    linkCallback: mock(() => {}),
    getExecution: mock(() => undefined),
    getTaskContext: mock(() => undefined),
  } as any;
}

function createMockChatManager() {
  return {
    handleMessage: mock(() => {}),
    recordAssistantMessage: mock(() => {}),
    resetForVoiceCall: mock(() => {}),
    setVoiceContext: mock(() => {}),
    getSessionId: mock(() => "session-1234"),
  };
}

describe("PhoneAPI + WhatsAppChatManager integration", () => {
  let app: Hono;
  let conversationManager: ConversationManager;
  let phoneCallManager: ReturnType<typeof createMockPhoneCallManager>;
  let messagingManager: ReturnType<typeof createMockMessagingManager>;
  let taskExecutor: ReturnType<typeof createMockTaskExecutor>;
  let chatManager: ReturnType<typeof createMockChatManager>;
  let phoneAPI: ReturnType<typeof createPhoneAPI>;

  beforeEach(() => {
    conversationManager = new ConversationManager();
    phoneCallManager = createMockPhoneCallManager();
    messagingManager = createMockMessagingManager();
    taskExecutor = createMockTaskExecutor();
    chatManager = createMockChatManager();

    phoneAPI = createPhoneAPI(
      phoneCallManager,
      conversationManager,
      { phoneProvider: "twilio", userPhoneNumber: "+15551234567" },
      () => "https://example.com",
      taskExecutor,
      messagingManager,
      chatManager as any,
    );

    app = new Hono();
    app.route("/api", phoneAPI.api);
  });

  async function postJSON(path: string, body: any) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJSON(path: string) {
    return app.request(path, { method: "GET" });
  }

  // ============================
  // POST /api/whatsapp
  // ============================

  describe("POST /api/whatsapp", () => {
    it("records in ChatManager after send", async () => {
      const res = await postJSON("/api/whatsapp", { message: "Hello from Claude" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);

      expect(messagingManager.sendWhatsApp).toHaveBeenCalledWith("+15551234567", "Hello from Claude");
      expect(chatManager.recordAssistantMessage).toHaveBeenCalledWith("Hello from Claude");
    });

    it("works without ChatManager", async () => {
      // Create phone API without chat manager
      const phoneAPINoChat = createPhoneAPI(
        phoneCallManager,
        conversationManager,
        { phoneProvider: "twilio", userPhoneNumber: "+15551234567" },
        () => "https://example.com",
        taskExecutor,
        messagingManager,
        undefined, // no chat manager
      );

      const noChatApp = new Hono();
      noChatApp.route("/api", phoneAPINoChat.api);

      const res = await noChatApp.request("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "no crash" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  // ============================
  // POST /api/whatsapp-wait
  // ============================

  describe("POST /api/whatsapp-wait", () => {
    it("resolves from inbound message via resolveWhatsAppWait", async () => {
      // Start the wait request (short timeout)
      const waitPromise = postJSON("/api/whatsapp-wait", { timeout_ms: 5000 });

      // Small delay to let the wait register
      await new Promise(r => setTimeout(r, 20));

      // Simulate inbound message resolving the wait
      const resolved = phoneAPI.resolveWhatsAppWait("Hello from user");
      expect(resolved).toBe(true);

      const res = await waitPromise;
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.received).toBe(true);
      expect(data.message).toBe("Hello from user");
    });

    it("times out when no message arrives", async () => {
      const res = await postJSON("/api/whatsapp-wait", { timeout_ms: 50 });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.received).toBe(false);
      expect(data.reason).toBe("timeout");
    });
  });

  // ============================
  // POST /api/complete
  // ============================

  describe("POST /api/complete", () => {
    it("records context for follow-up", async () => {
      // Create a conversation first
      const convId = "complete-test";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_1");
      conversationManager.updateState(convId, ConversationState.ENDED);

      const res = await postJSON(`/api/complete/${convId}`, {
        summary: "Created a React app",
      });

      expect(res.status).toBe(200);
      expect(taskExecutor.recordCompletion).toHaveBeenCalledWith(convId, "Created a React app");
    });
  });

  // ============================
  // POST /api/ask
  // ============================

  describe("POST /api/ask", () => {
    it("returns graceful fallback when conversation ended", async () => {
      const convId = "ask-ended";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_2");
      conversationManager.updateState(convId, ConversationState.ENDED);

      const res = await postJSON(`/api/ask/${convId}`, { message: "Are you there?" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.userOnCall).toBe(false);
      expect(data.response).toContain("proceed with");
    });
  });

  // ============================
  // POST /api/call
  // ============================

  describe("POST /api/call", () => {
    it("creates conversation record", async () => {
      const res = await postJSON("/api/call", { message: "Hello!" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.conversationId).toBeDefined();

      // Verify conversation was created
      const conv = conversationManager.getConversation(data.conversationId);
      expect(conv).toBeDefined();
      expect(conv!.channel).toBe(ChannelType.VOICE);
      expect(conv!.direction).toBe(ConversationDirection.OUTBOUND);
    });
  });

  // ============================
  // GET /api/status
  // ============================

  describe("GET /api/status", () => {
    it("returns active state for active conversation", async () => {
      const convId = "status-active";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_3");
      conversationManager.updateState(convId, ConversationState.ACTIVE);

      const res = await getJSON(`/api/status/${convId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.active).toBe(true);
      expect(data.state).toBe("active");
    });

    it("returns ended state for ended conversation", async () => {
      const convId = "status-ended";
      conversationManager.createConversation(convId, ChannelType.VOICE, ConversationDirection.INBOUND, "CA_4");
      conversationManager.updateState(convId, ConversationState.ENDED);

      const res = await getJSON(`/api/status/${convId}`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.active).toBe(false);
      expect(data.state).toBe("ended");
    });

    it("returns not_found for unknown conversation", async () => {
      const res = await getJSON("/api/status/unknown-id");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.active).toBeFalsy();
      expect(data.state).toBe("not_found");
    });
  });

  // ============================
  // POST /api/sms
  // ============================

  describe("POST /api/sms", () => {
    it("sends SMS successfully", async () => {
      const res = await postJSON("/api/sms", { message: "SMS test" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.messageId).toBe("SM_TEST");
      expect(messagingManager.sendSMS).toHaveBeenCalledWith("+15551234567", "SMS test");
    });
  });
});
