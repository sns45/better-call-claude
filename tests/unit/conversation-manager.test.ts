import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";

describe("ConversationManager", () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
  });

  describe("createConversation", () => {
    it("creates a voice conversation with RINGING state", () => {
      const conv = manager.createConversation(
        "conv-1", ChannelType.VOICE, ConversationDirection.INBOUND, "provider-1", { from: "+1111" }
      );
      expect(conv.id).toBe("conv-1");
      expect(conv.channel).toBe(ChannelType.VOICE);
      expect(conv.state).toBe(ConversationState.RINGING);
      expect(conv.messages).toHaveLength(0);
      expect(conv.metadata?.from).toBe("+1111");
    });

    it("creates an SMS conversation with ACTIVE state", () => {
      const conv = manager.createConversation(
        "conv-2", ChannelType.SMS, ConversationDirection.INBOUND, "msg-1"
      );
      expect(conv.state).toBe(ConversationState.ACTIVE);
    });

    it("creates a WhatsApp conversation with ACTIVE state", () => {
      const conv = manager.createConversation(
        "conv-3", ChannelType.WHATSAPP, ConversationDirection.OUTBOUND, "msg-2"
      );
      expect(conv.state).toBe(ConversationState.ACTIVE);
      expect(conv.direction).toBe(ConversationDirection.OUTBOUND);
    });
  });

  describe("getConversation / getConversationByProviderId", () => {
    it("retrieves by id", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "p1");
      expect(manager.getConversation("c1")).toBeDefined();
      expect(manager.getConversation("nope")).toBeUndefined();
    });

    it("retrieves by provider id", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "p1");
      expect(manager.getConversationByProviderId("p1")?.id).toBe("c1");
      expect(manager.getConversationByProviderId("nope")).toBeUndefined();
    });
  });

  describe("findOrCreateConversation", () => {
    it("reuses existing active conversation from same sender", () => {
      const first = manager.createConversation(
        "c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1", { from: "+1000", to: "+2000" }
      );
      const found = manager.findOrCreateConversation(ChannelType.SMS, "m2", "+1000", "+2000");
      expect(found.id).toBe("c1");
    });

    it("creates new conversation if no active match", () => {
      const conv = manager.findOrCreateConversation(ChannelType.WHATSAPP, "m1", "+1000", "+2000");
      expect(conv.id).toBeDefined();
      expect(conv.channel).toBe(ChannelType.WHATSAPP);
    });

    it("does not reuse ended conversations", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1", { from: "+1000" });
      manager.updateState("c1", ConversationState.ENDED);
      const conv = manager.findOrCreateConversation(ChannelType.SMS, "m2", "+1000", "+2000");
      expect(conv.id).not.toBe("c1");
    });
  });

  describe("updateState", () => {
    it("updates state and sets endedAt for ENDED", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      manager.updateState("c1", ConversationState.ACTIVE);
      expect(manager.getConversation("c1")!.state).toBe(ConversationState.ACTIVE);

      manager.updateState("c1", ConversationState.ENDED);
      const conv = manager.getConversation("c1")!;
      expect(conv.state).toBe(ConversationState.ENDED);
      expect(conv.endedAt).toBeDefined();
    });

    it("silently ignores unknown conversation", () => {
      // Should not throw
      manager.updateState("unknown", ConversationState.ENDED);
    });
  });

  describe("addMessage", () => {
    it("adds messages to conversation", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      manager.addMessage("c1", "user", "hello");
      manager.addMessage("c1", "assistant", "hi back");
      const conv = manager.getConversation("c1")!;
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[1].content).toBe("hi back");
    });

    it("silently ignores unknown conversation", () => {
      manager.addMessage("nope", "user", "hello");
    });
  });

  describe("waiters", () => {
    it("waitForResponse resolves when user message arrives", async () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.OUTBOUND, "p1");
      manager.addMessage("c1", "assistant", "question?");

      const promise = manager.waitForResponse("c1", 5000);
      // Simulate user replying after a tick
      setTimeout(() => manager.addMessage("c1", "user", "answer"), 10);
      const result = await promise;
      expect(result).toBe("answer");
    });

    it("waitForResponse resolves immediately if last message is from user", async () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.addMessage("c1", "user", "already here");
      const result = await manager.waitForResponse("c1", 1000);
      expect(result).toBe("already here");
    });

    it("waitForResponse returns null on timeout", async () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.OUTBOUND, "m1");
      manager.addMessage("c1", "assistant", "question");
      const result = await manager.waitForResponse("c1", 50);
      expect(result).toBeNull();
    });

    it("waitForResponse returns null for unknown conversation", async () => {
      const result = await manager.waitForResponse("nope", 50);
      expect(result).toBeNull();
    });

    it("waitForInbound resolves when inbound message arrives", async () => {
      const promise = manager.waitForInbound(5000, ChannelType.SMS);
      setTimeout(() => {
        const conv = manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
        manager.addMessage("c1", "user", "incoming");
      }, 10);
      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.id).toBe("c1");
    });

    it("waitForInbound returns null on timeout", async () => {
      const result = await manager.waitForInbound(50, ChannelType.VOICE);
      expect(result).toBeNull();
    });

    it("getPendingInbound returns pending conversation", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.addMessage("c1", "user", "hello");
      const pending = manager.getPendingInbound(ChannelType.SMS);
      expect(pending).not.toBeNull();
      expect(pending!.id).toBe("c1");
    });

    it("getPendingInbound filters by channel", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.addMessage("c1", "user", "hello");
      expect(manager.getPendingInbound(ChannelType.WHATSAPP)).toBeNull();
      expect(manager.getPendingInbound(ChannelType.SMS)).not.toBeNull();
    });
  });

  describe("getActiveConversations", () => {
    it("returns non-ended conversations", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.createConversation("c2", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      manager.updateState("c1", ConversationState.ENDED);
      expect(manager.getActiveConversations()).toHaveLength(1);
      expect(manager.getActiveConversations(ChannelType.SMS)).toHaveLength(0);
      expect(manager.getActiveConversations(ChannelType.VOICE)).toHaveLength(1);
    });
  });

  describe("cleanupOld", () => {
    it("removes old ended conversations", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.updateState("c1", ConversationState.ENDED);
      // Manually set endedAt to past
      const conv = manager.getConversation("c1")!;
      conv.endedAt = new Date(Date.now() - 7200000); // 2 hours ago

      manager.cleanupOld(3600000);
      expect(manager.getConversation("c1")).toBeUndefined();
    });

    it("keeps recent ended conversations", () => {
      manager.createConversation("c1", ChannelType.SMS, ConversationDirection.INBOUND, "m1");
      manager.updateState("c1", ConversationState.ENDED);
      manager.cleanupOld(3600000);
      expect(manager.getConversation("c1")).toBeDefined();
    });
  });

  describe("legacy aliases", () => {
    it("createCall delegates to createConversation", () => {
      const conv = manager.createCall("c1", ConversationDirection.INBOUND, "p1");
      expect(conv.channel).toBe(ChannelType.VOICE);
    });

    it("getCall delegates to getConversation", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      expect(manager.getCall("c1")).toBeDefined();
    });

    it("getCallByProviderId delegates", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      expect(manager.getCallByProviderId("p1")?.id).toBe("c1");
    });

    it("addTranscript delegates to addMessage", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      manager.addTranscript("c1", "user", "test");
      expect(manager.getConversation("c1")!.messages).toHaveLength(1);
    });

    it("getPendingInboundCall delegates", () => {
      expect(manager.getPendingInboundCall()).toBeNull();
    });

    it("getActiveCalls delegates", () => {
      manager.createConversation("c1", ChannelType.VOICE, ConversationDirection.INBOUND, "p1");
      expect(manager.getActiveCalls()).toHaveLength(1);
    });
  });
});
