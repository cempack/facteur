import { parseAddressList, type Address } from "./mail/address.ts";

/**
 * Everything Facteur reads from the environment, parsed once at boot.
 * See README.md for the full list and what each one does.
 */
export interface Config {
  bridge: {
    host: string;
    imapPort: number;
    smtpPort: number;
    user: string;
    password: string;
    /** "starttls" (Bridge's default), "tls" for implicit TLS, or "none" */
    tls: "starttls" | "tls" | "none";
    /** Bridge presents a self-signed certificate, so this is off by default */
    verifyTls: boolean;
    /** how many IMAP connections to keep open to Bridge at most */
    poolSize: number;
  };
  /** addresses mail can be sent from; the first one is the default */
  identities: Address[];
  transport: "http" | "stdio";
  http: {
    port: number;
    /** public origin, e.g. https://facteur.elliotmoreau.fr */
    publicUrl: string;
    /** a static bearer token with every scope, for scripts and CLI clients */
    apiToken?: string;
    /** password for the OAuth consent page, when Cloudflare Access isn't set up */
    adminPassword?: string;
    /** Cloudflare Access team domain (e.g. "elliot" for elliot.cloudflareaccess.com) */
    accessTeam?: string;
    /** Cloudflare Access application audience tag */
    accessAud?: string;
    /** trust X-Forwarded-For / CF-Connecting-IP (behind Traefik + Cloudflare) */
    trustProxy: boolean;
  };
  dataDir: string;
  /** dates in tool output are shown in this IANA time zone */
  timeZone: string;
  /** cap on attachment size returned to the model, in bytes */
  maxAttachmentBytes: number;
}

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false, got "${v}"`);
}

function required(name: string): string {
  const v = str(name);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): Config {
  const transport = (str("FACTEUR_TRANSPORT") ?? "http") as Config["transport"];
  if (transport !== "http" && transport !== "stdio") throw new Error(`FACTEUR_TRANSPORT must be http or stdio`);

  const tls = (str("BRIDGE_TLS") ?? "starttls") as Config["bridge"]["tls"];
  if (!["starttls", "tls", "none"].includes(tls)) throw new Error(`BRIDGE_TLS must be starttls, tls or none`);

  const user = required("BRIDGE_USER");
  const identities = parseAddressList(str("FACTEUR_FROM") ?? user);
  if (identities.length === 0) throw new Error("FACTEUR_FROM has no valid address");

  const port = int("PORT", 8080);
  const publicUrl = (str("FACTEUR_PUBLIC_URL") ?? `http://localhost:${port}`).replace(/\/+$/, "");

  const cfg: Config = {
    bridge: {
      host: str("BRIDGE_HOST") ?? "127.0.0.1",
      imapPort: int("BRIDGE_IMAP_PORT", 1143),
      smtpPort: int("BRIDGE_SMTP_PORT", 1025),
      user,
      password: required("BRIDGE_PASSWORD"),
      tls,
      verifyTls: bool("BRIDGE_TLS_VERIFY", false),
      poolSize: Math.max(1, int("BRIDGE_POOL_SIZE", 3)),
    },
    identities,
    transport,
    http: {
      port,
      publicUrl,
      apiToken: str("FACTEUR_API_TOKEN"),
      adminPassword: str("FACTEUR_ADMIN_PASSWORD"),
      accessTeam: str("FACTEUR_ACCESS_TEAM"),
      accessAud: str("FACTEUR_ACCESS_AUD"),
      trustProxy: bool("FACTEUR_TRUST_PROXY", true),
    },
    dataDir: str("FACTEUR_DATA_DIR") ?? "./data",
    timeZone: str("FACTEUR_TIMEZONE") ?? str("TZ") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    maxAttachmentBytes: int("FACTEUR_MAX_ATTACHMENT_MB", 15) * 1024 * 1024,
  };

  if (cfg.http.apiToken && cfg.http.apiToken.length < 24) throw new Error("FACTEUR_API_TOKEN must be at least 24 characters");
  if (Boolean(cfg.http.accessTeam) !== Boolean(cfg.http.accessAud)) throw new Error("set both FACTEUR_ACCESS_TEAM and FACTEUR_ACCESS_AUD, or neither");
  return cfg;
}
