import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkDrivePath, childPath, type DriveNode, type DriveService, type FileConflict, type ItemResult, type ShareInfo, mb, nodeName, nodeSize } from "../../drive/service.ts";
import { localDate } from "../format.ts";
import { safe, text, type ToolContext, type ToolResult } from "../context.ts";

export const DRIVE_SCOPES = { read: "drive.read", write: "drive.write" } as const;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** sharing reaches other people and the public web */
const SHARE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const drivePath = z
  .string()
  .min(1)
  .describe('Absolute Drive path, e.g. "/my-files/Documents/report.pdf". Your files are under /my-files. Escape a "/" inside a name as "\\/".');
const drivePaths = z.array(drivePath).min(1).max(100);

const kb = (n?: number) => (n === undefined ? "-" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : mb(n));

function line(n: DriveNode, path: string, tz?: string): string {
  const kind = n.type === "folder" ? "dir " : n.type === "file" ? "file" : n.type;
  const size = n.type === "folder" ? "" : ` ${kb(nodeSize(n))}`;
  const when = n.activeRevision?.claimedModificationTime ?? n.modificationTime;
  const flags = [n.isShared && "shared", n.isSharedByUrl && "link", n.trashTime && "trashed"].filter(Boolean).join(",");
  return `${kind} ${when ? localDate(when, tz) : ""}${size} ${path}${n.type === "folder" ? "/" : ""}${flags ? ` [${flags}]` : ""}`;
}

function renderInfo(path: string, n: DriveNode, tz?: string, folderSize?: Record<string, unknown>): string {
  const author = (a?: { ok: boolean; value?: unknown }) => (a?.ok ? (a.value ?? "anonymous") : a ? "unverified" : undefined);
  const rows: [string, unknown][] = [
    ["Path", path],
    ["Name", nodeName(n)],
    ["Type", n.type + (n.mediaType ? ` (${n.mediaType})` : "")],
    ["Size", n.type === "folder" ? undefined : kb(nodeSize(n))],
    ["Folder size", folderSize ? Object.entries(folderSize).map(([k, v]) => `${k}: ${typeof v === "number" ? kb(v) : String(v)}`).join(", ") : undefined],
    ["Modified", n.activeRevision?.claimedModificationTime ? localDate(n.activeRevision.claimedModificationTime, tz) : n.modificationTime && localDate(n.modificationTime, tz)],
    ["Created", n.creationTime && localDate(n.creationTime, tz)],
    ["Trashed", n.trashTime && localDate(n.trashTime, tz)],
    ["Shared", n.isShared ? (n.isSharedByUrl ? "yes, with a public link" : "yes") : "no"],
    ["My role", n.directRole],
    ["Owner", n.ownedBy?.email],
    ["Author", author(n.activeRevision?.contentAuthor ?? n.keyAuthor)],
    ["Uid", n.uid],
  ];
  return rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
}

function renderShare(path: string, s: ShareInfo, tz?: string): string {
  const out = [`Sharing for ${path}:`];
  const people = [
    ...(s.members ?? []).map((m) => `- ${m.inviteeEmail} (${m.role})`),
    ...(s.protonInvitations ?? []).map((m) => `- ${m.inviteeEmail} (${m.role}, invited)`),
    ...(s.nonProtonInvitations ?? []).map((m) => `- ${m.inviteeEmail} (${m.role}, invited${m.state ? `, ${m.state}` : ""})`),
  ];
  out.push(people.length ? `People:\n${people.join("\n")}` : "People: none");
  const u = s.urlAccess;
  if (u) {
    const extra = [
      u.role,
      u.customPassword ? "password protected" : "",
      u.expirationTime ? `expires ${localDate(u.expirationTime, tz)}` : "no expiry",
      u.numberOfInitializedDownloads !== undefined ? `${u.numberOfInitializedDownloads} downloads` : "",
    ].filter(Boolean);
    out.push(`Public link: ${u.url} (${extra.join(", ")})`);
  } else out.push("Public link: none");
  return out.join("\n");
}

function renderItems(verb: string, paths: string[], items: ItemResult[]): string {
  const failed = items.filter((i) => !i.ok);
  const ok = items.length - failed.length;
  const lines = [`${verb} ${ok} of ${paths.length} item${paths.length === 1 ? "" : "s"}.`];
  for (const f of failed) {
    const msg = typeof f.error === "string" ? f.error : (f.error?.message ?? "failed");
    lines.push(`- failed (${f.uid}): ${msg}`);
  }
  return lines.join("\n");
}

