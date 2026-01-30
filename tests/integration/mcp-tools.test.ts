import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";

/**
 * Integration tests for MCP tool handlers.
 * Tests the tool handler logic with real ConversationManager
 * but mocked external services.
 */

// Simplified tool handler that mirrors index.ts logic
function createToolHandler(deps: {
  conversationManager: ConversationManager;
  phoneCallManager: any;
  messagingManager: any;
  config: { userPhoneNumber: string; phoneProvider: string; transcriptTimeoutMs: number };
  publicUrl: string;
}) {
  const { conversationManager, phoneCallManager, messagingManager, config } = deps;

  return async function handleTool(name: string, args: Record<string, any> = {}): Promise<any> {
    switch (name) {
      case "receive_inbound_call": {
        const timeoutMs = args.timeout_ms || 5000;
        const pending = conversationManager.getPendingInbound(ChannelType.VOICE);
        if (pending) {
          const lastMessage = pending.messages[pending.messages.length - 1];
          return { success: true, conversation_id: pending.id, channel: "voice", user_message: lastMessage?.content || "" };
        }
        const conv = await conversationManager.waitForInbound(timeoutMs, ChannelType.VOICE);
        if (conv) {
          const lastMessage = conv.messages[conv.messages.length - 1];
          return { success: true, conversation_id: conv.id, channel: "voice", user_message: lastMessage?.content || "" };
        }
        return { success: false, error: "No incoming call received within timeout" };
      }

      case "send_sms": {
        const messageId = await messagingManager.sendSMS(config.userPhoneNumber, args.message);
        const conversationId = crypto.randomUUID();
        conversationManager.createConversation(conversationId, ChannelType.SMS, ConversationDirection.OUTBOUND, messageId, { to: config.userPhoneNumber });
        conversationManager.addMessage(conversationId, "assistant", args.message);

        if (args.wait_for_reply !== false) {
          const response = await conversationManager.waitForResponse(conversationId, args.timeout_ms || 100);
          return { success: true, conversation_id: conversationId, channel: "sms", response: response || "No reply received" };
        }
        return { success: true, conversation_id: conversationId, channel: "sms", message: "SMS sent" };
      }

      case "send_whatsapp": {
        const messageId = await messagingManager.sendWhatsApp(config.userPhoneNumber, args.message);
        const conversationId = crypto.randomUUID();
        conversationManager.createConversation(conversationId, ChannelType.WHATSAPP, ConversationDirection.OUTBOUND, messageId, { to: config.userPhoneNumber });
        conversationManager.addMessage(conversationId, "assistant", args.message);

        if (args.wait_for_reply !== false) {
          const response = await conversationManager.waitForResponse(conversationId, args.timeout_ms || 100);
          return { success: true, conversation_id: conversationId, channel: "whatsapp", response: response || "No reply received" };
        }
        return { success: true, conversation_id: conversationId, channel: "whatsapp", message: "WhatsApp message sent" };
      }

      case "reply_to_conversation": {
        const conv = conversationManager.getConversation(args.conversation_id);
        if (!conv) throw new Error(`Conversation ${args.conversation_id} not found`);
        if (conv.state === ConversationState.ENDED) throw new Error(`Conversation ${args.conversation_id} has ended`);

        if (conv.channel === ChannelType.SMS) {
          await messagingManager.sendSMS(conv.metadata?.from || config.userPhoneNumber, args.message);
        } else if (conv.channel === ChannelType.WHATSAPP) {
          await messagingManager.sendWhatsApp(conv.metadata?.from || config.userPhoneNumber, args.message);
        }
        conversationManager.addMessage(args.conversation_id, "assistant", args.message);

        if (args.wait_for_reply !== false) {
          const response = await conversationManager.waitForResponse(args.conversation_id, args.timeout_ms || 100);
          return { success: true, conversation_id: args.conversation_id, channel: conv.channel, response: response || "No reply received" };
        }
        return { success: true, conversation_id: args.conversation_id, channel: conv.channel, message: "Message sent" };
      }

      case "get_conversation_history": {
        const conv = conversationManager.getConversation(args.conversation_id);
        if (!conv) throw new Error(`Conversation ${args.conversation_id} not found`);
        return {
          conversation_id: args.conversation_id,
          channel: conv.channel,
          state: conv.state,
          direction: conv.direction,
          messages: conv.messages,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

describe("MCP Tool Handlers", () => {
  let conversationManager: ConversationManager;
  let handleTool: ReturnType<typeof createToolHandler>;
  let messagingManager: any;

  beforeEach(() => {
    conversationManager = new ConversationManager();
    messagingManager = {
      sendSMS: mock(() => Promise.resolve("SM_TOOL")),
      sendWhatsApp: mock(() => Promise.resolve("SM_WA_TOOL")),
    };

    handleTool = createToolHandler({
      conversationManager,
      phoneCallManager: {},
      messagingManager,
      config: { userPhoneNumber: "+15551234567", phoneProvider: "twilio", transcriptTimeoutMs: 180000 },
      publicUrl: "https://example.com",
    });
  });

  describe("receive_inbound_call", () => {
    it("returns pending inbound voice conversation", async () => {
      conversationManager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      conversationManager.addMessage("c1", "user", "build a website");

      const result = await handleTool("receive_inbound_call", { timeout_ms: 100 });
      expect(result.success).toBe(true);
      expect(result.conversation_id).toBe("c1");
      expect(result.user_message).toBe("build a website");
    });

    it("times out when no inbound call", async () => {
      const result = await handleTool("receive_inbound_call", { timeout_ms: 50 });
      expect(result.success).toBe(false);
    });

    it("waits and resolves when call arrives", async () => {
      const promise = handleTool("receive_inbound_call", { timeout_ms: 5000 });

      setTimeout(() => {
        conversationManager.createConversation("late", ChannelType.VOICE, ConversationDirection.INBOUND, "p-late");
        conversationManager.addMessage("late", "user", "late arrival");
      }, 20);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.user_message).toBe("late arrival");
    });
  });

  describe("send_sms", () => {
    it("sends SMS and creates conversation", async () => {
      const result = await handleTool("send_sms", { message: "Hello!", wait_for_reply: false });
      expect(result.success).toBe(true);
      expect(result.channel).toBe("sms");
      expect(result.message).toBe("SMS sent");
      expect(messagingManager.sendSMS).toHaveBeenCalledWith("+15551234567", "Hello!");
    });

    it("waits for reply and times out", async () => {
      const result = await handleTool("send_sms", { message: "Reply?", timeout_ms: 50 });
      expect(result.success).toBe(true);
      expect(result.response).toBe("No reply received");
    });

    it("receives reply when user responds", async () => {
      const promise = handleTool("send_sms", { message: "Question?", timeout_ms: 5000 });

      // Simulate user reply after a tick
      await new Promise(r => setTimeout(r, 20));
      // Find the created conversation and add a reply
      const convs = conversationManager.getActiveConversations(ChannelType.SMS);
      expect(convs).toHaveLength(1);
      conversationManager.addMessage(convs[0].id, "user", "My answer");

      const result = await promise;
      expect(result.response).toBe("My answer");
    });
  });

  describe("send_whatsapp", () => {
    it("sends WhatsApp and creates conversation", async () => {
      const result = await handleTool("send_whatsapp", { message: "Hello WA!", wait_for_reply: false });
      expect(result.success).toBe(true);
      expect(result.channel).toBe("whatsapp");
      expect(messagingManager.sendWhatsApp).toHaveBeenCalled();
    });
  });

  describe("reply_to_conversation", () => {
    it("replies to SMS conversation", async () => {
      conversationManager.createConversation("sms-1", ChannelType.SMS, ConversationDirection.INBOUND, "m1", { from: "+19990001111" });
      conversationManager.addMessage("sms-1", "user", "Hi");

      const result = await handleTool("reply_to_conversation", {
        conversation_id: "sms-1",
        message: "Reply!",
        wait_for_reply: false,
      });

      expect(result.success).toBe(true);
      expect(result.channel).toBe(ChannelType.SMS);
      expect(messagingManager.sendSMS).toHaveBeenCalledWith("+19990001111", "Reply!");
    });

    it("replies to WhatsApp conversation", async () => {
      conversationManager.createConversation("wa-1", ChannelType.WHATSAPP, ConversationDirection.INBOUND, "m1", { from: "+19990001111" });

      const result = await handleTool("reply_to_conversation", {
        conversation_id: "wa-1",
        message: "WA Reply!",
        wait_for_reply: false,
      });

      expect(result.success).toBe(true);
      expect(messagingManager.sendWhatsApp).toHaveBeenCalled();
    });

    it("throws for unknown conversation", async () => {
      await expect(
        handleTool("reply_to_conversation", { conversation_id: "nope", message: "hi" })
      ).rejects.toThrow("not found");
    });

    it("throws for ended conversation", async () => {
      conversationManager.createConversation("ended", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      conversationManager.updateState("ended", ConversationState.ENDED);

      await expect(
        handleTool("reply_to_conversation", { conversation_id: "ended", message: "hi" })
      ).rejects.toThrow("has ended");
    });
  });

  describe("get_conversation_history", () => {
    it("returns full conversation history", async () => {
      conversationManager.createConversation("hist-1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      conversationManager.addMessage("hist-1", "user", "Hello");
      conversationManager.addMessage("hist-1", "assistant", "Hi there");

      const result = await handleTool("get_conversation_history", { conversation_id: "hist-1" });
      expect(result.conversation_id).toBe("hist-1");
      expect(result.channel).toBe(ChannelType.SMS);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    it("throws for unknown conversation", async () => {
      await expect(
        handleTool("get_conversation_history", { conversation_id: "nope" })
      ).rejects.toThrow("not found");
    });
  });
});
