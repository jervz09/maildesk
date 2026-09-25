import nodemailer from "nodemailer";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import {
  SESv2Client,
  GetAccountCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";

export async function publicSmtpAddress(host, resolver = lookup) {
  const records = await resolver(host, { all: true, verbatim: true });
  if (
    !records.length ||
    records.some(({ address }) => ipaddr.process(address).range() !== "unicast")
  ) {
    throw new Error(
      "SMTP must use a public internet address; private and local addresses are blocked.",
    );
  }
  return records[0].address;
}
async function smtp(config) {
  // Resolve once and pin the checked IP while keeping certificate validation on the hostname.
  const host = await publicSmtpAddress(config.host);
  return nodemailer.createTransport({
    host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port === 587,
    tls: {
      servername: config.host,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
    auth: { user: config.username, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
function ses(config) {
  return new SESv2Client({
    region: config.region,
    maxAttempts: 1,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
    requestHandler: { connectionTimeout: 10000, requestTimeout: 20000 },
  });
}
export const providers = {
  async verify(kind, config) {
    if (kind !== "ses") {
      const transport = await smtp(config);
      try {
        await transport.verify();
        return {
          ready: true,
          summary:
            "SMTP authentication and TLS connection verified. Send a test to check sender permission.",
        };
      } finally {
        transport.close();
      }
    }
    const client = ses(config);
    try {
      const account = await client.send(new GetAccountCommand({}));
      let identity;
      try {
        identity = await client.send(
          new GetEmailIdentityCommand({ EmailIdentity: config.from }),
        );
      } catch (error) {
        if (error.name !== "NotFoundException") throw error;
        identity = await client.send(
          new GetEmailIdentityCommand({
            EmailIdentity: config.from.split("@")[1],
          }),
        );
      }
      const verified = identity.VerifiedForSendingStatus === true;
      const production = account.ProductionAccessEnabled === true;
      const ready = verified && production && account.SendingEnabled === true;
      return {
        ready,
        production,
        verified,
        quota: account.SendQuota,
        summary: ready
          ? "SES sender and production access verified."
          : "SES needs a verified sender, production access, and sending enabled before campaigns can start.",
      };
    } finally {
      client.destroy();
    }
  },
  async send(kind, config, message) {
    if (kind !== "ses") {
      const transport = await smtp(config);
      try {
        const result = await transport.sendMail(smtpMessage(config, message));
        if (!result.accepted?.length)
          throw Object.assign(new Error("Recipient rejected"), {
            definitive: true,
          });
        return result.messageId;
      } finally {
        transport.close();
      }
    }
    const client = ses(config);
    try {
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: `${config.fromName} <${config.from}>`,
          Destination: { ToAddresses: [message.to] },
          ...(config.replyTo ? { ReplyToAddresses: [config.replyTo] } : {}),
          ...(config.configurationSet
            ? { ConfigurationSetName: config.configurationSet }
            : {}),
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: sesBody(message),
              Headers: [
                { Name: "List-Unsubscribe", Value: `<${message.unsubscribe}>` },
                {
                  Name: "List-Unsubscribe-Post",
                  Value: "List-Unsubscribe=One-Click",
                },
              ],
            },
          },
        }),
      );
      return result.MessageId;
    } finally {
      client.destroy();
    }
  },
};
export function failedDelivery(error) {
  // A network timeout may happen after acceptance. Never automatically retry it.
  const definitive =
    error.definitive ||
    (error.responseCode >= 400 && error.responseCode < 600) ||
    (error.$metadata?.httpStatusCode >= 400 &&
      error.$metadata?.httpStatusCode < 500);
  return {
    status: definitive ? "failed" : "uncertain",
    message: definitive
      ? "Provider rejected the message. Check credentials, sender, quota, and recipient."
      : "Delivery outcome is unknown. Check your provider before sending again.",
  };
}

export function sesBody(message) {
  return {
    Text: { Data: message.text, Charset: "UTF-8" },
    ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
  };
}

export function smtpMessage(config, message) {
  return {
    from: { name: config.fromName, address: config.from },
    to: message.to,
    replyTo: config.replyTo || undefined,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    headers: {
      "List-Unsubscribe": `<${message.unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
