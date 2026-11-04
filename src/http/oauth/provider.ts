import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, sameHash, token, type Client, type Grant, type OAuthStore } from "./store.ts";

/**
 * A small OAuth 2.1 authorization server, just enough for MCP clients:
 * dynamic client registration (RFC 7591), authorization code + PKCE S256,
 * rotating refresh tokens, revocation (RFC 7009), resource indicators
 * (RFC 8707). The person approving is the mailbox owner, authenticated by
 * the HTTP layer (Cloudflare Access or a password) before consent.
 */

export const ACCESS_TTL = 60 * 60 * 1000; // 1 h
export const REFRESH_TTL = 60 * 86_400_000; // 60 days, renewed on every refresh
const CODE_TTL = 5 * 60 * 1000;

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

export interface AuthorizeRequest {
  client: Client;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  resource: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expires: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface VerifiedToken {
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource: string;
  grantId?: string;
}

export class OAuthProvider {
  private codes = new Map<string, PendingCode>();
  private readonly store: OAuthStore;
  readonly issuer: string;
  readonly resource: string;
  readonly scopes: string[];
  private readonly apiTokenHash?: string;
  private readonly apiTokenScopes: string[];

  constructor(opts: { store: OAuthStore; issuer: string; resource: string; scopes: string[]; apiToken?: string; apiTokenScopes?: string[] }) {
    this.store = opts.store;
    this.issuer = opts.issuer;
    this.resource = opts.resource;
    this.scopes = opts.scopes;
    if (opts.apiToken) this.apiTokenHash = hash(opts.apiToken);
    this.apiTokenScopes = (opts.apiTokenScopes ?? opts.scopes).filter((s) => opts.scopes.includes(s));
  }

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: this.scopes,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    };
  }

  // ---------- registration ----------

  register(body: Record<string, unknown>): Record<string, unknown> {
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a list of 1 to 10 URLs");
    }
    for (const u of uris as string[]) checkRedirectUri(u);
    const method = (body.token_endpoint_auth_method as string | undefined) ?? "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      throw new OAuthError("invalid_client_metadata", `unsupported token_endpoint_auth_method ${method}`);
    }
    const grantTypes = (body.grant_types as string[] | undefined) ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => !["authorization_code", "refresh_token"].includes(g))) {
      throw new OAuthError("invalid_client_metadata", "only authorization_code and refresh_token grants are supported");
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined;
    const clientUri = typeof body.client_uri === "string" && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 300) : undefined;
    const client: Client = {
      client_id: `fct_client_${randomBytes(16).toString("base64url")}`,
      redirect_uris: uris as string[],
      token_endpoint_auth_method: method as Client["token_endpoint_auth_method"],
      created_at: Date.now(),
      ...(name && { client_name: name }),
      ...(clientUri && { client_uri: clientUri }),
    };
    let secret: string | undefined;
    if (method !== "none") {
      secret = token("fct_secret");
      client.client_secret_hash = hash(secret);
    }
    this.store.addClient(client);
    return {
      client_id: client.client_id,
      ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(name && { client_name: name }),
      ...(clientUri && { client_uri: clientUri }),
    };
  }

  // ---------- authorization ----------

  /**
   * Check an /authorize request. Errors about the client or redirect URI must
   * be shown to the user (never redirected: the URI isn't trusted yet);
   * `redirectable` errors go back to the client.
   */
  parseAuthorize(q: Record<string, string | undefined>): AuthorizeRequest {
    const client = q.client_id ? this.store.client(q.client_id) : undefined;
    if (!client) throw new OAuthError("invalid_client", "Unknown client. Remove the connector in your AI app and add it again.");
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError("invalid_request", "The redirect_uri doesn't match the one this client registered.");
    }
    const fail = (code: string, msg: string) => {
      const e = new OAuthError(code, msg);
      (e as OAuthError & { redirect?: string }).redirect = errorRedirect(redirectUri, code, msg, q.state, this.issuer);
      return e;
    };
    if (q.response_type !== "code") throw fail("unsupported_response_type", "response_type must be code");
    if (!q.code_challenge || q.code_challenge_method !== "S256") throw fail("invalid_request", "PKCE with S256 is required");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) throw fail("invalid_request", "code_challenge isn't a S256 challenge");
    const resource = this.checkResource(q.resource, fail);
    const requested = (q.scope ?? "").split(/\s+/).filter(Boolean);
    const unknown = requested.filter((s) => !this.scopes.includes(s));
    if (unknown.length) throw fail("invalid_scope", `unknown scope ${unknown.join(" ")}`);
    return {
      client,
      redirectUri,
      // asking for nothing means asking for everything; the owner picks on the consent page
      scopes: requested.length ? requested : [...this.scopes],
      ...(q.state !== undefined && { state: q.state }),
      codeChallenge: q.code_challenge,
      resource,
    };
  }

  /** the owner approved: mint a single-use code and build the redirect */
  approve(req: AuthorizeRequest, grantedScopes: string[]): string {
    const scopes = grantedScopes.filter((s) => this.scopes.includes(s));
    if (!scopes.length) return errorRedirect(req.redirectUri, "access_denied", "no scope was granted", req.state, this.issuer);
    const code = randomBytes(32).toString("base64url");
    this.sweepCodes();
    this.codes.set(hash(code), {
      clientId: req.client.client_id,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scopes,
      resource: req.resource,
      expires: Date.now() + CODE_TTL,
    });
    const url = new URL(req.redirectUri);
    url.searchParams.set("code", code);
    if (req.state !== undefined) url.searchParams.set("state", req.state);
    url.searchParams.set("iss", this.issuer);
    return url.toString();
  }

  deny(req: AuthorizeRequest): string {
    return errorRedirect(req.redirectUri, "access_denied", "the owner declined", req.state, this.issuer);
  }

  // ---------- token endpoint ----------

  token(body: Record<string, string | undefined>, basicAuth?: { id: string; secret: string }): TokenResponse {
    const client = this.authenticateClient(body, basicAuth);
    if (body.grant_type === "authorization_code") return this.exchangeCode(client, body);
    if (body.grant_type === "refresh_token") return this.refresh(client, body);
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  private exchangeCode(client: Client, body: Record<string, string | undefined>): TokenResponse {
    const key = body.code ? hash(body.code) : "";
    const pending = this.codes.get(key);
    // single use, whatever happens next
    this.codes.delete(key);
    if (!pending || pending.expires < Date.now()) throw new OAuthError("invalid_grant", "the code is invalid or expired");
    if (pending.clientId !== client.client_id) throw new OAuthError("invalid_grant", "the code was issued to another client");
    if (body.redirect_uri !== undefined && body.redirect_uri !== pending.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (!body.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) throw new OAuthError("invalid_grant", "code_verifier is missing or malformed");
    const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
    if (!safeEqual(challenge, pending.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    if (body.resource !== undefined && this.normalizeResource(body.resource) !== pending.resource) {
      throw new OAuthError("invalid_target", "resource doesn't match the authorization");
    }
    const now = Date.now();
    const access = token("fct_at");
    const refresh = token("fct_rt");
    const grant: Grant = {
      id: randomBytes(9).toString("base64url"),
      client_id: client.client_id,
      scopes: pending.scopes,
      resource: pending.resource,
      created_at: now,
      last_used_at: now,
      access_hash: hash(access),
      access_expires: now + ACCESS_TTL,
      refresh_hash: hash(refresh),
      refresh_expires: now + REFRESH_TTL,
    };
    this.store.addGrant(grant);
    client.last_used_at = now;
    return this.response(access, refresh, grant.scopes);
  }

  private refresh(client: Client, body: Record<string, string | undefined>): TokenResponse {
    const h = body.refresh_token ? hash(body.refresh_token) : "";
    const grants = this.store.grants();
    const reused = h && grants.find((g) => g.previous_refresh_hash && sameHash(g.previous_refresh_hash, h));
    if (reused) {
      // an old refresh token came back: someone else has it. End the whole grant.
      this.store.removeGrant(reused.id);
      throw new OAuthError("invalid_grant", "refresh token reuse detected; the connection was revoked");
    }
    const grant = h ? grants.find((g) => sameHash(g.refresh_hash, h)) : undefined;
    if (!grant || grant.refresh_expires < Date.now()) throw new OAuthError("invalid_grant", "the refresh token is invalid or expired");
    if (grant.client_id !== client.client_id) throw new OAuthError("invalid_grant", "the refresh token belongs to another client");
    let scopes = grant.scopes;
    if (body.scope) {
      const asked = body.scope.split(/\s+/).filter(Boolean);
      if (asked.some((s) => !grant.scopes.includes(s))) throw new OAuthError("invalid_scope", "can't widen scopes on refresh");
      scopes = asked;
    }
    const now = Date.now();
    const access = token("fct_at");
    const refresh = token("fct_rt");
    grant.previous_refresh_hash = grant.refresh_hash;
    grant.refresh_hash = hash(refresh);
    grant.refresh_expires = now + REFRESH_TTL;
    grant.access_hash = hash(access);
    grant.access_expires = now + ACCESS_TTL;
    grant.scopes = scopes;
    grant.last_used_at = now;
    client.last_used_at = now;
    this.store.save(true);
    return this.response(access, refresh, scopes);
  }

  private response(access: string, refresh: string, scopes: string[]): TokenResponse {
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: scopes.join(" ") };
  }

  private authenticateClient(body: Record<string, string | undefined>, basic?: { id: string; secret: string }): Client {
    const id = basic?.id ?? body.client_id;
    const client = id ? this.store.client(id) : undefined;
    if (!client) throw new OAuthError("invalid_client", "unknown client", 401);
    if (client.token_endpoint_auth_method !== "none") {
      const secret = basic?.secret ?? body.client_secret;
      if (!secret || !client.client_secret_hash || !sameHash(hash(secret), client.client_secret_hash)) {
        throw new OAuthError("invalid_client", "client authentication failed", 401);
      }
    }
    return client;
  }

  // ---------- resource server side ----------

  verify(accessToken: string): VerifiedToken | undefined {
    const h = hash(accessToken);
    if (this.apiTokenHash && sameHash(h, this.apiTokenHash)) {
      return { clientId: "api-token", scopes: [...this.apiTokenScopes], resource: this.resource };
    }
    const now = Date.now();
    const grant = this.store.grants().find((g) => sameHash(g.access_hash, h));
    if (!grant || grant.access_expires < now) return undefined;
    if (!grant.last_used_at || now - grant.last_used_at > 60_000) {
      grant.last_used_at = now;
      this.store.save();
    }
    return { clientId: grant.client_id, scopes: grant.scopes, expiresAt: Math.floor(grant.access_expires / 1000), resource: grant.resource, grantId: grant.id };
  }

  /** RFC 7009: always "ok", whether or not the token existed */
  revoke(tokenValue: string | undefined) {
    if (!tokenValue) return;
    const h = hash(tokenValue);
    const grant = this.store.grants().find((g) => sameHash(g.access_hash, h) || sameHash(g.refresh_hash, h));
    if (grant) this.store.removeGrant(grant.id);
  }

  // ---------- helpers ----------

  private checkResource(resource: string | undefined, fail: (c: string, m: string) => Error): string {
    if (resource === undefined) return this.resource;
    const r = this.normalizeResource(resource);
    if (r !== this.resource) throw fail("invalid_target", `this server only issues tokens for ${this.resource}`);
    return r;
  }

  /** clients send the MCP URL or the bare origin; both mean this server */
  private normalizeResource(resource: string): string {
    const r = resource.replace(/\/+$/, "");
    return r === this.issuer ? this.resource : r;
  }

  private sweepCodes() {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expires < now) this.codes.delete(k);
    if (this.codes.size > 1000) this.codes.clear();
  }
}

/** https anywhere, http only on loopback (RFC 8252), and app schemes like cursor:// */
export function checkRedirectUri(u: string) {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new OAuthError("invalid_redirect_uri", `not a URL: ${u}`);
  }
  if (url.hash) throw new OAuthError("invalid_redirect_uri", "redirect URIs can't have a fragment");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && loopback) return;
  if (/^(javascript|data|file|vbscript|blob|about):$/i.test(url.protocol) || url.protocol === "http:") {
    throw new OAuthError("invalid_redirect_uri", `redirect URIs must be https, loopback http, or an app scheme: ${u}`);
  }
}

function errorRedirect(redirectUri: string, code: string, description: string, state: string | undefined, iss: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", iss);
  return url.toString();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** HMAC-signed, expiring blobs: consent forms and the password session cookie */
export function sign(secret: string, payload: object, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function unsign<T>(secret: string, value: string | undefined): (T & { exp: number }) | undefined {
  if (!value) return undefined;
  const [body, mac] = value.split(".");
  if (!body || !mac) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return data.exp > Date.now() ? data : undefined;
  } catch {
    return undefined;
  }
}
