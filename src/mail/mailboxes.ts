import type { ImapFlow, ListResponse } from "imapflow";

/**
 * Proton Mail Bridge exposes:
 *   INBOX, Drafts, Sent, Starred, Archive, Spam, Trash, All Mail (special-use)
 *   Folders/<name>   user folders (a message lives in exactly one folder)
 *   Labels/<name>    labels (a message can carry many; copying adds a label,
 *                    deleting from Labels/<name> removes just that label)
 */
export const ROLES = ["inbox", "drafts", "sent", "starred", "archive", "spam", "trash", "all"] as const;
export type Role = (typeof ROLES)[number];

const SPECIAL_USE: Record<string, Role> = {
  "\\Inbox": "inbox",
  "\\Drafts": "drafts",
  "\\Sent": "sent",
  "\\Flagged": "starred",
  "\\Archive": "archive",
  "\\Junk": "spam",
  "\\Trash": "trash",
  "\\All": "all",
};

/** names Bridge uses, for servers that don't advertise SPECIAL-USE */
const FALLBACK_PATH: Record<Role, string> = {
  inbox: "INBOX",
  drafts: "Drafts",
  sent: "Sent",
  starred: "Starred",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
  all: "All Mail",
};

export const FOLDER_ROOT = "Folders";
export const LABEL_ROOT = "Labels";

export interface MailboxInfo {
  path: string;
  name: string;
  role?: Role;
  kind: "system" | "folder" | "label";
  total?: number;
  unread?: number;
}

export class Mailboxes {
  private cache?: { at: number; list: ListResponse[] };

  /** list every mailbox, optionally with message/unread counts */
  async list(client: ImapFlow, withCounts: boolean): Promise<MailboxInfo[]> {
    const list = withCounts ? await client.list({ statusQuery: { messages: true, unseen: true } }) : await this.raw(client);
    if (withCounts) this.cache = { at: Date.now(), list };
    return list
      .filter((m) => !m.flags.has("\\Noselect") && !m.flags.has("\\NonExistent"))
      .map((m) => {
        const role = roleOf(m);
        const kind = role ? "system" : m.path.startsWith(LABEL_ROOT + m.delimiter) ? "label" : m.path.startsWith(FOLDER_ROOT + m.delimiter) ? "folder" : "system";
        return {
          path: m.path,
          name: kind === "system" ? m.path : m.path.slice(m.path.indexOf(m.delimiter) + 1),
          ...(role && { role }),
          kind,
          ...(m.status?.messages !== undefined && { total: m.status.messages }),
          ...(m.status?.unseen !== undefined && { unread: m.status.unseen }),
        } satisfies MailboxInfo;
      })
      .sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  }

  /**
   * Turn what a model wrote ("inbox", "Archive", "Folders/Work", "Work",
   * "label:Receipts", "Receipts") into a real mailbox path, or explain
   * what exists.
   */
  async resolve(client: ImapFlow, name: string): Promise<string> {
    const wanted = name.trim();
    const list = await this.raw(client);
    const exact = list.find((m) => m.path === wanted);
    if (exact) return exact.path;

    const lower = wanted.toLowerCase();
    const role = asRole(lower);
    if (role) {
      const byUse = list.find((m) => roleOf(m) === role);
      return byUse?.path ?? FALLBACK_PATH[role];
    }

    const delim = list[0]?.delimiter ?? "/";
    const candidates: string[] = [];
    if (lower.startsWith("label:")) candidates.push(`${LABEL_ROOT}${delim}${wanted.slice(6).trim()}`);
    else if (lower.startsWith("folder:")) candidates.push(`${FOLDER_ROOT}${delim}${wanted.slice(7).trim()}`);
    else candidates.push(`${FOLDER_ROOT}${delim}${wanted}`, `${LABEL_ROOT}${delim}${wanted}`);

    for (const c of candidates) {
      const hit = list.find((m) => m.path.toLowerCase() === c.toLowerCase());
      if (hit) return hit.path;
    }
    const caseInsensitive = list.find((m) => m.path.toLowerCase() === lower);
    if (caseInsensitive) return caseInsensitive.path;

    const known = list.filter((m) => !m.flags.has("\\Noselect")).map((m) => m.path);
    throw new Error(`No mailbox called "${name}". Existing mailboxes: ${known.join(", ")}`);
  }

  /** the full path for a new folder or label called `name` */
  async newPath(client: ImapFlow, kind: "folder" | "label", name: string): Promise<string> {
    const list = await this.raw(client);
    const delim = list[0]?.delimiter ?? "/";
    const clean = name.trim().replace(/^(Folders|Labels)\//i, "");
    if (!clean) throw new Error("the name is empty");
    return `${kind === "label" ? LABEL_ROOT : FOLDER_ROOT}${delim}${clean}`;
  }

  /** the role of a path, if it's a system mailbox */
  async roleOfPath(client: ImapFlow, path: string): Promise<Role | undefined> {
    const m = (await this.raw(client)).find((x) => x.path === path);
    return m ? roleOf(m) : undefined;
  }

  invalidate() {
    this.cache = undefined;
  }

  private async raw(client: ImapFlow): Promise<ListResponse[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.list;
    const list = await client.list();
    this.cache = { at: Date.now(), list };
    return list;
  }
}

function roleOf(m: ListResponse): Role | undefined {
  if (m.path.toUpperCase() === "INBOX") return "inbox";
  return m.specialUse ? SPECIAL_USE[m.specialUse] : undefined;
}

function asRole(s: string): Role | undefined {
  const aliases: Record<string, Role> = {
    inbox: "inbox",
    drafts: "drafts",
    draft: "drafts",
    sent: "sent",
    "sent mail": "sent",
    starred: "starred",
    flagged: "starred",
    archive: "archive",
    archived: "archive",
    spam: "spam",
    junk: "spam",
    trash: "trash",
    bin: "trash",
    deleted: "trash",
    all: "all",
    "all mail": "all",
    everything: "all",
  };
  return aliases[s];
}

function order(m: MailboxInfo): number {
  if (m.role) return ROLES.indexOf(m.role);
  return m.kind === "system" ? 20 : m.kind === "folder" ? 30 : 40;
}
