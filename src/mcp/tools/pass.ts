import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { matches, renderItem, viewItem, type ItemView } from "../../pass/items.ts";
import type { RevealStore } from "../../pass/reveal.ts";
import { findString, formatRef, parseRef, type PassService } from "../../pass/service.ts";
import { safe, SCOPES, text, type ToolContext } from "../context.ts";

type PassContext = ToolContext & { pass: PassService; reveals: RevealStore };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const refArg = z.string().describe("Item reference from pass_search, e.g. pass://<vault id>/<item id>.");
const reasonArg = z
  .string()
  .min(3)
  .max(200)
  .describe("Why you need this, in a few words (\"user asked to log in to their bank\"). Recorded in Proton Pass's audit log.");

interface Vault {
  shareId: string;
  name: string;
}

export function registerPassTools(server: McpServer, ctx: PassContext) {
  const canReveal = ctx.scopes.has(SCOPES.passReveal);
  const canWrite = ctx.scopes.has(SCOPES.passWrite);
  const why = (tool: string, reason?: string) => `${ctx.client} via Facteur: ${tool}${reason ? ` (${reason})` : ""}`;

  const vaults = async (): Promise<Vault[]> =>
    (await ctx.pass.vaults())
      .map((v) => ({ shareId: findString(v, ["share_id", "shareId", "shareID"]) ?? findString(v, ["id"]) ?? "", name: findString(v, ["name", "title"]) ?? "(vault)" }))
      .filter((v) => v.shareId);

  const pickVault = async (name?: string): Promise<Vault> => {
    const all = await vaults();
    if (!all.length) throw new Error("Facteur's Pass agent has no vault access. Grant it one with: pass-cli agent access grant facteur --vault-name <name>");
    if (!name) {
      if (all.length === 1) return all[0]!;
      throw new Error(`say which vault: ${all.map((v) => v.name).join(", ")}`);
    }
    const hit = all.find((v) => v.name.toLowerCase() === name.toLowerCase() || v.shareId === name);
    if (!hit) throw new Error(`no vault "${name}" (Facteur can use: ${all.map((v) => v.name).join(", ")})`);
    return hit;
  };

  const itemsOf = async (v: Vault, type?: string, trashed?: boolean): Promise<ItemView[]> =>
    (await ctx.pass.items({ shareId: v.shareId }, { type, trashed })).map((raw) => {
      const itemId = findString(raw, ["item_id", "itemId", "itemID"]) ?? findString(raw, ["id"]);
      const view = viewItem(raw, itemId ? formatRef({ shareId: v.shareId, itemId }) : undefined);
      view.vault ??= v.name;
      return view;
    });

  server.registerTool(
    "pass_list_vaults",
    {
      title: "List Proton Pass vaults",
      description: "The Proton Pass vaults Facteur can use.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    safe("pass_list_vaults", ctx, async () => {
      const all = await vaults();
      return text(all.length ? all.map((v) => `• ${v.name}  (${v.shareId})`).join("\n") : "No vaults are shared with Facteur.");
    }),
  );

  server.registerTool(
    "pass_search",
    {
      title: "Search Proton Pass",
      description:
        "Find logins, notes, cards, identities, aliases... by title, username, email or website. " +
        "Shows only non-secret fields; secret fields are listed by name for pass_reveal.",
      inputSchema: z.object({
        query: z.string().optional().describe('Words to match, e.g. "github" or "bank". Leave out to list everything.'),
        vault: z.string().optional().describe("Only this vault."),
        type: z.enum(["login", "note", "alias", "credit-card", "identity", "ssh-key", "wifi", "custom"]).optional(),
        trashed: z.boolean().default(false).describe("Search the trash instead."),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: READ,
    },
    safe("pass_search", ctx, async ({ query, vault, type, trashed, limit }) => {
      const scope = vault ? [await pickVault(vault)] : await vaults();
      let found: ItemView[] = [];
      for (const v of scope) found.push(...(await itemsOf(v, type, trashed)));
      if (query) found = found.filter((i) => matches(i, query));
      if (!found.length) return text(`No items match${query ? ` "${query}"` : ""}.`);
      const shown = found.slice(0, limit);
      const more = found.length > shown.length ? `\n\n(${found.length - shown.length} more; narrow the query.)` : "";
      return text(`${found.length} item${found.length > 1 ? "s" : ""}:\n\n${shown.map(renderItem).join("\n\n")}${more}`);
    }),
  );

  server.registerTool(
    "pass_get_item",
    {
      title: "Open a Proton Pass item",
      description: "One item's non-secret details (username, websites, custom text fields, attachments) and the names of its secret fields.",
      inputSchema: z.object({ ref: refArg }),
      annotations: READ,
    },
    safe("pass_get_item", ctx, async ({ ref }) => {
      const r = parseRef(ref);
      const view = viewItem(await ctx.pass.view(r, why("pass_get_item", "show non-secret details")), ref);
      return text(renderItem(view));
    }),
  );

  server.registerTool(
    "pass_reveal",
    {
      title: canReveal ? "Reveal a secret" : "Get a link to reveal a secret",
      description: canReveal
        ? "Read one secret field of an item: password (default), totp (the current 2FA code), note, or a custom/hidden field by name. " +
          "Only when the user needs it for what they asked; never put it in an email, message or file unless they asked for exactly that."
        : "This connection can't see secrets. Returns a one-time link (10 minutes) the user opens to see the field themselves.",
      inputSchema: z.object({
        ref: refArg,
        field: z.string().default("password").describe('"password", "totp", "note", or a field name from pass_get_item.'),
        reason: reasonArg,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe("pass_reveal", ctx, async ({ ref, field, reason }) => {
      const r = parseRef(ref);
      if (!canReveal) {
        const title = viewItem(await ctx.pass.view(r, why("pass_reveal link", reason)), ref).title;
        const id = ctx.reveals.create({ ref: r, title, field, client: ctx.client, reason });
        ctx.audit.record({ client: ctx.client, tool: "pass_reveal", ok: true, mode: "link", ref, field, reason });
        return text(
          `This app isn't allowed to see secrets, so the value was not shared with it. ` +
            `Give the user this one-time link (valid 10 minutes, needs their sign-in): ${ctx.cfg.http.publicUrl}/reveal/${id}`,
        );
      }
      const audit = { client: ctx.client, tool: "pass_reveal", ok: true, mode: "value", ref, field, reason };
      if (/^(totp|2fa|otp|mfa)$/i.test(field)) {
        const t = await ctx.pass.totp(r, why("pass_reveal totp", reason));
        ctx.audit.record(audit);
        return text(`2FA code: ${t.code}${t.expiresIn !== undefined ? ` (valid ${t.expiresIn} more seconds)` : ""}`);
      }
      const value = await ctx.pass.field(r, field, why("pass_reveal", reason));
      ctx.audit.record(audit);
      if (!value) return text(`The ${field} field is empty.`);
      return text(`${field}: ${value}\n(Use it only for what the user asked. Don't repeat it back in full unless they want to see it.)`);
    }),
  );

  server.registerTool(
    "pass_generate_password",
    {
      title: "Generate a password",
      description: "A strong random password or passphrase, generated locally by Proton Pass. Nothing is saved.",
      inputSchema: z.object({
        length: z.number().int().min(8).max(128).default(20),
        symbols: z.boolean().default(true),
        passphrase_words: z.number().int().min(3).max(12).optional().describe("Make a passphrase of this many words instead."),
      }),
      annotations: { ...READ, idempotentHint: false },
    },
    safe("pass_generate_password", ctx, async ({ length, symbols, passphrase_words }) =>
      text(await ctx.pass.generatePassword({ length, symbols, ...(passphrase_words && { passphraseWords: passphrase_words }) })),
    ),
  );

  if (!canWrite) return;

  server.registerTool(
    "pass_create_login",
    {
      title: "Save a new login",
      description: "Create a login item. Without a password, a strong one is generated (and not shown unless this app may see secrets).",
      inputSchema: z.object({
        vault: z.string().optional().describe("Vault name (needed if Facteur has several)."),
        title: z.string().min(1),
        username: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional().describe("Leave out to generate one."),
        urls: z.array(z.string()).optional(),
        note: z.string().optional(),
        reason: reasonArg,
      }),
      annotations: WRITE,
    },
    safe("pass_create_login", ctx, async ({ vault, password, reason, ...item }) => {
      const v = await pickVault(vault);
      const generated = !password;
      const pw = password ?? (await ctx.pass.generatePassword({ length: 24, symbols: true }));
      await ctx.pass.createLogin({ shareId: v.shareId }, { ...item, password: pw }, why("pass_create_login", reason));
      ctx.audit.record({ client: ctx.client, tool: "pass_create_login", ok: true, vault: v.name, title: item.title, generated });
      const shown = generated ? (canReveal ? ` Generated password: ${pw}` : " A strong password was generated; reveal it with pass_reveal.") : "";
      return text(`Saved "${item.title}" in ${v.name}.${shown}`);
    }),
  );

  server.registerTool(
    "pass_update_item",
    {
      title: "Edit a Pass item",
      description:
        'Change fields of an item: e.g. {"username": "new", "url": "https://…"}. Set password to "generate" for a new strong password. ' +
        "A field name that doesn't exist yet becomes a custom field.",
      inputSchema: z.object({
        ref: refArg,
        fields: z.record(z.string(), z.string()).describe("Field name → new value."),
        new_fields_type: z.enum(["text", "hidden", "totp"]).optional().describe("Type for fields that don't exist yet (default text)."),
        reason: reasonArg,
      }),
      annotations: WRITE,
    },
    safe("pass_update_item", ctx, async ({ ref, fields, new_fields_type, reason }) => {
      if (!Object.keys(fields).length) throw new Error("no fields to change");
      const r = parseRef(ref);
      const out = { ...fields };
      let generated = false;
      if (out.password === "generate") {
        out.password = await ctx.pass.generatePassword({ length: 24, symbols: true });
        generated = true;
      }
      await ctx.pass.update(r, out, why("pass_update_item", reason), new_fields_type);
      ctx.audit.record({ client: ctx.client, tool: "pass_update_item", ok: true, ref, fields: Object.keys(fields) });
      const pw = generated ? (canReveal ? ` New password: ${out.password}` : " A new password was generated; reveal it with pass_reveal.") : "";
      return text(`Updated ${Object.keys(fields).join(", ")}.${pw}`);
    }),
  );

  server.registerTool(
    "pass_trash_item",
    {
      title: "Move a Pass item to trash",
      description: "Move an item to the Pass trash (recoverable), or restore it with restore=true. Permanent deletion isn't available here.",
      inputSchema: z.object({ ref: refArg, restore: z.boolean().default(false), reason: reasonArg }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    safe("pass_trash_item", ctx, async ({ ref, restore, reason }) => {
      await ctx.pass.trash(parseRef(ref), why(restore ? "pass_restore_item" : "pass_trash_item", reason), restore);
      ctx.audit.record({ client: ctx.client, tool: "pass_trash_item", ok: true, ref, restore });
      return text(restore ? "Restored from trash." : "Moved to the Pass trash (restore with restore=true).");
    }),
  );
}
