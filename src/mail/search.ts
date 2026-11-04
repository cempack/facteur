import type { SearchObject } from "imapflow";

/** what a model can ask for when searching; every field is optional and they combine with AND */
export interface SearchInput {
  /** free text matched against headers and body */
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  unread?: boolean;
  starred?: boolean;
  answered?: boolean;
  /** received on/after: YYYY-MM-DD, ISO date, or relative ("7d", "2w", "3m", "1y", "today", "yesterday") */
  since?: string;
  /** received before (exclusive), same formats as since */
  before?: string;
  larger_than_kb?: number;
  smaller_than_kb?: number;
  /** only messages with (true) or without (false) attachments; checked after the IMAP search */
  has_attachment?: boolean;
}

/** parse "2026-11-04", an ISO timestamp, "today", "yesterday" or "7d"/"2w"/"3m"/"1y" (ago) */
export function parseDate(value: string, now = new Date()): Date {
  const v = value.trim().toLowerCase();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (v === "today") return startOfDay(now);
  if (v === "yesterday") return startOfDay(new Date(now.getTime() - 86_400_000));
  const rel = /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)( ago)?$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]![0];
    const d = startOfDay(now);
    if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - 7 * n);
    else if (unit === "m") d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`can't read the date "${value}": use YYYY-MM-DD, an ISO date, "today", "yesterday" or a span like "7d", "2w", "3m"`);
  }
  return d;
}

/** SearchInput → imapflow's search object (attachments are filtered later) */
export function toImapSearch(input: SearchInput, now = new Date()): SearchObject {
  const q: SearchObject = {};
  if (input.text) q.text = input.text;
  if (input.from) q.from = input.from;
  if (input.to) q.to = input.to;
  if (input.cc) q.cc = input.cc;
  if (input.subject) q.subject = input.subject;
  if (input.body) q.body = input.body;
  if (input.unread !== undefined) q.seen = !input.unread;
  if (input.starred !== undefined) q.flagged = input.starred;
  if (input.answered !== undefined) q.answered = input.answered;
  if (input.since) q.since = parseDate(input.since, now);
  if (input.before) q.before = parseDate(input.before, now);
  if (input.larger_than_kb) q.larger = Math.round(input.larger_than_kb * 1024);
  if (input.smaller_than_kb) q.smaller = Math.round(input.smaller_than_kb * 1024);
  // IMAP needs at least one key
  if (Object.keys(q).length === 0) q.all = true;
  // never list messages already marked for deletion
  q.deleted = false;
  return q;
}

export function describeSearch(input: SearchInput): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === "") continue;
    parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.length ? parts.join(" ") : "everything";
}
