import type { ImapFlow, FetchMessageObject } from "imapflow";
import type { Readable } from "node:stream";
import type { Config } from "../config.ts";
import type { Address } from "./address.ts";
import { ImapPool } from "./imap.ts";
import { Mailboxes, type MailboxInfo } from "./mailboxes.ts";
import {
  analyzeStructure,
  cleanText,
  FLAG,
  formatId,
  groupIds,
  htmlToText,
  messageIdList,
  parseHeaders,
  parseId,
  snippetOf,
  summarize,
  truncate,
  type AttachmentInfo,
  type Summary,
} from "./message.ts";
import { toImapSearch, type SearchInput } from "./search.ts";
import type { Original } from "./compose.ts";

export interface SearchResult {
  mailbox: string;
  total: number;
  offset: number;
  messages: Summary[];
  /** has_attachment filtering only looks at the newest candidates */
  capped?: boolean;
}

export interface FullMessage extends Summary {
  replyTo?: string;
  bcc?: string;
  inReplyTo?: string;
  references: string[];
  listUnsubscribe?: string;
  labels?: string[];
  body: string;
  bodyFormat: "text" | "html";
  truncated: boolean;
  attachmentList: AttachmentInfo[];
}

/** text bodies past this are cut before conversion (huge newsletters, logs) */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** has_attachment needs the MIME structure, so it only checks this many candidates */
const ATTACHMENT_SCAN = 1500;
/** bulk operations refuse to touch more than this in one call */
export const BULK_LIMIT = 1000;

/**
 * Everything Facteur does with the mailbox, in terms a tool can call.
 * Tools stay thin: they validate input, call one method, format the result.
 */
export class MailService {
  readonly pool: ImapPool;
  readonly mailboxes = new Mailboxes();
  readonly identities: Address[];
  readonly account: string;

  constructor(cfg: Config) {
    this.pool = new ImapPool(cfg.bridge);
    this.identities = cfg.identities;
    this.account = cfg.bridge.user;
  }

  close() {
    return this.pool.close();
  }

  // ---------- reading ----------

  listMailboxes(withCounts = true): Promise<MailboxInfo[]> {
    return this.pool.withClient((c) => this.mailboxes.list(c, withCounts));
  }

  async resolve(name: string): Promise<string> {
    return this.pool.withClient((c) => this.mailboxes.resolve(c, name));
  }

