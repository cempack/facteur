import type { Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import { sign, unsign } from "./oauth/provider.ts";

/**
 * Who may approve connections and see the dashboard: the mailbox owner.
 *
 * - With Cloudflare Access (FACTEUR_ACCESS_TEAM + FACTEUR_ACCESS_AUD), the
 *   Access JWT on the request is verified against the team's keys. A
 *   password is never needed.
 * - Otherwise FACTEUR_ADMIN_PASSWORD, exchanged for a signed cookie that
 *   lasts FACTEUR_SESSION_DAYS (30 by default).
 */
export const SESSION_COOKIE = "facteur_owner";

export type OwnerMode = "access" | "password" | "none";

export class Owner {
  readonly mode: OwnerMode;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer?: string;
  private readonly aud?: string;
  private readonly passwordHash?: Buffer;
  private readonly secret: string;
  private readonly secure: boolean;
  private readonly sessionMs: number;

  constructor(http: Config["http"], secret: string) {
    this.secret = secret;
    this.sessionMs = http.sessionDays * 86_400_000;
    this.secure = http.publicUrl.startsWith("https://");
    if (http.accessTeam && http.accessAud) {
      this.mode = "access";
      const team = http.accessTeam.replace(/\.cloudflareaccess\.com$/, "");
      this.issuer = `https://${team}.cloudflareaccess.com`;
      this.aud = http.accessAud;
      this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`));
    } else if (http.adminPassword) {
      this.mode = "password";
      this.passwordHash = createHash("sha256").update(http.adminPassword).digest();
    } else {
      this.mode = "none";
    }
  }

  /** the owner's identity (email, or "owner"), or undefined */
  async identify(req: Request): Promise<string | undefined> {
    if (this.mode === "access") {
      const jwt = (req.headers["cf-access-jwt-assertion"] as string | undefined) ?? cookie(req, "CF_Authorization");
      if (!jwt || !this.jwks) return undefined;
      try {
        const { payload } = await jwtVerify(jwt, this.jwks, { issuer: this.issuer!, audience: this.aud! });
        return (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? "owner";
      } catch {
        return undefined;
      }
    }
    if (this.mode === "password") {
      return unsign<{ owner: true }>(this.secret, cookie(req, SESSION_COOKIE))?.owner ? "owner" : undefined;
    }
    return undefined;
  }

  checkPassword(given: unknown): boolean {
    if (this.mode !== "password" || typeof given !== "string" || !this.passwordHash) return false;
    const h = createHash("sha256").update(given).digest();
    return timingSafeEqual(h, this.passwordHash);
  }

  startSession(res: Response) {
    res.cookie(SESSION_COOKIE, sign(this.secret, { owner: true }, this.sessionMs), {
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      path: "/",
      maxAge: this.sessionMs,
    });
  }

  endSession(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}

export function cookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
