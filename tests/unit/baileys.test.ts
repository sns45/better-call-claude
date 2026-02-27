import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { toJid, fromJid, extractMessageText } from "../../src/baileys";
import { loadConfig, validateConfig, type AppConfig } from "../../src/config";

describe("baileys", () => {
  describe("toJid", () => {
    it("converts E.164 number to WhatsApp JID", () => {
      expect(toJid("+1234567890")).toBe("1234567890@s.whatsapp.net");
    });

    it("strips non-digit characters", () => {
      expect(toJid("+1 (234) 567-890")).toBe("1234567890@s.whatsapp.net");
    });

    it("handles number without plus sign", () => {
      expect(toJid("1234567890")).toBe("1234567890@s.whatsapp.net");
    });

    it("handles international numbers", () => {
      expect(toJid("+4915123456789")).toBe("4915123456789@s.whatsapp.net");
    });
  });

  describe("fromJid", () => {
    it("converts WhatsApp JID to E.164 number", () => {
      expect(fromJid("1234567890@s.whatsapp.net")).toBe("+1234567890");
    });

    it("handles international JIDs", () => {
      expect(fromJid("4915123456789@s.whatsapp.net")).toBe("+4915123456789");
    });

    it("handles JID with extra info after @", () => {
      expect(fromJid("1234567890@s.whatsapp.net:5")).toBe("+1234567890");
    });
  });

  describe("extractMessageText", () => {
    it("extracts conversation text", () => {
      expect(extractMessageText({ conversation: "hello" })).toBe("hello");
    });

    it("extracts extendedTextMessage text", () => {
      expect(
        extractMessageText({
          extendedTextMessage: { text: "extended hello" },
        })
      ).toBe("extended hello");
    });

    it("extracts imageMessage caption", () => {
      expect(
        extractMessageText({
          imageMessage: { caption: "photo caption" } as any,
        })
      ).toBe("photo caption");
    });

    it("extracts videoMessage caption", () => {
      expect(
        extractMessageText({
          videoMessage: { caption: "video caption" } as any,
        })
      ).toBe("video caption");
    });

    it("returns null for empty message", () => {
      expect(extractMessageText(null)).toBeNull();
      expect(extractMessageText(undefined)).toBeNull();
    });

    it("returns null for message with no text content", () => {
      expect(extractMessageText({ imageMessage: {} as any })).toBeNull();
    });

    it("prioritizes conversation over extendedTextMessage", () => {
      expect(
        extractMessageText({
          conversation: "plain",
          extendedTextMessage: { text: "extended" },
        })
      ).toBe("plain");
    });
  });
});

describe("config - baileys mode", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "BETTERCALLCLAUDE_PHONE_PROVIDER",
    "BETTERCALLCLAUDE_WHATSAPP_PROVIDER",
    "BETTERCALLCLAUDE_PHONE_ACCOUNT_SID",
    "BETTERCALLCLAUDE_PHONE_AUTH_TOKEN",
    "BETTERCALLCLAUDE_PHONE_NUMBER",
    "BETTERCALLCLAUDE_WHATSAPP_NUMBER",
    "BETTERCALLCLAUDE_USER_PHONE_NUMBER",
    "BETTERCALLCLAUDE_OPENAI_API_KEY",
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

  it("loads whatsappProvider from env", () => {
    process.env.BETTERCALLCLAUDE_WHATSAPP_PROVIDER = "baileys";
    const config = loadConfig();
    expect(config.whatsappProvider).toBe("baileys");
  });

  it("whatsappProvider is undefined when not set", () => {
    const config = loadConfig();
    expect(config.whatsappProvider).toBeUndefined();
  });

  it("loads baileysAuthDir with default", () => {
    const config = loadConfig();
    expect(config.baileysAuthDir).toBe("data/baileys-auth");
  });

  it("loads custom baileysAuthDir from env", () => {
    process.env.BETTERCALLCLAUDE_BAILEYS_AUTH_DIR = "/tmp/baileys";
    const config = loadConfig();
    expect(config.baileysAuthDir).toBe("/tmp/baileys");
  });

  it("validates in baileys-only mode with just userPhoneNumber", () => {
    process.env.BETTERCALLCLAUDE_WHATSAPP_PROVIDER = "baileys";
    process.env.BETTERCALLCLAUDE_USER_PHONE_NUMBER = "+1234567890";
    const config = loadConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("fails baileys-only mode without userPhoneNumber", () => {
    process.env.BETTERCALLCLAUDE_WHATSAPP_PROVIDER = "baileys";
    const config = loadConfig();
    expect(() => validateConfig(config)).toThrow("BETTERCALLCLAUDE_USER_PHONE_NUMBER");
  });

  it("validates hybrid mode (twilio + baileys) with all required fields", () => {
    process.env.BETTERCALLCLAUDE_PHONE_PROVIDER = "twilio";
    process.env.BETTERCALLCLAUDE_WHATSAPP_PROVIDER = "baileys";
    process.env.BETTERCALLCLAUDE_PHONE_ACCOUNT_SID = "AC_TEST";
    process.env.BETTERCALLCLAUDE_PHONE_AUTH_TOKEN = "token";
    process.env.BETTERCALLCLAUDE_PHONE_NUMBER = "+1555";
    process.env.BETTERCALLCLAUDE_USER_PHONE_NUMBER = "+1666";
    process.env.BETTERCALLCLAUDE_OPENAI_API_KEY = "sk-test";
    const config = loadConfig();
    expect(() => validateConfig(config)).not.toThrow();
    expect(config.whatsappProvider).toBe("baileys");
    expect(config.phoneProvider).toBe("twilio");
  });
});
