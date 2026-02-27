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
  completedAt?: number;        // Timestamp for cross-channel lookup
  conversationId?: string;     // Original conversation ID
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
    console.error(`[TaskExecutor] Linked callback ${callbackConversationId.slice(0, 8)} to original ${originalConversationId.slice(0, 8)}`);
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
      console.error(`[TaskExecutor] Recorded completion for ${conversationId.slice(0, 8)}: ${summary.slice(0, 50)}...`);
    }
  }

  /**
   * Get the most recent task context (for cross-channel continuity)
   * Used when WhatsApp message should continue work from a voice call
   */
  getLatestTaskContext(): TaskContext | undefined {
    let latestContext: TaskContext | undefined;
    let latestTime = 0;

    for (const [conversationId, execution] of this.executions) {
      // Find most recently completed or running task
      const executionTime = execution.startedAt.getTime();
      if (executionTime > latestTime) {
        latestTime = executionTime;
        latestContext = {
          originalTask: execution.task,
          completionSummary: execution.completionSummary || "Task in progress",
          workingDir: execution.workingDir,
          completedAt: execution.status !== "running" ? executionTime : undefined,
          conversationId: conversationId,
        };
      }
    }

    if (latestContext) {
      console.error(`[TaskExecutor] Latest context: ${latestContext.originalTask.slice(0, 50)}... (${latestContext.conversationId?.slice(0, 8)})`);
    }

    return latestContext;
  }

  /**
   * Execute a task by spawning a Claude Code session
   * @param context Optional context from a previous task (for follow-ups on callbacks)
   * @param channel Communication channel - affects how Claude responds
   */
  async executeTask(
    conversationId: string,
    initialTask: string,
    workingDir: string,
    context?: TaskContext,
    channel: "voice" | "whatsapp" | "sms" = "voice"
  ): Promise<void> {
    // Build context section if we have prior task info
    let contextSection = "";
    if (context) {
      contextSection = `
## IMPORTANT: Previous Task Context

This is a FOLLOW-UP from a previous task${context.conversationId ? ` (conversation ${context.conversationId.slice(0, 8)})` : ""}:

**Original Request**: "${context.originalTask}"
**What Was Done**: "${context.completionSummary}"
**Working Directory**: ${context.workingDir}

The user is asking a follow-up question about what was just created.
You should continue working in the same directory and build on what was already created.
`;
    }

    // Channel-specific instructions
    const channelInstructions = channel === "whatsapp"
      ? `
## Communication Channel: WhatsApp

You received this task via WhatsApp (a text messaging app).
Use the WhatsApp endpoint to respond - do NOT use voice endpoints.

### Send WhatsApp message to user:
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/whatsapp \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Your message here"}'
\`\`\`

DO NOT use /api/ask or /api/say (those are for voice calls).
When done, send a WhatsApp message with the result instead of calling /api/complete.
`
      : channel === "sms"
      ? `
## Communication Channel: SMS

You received this task via SMS text message.
Use the SMS endpoint to respond - do NOT use voice endpoints.

### Send SMS to user:
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/sms \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Your message here"}'
\`\`\`

DO NOT use /api/ask or /api/say (those are for voice calls).
When done, send an SMS with the result instead of calling /api/complete.
`
      : `
## Communication Channel: Voice

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
`;

    const messagingEndpoints = `
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

### Wait for WhatsApp message (blocking - keeps session alive):
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/whatsapp-wait \\
  -H "Content-Type: application/json" \\
  -d '{"timeout_ms": 300000}'
\`\`\`
Returns: {"message": "user's WhatsApp message", "received": true}
Or on timeout: {"message": null, "received": false, "reason": "timeout"}

Use this in a loop to continuously listen for WhatsApp messages:
\`\`\`bash
while true; do
  response=$(curl -s -X POST ${this.apiBaseUrl}/api/whatsapp-wait -H "Content-Type: application/json" -d '{"timeout_ms": 300000}')
  received=$(echo "$response" | jq -r '.received')
  if [ "$received" = "true" ]; then
    message=$(echo "$response" | jq -r '.message')
    # Process the message and respond
    # ... do work based on message ...
    curl -s -X POST ${this.apiBaseUrl}/api/whatsapp -H "Content-Type: application/json" -d "{\"message\": \"Done!\"}"
  fi
done
\`\`\`
`;

    const prompt = `
You received a ${channel === "voice" ? "phone call" : channel.toUpperCase() + " message"} from a user. Their request was:
"${initialTask}"
${contextSection}
${channelInstructions}
${channel === "voice" ? messagingEndpoints : ""}
## Important Instructions

1. ${channel === "voice" ? "**Clarify first**: If the request is unclear, use /api/ask to get clarification" : "**Work autonomously**: Execute the task directly"}
2. **Keep it short**: ${channel === "voice" ? "Phone conversation - questions should be 1-2 sentences max" : "Messages should be concise"}
3. **Give updates**: ${channel === "voice" ? "Use /api/say for progress updates on longer tasks" : "Send progress updates via " + channel}
4. **Work locally**: Create files and directories in ${workingDir}
5. ${channel === "voice" ? "**Always complete**: When done, ALWAYS call /api/complete with a summary" : "**Respond when done**: Send final result via " + channel}
6. ${channel === "voice" ? "**Auto-callback**: If user hangs up, /api/complete will call them back automatically" : "**Cross-channel**: You can still use /api/sms or /api/whatsapp to send messages"}
${channel === "voice" ? `7. **WhatsApp listening**: If user says "continue on WhatsApp" or similar, use /api/whatsapp-wait in a loop to listen for their WhatsApp messages instead of completing` : ""}

## Example Flow

${channel === "voice" ? `### Normal flow:
1. User says "create a todo app"
2. You ask: curl .../api/ask/... -d '{"message": "What tech stack? React, Vue, or vanilla JS?"}'
3. User responds: "React"
4. You say: curl .../api/say/... -d '{"message": "Got it, setting up React project..."}'
5. You create the files
6. You complete: curl .../api/complete/... -d '{"summary": "Created React todo app in ./todo-app"}'

### WhatsApp continuation flow:
1. User says "start the todo app and continue on WhatsApp"
2. You start the app (npm run dev &)
3. You say: curl .../api/say/... -d '{"message": "App running. Send me WhatsApp messages for more instructions."}'
4. You loop: while true; do response=$(curl .../api/whatsapp-wait ...); if received, process and respond via /api/whatsapp; done
5. User sends WhatsApp: "expose via localtunnel"
6. You run localtunnel, respond via WhatsApp with URL` : `1. User sends "expose the dev server via localtunnel"
2. You run: npx localtunnel --port 5173
3. You respond via ${channel}: curl .../api/${channel} -d '{"message": "Done! URL: https://xxx.loca.lt"}'`}

Start now. ${context ? "This is a follow-up request - use your context from the previous task." : "Execute the task."}
`.trim();

    console.error(`[TaskExecutor] Starting task for ${conversationId}: ${initialTask.slice(0, 50)}...`);

    const execution = this.spawnClaude(conversationId, prompt, workingDir);
    execution.task = initialTask;
  }

  /**
   * Spawn a Claude Code process with the given prompt.
   * Reusable by both executeTask() and WhatsAppChatManager.
   * @param sessionId Optional stable session ID passed as --session-id to claude CLI
   * @param onClose Optional callback invoked when the process exits
   */
  spawnClaude(
    conversationId: string,
    prompt: string,
    workingDir: string,
    sessionId?: string,
    onClose?: (code: number | null) => void,
  ): TaskExecution {
    // Prevent spawned Claude from loading user's MCP servers (which would
    // spawn recursive better-call-claude instances, steal Baileys connections,
    // cause port conflicts, and add 90+ seconds of startup delay).
    // Use --strict-mcp-config with empty config AND isolated HOME.
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--mcp-config", '{"mcpServers":{}}',
      "--strict-mcp-config",
    ];
    if (sessionId) {
      args.push("--session-id", sessionId);
    }
    args.push(prompt); // Prompt as positional argument

    const spawnEnv = { ...process.env };
    delete spawnEnv.CLAUDECODE;
    delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

    const claude = spawn("claude", args, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
    });

    const execution: TaskExecution = {
      conversationId,
      task: "",
      process: claude,
      status: "running",
      startedAt: new Date(),
      workingDir,
    };
    this.executions.set(conversationId, execution);

    // Capture output to temp files for debugging spawn issues (skip in tests)
    const isTest = typeof process !== "undefined" && !!process.env.BUN_TEST;
    const logFile = isTest ? null : `/tmp/bcc-spawn-${conversationId.slice(0, 12)}.log`;
    if (logFile) {
      const fs = require("fs");
      try { fs.writeFileSync(logFile, `[${new Date().toISOString()}] Spawned: claude ${args.slice(0, 3).join(" ")} ...\n`); } catch {}
    }

    claude.stdout?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Claude:${conversationId.slice(0, 8)}] ${output}`);
        if (logFile) { try { require("fs").appendFileSync(logFile, `[stdout] ${output}\n`); } catch {} }
      }
    });

    claude.stderr?.on("data", (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Claude:${conversationId.slice(0, 8)}:err] ${output}`);
        if (logFile) { try { require("fs").appendFileSync(logFile, `[stderr] ${output}\n`); } catch {} }
      }
    });

    claude.on("close", (code) => {
      execution.status = code === 0 ? "completed" : "failed";
      console.error(`[TaskExecutor] Claude session ${conversationId.slice(0, 8)} exited with code ${code}`);
      if (logFile) { try { require("fs").appendFileSync(logFile, `[close] exit code ${code}\n`); } catch {} }
      onClose?.(code);
    });

    claude.on("error", (err) => {
      execution.status = "failed";
      console.error(`[TaskExecutor] Failed to spawn Claude: ${err.message}`);
    });

    return execution;
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
   * Clean up old executions and zombie processes
   * @param maxAgeMs Maximum age for completed/failed executions (default: 1 hour)
   * @param maxRunningMs Maximum runtime for "running" processes before being killed (default: 30 minutes)
   */
  cleanup(maxAgeMs: number = 3600000, maxRunningMs: number = 1800000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.executions.forEach((execution, id) => {
      const age = now - execution.startedAt.getTime();
      
      // Clean up old completed/failed executions
      if (execution.status !== "running" && age > maxAgeMs) {
        toDelete.push(id);
      } 
      // Kill zombie processes stuck in "running" state too long
      else if (execution.status === "running" && age > maxRunningMs) {
        console.error(`[TaskExecutor] Killing zombie process ${id.slice(0, 8)} after ${maxRunningMs}ms`);
        execution.process.kill("SIGTERM");
        execution.status = "failed";
        toDelete.push(id);
      }
    });

    toDelete.forEach(id => this.executions.delete(id));
  }

  /**
   * Kill all running processes
   * Used during graceful shutdown to prevent orphaned processes
   */
  killAllRunning(): void {
    for (const [id, execution] of this.executions) {
      if (execution.status === "running") {
        console.error(`[TaskExecutor] Killing running process ${id.slice(0, 8)}`);
        execution.process.kill("SIGTERM");
        execution.status = "failed";
      }
    }
  }
}
