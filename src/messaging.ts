/**
 * Messaging Manager
 * Handles SMS and WhatsApp messaging via Telnyx (primary) or Twilio
 */

export interface MessagingConfig {
  phoneProvider: "telnyx" | "twilio";
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;
}

export interface InboundMessageData {
  type: "sms" | "whatsapp";
  messageId: string;
  from: string;
  to: string;
  content: string;
  timestamp?: Date;
}

export interface MessageStatusData {
  messageId: string;
  status: "queued" | "sent" | "delivered" | "failed" | "read";
  errorCode?: string;
  errorMessage?: string;
}

export class MessagingManager {
  private config: MessagingConfig;

  constructor(config: MessagingConfig) {
    this.config = config;
  }

  /**
   * Normalize phone number to E.164 format (+1XXXXXXXXXX)
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters except leading +
    let cleaned = phone.replace(/[^\d+]/g, "");

    // If it doesn't start with +, assume US number and add +1
    if (!cleaned.startsWith("+")) {
      // Remove leading 1 if present (e.g., 1234567890 -> 234567890)
      if (cleaned.startsWith("1") && cleaned.length === 11) {
        cleaned = cleaned.substring(1);
      }
      // Add +1 for US numbers
      cleaned = "+1" + cleaned;
    }

    console.log(`[Messaging] Normalized phone: ${phone} -> ${cleaned}`);
    return cleaned;
  }

  /**
   * Send an SMS message
   * @returns The message ID from the provider
   */
  async sendSMS(to: string, message: string): Promise<string> {
    const normalizedTo = this.normalizePhoneNumber(to);
    console.log(`[Messaging] Sending SMS to ${normalizedTo}: ${message.slice(0, 50)}...`);

    if (this.config.phoneProvider === "telnyx") {
      return this.sendTelnyxSMS(normalizedTo, message);
    } else {
      return this.sendTwilioSMS(normalizedTo, message);
    }
  }

