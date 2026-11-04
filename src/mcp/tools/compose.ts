import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatAddress, parseAddressList, type Address } from "../../mail/address.ts";
import {
  buildForwardBody,
  buildReplyBody,
  decodeAttachment,
  pickIdentity,
  prefixSubject,
  renderBody,
  replyRecipients,
  replyReferences,
  resolveFrom,
  type Outgoing,
  type OutgoingAttachment,
} from "../../mail/compose.ts";
import { parseId } from "../../mail/message.ts";
import { parseDraft } from "../../mail/send.ts";
import { attachmentInput, bodyFormat, requireScope, safe, SCOPES, text, type ToolContext } from "../context.ts";

const recipients = z.union([z.string(), z.array(z.string())]).describe('Addresses: "a@b.com", "Name <a@b.com>", or a list.');

const SENDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const DRAFTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** 25 MB is Proton's limit for a whole message */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

function addresses(v: string | string[] | undefined, field: string): Address[] {
  if (v === undefined) return [];
  const list = parseAddressList(v);
  const given = (Array.isArray(v) ? v : v.split(",")).filter((s) => s.trim()).length;
  if (list.length < given) throw new Error(`${field}: couldn't read every address in ${JSON.stringify(v)}`);
  return list;
}

function checkSize(msg: Outgoing) {
  const size = msg.attachments.reduce((n, a) => n + a.content.length, 0) + msg.text.length + (msg.html?.length ?? 0);
  if (size * 1.37 > MAX_MESSAGE_BYTES) throw new Error(`the message would be about ${(size * 1.37 / 1024 / 1024).toFixed(1)} MB, over Proton's 25 MB limit`);
}

function describe(msg: Outgoing): string {
  const lines = [`From: ${formatAddress(msg.from)}`, `To: ${msg.to.map(formatAddress).join(", ") || "(nobody yet)"}`];
  if (msg.cc.length) lines.push(`Cc: ${msg.cc.map(formatAddress).join(", ")}`);
  if (msg.bcc.length) lines.push(`Bcc: ${msg.bcc.map(formatAddress).join(", ")}`);
  lines.push(`Subject: ${msg.subject}`);
  if (msg.attachments.length) lines.push(`Attachments: ${msg.attachments.map((a) => a.filename).join(", ")}`);
  return lines.join("\n");
}

