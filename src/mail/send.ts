import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { simpleParser, type AddressObject } from "mailparser";
import type { Config } from "../config.ts";
import { formatAddress, parseAddressList, type Address } from "./address.ts";
import type { Outgoing } from "./compose.ts";

/**
 * Outgoing mail through Bridge's SMTP. Bridge encrypts and sends it through
 * Proton, and files the copy in Sent itself, so nothing is appended here.
 */
export class Mailer {
  private transport: Transporter;
  private readonly domain: string;
  private readonly bridge: Config["bridge"];

  constructor(bridge: Config["bridge"], from: Address) {
    this.bridge = bridge;
    this.transport = this.create();
    this.domain = from.address.split("@")[1] ?? "localhost";
  }

  /** after the Bridge password changed (bridge.password is read again) */
  reload() {
    this.transport.close();
    this.transport = this.create();
  }

  private create(): Transporter {
    const bridge = this.bridge;
    return nodemailer.createTransport({
      host: bridge.host,
      port: bridge.smtpPort,
      secure: bridge.tls === "tls",
      requireTLS: bridge.tls === "starttls",
      ignoreTLS: bridge.tls === "none",
      auth: { user: bridge.user, pass: bridge.password },
      tls: bridge.verifyTls ? { rejectUnauthorized: true, servername: bridge.host } : { rejectUnauthorized: false },
      pool: true,
      maxConnections: 2,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000,
    });
  }

  async verify(): Promise<void> {
    await this.transport.verify();
  }

  async send(msg: Outgoing): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    const info = await this.transport.sendMail(toNodemailer(msg, this.domain));
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  /** the RFC 822 bytes of a message, for saving as a draft */
  async build(msg: Outgoing): Promise<Buffer> {
    // keepBcc: a draft has to remember its Bcc recipients
    const composer = new MailComposer({ ...toNodemailer(msg, this.domain), keepBcc: true } as Mail.Options);
    return composer.compile().build();
  }

  close() {
    this.transport.close();
  }
}

function toNodemailer(msg: Outgoing, domain: string): Mail.Options {
  const list = (l: Address[]) => (l.length ? l.map(formatAddress) : undefined);
  return {
    from: formatAddress(msg.from),
    to: list(msg.to),
    cc: list(msg.cc),
    bcc: list(msg.bcc),
    replyTo: msg.replyTo?.length ? msg.replyTo.map(formatAddress) : undefined,
    subject: msg.subject,
    text: msg.text,
    ...(msg.html && { html: msg.html }),
    ...(msg.inReplyTo && { inReplyTo: msg.inReplyTo }),
    ...(msg.references?.length && { references: msg.references }),
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType && { contentType: a.contentType }),
      ...(a.cid && { cid: a.cid }),
    })),
  };
}

/** a saved draft → an Outgoing we can edit or send */
export async function parseDraft(raw: Buffer, fallbackFrom: Address): Promise<Outgoing> {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const addrs = (a: AddressObject | AddressObject[] | undefined): Address[] => {
    if (!a) return [];
    const all = Array.isArray(a) ? a : [a];
    return parseAddressList(all.map((x) => x.text));
  };
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  return {
    from: addrs(p.from)[0] ?? fallbackFrom,
    to: addrs(p.to),
    cc: addrs(p.cc),
    bcc: addrs(p.bcc),
    replyTo: addrs(p.replyTo),
    subject: p.subject ?? "",
    text: p.text ?? "",
    ...(typeof p.html === "string" && p.html && { html: p.html }),
    ...(p.inReplyTo && { inReplyTo: p.inReplyTo }),
    references: refs,
    attachments: p.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      content: a.content,
      contentType: a.contentType,
      ...(a.cid && { cid: a.cid }),
    })),
  };
}
