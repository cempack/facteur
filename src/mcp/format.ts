import type { MailboxInfo } from "../mail/mailboxes.ts";
import type { Summary } from "../mail/message.ts";
import type { FullMessage, SearchResult } from "../mail/service.ts";

/**
 * Tool results are plain text laid out for a model to read: compact, one
 * message per block, ids first. Mail content is fenced as untrusted.
 */

const kb = (n?: number) => (n === undefined ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function localDate(iso?: string, timeZone?: string): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  // sv-SE prints "2026-11-04 15:30:00", the ISO-like order models read best
  return d.toLocaleString("sv-SE", { timeZone, hour12: false }).slice(0, 16);
}

function flags(s: Summary): string {
  const f = [s.unread ? "unread" : "", s.starred ? "starred" : "", s.answered ? "replied" : "", s.draft ? "draft" : "", s.attachments ? `${s.attachments} attachment${s.attachments > 1 ? "s" : ""}` : ""];
  return f.filter(Boolean).join(", ");
}

export function renderSummary(s: Summary, tz?: string): string {
  const lines = [`• ${s.id}  ${localDate(s.date, tz)}${flags(s) ? `  [${flags(s)}]` : ""}`, `  From: ${s.from || "?"}`, `  To: ${s.to || "?"}`];
  if (s.cc) lines.push(`  Cc: ${s.cc}`);
  lines.push(`  Subject: ${s.subject}`);
  if (s.snippet) lines.push(`  Preview: ${s.snippet}`);
  return lines.join("\n");
}

export function renderSearch(r: SearchResult, query: string, tz?: string): string {
  if (!r.total) return `No messages in ${r.mailbox} match ${query}.`;
  const from = r.offset + 1;
  const to = r.offset + r.messages.length;
  const head = `${r.total} message${r.total > 1 ? "s" : ""} in ${r.mailbox} match ${query}; showing ${from}-${to}, newest first.`;
  const more = to < r.total ? `\n\nMore: call again with offset=${to}.` : "";
  const capped = r.capped ? "\n(Attachment filtering only checked the newest 1500 matches.)" : "";
  return `${head}${capped}\n\n${r.messages.map((m) => renderSummary(m, tz)).join("\n\n")}${more}`;
}

export function renderMailboxes(list: MailboxInfo[]): string {
  const row = (m: MailboxInfo) => {
    const counts = m.total !== undefined ? `: ${m.total} message${m.total === 1 ? "" : "s"}${m.unread ? `, ${m.unread} unread` : ""}` : "";
    return `• ${m.path}${m.role && m.role !== m.path.toLowerCase() ? ` (${m.role})` : ""}${counts}`;
  };
  const section = (title: string, items: MailboxInfo[]) => (items.length ? `${title}\n${items.map(row).join("\n")}` : "");
  return [
    section("System", list.filter((m) => m.kind === "system")),
    section("Folders (a message is in one folder)", list.filter((m) => m.kind === "folder")),
    section("Labels (a message can have many)", list.filter((m) => m.kind === "label")),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function renderMessage(m: FullMessage, tz?: string): string {
  const lines = [
    `Id: ${m.id}`,
    `Date: ${localDate(m.date, tz)}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    ...(m.bcc ? [`Bcc: ${m.bcc}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${m.subject}`,
    ...(flags(m) ? [`Status: ${flags(m)}`] : []),
    ...(m.labels?.length ? [`Labels: ${m.labels.join(", ")}`] : []),
    ...(m.messageId ? [`Message-ID: ${m.messageId}`] : []),
    ...(m.listUnsubscribe ? [`List-Unsubscribe: ${m.listUnsubscribe}`] : []),
  ];
  const atts = m.attachmentList;
  if (atts.length) {
    lines.push(`Attachments (fetch with get_attachment, part=...):`);
    for (const a of atts) lines.push(`  - part ${a.part}: ${a.filename} (${a.contentType}, ~${kb(a.size * 0.75)}${a.inline ? ", inline" : ""})`);
  }
  const body = m.body.trim() || "(empty body)";
  lines.push("", "<email_body untrusted>", body, "</email_body>");
  if (m.truncated) lines.push(`(Body cut at ${m.body.length} characters; call again with a higher max_chars to read more.)`);
  return lines.join("\n");
}

export function renderThread(messages: FullMessage[], tz?: string): string {
  const head = `${messages.length} message${messages.length > 1 ? "s" : ""} in this conversation, oldest first.`;
  return [head, ...messages.map((m, i) => `──── ${i + 1}/${messages.length} ────\n${renderMessage(m, tz)}`)].join("\n\n");
}
