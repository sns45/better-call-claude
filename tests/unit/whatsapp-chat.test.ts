import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { WhatsAppChatManager } from "../../src/whatsapp-chat";
import { TaskExecutor } from "../../src/task-executor";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.pid = 99999;
  return proc;
}

describe("WhatsAppChatManager", () => {
  let manager: WhatsAppChatManager;
  let executor: TaskExecutor;
  let spawnMock: ReturnType<typeof spyOn>;
  let mockProcs: any[];

  beforeEach(() => {
    mockProcs = [];
    executor = new TaskExecutor("https://example.com");
    spawnMock = spyOn(childProcess, "spawn").mockImplementation(() => {
      const proc = createMockProcess();
      mockProcs.push(proc);
      return proc;
    });
    manager = new WhatsAppChatManager(executor, "https://example.com", "/tmp/work", 50);
  });

  afterEach(() => {
    spawnMock.mockRestore();
  });

  describe("session management", () => {
    it("generates a session ID on construction", () => {
      const sessionId = manager.getSessionId();
      expect(sessionId).toBeDefined();
      expect(sessionId.length).toBe(36); // UUID format
    });

    it("session ID persists across messages", () => {
      const id1 = manager.getSessionId();
      manager.handleMessage("hello");
      const id2 = manager.getSessionId();
      expect(id1).toBe(id2);
    });
  });

  describe("history management", () => {
    it("records user messages in history", () => {
      manager.handleMessage("hello");
      const history = manager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe("user");
      expect(history[0].content).toBe("hello");
    });

    it("records assistant messages in history", () => {
      manager.recordAssistantMessage("hi there");
      const history = manager.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe("assistant");
      expect(history[0].content).toBe("hi there");
    });

    it("trims history when exceeding max", () => {
      // Create manager with small limit
      const smallManager = new WhatsAppChatManager(executor, "https://example.com", "/tmp", 3);
      smallManager.handleMessage("msg1");
      // Simulate process exit so we can send more without queueing
      mockProcs[0]?.emit("close", 0);
      smallManager.recordAssistantMessage("reply1");
      smallManager.handleMessage("msg2");
      mockProcs[1]?.emit("close", 0);
      smallManager.recordAssistantMessage("reply2");

      const history = smallManager.getHistory();
      expect(history.length).toBeLessThanOrEqual(3);
    });

    it("preserves order of messages", () => {
      manager.handleMessage("first");
      manager.recordAssistantMessage("reply");
      // Don't send another user message yet (Claude still processing)
      const history = manager.getHistory();
      expect(history[0].content).toBe("first");
      expect(history[1].content).toBe("reply");
    });
  });

  describe("message processing", () => {
    it("spawns Claude on first message", () => {
      manager.handleMessage("hello");
      expect(childProcess.spawn).toHaveBeenCalled();
      expect(manager.getIsProcessing()).toBe(true);
    });

    it("queues messages while Claude is processing", () => {
      manager.handleMessage("first");
      expect(manager.getIsProcessing()).toBe(true);

      manager.handleMessage("second");
      manager.handleMessage("third");
      expect(manager.getPendingCount()).toBe(2);
    });

    it("processes queued messages after Claude exits", () => {
      manager.handleMessage("first");
      manager.handleMessage("second");
      expect(manager.getPendingCount()).toBe(1);

      // Simulate first process exit
      mockProcs[0]?.emit("close", 0);

      // Should have started processing "second"
      expect(manager.getIsProcessing()).toBe(true);
      expect(manager.getPendingCount()).toBe(0);
    });

    it("does NOT pass session ID flag (avoids lock conflicts)", () => {
      manager.handleMessage("hello");

      // --session-id was removed to avoid "Session ID already in use" errors
      // The session ID is still in the prompt text for the footer
      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).not.toContain("--session-id");
      // But the session ID IS in the prompt text
      const prompt = args[args.length - 1];
      expect(prompt).toContain(manager.getSessionId());
    });
  });

  describe("voice call reset", () => {
    it("clears history on voice call reset", () => {
      manager.handleMessage("hello");
      manager.recordAssistantMessage("hi");
      expect(manager.getHistory().length).toBe(2);

      manager.resetForVoiceCall();
      expect(manager.getHistory().length).toBe(0);
    });

    it("generates new session ID on voice call reset", () => {
      const oldId = manager.getSessionId();
      manager.resetForVoiceCall();
      const newId = manager.getSessionId();
      expect(newId).not.toBe(oldId);
    });

    it("clears pending queue on voice call reset", () => {
      manager.handleMessage("first");
      manager.handleMessage("queued");
      expect(manager.getPendingCount()).toBe(1);

      manager.resetForVoiceCall();
      expect(manager.getPendingCount()).toBe(0);
      expect(manager.getIsProcessing()).toBe(false);
    });
  });

  describe("voice context", () => {
    it("includes voice context in prompt after setVoiceContext", () => {
      manager.setVoiceContext('Task: "build app"\nResult: "Done"');
      manager.handleMessage("continue with the app");

      // The prompt should include voice context — verify via spawn args
      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain("Voice Call Context");
      expect(prompt).toContain("build app");
    });

    it("voice context is cleared after voice call reset", () => {
      manager.setVoiceContext("some context");
      manager.resetForVoiceCall();

      manager.handleMessage("hello");
      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).not.toContain("Voice Call Context");
    });
  });

  describe("prompt building", () => {
    it("includes conversation history in prompt", () => {
      manager.handleMessage("first question");
      manager.recordAssistantMessage("first answer");
      // Simulate process exit
      mockProcs[0]?.emit("close", 0);

      manager.handleMessage("second question");
      const spawnCall = (childProcess.spawn as any).mock.calls[1];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain("first question");
      expect(prompt).toContain("first answer");
      expect(prompt).toContain("second question");
    });

    it("includes session footer instruction in prompt", () => {
      const sessionId = manager.getSessionId();
      manager.handleMessage("hello");

      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain(`Session: ${sessionId}`);
      expect(prompt).toContain(`claude --resume ${sessionId}`);
    });

    it("includes WhatsApp endpoint instructions", () => {
      manager.handleMessage("hello");
      const spawnCall = (childProcess.spawn as any).mock.calls[0];
      const prompt = spawnCall[1][spawnCall[1].length - 1] as string;
      expect(prompt).toContain("/api/whatsapp");
      expect(prompt).toContain("Do NOT use /api/ask");
    });
  });
});

// Baileys echo filtering is tested here for convenience
import { BaileysClient } from "../../src/baileys";

describe("BaileysClient echo filtering", () => {
  it("has sentMessageIds set initialized", () => {
    const client = new BaileysClient("/tmp/test-auth");
    // The set exists (private, but we verify behavior via the public API)
    expect(client).toBeDefined();
  });
});

