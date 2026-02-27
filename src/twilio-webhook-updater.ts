/**
 * Twilio Webhook Updater
 * Automatically updates Twilio webhook URLs when public URL changes
 */

export interface TwilioWebhookConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  whatsappNumber?: string;
}

export async function updateTwilioWebhooks(
  config: TwilioWebhookConfig,
  publicUrl: string
): Promise<void> {
  const { accountSid, authToken, phoneNumber } = config;

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;

  console.error(`[TwilioWebhooks] Updating webhooks to: ${publicUrl}`);

  try {
    // Step 1: Look up the phone number SID
    const lookupUrl = `${baseUrl}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`;

    const lookupResponse = await fetch(lookupUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!lookupResponse.ok) {
      const error = await lookupResponse.text();
      console.error(`[TwilioWebhooks] Failed to lookup phone number: ${error}`);
      return;
    }

    const lookupData = await lookupResponse.json() as { incoming_phone_numbers: Array<{ sid: string; phone_number: string }> };

    if (!lookupData.incoming_phone_numbers || lookupData.incoming_phone_numbers.length === 0) {
      console.error(`[TwilioWebhooks] Phone number ${phoneNumber} not found in account`);
      return;
    }

    const phoneNumberSid = lookupData.incoming_phone_numbers[0].sid;
    console.error(`[TwilioWebhooks] Found phone number SID: ${phoneNumberSid}`);

    // Step 2: Update the phone number webhooks
    const updateUrl = `${baseUrl}/IncomingPhoneNumbers/${phoneNumberSid}.json`;

    const webhookParams = new URLSearchParams({
      VoiceUrl: `${publicUrl}/webhook/twilio/inbound`,
      VoiceMethod: "POST",
      SmsUrl: `${publicUrl}/webhook/twilio/sms`,
      SmsMethod: "POST",
    });

    const updateResponse = await fetch(updateUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: webhookParams.toString(),
    });

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      console.error(`[TwilioWebhooks] Failed to update webhooks: ${error}`);
      return;
    }

    console.error(`[TwilioWebhooks] ✓ Voice webhook: ${publicUrl}/webhook/twilio/inbound`);
    console.error(`[TwilioWebhooks] ✓ SMS webhook: ${publicUrl}/webhook/twilio/sms`);

    // Step 3: Try to update WhatsApp sandbox webhook
    // Note: WhatsApp sandbox uses a different API - Messaging Service
    // For sandbox, this might not work programmatically, but we'll try
    await updateWhatsAppSandbox(config, publicUrl, auth);

  } catch (error) {
    console.error(`[TwilioWebhooks] Error updating webhooks:`, error);
  }
}

async function updateWhatsAppSandbox(
  config: TwilioWebhookConfig,
  publicUrl: string,
  auth: string
): Promise<void> {
  // WhatsApp sandbox webhook URL needs to be set manually in Twilio console
  // OR we can try updating via the Messaging Service API if configured

  // For now, just log the URL that needs to be set
  console.error(`[TwilioWebhooks] WhatsApp webhook (set manually in Twilio Console):`);
  console.error(`[TwilioWebhooks]   Sandbox: https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn`);
  console.error(`[TwilioWebhooks]   URL: ${publicUrl}/webhook/twilio/whatsapp`);

  // Try to update via API (may not work for sandbox)
  try {
    // Check if there's a messaging service we can update
    const servicesUrl = `https://messaging.twilio.com/v1/Services`;

    const servicesResponse = await fetch(servicesUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (servicesResponse.ok) {
      const servicesData = await servicesResponse.json() as { services: Array<{ sid: string; friendly_name: string }> };

      if (servicesData.services && servicesData.services.length > 0) {
        // Found messaging services - try to update the first one
        const serviceSid = servicesData.services[0].sid;

        const updateServiceUrl = `https://messaging.twilio.com/v1/Services/${serviceSid}`;
        const updateParams = new URLSearchParams({
          InboundRequestUrl: `${publicUrl}/webhook/twilio/whatsapp`,
          InboundMethod: "POST",
        });

        const updateResponse = await fetch(updateServiceUrl, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: updateParams.toString(),
        });

        if (updateResponse.ok) {
          console.error(`[TwilioWebhooks] ✓ WhatsApp webhook (via Messaging Service): ${publicUrl}/webhook/twilio/whatsapp`);
        }
      }
    }
  } catch (error) {
    // Silently ignore - WhatsApp sandbox needs manual configuration
  }
}
