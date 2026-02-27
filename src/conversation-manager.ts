/**
 * Conversation Manager
 * Tracks active conversations across all channels: Voice, SMS, WhatsApp
 */

export enum ChannelType {
  VOICE = "voice",
  SMS = "sms",
  WHATSAPP = "whatsapp",
}

export enum ConversationState {
  RINGING = "ringing",        // Voice only: call is ringing
  ACTIVE = "active",          // Conversation is active
  PENDING_RESPONSE = "pending_response",  // Waiting for Claude to respond
  ENDED = "ended",
}

export enum ConversationDirection {
  INBOUND = "inbound",
  OUTBOUND = "outbound",
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface Conversation {
  id: string;
  providerConversationId: string;
  channel: ChannelType;
  direction: ConversationDirection;
  state: ConversationState;
  messages: Message[];
  startedAt: Date;
  endedAt?: Date;
  metadata?: {
    from?: string;
    to?: string;
  };
}

export class ConversationManager {
  private conversations: Map<string, Conversation> = new Map();
  private inboundWaiters: Array<{
    resolve: (conversation: Conversation | null) => void;
    timeout: Timer;
    channel?: ChannelType;
  }> = [];
  private responseWaiters: Map<
    string,
    { resolve: (response: string | null) => void; timeout: Timer }
  > = new Map();

  /**
   * Create a new conversation record
   */
  createConversation(
    id: string,
    channel: ChannelType,
    direction: ConversationDirection,
    providerConversationId: string,
    metadata?: { from?: string; to?: string }
  ): Conversation {
    const conversation: Conversation = {
      id,
      providerConversationId,
      channel,
      direction,
      state: channel === ChannelType.VOICE ? ConversationState.RINGING : ConversationState.ACTIVE,
      messages: [],
      startedAt: new Date(),
      metadata,
    };

    this.conversations.set(id, conversation);
    console.error(
      `[Conversation] Created ${channel} ${direction} conversation ${id} (provider: ${providerConversationId})`
    );

    return conversation;
  }

  /**
   * Get a conversation by ID
   */
  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /**
   * Get a conversation by provider conversation ID
   */
  getConversationByProviderId(providerConversationId: string): Conversation | undefined {
    for (const conversation of this.conversations.values()) {
      if (conversation.providerConversationId === providerConversationId) {
        return conversation;
      }
    }
    return undefined;
  }

  /**
   * Find or create a conversation for an inbound message
   * For messaging, we track by the sender's phone number to maintain thread continuity
   */
  findOrCreateConversation(
    channel: ChannelType,
    providerMessageId: string,
    from: string,
    to: string
  ): Conversation {
    // For messaging, look for an existing active conversation from the same number
    if (channel === ChannelType.SMS || channel === ChannelType.WHATSAPP) {
      for (const conversation of this.conversations.values()) {
        if (
          conversation.channel === channel &&
          conversation.state !== ConversationState.ENDED &&
          conversation.metadata?.from === from
        ) {
          return conversation;
        }
      }
    }

    // Create a new conversation
    const id = crypto.randomUUID();
    return this.createConversation(id, channel, ConversationDirection.INBOUND, providerMessageId, {
      from,
      to,
    });
  }

  /**
   * Update conversation state
   */
  updateState(id: string, state: ConversationState): void {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      console.warn(`[Conversation] Conversation ${id} not found for state update`);
      return;
    }

    conversation.state = state;
    if (state === ConversationState.ENDED) {
      conversation.endedAt = new Date();
    }

    console.error(`[Conversation] ${id} state updated to ${state}`);
  }

  /**
   * Add a message to the conversation
   */
  addMessage(id: string, role: "user" | "assistant", content: string): void {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      console.warn(`[Conversation] Conversation ${id} not found for message`);
      return;
    }

    conversation.messages.push({
      role,
      content,
      timestamp: new Date(),
    });

    console.error(
      `[Conversation] ${id} [${conversation.channel}] message added: [${role}] ${content.slice(0, 50)}...`
    );

    // If this is a user message and we have a waiter, resolve it
    if (role === "user") {
      const waiter = this.responseWaiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.responseWaiters.delete(id);
        waiter.resolve(content);
      }

