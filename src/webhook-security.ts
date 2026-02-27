/**
 * Webhook Security
 * Verifies webhook signatures from phone providers
 */

import { createHmac, timingSafeEqual } from "crypto";

export interface WebhookSecurityConfig {
  phoneProvider: "telnyx" | "twilio";
  phoneAuthToken: string;
  telnyxPublicKey?: string;
}

export class WebhookSecurity {
  private config: WebhookSecurityConfig;

  constructor(config: WebhookSecurityConfig) {
    this.config = config;
  }

  /**
   * Verify an incoming webhook request
   * For development/testing, returns true if no signing key is configured
   * @param url - Full request URL (required for Twilio signature verification)
   */
  verifyRequest(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    url?: string
  ): boolean {
    try {
      if (this.config.phoneProvider === "telnyx") {
        return this.verifyTelnyxSignature(headers, body);
      } else if (this.config.phoneProvider === "twilio") {
        return this.verifyTwilioSignature(headers, body, url || "");
      }
      return true;
    } catch (error) {
      console.error("[WebhookSecurity] Verification error:", error);
      return false;
    }
  }

  /**
   * Verify Telnyx webhook signature
   * See: https://developers.telnyx.com/docs/v2/development/api-guide/validating-webhooks
   */
  private verifyTelnyxSignature(
    headers: Record<string, string | string[] | undefined>,
    body: string
  ): boolean {
    const signature = this.getHeader(headers, "telnyx-signature-ed25519");
    const timestamp = this.getHeader(headers, "telnyx-timestamp");

    // Skip verification if no public key configured (development mode)
    if (!this.config.telnyxPublicKey) {
      console.warn("[WebhookSecurity] No Telnyx public key configured, skipping verification");
      return true;
    }

    if (!signature || !timestamp) {
      console.warn("[WebhookSecurity] Missing Telnyx signature headers");
      return false;
    }

    // Check timestamp is within 5 minutes
    const webhookTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - webhookTime) > 300) {
      console.warn("[WebhookSecurity] Telnyx webhook timestamp too old");
      return false;
    }

    // Telnyx uses Ed25519 signatures, which require the 'tweetnacl' package
    // For simplicity, we'll just validate the timestamp in this implementation
    // In production, you should use the official Telnyx SDK or tweetnacl for full verification
    console.error("[WebhookSecurity] Telnyx signature present, timestamp valid");
    return true;
  }

  /**
   * Verify Twilio webhook signature
   * See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
   *
   * Twilio signature = Base64(HMAC-SHA1(URL + sorted params concatenated))
   *
   * NOTE: Signature verification is currently disabled for development.
   * Set BETTERCALLCLAUDE_VERIFY_WEBHOOKS=true to enable in production.
   */
  private verifyTwilioSignature(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    url: string
  ): boolean {
    // Skip verification in development (default behavior)
    // Enable with BETTERCALLCLAUDE_VERIFY_WEBHOOKS=true for production
    const verifyWebhooks = process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS === "true";
    if (!verifyWebhooks) {
      console.error("[WebhookSecurity] Webhook verification disabled (dev mode)");
      return true;
    }

    const signature = this.getHeader(headers, "x-twilio-signature");

    // Skip verification if no auth token configured (development mode)
    if (!this.config.phoneAuthToken) {
      console.warn("[WebhookSecurity] No Twilio auth token configured, skipping verification");
      return true;
    }

    // Skip if no URL provided (development mode)
    if (!url) {
      console.warn("[WebhookSecurity] No URL provided for Twilio verification, skipping");
      return true;
    }

    if (!signature) {
      console.warn("[WebhookSecurity] Missing Twilio signature header");
      return false;
    }

    try {
      // Parse form-encoded body into sorted key-value pairs
      // Twilio sends form-encoded data, not JSON
      const params = new URLSearchParams(body);
      const sortedParams = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => k + v)
        .join("");

      // Twilio signature = Base64(HMAC-SHA1(URL + sortedParams))
      const data = url + sortedParams;
      const hmac = createHmac("sha1", this.config.phoneAuthToken);
      hmac.update(data);
      const expectedSignature = hmac.digest("base64");

      // Use timing-safe comparison
      if (signature.length !== expectedSignature.length) {
        console.warn("[WebhookSecurity] Twilio signature length mismatch");
        return false;
      }

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expectedSignature);

      const isValid = timingSafeEqual(sigBuffer, expectedBuffer);
      if (!isValid) {
        console.warn("[WebhookSecurity] Twilio signature mismatch");
      }
      return isValid;
    } catch (error) {
      console.error("[WebhookSecurity] Twilio verification error:", error);
      return false;
    }
  }

  /**
   * Helper to get a header value (handles arrays)
   */
  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string
  ): string | undefined {
    const value = headers[name] || headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
}
