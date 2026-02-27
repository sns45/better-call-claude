import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, validateConfig, type AppConfig } from "../../src/config";

describe("config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    "BETTERCALLCLAUDE_PHONE_PROVIDER",
    "BETTERCALLCLAUDE_PHONE_ACCOUNT_SID",
    "BETTERCALLCLAUDE_PHONE_AUTH_TOKEN",
    "BETTERCALLCLAUDE_PHONE_NUMBER",
    "BETTERCALLCLAUDE_WHATSAPP_NUMBER",
    "BETTERCALLCLAUDE_USER_PHONE_NUMBER",
    "BETTERCALLCLAUDE_OPENAI_API_KEY",
    "BETTERCALLCLAUDE_PORT",
    "BETTERCALLCLAUDE_TTS_VOICE",
    "BETTERCALLCLAUDE_TELNYX_VOICE",
    "BETTERCALLCLAUDE_TRANSCRIPT_TIMEOUT_MS",
    "BETTERCALLCLAUDE_STT_SILENCE_DURATION_MS",
    "BETTERCALLCLAUDE_TELNYX_PUBLIC_KEY",
    "BETTERCALLCLAUDE_WHATSAPP_PROVIDER",
    "BETTERCALLCLAUDE_WHATSAPP_CHAT_HISTORY_SIZE",
    "BETTERCALLCLAUDE_BAILEYS_AUTH_DIR",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe("loadConfig", () => {
    it("returns defaults when no env vars set", () => {
      const config = loadConfig();
      expect(config.phoneProvider).toBe("telnyx");
      expect(config.port).toBe(3333);
      expect(config.ttsVoice).toBe("onyx");
      expect(config.telnyxVoice).toBe("female");
      expect(config.transcriptTimeoutMs).toBe(180000);
      expect(config.sttSilenceDurationMs).toBe(800);
    });

    it("reads env vars", () => {
      process.env.BETTERCALLCLAUDE_PHONE_PROVIDER = "twilio";
      process.env.BETTERCALLCLAUDE_PORT = "4444";
      process.env.BETTERCALLCLAUDE_PHONE_ACCOUNT_SID = "AC_TEST";

      const config = loadConfig();
      expect(config.phoneProvider).toBe("twilio");
      expect(config.port).toBe(4444);
      expect(config.phoneAccountSid).toBe("AC_TEST");
    });
  });

  describe("validateConfig", () => {
    it("throws on missing required fields", () => {
      const config = loadConfig(); // all empty
      expect(() => validateConfig(config)).toThrow("Missing required");
    });

    it("passes with all required fields set", () => {
      const config: AppConfig = {
        ...loadConfig(),
        phoneAccountSid: "AC_TEST",
        phoneAuthToken: "token",
        phoneNumber: "+1555",
        userPhoneNumber: "+1666",
        openaiApiKey: "sk-test",
      };
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe("whatsappChatHistorySize", () => {
    it("defaults to 50 when no env var set", () => {
      const config = loadConfig();
      expect(config.whatsappChatHistorySize).toBe(50);
    });

    it("reads from env var", () => {
      process.env.BETTERCALLCLAUDE_WHATSAPP_CHAT_HISTORY_SIZE = "100";
      const config = loadConfig();
      expect(config.whatsappChatHistorySize).toBe(100);
    });

    it("NaN env value results in NaN", () => {
      process.env.BETTERCALLCLAUDE_WHATSAPP_CHAT_HISTORY_SIZE = "not-a-number";
      const config = loadConfig();
      expect(config.whatsappChatHistorySize).toBeNaN();
    });
  });

  describe("Baileys-only validation", () => {
    it("accepts minimal config with just userPhoneNumber and whatsappProvider", () => {
      process.env.BETTERCALLCLAUDE_WHATSAPP_PROVIDER = "baileys";
      process.env.BETTERCALLCLAUDE_USER_PHONE_NUMBER = "+1234567890";
      const config = loadConfig();
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.whatsappProvider).toBe("baileys");
      expect(config.phoneAccountSid).toBe("");
      expect(config.phoneAuthToken).toBe("");
    });
  });
});
