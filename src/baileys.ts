/**
 * Baileys WhatsApp Client
 * Connects to WhatsApp Web protocol via WebSocket using @whiskeysockets/baileys.
 * Enables free, personal WhatsApp messaging without Twilio/Telnyx.
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  type WASocket,
  type BaileysEventMap,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { mkdir } from "fs/promises";
import type { InboundMessageData } from "./messaging.js";

/**
 * Convert E.164 phone number (+1234567890) to WhatsApp JID (1234567890@s.whatsapp.net)
 */
export function toJid(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Convert WhatsApp JID (1234567890@s.whatsapp.net) to E.164 phone number (+1234567890)
 */
export function fromJid(jid: string): string {
  const digits = jid.split("@")[0];
  return `+${digits}`;
}

/**
 * Extract text content from a Baileys message
 */
export function extractMessageText(msg: proto.IMessage | null | undefined): string | null {
  if (!msg) return null;
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    null
  );
}

type InboundHandler = (message: InboundMessageData) => void;

export interface BaileysClientOptions {
  /** Print QR code directly to terminal (true for standalone scripts, false for MCP) */
  printQR?: boolean;
}

export class BaileysClient {
  private socket: WASocket | null = null;
  private authDir: string;
  private inboundHandler: InboundHandler | null = null;
  private connected = false;
  private intentionalDisconnect = false;
  private printQR: boolean;
  /** IDs of messages we sent — used to filter echo in self-chat */
  private sentMessageIds: Set<string> = new Set();
  /** IDs of messages already processed — dedup against multiple upsert events for same message */
  private processedMessageIds: Set<string> = new Set();
  /** Debug log of recent messages.upsert events (ring buffer for diagnostics) */
  private debugLog: Array<{ ts: number; type: string; count: number; details: string }> = [];

  constructor(authDir: string, options?: BaileysClientOptions) {
    this.authDir = authDir;
    this.printQR = options?.printQR ?? false;
  }

  /** Get recent debug events (for /health diagnostics) */
  getDebugLog(): typeof this.debugLog {
    return this.debugLog;
  }

  async connect(): Promise<void> {
    await mkdir(this.authDir, { recursive: true });
    this.intentionalDisconnect = false;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const logger = pino({ level: this.printQR ? "warn" : "silent" });

    // Fetch latest WhatsApp Web version — stale versions cause 405 rejection
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: this.printQR,
      browser: Browsers.macOS("Chrome"),
    });

    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Baileys connection timed out after 120s"));
        }
      }, 120_000);

      this.socket!.ev.on("creds.update", saveCreds);

      this.socket!.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Render QR to stderr (stdout is reserved for MCP stdio transport)
          process.stderr.write("\n[Baileys] Scan this QR code with WhatsApp:\n\n");
          qrcode.generate(qr, { small: true }, (qrString: string) => {
            process.stderr.write(qrString + "\n");
          });
        }

        if (connection === "open") {
          this.connected = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
          }
          console.error("[Baileys] Connected to WhatsApp");
          resolve();
        }

        if (connection === "close") {
          this.connected = false;

          // Don't reconnect if disconnect() was called intentionally
          if (this.intentionalDisconnect) return;

          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            console.error("[Baileys] Logged out — delete auth dir and re-scan QR");
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(new Error("WhatsApp logged out"));
            }
          } else if (!settled) {
            // QR expired or connection dropped before pairing — wait then retry with fresh socket
            console.error(`[Baileys] Disconnected (code ${statusCode}), retrying in 2s...`);
            setTimeout(() => {
              this.connect().then(resolve).catch(reject);
            }, 2000);
          } else {
            // Post-connect disconnect — auto-reconnect
            console.error(`[Baileys] Disconnected (code ${statusCode}), reconnecting...`);
            this.connect().catch((err) => {
              console.error("[Baileys] Reconnect failed:", err);
            });
          }
        }
      });

      this.socket!.ev.on("messages.upsert", (upsert) => {
        // Debug: log ALL upsert events (even non-notify) to diagnose inbound issues
        const ownJid = this.socket?.user?.id?.split(":")[0] || "";
        const debugEntry = {
          ts: Date.now(),
          type: upsert.type,
          count: upsert.messages.length,
          details: upsert.messages.map(m => {
            const remote = m.key.remoteJid?.split("@")[0] || "?";
            const text = extractMessageText(m.message);
            return `from=${remote} own=${ownJid} fromMe=${m.key.fromMe} id=${m.key.id?.slice(0, 8)} echo=${m.key.id ? this.sentMessageIds.has(m.key.id) : false} text=${text?.slice(0, 30) || "(none)"}`;
          }).join("; "),
        };
        this.debugLog.push(debugEntry);
        if (this.debugLog.length > 20) this.debugLog.shift();
        console.error(`[Baileys:upsert] type=${upsert.type} msgs=${upsert.messages.length} ${debugEntry.details}`);

        if (upsert.type !== "notify") return;

        for (const msg of upsert.messages) {
          // Skip messages we sent ourselves (echo filtering for self-chat)
          if (msg.key.id && this.sentMessageIds.has(msg.key.id)) {
            console.error(`[Baileys] Skipping echo for sent message ${msg.key.id}`);
            continue;
          }

          // Deduplicate: WhatsApp may deliver the same message multiple times
          // (e.g., via both phone-number JID and LID JID)
          if (msg.key.id && this.processedMessageIds.has(msg.key.id)) {
            continue;
          }

          // Skip group messages and broadcasts
          if (msg.key.remoteJid?.endsWith("@g.us")) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;

          // Only process messages sent by the logged-in user (fromMe=true).
          // This covers self-chat ("Message Yourself") regardless of whether
          // WhatsApp uses phone-number JIDs or LID (Linked Identity) JIDs.
          if (!msg.key.fromMe) continue;

          const text = extractMessageText(msg.message);
          if (!text) continue;

          // Mark as processed to prevent duplicate handling
          if (msg.key.id) {
            this.processedMessageIds.add(msg.key.id);
            setTimeout(() => this.processedMessageIds.delete(msg.key.id!), 120_000);
          }

          const from = fromJid(msg.key.remoteJid || "");
          const to = fromJid(this.socket?.user?.id || "");

          const inbound: InboundMessageData = {
            type: "whatsapp",
            messageId: msg.key.id || crypto.randomUUID(),
            from,
            to,
            content: text,
            timestamp: msg.messageTimestamp
              ? new Date(Number(msg.messageTimestamp) * 1000)
              : new Date(),
          };

          console.error(`[Baileys] Inbound from ${from}: ${text.slice(0, 80)}`);
          this.inboundHandler?.(inbound);
        }
      });
    });
  }

  async sendMessage(to: string, text: string): Promise<string> {
    if (!this.socket || !this.connected) {
      throw new Error("Baileys not connected");
    }
    const jid = toJid(to);
    const result = await this.socket.sendMessage(jid, { text });
    const messageId = result?.key?.id || crypto.randomUUID();
    // Track sent message ID so we can filter the echo in messages.upsert
    this.sentMessageIds.add(messageId);
    setTimeout(() => this.sentMessageIds.delete(messageId), 60_000);
    console.error(`[Baileys] Sent to ${to}: ${text.slice(0, 80)} (id: ${messageId})`);
    return messageId;
  }

  onInboundMessage(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.connected = false;
    this.socket?.end(undefined);
    this.socket = null;
    console.error("[Baileys] Disconnected");
  }
}
