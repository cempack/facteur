import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import { convert } from "html-to-text";

/**
 * Message ids handed to the model are "<mailbox>/<uid>", e.g. "INBOX/4521"
 * or "Folders/Work/88". The uid is everything after the last slash.
 */
export interface MessageRef {
  mailbox: string;
  uid: number;
}

export function formatId(mailbox: string, uid: number): string {
  return `${mailbox}/${uid}`;
}

export function parseId(id: string): MessageRef {
  const i = id.lastIndexOf("/");
  const uid = Number(id.slice(i + 1));
  if (i <= 0 || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(`"${id}" isn't a message id. Ids look like "INBOX/4521": the mailbox, a slash, then the uid.`);
  }
  return { mailbox: id.slice(0, i), uid };
}

/** group ids by mailbox, keeping order */
export function groupIds(ids: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const id of ids) {
    const { mailbox, uid } = parseId(id);
    const list = out.get(mailbox) ?? [];
    if (!list.includes(uid)) list.push(uid);
    out.set(mailbox, list);
  }
  return out;
}

export interface AttachmentInfo {
  part: string;
  filename: string;
  contentType: string;
  /** encoded size on the wire; the decoded file is ~3/4 of this for base64 */
  size: number;
  inline: boolean;
  contentId?: string;
}

export interface TextParts {
  plain?: { part: string; size: number };
  html?: { part: string; size: number };
}

const partOf = (node: MessageStructureObject) => node.part ?? "1";

function filenameOf(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name;
}

function isAttachment(node: MessageStructureObject): boolean {
  const type = node.type.toLowerCase();
  if (type.startsWith("multipart/")) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  if (type === "message/rfc822") return true;
  // inline images and other non-text parts with a name are attachments too
  return !type.startsWith("text/") && Boolean(filenameOf(node) || node.id);
}

/** walk the MIME tree: first readable text/plain and text/html, plus every attachment */
export function analyzeStructure(root: MessageStructureObject | undefined): { text: TextParts; attachments: AttachmentInfo[] } {
  const text: TextParts = {};
  const attachments: AttachmentInfo[] = [];
  if (!root) return { text, attachments };

  const visit = (node: MessageStructureObject) => {
    const type = node.type.toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of node.childNodes ?? []) visit(child);
      return;
    }
    if (isAttachment(node)) {
      attachments.push({
        part: partOf(node),
        filename: filenameOf(node) ?? `part-${partOf(node)}${guessExt(type)}`,
        contentType: type,
        size: node.size ?? 0,
        inline: node.disposition?.toLowerCase() === "inline" || (!node.disposition && Boolean(node.id)),
        ...(node.id && { contentId: node.id.replace(/^<|>$/g, "") }),
      });
      return;
    }
    if (type === "text/plain" && !text.plain) text.plain = { part: partOf(node), size: node.size ?? 0 };
    else if (type === "text/html" && !text.html) text.html = { part: partOf(node), size: node.size ?? 0 };
  };
  visit(root);
  return { text, attachments };
}

function guessExt(type: string): string {
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "text/calendar": ".ics",
    "message/rfc822": ".eml",
  };
  return map[type] ?? "";
}

/** emails as readable text: links kept as "text (url)", images by alt text, no layout tables */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, linkBrackets: [" (", ")"], ignoreHref: false } },
      { selector: "img", format: "skip" },
      { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "style", format: "skip" },
      { selector: "head", format: "skip" },
    ],
  })
    .replace(/[​-‍⁠﻿͏­]+/g, "") // invisible preheader padding
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[​-‍⁠﻿͏­]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function snippetOf(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max).trimEnd(), truncated: true };
}

/** unfolded header lines from a raw header block, lower-cased names → values */
export function parseHeaders(raw: Buffer | string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw) return out;
  const unfolded = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const list = out.get(name) ?? [];
    list.push(line.slice(i + 1).trim());
    out.set(name, list);
  }
  return out;
}

/** "<a@b> <c@d>" → ["<a@b>", "<c@d>"] */
export function messageIdList(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

export const FLAG = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
  deleted: "\\Deleted",
} as const;

export interface Summary {
  id: string;
  date?: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  unread: boolean;
  starred: boolean;
  answered: boolean;
  draft: boolean;
  attachments: number;
  size?: number;
  snippet?: string;
  messageId?: string;
}

export function isoDate(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function summarize(mailbox: string, m: FetchMessageObject): Summary {
  const env = m.envelope;
  const flags = m.flags ?? new Set<string>();
  const { attachments } = analyzeStructure(m.bodyStructure);
  const addr = (l?: { name?: string; address?: string }[]) =>
    (l ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""))).filter(Boolean).join(", ");
  return {
    id: formatId(mailbox, m.uid),
    date: isoDate(env?.date) ?? isoDate(m.internalDate),
    from: addr(env?.from),
    to: addr(env?.to),
    ...(env?.cc?.length && { cc: addr(env.cc) }),
    subject: env?.subject || "(no subject)",
    unread: !flags.has(FLAG.seen),
    starred: flags.has(FLAG.flagged),
    answered: flags.has(FLAG.answered),
    draft: flags.has(FLAG.draft),
    attachments: attachments.filter((a) => !a.inline).length,
    ...(m.size !== undefined && { size: m.size }),
    ...(env?.messageId && { messageId: env.messageId }),
  };
}
