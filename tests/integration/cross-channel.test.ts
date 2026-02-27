import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { WhatsAppChatManager } from "../../src/whatsapp-chat";
import { TaskExecutor } from "../../src/task-executor";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

/**
 * Integration tests for cross-channel context sharing.
 * Tests the full voice→WhatsApp context lifecycle.
 */

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.pid = 55555;
  return proc;
}

describe("Cross-channel context sharing", () => {
  let executor: TaskExecutor;
  let chatManager: WhatsAppChatManager;
  let spawnSpy: ReturnType<typeof spyOn>;
  let mockProcs: any[];

  beforeEach(() => {
    mockProcs = [];
    executor = new TaskExecutor("https://example.com");
    spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
      const proc = createMockProcess();
      mockProcs.push(proc);
      return proc;
    });
    chatManager = new WhatsAppChatManager(executor, "https://example.com", "/tmp/work", 50);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  // ============================
  // Voice → TaskExecutor context
  // ============================

  describe("Voice call → TaskExecutor context", () => {
    it("voice call completes → context available in TaskExecutor", async () => {
      await executor.executeTask("voice-conv-1", "build a todo app", "/tmp/project");
      executor.recordCompletion("voice-conv-1", "Created React todo app in ./todo-app");

      const ctx = executor.getTaskContext("voice-conv-1");
      expect(ctx).toBeDefined();
      expect(ctx!.originalTask).toBe("build a todo app");
      expect(ctx!.completionSummary).toBe("Created React todo app in ./todo-app");
      expect(ctx!.workingDir).toBe("/tmp/project");
    });
  });

  // ============================
  // Voice → WhatsAppChatManager context
  // ============================

  describe("Voice call → WhatsAppChatManager context", () => {
    it("voice call completes → ChatManager gets voice context", () => {
      chatManager.setVoiceContext(
        'Task: "build a todo app"\nResult: "Created React todo app"\nWorking dir: /tmp/project'
      );

      // Verify context is set by checking prompt
      chatManager.handleMessage("what did we work on?");
      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain("Voice Call Context");
      expect(prompt).toContain("build a todo app");
    });

    it("WhatsApp message after voice call includes voice context in prompt", () => {
      chatManager.setVoiceContext(
        'Task: "deploy the app"\nResult: "Deployed to Vercel"\nWorking dir: /tmp/deploy'
      );

      chatManager.handleMessage("how did the deployment go?");

      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain("Voice Call Context");
      expect(prompt).toContain("deploy the app");
      expect(prompt).toContain("Deployed to Vercel");
    });
  });

  // ============================
  // Voice call resets WhatsApp session
  // ============================

  describe("Voice call resets WhatsApp session", () => {
    it("voice call resets session (new ID, cleared history)", () => {
      const oldSessionId = chatManager.getSessionId();

      // Add some history
      chatManager.handleMessage("hello");
      chatManager.recordAssistantMessage("hi there");
      expect(chatManager.getHistory().length).toBe(2);

      // Voice call reset
      chatManager.resetForVoiceCall();

      const newSessionId = chatManager.getSessionId();
      expect(newSessionId).not.toBe(oldSessionId);
      expect(chatManager.getHistory().length).toBe(0);
    });

    it("multiple voice calls → each resets independently", () => {
      const sessionIds: string[] = [];
      sessionIds.push(chatManager.getSessionId());

      chatManager.handleMessage("msg1");
      chatManager.resetForVoiceCall();
      sessionIds.push(chatManager.getSessionId());

      chatManager.handleMessage("msg2");
      chatManager.resetForVoiceCall();
      sessionIds.push(chatManager.getSessionId());

      // All three session IDs should be different
      expect(new Set(sessionIds).size).toBe(3);
      expect(chatManager.getHistory().length).toBe(0);
    });
  });

  // ============================
  // WhatsApp history persistence
  // ============================

  describe("WhatsApp history persistence", () => {
    it("history persists across many messages (no expiry)", () => {
      // Send 10+ messages with process exits between them
      for (let i = 0; i < 10; i++) {
        chatManager.handleMessage(`msg-${i}`);
        chatManager.recordAssistantMessage(`reply-${i}`);
        // Simulate Claude process exit to allow next message
        if (mockProcs[i]) {
          mockProcs[i].emit("close", 0);
        }
      }

      const history = chatManager.getHistory();
      expect(history.length).toBe(20); // 10 user + 10 assistant
      expect(chatManager.getSessionId()).toBeDefined(); // Same session throughout

      // Verify ordering
      expect(history[0].content).toBe("msg-0");
      expect(history[1].content).toBe("reply-0");
      expect(history[18].content).toBe("msg-9");
      expect(history[19].content).toBe("reply-9");
    });

    it("history trims at max limit", () => {
      // Create manager with limit of 5
      const smallManager = new WhatsAppChatManager(executor, "https://example.com", "/tmp", 5);

      // Send many messages
      for (let i = 0; i < 10; i++) {
        smallManager.handleMessage(`msg-${i}`);
        // Let Claude process exit
        const procIdx = mockProcs.length - 1;
        if (mockProcs[procIdx]) {
          mockProcs[procIdx].emit("close", 0);
        }
      }

      const history = smallManager.getHistory();
      expect(history.length).toBeLessThanOrEqual(5);
      // Oldest messages should be trimmed, newest preserved
      const lastMsg = history[history.length - 1];
      expect(lastMsg.content).toBe("msg-9");
    });
  });

  // ============================
  // Session ID in prompt
  // ============================

  describe("Session ID in prompt", () => {
    it("matches getSessionId()", () => {
      const sessionId = chatManager.getSessionId();
      chatManager.handleMessage("check session");

      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain(`Session: ${sessionId}`);
      expect(prompt).toContain(`claude --resume ${sessionId}`);
    });
  });
});
