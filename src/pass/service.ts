import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.ts";

/**
 * Proton Pass through Proton's official `pass-cli`, signed in as a Pass
 * *agent*: a token the owner created for Facteur, limited to chosen vaults,
 * revocable from Pass, with Proton keeping its own audit trail
 * (`pass-cli agent monitor facteur`). Every read of an item carries a reason,
 * which Proton records (PROTON_PASS_AGENT_REASON).
 *
 * The CLI keeps its session in a private directory that isn't persisted;
 * Facteur signs in again with the agent token whenever the session expires.
 */

export interface PassConfig {
  /** agent token from the environment: pst_<token>::<key> */
  token?: string;
  bin: string;
  sessionDir: string;
  /** where the dashboard saves a renewed token; it wins over the env one */
  tokenFile: string;
}

export const TOKEN_RE = /pst_[A-Za-z0-9_-]+::[A-Za-z0-9+/=_-]+/;

export interface ItemRef {
  shareId: string;
  itemId: string;
}

export const formatRef = (r: ItemRef) => `pass://${r.shareId}/${r.itemId}`;

export function parseRef(ref: string): ItemRef {
  const m = /^pass:\/\/([A-Za-z0-9_=-]+)\/([A-Za-z0-9_=-]+)\/?$/.exec(ref.trim());
  if (!m) throw new Error(`"${ref}" isn't an item reference. They look like pass://<vault id>/<item id>, as returned by pass_search.`);
  return { shareId: m[1]!, itemId: m[2]! };
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const SESSION_MS = 100 * 60_000; // agent sessions last 2 h; renew before that
const NOT_SIGNED_IN = /not (logged|signed) in|no (active )?session|session (expired|invalid)|unauthori[sz]ed|please log ?in|run 'pass-cli login'/i;

export class PassService {
  private readonly cfg: PassConfig;
  private readonly lock = new Mutex();
  private signedInAt = 0;
  private listCache = new Map<string, { at: number; items: Record<string, unknown>[] }>();

  constructor(cfg: PassConfig) {
    this.cfg = cfg;
    mkdirSync(cfg.sessionDir, { recursive: true, mode: 0o700 });
  }

  get bin() {
    return this.cfg.bin;
  }

  /** the token in use: the one saved from the dashboard, else the env one */
  token(): { value: string; source: "dashboard" | "env" } | undefined {
    try {
      const t = readFileSync(this.cfg.tokenFile, "utf8").trim();
      if (TOKEN_RE.test(t)) return { value: t, source: "dashboard" };
    } catch {
      /* none saved */
    }
    return this.cfg.token ? { value: this.cfg.token, source: "env" } : undefined;
  }

  setToken(t: string) {
    if (!TOKEN_RE.test(t)) throw new Error("that isn't a Pass agent token");
    mkdirSync(dirname(this.cfg.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.cfg.tokenFile}.tmp`, t + "\n", { mode: 0o600 });
    renameSync(`${this.cfg.tokenFile}.tmp`, this.cfg.tokenFile);
    this.signedInAt = 0;
    this.listCache.clear();
  }

  // ---------- reading ----------

  async vaults(): Promise<Record<string, unknown>[]> {
    return asList(await this.json(["vault", "list", "--output", "json"]), ["vaults", "shares"]);
  }

  async items(vault: { shareId?: string; name?: string }, opts: { type?: string; trashed?: boolean } = {}): Promise<Record<string, unknown>[]> {
    const args = ["item", "list", "--output", "json"];
    if (vault.shareId) args.push("--share-id", vault.shareId);
    else if (vault.name) args.push("--vault-name", vault.name);
    if (opts.type) args.push("--filter-type", opts.type);
    args.push("--filter-state", opts.trashed ? "trashed" : "active");
    const key = args.join("\u0000");
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.items;
    const items = asList(await this.json(args), ["items"]);
    this.listCache.set(key, { at: Date.now(), items });
    return items;
  }

  /** the whole item, secrets included: callers must strip what the model may not see */
  async view(ref: ItemRef, reason: string): Promise<Record<string, unknown>> {
    const out = await this.json(["item", "view", "--share-id", ref.shareId, "--item-id", ref.itemId, "--output", "json"], reason);
    return (out && typeof out === "object" ? (out as Record<string, unknown>) : {}) as Record<string, unknown>;
  }

  async field(ref: ItemRef, field: string, reason: string): Promise<string> {
    return (await this.run(["item", "view", "--share-id", ref.shareId, "--item-id", ref.itemId, "--field", field], { reason })).trim();
  }

  async totp(ref: ItemRef, reason: string, field?: string): Promise<{ code: string; expiresIn?: number }> {
    const args = ["item", "totp", "--share-id", ref.shareId, "--item-id", ref.itemId, "--output", "json"];
    if (field) args.push("--field", field);
    const out = await this.json(args, reason);
    const code = findString(out, ["code", "token", "totp", "value"]);
    if (!code) throw new Error("this item has no 2FA code");
    const left = findNumber(out, ["remaining", "remaining_seconds", "expires_in", "ttl", "period_remaining"]);
    return { code, ...(left !== undefined && { expiresIn: left }) };
  }

  async generatePassword(opts: { length?: number; symbols?: boolean; passphraseWords?: number }): Promise<string> {
    const args = opts.passphraseWords
      ? ["password", "generate", "passphrase", "--count", String(opts.passphraseWords)]
      : ["password", "generate", "random", "--length", String(opts.length ?? 20), "--symbols", String(opts.symbols ?? true)];
    // works without a session: nothing leaves the machine
    return (await this.run(args, { auth: false })).trim().split("\n").pop()!.trim();
  }

  // ---------- writing ----------

  async createLogin(
    vault: { shareId?: string; name?: string },
    item: { title: string; username?: string; email?: string; password?: string; urls?: string[]; note?: string },
    reason: string,
  ): Promise<string> {
    const template = await this.json(["item", "create", "login", "--get-template"], reason);
    const filled = fillTemplate(template, item);
    const args = ["item", "create", "login", "--from-template", "-", "--output", "json"];
    if (vault.shareId) args.push("--share-id", vault.shareId);
    else if (vault.name) args.push("--vault-name", vault.name);
    // the template (with the password) goes over stdin, never on the command line
    const out = await this.run(args, { reason, stdin: JSON.stringify(filled) });
    this.listCache.clear();
    return out;
  }

  async update(ref: ItemRef, fields: Record<string, string>, reason: string, fieldType?: "text" | "hidden" | "totp"): Promise<void> {
    const args = ["item", "update", "--share-id", ref.shareId, "--item-id", ref.itemId];
    for (const [k, v] of Object.entries(fields)) args.push("--field", `${k}=${v}`);
    if (fieldType) args.push("--field-type", fieldType);
    await this.run(args, { reason });
    this.listCache.clear();
  }

  async trash(ref: ItemRef, reason: string, restore = false): Promise<void> {
    await this.run(["item", restore ? "untrash" : "trash", "--share-id", ref.shareId, "--item-id", ref.itemId], { reason });
    this.listCache.clear();
  }

  async check(): Promise<string> {
    return (await this.run(["info"])).trim();
  }

  // ---------- plumbing ----------

  private async json(args: string[], reason?: string): Promise<unknown> {
    const out = await this.run(args, { reason });
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`pass-cli returned something unexpected for "${args.slice(0, 2).join(" ")}"`);
    }
  }

  private run(args: string[], opts: { reason?: string; stdin?: string; auth?: boolean } = {}): Promise<string> {
    return this.lock.run(async () => {
      if (opts.auth !== false) await this.ensureSession();
      try {
        return await this.exec(args, opts);
      } catch (e) {
        if (opts.auth === false || !NOT_SIGNED_IN.test((e as Error).message)) throw e;
        // the session expired under us: sign in again once
        this.signedInAt = 0;
        await this.ensureSession();
        return this.exec(args, opts);
      }
    });
  }

  private async ensureSession() {
    if (Date.now() - this.signedInAt < SESSION_MS) return;
    if (!this.token()) throw new Error("Proton Pass isn't connected yet: open Connections on Facteur's home page and click Connect Pass");
    await this.exec(["logout"], {}).catch(() => this.exec(["logout", "--force"], {}).catch(() => undefined));
    await this.exec(["login"], { withToken: true });
    this.signedInAt = Date.now();
    log.info("pass: signed in with the agent token");
  }

  private exec(args: string[], opts: { reason?: string; stdin?: string; withToken?: boolean }): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.cfg.sessionDir,
      PROTON_PASS_SESSION_DIR: this.cfg.sessionDir,
      // containers have no keyring; the session dir is private and not persisted
      PROTON_PASS_KEY_PROVIDER: "fs",
      NO_COLOR: "1",
      ...(opts.reason && { PROTON_PASS_AGENT_REASON: opts.reason.slice(0, 300) }),
      ...(opts.withToken && { PROTON_PASS_PERSONAL_ACCESS_TOKEN: this.token()?.value }),
    };
    return new Promise((resolve, reject) => {
      const child = execFile(this.cfg.bin, args, { env, timeout: 45_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // never echo stdin or stdout (they may hold secrets); stderr is the CLI's own message
          const msg = String(stderr || err.message).replace(/pst_[A-Za-z0-9_:+/=-]+/g, "pst_***").trim().split("\n").slice(-3).join(" ");
          return reject(new Error(`pass-cli ${args[0]} ${args[1] ?? ""}: ${msg || "failed"}`.trim()));
        }
        resolve(stdout);
      });
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
      else child.stdin?.end();
    });
  }
}

// ---------- JSON shapes ----------
// pass-cli's JSON is documented loosely, so these helpers look for fields by
// name rather than by exact path.

export function asList(v: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === "object") {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as Record<string, unknown>[];
    }
  }
  return [];
}

export function findString(v: unknown, keys: string[], depth = 4): string | undefined {
  if (!v || typeof v !== "object" || depth < 0) return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  for (const x of Object.values(o)) {
    const hit = findString(x, keys, depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

export function findNumber(v: unknown, keys: string[], depth = 3): number | undefined {
  if (!v || typeof v !== "object" || depth < 0) return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "number") return o[k] as number;
  for (const x of Object.values(o)) {
    const hit = findNumber(x, keys, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** put our values into whatever template shape `--get-template` returned */
export function fillTemplate(template: unknown, item: { title: string; username?: string; email?: string; password?: string; urls?: string[]; note?: string }): Record<string, unknown> {
  const t = (template && typeof template === "object" ? structuredClone(template) : {}) as Record<string, unknown>;
  const set = (keys: string[], value: unknown) => {
    if (value === undefined) return;
    const hit = keys.find((k) => k in t);
    t[hit ?? keys[0]!] = value;
  };
  set(["title", "name"], item.title);
  set(["username"], item.username);
  set(["email"], item.email);
  set(["password"], item.password);
  set(["urls", "url", "websites"], item.urls);
  set(["note", "notes"], item.note);
  return t;
}
