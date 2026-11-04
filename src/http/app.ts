import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { createMcpHandler, OAuthError as McpOAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { ALL_SCOPES, type ToolContext } from "../mcp/context.ts";
import { buildServer } from "../mcp/server.ts";
import { OAuthError, OAuthProvider, sign, unsign, type AuthorizeRequest } from "./oauth/provider.ts";
import { OAuthStore } from "./oauth/store.ts";
import { Owner } from "./owner.ts";
import { consentPage, dashboardPage, errorPage, loginPage } from "./pages.ts";

type Deps = Omit<ToolContext, "client" | "scopes">;

export function createApp(cfg: Config, deps: Deps) {
  const base = cfg.http.publicUrl;
  const mcpUrl = `${base}/mcp`;
  const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const store = new OAuthStore(join(cfg.dataDir, "oauth.json"));
  const oauth = new OAuthProvider({ store, issuer: base, resource: mcpUrl, scopes: ALL_SCOPES, apiToken: cfg.http.apiToken });
  const owner = new Owner(cfg.http, store.secret);

  const app = express();
  app.disable("x-powered-by");
  if (cfg.http.trustProxy) app.set("trust proxy", true);

  // the real client IP behind Cloudflare, for rate limits
  const clientIp = (req: Request) => (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip ?? "unknown";
  const limiter = (limit: number, windowMs = 15 * 60_000) =>
    rateLimit({ windowMs, limit, keyGenerator: clientIp, standardHeaders: "draft-8", legacyHeaders: false, validate: false });

  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    next();
  });

  // ---------- health ----------
  app.get("/healthz", async (req, res) => {
    if (req.query.deep === undefined) return void res.json({ ok: true });
    try {
      await deps.mail.pool.withClient((c) => c.noop());
      res.json({ ok: true, imap: true });
    } catch (e) {
      res.status(503).json({ ok: false, imap: false, error: (e as Error).message });
    }
  });

  // ---------- discovery ----------
  const prm = {
    resource: mcpUrl,
    authorization_servers: [base],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Facteur (Proton Mail)",
  };
  const cors = (_req: Request, res: Response, next: NextFunction) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    next();
  };
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], cors, (_req, res) => void res.json(prm));
  app.get("/.well-known/oauth-authorization-server", cors, (_req, res) => void res.json(oauth.metadata()));
  app.options(/^\/(\.well-known\/.*|token|register|revoke)$/, cors, (_req, res) => void res.sendStatus(204));

  const oauthError = (res: Response, e: unknown) => {
    if (e instanceof OAuthError) return void res.status(e.status).json({ error: e.code, error_description: e.message });
    log.error("oauth endpoint failed", { error: String(e) });
    res.status(500).json({ error: "server_error" });
  };

  // ---------- registration, token, revocation (called by AI apps) ----------
  app.post("/register", cors, limiter(30, 60 * 60_000), express.json({ limit: "20kb" }), (req, res) => {
    if (owner.mode === "none") return void res.status(403).json({ error: "access_denied", error_description: "OAuth is disabled on this server" });
    try {
      const client = oauth.register(req.body ?? {});
      log.info("client registered", { client: client.client_id, name: client.client_name });
      res.status(201).json(client);
    } catch (e) {
      oauthError(res, e);
    }
  });

  app.post("/token", cors, limiter(120), express.urlencoded({ extended: false, limit: "20kb" }), express.json({ limit: "20kb" }), (req, res) => {
    try {
      res.json(oauth.token(req.body ?? {}, basicAuth(req)));
    } catch (e) {
      oauthError(res, e);
    }
  });

  app.post("/revoke", cors, limiter(60), express.urlencoded({ extended: false, limit: "20kb" }), express.json({ limit: "20kb" }), (req, res) => {
    oauth.revoke(req.body?.token);
    res.sendStatus(200);
  });

  // ---------- consent (the owner, in a browser) ----------
  const FORM_TTL = 10 * 60_000;
  const form = express.urlencoded({ extended: false, limit: "20kb" });

  app.get("/authorize", limiter(60), async (req, res) => {
    if (owner.mode === "none") return void res.status(403).send(errorPage("Connections are off", "Set FACTEUR_ADMIN_PASSWORD or Cloudflare Access to approve connections."));
    let request: AuthorizeRequest;
    try {
      request = oauth.parseAuthorize(req.query as Record<string, string>);
    } catch (e) {
      const redirect = (e as { redirect?: string }).redirect;
      if (redirect) return void res.redirect(302, redirect);
      return void res.status(400).send(errorPage("Can't connect", (e as Error).message));
    }
    const who = await owner.identify(req);
    if (!who) {
      if (owner.mode === "access") return void res.status(403).send(errorPage("Not signed in", "Sign in through Cloudflare Access, then try again."));
      return void res.send(loginPage(`/login?next=${encodeURIComponent(req.originalUrl)}`));
    }
    const signed = sign(store.secret, { q: req.query }, FORM_TTL);
    res.send(
      consentPage({
        clientName: request.client.client_name ?? "An app",
        redirectHost: hostOf(request.redirectUri),
        account: deps.mail.account,
        scopes: request.scopes,
        form: signed,
        owner: who,
      }),
    );
  });

  app.post("/authorize", limiter(30), form, async (req, res) => {
    if (!sameOrigin(req, base)) return void res.status(403).send(errorPage("Blocked", "This form must be sent from this site."));
    const who = await owner.identify(req);
    if (!who) return void res.status(403).send(errorPage("Not signed in", "Your session expired. Start the connection again from your app."));
    const data = unsign<{ q: Record<string, string> }>(store.secret, req.body?.request);
    if (!data) return void res.status(400).send(errorPage("Expired", "This approval page expired. Start the connection again from your app."));
    let request: AuthorizeRequest;
    try {
      request = oauth.parseAuthorize(data.q);
    } catch (e) {
      return void res.status(400).send(errorPage("Can't connect", (e as Error).message));
    }
    if (req.body.decision !== "allow") return void res.redirect(302, oauth.deny(request));
    const picked = ([] as string[]).concat(req.body.scope ?? []).filter((s) => request.scopes.includes(s));
    log.info("connection approved", { client: request.client.client_id, name: request.client.client_name, scopes: picked, by: who });
    res.redirect(302, oauth.approve(request, picked));
  });

  app.post("/login", limiter(10), form, (req, res) => {
    const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/";
    if (!sameOrigin(req, base)) return void res.status(403).send(errorPage("Blocked", "This form must be sent from this site."));
    if (!owner.checkPassword(req.body?.password)) {
      log.warn("wrong owner password", { ip: clientIp(req) });
      return void res.status(401).send(loginPage(`/login?next=${encodeURIComponent(next)}`, "Wrong password."));
    }
    owner.startSession(res);
    res.redirect(303, next);
  });

  app.get("/login", (_req, res) => void res.send(loginPage("/login?next=/")));
  app.get("/logout", (_req, res) => {
    owner.endSession(res);
    res.redirect(303, "/");
  });

  // ---------- dashboard ----------
  app.get("/", async (req, res) => {
    const who = await owner.identify(req);
    if (!who) {
      if (owner.mode === "password") return void res.send(loginPage("/login?next=/"));
      return void res.send(errorPage("Facteur", `This is a private MCP server. Its endpoint is ${mcpUrl}.`));
    }
    const date = (t?: number) => (t ? new Date(t).toLocaleString("sv-SE", { timeZone: cfg.timeZone }).slice(0, 16) : "never");
    const grants = store.grants().map((g) => {
      const c = store.client(g.client_id);
      return {
        id: g.id,
        client: c?.client_name ?? "Unnamed app",
        redirectHost: c ? hostOf(c.redirect_uris[0] ?? "") : "?",
        scopes: g.scopes,
        created: date(g.created_at),
        lastUsed: date(g.last_used_at),
      };
    });
    res.send(dashboardPage({ account: deps.mail.account, mcpUrl, owner: who, grants, ownerMode: owner.mode, tokenEnabled: Boolean(cfg.http.apiToken) }));
  });

  app.post("/grants/:id/revoke", limiter(60), async (req, res) => {
    if (!sameOrigin(req, base) || !(await owner.identify(req))) return void res.status(403).send(errorPage("Blocked", "Sign in first."));
    store.removeGrant(String(req.params.id));
    log.info("connection revoked from dashboard", { grant: req.params.id });
    res.redirect(303, "/");
  });

  // ---------- MCP ----------
  const verifier = {
    async verifyAccessToken(t: string): Promise<AuthInfo> {
      const v = oauth.verify(t);
      if (!v) throw new McpOAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired token");
      return {
        token: t,
        clientId: v.clientId,
        scopes: v.scopes,
        // the static token never expires; the SDK still wants a number
        expiresAt: v.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
        resource: new URL(v.resource),
      };
    },
  };

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const client = authInfo?.clientId ?? "unknown";
      const name = client === "api-token" ? "api-token" : (store.client(client)?.client_name ?? client);
      return buildServer({ ...deps, client: name, scopes: new Set(authInfo?.scopes ?? []) });
    },
    { responseMode: "json", legacy: "stateless", maxRequestBodySize: 40 * 1024 * 1024, onerror: (e) => log.error("mcp handler error", { error: e.message }) },
  );
  const nodeHandler = toNodeHandler(handler, { onerror: (e) => log.error("mcp adapter error", { error: e.message }), maxRequestBodySize: 40 * 1024 * 1024 });

  const auth = requireBearerAuth({ verifier, resourceMetadataUrl: prmUrl });
  app.post("/mcp", limiter(600, 60_000), auth, express.json({ limit: "40mb" }), (req, res) => void nodeHandler(req, res, req.body));
  app.get("/mcp", auth, (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "use POST" }));
  app.delete("/mcp", auth, (_req, res) => void res.sendStatus(405));

  app.use((_req, res) => void res.status(404).json({ error: "not found" }));

  return { app, close: () => handler.close().finally(() => store.flush()) };
}

function basicAuth(req: Request): { id: string; secret: string } | undefined {
  const h = req.headers.authorization;
  if (!h?.toLowerCase().startsWith("basic ")) return undefined;
  const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 0) return undefined;
  return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
}

function hostOf(u: string): string {
  try {
    const url = new URL(u);
    return url.host || `${url.protocol}//`;
  } catch {
    return u;
  }
}

/** forms are only accepted from our own pages (Origin, or Referer as a fallback) */
function sameOrigin(req: Request, base: string): boolean {
  const origin = (req.headers.origin as string | undefined) ?? refererOrigin(req.headers.referer);
  if (!origin) return true; // some browsers send neither on same-origin POSTs with no-referrer; cookies are SameSite=Lax
  return origin === new URL(base).origin;
}

function refererOrigin(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}
