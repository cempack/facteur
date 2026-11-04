import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { createMcpHandler, OAuthError as McpOAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { availableScopes, OPT_IN_SCOPES, type ToolContext } from "../mcp/context.ts";
import { buildServer } from "../mcp/server.ts";
import { OAuthError, OAuthProvider, sign, unsign, type AuthorizeRequest } from "./oauth/provider.ts";
import { OAuthStore } from "./oauth/store.ts";
import { describe as describeActivity } from "./activity.ts";
import { Connections, connectionsRouter } from "./connections.ts";
import { Owner } from "./owner.ts";
import { activityPage, consentPage, dashboardPage, errorPage, FONT_FILE, FONT_FILE_EXT, loginPage, revealConfirmPage, revealPage } from "./pages.ts";

type Deps = Omit<ToolContext, "client" | "scopes">;

export function createApp(cfg: Config, deps: Deps) {
  const base = cfg.http.publicUrl;
  const mcpUrl = `${base}/mcp`;
  const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const store = new OAuthStore(join(cfg.dataDir, "oauth.json"));
  const scopes = availableScopes(cfg);
  // the static token can't read Pass secrets unless FACTEUR_API_TOKEN_SCOPES says so
  const apiTokenScopes = cfg.http.apiTokenScopes ?? scopes.filter((s) => !OPT_IN_SCOPES.includes(s));
  const oauth = new OAuthProvider({ store, issuer: base, resource: mcpUrl, scopes, apiToken: cfg.http.apiToken, apiTokenScopes });
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
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // same-origin, not no-referrer: with no-referrer browsers send "Origin: null"
      // on form posts, which the same-origin check below has to refuse
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    next();
  });

  // ---------- assets ----------
  const font = (file: string) => (_req: Request, res: Response) => {
    res.set({ "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "font/woff2" });
    res.sendFile(file);
  };
  app.get("/assets/inter.woff2", font(FONT_FILE));
  app.get("/assets/inter-ext.woff2", font(FONT_FILE_EXT));

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
    scopes_supported: scopes,
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
        optIn: OPT_IN_SCOPES,
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
    if (picked.length) deps.audit.record({ client: request.client.client_name ?? "Unnamed app", tool: "connect", ok: true, scopes: picked });
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

  // with Cloudflare Access, Access itself is the sign-in page
  app.get("/login", (_req, res) => void (owner.mode === "password" ? res.send(loginPage("/login?next=/")) : res.redirect(303, "/")));
  app.get("/logout", (_req, res) => {
    owner.endSession(res);
    res.redirect(303, "/");
  });

  // ---------- one-time secret reveal (Pass, for apps that may not see secrets) ----------
  app.get("/reveal/:id", limiter(60), async (req, res) => {
    const who = await owner.identify(req);
    if (!who) {
      if (owner.mode === "password") return void res.send(loginPage(`/login?next=${encodeURIComponent(req.originalUrl)}`));
      return void res.status(403).send(errorPage("Not signed in", "Sign in first."));
    }
    const r = deps.reveals?.peek(String(req.params.id));
    if (!r) return void res.status(404).send(errorPage("Link expired", "This link was already used or is older than 10 minutes. Ask again."));
    res.send(revealConfirmPage({ title: r.title, field: r.field, client: r.client, reason: r.reason, action: `/reveal/${encodeURIComponent(String(req.params.id))}` }));
  });

  app.post("/reveal/:id", limiter(30), async (req, res) => {
    if (!sameOrigin(req, base) || !(await owner.identify(req))) return void res.status(403).send(errorPage("Blocked", "Sign in first."));
    const r = deps.reveals?.take(String(req.params.id));
    if (!r || !deps.pass) return void res.status(404).send(errorPage("Link expired", "This link was already used or is older than 10 minutes. Ask again."));
    try {
      const reason = `owner viewing it on the Facteur page, asked by ${r.client} (${r.reason})`;
      const value = /^(totp|2fa|otp|mfa)$/i.test(r.field) ? (await deps.pass.totp(r.ref, reason)).code : await deps.pass.field(r.ref, r.field, reason);
      deps.audit.record({ client: r.client, tool: "pass_reveal", ok: true, mode: "owner-page", field: r.field, title: r.title });
      res.send(revealPage({ title: r.title, field: r.field, value }));
    } catch (e) {
      res.status(502).send(errorPage("Couldn't read it", (e as Error).message));
    }
  });

  // ---------- connections (sign-in to Proton services) ----------
  if (deps.pass && deps.calendar) {
    const connections = new Connections({
      mail: deps.mail,
      mailer: deps.mailer,
      pass: deps.pass,
      calendar: deps.calendar,
      bridge: cfg.bridge,
      bridgePasswordFile: join(cfg.dataDir, "bridge", "password"),
      audit: deps.audit,
      ...(deps.drive && { drive: deps.drive }),
    });
    const guard = async (req: Request, res: Response, post: boolean): Promise<string | undefined> => {
      if (post && !sameOrigin(req, base)) {
        res.status(403).send(errorPage("Blocked", "This form must be sent from this site.", { href: "/connections", label: "Back to Connections" }));
        return undefined;
      }
      const who = await owner.identify(req);
      if (who) return who;
      if (!post && owner.mode === "password") res.send(loginPage(`/login?next=${encodeURIComponent(req.originalUrl)}`));
      else res.status(403).send(errorPage("Not signed in", "Sign in first.", { href: "/login", label: "Sign in" }));
      return undefined;
    };
    const bridgeHint = process.env.FACTEUR_BRIDGE_LOGIN_HINT ?? "open the Bridge CLI in its container and run login.";
    app.use("/connections", limiter(120));
    app.use(connectionsRouter(connections, guard, bridgeHint, owner.mode === "password"));
  }

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

  app.get("/activity", limiter(120), async (req, res) => {
    const who = await owner.identify(req);
    if (!who) {
      if (owner.mode === "password") return void res.send(loginPage(`/login?next=${encodeURIComponent(req.originalUrl)}`));
      return void res.status(403).send(errorPage("Not signed in", "Sign in first."));
    }
    const all = (await deps.audit.recent(400)).map(describeActivity);
    const apps = [...new Set(all.filter((i) => i.kind !== "owner").map((i) => i.client))].slice(0, 8);
    const app_ = typeof req.query.app === "string" ? req.query.app : undefined;
    const only = typeof req.query.only === "string" ? req.query.only : undefined;
    const items = all.filter((i) => (app_ ? i.client === app_ && i.kind !== "owner" : only === "sensitive" ? i.sensitive : only === "failed" ? !i.ok : true)).slice(0, 200);
    const current = app_ ? `app:${app_}` : only;
    res.send(activityPage({ items, apps, ...(current && { current }), timeZone: cfg.timeZone, owner: { owner: who, signOut: owner.mode === "password" } }));
  });

  app.post("/grants/:id/revoke", limiter(60), async (req, res) => {
    if (!sameOrigin(req, base) || !(await owner.identify(req))) return void res.status(403).send(errorPage("Blocked", "Sign in first."));
    const grant = store.grants().find((g) => g.id === String(req.params.id));
    store.removeGrant(String(req.params.id));
    log.info("connection revoked from dashboard", { grant: req.params.id });
    if (grant) deps.audit.record({ client: store.client(grant.client_id)?.client_name ?? "Unnamed app", tool: "disconnect", ok: true });
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

/** forms are only accepted from our own pages (Origin, or Referer when Origin is missing or "null") */
export function sameOrigin(req: Pick<Request, "headers">, base: string): boolean {
  const own = new URL(base).origin;
  const origin = req.headers.origin as string | undefined;
  if (origin && origin !== "null") return origin === own;
  const ref = refererOrigin(req.headers.referer);
  if (ref) return ref === own;
  // neither header: only non-browser clients do that, and they have no owner cookie (SameSite=Lax)
  return origin === undefined;
}

function refererOrigin(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}
