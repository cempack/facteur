import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { log } from "../../log.ts";

/**
 * OAuth state, kept in one small JSON file in the data volume. Secrets are
 * never stored: client secrets, access and refresh tokens are SHA-256 hashes
 * (they're 256-bit random, so a plain hash is enough).
 */

export interface Client {
  client_id: string;
  client_secret_hash?: string;
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  created_at: number;
  last_used_at?: number;
}

/** one approval: a client, the scopes it got, and its current token pair */
export interface Grant {
  id: string;
  client_id: string;
  scopes: string[];
  resource: string;
  created_at: number;
  last_used_at?: number;
  access_hash: string;
  access_expires: number;
  refresh_hash: string;
  refresh_expires: number;
  /** the previous refresh token: presenting it again means it leaked, so the grant is revoked */
  previous_refresh_hash?: string;
}

interface State {
  version: 1;
  /** HMAC key for cookies and consent forms */
  secret: string;
  clients: Client[];
  grants: Grant[];
}

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export class OAuthStore {
  private state: State;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.state = this.load();
  }

  get secret() {
    return this.state.secret;
  }

  clients() {
    return this.state.clients;
  }

  grants() {
    return this.state.grants;
  }

  client(id: string) {
    return this.state.clients.find((c) => c.client_id === id);
  }

  addClient(c: Client) {
    this.state.clients.push(c);
    this.prune();
    this.save(true);
  }

  addGrant(g: Grant) {
    this.state.grants.push(g);
    this.save(true);
  }

  removeGrant(id: string) {
    this.state.grants = this.state.grants.filter((g) => g.id !== id);
    this.save(true);
  }

  removeClientGrants(clientId: string) {
    this.state.grants = this.state.grants.filter((g) => g.client_id !== clientId);
    this.save(true);
  }

  /** write soon (coalesces bursts of last-used updates), or now for security-relevant changes */
  save(now = false) {
    clearTimeout(this.saveTimer);
    if (now) return this.flush();
    this.saveTimer = setTimeout(() => this.flush(), 5_000);
    this.saveTimer.unref();
  }

  flush() {
    clearTimeout(this.saveTimer);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      log.error("couldn't save OAuth state", { error: String(e) });
    }
  }

  /**
   * Registration is open (that's how MCP clients sign up), so drop clients
   * that never got approved after a day, and grants long expired.
   */
  prune(now = Date.now()) {
    const day = 86_400_000;
    const approved = new Set(this.state.grants.map((g) => g.client_id));
    this.state.grants = this.state.grants.filter((g) => g.refresh_expires > now);
    this.state.clients = this.state.clients.filter((c) => approved.has(c.client_id) || now - c.created_at < day);
    // hard cap, oldest unapproved first
    if (this.state.clients.length > 500) {
      const keep = this.state.clients.filter((c) => approved.has(c.client_id));
      const rest = this.state.clients.filter((c) => !approved.has(c.client_id)).slice(-(500 - keep.length));
      this.state.clients = [...keep, ...rest];
    }
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (s.version === 1 && s.secret) return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn("OAuth state unreadable, starting fresh", { error: String(e) });
    }
    const fresh: State = { version: 1, secret: randomBytes(32).toString("base64url"), clients: [], grants: [] };
    this.state = fresh;
    this.flush();
    return fresh;
  }
}
