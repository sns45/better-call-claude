/**
 * WhatsApp Chat Manager
 * Manages always-on WhatsApp chat with persistent history and session tracking.
 * Each message spawns a fresh Claude process with the full conversation history.
 * Context persists forever — only a phone call resets it.
 */

import type { TaskExecutor } from "./task-executor.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export class WhatsAppChatManager {
  private history: ChatMessage[] = [];
  private sessionId: string;
  private isProcessing = false;
  private pendingMessages: string[] = [];
  private voiceContext: string | null = null;
  private taskExecutor: TaskExecutor;
  private apiBaseUrl: string;
  private workingDir: string;
  private maxHistory: number;

  constructor(
    taskExecutor: TaskExecutor,
    apiBaseUrl: string,
    workingDir: string,
    maxHistory: number = 50,
  ) {
    this.taskExecutor = taskExecutor;
    this.apiBaseUrl = apiBaseUrl;
    this.workingDir = workingDir;
    this.maxHistory = maxHistory;
    this.sessionId = crypto.randomUUID();
    console.error(`[WhatsAppChat] Initialized with session ${this.sessionId.slice(0, 8)}`);
  }

  /**
   * Handle an incoming WhatsApp message from the user.
   * Adds to history. If Claude is already processing, queues the message.
   * Otherwise spawns Claude with full history.
   */
  handleMessage(text: string): void {
    this.history.push({ role: "user", content: text, timestamp: Date.now() });
    this.trimHistory();

    if (this.isProcessing) {
      this.pendingMessages.push(text);
      console.error(`[WhatsAppChat] Queued message (${this.pendingMessages.length} pending): ${text.slice(0, 60)}`);
      return;
    }

    this.processMessage(text);
  }

  /**
   * Record an assistant (bot) message in the chat history.
   * Called by the /api/whatsapp handler after sending a message.
   */
  recordAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", content: text, timestamp: Date.now() });
    this.trimHistory();
  }

  /**
   * Reset state for an incoming voice call.
   * Clears history, generates a new session ID, kills any active process.
   */
  resetForVoiceCall(): void {
    console.error(`[WhatsAppChat] Resetting for voice call (old session: ${this.sessionId.slice(0, 8)})`);
    this.history = [];
    this.pendingMessages = [];
    this.voiceContext = null;
    this.isProcessing = false;
    this.sessionId = crypto.randomUUID();
    console.error(`[WhatsAppChat] New session: ${this.sessionId.slice(0, 8)}`);
  }

  /**
   * Seed voice call context into the next WhatsApp session.
   * Called after a voice call completes/fails.
   */
  setVoiceContext(context: string): void {
    this.voiceContext = context;
    console.error(`[WhatsAppChat] Voice context set: ${context.slice(0, 80)}`);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }

  getPendingCount(): number {
    return this.pendingMessages.length;
  }

  // ---- internal ----

  private processMessage(latestMessage: string): void {
    this.isProcessing = true;
    const prompt = this.buildPrompt(latestMessage);
    // Use a per-spawn conversation ID so TaskExecutor doesn't collide
    const spawnId = `wa-chat-${crypto.randomUUID().slice(0, 8)}`;

    console.error(`[WhatsAppChat] Spawning Claude (session ${this.sessionId.slice(0, 8)}, spawn ${spawnId})`);

    // Don't pass sessionId as --session-id flag: Claude Code locks session files,
    // so concurrent or rapid spawns fail with "Session ID already in use".
    // The session ID is still included in the prompt text for the footer.
    this.taskExecutor.spawnClaude(
      spawnId,
      prompt,
      this.workingDir,
      undefined, // no --session-id flag
      (_code) => {
        this.isProcessing = false;
        // Drain pending queue
        if (this.pendingMessages.length > 0) {
          const next = this.pendingMessages.shift()!;
          console.error(`[WhatsAppChat] Processing queued message: ${next.slice(0, 60)}`);
          this.processMessage(next);
        }
      },
    );
  }

  private buildPrompt(latestMessage: string): string {
    let historyBlock = "";
    // Include all messages except the very last user message (which is latestMessage)
    const priorMessages = this.history.slice(0, -1);
    if (priorMessages.length > 0) {
      historyBlock = priorMessages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
    }

    let voiceBlock = "";
    if (this.voiceContext) {
      voiceBlock = `
## Voice Call Context

The following context was carried over from a recent voice call:
${this.voiceContext}
`;
    }

    return `
You are continuing an always-on WhatsApp conversation with the user.
${voiceBlock}
${historyBlock ? `## Conversation History\n\n${historyBlock}\n` : ""}
## Latest Message

User: ${latestMessage}

## Instructions

Respond to the user's latest message via WhatsApp. Use the endpoint below to send your response.
Keep responses concise — this is a chat conversation, not a report.

### Send WhatsApp message:
\`\`\`bash
curl -s -X POST ${this.apiBaseUrl}/api/whatsapp \\
  -H "Content-Type: application/json" \\
  -d '{"message": "YOUR RESPONSE HERE"}'
\`\`\`

You can send multiple messages if needed (for long responses, break them up).
You can also execute code, create files, etc. — you have full Claude Code capabilities.
Work in directory: ${this.workingDir}

IMPORTANT: Always append a session footer to your LAST message:
\`\`\`
---
Session: ${this.sessionId} | Resume: claude --resume ${this.sessionId}
\`\`\`

Do NOT use /api/ask, /api/say, or /api/complete — those are for voice calls only.
`.trim();
  }

  private trimHistory(): void {
    if (this.history.length > this.maxHistory) {
      const excess = this.history.length - this.maxHistory;
      this.history.splice(0, excess);
    }
  }
}
