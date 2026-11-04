import type { AuditEntry } from "../audit.ts";

/**
 * Audit entries → one readable line each, for the Activity tab. Unknown
 * tools fall back to the tool name, so new tools show up without changes here.
 */

export interface ActivityItem {
  time: Date;
  client: string;
  icon: string;
  kind: "mail" | "pass" | "drive" | "calendar" | "owner";
  title: string;
  detail?: string;
  ok: boolean;
  /** worth a second look: secrets revealed, permanent deletes, public links */
  sensitive?: boolean;
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const n = (v: unknown) => (typeof v === "number" ? v : 0);
const list = (v: unknown, max = 3) => {
  const a = Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
  return a.length > max ? `${a.slice(0, max).join(", ")} and ${a.length - max} more` : a.join(", ");
};
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const quote = (t: unknown) => (s(t) ? `“${s(t)}”` : "");

export function describe(e: AuditEntry): ActivityItem {
  const base = { time: new Date(e.t), client: e.client || "unknown app", ok: e.ok !== false };
  const it = (kind: ActivityItem["kind"], icon: string, title: string, detail?: string, sensitive?: boolean): ActivityItem => ({
    ...base,
    kind,
    icon,
    title,
    ...(detail && { detail }),
    ...(sensitive && { sensitive }),
  });

  if (e.ok === false) {
    const kind = e.tool.startsWith("pass") ? "pass" : e.tool.startsWith("drive") ? "drive" : e.tool.startsWith("calendar") ? "calendar" : "mail";
    return it(kind, "warning-circle", `${e.tool.replace(/_/g, " ")} failed`, s(e.error));
  }

  switch (e.tool) {
    // mail
    case "send_email":
    case "reply_email":
    case "forward_email":
    case "send_draft": {
      const verb = { send_email: "Sent", reply_email: "Replied", forward_email: "Forwarded", send_draft: "Sent draft" }[e.tool];
      const to = list([...(Array.isArray(e.to) ? e.to : []), ...(Array.isArray(e.cc) ? e.cc : [])]);
      return it("mail", "paper-plane-tilt", `${verb} ${quote(e.subject)}`.trim(), [to && `to ${to}`, n(e.attachments) && plural(n(e.attachments), "attachment"), s(e.from) && `from ${s(e.from)}`].filter(Boolean).join(", "));
    }
    case "create_draft":
    case "update_draft":
      return it("mail", "note-pencil", `${e.tool === "create_draft" ? "Saved draft" : "Edited draft"} ${quote(e.subject)}`.trim(), list(e.to) && `to ${list(e.to)}`);
    case "move_emails":
      return it("mail", "folder-simple", `Moved ${plural(n(e.count), "message")} to ${s(e.to)}`);
    case "delete_emails": {
      const parts = [n(e.trashed) && `${plural(n(e.trashed), "message")} to Trash`, n(e.deleted) && `${plural(n(e.deleted), "message")} deleted for good`].filter(Boolean);
      return it("mail", "trash", parts.length ? `Moved ${parts.join(", ")}` : "Deleted messages", undefined, n(e.deleted) > 0);
    }
    case "mark_emails": {
      const c = (e.change ?? {}) as Record<string, unknown>;
      const what = [c.read === true && "read", c.read === false && "unread", c.starred === true && "starred", c.starred === false && "unstarred", c.answered && "replied"].filter(Boolean).join(", ");
      return it("mail", "check-square", `Marked ${plural(n(e.count), "message")} ${what}`.trim());
    }
    case "label_emails":
      return it("mail", "tag", `${e.action === "remove" ? "Removed" : "Added"} label ${s(e.label).replace(/^Labels\//, "")} ${e.action === "remove" ? "from" : "on"} ${plural(n(e.count), "message")}`);
    case "manage_mailbox":
      return it("mail", "folder-simple", `${({ create: "Created", rename: "Renamed", delete: "Deleted" } as Record<string, string>)[s(e.action)] ?? "Changed"} ${s(e.kind) || "folder"} ${s(e.name)}${e.new_name ? ` to ${s(e.new_name)}` : ""}`, undefined, e.action === "delete");

    // pass
    case "pass_reveal": {
      if (e.mode === "link") return it("pass", "link-simple", `Asked you to view a ${s(e.field)}`, s(e.reason));
      if (e.mode === "owner-page") return it("owner", "eye", `You viewed the ${s(e.field)} of ${quote(e.title)}`, `asked by ${s(e.client)}`);
      return it("pass", "key", `Read a ${s(e.field)}`, s(e.reason), true);
    }
    case "pass_create_login":
      return it("pass", "plus-circle", `Saved login ${quote(e.title)}`, [s(e.vault) && `in ${s(e.vault)}`, e.generated && "generated password"].filter(Boolean).join(", "));
    case "pass_update_item":
      return it("pass", "pencil-simple", `Changed ${list(e.fields)} of a Pass item`, undefined, Array.isArray(e.fields) && e.fields.includes("password"));
    case "pass_trash_item":
      return it("pass", "trash", e.restore ? "Restored a Pass item" : "Moved a Pass item to the trash");

    // drive
    case "drive_upload":
      return it("drive", "upload-simple", `Uploaded ${quote(e.filename)}`, [s(e.folder) && `to ${s(e.folder)}`, e.email_id ? "from an email" : ""].filter(Boolean).join(", "));
    case "drive_mkdir":
      return it("drive", "folder-simple-plus", `Created folder ${quote(e.name)}`, s(e.parent) && `in ${s(e.parent)}`);
    case "drive_rename":
      return it("drive", "pencil-simple", `Renamed ${s(e.path)}`, `to ${s(e.new_name)}`);
    case "drive_move":
      return it("drive", "folder-simple", `Moved ${list(e.paths, 2)}`, `to ${s(e.to)}`);
    case "drive_trash":
      return it("drive", "trash", `Trashed ${list(e.paths, 2)}`);
    case "drive_restore":
      return it("drive", "arrow-counter-clockwise", `Restored ${list(e.paths, 2)}`);
    case "drive_share_link":
      return it("drive", "globe-simple", `Made a public link for ${s(e.path)}`, [s(e.role), e.password && "with password", s(e.expiration) && `until ${s(e.expiration)}`].filter(Boolean).join(", "), true);
    case "drive_unshare_link":
      return it("drive", "link-break", `Removed the public link of ${s(e.path)}`);
    case "drive_share":
      return it("drive", "share-network", `Shared ${s(e.path)}`, `with ${list(e.emails)}${e.role ? ` (${s(e.role)})` : ""}`, true);
    case "drive_unshare":
      return it("drive", "user-minus", `Stopped sharing ${s(e.path)}`, e.everyone ? "with everyone" : list(e.emails) && `with ${list(e.emails)}`);

    // owner actions on the pages
    case "connect":
      return it("owner", "plugs-connected", `You connected ${s(e.client)}`, list(e.scopes, 9), Array.isArray(e.scopes) && e.scopes.includes("pass.reveal"));
    case "disconnect":
      return it("owner", "plugs", `You disconnected ${s(e.client)}`);
    case "drive_signin":
      return it("owner", "hard-drives", "You signed Drive in");
    case "drive_signout":
      return it("owner", "hard-drives", "You signed Drive out");
    case "pass_agent":
      return it("owner", "key", e.renewed ? "You renewed Facteur's Pass agent" : "You connected Pass");
    case "bridge_password":
      return it("owner", "envelope-simple", "You updated the Bridge password");
    case "calendar_add":
      return it("owner", "calendar-blank", `You added calendar ${quote(e.name)}`);
    case "calendar_remove":
      return it("owner", "calendar-blank", `You removed calendar ${quote(e.name)}`);
  }
  const kind = e.tool.startsWith("pass") ? "pass" : e.tool.startsWith("drive") ? "drive" : e.tool.startsWith("calendar") ? "calendar" : "mail";
  return it(kind, "circle", e.tool.replace(/_/g, " "));
}