      // Also check for inbound conversation waiters
      if (conversation.direction === ConversationDirection.INBOUND) {
        conversation.state = ConversationState.PENDING_RESPONSE;
        this.notifyInboundWaiters(conversation);
      }
    }
  }

  /**
   * Get a pending inbound conversation (has message but no response yet)
   * Optionally filter by channel
   */
  getPendingInbound(channel?: ChannelType): Conversation | null {
    for (const conversation of this.conversations.values()) {
      if (
        conversation.direction === ConversationDirection.INBOUND &&
        conversation.state === ConversationState.PENDING_RESPONSE &&
        conversation.messages.length > 0 &&
        (channel === undefined || conversation.channel === channel)
      ) {
        return conversation;
      }
    }
    return null;
  }

  /**
   * Wait for an inbound conversation with a message
   * Optionally filter by channel
   */
  waitForInbound(timeoutMs: number, channel?: ChannelType): Promise<Conversation | null> {
    // First check if there's already a pending conversation
    const pending = this.getPendingInbound(channel);
    if (pending) {
      return Promise.resolve(pending);
    }

    // Otherwise, wait for one
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = this.inboundWaiters.findIndex((w) => w.resolve === resolve);
        if (index !== -1) {
          this.inboundWaiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);

      this.inboundWaiters.push({ resolve, timeout, channel });
    });
  }

  /**
   * Notify inbound waiters that a conversation is ready
   */
  private notifyInboundWaiters(conversation: Conversation): void {
    // Find a waiter that matches the channel (or any channel)
    const waiterIndex = this.inboundWaiters.findIndex(
      (w) => w.channel === undefined || w.channel === conversation.channel
    );

    if (waiterIndex !== -1) {
      const waiter = this.inboundWaiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timeout);
      waiter.resolve(conversation);
    }
  }

  /**
   * Wait for a user response in an active conversation
   */
  waitForResponse(conversationId: string, timeoutMs: number): Promise<string | null> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      return Promise.resolve(null);
    }

    // Check if there's already a user response we haven't processed
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (lastMessage?.role === "user") {
      return Promise.resolve(lastMessage.content);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.responseWaiters.delete(conversationId);
        resolve(null);
      }, timeoutMs);

      this.responseWaiters.set(conversationId, { resolve, timeout });
    });
  }

  /**
   * Get all active conversations, optionally filtered by channel
   */
  getActiveConversations(channel?: ChannelType): Conversation[] {
    return Array.from(this.conversations.values()).filter(
      (conv) =>
        conv.state !== ConversationState.ENDED &&
        (channel === undefined || conv.channel === channel)
    );
  }

  /**
   * Clean up old ended conversations (call periodically to prevent memory leaks)
   */
  cleanupOld(maxAgeMs: number = 3600000): void {
    const now = Date.now();
    for (const [id, conversation] of this.conversations.entries()) {
      if (
        conversation.state === ConversationState.ENDED &&
        conversation.endedAt &&
        now - conversation.endedAt.getTime() > maxAgeMs
      ) {
        this.conversations.delete(id);
        console.error(`[Conversation] Cleaned up old conversation ${id}`);
      }
    }
  }

  // ============================================
  // Legacy aliases for backward compatibility
  // ============================================

  /** @deprecated Use createConversation */
  createCall(id: string, direction: ConversationDirection, providerCallId: string): Conversation {
    return this.createConversation(id, ChannelType.VOICE, direction, providerCallId);
  }

  /** @deprecated Use getConversation */
  getCall(id: string): Conversation | undefined {
    return this.getConversation(id);
  }

  /** @deprecated Use getConversationByProviderId */
  getCallByProviderId(providerCallId: string): Conversation | undefined {
    return this.getConversationByProviderId(providerCallId);
  }

  /** @deprecated Use addMessage */
  addTranscript(id: string, role: "user" | "assistant", content: string): void {
    return this.addMessage(id, role, content);
  }

  /** @deprecated Use getPendingInbound(ChannelType.VOICE) */
  getPendingInboundCall(): Conversation | null {
    return this.getPendingInbound(ChannelType.VOICE);
  }

  /** @deprecated Use waitForInbound(timeoutMs, ChannelType.VOICE) */
  waitForInboundCall(timeoutMs: number): Promise<Conversation | null> {
    return this.waitForInbound(timeoutMs, ChannelType.VOICE);
  }

  /** @deprecated Use waitForResponse */
  waitForUserResponse(callId: string, timeoutMs: number): Promise<string | null> {
    return this.waitForResponse(callId, timeoutMs);
  }

  /** @deprecated Use getActiveConversations(ChannelType.VOICE) */
  getActiveCalls(): Conversation[] {
    return this.getActiveConversations(ChannelType.VOICE);
  }

  /** @deprecated Use cleanupOld */
  cleanupOldCalls(maxAgeMs?: number): void {
    return this.cleanupOld(maxAgeMs);
  }
}

// Re-export with legacy names for backward compatibility
export {
  ConversationState as CallState,
  ConversationDirection as CallDirection,
  type Conversation as Call,
  type Message as Transcript,
};

// Legacy class alias
export { ConversationManager as CallStateManager };
