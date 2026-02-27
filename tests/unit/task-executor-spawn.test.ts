import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { TaskExecutor } from "../../src/task-executor";
import * as childProcess from "child_process";
import { EventEmitter } from "events";

/**
 * Unit tests for TaskExecutor.spawnClaude method
 */

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = mock(() => {});
  proc.pid = 12345;
  return proc;
}

describe("TaskExecutor.spawnClaude", () => {
  let executor: TaskExecutor;
  let spawnSpy: ReturnType<typeof spyOn>;
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    executor = new TaskExecutor("https://example.com");
    mockProc = createMockProcess();
    spawnSpy = spyOn(childProcess, "spawn").mockReturnValue(mockProc as any);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it("without sessionId — no --session-id flag", () => {
    executor.spawnClaude("conv-1", "do something", "/tmp/work");

    const spawnCall = (childProcess.spawn as any).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).not.toContain("--session-id");
    expect(args).toContain("--print");
    expect(args).toContain("--dangerously-skip-permissions");
    // Prompt should be the last arg
    expect(args[args.length - 1]).toBe("do something");
  });

  it("with sessionId — --session-id flag present", () => {
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    executor.spawnClaude("conv-2", "do something", "/tmp/work", sessionId);

    const spawnCall = (childProcess.spawn as any).mock.calls[0];
    const args = spawnCall[1] as string[];
    expect(args).toContain("--session-id");
    expect(args).toContain(sessionId);
    // Session ID should come before the prompt
    const sessionIdx = args.indexOf("--session-id");
    const promptIdx = args.length - 1;
    expect(sessionIdx).toBeLessThan(promptIdx);
    expect(args[sessionIdx + 1]).toBe(sessionId);
  });

  it("calls onClose callback on exit", () => {
    const onClose = mock(() => {});
    executor.spawnClaude("conv-3", "prompt", "/tmp", undefined, onClose);

    // Simulate process exit
    mockProc.emit("close", 0);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("returns TaskExecution with 'running' status", () => {
    const execution = executor.spawnClaude("conv-4", "prompt", "/tmp/work");

    expect(execution).toBeDefined();
    expect(execution.status).toBe("running");
    expect(execution.conversationId).toBe("conv-4");
    expect(execution.workingDir).toBe("/tmp/work");
  });

  it("tracks execution in map", () => {
    executor.spawnClaude("conv-5", "prompt", "/tmp");

    const retrieved = executor.getExecution("conv-5");
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe("running");
  });

  it("executeTask still works (calls spawnClaude internally)", async () => {
    await executor.executeTask("conv-6", "build a todo app", "/tmp/work");

    const execution = executor.getExecution("conv-6");
    expect(execution).toBeDefined();
    expect(execution!.status).toBe("running");
    expect(execution!.task).toBe("build a todo app");
    expect(execution!.workingDir).toBe("/tmp/work");

    // Should have spawned a process
    expect(childProcess.spawn).toHaveBeenCalled();
  });
});
