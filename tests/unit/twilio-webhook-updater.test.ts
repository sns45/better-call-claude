import { describe, it, expect, mock } from "bun:test";
import { updateTwilioWebhooks } from "../../src/twilio-webhook-updater";

describe("updateTwilioWebhooks", () => {
  const config = {
    accountSid: "AC_TEST",
    authToken: "test_token",
    phoneNumber: "+15551234567",
  };

  it("looks up phone number and updates webhooks", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = mock((url: string) => {
      if (url.includes("IncomingPhoneNumbers.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              incoming_phone_numbers: [{ sid: "PN_123", phone_number: "+15551234567" }],
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("IncomingPhoneNumbers/PN_123.json")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      // Messaging services lookup
      if (url.includes("messaging.twilio.com")) {
        return Promise.resolve(new Response(JSON.stringify({ services: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      await updateTwilioWebhooks(config, "https://my-funnel.ts.net/bcc");

      // Should have made at least 2 calls: lookup + update
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Check lookup call
      const lookupUrl = mockFetch.mock.calls[0][0] as string;
      expect(lookupUrl).toContain("IncomingPhoneNumbers.json");
      expect(lookupUrl).toContain(encodeURIComponent("+15551234567"));

      // Check update call
      const updateUrl = mockFetch.mock.calls[1][0] as string;
      expect(updateUrl).toContain("PN_123.json");
      const updateBody = mockFetch.mock.calls[1][1].body;
      expect(updateBody).toContain("VoiceUrl=");
      expect(updateBody).toContain(encodeURIComponent("https://my-funnel.ts.net/bcc/webhook/twilio/inbound"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles phone number not found", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ incoming_phone_numbers: [] }), { status: 200 })
      )
    ) as any;

    try {
      // Should not throw, just log error
      await updateTwilioWebhooks(config, "https://example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles lookup API failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))
    ) as any;

    try {
      // Should not throw
      await updateTwilioWebhooks(config, "https://example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
