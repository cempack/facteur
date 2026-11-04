import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Audit } from "../audit.ts";
import type { Config } from "../config.ts";
import type { CalendarService } from "../calendar/service.ts";
import type { DriveService } from "../drive/service.ts";
import type { Mailer } from "../mail/send.ts";
import type { MailService } from "../mail/service.ts";
import type { RevealStore } from "../pass/reveal.ts";
import type { PassService } from "../pass/service.ts";

export const SCOPES = {
  read: "mail.read",
  write: "mail.write",
  send: "mail.send",
  passRead: "pass.read",
  passReveal: "pass.reveal",
  passWrite: "pass.write",
  calendarRead: "calendar.read",
  driveRead: "drive.read",
  driveWrite: "drive.write",
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** scopes the consent page leaves unticked unless the owner ticks them */
export const OPT_IN_SCOPES: string[] = [SCOPES.passReveal];

/** what this server can grant, given which Proton services are set up */
export function availableScopes(cfg: Config): string[] {
  const out: string[] = [SCOPES.read, SCOPES.write, SCOPES.send];
  out.push(SCOPES.passRead, SCOPES.passReveal, SCOPES.passWrite, SCOPES.calendarRead);
  if (cfg.drive) out.push(SCOPES.driveRead, SCOPES.driveWrite);
  return out;
}

export interface ToolContext {
  mail: MailService;
  mailer: Mailer;
  cfg: Config;
  audit: Audit;
  pass?: PassService;
  reveals?: RevealStore;
  calendar?: CalendarService;
  drive?: DriveService;
  /** who is calling: an OAuth client id, "api-token" or "stdio" */
  client: string;
  scopes: Set<string>;
}

export type ToolResult = CallToolResult;

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/**
 * Wrap a handler so failures come back as a readable tool error (the model
 * can fix its call) instead of a protocol error, and are logged without
 * message content.
 */
export function safe<A>(name: string, ctx: ToolContext, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      ctx.audit.record({ client: ctx.client, tool: name, ok: false, error: message.slice(0, 300) });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
}

export function requireScope(ctx: ToolContext, scope: Scope, what: string) {
  if (!ctx.scopes.has(scope)) throw new Error(`this connection isn't allowed to ${what} (needs the ${scope} scope). Reconnect and grant it.`);
}

// ---------- shared schema pieces ----------

export const idsSchema = z
  .array(z.string())
  .min(1)
  .max(1000)
  .describe('Message ids as returned by search_emails, e.g. "INBOX/4521" (mailbox, slash, uid).');

export const searchFields = {
  text: z.string().optional().describe("Free text, matched against headers and body."),
  from: z.string().optional().describe("Sender address or name (substring)."),
  to: z.string().optional().describe("Recipient address or name (substring)."),
  cc: z.string().optional(),
  subject: z.string().optional().describe("Substring of the subject."),
  body: z.string().optional().describe("Substring of the body only."),
  unread: z.boolean().optional().describe("true: only unread; false: only read."),
  starred: z.boolean().optional(),
  answered: z.boolean().optional().describe("true: only messages I replied to."),
  since: z.string().optional().describe('Received on/after: "2026-11-01", "today", "yesterday", "7d", "2w", "3m", "1y".'),
  before: z.string().optional().describe("Received before (exclusive); same formats as since."),
  larger_than_kb: z.number().positive().optional(),
  smaller_than_kb: z.number().positive().optional(),
  has_attachment: z.boolean().optional().describe("Only messages with (true) or without (false) real attachments."),
};

export const mailboxArg = z
  .string()
  .default("inbox")
  .describe('Mailbox: "inbox", "sent", "drafts", "archive", "spam", "trash", "starred", "all" (every message), a folder name, "label:<name>", or a full path from list_mailboxes.');

export const searchSchema = z.object({ mailbox: mailboxArg, ...searchFields });

export const bodyFormat = z
  .enum(["markdown", "text", "html"])
  .default("markdown")
  .describe("How body is written: markdown (sent as HTML + plain text), text (plain only) or html.");

export const attachmentInput = z.object({
  filename: z.string(),
  content_base64: z.string().optional().describe("File content, base64."),
  text: z.string().optional().describe("Or: the content as UTF-8 text (for .txt, .csv, .ics, .md...)."),
  content_type: z.string().optional(),
});
