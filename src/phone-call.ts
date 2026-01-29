/**
 * Phone Call Manager
 * Handles phone calls via Telnyx (primary) or Twilio
 * Integrates with OpenAI for TTS/STT
 */

import Telnyx from "telnyx";
import OpenAI from "openai";

export interface PhoneCallConfig {
  phoneProvider: "telnyx" | "twilio";
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;
  openaiApiKey: string;
  ttsVoice: string;
  telnyxVoice?: string;
  sttSilenceDurationMs: number;
}

export interface InboundWebhookData {
  type: "call.initiated" | "call.answered" | "call.hangup" | "unknown";
  providerCallId: string;
  from: string;
  to: string;
}

export interface SpeechResult {
  transcript: string | null;
  confidence?: number;
}

export interface StatusResult {
  state: "ringing" | "answered" | "completed" | "failed" | "busy" | "no-answer";
}

export class PhoneCallManager {
  private config: PhoneCallConfig;
  private telnyx: Telnyx | null = null;
  private openai: OpenAI;

  constructor(config: PhoneCallConfig) {
    this.config = config;

    // Initialize OpenAI
    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
    });

    // Initialize Telnyx if it's the provider
    if (config.phoneProvider === "telnyx") {
      this.telnyx = new Telnyx(config.phoneAuthToken);
    }
  }

  /**
   * Initiate an outbound call
   */
  async initiateCall(
    to: string,
    message: string,
    statusUrl: string,
    gatherUrl: string
  ): Promise<string> {
    console.log(`[PhoneCall] Initiating call to ${to}`);

    if (this.config.phoneProvider === "telnyx") {
      return this.initiateTelnyxCall(to, message, statusUrl, gatherUrl);
    } else {
      return this.initiateTwilioCall(to, message, statusUrl, gatherUrl);
    }
  }

  private async initiateTelnyxCall(
    to: string,
    message: string,
    statusUrl: string,
    gatherUrl: string
  ): Promise<string> {
    if (!this.telnyx) {
      throw new Error("Telnyx client not initialized");
    }

    try {
      // Create a call using Telnyx Call Control
      const response = await this.telnyx.calls.create({
        connection_id: this.config.phoneAccountSid,
        to,
        from: this.config.phoneNumber,
        answering_machine_detection: "detect",
        webhook_url: statusUrl,
      });

      const callControlId = response.data?.call_control_id;
      if (!callControlId) {
        throw new Error("No call_control_id returned from Telnyx");
      }

      console.log(`[PhoneCall] Telnyx call created: ${callControlId}`);

      // The message will be spoken when the call is answered via webhook
      return callControlId;
    } catch (error) {
      console.error("[PhoneCall] Telnyx call error:", error);
      throw error;
    }
  }

  private async initiateTwilioCall(
    to: string,
    message: string,
    statusUrl: string,
    gatherUrl: string
  ): Promise<string> {
    // Twilio uses REST API
    const auth = Buffer.from(
      `${this.config.phoneAccountSid}:${this.config.phoneAuthToken}`
    ).toString("base64");

    const twiml = this.generateTwiML(message, gatherUrl);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.phoneAccountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: to,
          From: this.config.phoneNumber,
          Twiml: twiml,
          StatusCallback: statusUrl,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio call failed: ${error}`);
    }

    const data = await response.json();
    console.log(`[PhoneCall] Twilio call created: ${data.sid}`);
    return data.sid;
  }

  /**
   * Speak to an active call
   * @param gatherUrl - Required for Twilio when waitForResponse is true
   */
  async speakToCall(
    providerCallId: string,
    message: string,
    waitForResponse: boolean,
    gatherUrl?: string
  ): Promise<void> {
    console.log(`[PhoneCall] Speaking to call ${providerCallId}: ${message.slice(0, 50)}...`);

    if (this.config.phoneProvider === "telnyx") {
      await this.speakToTelnyxCall(providerCallId, message, waitForResponse);
    } else {
      await this.speakToTwilioCall(providerCallId, message, waitForResponse, gatherUrl);
    }
  }

  private async speakToTelnyxCall(
    callControlId: string,
    message: string,
    waitForResponse: boolean
  ): Promise<void> {
    if (!this.telnyx) {
      throw new Error("Telnyx client not initialized");
    }

    try {
      // Use Telnyx TTS or generate audio via OpenAI
      // For now, use Telnyx's built-in TTS
      await this.telnyx.calls.speak({
        call_control_id: callControlId,
        payload: message,
        voice: this.config.telnyxVoice || "female",
        language: "en-US",
      });

      console.log(`[PhoneCall] Spoke to Telnyx call ${callControlId}`);

      if (waitForResponse) {
        // Start gathering speech input
        await this.telnyx.calls.gather_using_speak({
          call_control_id: callControlId,
          payload: "", // Empty payload since we just spoke
          voice: "female",
          language: "en-US",
          minimum_digits: 1,
          maximum_digits: 128,
          timeout_millis: this.config.sttSilenceDurationMs,
        });
      }
    } catch (error) {
      console.error("[PhoneCall] Telnyx speak error:", error);
      throw error;
    }
  }

  /**
   * Speak to an active Twilio call using the Modify Call API
   * This injects new TwiML into an in-progress call
   */
  private async speakToTwilioCall(
    callSid: string,
    message: string,
    waitForResponse: boolean,
    gatherUrl?: string
  ): Promise<void> {
    const auth = Buffer.from(
      `${this.config.phoneAccountSid}:${this.config.phoneAuthToken}`
    ).toString("base64");

    // Generate appropriate TwiML
    let twiml: string;
    if (waitForResponse && gatherUrl) {
      twiml = this.generateGatherTwiML(message, gatherUrl);
    } else {
      twiml = this.generateSayTwiML(message);
    }

    // Use Twilio's call modify API to inject new TwiML
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.phoneAccountSid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          Twiml: twiml,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio speak failed: ${error}`);
    }

    console.log(`[PhoneCall] Spoke to Twilio call ${callSid}`);
  }

  /**
   * End an active call
   */
  async endCall(providerCallId: string): Promise<void> {
    console.log(`[PhoneCall] Ending call ${providerCallId}`);

    if (this.config.phoneProvider === "telnyx") {
      await this.endTelnyxCall(providerCallId);
    } else {
      await this.endTwilioCall(providerCallId);
    }
  }

  private async endTelnyxCall(callControlId: string): Promise<void> {
    if (!this.telnyx) {
      throw new Error("Telnyx client not initialized");
    }

    try {
      await this.telnyx.calls.hangup({
        call_control_id: callControlId,
      });
      console.log(`[PhoneCall] Telnyx call ${callControlId} ended`);
    } catch (error) {
      console.error("[PhoneCall] Telnyx hangup error:", error);
      throw error;
    }
  }

  private async endTwilioCall(callSid: string): Promise<void> {
    const auth = Buffer.from(
      `${this.config.phoneAccountSid}:${this.config.phoneAuthToken}`
    ).toString("base64");

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.phoneAccountSid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          Status: "completed",
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio hangup failed: ${error}`);
    }

    console.log(`[PhoneCall] Twilio call ${callSid} ended`);
  }

  /**
   * Parse inbound webhook data
   */
  parseInboundWebhook(
    provider: "telnyx" | "twilio",
    body: any
  ): InboundWebhookData {
    if (provider === "telnyx") {
      return this.parseTelnyxInboundWebhook(body);
    } else {
      return this.parseTwilioInboundWebhook(body);
    }
  }

  private parseTelnyxInboundWebhook(body: any): InboundWebhookData {
    const eventType = body?.data?.event_type || "";
    const payload = body?.data?.payload || {};

    let type: InboundWebhookData["type"] = "unknown";
    if (eventType === "call.initiated") {
      type = "call.initiated";
    } else if (eventType === "call.answered") {
      type = "call.answered";
    } else if (eventType === "call.hangup") {
      type = "call.hangup";
    }

    return {
      type,
      providerCallId: payload.call_control_id || "",
      from: payload.from || "",
      to: payload.to || "",
    };
  }

  private parseTwilioInboundWebhook(body: any): InboundWebhookData {
    const callStatus = body?.CallStatus || "";

    let type: InboundWebhookData["type"] = "unknown";
    if (callStatus === "ringing") {
      type = "call.initiated";
    } else if (callStatus === "in-progress") {
      type = "call.answered";
    } else if (callStatus === "completed") {
      type = "call.hangup";
    }

    return {
      type,
      providerCallId: body?.CallSid || "",
      from: body?.From || "",
      to: body?.To || "",
    };
  }

  /**
   * Parse speech result from gather webhook
   */
  parseSpeechResult(provider: "telnyx" | "twilio", body: any): SpeechResult {
    if (provider === "telnyx") {
      return this.parseTelnyxSpeechResult(body);
    } else {
      return this.parseTwilioSpeechResult(body);
    }
  }

  private parseTelnyxSpeechResult(body: any): SpeechResult {
    const payload = body?.data?.payload || {};

    // Telnyx returns transcription in gather events
    const transcript = payload?.digits || payload?.speech?.transcript || null;

    return {
      transcript,
      confidence: payload?.speech?.confidence,
    };
  }

  private parseTwilioSpeechResult(body: any): SpeechResult {
    // Twilio returns SpeechResult for <Gather input="speech">
    const transcript = body?.SpeechResult || body?.Digits || null;

    return {
      transcript,
      confidence: body?.Confidence ? parseFloat(body.Confidence) : undefined,
    };
  }

  /**
   * Parse call status webhook
   */
  parseStatusWebhook(provider: "telnyx" | "twilio", body: any): StatusResult {
    if (provider === "telnyx") {
      return this.parseTelnyxStatusWebhook(body);
    } else {
      return this.parseTwilioStatusWebhook(body);
    }
  }

  private parseTelnyxStatusWebhook(body: any): StatusResult {
    const eventType = body?.data?.event_type || "";

    const stateMap: Record<string, StatusResult["state"]> = {
      "call.initiated": "ringing",
      "call.answered": "answered",
      "call.hangup": "completed",
      "call.machine.detection.ended": "answered",
    };

    return {
      state: stateMap[eventType] || "completed",
    };
  }

  private parseTwilioStatusWebhook(body: any): StatusResult {
    const status = body?.CallStatus || "";

    const stateMap: Record<string, StatusResult["state"]> = {
      queued: "ringing",
      ringing: "ringing",
      "in-progress": "answered",
      completed: "completed",
      failed: "failed",
      busy: "busy",
      "no-answer": "no-answer",
    };

    return {
      state: stateMap[status] || "completed",
    };
  }

  /**
   * Generate TwiML for answering a call with a message and gathering input
   * Uses DTMF termination (press # when done) for better conversation flow
   */
  generateAnswerTwiML(message: string, gatherUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
  <Gather input="speech dtmf" action="${this.escapeXml(gatherUrl)}" finishOnKey="#" speechTimeout="3" maxSpeechTime="60" language="en-US">
    <Say voice="alice">Press pound when you're finished speaking.</Say>
  </Gather>
</Response>`;
  }

  /**
   * Generate TwiML for gathering speech input
   * Uses DTMF termination (press # when done) for better conversation flow
   */
  generateGatherTwiML(message: string, callbackUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
  <Gather input="speech dtmf" action="${this.escapeXml(callbackUrl)}" finishOnKey="#" speechTimeout="3" maxSpeechTime="60" language="en-US" />
</Response>`;
  }

  /**
   * Generate TwiML for waiting/holding
   */
  generateWaitTwiML(message: string, seconds: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
  <Pause length="${seconds}"/>
</Response>`;
  }

  /**
   * Generate TwiML for hanging up with a message
   */
  generateHangupTwiML(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
  }

  /**
   * Generate TwiML for holding/waiting with redirect
   * Used to keep call alive while Claude works
   */
  generateHoldTwiML(message: string, holdUrl: string, waitSeconds: number = 30): string {
    const sayPart = message
      ? `<Say voice="alice">${this.escapeXml(message)}</Say>\n  `
      : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayPart}<Pause length="${waitSeconds}"/>
  <Redirect>${this.escapeXml(holdUrl)}</Redirect>
</Response>`;
  }

  /**
   * Generate TwiML for speaking only (no gather)
   */
  generateSayTwiML(message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
</Response>`;
  }

  /**
   * Generate generic TwiML with message and optional gather
   */
  private generateTwiML(message: string, gatherUrl?: string): string {
    if (gatherUrl) {
      return this.generateGatherTwiML(message, gatherUrl);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${this.escapeXml(message)}</Say>
</Response>`;
  }

  /**
   * Text to Speech using OpenAI
   */
  async textToSpeech(text: string): Promise<Buffer> {
    const response = await this.openai.audio.speech.create({
      model: "tts-1",
      voice: this.config.ttsVoice as any,
      input: text,
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Speech to Text using OpenAI Whisper
   */
  async speechToText(audioBuffer: Buffer): Promise<string> {
    // Create a File-like object from the buffer
    const file = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });

    const response = await this.openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: "en",
    });

    return response.text;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }
}
