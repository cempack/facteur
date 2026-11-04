/**
 * Turning pass-cli's item JSON into what a model may see.
 *
 * Rule: a field is shown only if it is known to be harmless (titles,
 * usernames, URLs...). Everything else that has a value is listed by name as
 * "revealable", and its value only ever comes out through pass_reveal.
 */

const VISIBLE = new Set([
  "title", "name", "username", "email", "urls", "url", "websites", "website",
  "type", "itemtype", "kind", "state", "vault", "vaultname", "sharename",
  "aliasaddress", "displayname",
  "createtime", "modifytime", "createdat", "updatedat", "lastusetime", "created", "modified", "updated",
  "aliasemail", "alias", "cardholdername", "cardtype", "expirationdate",
  "ssid", "security", "fullname", "firstname", "lastname", "phonenumber", "organization", "company",
  "city", "country", "zipcode", "stateorprovince", "streetaddress",
  "pinned", "flags", "itemid", "shareid", "id", "filename", "mimetype", "size",
]);

/** internal ids and app metadata: neither shown nor offered for reveal */
const IGNORE = new Set(["vaultid", "itemuuid", "customicon", "platformspecific", "autofillurls", "passkeys", "flags", "itemid", "shareid", "id"]);

/** content.content is keyed by the item type: { Login: {...} }, { CreditCard: {...} } */
const TYPES = new Set(["Login", "Note", "Alias", "CreditCard", "Identity", "SshKey", "Wifi", "Custom"]);

const SECRET = /pass(word|phrase|code)?$|totp|otp|secret|private|cvv|cvc|pin$|^number$|cardnumber|token|recovery|^note$|^notes$|^content$|seed|mnemonic|license|^key$/i;

export interface ItemView {
  ref?: string;
  title: string;
  type?: string;
  vault?: string;
  visible: Record<string, string>;
  /** fields that hold a value but are secret; reveal with pass_reveal */
  revealable: string[];
  customVisible: Record<string, string>;
  attachments: string[];
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.filter(Boolean).join(", ") || undefined;
  return undefined;
}

/** walk the item, sorting leaves into visible and revealable */
export function viewItem(raw: Record<string, unknown>, ref?: string): ItemView {
  const view: ItemView = { ...(ref && { ref }), title: "", visible: {}, revealable: [], customVisible: {}, attachments: [] };
  const seenSecret = new Set<string>();

  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    const k = norm(key);
    if (IGNORE.has(k)) return;
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object")) {
      // custom fields: [{ name, type, value }] / attachments: [{ name|filename, ... }]
      if (/extrafields|customfields|fields/.test(k)) {
        for (const f of v as Record<string, unknown>[]) custom(f);
        return;
      }
      if (/attachment|files/.test(k)) {
        for (const f of v as Record<string, unknown>[]) {
          const n = str(f.name) ?? str(f.filename) ?? str(f.fileName);
          if (n) view.attachments.push(n);
        }
        return;
      }
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    if (typeof v === "object" && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (TYPES.has(ck)) view.type ??= ck;
        walk(cv, ck, depth + 1);
      }
      return;
    }
    const value = str(v);
    if (!value) return;
    if (SECRET.test(k) || !VISIBLE.has(k)) {
      // unknown or secret: name only
      if (!SECRET.test(k) && !VISIBLE.has(k) && value.length <= 3) return; // tiny flags/enums
      if (!seenSecret.has(key)) {
        seenSecret.add(key);
        view.revealable.push(key);
      }
      return;
    }
    if (k === "title" || (k === "name" && !view.title)) view.title = value;
    else if (/^(type|itemtype|kind)$/.test(k)) view.type ??= value;
    else if (/^(vault|vaultname|sharename)$/.test(k)) view.vault ??= value;
    else if (!(key in view.visible)) view.visible[key] = value;
  };

  const custom = (f: Record<string, unknown>) => {
    const name = str(f.name) ?? str(f.fieldName) ?? str(f.title);
    if (!name) return;
    let type = (str(f.type) ?? str(f.fieldType) ?? "text").toLowerCase();
    let value = str(f.value) ?? str((f.data as Record<string, unknown> | undefined)?.content) ?? str(f.content);
    // { name, content: { Hidden: "…" } } / { Text: … } / { Totp: … }
    const c = f.content;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const [k, x] = Object.entries(c as Record<string, unknown>)[0] ?? [];
      if (k) {
        type = k.toLowerCase();
        value = str(x) ?? str((x as Record<string, unknown> | undefined)?.value);
      }
    }
    if (type === "text" && value && !SECRET.test(norm(name))) view.customVisible[name] = value;
    else if (value || type !== "text") view.revealable.push(name);
  };

  walk(raw, "", 0);
  if (!view.title) view.title = "(untitled)";
  // the id fields are noise next to the ref
  for (const k of Object.keys(view.visible)) if (/^(id|itemid|shareid|item_id|share_id)$/i.test(k)) delete view.visible[k];
  return view;
}

export function renderItem(v: ItemView): string {
  const lines = [`• ${v.ref ?? ""}  ${v.title}${v.type ? `  [${v.type}]` : ""}${v.vault ? `  (vault: ${v.vault})` : ""}`];
  for (const [k, val] of Object.entries(v.visible)) lines.push(`  ${k}: ${val}`);
  for (const [k, val] of Object.entries(v.customVisible)) lines.push(`  ${k}: ${val}`);
  if (v.attachments.length) lines.push(`  attachments: ${v.attachments.join(", ")}`);
  if (v.revealable.length) lines.push(`  secret fields (pass_reveal): ${[...new Set(v.revealable)].join(", ")}`);
  return lines.join("\n");
}

/** does a list entry match a free-text query (title, username, email, URLs)? */
export function matches(v: ItemView, q: string): boolean {
  const needle = q.toLowerCase();
  const hay = [v.title, ...Object.values(v.visible), ...Object.keys(v.customVisible), ...Object.values(v.customVisible)].join(" ").toLowerCase();
  return needle.split(/\s+/).every((w) => hay.includes(w));
}
