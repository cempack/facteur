import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BULK_LIMIT } from "../../mail/service.ts";
import { idsSchema, safe, searchSchema, text, type ToolContext } from "../context.ts";

/**
 * Every bulk tool takes either `ids` (from search_emails) or `search` (the
 * same filters as search_emails, applied server-side), never both. `max`
 * guards against a search matching far more than intended.
 */
const target = {
  ids: idsSchema.optional(),
  search: searchSchema.optional().describe("Instead of ids: act on every message matching this search (same fields as search_emails)."),
  max: z.number().int().min(1).max(BULK_LIMIT).default(100).describe("Refuse if the search matches more than this many messages."),
};

type Target = { ids?: string[]; search?: z.infer<typeof searchSchema>; max: number };

function count(targets: Map<string, number[]>) {
  let n = 0;
  for (const uids of targets.values()) n += uids.length;
  return n;
}

function idList(targets: Map<string, number[]>) {
  const out: string[] = [];
  for (const [box, uids] of targets) for (const u of uids) out.push(`${box}/${u}`);
  return out;
}

export function registerOrganizeTools(server: McpServer, ctx: ToolContext) {
  const resolveTargets = async (t: Target) => {
    if (t.ids?.length && t.search) throw new Error("give ids or search, not both");
    return ctx.mail.targets(t.ids, t.search, t.max);
  };

  server.registerTool(
    "mark_emails",
    {
      title: "Mark emails",
      description: "Mark messages read/unread, starred/unstarred, or replied. Leave a field out to keep it as is.",
      inputSchema: z.object({
        ...target,
        read: z.boolean().optional(),
        starred: z.boolean().optional(),
        answered: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe("mark_emails", ctx, async ({ read, starred, answered, ...t }) => {
      if (read === undefined && starred === undefined && answered === undefined) throw new Error("nothing to change: set read, starred or answered");
      const targets = await resolveTargets(t);
      if (!targets.size) return text("No messages matched; nothing changed.");
      const n = await ctx.mail.setFlags(targets, { read, starred, answered });
      ctx.audit.record({ client: ctx.client, tool: "mark_emails", ok: true, count: n, change: { read, starred, answered } });
      return text(`Updated ${n} message${n > 1 ? "s" : ""}.`);
    }),
  );

  server.registerTool(
    "move_emails",
    {
      title: "Move emails",
      description:
        'Move messages to another mailbox: "inbox", "archive", "spam", "trash", or a folder ("Work", "Folders/Work"). ' +
        "Moving gives messages new ids; the new ones are returned. To tag without moving, use label_emails.",
      inputSchema: z.object({ ...target, to: z.string().describe("Destination mailbox.") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe("move_emails", ctx, async ({ to, ...t }) => {
      const targets = await resolveTargets(t);
      if (!targets.size) return text("No messages matched; nothing moved.");
      const r = await ctx.mail.move(targets, to);
      ctx.audit.record({ client: ctx.client, tool: "move_emails", ok: true, count: r.moved, to: r.destination, ids: idList(targets).slice(0, 200) });
      const ids = r.newIds.length ? `\nNew ids: ${r.newIds.slice(0, 100).join(", ")}${r.newIds.length > 100 ? " …" : ""}` : "";
      return text(`Moved ${r.moved} message${r.moved === 1 ? "" : "s"} to ${r.destination}.${ids}`);
    }),
  );

  server.registerTool(
    "label_emails",
    {
      title: "Add or remove a label",
      description: "Add a label to messages (they stay where they are), or remove one. Labels are listed by list_mailboxes.",
      inputSchema: z.object({
        ...target,
        label: z.string().describe('Label name, e.g. "Receipts".'),
        action: z.enum(["add", "remove"]).default("add"),
        create: z.boolean().default(false).describe("Create the label if it doesn't exist (add only)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe("label_emails", ctx, async ({ label, action, create, ...t }) => {
      const targets = await resolveTargets(t);
      if (!targets.size) return text("No messages matched; nothing changed.");
      const r = action === "add" ? await ctx.mail.addLabel(targets, label, create) : await ctx.mail.removeLabel(targets, label);
      ctx.audit.record({ client: ctx.client, tool: "label_emails", ok: true, action, label: r.label, count: r.count });
      return text(`${action === "add" ? "Added" : "Removed"} ${r.label} ${action === "add" ? "to" : "from"} ${r.count} message${r.count === 1 ? "" : "s"}.`);
    }),
  );

  server.registerTool(
    "delete_emails",
    {
      title: "Delete emails",
      description:
        "Move messages to Trash (recoverable). With permanent=true, or for messages already in Trash/Spam, they are deleted for good.",
      inputSchema: z.object({ ...target, permanent: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safe("delete_emails", ctx, async ({ permanent, ...t }) => {
      const targets = await resolveTargets(t);
      if (!targets.size) return text("No messages matched; nothing deleted.");
      const r = await ctx.mail.delete(targets, permanent);
      ctx.audit.record({ client: ctx.client, tool: "delete_emails", ok: true, permanent, ...r, ids: idList(targets).slice(0, 200) });
      const parts = [r.trashed ? `moved ${r.trashed} to Trash` : "", r.deleted ? `permanently deleted ${r.deleted}` : ""].filter(Boolean);
      return text(`Done: ${parts.join(", ")}.`);
    }),
  );

  server.registerTool(
    "manage_mailbox",
    {
      title: "Create, rename or delete a folder or label",
      description:
        "create: a new folder or label. rename: give the current name and new_name. delete: removes the folder or label " +
        "(messages in a deleted folder go back to the inbox in Proton; deleting a label only untags messages).",
      inputSchema: z.object({
        action: z.enum(["create", "rename", "delete"]),
        kind: z.enum(["folder", "label"]).default("folder").describe("For create."),
        name: z.string().describe("Name of the folder/label (to create, rename or delete)."),
        new_name: z.string().optional().describe("For rename."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe("manage_mailbox", ctx, async ({ action, kind, name, new_name }) => {
      let result: string;
      if (action === "create") result = `Created ${await ctx.mail.createMailbox(kind, name)}.`;
      else if (action === "rename") {
        if (!new_name) throw new Error("rename needs new_name");
        const r = await ctx.mail.renameMailbox(name, new_name);
        result = `Renamed ${r.from} to ${r.to}.`;
      } else result = `Deleted ${await ctx.mail.deleteMailbox(name)}.`;
      ctx.audit.record({ client: ctx.client, tool: "manage_mailbox", ok: true, action, kind, name, new_name });
      return text(result);
    }),
  );
}
