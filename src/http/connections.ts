import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Router } from "express";
import express from "express";
import type { Audit } from "../audit.ts";
import type { CalendarService } from "../calendar/service.ts";
import type { DriveService } from "../drive/service.ts";
import { log } from "../log.ts";
import type { Mailer } from "../mail/send.ts";
import type { MailService } from "../mail/service.ts";
import { TOKEN_RE, type PassService } from "../pass/service.ts";
import { connectionsPage, errorPage } from "./pages.ts";

/**
 * The owner's "Connections" page: the status of every Proton service and
 * one-click sign-in for the ones that need it now and then.
 *
 * Drive and Pass both sign in with Proton's "session fork": the CLI prints a
 * proton.me link, the owner opens it (on any device) and approves, the CLI
 * picks the session up. This page runs the CLI, shows the link, and refreshes
 * until it's done. For Pass it then renews Facteur's agent (1 year) with that
 * owner session, saves the agent token, and signs the owner session out.
 */

type Kind = "drive" | "pass";

interface Flow {
  kind: Kind;
  status: "starting" | "waiting" | "finishing" | "done" | "failed";
  url?: string;
  message?: string;
  started: number;
  child?: ChildProcess;
}

const FLOW_TTL = 11 * 60_000;

export interface ConnectionDeps {
  mail: MailService;
  mailer: Mailer;
  pass: PassService;
  drive?: DriveService;
  calendar: CalendarService;
  bridge: Config["bridge"];
  bridgePasswordFile: string;
  audit: Audit;
}

export class Connections {
  private flows = new Map<Kind, Flow>();
  private readonly d: ConnectionDeps;

  constructor(d: ConnectionDeps) {
    this.d = d;
  }

  flow(kind: Kind): Flow | undefined {
    const f = this.flows.get(kind);
    if (f && ["done", "failed"].includes(f.status) && Date.now() - f.started > FLOW_TTL) this.flows.delete(kind);
    return this.flows.get(kind);
  }

  // ---------- Drive ----------

  async startDrive() {
    const drive = this.d.drive;
    if (!drive) throw new Error("Drive is turned off (FACTEUR_DRIVE)");
    if (this.running("drive")) return;
    const f: Flow = { kind: "drive", status: "starting", started: Date.now() };
    this.flows.set("drive", f);
    try {
      await drive.ensureDir();
    } catch (e) {
      f.status = "failed";
      f.message = `couldn't create the Drive session folder: ${(e as Error).message}`;
      return;
    }
    this.runLogin(f, drive.cfg.bin, ["auth", "login"], { ...drive.env() }, drive.cfg.dir, async () => {
      f.status = "done";
      f.message = "Proton Drive is connected.";
      this.d.audit.record({ client: "owner", tool: "drive_signin", ok: true });
    });
  }

  async driveLogout() {
    const drive = this.d.drive;
    if (!drive) return;
    await new Promise<void>((resolve) => {
      const c = spawn(drive.cfg.bin, ["auth", "logout"], { env: drive.env(), cwd: drive.cfg.dir, stdio: "ignore" });
      c.on("close", () => resolve());
      c.on("error", () => resolve());
    });
    this.d.audit.record({ client: "owner", tool: "drive_signout", ok: true });
  }

  // ---------- Pass ----------

