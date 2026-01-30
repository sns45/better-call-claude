/**
 * Configuration
 * Loads and validates app configuration from environment variables
 */

export interface AppConfig {
  phoneProvider: "telnyx" | "twilio";
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;
  whatsappNumber: string;
  userPhoneNumber: string;
  openaiApiKey: string;
  port: number;
  ttsVoice: string;
  telnyxVoice: string;
  transcriptTimeoutMs: number;
  sttSilenceDurationMs: number;
  telnyxPublicKey: string;
}

export function loadConfig(): AppConfig {
  return {
    phoneProvider: (process.env.BETTERCALLCLAUDE_PHONE_PROVIDER || "telnyx") as "telnyx" | "twilio",
    phoneAccountSid: process.env.BETTERCALLCLAUDE_PHONE_ACCOUNT_SID || "",
    phoneAuthToken: process.env.BETTERCALLCLAUDE_PHONE_AUTH_TOKEN || "",
    phoneNumber: process.env.BETTERCALLCLAUDE_PHONE_NUMBER || "",
    whatsappNumber: process.env.BETTERCALLCLAUDE_WHATSAPP_NUMBER || "",
    userPhoneNumber: process.env.BETTERCALLCLAUDE_USER_PHONE_NUMBER || "",
    openaiApiKey: process.env.BETTERCALLCLAUDE_OPENAI_API_KEY || "",
    port: parseInt(process.env.BETTERCALLCLAUDE_PORT || "3333"),
    ttsVoice: process.env.BETTERCALLCLAUDE_TTS_VOICE || "onyx",
    telnyxVoice: process.env.BETTERCALLCLAUDE_TELNYX_VOICE || "female",
    transcriptTimeoutMs: parseInt(process.env.BETTERCALLCLAUDE_TRANSCRIPT_TIMEOUT_MS || "180000"),
    sttSilenceDurationMs: parseInt(process.env.BETTERCALLCLAUDE_STT_SILENCE_DURATION_MS || "800"),
    telnyxPublicKey: process.env.BETTERCALLCLAUDE_TELNYX_PUBLIC_KEY || "",
  };
}

export function validateConfig(config: AppConfig): void {
  const required: (keyof AppConfig)[] = [
    "phoneAccountSid",
    "phoneAuthToken",
    "phoneNumber",
    "userPhoneNumber",
    "openaiApiKey",
  ];

  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Missing required environment variable: BETTERCALLCLAUDE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
    }
  }
}
