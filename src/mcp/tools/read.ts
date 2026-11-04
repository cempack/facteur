import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describeSearch } from "../../mail/search.ts";
import { mailboxArg, safe, searchFields, text, type ToolContext } from "../context.ts";
import { renderMailboxes, renderMessage, renderSearch, renderThread } from "../format.ts";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  const tz = ctx.cfg.timeZone;

  server.registerTool(
    "list_mailboxes",
    {
      title: "List mailboxes",
      description: "Every mailbox (system ones, folders and labels) with total and unread counts. Use it to find folder/label names.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    safe("list_mailboxes", ctx, async () => text(renderMailboxes(await ctx.mail.listMailboxes(true)))),
  );

  server.registerTool(
    "search_emails",
    {
      title: "Search emails",
      description:
        "Find messages in one mailbox, newest first. All filters combine with AND; with none it lists the mailbox. " +
        'Use mailbox "all" to search everywhere. Returns ids for get_email and the action tools, plus a short preview.',
      inputSchema: z.object({
        mailbox: mailboxArg,
        ...searchFields,
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0).describe("Skip this many results (for paging)."),
        preview: z.boolean().default(true).describe("Include a ~200 character preview of each body."),
      }),
      annotations: READ,
    },
    safe("search_emails", ctx, async ({ mailbox, limit, offset, preview, ...filters }) => {
      const result = await ctx.mail.search(mailbox, filters, { limit, offset, preview });
      return text(renderSearch(result, describeSearch(filters), tz));
    }),
  );

  server.registerTool(
    "get_email",
    {
      title: "Read an email",
      description:
        "One message in full: headers, body as readable text (HTML converted), attachments with their part numbers, and labels. " +
        "Doesn't mark it read unless mark_read is true.",
      inputSchema: z.object({
        id: z.string().describe('Message id, e.g. "INBOX/4521".'),
        max_chars: z.number().int().min(500).max(200_000).default(20_000).describe("Cut the body after this many characters."),
        format: z.enum(["text", "html"]).default("text").describe("text: readable text (default). html: the raw HTML part."),
        mark_read: z.boolean().default(false),
      }),
      annotations: { ...READ, readOnlyHint: false, idempotentHint: true },
    },
    safe("get_email", ctx, async ({ id, max_chars, format, mark_read }) => {
      if (mark_read && !ctx.scopes.has("mail.write")) throw new Error("marking as read needs the mail.write scope; call again with mark_read=false");
      const msg = await ctx.mail.getMessage(id, { format, maxChars: max_chars, markRead: mark_read, labels: true });
      return text(renderMessage(msg, tz));
    }),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a conversation",
      description: "The whole conversation a message belongs to (every reply, sent and received, across folders), oldest first.",
      inputSchema: z.object({
        id: z.string().describe("Any message of the conversation."),
        max_chars_per_message: z.number().int().min(200).max(50_000).default(6_000),
        limit: z.number().int().min(1).max(50).default(20).describe("At most this many messages (the newest are kept)."),
      }),
      annotations: READ,
    },
    safe("get_thread", ctx, async ({ id, max_chars_per_message, limit }) => {
      const { messages } = await ctx.mail.thread(id, { maxChars: max_chars_per_message, limit });
      return text(renderThread(messages, tz));
    }),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Open an attachment",
      description:
        "Download one attachment of a message (part number from get_email). Images come back as images, text files as text, " +
        "PDFs and other files as an embedded resource.",
      inputSchema: z.object({
        id: z.string().describe("Message id."),
        part: z.string().describe('Attachment part number from get_email, e.g. "2" or "1.3" (or its exact filename).'),
      }),
      annotations: READ,
    },
    safe("get_attachment", ctx, async ({ id, part }) => {
      const file = await ctx.mail.downloadAttachment(id, part, ctx.cfg.maxAttachmentBytes);
      const intro = { type: "text" as const, text: `${file.filename} (${file.contentType}, ${Math.ceil(file.data.length / 1024)} KB) from ${id}:` };
      const type = file.contentType.toLowerCase();
      if (/^image\/(png|jpe?g|gif|webp)$/.test(type)) {
        return { content: [intro, { type: "image", data: file.data.toString("base64"), mimeType: type }] };
      }
      if (type.startsWith("text/") || /json|xml|csv|calendar|javascript|yaml/.test(type)) {
        const body = file.data.toString("utf8");
        return { content: [intro, { type: "text", text: `<attachment untrusted>\n${body}\n</attachment>` }] };
      }
      return {
        content: [
          intro,
          {
            type: "resource",
            resource: { uri: `mail://${encodeURIComponent(id)}/attachments/${encodeURIComponent(part)}`, mimeType: type, blob: file.data.toString("base64") },
          },
        ],
      };
    }),
  );
}
