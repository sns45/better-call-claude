import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "crypto";
import { WebhookSecurity } from "../../src/webhook-security";

describe("WebhookSecurity", () => {
  describe("Twilio verification", () => {
    const authToken = "test-auth-token-12345";

    it("returns true when verification is disabled (default dev mode)", () => {
      const security = new WebhookSecurity({
        phoneProvider: "twilio",
        phoneAuthToken: authToken,
      });
      // BETTERCALLCLAUDE_VERIFY_WEBHOOKS is not set, so verification is skipped
      const result = security.verifyRequest({}, "Body=test", "https://example.com/webhook");
      expect(result).toBe(true);
    });

    it("validates correct HMAC-SHA1 signature when verification enabled", () => {
      // Temporarily enable verification
      const origEnv = process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
      process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = "true";

      try {
        const security = new WebhookSecurity({
          phoneProvider: "twilio",
          phoneAuthToken: authToken,
        });

        const url = "https://example.com/webhook/twilio/inbound";
        const body = "CallSid=CA123&From=%2B1234567890&To=%2B0987654321&CallStatus=ringing";

        // Compute expected signature
        const params = new URLSearchParams(body);
        const sortedParams = Array.from(params.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => k + v)
          .join("");
        const data = url + sortedParams;
        const hmac = createHmac("sha1", authToken);
        hmac.update(data);
        const expectedSig = hmac.digest("base64");

        const result = security.verifyRequest(
          { "x-twilio-signature": expectedSig },
          body,
          url
        );
        expect(result).toBe(true);
      } finally {
        if (origEnv === undefined) {
          delete process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
        } else {
          process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = origEnv;
        }
      }
    });

    it("rejects invalid signature when verification enabled", () => {
      const origEnv = process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
      process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = "true";

      try {
        const security = new WebhookSecurity({
          phoneProvider: "twilio",
          phoneAuthToken: authToken,
        });

        const result = security.verifyRequest(
          { "x-twilio-signature": "invalidsignature==" },
          "Body=test",
          "https://example.com/webhook"
        );
        expect(result).toBe(false);
      } finally {
        if (origEnv === undefined) {
          delete process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
        } else {
          process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = origEnv;
        }
      }
    });

    it("rejects missing signature when verification enabled", () => {
      const origEnv = process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
      process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = "true";

      try {
        const security = new WebhookSecurity({
          phoneProvider: "twilio",
          phoneAuthToken: authToken,
        });

        const result = security.verifyRequest({}, "Body=test", "https://example.com/webhook");
        expect(result).toBe(false);
      } finally {
        if (origEnv === undefined) {
          delete process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
        } else {
          process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = origEnv;
        }
      }
    });

    it("returns true when no auth token configured (dev mode)", () => {
      const origEnv = process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
      process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = "true";

      try {
        const security = new WebhookSecurity({
          phoneProvider: "twilio",
          phoneAuthToken: "",
        });
        const result = security.verifyRequest({}, "Body=test", "https://example.com");
        expect(result).toBe(true);
      } finally {
        if (origEnv === undefined) {
          delete process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS;
        } else {
          process.env.BETTERCALLCLAUDE_VERIFY_WEBHOOKS = origEnv;
        }
      }
    });
  });

  describe("Telnyx verification", () => {
    it("returns true when no public key configured (dev mode)", () => {
      const security = new WebhookSecurity({
        phoneProvider: "telnyx",
        phoneAuthToken: "test",
      });
      const result = security.verifyRequest({}, '{"data":{}}');
      expect(result).toBe(true);
    });

    it("rejects missing signature headers when key configured", () => {
      const security = new WebhookSecurity({
        phoneProvider: "telnyx",
        phoneAuthToken: "test",
        telnyxPublicKey: "some-public-key",
      });
      const result = security.verifyRequest({}, '{"data":{}}');
      expect(result).toBe(false);
    });

    it("rejects stale timestamp", () => {
      const security = new WebhookSecurity({
        phoneProvider: "telnyx",
        phoneAuthToken: "test",
        telnyxPublicKey: "some-public-key",
      });
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600); // 10 minutes ago
      const result = security.verifyRequest(
        {
          "telnyx-signature-ed25519": "fakesig",
          "telnyx-timestamp": staleTimestamp,
        },
        '{"data":{}}'
      );
      expect(result).toBe(false);
    });

    it("accepts valid timestamp with signature present", () => {
      const security = new WebhookSecurity({
        phoneProvider: "telnyx",
        phoneAuthToken: "test",
        telnyxPublicKey: "some-public-key",
      });
      const now = String(Math.floor(Date.now() / 1000));
      const result = security.verifyRequest(
        {
          "telnyx-signature-ed25519": "fakesig",
          "telnyx-timestamp": now,
        },
        '{"data":{}}'
      );
      // Current implementation only validates timestamp, not actual Ed25519 sig
      expect(result).toBe(true);
    });
  });

  describe("unknown provider", () => {
    it("returns true for unknown provider", () => {
      const security = new WebhookSecurity({
        phoneProvider: "unknown" as any,
        phoneAuthToken: "test",
      });
      const result = security.verifyRequest({}, "body");
      expect(result).toBe(true);
    });
  });
});