export function registerComposeTools(server: McpServer, ctx: ToolContext) {
  const canSend = ctx.scopes.has(SCOPES.send);
  const canWrite = ctx.scopes.has(SCOPES.write);
  const ids = ctx.cfg.identities;
  const senders = ids.map((i) => i.address).join(", ");

  const deliver = async (tool: string, msg: Outgoing, extra: Record<string, unknown> = {}) => {
    if (!msg.to.length && !msg.cc.length && !msg.bcc.length) throw new Error("no recipients");
    checkSize(msg);
    const r = await ctx.mailer.send(msg);
    ctx.audit.record({
      client: ctx.client,
      tool,
      ok: true,
      from: msg.from.address,
      to: msg.to.map((a) => a.address),
      cc: msg.cc.map((a) => a.address),
      bcc: msg.bcc.map((a) => a.address),
      subject: msg.subject,
      attachments: msg.attachments.length,
      messageId: r.messageId,
      ...extra,
    });
    const rejected = r.rejected.length ? `\nRejected by the server: ${r.rejected.join(", ")}` : "";
    return `Sent. It's in Sent now.\n${describe(msg)}\nMessage-ID: ${r.messageId}${rejected}`;
  };

  const saveDraft = async (tool: string, msg: Outgoing, replaces?: string) => {
    checkSize(msg);
    const id = await ctx.mail.appendDraft(await ctx.mailer.build(msg));
    if (replaces) await ctx.mail.delete(new Map([[await ctx.mail.resolve(parseId(replaces).mailbox), [parseId(replaces).uid]]]), true);
    ctx.audit.record({ client: ctx.client, tool, ok: true, draft: id, to: msg.to.map((a) => a.address), subject: msg.subject });
    return `Draft saved as ${id}. It shows up in Proton's Drafts; send it with send_draft or from any Proton app.\n${describe(msg)}`;
  };

  const composeFields = {
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: z.string().default(""),
    body: z.string().describe("The message. Markdown by default (see format)."),
    format: bodyFormat,
    from: z.string().optional().describe(`Send from this address; one of: ${senders}. Defaults to ${ids[0]!.address}.`),
    reply_to: recipients.optional().describe("Where replies should go, if not the sender."),
    attachments: z.array(attachmentInput).max(20).optional(),
  };

  const build = (a: {
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    body: string;
    format: "markdown" | "text" | "html";
    from?: string;
    reply_to?: string | string[];
    attachments?: z.infer<typeof attachmentInput>[];
  }): Outgoing => ({
    from: resolveFrom(ids, a.from),
    to: addresses(a.to, "to"),
    cc: addresses(a.cc, "cc"),
    bcc: addresses(a.bcc, "bcc"),
    replyTo: addresses(a.reply_to, "reply_to"),
    subject: a.subject,
    ...renderBody(a.body, a.format),
    attachments: (a.attachments ?? []).map(decodeAttachment),
  });

  if (canSend) {
    server.registerTool(
      "send_email",
      {
        title: "Send an email",
        description: "Write and send a new email right away. To let the user review first, use create_draft instead.",
        inputSchema: z.object(composeFields),
        annotations: SENDS,
      },
      safe("send_email", ctx, async (a) => {
        const msg = build(a);
        if (!msg.subject.trim()) throw new Error("subject is empty; set one (or create a draft)");
        return text(await deliver("send_email", msg));
      }),
    );
  }

  if (canSend || canWrite) {
    server.registerTool(
      "reply_email",
      {
        title: "Reply to an email",
        description:
          "Reply to a message: recipients, subject, threading headers and the quoted original are filled in. " +
          "It's sent from the address the original was sent to. save_as_draft=true saves it to Drafts instead of sending.",
        inputSchema: z.object({
          id: z.string().describe("The message to reply to."),
          body: z.string().describe("Your reply (the original is quoted below it automatically)."),
          format: bodyFormat,
          reply_all: z.boolean().default(false),
          cc: recipients.optional().describe("Extra Cc recipients."),
          bcc: recipients.optional(),
          from: z.string().optional().describe(`Override the sender; one of: ${senders}.`),
          quote: z.boolean().default(true).describe("Quote the original under the reply."),
          attachments: z.array(attachmentInput).max(20).optional(),
          save_as_draft: z.boolean().default(!canSend),
        }),
        annotations: canSend ? SENDS : DRAFTS,
      },
      safe("reply_email", ctx, async (a) => {
        requireScope(ctx, a.save_as_draft ? SCOPES.write : SCOPES.send, a.save_as_draft ? "save drafts" : "send mail");
        const orig = await ctx.mail.original(a.id);
        const rcpt = replyRecipients(orig, ids, a.reply_all);
        const own = renderBody(a.body, a.format);
        const body = a.quote ? buildReplyBody(own, orig) : own;
        const msg: Outgoing = {
          from: pickIdentity(ids, orig, a.from),
          to: rcpt.to,
          cc: [...rcpt.cc, ...addresses(a.cc, "cc")],
          bcc: addresses(a.bcc, "bcc"),
          subject: prefixSubject(orig.subject, "Re"),
          ...body,
          ...(orig.messageId && { inReplyTo: orig.messageId }),
          references: replyReferences(orig),
          attachments: (a.attachments ?? []).map(decodeAttachment),
        };
        if (a.save_as_draft) return text(await saveDraft("reply_email", msg));
        const out = await deliver("reply_email", msg, { inReplyTo: a.id });
        await ctx.mail.setFlags(new Map([[orig.mailbox, [orig.uid]]]), { answered: true }).catch(() => undefined);
        return text(out);
      }),
    );

    server.registerTool(
      "forward_email",
      {
        title: "Forward an email",
        description: "Forward a message (with its attachments by default) to new recipients, with an optional note above it.",
        inputSchema: z.object({
          id: z.string().describe("The message to forward."),
          to: recipients,
          cc: recipients.optional(),
          bcc: recipients.optional(),
          body: z.string().default("").describe("Optional note above the forwarded message."),
          format: bodyFormat,
          from: z.string().optional().describe(`Send from; one of: ${senders}.`),
          include_attachments: z.boolean().default(true),
          save_as_draft: z.boolean().default(!canSend),
        }),
        annotations: canSend ? SENDS : DRAFTS,
      },
      safe("forward_email", ctx, async (a) => {
        requireScope(ctx, a.save_as_draft ? SCOPES.write : SCOPES.send, a.save_as_draft ? "save drafts" : "send mail");
        const orig = await ctx.mail.original(a.id);
        const note = a.body ? renderBody(a.body, a.format) : { text: "", html: a.format === "text" ? undefined : renderBody("", a.format).html };
        let attachments: OutgoingAttachment[] = [];
        if (a.include_attachments && orig.attachments.length) {
          attachments = (await ctx.mail.allAttachments(a.id, MAX_MESSAGE_BYTES)).map((f) => ({
            filename: f.filename,
            content: f.data,
            contentType: f.contentType,
            ...(f.contentId && { cid: f.contentId }),
          }));
        }
        const msg: Outgoing = {
          from: pickIdentity(ids, orig, a.from),
          to: addresses(a.to, "to"),
          cc: addresses(a.cc, "cc"),
          bcc: addresses(a.bcc, "bcc"),
          subject: prefixSubject(orig.subject, "Fwd"),
          ...buildForwardBody(note, orig),
          attachments,
        };
        if (a.save_as_draft) return text(await saveDraft("forward_email", msg));
        return text(await deliver("forward_email", msg, { forwarded: a.id }));
      }),
    );
  }

  if (canWrite) {
    server.registerTool(
      "create_draft",
      {
        title: "Create a draft",
        description: "Save a new email to Drafts without sending it. It syncs to Proton, so it can be reviewed and sent from any Proton app.",
        inputSchema: z.object(composeFields),
        annotations: DRAFTS,
      },
      safe("create_draft", ctx, async (a) => text(await saveDraft("create_draft", build(a)))),
    );

    server.registerTool(
      "update_draft",
      {
        title: "Edit a draft",
        description: "Change a saved draft. Only the fields you give change; body replaces the whole text. The draft gets a new id (returned).",
        inputSchema: z.object({
          id: z.string().describe('Draft id, e.g. "Drafts/12".'),
          to: recipients.optional(),
          cc: recipients.optional(),
          bcc: recipients.optional(),
          subject: z.string().optional(),
          body: z.string().optional(),
          format: bodyFormat,
          from: z.string().optional(),
          add_attachments: z.array(attachmentInput).max(20).optional(),
          remove_attachments: z.array(z.string()).optional().describe("Filenames to drop."),
        }),
        annotations: DRAFTS,
      },
      safe("update_draft", ctx, async (a) => {
        await ctx.mail.assertDraft(a.id);
        const cur = await parseDraft(await ctx.mail.rawMessage(a.id), ids[0]!);
        const drop = new Set(a.remove_attachments ?? []);
        const msg: Outgoing = {
          ...cur,
          ...(a.from && { from: resolveFrom(ids, a.from) }),
          ...(a.to !== undefined && { to: addresses(a.to, "to") }),
          ...(a.cc !== undefined && { cc: addresses(a.cc, "cc") }),
          ...(a.bcc !== undefined && { bcc: addresses(a.bcc, "bcc") }),
          ...(a.subject !== undefined && { subject: a.subject }),
          ...(a.body !== undefined && { html: undefined, ...renderBody(a.body, a.format) }),
          attachments: [...cur.attachments.filter((x) => !drop.has(x.filename)), ...(a.add_attachments ?? []).map(decodeAttachment)],
        };
        return text(await saveDraft("update_draft", msg, a.id));
      }),
    );
  }

  if (canSend) {
    server.registerTool(
      "send_draft",
      {
        title: "Send a draft",
        description: "Send a saved draft as it is, then remove it from Drafts.",
        inputSchema: z.object({ id: z.string().describe('Draft id, e.g. "Drafts/12".') }),
        annotations: SENDS,
      },
      safe("send_draft", ctx, async ({ id }) => {
        await ctx.mail.assertDraft(id);
        const msg = await parseDraft(await ctx.mail.rawMessage(id), ids[0]!);
        // a draft can only go out from one of my addresses
        msg.from = resolveFrom(ids, msg.from.address);
        const out = await deliver("send_draft", msg, { draft: id });
        const ref = parseId(id);
        await ctx.mail.delete(new Map([[await ctx.mail.resolve(ref.mailbox), [ref.uid]]]), true).catch(() => undefined);
        return text(out);
      }),
    );
  }
}
