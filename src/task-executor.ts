/**
 * Task Executor
 * Spawns Claude Code sessions to handle phone call tasks
 */

import { spawn, type ChildProcess } from "child_process";

export interface TaskExecution {
  conversationId: string;
  task: string;
  process: ChildProcess;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  completionSummary?: string;  // What was accomplished
  workingDir: string;          // Where files were created
}

export interface TaskContext {
  originalTask: string;
  completionSummary: string;
  workingDir: string;
}

export class TaskExecutor {
  private executions: Map<string, TaskExecution> = new Map();
  private apiBaseUrl: string;
  // Map callback conversation IDs to original conversation IDs for context
  private callbackLinks: Map<string, string> = new Map();

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Link a callback conversation to the original task
   */
  linkCallback(callbackConversationId: string, originalConversationId: string): void {
    this.callbackLinks.set(callbackConversationId, originalConversationId);
    console.log(`[TaskExecutor] Linked callback ${callbackConversationId.slice(0, 8)} to original ${originalConversationId.slice(0, 8)}`);
  }

  /**
   * Get context from a previous task (for follow-up conversations)
   */
  getTaskContext(conversationId: string): TaskContext | undefined {
    // Check if this is a callback conversation
    const originalId = this.callbackLinks.get(conversationId) || conversationId;
    const execution = this.executions.get(originalId);

    if (execution && execution.completionSummary) {
      return {
        originalTask: execution.task,
        completionSummary: execution.completionSummary,
        workingDir: execution.workingDir,
      };
    }
    return undefined;
  }

  /**
   * Record task completion summary
   */
  recordCompletion(conversationId: string, summary: string): void {
    const execution = this.executions.get(conversationId);
    if (execution) {
      execution.completionSummary = summary;
      console.log(`[TaskExecutor] Recorded completion for ${conversationId.slice(0, 8)}: ${summary.slice(0, 50)}...`);
    }
  }

  /**
   * Execute a task by spawning a Claude Code session
   * @param context Optional context from a previous task (for follow-ups on callbacks)
   */
  async executeTask(
    conversationId: string,
    initialTask: string,
    workingDir: string,
    context?: TaskContext
  ): Promise<void> {
    // Build context section if we have prior task info
    let contextSection = "";
    if (context) {
      contextSection = `
## IMPORTANT: Previous Task Context

This is a FOLLOW-UP call. Before this call, you completed a task:

**Original Request**: "${context.originalTask}"
**What You Created**: "${context.completionSummary}"
**Working Directory**: ${context.workingDir}

The user is asking a follow-up question about what you just created.
You should continue working in the same directory and build on what was already created.
`;
    }

    const prompt = `
You received a phone call from a user. Their request was:
"${initialTask}"
${contextSection}
## Phone Communication API

You can communicate with the user via these HTTP endpoints. Use curl to call them.

### Ask a question (blocking - waits for user's spoken response):
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/ask/${conversationId} \\
  -H "Content-Type: application/json" \\
  -d '{"message": "What tech stack would you like?"}'
\`\`\`
Returns JSON: {"response": "user's spoken answer"}

### Say something (non-blocking - just speaks to user):
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/say/${conversationId} \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Working on it, this might take a minute..."}'
\`\`\`

### Report completion (REQUIRED when done):
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/complete/${conversationId} \\
  -H "Content-Type: application/json" \\
  -d '{"summary": "Created todo app in ./todo-app with React frontend and Hono backend"}'
\`\`\`
This will speak to user if still on call, or call them back if they hung up.

### Check if user is still on call:
\`\`\`bash
curl -s ${this.apiBaseUrl}/api/status/${conversationId}
\`\`\`

### Send SMS to user:
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/sms \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Here is the URL: https://example.com"}'
\`\`\`

### Send WhatsApp to user:
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/whatsapp \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Here is the URL: https://example.com"}'
\`\`\`

## Important Instructions

1. **Clarify first**: If the request is unclear, use /api/ask to get clarification
2. **Keep it short**: Phone conversation - questions should be 1-2 sentences max
3. **Give updates**: Use /api/say for progress updates on longer tasks
4. **Work locally**: Create files and directories in ${workingDir}
5. **Always complete**: When done, ALWAYS call /api/complete with a summary
6. **Auto-callback**: If user hangs up, /api/complete will call them back automatically

## Example Flow

1. User says "create a todo app"
2. You ask: curl .../api/ask/... -d '{"message": "What tech stack? React, Vue, or vanilla JS?"}'
3. User responds: "React"
4. You say: curl .../api/say/... -d '{"message": "Got it, setting up React project..."}'
5. You create the files
6. You complete: curl .../api/complete/... -d '{"summary": "Created React todo app in ./todo-app"}'

Start now. ${context ? "This is a follow-up request - use your context from the previous task." : "Clarify if needed, then execute the task."}
`.trim();

    console.log(`[TaskExecutor] Starting task for ${conversationId}: ${initialTask.slice(0, 50)}...`);

    // Note: prompt is a positional argument, not a flag
    // Usage: claude [options] [prompt]
    const claude = spawn("claude", [
      "--print",
      "--dangerously-skip-permissions",
      prompt  // Prompt as positional argument
    ], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const execution: TaskExecution = {
      conversationId,
      task: initialTask,
      process: claude,
      status: "running",
      startedAt: new Date(),
      workingDir,
    };
    this.executions.set(conversationId, execution);

    claude.stdout?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Claude:${conversationId.slice(0, 8)}] ${output}`);
      }
    });

    claude.stderr?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Claude:${conversationId.slice(0, 8)}:err] ${output}`);
      }
    });

    claude.on("close", (code) => {
      execution.status = code === 0 ? "completed" : "failed";
      console.log(`[TaskExecutor] Claude session ${conversationId.slice(0, 8)} exited with code ${code}`);
    });

    claude.on("error", (err) => {
      execution.status = "failed";
      console.error(`[TaskExecutor] Failed to spawn Claude: ${err.message}`);
    });
  }

  /**
   * Get execution status for a conversation
   */
  getExecution(conversationId: string): TaskExecution | undefined {
    return this.executions.get(conversationId);
  }

  /**
   * Check if a task is running for a conversation
   */
  isRunning(conversationId: string): boolean {
    const execution = this.executions.get(conversationId);
    return execution?.status === "running";
  }

  /**
   * Kill a running task
   */
  killTask(conversationId: string): boolean {
    const execution = this.executions.get(conversationId);
    if (execution && execution.status === "running") {
      execution.process.kill("SIGTERM");
      execution.status = "failed";
      return true;
    }
    return false;
  }

  /**
   * Clean up old executions
   */
  cleanup(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.executions.forEach((execution, id) => {
      if (execution.status !== "running" &&
          now - execution.startedAt.getTime() > maxAgeMs) {
        toDelete.push(id);
      }
    });

    toDelete.forEach(id => this.executions.delete(id));
  }
}