function fileContent(label: string, uri: string, contentType: string, data: Buffer): ToolResult {
  const intro = { type: "text" as const, text: label };
  const type = contentType.toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp)$/.test(type)) {
    return { content: [intro, { type: "image", data: data.toString("base64"), mimeType: type }] };
  }
  if (type.startsWith("text/") || /json|xml|csv|calendar|javascript|yaml|markdown/.test(type)) {
    return { content: [intro, { type: "text", text: `<file untrusted>\n${data.toString("utf8")}\n</file>` }] };
  }
  return { content: [intro, { type: "resource", resource: { uri, mimeType: type, blob: data.toString("base64") } }] };
}

export function registerDriveTools(server: McpServer, ctx: ToolContext & { drive: DriveService }) {
  const drive = ctx.drive;
  const tz = ctx.cfg.timeZone;

  if (ctx.scopes.has(DRIVE_SCOPES.read)) {
    server.registerTool(
      "drive_list",
      {
        title: "List Drive files",
        description:
          'List a Proton Drive folder. "/" lists the sections (my-files, shared-with-me, shared-by-me, trash, devices, photos...). ' +
          "With recursive=true, walks subfolders (bounded) and can filter by name, which is how to search Drive.",
        inputSchema: z.object({
          path: drivePath.default("/my-files"),
          recursive: z.boolean().default(false),
          name_contains: z.string().optional().describe("Only entries whose name contains this (case-insensitive). Best with recursive=true."),
          type: z.enum(["file", "folder"]).optional(),
          max_depth: z.number().int().min(1).max(10).default(4).describe("With recursive: how many folder levels to go down."),
          limit: z.number().int().min(1).max(2000).default(300),
        }),
        annotations: READ,
      },
      safe("drive_list", ctx, async ({ path, recursive, name_contains, type, max_depth, limit }) => {
        const needle = name_contains?.toLowerCase();
        if (!recursive) {
          const items = await drive.list(path, type);
          const shown = items.filter((i) => !needle || nodeName(i).toLowerCase().includes(needle));
          if (!shown.length) return text(`${path} is empty${needle ? ` (or nothing matches "${name_contains}")` : ""}.`);
          const base = checkDrivePath(path);
          const rows = shown.slice(0, limit).map((i) => ("path" in i ? `section /${i.path}` : line(i, childPath(base, nodeName(i)), tz)));
          const more = shown.length > limit ? `\n… ${shown.length - limit} more; raise limit` : "";
          return text(`${path}: ${shown.length} entr${shown.length === 1 ? "y" : "ies"}\n${rows.join("\n")}${more}`);
        }
        const walk = await drive.walk(path, { maxDepth: max_depth, maxFolders: 60, maxEntries: needle ? 20_000 : limit, type });
        const hits = walk.entries.filter((e) => !needle || nodeName(e.node).toLowerCase().includes(needle)).slice(0, limit);
        const head = `${path}, recursive (${max_depth} levels): ${hits.length} entr${hits.length === 1 ? "y" : "ies"}${needle ? ` matching "${name_contains}"` : ""}`;
        const note = walk.truncated || hits.length === limit ? "\n(stopped early: narrow the path or raise limit/max_depth)" : "";
        return text(`${head}\n${hits.map((e) => line(e.node, e.path, tz)).join("\n") || "(nothing)"}${note}`);
      }),
    );

    server.registerTool(
      "drive_info",
      {
        title: "Drive item details",
        description: "Metadata for one Drive file or folder: type, size, dates, sharing, owner. For folders, can include the total size.",
        inputSchema: z.object({
          path: drivePath,
          folder_size: z.boolean().default(false).describe("For a folder: also compute its total size (slower)."),
        }),
        annotations: READ,
      },
      safe("drive_info", ctx, async ({ path, folder_size }) => {
        const n = await drive.info(path);
        const size = folder_size && n.type === "folder" ? await drive.folderSize(path) : undefined;
        return text(renderInfo(path, n, tz, size));
      }),
    );

    server.registerTool(
      "drive_sharing_status",
      {
        title: "Drive sharing status",
        description: "Who a Drive file or folder is shared with, pending invitations, and its public link if any.",
        inputSchema: z.object({ path: drivePath }),
        annotations: READ,
      },
      safe("drive_sharing_status", ctx, async ({ path }) => text(renderShare(path, await drive.sharingStatus(path), tz))),
    );

    server.registerTool(
      "drive_download",
      {
        title: "Open a Drive file",
        description:
          `Download one Drive file (at most ${mb(ctx.cfg.maxAttachmentBytes)}). Images come back as images, text files as text, ` +
          "PDFs and other files as an embedded resource. Proton Docs and Sheets can't be downloaded.",
        inputSchema: z.object({ path: drivePath }),
        annotations: READ,
      },
      safe("drive_download", ctx, async ({ path }) => {
        const f = await drive.download(path, ctx.cfg.maxAttachmentBytes);
        const label = `${f.name} (${f.contentType}, ${kb(f.data.length)}) from ${path}:`;
        return fileContent(label, `drive://${path.split("/").map(encodeURIComponent).join("/")}`, f.contentType, f.data);
      }),
    );
  }

  if (!ctx.scopes.has(DRIVE_SCOPES.write)) return;

  server.registerTool(
    "drive_upload",
    {
      title: "Save a file to Drive",
      description:
        "Upload a file into a Drive folder. The content is one of: content_base64, text, or an email attachment " +
        '(email_id + part from get_email), e.g. "save this attachment to my Drive". The folder must exist (drive_mkdir).',
      inputSchema: z.object({
        folder: drivePath.describe('Destination folder, e.g. "/my-files/Invoices".'),
        filename: z.string().optional().describe("Name in Drive. Defaults to the attachment's filename."),
        content_base64: z.string().optional().describe("File content, base64."),
        text: z.string().optional().describe("Or: the content as UTF-8 text."),
        email_id: z.string().optional().describe('Or: save an email attachment. Message id, e.g. "INBOX/4521".'),
        part: z.string().optional().describe("With email_id: attachment part number or exact filename from get_email."),
        if_exists: z
          .enum(["rename", "new_revision", "replace", "skip"])
          .default("rename")
          .describe("When a file with that name exists: rename (add a suffix), new_revision, replace (old one to trash) or skip."),
      }),
      annotations: WRITE,
    },
    safe("drive_upload", ctx, async ({ folder, filename, content_base64, text: body, email_id, part, if_exists }) => {
      const sources = [content_base64 !== undefined, body !== undefined, email_id !== undefined].filter(Boolean).length;
      if (sources !== 1) throw new Error("give exactly one of content_base64, text, or email_id + part");
      let data: Buffer;
      let name = filename;
      if (email_id !== undefined) {
        if (!part) throw new Error("email_id needs part (the attachment part number from get_email)");
        if (!ctx.scopes.has("mail.read")) throw new Error("saving an email attachment needs the mail.read scope");
        const att = await ctx.mail.downloadAttachment(email_id, part, ctx.cfg.maxAttachmentBytes);
        data = att.data;
        name ??= att.filename;
      } else if (body !== undefined) {
        data = Buffer.from(body, "utf8");
      } else {
        data = Buffer.from(content_base64!, "base64");
      }
      if (!name) throw new Error("filename is required");
      if (data.length > ctx.cfg.maxAttachmentBytes) throw new Error(`the file is ${mb(data.length)}, over the ${mb(ctx.cfg.maxAttachmentBytes)} limit`);
      const s = await drive.upload(folder, name, data, if_exists as FileConflict);
      ctx.audit.record({
        client: ctx.client, tool: "drive_upload", ok: true, folder, filename: name, bytes: data.length,
        from: email_id ? { email_id, part } : undefined, skipped: s?.skippedItems || undefined,
      });
      if (s?.skippedItems && !s.transferredItems) {
        return text(`Skipped: ${folder}/${name} already exists${if_exists === "skip" ? "" : " with identical content"}.`);
      }
      const renamed = if_exists === "rename" ? " (a suffix is added if the name was taken)" : "";
      return text(`Uploaded ${name} (${kb(data.length)}) to ${folder}${renamed}.`);
    }),
  );

  server.registerTool(
    "drive_mkdir",
    {
      title: "Create a Drive folder",
      description: "Create a folder inside an existing Drive folder (under /my-files, /devices or a folder shared with you).",
      inputSchema: z.object({ parent: drivePath.default("/my-files"), name: z.string().min(1).max(255) }),
      annotations: WRITE,
    },
    safe("drive_mkdir", ctx, async ({ parent, name }) => {
      await drive.createFolder(parent, name);
      ctx.audit.record({ client: ctx.client, tool: "drive_mkdir", ok: true, parent, name });
      return text(`Created ${childPath(checkDrivePath(parent), name)}/`);
    }),
  );

  server.registerTool(
    "drive_rename",
    {
      title: "Rename a Drive item",
      description: "Rename a file or folder in place (use drive_move to change its folder).",
      inputSchema: z.object({ path: drivePath, new_name: z.string().min(1).max(255) }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe("drive_rename", ctx, async ({ path, new_name }) => {
      await drive.rename(path, new_name);
      ctx.audit.record({ client: ctx.client, tool: "drive_rename", ok: true, path, new_name });
      return text(`Renamed ${path} to ${new_name}.`);
    }),
  );

  server.registerTool(
    "drive_move",
    {
      title: "Move Drive items",
      description: "Move files or folders into another Drive folder of the same account.",
      inputSchema: z.object({ paths: drivePaths, to: drivePath.describe("Destination folder.") }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe("drive_move", ctx, async ({ paths, to }) => {
      const r = await drive.move(paths, to);
      ctx.audit.record({ client: ctx.client, tool: "drive_move", ok: true, paths, to, failed: r.filter((i) => !i.ok).length || undefined });
      return text(renderItems(`Moved to ${to}:`, paths, r));
    }),
  );

  server.registerTool(
    "drive_trash",
    {
      title: "Trash Drive items",
      description: "Move files or folders to the Drive trash (recoverable with drive_restore; nothing is deleted permanently).",
      inputSchema: z.object({ paths: drivePaths }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    safe("drive_trash", ctx, async ({ paths }) => {
      const r = await drive.trash(paths);
      ctx.audit.record({ client: ctx.client, tool: "drive_trash", ok: true, paths, failed: r.filter((i) => !i.ok).length || undefined });
      return text(renderItems("Trashed", paths, r));
    }),
  );

  server.registerTool(
    "drive_restore",
    {
      title: "Restore from Drive trash",
      description: 'Restore trashed items. Paths are as listed by drive_list on "/trash".',
      inputSchema: z.object({ paths: drivePaths }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    safe("drive_restore", ctx, async ({ paths }) => {
      const r = await drive.restore(paths);
      ctx.audit.record({ client: ctx.client, tool: "drive_restore", ok: true, paths, failed: r.filter((i) => !i.ok).length || undefined });
      return text(renderItems("Restored", paths, r));
    }),
  );

  server.registerTool(
    "drive_share_link",
    {
      title: "Create a public Drive link",
      description:
        "Create or update a public link to a Drive file or folder. Anyone with the link can open it, so only do this when the user asked. " +
        "Returns the URL.",
      inputSchema: z.object({
        path: drivePath,
        role: z.enum(["viewer", "editor"]).default("viewer"),
        password: z.string().min(1).max(200).optional().describe("Optional extra password for the link."),
        expiration: z.string().optional().describe("Optional expiry date, ISO, e.g. 2026-12-31."),
      }),
      annotations: SHARE,
    },
    safe("drive_share_link", ctx, async ({ path, role, password, expiration }) => {
      const s = await drive.setUrl(path, { role, password, expiration });
      ctx.audit.record({ client: ctx.client, tool: "drive_share_link", ok: true, path, role, password: password ? "set" : undefined, expiration });
      return text(renderShare(path, s, tz));
    }),
  );

  server.registerTool(
    "drive_unshare_link",
    {
      title: "Remove a public Drive link",
      description: "Remove the public link of a Drive file or folder. People it's shared with directly keep access.",
      inputSchema: z.object({ path: drivePath }),
      annotations: { ...SHARE, openWorldHint: false },
    },
    safe("drive_unshare_link", ctx, async ({ path }) => {
      const s = await drive.removeUrl(path);
      ctx.audit.record({ client: ctx.client, tool: "drive_unshare_link", ok: true, path });
      return text(renderShare(path, s, tz));
    }),
  );

  server.registerTool(
    "drive_share",
    {
      title: "Share a Drive item with people",
      description:
        "Invite people by email to a Drive file or folder (Proton emails them an invitation), or change their role if already shared. " +
        "Only do this when the user asked.",
      inputSchema: z.object({
        path: drivePath,
        emails: z.array(z.string()).min(1).max(50),
        role: z.enum(["viewer", "editor", "admin"]).default("viewer"),
        message: z.string().max(2000).optional().describe("Optional message in the invitation email (sent in clear text)."),
      }),
      annotations: SHARE,
    },
    safe("drive_share", ctx, async ({ path, emails, role, message }) => {
      const s = await drive.invite(path, emails, role, message);
      ctx.audit.record({ client: ctx.client, tool: "drive_share", ok: true, path, emails, role });
      return text(renderShare(path, s, tz));
    }),
  );

  server.registerTool(
    "drive_unshare",
    {
      title: "Stop sharing a Drive item",
      description: "Remove people's access (or pending invitations) to a Drive file or folder, by email or for everyone. Doesn't touch the public link.",
      inputSchema: z.object({
        path: drivePath,
        emails: z.array(z.string()).max(50).optional(),
        everyone: z.boolean().default(false),
      }),
      annotations: { ...SHARE, openWorldHint: false },
    },
    safe("drive_unshare", ctx, async ({ path, emails, everyone }) => {
      if (everyone === Boolean(emails?.length)) throw new Error("give emails, or everyone=true, not both");
      const s = await drive.removeAccess(path, everyone ? "everyone" : emails!);
      ctx.audit.record({ client: ctx.client, tool: "drive_unshare", ok: true, path, emails, everyone: everyone || undefined });
      return text(renderShare(path, s, tz));
    }),
  );
}
