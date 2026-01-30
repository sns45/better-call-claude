import { describe, it, expect, beforeEach, mock } from "bun:test";
import { PhoneCallManager } from "../../src/phone-call";

// We test TwiML generation (pure) and Twilio API calls (mock fetch)
describe("PhoneCallManager", () => {
  const baseConfig = {
    phoneProvider: "twilio" as const,
    phoneAccountSid: "AC_TEST_SID",
    phoneAuthToken: "test_auth_token",
    phoneNumber: "+15551234567",
    openaiApiKey: "sk-test",
    ttsVoice: "onyx",
    sttSilenceDurationMs: 800,
  };

  let manager: PhoneCallManager;

  beforeEach(() => {
    manager = new PhoneCallManager(baseConfig);
  });

  describe("TwiML generation", () => {
    it("generateAnswerTwiML includes Say and Gather", () => {
      const twiml = manager.generateAnswerTwiML("Hello!", "https://example.com/gather");
      expect(twiml).toContain('<?xml version="1.0"');
      expect(twiml).toContain("<Response>");
      expect(twiml).toContain("Hello!");
      expect(twiml).toContain("<Gather");
      expect(twiml).toContain("https://example.com/gather");
      expect(twiml).toContain('input="speech dtmf"');
    });

    it("generateGatherTwiML includes message and action", () => {
      const twiml = manager.generateGatherTwiML("Please speak", "https://example.com/cb");
      expect(twiml).toContain("Please speak");
      expect(twiml).toContain("https://example.com/cb");
      expect(twiml).toContain("<Gather");
    });

    it("generateHoldTwiML with message includes Say, Pause, Redirect", () => {
      const twiml = manager.generateHoldTwiML("Please wait", "https://example.com/hold", 15);
      expect(twiml).toContain("Please wait");
      expect(twiml).toContain('<Pause length="15"');
      expect(twiml).toContain("<Redirect>");
      expect(twiml).toContain("https://example.com/hold");
    });

    it("generateHoldTwiML without message omits Say", () => {
      const twiml = manager.generateHoldTwiML("", "https://example.com/hold", 30);
      expect(twiml).not.toContain("<Say");
      expect(twiml).toContain("<Pause");
      expect(twiml).toContain("<Redirect>");
    });

    it("generateSayTwiML includes message only", () => {
      const twiml = manager.generateSayTwiML("Just saying");
      expect(twiml).toContain("Just saying");
      expect(twiml).not.toContain("<Gather");
    });

    it("generateHangupTwiML includes message and hangup", () => {
      const twiml = manager.generateHangupTwiML("Goodbye");
      expect(twiml).toContain("Goodbye");
      expect(twiml).toContain("<Hangup");
    });

    it("generateWaitTwiML includes pause duration", () => {
      const twiml = manager.generateWaitTwiML("Wait a moment", 10);
      expect(twiml).toContain("Wait a moment");
      expect(twiml).toContain('<Pause length="10"');
    });

    it("escapes XML special characters", () => {
      const twiml = manager.generateSayTwiML('Hello & "world" <tag>');
      expect(twiml).toContain("&amp;");
      expect(twiml).toContain("&quot;");
      expect(twiml).toContain("&lt;");
      expect(twiml).toContain("&gt;");
    });
  });

  describe("parseInboundWebhook - Twilio", () => {
    it("parses ringing status as call.initiated", () => {
      const result = manager.parseInboundWebhook("twilio", {
        CallSid: "CA123",
        CallStatus: "ringing",
        From: "+1111",
        To: "+2222",
      });
      expect(result.type).toBe("call.initiated");
      expect(result.providerCallId).toBe("CA123");
      expect(result.from).toBe("+1111");
      expect(result.to).toBe("+2222");
    });

    it("parses in-progress as call.answered", () => {
      const result = manager.parseInboundWebhook("twilio", {
        CallSid: "CA123",
        CallStatus: "in-progress",
      });
      expect(result.type).toBe("call.answered");
    });

    it("parses completed as call.hangup", () => {
      const result = manager.parseInboundWebhook("twilio", {
        CallSid: "CA123",
        CallStatus: "completed",
      });
      expect(result.type).toBe("call.hangup");
    });

    it("parses unknown status", () => {
      const result = manager.parseInboundWebhook("twilio", {
        CallStatus: "unknown-status",
      });
      expect(result.type).toBe("unknown");
    });
  });

  describe("parseInboundWebhook - Telnyx", () => {
    it("parses call.initiated event", () => {
      const result = manager.parseInboundWebhook("telnyx", {
        data: {
          event_type: "call.initiated",
          payload: { call_control_id: "cc-1", from: "+1111", to: "+2222" },
        },
      });
      expect(result.type).toBe("call.initiated");
      expect(result.providerCallId).toBe("cc-1");
    });
  });

  describe("parseSpeechResult", () => {
    it("parses Twilio SpeechResult", () => {
      const result = manager.parseSpeechResult("twilio", {
        SpeechResult: "create a todo app",
        Confidence: "0.95",
      });
      expect(result.transcript).toBe("create a todo app");
      expect(result.confidence).toBe(0.95);
    });

    it("parses Twilio Digits fallback", () => {
      const result = manager.parseSpeechResult("twilio", { Digits: "1234" });
      expect(result.transcript).toBe("1234");
    });

    it("returns null transcript when no speech", () => {
      const result = manager.parseSpeechResult("twilio", {});
      expect(result.transcript).toBeNull();
    });

    it("parses Telnyx speech result", () => {
      const result = manager.parseSpeechResult("telnyx", {
        data: { payload: { speech: { transcript: "hello", confidence: 0.9 } } },
      });
      expect(result.transcript).toBe("hello");
      expect(result.confidence).toBe(0.9);
    });
  });

  describe("parseStatusWebhook", () => {
    it("parses Twilio statuses", () => {
      expect(manager.parseStatusWebhook("twilio", { CallStatus: "ringing" }).state).toBe("ringing");
      expect(manager.parseStatusWebhook("twilio", { CallStatus: "in-progress" }).state).toBe("answered");
      expect(manager.parseStatusWebhook("twilio", { CallStatus: "completed" }).state).toBe("completed");
      expect(manager.parseStatusWebhook("twilio", { CallStatus: "failed" }).state).toBe("failed");
      expect(manager.parseStatusWebhook("twilio", { CallStatus: "busy" }).state).toBe("busy");
    });

    it("parses Telnyx statuses", () => {
      expect(manager.parseStatusWebhook("telnyx", { data: { event_type: "call.answered" } }).state).toBe("answered");
      expect(manager.parseStatusWebhook("telnyx", { data: { event_type: "call.hangup" } }).state).toBe("completed");
    });
  });

  describe("Twilio API calls", () => {
    it("initiateCall makes Twilio REST call", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ sid: "CA_NEW" }), { status: 200 }))
      );
      globalThis.fetch = mockFetch as any;

      try {
        const sid = await manager.initiateCall(
          "+19995551234",
          "Hello user",
          "https://example.com/status",
          "https://example.com/gather"
        );
        expect(sid).toBe("CA_NEW");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0] as [string, any];
        expect(url).toContain("Calls.json");
        expect(opts.method).toBe("POST");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("initiateCall throws on Twilio error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Error", { status: 400 }))
      ) as any;

      try {
        await expect(
          manager.initiateCall("+19995551234", "msg", "https://status", "https://gather")
        ).rejects.toThrow("Twilio call failed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("endCall completes Twilio call", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
      globalThis.fetch = mockFetch as any;

      try {
        await manager.endCall("CA_123");
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, opts] = mockFetch.mock.calls[0] as [string, any];
        expect(url).toContain("CA_123.json");
        expect(opts.body.toString()).toContain("Status=completed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("speakToCall injects TwiML into active call", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
      globalThis.fetch = mockFetch as any;

      try {
        await manager.speakToCall("CA_123", "Working on it", false);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const body = mockFetch.mock.calls[0][1].body.toString();
        expect(body).toContain("Twiml=");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