  startPass() {
    if (this.running("pass")) return;
    const f: Flow = { kind: "pass", status: "starting", started: Date.now() };
    this.flows.set("pass", f);
    // the owner's own session lives only for this flow, in a private temp dir
    const dir = mkdtempSync(join(tmpdir(), "facteur-owner-"));
    const env = { PATH: process.env.PATH, HOME: dir, PROTON_PASS_SESSION_DIR: dir, PROTON_PASS_KEY_PROVIDER: "fs", NO_COLOR: "1" };
    const bin = this.d.pass.bin;
    const cli = (args: string[], reason?: string) => runCli(bin, args, { ...env, ...(reason && { PROTON_PASS_AGENT_REASON: reason }) }, dir);
    const cleanup = async () => {
      await cli(["logout"]).catch(() => cli(["logout", "--force"]).catch(() => undefined));
      rmSync(dir, { recursive: true, force: true });
    };
    this.runLogin(
      f,
      bin,
      ["login"],
      env,
      dir,
      async () => {
        f.status = "finishing";
        f.message = "Signed in. Renewing Facteur's agent…";
        try {
          const agents = await cli(["agent", "list", "--output", "json"]).catch(() => "");
          const exists = /"facteur"/.test(agents) || /\bfacteur\b/.test(agents);
          let out: string;
          if (exists) {
            out = await cli(["agent", "renew", "--expiration", "1y", "--output", "json", "facteur"], "Facteur dashboard: renew the agent");
          } else {
            // first connection (or the agent was deleted): every vault, editor
            const vaults = (await cli(["vault", "list", "--output", "json"]).then(JSON.parse)) as { vaults?: { name: string }[] };
            const names = (vaults.vaults ?? []).map((v) => v.name);
            if (!names.length) throw new Error("your account has no vaults");
            out = await cli(["agent", "create", "--expiration", "1y", ...names.flatMap((n) => ["--vault", n]), "facteur"]);
            for (const n of names) await cli(["agent", "access", "grant", "facteur", "--vault-name", n, "--role", "editor"]).catch(() => undefined);
          }
          const token = TOKEN_RE.exec(out)?.[0];
          if (token) this.d.pass.setToken(token);
          else if (!exists) throw new Error("the agent was created but pass-cli didn't print its token");
          // renewing may keep the same token: then the current one simply lasts longer
          await this.d.pass.check();
          f.status = "done";
          f.message = exists ? "Facteur's Pass agent is renewed for a year." : "Facteur's Pass agent is created (all vaults, can edit) and connected.";
          log.info("pass agent connected from the dashboard", { renewed: exists, newToken: Boolean(token) });
          this.d.audit.record({ client: "owner", tool: "pass_agent", ok: true, renewed: exists });
        } catch (e) {
          f.status = "failed";
          f.message = (e as Error).message.replace(TOKEN_RE, "pst_***");
        } finally {
          await cleanup();
        }
      },
      cleanup,
    );
  }

  /** Bridge gives a new password after each sign-in: save it and reconnect */
  async setBridgePassword(p: string) {
    const pw = p.trim();
    if (pw.length < 8 || /\s/.test(pw)) throw new Error("that doesn't look like a Bridge password (shown by `info` in the Bridge CLI)");
    const old = this.d.bridge.password;
    this.d.bridge.password = pw;
    await this.d.mail.pool.reset();
    try {
      await this.d.mail.pool.withClient((c) => c.noop());
    } catch (e) {
      this.d.bridge.password = old;
      await this.d.mail.pool.reset();
      throw new Error(`Bridge refused it: ${(e as Error).message}`);
    }
    mkdirSync(dirname(this.d.bridgePasswordFile), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.d.bridgePasswordFile}.tmp`, pw + "\n", { mode: 0o600 });
    renameSync(`${this.d.bridgePasswordFile}.tmp`, this.d.bridgePasswordFile);
    this.d.mailer.reload();
    log.info("bridge password updated from the dashboard");
    this.d.audit.record({ client: "owner", tool: "bridge_password", ok: true });
  }

  addCalendar(name: string, url: string) {
    this.d.calendar.add(name, url);
    this.d.audit.record({ client: "owner", tool: "calendar_add", ok: true, name });
  }

  removeCalendar(name: string) {
    this.d.calendar.remove(name);
    this.d.audit.record({ client: "owner", tool: "calendar_remove", ok: true, name });
  }

  // ---------- shared ----------

  private running(kind: Kind) {
    const f = this.flows.get(kind);
    return f && ["starting", "waiting", "finishing"].includes(f.status) && Date.now() - f.started < FLOW_TTL;
  }

  /** run `<bin> <args>` until it exits; surface the proton.me link it prints */
  private runLogin(f: Flow, bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onDone: () => Promise<void>, onFail?: () => Promise<void>) {
    const child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    f.child = child;
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    const seen = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      const url = /https:\/\/[A-Za-z0-9.-]*proton\.me\/[^\s"'<>]+/.exec(output)?.[0];
      if (url && !f.url) {
        f.url = url;
        f.status = "waiting";
      }
    };
    child.stdout?.on("data", seen);
    child.stderr?.on("data", seen);
    child.stdin?.end();
    let spawnError: Error | undefined;
    child.on("error", (e) => {
      // e.g. the binary or the working directory is missing; "close" follows
      spawnError = e;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      f.child = undefined;
      if (spawnError) {
        f.status = "failed";
        f.message = `couldn't start ${bin.split("/").pop()}: ${spawnError.message}`;
        await onFail?.();
        return;
      }
      if (code === 0) return onDone().catch((e) => ((f.status = "failed"), (f.message = String(e))));
      f.status = "failed";
      const last = output.replace(TOKEN_RE, "pst_***").trim().split("\n").filter(Boolean).slice(-2).join(" ");
      f.message = code === null ? "The link wasn't approved within 10 minutes. Try again." : last || `exited with ${code}`;
      await onFail?.();
    });
  }

  // ---------- status ----------

  async status() {
    const settle = <T>(p: Promise<T>, ms = 8000) => Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error("timed out")), ms))]);
    const [imap, smtp, pass, drive] = await Promise.allSettled([
      settle(this.d.mail.pool.withClient((c) => c.noop())),
      settle(this.d.mailer.verify()),
      this.d.pass.token() ? settle(this.d.pass.check(), 20_000) : Promise.reject(new Error("not connected")),
      this.d.drive ? this.d.drive.signedIn() : Promise.resolve(false),
    ]);
    return {
      mail: { imap: imap.status === "fulfilled", smtp: smtp.status === "fulfilled", error: imap.status === "rejected" ? String(imap.reason?.message ?? imap.reason) : undefined },
      pass: { ok: pass.status === "fulfilled", source: this.d.pass.token()?.source, error: pass.status === "rejected" ? String(pass.reason?.message ?? pass.reason).replace(TOKEN_RE, "pst_***") : undefined },
      drive: { enabled: Boolean(this.d.drive), signedIn: drive.status === "fulfilled" && drive.value === true },
      calendars: this.d.calendar.sources.map((s) => ({ name: s.name, host: new URL(s.url).host, fromEnv: this.d.calendar.isFromEnv(s.name) })),
    };
  }
}