  private async sendTelnyxSMS(to: string, message: string): Promise<string> {
    const response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.phoneAuthToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.phoneNumber,
        to,
        text: message,
        type: "SMS",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx SMS failed: ${error}`);
    }

    const data = await response.json();
    const messageId = data.data?.id;
    console.log(`[Messaging] Telnyx SMS sent: ${messageId}`);
    return messageId;
  }

  private async sendTwilioSMS(to: string, message: string): Promise<string> {
    const auth = Buffer.from(
      `${this.config.phoneAccountSid}:${this.config.phoneAuthToken}`
    ).toString("base64");

    // Normalize the from number too
    const normalizedFrom = this.normalizePhoneNumber(this.config.phoneNumber);

    console.log(`[Messaging] Twilio SMS: From=${normalizedFrom}, To=${to}`);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.phoneAccountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: normalizedFrom,
          To: to,
          Body: message,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetail = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorDetail = `${errorJson.code}: ${errorJson.message}`;
      } catch {}
      console.error(`[Messaging] Twilio SMS failed: ${errorDetail}`);
      throw new Error(`Twilio SMS failed: ${errorDetail}`);
    }

    const data = await response.json();
    console.log(`[Messaging] Twilio SMS sent: ${data.sid}, status: ${data.status}`);
    return data.sid;
  }

  /**
   * Send a WhatsApp message
   * @returns The message ID from the provider
   */
  async sendWhatsApp(to: string, message: string): Promise<string> {
    const normalizedTo = this.normalizePhoneNumber(to);
    console.log(`[Messaging] Sending WhatsApp to ${normalizedTo}: ${message.slice(0, 50)}...`);

    if (this.config.phoneProvider === "telnyx") {
      return this.sendTelnyxWhatsApp(normalizedTo, message);
    } else {
      return this.sendTwilioWhatsApp(normalizedTo, message);
    }
  }

  private async sendTelnyxWhatsApp(to: string, message: string): Promise<string> {
    // Telnyx WhatsApp API
    // Note: Requires WhatsApp Business setup in Telnyx portal
    const response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.phoneAuthToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.phoneNumber,
        to,
        text: message,
        type: "whatsapp", // Telnyx uses messaging profile for WhatsApp
        messaging_profile_id: this.config.phoneAccountSid, // Use account SID as messaging profile
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx WhatsApp failed: ${error}`);
    }

    const data = await response.json();
    const messageId = data.data?.id;
    console.log(`[Messaging] Telnyx WhatsApp sent: ${messageId}`);
    return messageId;
  }

  private async sendTwilioWhatsApp(to: string, message: string): Promise<string> {
    const auth = Buffer.from(
      `${this.config.phoneAccountSid}:${this.config.phoneAuthToken}`
    ).toString("base64");

    // Twilio WhatsApp requires "whatsapp:" prefix
    const whatsappTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const whatsappFrom = this.config.phoneNumber.startsWith("whatsapp:")
      ? this.config.phoneNumber
      : `whatsapp:${this.config.phoneNumber}`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.phoneAccountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: whatsappFrom,
          To: whatsappTo,
          Body: message,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio WhatsApp failed: ${error}`);
    }

    const data = await response.json();
    console.log(`[Messaging] Twilio WhatsApp sent: ${data.sid}`);
    return data.sid;
  }

  /**
   * Parse an inbound message webhook
   */
  parseInboundMessage(provider: "telnyx" | "twilio", body: any): InboundMessageData | null {
    if (provider === "telnyx") {
      return this.parseTelnyxInboundMessage(body);
    } else {
      return this.parseTwilioInboundMessage(body);
    }
  }

  private parseTelnyxInboundMessage(body: any): InboundMessageData | null {
    const eventType = body?.data?.event_type || "";
    const payload = body?.data?.payload || {};

    // Handle both SMS and WhatsApp inbound
    if (eventType !== "message.received") {
      return null;
    }

    const type = payload.type === "whatsapp" ? "whatsapp" : "sms";

    return {
      type,
      messageId: payload.id || "",
      from: payload.from?.phone_number || payload.from || "",
      to: payload.to?.[0]?.phone_number || payload.to || "",
      content: payload.text || "",
      timestamp: payload.received_at ? new Date(payload.received_at) : new Date(),
    };
  }

  private parseTwilioInboundMessage(body: any): InboundMessageData | null {
    // Twilio sends form-encoded data for inbound messages
    if (!body?.Body) {
      return null;
    }

    // Detect WhatsApp from the "whatsapp:" prefix
    const from = body.From || "";
    const type = from.startsWith("whatsapp:") ? "whatsapp" : "sms";

    return {
      type,
      messageId: body.MessageSid || "",
      from: from.replace("whatsapp:", ""),
      to: (body.To || "").replace("whatsapp:", ""),
      content: body.Body || "",
      timestamp: new Date(),
    };
  }

  /**
   * Parse a message status webhook
   */
  parseStatusWebhook(provider: "telnyx" | "twilio", body: any): MessageStatusData | null {
    if (provider === "telnyx") {
      return this.parseTelnyxStatusWebhook(body);
    } else {
      return this.parseTwilioStatusWebhook(body);
    }
  }

  private parseTelnyxStatusWebhook(body: any): MessageStatusData | null {
    const eventType = body?.data?.event_type || "";
    const payload = body?.data?.payload || {};

    const statusMap: Record<string, MessageStatusData["status"]> = {
      "message.sent": "sent",
      "message.delivered": "delivered",
      "message.finalized": "delivered",
      "message.failed": "failed",
      // WhatsApp specific
      "whatsapp.message.sent": "sent",
      "whatsapp.message.delivered": "delivered",
      "whatsapp.message.read": "read",
      "whatsapp.message.failed": "failed",
    };

    const status = statusMap[eventType];
    if (!status) {
      return null;
    }

    return {
      messageId: payload.id || "",
      status,
      errorCode: payload.errors?.[0]?.code,
      errorMessage: payload.errors?.[0]?.detail,
    };
  }

  private parseTwilioStatusWebhook(body: any): MessageStatusData | null {
    const twilioStatus = body?.MessageStatus || body?.SmsStatus || "";

    const statusMap: Record<string, MessageStatusData["status"]> = {
      queued: "queued",
      sent: "sent",
      delivered: "delivered",
      failed: "failed",
      undelivered: "failed",
      read: "read",
    };

    const status = statusMap[twilioStatus];
    if (!status) {
      return null;
    }

    return {
      messageId: body.MessageSid || body.SmsSid || "",
      status,
      errorCode: body.ErrorCode,
      errorMessage: body.ErrorMessage,
    };
  }
}
