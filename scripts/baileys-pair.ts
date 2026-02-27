#!/usr/bin/env node
/**
 * Baileys Pairing Script
 * Run this standalone to scan the QR code and establish a WhatsApp session.
 * The session is saved to data/baileys-auth/ and reused by the MCP server.
 *
 * IMPORTANT: Must run with Node.js (not Bun) — Bun's WebSocket doesn't support
 * the 'upgrade' event that Baileys needs for the initial QR handshake.
 *
 * Usage: npx tsx scripts/baileys-pair.ts
 */

import { BaileysClient } from "../src/baileys.js";

const authDir = process.env.BETTERCALLCLAUDE_BAILEYS_AUTH_DIR || "data/baileys-auth";

console.log("=== Baileys WhatsApp Pairing ===");
console.log(`Auth directory: ${authDir}`);
console.log("");
console.log("1. Open WhatsApp on your phone");
console.log("2. Go to Settings > Linked Devices > Link a Device");
console.log("3. Scan the QR code that appears below");
console.log("");

const client = new BaileysClient(authDir, { printQR: true });

try {
  await client.connect();
  // Wait for creds to flush to disk before exiting
  await new Promise((r) => setTimeout(r, 2000));
  console.log("");
  console.log("Paired successfully! Session saved.");
  console.log("You can now restart Claude Code — Baileys will connect automatically without QR.");
  client.disconnect();
  process.exit(0);
} catch (err) {
  console.error("Pairing failed:", err);
  process.exit(1);
}
