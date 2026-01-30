import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { TaskExecutor } from "../../src/task-executor";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

// Create a mock ChildProcess
function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.pid = 12345;
  return proc;
}

describe("TaskExecutor", () => {
  let executor: TaskExecutor;
  let mockSpawn: ReturnType<typeof mock>;
  let originalSpawn: typeof childProcess.spawn;

  beforeEach(() => {
    executor = new TaskExecutor("https://example.com");
    // We'll mock spawn per test as needed
  });

  describe("executeTask", () => {
    it("spawns claude process and tracks execution", async () => {
      const mockProc = createMockProcess();
      const origSpawn = childProcess.spawn;
      // @ts-ignore - mock spawn
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc);

      try {
        await executor.executeTask("conv-1", "build a todo app", "/tmp/work");

        const execution = executor.getExecution("conv-1");
        expect(execution).toBeDefined();
        expect(execution!.status).toBe("running");
        expect(execution!.task).toBe("build a todo app");
        expect(execution!.workingDir).toBe("/tmp/work");

        // Simulate process exit
        mockProc.emit("close", 0);
        expect(execution!.status).toBe("completed");
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("marks execution as failed on non-zero exit", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("conv-2", "fail task", "/tmp/work");
        mockProc.emit("close", 1);
        expect(executor.getExecution("conv-2")!.status).toBe("failed");
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("marks execution as failed on spawn error", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("conv-3", "error task", "/tmp/work");
        mockProc.emit("error", new Error("spawn ENOENT"));
        expect(executor.getExecution("conv-3")!.status).toBe("failed");
      } finally {
        spawnMock.mockRestore();
      }
    });
  });

  describe("getExecution / isRunning", () => {
    it("returns undefined for unknown conversation", () => {
      expect(executor.getExecution("nope")).toBeUndefined();
      expect(executor.isRunning("nope")).toBe(false);
    });
  });

  describe("killTask", () => {
    it("kills running task", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("conv-k", "kill me", "/tmp");
        const killed = executor.killTask("conv-k");
        expect(killed).toBe(true);
        expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
        expect(executor.getExecution("conv-k")!.status).toBe("failed");
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("returns false for non-running task", () => {
      expect(executor.killTask("nope")).toBe(false);
    });
  });

  describe("context management", () => {
    it("getTaskContext returns undefined when no execution", () => {
      expect(executor.getTaskContext("nope")).toBeUndefined();
    });

    it("recordCompletion + getTaskContext returns context", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("conv-ctx", "original task", "/tmp/project");
        executor.recordCompletion("conv-ctx", "Created a todo app");

        const ctx = executor.getTaskContext("conv-ctx");
        expect(ctx).toBeDefined();
        expect(ctx!.originalTask).toBe("original task");
        expect(ctx!.completionSummary).toBe("Created a todo app");
        expect(ctx!.workingDir).toBe("/tmp/project");
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("linkCallback allows looking up context via callback ID", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("orig", "task", "/tmp");
        executor.recordCompletion("orig", "Done");
        executor.linkCallback("callback-id", "orig");

        const ctx = executor.getTaskContext("callback-id");
        expect(ctx).toBeDefined();
        expect(ctx!.completionSummary).toBe("Done");
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("getLatestTaskContext returns most recent", async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      let callCount = 0;
      const spawnMock = spyOn(childProcess, "spawn").mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProc1 : mockProc2;
      });

      try {
        await executor.executeTask("first", "first task", "/tmp/a");
        // Advance time slightly
        await new Promise(r => setTimeout(r, 10));
        await executor.executeTask("second", "second task", "/tmp/b");

        const latest = executor.getLatestTaskContext();
        expect(latest).toBeDefined();
        expect(latest!.originalTask).toBe("second task");
      } finally {
        spawnMock.mockRestore();
      }
    });
  });

  describe("cleanup", () => {
    it("removes old completed executions", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("old", "old task", "/tmp");
        const execution = executor.getExecution("old")!;
        execution.status = "completed";
        // Set startedAt to 2 hours ago
        execution.startedAt = new Date(Date.now() - 7200000);

        executor.cleanup(3600000);
        expect(executor.getExecution("old")).toBeUndefined();
      } finally {
        spawnMock.mockRestore();
      }
    });

    it("kills zombie processes", async () => {
      const mockProc = createMockProcess();
      const spawnMock = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);

      try {
        await executor.executeTask("zombie", "stuck task", "/tmp");
        const execution = executor.getExecution("zombie")!;
        // Set startedAt to 2 hours ago (running too long)
        execution.startedAt = new Date(Date.now() - 7200000);

        executor.cleanup(3600000, 1800000);
        expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
      } finally {
        spawnMock.mockRestore();
      }
    });
  });

  describe("killAllRunning", () => {
    it("kills all running processes", async () => {
      const mockProc1 = createMockProcess();
      const mockProc2 = createMockProcess();
      let callCount = 0;
      const spawnMock = spyOn(childProcess, "spawn").mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mockProc1 : mockProc2;
      });

      try {
        await executor.executeTask("r1", "task1", "/tmp");
        await executor.executeTask("r2", "task2", "/tmp");

        executor.killAllRunning();
        expect(mockProc1.kill).toHaveBeenCalled();
        expect(mockProc2.kill).toHaveBeenCalled();
        expect(executor.getExecution("r1")!.status).toBe("failed");
        expect(executor.getExecution("r2")!.status).toBe("failed");
      } finally {
        spawnMock.mockRestore();
      }
    });
  });
});
