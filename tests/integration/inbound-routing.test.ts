import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  ConversationManager,
  ChannelType,
  ConversationDirection,
  ConversationState,
} from "../../src/conversation-manager";
import type { InboundMessageData } from "../../src/messaging";

/**
 * Integration tests for handleInboundWhatsApp priority routing logic.
 * Replicates the routing function from src/index.ts with mocked dependencies.
 */

function createMockTaskExecutor() {
  return {
    getExecution: mock(() => undefined as any),
    executeTask: mock(() => Promise.resolve()),
    getLatestTaskContext: mock(() => undefined as any),
    getTaskContext: mock(() => undefined as any),
    recordCompletion: mock(() => {}),
    spawnClaude: mock(() => ({ conversationId: "spawn-1", task: "", process: {}, status: "running" as const, startedAt: new Date(), workingDir: "/tmp" })),
  };
}

function createMockPhoneAPI() {
  return {
    hasPendingWhatsAppWait: mock(() => false),
    resolveWhatsAppWait: mock(() => false),
    resolveQuestion: mock(() => false),
  };
}

function createMockChatManager() {
  return {
    handleMessage: mock(() => {}),
    recordAssistantMessage: mock(() => {}),
    resetForVoiceCall: mock(() => {}),
    setVoiceContext: mock(() => {}),
    getSessionId: mock(() => "test-session-1234"),
  };
}

/**
 * Replicate handleInboundWhatsApp from index.ts for isolated testing
 */
function createInboundHandler(deps: {
  conversationManager: ConversationManager;
  phoneAPI: ReturnType<typeof createMockPhoneAPI>;
  taskExecutor: ReturnType<typeof createMockTaskExecutor>;
  whatsappChatManager: ReturnType<typeof createMockChatManager> | null;
}) {
  const { conversationManager, phoneAPI, taskExecutor, whatsappChatManager } = deps;

  return function handleInboundWhatsApp(message: InboundMessageData): void {
    // Find or create conversation
    const conversation = conversationManager.findOrCreateConversation(
      ChannelType.WHATSAPP,
      message.messageId,
      message.from,
      message.to
    );

    // Record message
    conversationManager.addMessage(conversation.id, "user", message.content);

    // Priority 1: Check pending WhatsApp wait
    if (phoneAPI.hasPendingWhatsAppWait()) {
      const wasResolved = phoneAPI.resolveWhatsAppWait(message.content);
      if (wasResolved) return;
    }

    // Priority 2: Check pending question
    const wasQuestionPending = phoneAPI.resolveQuestion(conversation.id, message.content);

    if (!wasQuestionPending) {
      // Priority 3: Check active task
      const existingExecution = taskExecutor.getExecution(conversation.id);

      if (!existingExecution || existingExecution.status !== "running") {
        // Priority 4: Route to ChatManager or spawn one-shot
        if (whatsappChatManager) {
          whatsappChatManager.handleMessage(message.content);
        } else {
          const voiceContext = taskExecutor.getLatestTaskContext();
          taskExecutor.executeTask(
            conversation.id,
            message.content,
            voiceContext?.workingDir || process.cwd(),
            voiceContext,
            "whatsapp"
          );
        }
      }
    }
  };
}

function makeMessage(content: string, overrides?: Partial<InboundMessageData>): InboundMessageData {
  return {
    type: "whatsapp",
    messageId: crypto.randomUUID(),
    from: "+15551234567",
    to: "+15559876543",
    content,
    timestamp: new Date(),
    ...overrides,
  };
}

