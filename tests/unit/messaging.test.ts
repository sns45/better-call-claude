import { describe, it, expect, beforeEach, mock } from "bun:test";
import { MessagingManager } from "../../src/messaging";

describe("MessagingManager", () => {
  const baseConfig = {
    phoneProvider: "twilio" as const,
    phoneAccountSid: "AC_TEST_SID",
    phoneAuthToken: "test_auth_token",
    phoneNumber: "+15551234567",
    whatsappNumber: "+15559876543",
  };

  let manager: MessagingManager;

  beforeEach(() => {
    manager = new MessagingManager(baseConfig);
  });

  describe("parseInboundMessage - Twilio", () => {
    it("parses SMS inbound", () => {
      const result = manager.parseInboundMessage("twilio", {
        MessageSid: "SM123",
        From: "+11234567890",
        To: "+10987654321",
        Body: "Hello there",
      });
      expect(result).not.toBeNull();
      expect(result!.type).toBe("sms");
      expect(result!.messageId).toBe("SM123");
      expect(result!.from).toBe("+11234567890");
      expect(result!.content).toBe("Hello there");
    });

    it("parses WhatsApp inbound (whatsapp: prefix)", () => {
      const result = manager.parseInboundMessage("twilio", {
        MessageSid: "SM456",
        From: "whatsapp:+11234567890",
        To: "whatsapp:+10987654321",
        Body: "WhatsApp msg",
      });
      expect(result!.type).toBe("whatsapp");
      expect(result!.from).toBe("+11234567890"); // prefix stripped
      expect(result!.to).toBe("+10987654321");
    });

    it("returns null when no Body", () => {
      const result = manager.parseInboundMessage("twilio", { MessageSid: "SM789" });
      expect(result).toBeNull();
    });
  });

  describe("parseInboundMessage - Telnyx", () => {
    it("parses SMS inbound", () => {
      const result = manager.parseInboundMessage("telnyx", {
        data: {
          event_type: "message.received",
          payload: {
            id: "msg-1",
            from: { phone_number: "+1111" },
            to: [{ phone_number: "+2222" }],
            text: "hi from telnyx",
            type: "SMS",
          },
        },
      });
      expect(result!.type).toBe("sms");
      expect(result!.content).toBe("hi from telnyx");
    });

    it("parses WhatsApp inbound", () => {
      const result = manager.parseInboundMessage("telnyx", {
        data: {
          event_type: "message.received",
          payload: {
            id: "msg-2",
            from: "+1111",
            to: "+2222",
            text: "whatsapp msg",
            type: "whatsapp",
          },
        },
      });
      expect(result!.type).toBe("whatsapp");
    });

    it("returns null for non-message.received event", () => {
      const result = manager.parseInboundMessage("telnyx", {
        data: { event_type: "message.sent", payload: {} },
      });
      expect(result).toBeNull();
    });
  });

  describe("parseStatusWebhook", () => {
    it("parses Twilio message status", () => {
      const result = manager.parseStatusWebhook("twilio", {
        MessageSid: "SM123",
        MessageStatus: "delivered",
      });
      expect(result!.messageId).toBe("SM123");
      expect(result!.status).toBe("delivered");
    });

    it("returns null for unknown Twilio status", () => {
      const result = manager.parseStatusWebhook("twilio", {
        MessageStatus: "unknown_status",
      });
      expect(result).toBeNull();
    });

    it("parses Telnyx message status", () => {
      const result = manager.parseStatusWebhook("telnyx", {
        data: {
          event_type: "message.delivered",
          payload: { id: "msg-1" },
        },
      });
      expect(result!.status).toBe("delivered");
    });

    it("maps Twilio failed/undelivered to failed", () => {
      expect(manager.parseStatusWebhook("twilio", { MessageSid: "x", MessageStatus: "failed" })!.status).toBe("failed");
      expect(manager.parseStatusWebhook("twilio", { MessageSid: "x", MessageStatus: "undelivered" })!.status).toBe("failed");
    });
  });

  describe("sendSMS - Twilio", () => {
    it("sends SMS via Twilio API", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ sid: "SM_NEW", status: "queued" }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      try {
        const sid = await manager.sendSMS("+19995551234", "Test message");
        expect(sid).toBe("SM_NEW");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0] as [string, any];
        expect(url).toContain("Messages.json");
        expect(opts.body.toString()).toContain("Body=Test+message");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws on Twilio SMS error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ code: 21211, message: "Invalid number" }), { status: 400 }))
      ) as any;

      try {
        await expect(manager.sendSMS("+1999", "msg")).rejects.toThrow("Twilio SMS failed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("sendWhatsApp - Twilio", () => {
    it("sends WhatsApp via Twilio API with whatsapp: prefix", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ sid: "SM_WA" }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      try {
        const sid = await manager.sendWhatsApp("+19995551234", "WhatsApp test");
        expect(sid).toBe("SM_WA");
        const body = mockFetch.mock.calls[0][1].body.toString();
        expect(body).toContain("whatsapp%3A");
        // Should use whatsappNumber as From
        expect(body).toContain(encodeURIComponent("whatsapp:+15559876543"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("uses phoneNumber when whatsappNumber not set", async () => {
      const mgr = new MessagingManager({ ...baseConfig, whatsappNumber: undefined });
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ sid: "SM_WA2" }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      try {
        await mgr.sendWhatsApp("+19995551234", "test");
        const body = mockFetch.mock.calls[0][1].body.toString();
        expect(body).toContain(encodeURIComponent("whatsapp:+15551234567"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
