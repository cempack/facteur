import { marked } from "marked";
import { dedupe, formatAddress, parseAddressList, sameAddress, type Address } from "./address.ts";

export type BodyFormat = "markdown" | "text" | "html";

/** what goes out over SMTP (or into Drafts): nodemailer's shape, trimmed to what we use */
export interface Outgoing {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo?: Address[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutgoingAttachment[];
}

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
}

/** the parts of an existing message that a reply or forward needs */
export interface Original {
  messageId?: string;
  references: string[];
  subject: string;
  date?: string;
  from: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  text: string;
}

const STYLE = "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;";

/** body as given → plain text and (unless plain text was asked for) HTML */
export function renderBody(body: string, format: BodyFormat): { text: string; html?: string } {
  if (format === "text") return { text: body };
  if (format === "html") return { text: htmlishToText(body), html: wrapHtml(body) };
  const html = marked.parse(body, { async: false, gfm: true, breaks: true });
  return { text: body, html: wrapHtml(html) };
}

function wrapHtml(inner: string): string {
  return `<!doctype html><html><body><div style="${STYLE}">${inner}</div></body></html>`;
}

function htmlishToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "Re: Re: Hello" stays "Re: Hello"; French and German prefixes count too */
export function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
  const s = subject.trim() || "(no subject)";
  const already = prefix === "Re" ? /^(re|aw|sv|antw|réf?)\s*:/i : /^(fwd?|tr|wg|enc)\s*:/i;
  return already.test(s) ? s : `${prefix}: ${s}`;
}

/** which of my identities the original was addressed to, so the reply comes from the same one */
export function pickIdentity(identities: Address[], original: Pick<Original, "to" | "cc">, requested?: string): Address {
  if (requested) {
    const asked = parseAddressList(requested)[0];
    const match = identities.find((i) => sameAddress(i.address, asked?.address));
    if (!match) {
      throw new Error(`can't send from ${requested}: allowed senders are ${identities.map((i) => i.address).join(", ")}`);
    }
    return asked?.name ? { ...match, name: asked.name } : match;
  }
  for (const a of [...original.to, ...original.cc]) {
    const match = identities.find((i) => sameAddress(i.address, a.address));
    if (match) return match;
  }
  return identities[0]!;
}

export function resolveFrom(identities: Address[], requested?: string): Address {
  return pickIdentity(identities, { to: [], cc: [] }, requested);
}

/** recipients for a reply: Reply-To (or From), plus everyone else on reply-all, never myself */
export function replyRecipients(original: Original, identities: Address[], replyAll: boolean): { to: Address[]; cc: Address[] } {
  const mine = identities.map((i) => i.address);
  const fromMe = original.from.some((f) => mine.some((m) => sameAddress(m, f.address)));
  // replying to my own sent message means writing to its recipients again
  let to = fromMe ? original.to : original.replyTo.length ? original.replyTo : original.from;
  to = dedupe(to, mine);
  if (!replyAll) return { to, cc: [] };
  const cc = dedupe([...(fromMe ? [] : original.to), ...original.cc], [...mine, ...to.map((t) => t.address)]);
  return { to, cc };
}

export function quoteHeader(original: Original): string {
  const who = original.from[0] ? formatAddress(original.from[0]) : "someone";
  const when = original.date ? new Date(original.date).toUTCString().replace(" GMT", " UTC") : undefined;
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
}

/** the reply body with the original quoted under it */
export function buildReplyBody(reply: { text: string; html?: string }, original: Original): { text: string; html?: string } {
  const header = quoteHeader(original);
  const quoted = original.text
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
    .join("\n");
  const text = `${reply.text}\n\n${header}\n${quoted}\n`;
  if (!reply.html) return { text };
  const quoteHtml =
    `<div style="${STYLE}"><p>${escapeHtml(header)}</p>` +
    `<blockquote style="margin:0 0 0 .8ex; border-left:1px solid #ccc; padding-left:1ex;">` +
    escapeHtml(original.text).replace(/\n/g, "<br>") +
    `</blockquote></div>`;
  return { text, html: reply.html.replace(/<\/body><\/html>$/, `${quoteHtml}</body></html>`) };
}

export function buildForwardBody(note: { text: string; html?: string }, original: Original): { text: string; html?: string } {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${original.from.map(formatAddress).join(", ")}`,
    ...(original.date ? [`Date: ${new Date(original.date).toUTCString()}`] : []),
    `Subject: ${original.subject}`,
    `To: ${original.to.map(formatAddress).join(", ")}`,
    ...(original.cc.length ? [`Cc: ${original.cc.map(formatAddress).join(", ")}`] : []),
  ];
  const text = `${note.text ? note.text + "\n\n" : ""}${lines.join("\n")}\n\n${original.text}\n`;
  if (!note.html) return { text };
  const fwdHtml =
    `<div style="${STYLE}"><p>${lines.map(escapeHtml).join("<br>")}</p>` +
    `<div>${escapeHtml(original.text).replace(/\n/g, "<br>")}</div></div>`;
  return { text, html: note.html.replace(/<\/body><\/html>$/, `<br>${fwdHtml}</body></html>`) };
}

/** References for a reply: the original's chain plus its own Message-ID (capped, newest kept) */
export function replyReferences(original: Original): string[] {
  const refs = [...original.references];
  if (original.messageId && !refs.includes(original.messageId)) refs.push(original.messageId);
  // keep the root and the most recent ones, as RFC 5322 suggests for long chains
  return refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs;
}

export function decodeAttachment(a: { filename: string; content_base64?: string; text?: string; content_type?: string }): OutgoingAttachment {
  if (!a.filename.trim()) throw new Error("every attachment needs a filename");
  if (a.content_base64 === undefined && a.text === undefined) throw new Error(`attachment ${a.filename}: give content_base64 or text`);
  const content = a.content_base64 !== undefined ? Buffer.from(a.content_base64, "base64") : Buffer.from(a.text ?? "", "utf8");
  return { filename: a.filename.trim(), content, ...(a.content_type && { contentType: a.content_type }) };
}