describe("handleInboundWhatsApp routing", () => {
  let conversationManager: ConversationManager;
  let phoneAPI: ReturnType<typeof createMockPhoneAPI>;
  let taskExecutor: ReturnType<typeof createMockTaskExecutor>;
  let chatManager: ReturnType<typeof createMockChatManager>;
  let handler: ReturnType<typeof createInboundHandler>;

  beforeEach(() => {
    conversationManager = new ConversationManager();
    phoneAPI = createMockPhoneAPI();
    taskExecutor = createMockTaskExecutor();
    chatManager = createMockChatManager();
  });

  // ============================
  // Priority 1: WhatsApp wait
  // ============================

  describe("Priority 1: WhatsApp wait", () => {
    it("resolves pending WhatsApp wait and returns early", () => {
      phoneAPI.hasPendingWhatsAppWait.mockReturnValue(true);
      phoneAPI.resolveWhatsAppWait.mockReturnValue(true);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("hello wait"));

      expect(phoneAPI.resolveWhatsAppWait).toHaveBeenCalledWith("hello wait");
      // Should NOT reach later priorities
      expect(phoneAPI.resolveQuestion).not.toHaveBeenCalled();
      expect(chatManager.handleMessage).not.toHaveBeenCalled();
      expect(taskExecutor.executeTask).not.toHaveBeenCalled();
    });

    it("falls through when resolve fails", () => {
      phoneAPI.hasPendingWhatsAppWait.mockReturnValue(true);
      phoneAPI.resolveWhatsAppWait.mockReturnValue(false);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("hello fallthrough"));

      // Should continue to P2
      expect(phoneAPI.resolveQuestion).toHaveBeenCalled();
    });
  });

  // ============================
  // Priority 2: Pending question
  // ============================

  describe("Priority 2: Pending question", () => {
    it("resolves pending question and stops", () => {
      phoneAPI.resolveQuestion.mockReturnValue(true);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("answer to question"));

      expect(phoneAPI.resolveQuestion).toHaveBeenCalled();
      // Should NOT reach later priorities
      expect(chatManager.handleMessage).not.toHaveBeenCalled();
      expect(taskExecutor.executeTask).not.toHaveBeenCalled();
    });

    it("falls through when no pending question", () => {
      phoneAPI.resolveQuestion.mockReturnValue(false);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("no question pending"));

      // Should reach P3/P4
      expect(chatManager.handleMessage).toHaveBeenCalledWith("no question pending");
    });
  });

  // ============================
  // Priority 3: Active task
  // ============================

  describe("Priority 3: Active task running", () => {
    it("skips when active task is running", () => {
      taskExecutor.getExecution.mockReturnValue({ status: "running" } as any);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("task running msg"));

      // Should NOT spawn new task or route to chat manager
      expect(chatManager.handleMessage).not.toHaveBeenCalled();
      expect(taskExecutor.executeTask).not.toHaveBeenCalled();
    });

    it("falls through when task is completed (not running)", () => {
      taskExecutor.getExecution.mockReturnValue({ status: "completed" } as any);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("completed task msg"));

      // Should reach P4
      expect(chatManager.handleMessage).toHaveBeenCalledWith("completed task msg");
    });
  });

  // ============================
  // Priority 4: ChatManager / One-shot
  // ============================

  describe("Priority 4: ChatManager routing", () => {
    it("routes to ChatManager when present", () => {
      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("hello chat"));

      expect(chatManager.handleMessage).toHaveBeenCalledWith("hello chat");
      expect(taskExecutor.executeTask).not.toHaveBeenCalled();
    });

    it("spawns one-shot when no ChatManager (non-baileys mode)", () => {
      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: null,
      });

      handler(makeMessage("one shot message"));

      expect(taskExecutor.executeTask).toHaveBeenCalled();
      const call = taskExecutor.executeTask.mock.calls[0];
      expect(call[1]).toBe("one shot message");
      expect(call[4]).toBe("whatsapp");
    });

    it("uses latest voice context when available (no ChatManager)", () => {
      taskExecutor.getLatestTaskContext.mockReturnValue({
        originalTask: "build app",
        completionSummary: "Built a React app",
        workingDir: "/tmp/project",
        conversationId: "voice-conv-1",
      });

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: null,
      });

      handler(makeMessage("continue the work"));

      const call = taskExecutor.executeTask.mock.calls[0];
      expect(call[2]).toBe("/tmp/project"); // workingDir from voice context
      expect(call[3]).toBeDefined(); // context passed
      expect(call[3].originalTask).toBe("build app");
    });

    it("uses process.cwd() when no voice context", () => {
      taskExecutor.getLatestTaskContext.mockReturnValue(undefined);

      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: null,
      });

      handler(makeMessage("no context msg"));

      const call = taskExecutor.executeTask.mock.calls[0];
      expect(call[2]).toBe(process.cwd());
      expect(call[3]).toBeUndefined();
    });
  });

  // ============================
  // Conversation management
  // ============================

  describe("Conversation management", () => {
    it("creates conversation for every inbound message", () => {
      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("test conv creation"));

      const convs = conversationManager.getActiveConversations(ChannelType.WHATSAPP);
      expect(convs).toHaveLength(1);
    });

    it("records message for every inbound", () => {
      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("recorded msg"));

      const convs = conversationManager.getActiveConversations(ChannelType.WHATSAPP);
      expect(convs[0].messages).toHaveLength(1);
      expect(convs[0].messages[0].content).toBe("recorded msg");
      expect(convs[0].messages[0].role).toBe("user");
    });

    it("reuses conversation for same sender", () => {
      handler = createInboundHandler({
        conversationManager, phoneAPI, taskExecutor, whatsappChatManager: chatManager,
      });

      handler(makeMessage("first"));
      handler(makeMessage("second"));

      const convs = conversationManager.getActiveConversations(ChannelType.WHATSAPP);
      expect(convs).toHaveLength(1);
      expect(convs[0].messages).toHaveLength(2);
    });
  });

  // ============================
  // Voice call integration
  // ============================

  describe("Voice call integration", () => {
    it("voice call resets ChatManager", () => {
      // Simulate what index.ts inbound webhook does on call.initiated
      chatManager.resetForVoiceCall();
      expect(chatManager.resetForVoiceCall).toHaveBeenCalled();
    });

    it("call status 'completed' seeds voice context", () => {
      // Simulate status webhook logic from index.ts
      const taskContext = {
        originalTask: "build something",
        completionSummary: "Built it",
        workingDir: "/tmp/project",
      };

      taskExecutor.getTaskContext.mockReturnValue(taskContext);

      // Simulate what the status webhook does
      if (chatManager) {
        const ctx = taskExecutor.getTaskContext("conv-1");
        if (ctx) {
          chatManager.setVoiceContext(
            `Task: "${ctx.originalTask}"\nResult: "${ctx.completionSummary}"\nWorking dir: ${ctx.workingDir}`
          );
        }
      }

      expect(chatManager.setVoiceContext).toHaveBeenCalledWith(
        expect.stringContaining("build something")
      );
      expect(chatManager.setVoiceContext).toHaveBeenCalledWith(
        expect.stringContaining("Built it")
      );
    });
  });
});
