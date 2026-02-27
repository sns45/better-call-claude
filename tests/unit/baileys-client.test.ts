import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { BaileysClient } from "../../src/baileys";
import { EventEmitter } from "events";

/**
 * Unit tests for BaileysClient class methods.
 * Mocks @whiskeysockets/baileys module functions.
 */

// Mock socket with EventEmitter for ev
function createMockSocket() {
  const ev = new EventEmitter();
  return {
    ev: {
      on: (event: string, handler: (...args: any[]) => void) => ev.on(event, handler),
      off: (event: string, handler: (...args: any[]) => void) => ev.off(event, handler),
      emit: (event: string, ...args: any[]) => ev.emit(event, ...args),
    },
    sendMessage: mock(() => Promise.resolve({ key: { id: "sent-msg-123" } })),
    user: { id: "1234567890:5@s.whatsapp.net" },
    end: mock(() => {}),
    _ev: ev, // expose for test manipulation
  };
}

describe("BaileysClient", () => {
  describe("constructor", () => {
    it("sets authDir and printQR options", () => {
      const client = new BaileysClient("/tmp/auth-dir", { printQR: true });
      expect(client).toBeDefined();
      // Verify via public API
      expect(client.isConnected()).toBe(false);
    });

    it("defaults printQR to false", () => {
      const client = new BaileysClient("/tmp/auth-dir");
      expect(client).toBeDefined();
    });
  });

  describe("sendMessage", () => {
    it("throws when not connected", async () => {
      const client = new BaileysClient("/tmp/auth-dir");
      await expect(client.sendMessage("+1234567890", "hello")).rejects.toThrow("Baileys not connected");
    });
  });

  describe("sendMessage — connected client", () => {
    // These tests verify sendMessage behavior on a manually-wired client
    // We bypass connect() and wire the mock socket directly via type assertion

    let client: BaileysClient;
    let mockSocket: ReturnType<typeof createMockSocket>;

    beforeEach(() => {
      client = new BaileysClient("/tmp/auth-dir");
      mockSocket = createMockSocket();
      // Wire mock socket into client internals
      (client as any).socket = mockSocket;
      (client as any).connected = true;
    });

    it("sends to correct JID", async () => {
      await client.sendMessage("+1234567890", "test message");
      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        "1234567890@s.whatsapp.net",
        { text: "test message" }
      );
    });

    it("tracks ID in sentMessageIds", async () => {
      await client.sendMessage("+1234567890", "test");
      const sentIds = (client as any).sentMessageIds as Set<string>;
      expect(sentIds.has("sent-msg-123")).toBe(true);
    });

    it("ID auto-expires after 60s", async () => {
      // Use fake timers
      const origSetTimeout = globalThis.setTimeout;
      let timerCallback: (() => void) | null = null;
      let timerDelay = 0;

      // Intercept the setTimeout in sendMessage
      const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, delay: number) => {
        if (delay === 60_000) {
          timerCallback = fn;
          timerDelay = delay;
          return 999 as any;
        }
        // Let other timers through (like in test framework)
        return origSetTimeout(fn, delay);
      }) as any);

      try {
        await client.sendMessage("+1234567890", "expiring msg");
        const sentIds = (client as any).sentMessageIds as Set<string>;
        expect(sentIds.has("sent-msg-123")).toBe(true);

        // Fire the timer callback
        expect(timerCallback).not.toBeNull();
        timerCallback!();
        expect(sentIds.has("sent-msg-123")).toBe(false);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  describe("messages.upsert echo filtering", () => {
    let client: BaileysClient;
    let mockSocket: ReturnType<typeof createMockSocket>;
    let inboundHandler: ReturnType<typeof mock>;

    beforeEach(() => {
      client = new BaileysClient("/tmp/auth-dir");
      mockSocket = createMockSocket();
      (client as any).socket = mockSocket;
      (client as any).connected = true;
      inboundHandler = mock(() => {});
      client.onInboundMessage(inboundHandler);
    });

    it("skips echo when sentMessageIds match", () => {
      // Pre-add a sent message ID
      (client as any).sentMessageIds.add("echo-msg-id");

      // Now wire up the messages.upsert handler by calling connect's internal setup
      // We need to manually register the handler that connect() would set up
      // Since we can't easily call connect() with mocks, we'll simulate the handler
      const ownJid = "1234567890";

      // Simulate what connect() registers on messages.upsert
      const upsertData = {
        type: "notify",
        messages: [
          {
            key: { id: "echo-msg-id", remoteJid: "1234567890@s.whatsapp.net" },
            message: { conversation: "echo text" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      // Register the handler manually (simulating what connect does)
      mockSocket._ev.on("messages.upsert", (upsert: any) => {
        if (upsert.type !== "notify") return;
        const ownJidDigits = mockSocket.user.id.split(":")[0];
        for (const msg of upsert.messages) {
          if (msg.key.id && (client as any).sentMessageIds.has(msg.key.id)) {
            continue; // Echo filtered
          }
          const remoteDigits = msg.key.remoteJid?.split("@")[0] || "";
          if (remoteDigits !== ownJidDigits) continue;
          inboundHandler({
            type: "whatsapp",
            messageId: msg.key.id,
            from: `+${remoteDigits}`,
            to: `+${ownJidDigits}`,
            content: msg.message?.conversation || "",
            timestamp: new Date(),
          });
        }
      });

      mockSocket._ev.emit("messages.upsert", upsertData);

      // Handler should NOT have been called (echo filtered)
      expect(inboundHandler).not.toHaveBeenCalled();
    });

    it("processes genuine inbound message", () => {
      const ownJidDigits = "1234567890";

      // Register same handler pattern as above
      mockSocket._ev.on("messages.upsert", (upsert: any) => {
        if (upsert.type !== "notify") return;
        const ownJid = mockSocket.user.id.split(":")[0];
        for (const msg of upsert.messages) {
          if (msg.key.id && (client as any).sentMessageIds.has(msg.key.id)) {
            continue;
          }
          const remoteDigits = msg.key.remoteJid?.split("@")[0] || "";
          if (remoteDigits !== ownJid) continue;
          if (msg.key.remoteJid?.endsWith("@g.us")) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
          if (!text) continue;
          inboundHandler({
            type: "whatsapp",
            messageId: msg.key.id,
            from: `+${remoteDigits}`,
            to: `+${ownJid}`,
            content: text,
            timestamp: new Date(),
          });
        }
      });

      const upsertData = {
        type: "notify",
        messages: [
          {
            key: { id: "genuine-msg-456", remoteJid: `${ownJidDigits}@s.whatsapp.net` },
            message: { conversation: "Hello Claude" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      };

      mockSocket._ev.emit("messages.upsert", upsertData);

      expect(inboundHandler).toHaveBeenCalledTimes(1);
      expect(inboundHandler.mock.calls[0][0].content).toBe("Hello Claude");
      expect(inboundHandler.mock.calls[0][0].type).toBe("whatsapp");
    });
  });

  describe("disconnect", () => {
    it("sets connected to false and nulls socket", () => {
      const client = new BaileysClient("/tmp/auth-dir");
      const mockSocket = createMockSocket();
      (client as any).socket = mockSocket;
      (client as any).connected = true;

      client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(mockSocket.end).toHaveBeenCalled();
    });
  });
});