function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", (e) => (clearTimeout(t), reject(e)));
    c.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out + err);
      else reject(new Error(`pass-cli ${args.slice(0, 2).join(" ")}: ${err.replace(TOKEN_RE, "pst_***").trim().split("\n").slice(-2).join(" ") || `exit ${code}`}`));
    });
  });
}

/** routes; `guard` checks the owner (and same-origin for posts), answers if not, and returns who it is */
export function connectionsRouter(
  c: Connections,
  guard: (req: express.Request, res: express.Response, post: boolean) => Promise<string | undefined>,
  bridgeHint: string,
  signOut: boolean,
): Router {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: "8kb" });
  const back = (res: express.Response) => res.redirect(303, "/connections");

  r.get("/connections", async (req, res) => {
    const who = await guard(req, res, false);
    if (!who) return;
    res.send(connectionsPage(await c.status(), { drive: c.flow("drive"), pass: c.flow("pass") }, bridgeHint, { owner: who, signOut }));
  });
  r.post("/connections/drive/login", async (req, res) => {
    if (!(await guard(req, res, true))) return;
    await c.startDrive();
    back(res);
  });
  r.post("/connections/drive/logout", async (req, res) => {
    if (!(await guard(req, res, true))) return;
    await c.driveLogout();
    back(res);
  });
  r.post("/connections/pass/login", async (req, res) => {
    if (!(await guard(req, res, true))) return;
    c.startPass();
    back(res);
  });
  r.post("/connections/bridge/password", form, async (req, res) => {
    if (!(await guard(req, res, true))) return;
    try {
      await c.setBridgePassword(String(req.body?.password ?? ""));
    } catch (e) {
      return void res.status(400).send(errorPage("Couldn't update it", (e as Error).message, { href: "/connections", label: "Back to Connections" }));
    }
    back(res);
  });
  r.post("/connections/calendars/add", form, async (req, res) => {
    if (!(await guard(req, res, true))) return;
    try {
      c.addCalendar(String(req.body?.name ?? ""), String(req.body?.url ?? ""));
    } catch (e) {
      return void res.status(400).send(errorPage("Couldn't add it", (e as Error).message, { href: "/connections", label: "Back to Connections" }));
    }
    back(res);
  });
  r.post("/connections/calendars/remove", form, async (req, res) => {
    if (!(await guard(req, res, true))) return;
    c.removeCalendar(String(req.body?.name ?? ""));
    back(res);
  });
  return r;
}