  /** newest first */
  async search(mailboxName: string, input: SearchInput, opts: { limit: number; offset: number; preview: boolean }): Promise<SearchResult> {
    return this.pool.withClient(async (c) => {
      const mailbox = await this.mailboxes.resolve(c, mailboxName);
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        let uids = ((await c.search(toImapSearch(input), { uid: true })) || []).sort((a, b) => b - a);
        let capped = false;
        if (input.has_attachment !== undefined) {
          capped = uids.length > ATTACHMENT_SCAN;
          uids = await this.filterByAttachment(c, uids.slice(0, ATTACHMENT_SCAN), input.has_attachment);
        }
        const page = uids.slice(opts.offset, opts.offset + opts.limit);
        const messages = await this.summaries(c, mailbox, page, opts.preview);
        return { mailbox, total: uids.length, offset: opts.offset, messages, ...(capped && { capped }) };
      } finally {
        lock.release();
      }
    });
  }

  /** the UIDs a bulk action applies to: explicit ids, or every match of a search */
  async targets(ids: string[] | undefined, search: (SearchInput & { mailbox?: string }) | undefined, max: number): Promise<Map<string, number[]>> {
    if (ids?.length) {
      const grouped = new Map<string, number[]>();
      await this.pool.withClient(async (c) => {
        for (const [box, uids] of groupIds(ids)) grouped.set(await this.mailboxes.resolve(c, box), uids);
      });
      return grouped;
    }
    if (!search) throw new Error("give either ids or a search");
    const { mailbox: box = "inbox", ...input } = search;
    return this.pool.withClient(async (c) => {
      const mailbox = await this.mailboxes.resolve(c, box);
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        let uids = ((await c.search(toImapSearch(input), { uid: true })) || []).sort((a, b) => b - a);
        if (input.has_attachment !== undefined) uids = await this.filterByAttachment(c, uids.slice(0, ATTACHMENT_SCAN), input.has_attachment);
        if (uids.length > max) {
          throw new Error(`the search matches ${uids.length} messages, more than max=${max}. Narrow the search or raise max (up to ${BULK_LIMIT}).`);
        }
        return new Map(uids.length ? [[mailbox, uids]] : []);
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(id: string, opts: { format: "text" | "html"; maxChars: number; markRead: boolean; labels: boolean }): Promise<FullMessage> {
    const ref = parseId(id);
    return this.pool.withClient(async (c) => {
      const mailbox = await this.mailboxes.resolve(c, ref.mailbox);
      const lock = await c.getMailboxLock(mailbox, { readOnly: !opts.markRead });
      let msg: FullMessage;
      try {
        const m = await c.fetchOne(
          String(ref.uid),
          { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ["references", "list-unsubscribe", "reply-to"] },
          { uid: true },
        );
        if (!m) throw new Error(`no message ${id}: it may have been moved or deleted. Search again for its new id.`);
        const { text, attachments } = analyzeStructure(m.bodyStructure);
        let body = "";
        let bodyFormat: "text" | "html" = "text";
        if (opts.format === "html" && text.html) {
          body = await this.downloadText(c, ref.uid, text.html.part);
          bodyFormat = "html";
        } else if (text.plain) {
          body = cleanText(await this.downloadText(c, ref.uid, text.plain.part));
          // some senders put a stub in text/plain ("view this email in your browser")
          if (body.length < 200 && text.html) {
            const fromHtml = htmlToText(await this.downloadText(c, ref.uid, text.html.part));
            if (fromHtml.length > body.length * 2) body = fromHtml;
          }
        } else if (text.html) {
          body = htmlToText(await this.downloadText(c, ref.uid, text.html.part));
        }
        const cut = truncate(body, opts.maxChars);
        const headers = parseHeaders(m.headers);
        msg = {
          ...summarize(mailbox, m),
          ...(m.envelope?.replyTo?.length && { replyTo: m.envelope.replyTo.map((a) => a.address).filter(Boolean).join(", ") }),
          ...(m.envelope?.bcc?.length && { bcc: m.envelope.bcc.map((a) => a.address).filter(Boolean).join(", ") }),
          ...(m.envelope?.inReplyTo && { inReplyTo: m.envelope.inReplyTo }),
          references: messageIdList(headers.get("references")?.join(" ")),
          ...(headers.get("list-unsubscribe") && { listUnsubscribe: headers.get("list-unsubscribe")!.join(", ") }),
          body: cut.text,
          bodyFormat,
          truncated: cut.truncated,
          attachmentList: attachments,
        };
        if (opts.markRead && msg.unread) {
          await c.messageFlagsAdd(String(ref.uid), [FLAG.seen], { uid: true });
          msg.unread = false;
        }
      } finally {
        lock.release();
      }
      if (opts.labels && msg.messageId) msg.labels = await this.labelsOf(c, msg.messageId);
      return msg;
    });
  }

  /** the reply/forward view of a message */
  async original(id: string): Promise<Original & { attachments: AttachmentInfo[]; mailbox: string; uid: number }> {
    const msg = await this.getMessage(id, { format: "text", maxChars: 50_000, markRead: false, labels: false });
    const ref = parseId(id);
    return this.pool.withClient(async (c) => {
      const mailbox = await this.mailboxes.resolve(c, ref.mailbox);
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const m = await c.fetchOne(String(ref.uid), { uid: true, envelope: true }, { uid: true });
        if (!m || !m.envelope) throw new Error(`no message ${id}`);
        const addrs = (l?: { name?: string; address?: string }[]): Address[] =>
          (l ?? []).filter((a) => a.address).map((a) => (a.name ? { name: a.name, address: a.address! } : { address: a.address! }));
        return {
          mailbox,
          uid: ref.uid,
          ...(m.envelope.messageId && { messageId: m.envelope.messageId }),
          references: msg.references,
          subject: m.envelope.subject ?? "",
          ...(msg.date && { date: msg.date }),
          from: addrs(m.envelope.from),
          replyTo: addrs(m.envelope.replyTo),
          to: addrs(m.envelope.to),
          cc: addrs(m.envelope.cc),
          text: msg.body,
          attachments: msg.attachmentList,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * The whole conversation a message belongs to, oldest first, from All Mail.
   * Bridge's header search is slow (seconds), its subject search fast, so
   * candidates come from the subject and are linked locally through
   * Message-ID / In-Reply-To / References. A header search is the fallback.
   */
  async thread(id: string, opts: { maxChars: number; limit: number }): Promise<{ mailbox: string; messages: FullMessage[] }> {
    const seed = await this.getMessage(id, { format: "text", maxChars: 1, markRead: false, labels: false });
    const all = await this.resolve("all");
    const uids = await this.pool.withMailbox(
      all,
      async (c) => {
        const base = baseSubject(seed.subject);
        let candidates = base.length >= 3 ? ((await c.search({ subject: base }, { uid: true })) || []) : [];
        if (!candidates.length && seed.messageId) {
          const mid = seed.messageId;
          candidates = (await c.search({ or: [{ header: { "message-id": mid } }, { header: { "in-reply-to": mid } }, { header: { references: mid } }] }, { uid: true })) || [];
        }
        candidates = candidates.sort((a, b) => a - b).slice(-400);
        if (!candidates.length) return [];
        const nodes: { uid: number; links: string[] }[] = [];
        for await (const m of c.fetch(candidates.join(","), { uid: true, envelope: true, headers: ["references"] }, { uid: true })) {
          const links = [m.envelope?.messageId, m.envelope?.inReplyTo, ...messageIdList(parseHeaders(m.headers).get("references")?.join(" "))].filter(Boolean) as string[];
          nodes.push({ uid: m.uid, links });
        }
        // grow the conversation from the seed's ids until nothing new links in
        const known = new Set([seed.messageId, seed.inReplyTo, ...seed.references].filter(Boolean) as string[]);
        const inThread = new Set<number>();
        for (let changed = true; changed; ) {
          changed = false;
          for (const n of nodes) {
            if (inThread.has(n.uid) || !n.links.some((l) => known.has(l))) continue;
            inThread.add(n.uid);
            for (const l of n.links) known.add(l);
            changed = true;
          }
        }
        return [...inThread];
      },
      { readOnly: true },
    );
    if (!uids.length) return { mailbox: parseId(id).mailbox, messages: [await this.getMessage(id, { format: "text", maxChars: opts.maxChars, markRead: false, labels: false })] };
    const messages: FullMessage[] = [];
    for (const uid of uids.sort((a, b) => a - b).slice(-opts.limit)) {
      messages.push(await this.getMessage(formatId(all, uid), { format: "text", maxChars: opts.maxChars, markRead: false, labels: false }));
    }
    messages.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    return { mailbox: all, messages };
  }

  async downloadAttachment(id: string, part: string, maxBytes: number): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const ref = parseId(id);
    return this.pool.withClient(async (c) => {
      const mailbox = await this.mailboxes.resolve(c, ref.mailbox);
      const lock = await c.getMailboxLock(mailbox, { readOnly: true });
      try {
        const m = await c.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!m) throw new Error(`no message ${id}`);
        const att = analyzeStructure(m.bodyStructure).attachments.find((a) => a.part === part || a.filename === part);
        if (!att) {
          const list = analyzeStructure(m.bodyStructure).attachments.map((a) => `${a.part} (${a.filename})`).join(", ");
          throw new Error(`message ${id} has no attachment "${part}". Its attachments: ${list || "none"}`);
        }
        // base64 is ~4/3 of the file; refuse early instead of streaming 50 MB
        if (att.size * 0.75 > maxBytes) {
          throw new Error(`${att.filename} is about ${mb(att.size * 0.75)}, over the ${mb(maxBytes)} limit for attachments`);
        }
        const dl = await c.download(String(ref.uid), att.part, { uid: true });
        if (!("content" in dl) || !dl.content) throw new Error(`couldn't download ${att.filename}`);
        const data = await readAll(dl.content, maxBytes);
        return { filename: att.filename, contentType: att.contentType, data };
      } finally {
        lock.release();
      }
    });
  }

  /** every attachment of a message, for forwarding */
  async allAttachments(id: string, maxBytes: number): Promise<{ filename: string; contentType: string; data: Buffer; contentId?: string }[]> {
    const ref = parseId(id);
    return this.pool.withMailbox(
      await this.resolve(ref.mailbox),
      async (c) => {
        const m = await c.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!m) throw new Error(`no message ${id}`);
        const out = [];
        let total = 0;
        for (const att of analyzeStructure(m.bodyStructure).attachments) {
          const dl = await c.download(String(ref.uid), att.part, { uid: true });
          if (!("content" in dl) || !dl.content) continue;
          const data = await readAll(dl.content, maxBytes - total);
          total += data.length;
          out.push({ filename: att.filename, contentType: att.contentType, data, ...(att.contentId && { contentId: att.contentId }) });
        }
        return out;
      },
      { readOnly: true },
    );
  }

  // ---------- organizing ----------

  async setFlags(targets: Map<string, number[]>, change: { read?: boolean; starred?: boolean; answered?: boolean }): Promise<number> {
    let n = 0;
    for (const [mailbox, uids] of targets) {
      await this.pool.withMailbox(mailbox, async (c) => {
        const range = uids.join(",");
        const add: string[] = [];
        const remove: string[] = [];
        const pick = (v: boolean | undefined, flag: string) => (v === true ? add.push(flag) : v === false ? remove.push(flag) : 0);
        pick(change.read, FLAG.seen);
        pick(change.starred, FLAG.flagged);
        pick(change.answered, FLAG.answered);
        if (add.length) await c.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await c.messageFlagsRemove(range, remove, { uid: true });
      });
      n += uids.length;
    }
    return n;
  }

  /** move, returning the messages' new ids where Bridge reports them */
  async move(targets: Map<string, number[]>, destinationName: string): Promise<{ moved: number; destination: string; newIds: string[] }> {
    const destination = await this.resolve(destinationName);
    let moved = 0;
    const newIds: string[] = [];
    for (const [mailbox, uids] of targets) {
      if (mailbox === destination) continue;
      const res = await this.pool.withMailbox(mailbox, (c) => c.messageMove(uids.join(","), destination, { uid: true }));
      moved += uids.length;
      if (res && res.uidMap) for (const uid of uids) {
        const nu = res.uidMap.get(uid);
        if (nu) newIds.push(formatId(destination, nu));
      }
    }
    return { moved, destination, newIds };
  }

  /** labels are mailboxes under Labels/: copying a message there adds the label */
  async addLabel(targets: Map<string, number[]>, label: string, create: boolean): Promise<{ count: number; label: string }> {
    const path = await this.labelPath(label, create);
    let count = 0;
    for (const [mailbox, uids] of targets) {
      if (mailbox === path) continue;
      await this.pool.withMailbox(mailbox, (c) => c.messageCopy(uids.join(","), path, { uid: true }));
      count += uids.length;
    }
    return { count, label: path };
  }

  /** removing a label = deleting the message from Labels/<name> (the message itself stays) */
  async removeLabel(targets: Map<string, number[]>, label: string): Promise<{ count: number; label: string }> {
    const path = await this.labelPath(label, false);
    const messageIds = await this.messageIds(targets);
    if (!messageIds.length) return { count: 0, label: path };
    const count = await this.pool.withMailbox(path, async (c) => {
      const uids = new Set<number>();
      for (const mid of messageIds) for (const u of (await c.search({ header: { "message-id": mid } }, { uid: true })) || []) uids.add(u);
      if (uids.size) await c.messageDelete([...uids].join(","), { uid: true });
      return uids.size;
    });
    return { count, label: path };
  }

  /** to Trash, or gone for good with permanent (always permanent when already in Trash or Spam) */
  async delete(targets: Map<string, number[]>, permanent: boolean): Promise<{ trashed: number; deleted: number }> {
    const trash = await this.resolve("trash");
    const spam = await this.resolve("spam");
    let trashed = 0;
    let deleted = 0;
    for (const [mailbox, uids] of targets) {
      const range = uids.join(",");
      if (permanent || mailbox === trash || mailbox === spam) {
        await this.pool.withMailbox(mailbox, (c) => c.messageDelete(range, { uid: true }));
        deleted += uids.length;
      } else {
        await this.pool.withMailbox(mailbox, (c) => c.messageMove(range, trash, { uid: true }));
        trashed += uids.length;
      }
    }
    return { trashed, deleted };
  }

  async createMailbox(kind: "folder" | "label", name: string): Promise<string> {
    return this.pool.withClient(async (c) => {
      const path = await this.mailboxes.newPath(c, kind, name);
      await c.mailboxCreate(path);
      this.mailboxes.invalidate();
      return path;
    });
  }

  async renameMailbox(from: string, newName: string): Promise<{ from: string; to: string }> {
    return this.pool.withClient(async (c) => {
      const path = await this.mailboxes.resolve(c, from);
      if (await this.mailboxes.roleOfPath(c, path)) throw new Error(`${path} is a system mailbox and can't be renamed`);
      const kind = path.startsWith("Labels/") ? "label" : "folder";
      const to = await this.mailboxes.newPath(c, kind, newName);
      await c.mailboxRename(path, to);
      this.mailboxes.invalidate();
      return { from: path, to };
    });
  }

  async deleteMailbox(name: string): Promise<string> {
    return this.pool.withClient(async (c) => {
      const path = await this.mailboxes.resolve(c, name);
      if (await this.mailboxes.roleOfPath(c, path)) throw new Error(`${path} is a system mailbox and can't be deleted`);
      await c.mailboxDelete(path);
      this.mailboxes.invalidate();
      return path;
    });
  }

  // ---------- drafts ----------

  async appendDraft(raw: Buffer): Promise<string> {
    const drafts = await this.resolve("drafts");
    const res = await this.pool.withClient((c) => c.append(drafts, raw, [FLAG.draft, FLAG.seen]));
    if (res && res.uid) return formatId(drafts, res.uid);
    // no UIDPLUS answer: find it as the newest draft
    return this.pool.withMailbox(
      drafts,
      async (c) => {
        const uids = ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a);
        if (!uids[0]) throw new Error("the draft was saved but couldn't be found again");
        return formatId(drafts, uids[0]);
      },
      { readOnly: true },
    );
  }

  async rawMessage(id: string): Promise<Buffer> {
    const ref = parseId(id);
    return this.pool.withMailbox(
      await this.resolve(ref.mailbox),
      async (c) => {
        const m = await c.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
        if (!m || !m.source) throw new Error(`no message ${id}`);
        return m.source;
      },
      { readOnly: true },
    );
  }

  async assertDraft(id: string): Promise<void> {
    const { mailbox } = parseId(id);
    const [path, drafts] = [await this.resolve(mailbox), await this.resolve("drafts")];
    if (path !== drafts) throw new Error(`${id} isn't in Drafts. Only drafts can be edited or sent this way.`);
  }

  // ---------- helpers ----------

  private async summaries(c: ImapFlow, mailbox: string, uids: number[], preview: boolean): Promise<Summary[]> {
    if (!uids.length) return [];
    const fetched: FetchMessageObject[] = await c.fetchAll(
      uids.join(","),
      { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true },
      { uid: true },
    );
    const byUid = new Map(fetched.map((m) => [m.uid, m]));
    const out: Summary[] = [];
    for (const uid of uids) {
      const m = byUid.get(uid);
      if (!m) continue;
      const s = summarize(mailbox, m);
      if (preview) s.snippet = await this.preview(c, m).catch(() => undefined);
      out.push(s);
    }
    return out;
  }

  private async preview(c: ImapFlow, m: FetchMessageObject): Promise<string | undefined> {
    const { text } = analyzeStructure(m.bodyStructure);
    if (text.plain) {
      const t = cleanText(await this.downloadText(c, m.uid, text.plain.part, 3000));
      if (t.length > 40 || !text.html) return snippetOf(t);
    }
    if (text.html) return snippetOf(htmlToText(await this.downloadText(c, m.uid, text.html.part, 30_000)));
    return undefined;
  }

  private async downloadText(c: ImapFlow, uid: number, part: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
    const dl = await c.download(String(uid), part, { uid: true, maxBytes });
    if (!("content" in dl) || !dl.content) return "";
    return (await readAll(dl.content, maxBytes, true)).toString("utf8");
  }

  private async filterByAttachment(c: ImapFlow, uids: number[], want: boolean): Promise<number[]> {
    if (!uids.length) return [];
    const has = new Set<number>();
    for await (const m of c.fetch(uids.join(","), { uid: true, bodyStructure: true }, { uid: true })) {
      if (analyzeStructure(m.bodyStructure).attachments.some((a) => !a.inline)) has.add(m.uid);
    }
    return uids.filter((u) => has.has(u) === want);
  }

  private async messageIds(targets: Map<string, number[]>): Promise<string[]> {
    const out: string[] = [];
    for (const [mailbox, uids] of targets) {
      await this.pool.withMailbox(
        mailbox,
        async (c) => {
          for await (const m of c.fetch(uids.join(","), { uid: true, envelope: true }, { uid: true })) {
            if (m.envelope?.messageId) out.push(m.envelope.messageId);
          }
        },
        { readOnly: true },
      );
    }
    return out;
  }

  private async labelPath(label: string, create: boolean): Promise<string> {
    return this.pool.withClient(async (c) => {
      try {
        const path = await this.mailboxes.resolve(c, label.includes("/") ? label : `label:${label}`);
        if (!path.startsWith("Labels/")) throw new Error(`${path} is a folder, not a label`);
        return path;
      } catch (e) {
        if (!create || !(e as Error).message.startsWith("No mailbox")) throw e;
        const path = await this.mailboxes.newPath(c, "label", label);
        await c.mailboxCreate(path);
        this.mailboxes.invalidate();
        return path;
      }
    });
  }

  /** which labels carry this message (one quick search per label) */
  private async labelsOf(c: ImapFlow, messageId: string): Promise<string[]> {
    const labels = (await this.mailboxes.list(c, false)).filter((m) => m.kind === "label").slice(0, 40);
    const out: string[] = [];
    for (const l of labels) {
      const lock = await c.getMailboxLock(l.path, { readOnly: true });
      try {
        const hits = await c.search({ header: { "message-id": messageId } }, { uid: true });
        if (hits && hits.length) out.push(l.name);
      } finally {
        lock.release();
      }
    }
    return out;
  }
}

/** "Re: Fwd: TR: Hello" → "Hello" */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^((re|aw|sv|antw|réf?|fwd?|tr|wg|enc)(\[\d+\])?\s*:\s*)/i, "").replace(/^\[[^\]]{1,40}\]\s*/, "").trim();
  }
  return s === "(no subject)" ? "" : s;
}

async function readAll(stream: Readable, maxBytes: number, cut = false): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > maxBytes) {
      if (cut) {
        chunks.push(b.subarray(0, b.length - (size - maxBytes)));
        stream.destroy();
        break;
      }
      stream.destroy();
      throw new Error(`the file is over the ${mb(maxBytes)} limit`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
