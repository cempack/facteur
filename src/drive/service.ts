import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";

/**
 * Proton Drive through Proton's official `proton-drive` CLI (built on the
 * Drive SDK). Every call is one short-lived CLI process, run with execFile
 * and an argument array (never a shell), with `--json` and `--` before the
 * positional arguments.
 *
 * The CLI keeps its session, caches and logs in PROTON_DRIVE_CACHE_DIR. In
 * the container there is no OS keyring, so the session is the plaintext
 * `auth-session.json` file the CLI writes when
 * PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file, inside a 0700 directory on the
 * data volume. The owner signs in once with `proton-drive auth login`.
 */

export interface DriveConfig {
  /** the proton-drive executable */
  bin: string;
  /** PROTON_DRIVE_CACHE_DIR: session, caches, events, logs */
  dir: string;
  timeoutMs: number;
  /** slower calls: upload and download */
  transferTimeoutMs: number;
}

export function driveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DriveConfig {
  const secs = (name: string, def: number) => {
    const n = Number(env[name]);
    return (Number.isFinite(n) && n > 0 ? n : def) * 1000;
  };
  return {
    bin: env.FACTEUR_DRIVE_BIN || "proton-drive",
    dir: env.PROTON_DRIVE_CACHE_DIR || join(env.FACTEUR_DATA_DIR || "./data", "drive"),
    timeoutMs: secs("FACTEUR_DRIVE_TIMEOUT_S", 60),
    transferTimeoutMs: secs("FACTEUR_DRIVE_TRANSFER_TIMEOUT_S", 600),
  };
}

export const LOGIN_HINT = "run `proton-drive auth login` inside the Facteur container (docker exec -it <container> proton-drive auth login) and open the URL it prints";

// ---------- validation ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * An absolute Drive path such as "/my-files/Docs/a.pdf". The CLI escapes a
 * slash inside a name as "\/", which is kept as is.
 */
export function checkDrivePath(p: string): string {
  if (typeof p !== "string" || !p) throw new Error("a Drive path is required, e.g. /my-files/Documents");
  if (CONTROL.test(p)) throw new Error("Drive paths can't contain control characters");
  if (p.length > 4096) throw new Error("Drive path is too long");
  if (!p.startsWith("/")) throw new Error(`Drive paths are absolute and start with /, e.g. /my-files/${p.replace(/^-+/, "")}`);
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (trimmed.includes("//")) throw new Error(`invalid Drive path "${p}": empty segment`);
  for (const seg of trimmed.split("/").slice(1)) {
    if (seg === ".." || seg === ".") throw new Error(`invalid Drive path "${p}": "." and ".." aren't allowed`);
    if (seg.startsWith("-")) throw new Error(`invalid Drive path "${p}": a segment can't start with "-"`);
  }
  return trimmed || "/";
}

/** a single file or folder name (create-folder, rename, upload) */
export function checkName(name: string): string {
  if (typeof name !== "string" || !name.trim()) throw new Error("a name is required");
  if (CONTROL.test(name)) throw new Error("names can't contain control characters");
  if (name.includes("/") || name.includes("\\")) throw new Error(`invalid name "${name}": no slashes`);
  if (name === "." || name === "..") throw new Error(`invalid name "${name}"`);
  if (name.startsWith("-")) throw new Error(`invalid name "${name}": can't start with "-"`);
  if (Buffer.byteLength(name) > 255) throw new Error("name is too long (255 bytes at most)");
  return name;
}

/** join a parent path and a child's raw name, escaping "/" the way the CLI expects */
export function childPath(parent: string, name: string): string {
  const esc = name.replace(/\\/g, "\\\\").replace(/\//g, "\\/");
  return parent === "/" ? `/${esc}` : `${parent}/${esc}`;
}

export type FileConflict = "rename" | "new_revision" | "replace" | "skip";
const FILE_CONFLICT: Record<FileConflict, string> = {
  rename: "rename",
  new_revision: "create-new-revision",
  replace: "replace",
  skip: "skip",
};

export type ShareRole = "viewer" | "editor" | "admin";

const emailRe = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
function checkEmail(e: string): string {
  if (!emailRe.test(e) || e.startsWith("-")) throw new Error(`invalid email address "${e}"`);
  return e;
}

/**
 * Argument arrays for each CLI command. Options come first, then `--`, then
 * the positional arguments, so nothing user-supplied is read as a flag.
 */
export const driveArgs = {
  list: (path: string, type?: "file" | "folder") => [
    "filesystem", "list", "--json", ...(type ? ["--type", type] : []), "--", checkDrivePath(path),
  ],
  info: (path: string) => ["filesystem", "info", "--json", "--", checkDrivePath(path)],
  size: (path: string) => ["filesystem", "size", "--json", "--", checkDrivePath(path)],
  createFolder: (parent: string, name: string) => ["filesystem", "create-folder", "--json", "--", checkDrivePath(parent), checkName(name)],
  rename: (path: string, newName: string) => ["filesystem", "rename", "--json", "--", checkDrivePath(path), checkName(newName)],
  move: (paths: string[], to: string) => ["filesystem", "move", "--json", "--", ...nonEmpty(paths).map(checkDrivePath), checkDrivePath(to)],
  trash: (paths: string[]) => ["filesystem", "trash", "--json", "--", ...nonEmpty(paths).map(checkDrivePath)],
  restore: (paths: string[]) => ["filesystem", "restore", "--json", "--", ...nonEmpty(paths).map(checkDrivePath)],
  upload: (localFile: string, parent: string, ifExists: FileConflict) => [
    "filesystem", "upload", "--json",
    "--file-conflict-strategy", FILE_CONFLICT[ifExists],
    "--folder-conflict-strategy", "skip",
    "--", localFile, checkDrivePath(parent),
  ],
  download: (path: string, localDir: string) => [
    "filesystem", "download", "--json",
    "--file-conflict-strategy", "rename",
    "--folder-conflict-strategy", "skip",
    "--", checkDrivePath(path), localDir,
  ],
  sharingStatus: (path: string) => ["sharing", "status", "--json", "--", checkDrivePath(path)],
  setUrl: (path: string, o: { role?: "viewer" | "editor"; password?: string; expiration?: string }) => {
    const a = ["sharing", "set-url", "--json", "--role", o.role ?? "viewer"];
    if (o.password) {
      if (CONTROL.test(o.password)) throw new Error("the link password can't contain control characters");
      a.push(`--password=${o.password}`);
    }
    if (o.expiration) {
      if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(o.expiration) || isNaN(Date.parse(o.expiration))) {
        throw new Error(`expiration must be an ISO date like 2026-12-31, got "${o.expiration}"`);
      }
      a.push("--expiration", o.expiration);
    }
    return [...a, "--", checkDrivePath(path)];
  },
  removeUrl: (path: string) => ["sharing", "remove-url", "--json", "--", checkDrivePath(path)],
  invite: (path: string, emails: string[], role: ShareRole, message?: string) => {
    const a = ["sharing", "invite", "--json", "--role", role];
    for (const e of nonEmpty(emails)) a.push("--user", checkEmail(e));
    if (message) {
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) throw new Error("the message can't contain control characters");
      a.push(`--message=${message}`);
    }
    return [...a, "--", checkDrivePath(path)];
  },
  removeAccess: (path: string, emails: string[] | "everyone") => {
    const a = ["sharing", "remove", "--json"];
    if (emails === "everyone") a.push("--everyone");
    else for (const e of nonEmpty(emails)) a.push("--email", checkEmail(e));
    return [...a, "--", checkDrivePath(path)];
  },
};

function nonEmpty(a: string[]): string[] {
  if (!a.length) throw new Error("give at least one path");
  if (a.length > 100) throw new Error("100 paths at most per call");
  return a;
}

// ---------- output ----------

/**
 * The CLI prints one JSON value per command: an object on one line, or a
 * streamed array ("[", one item per line, "]"). Anything printed before it
 * (progress, notices) is skipped.
 */
export function parseCliJson(stdout: string): unknown {
  const s = stdout.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const lines = s.split("\n");
  const start = lines.lastIndexOf("[");
  if (start >= 0) {
    try {
      return JSON.parse(lines.slice(start).join("\n"));
    } catch {
      // fall through
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (l.startsWith("{") || l.startsWith("[")) {
      try {
        return JSON.parse(l);
      } catch {
        // keep looking
      }
    }
  }
  throw new Error("Proton Drive returned output Facteur couldn't read");
}

/** a short, readable message from the CLI's stderr */
export function cliError(stderr: string, fallback: string): Error {
  const lines = stderr
    .split("\n")
    .map((l) => l.replace(new RegExp(CONTROL.source, "g"), " ").replace(/^Trace:\s*/, "").trim())
    .filter((l) => l && !l.startsWith("===") && !/^at\s/.test(l) && !l.startsWith("Usage:"));
  const all = lines.join(" ");
  if (/need to login|not logged in|log in first|sign in first|invalid refresh token|session (has )?expired|refresh token/i.test(all)) {
    return new Error(`Proton Drive is not signed in: ${LOGIN_HINT}`);
  }
  if (/insufficient quota|storage quota|not enough space/i.test(all)) {
    return new Error("Proton Drive is out of storage space");
  }
  const msg = (lines.find((l) => /error|not found|invalid|cannot|can't|failed|denied|exists/i.test(l)) ?? lines[0] ?? fallback).slice(0, 300);
  return new Error(`Proton Drive: ${msg}`);
}

// ---------- shapes the CLI returns (SDK NodeEntity, simplified) ----------

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface DriveNode {
  uid: string;
  parentUid?: string;
  name: Result<string> | string;
  type: "file" | "folder" | "album" | "photo" | string;
  mediaType?: string;
  isShared?: boolean;
  isSharedByUrl?: boolean;
  creationTime?: string;
  modificationTime?: string;
  trashTime?: string;
  totalStorageSize?: number;
  directRole?: string;
  ownedBy?: { email?: string; organization?: string };
  activeRevision?: { claimedSize?: number; storageSize?: number; claimedModificationTime?: string; contentAuthor?: Result<string | null> };
  keyAuthor?: Result<string | null>;
}

export function nodeName(n: DriveNode | { path: string }): string {
  if ("path" in n) return n.path;
  const r = n.name;
  if (typeof r === "string") return r;
  if (r?.ok) return r.value;
  // InvalidNameError: { name, error } with the name as claimed
  const e = r?.error as { name?: unknown; error?: unknown } | undefined;
  return typeof e?.name === "string" && typeof e?.error === "string" ? e.name : n.uid;
}

export function nodeSize(n: DriveNode): number | undefined {
  return n.activeRevision?.claimedSize ?? n.activeRevision?.storageSize ?? n.totalStorageSize;
}

export interface TransferSummary {
  transferredItems: number;
  transferredBytes: number;
  skippedItems: number;
  failedItems: number;
  failures?: { name: string; nodeUid?: string; error: string }[];
}

export type ItemResult = { uid: string; ok: boolean; error?: { message?: string } | string };

export interface ShareInfo {
  members?: { inviteeEmail: string; role: string }[];
  protonInvitations?: { inviteeEmail: string; role: string }[];
  nonProtonInvitations?: { inviteeEmail: string; role: string; state?: string }[];
  urlAccess?: { url: string; role: string; customPassword?: string; expirationTime?: string; numberOfInitializedDownloads?: number };
  editorsCanShare?: boolean;
}

// ---------- the service ----------

export class DriveService {
  readonly cfg: DriveConfig;
  /** one CLI process at a time: they share a session file whose refresh token rotates */
  private queue: Promise<unknown> = Promise.resolve();
  private ready?: Promise<void>;

  constructor(cfg: DriveConfig = driveConfigFromEnv()) {
    this.cfg = cfg;
  }

  /** the session file exists (cheap; doesn't prove it is still valid) */
  async signedIn(): Promise<boolean> {
    return access(join(this.cfg.dir, "auth-session.json")).then(
      () => true,
      () => false,
    );
  }

  /** the session dir may not exist yet (a data volume created before Drive was added) */
  ensureDir() {
    this.ready ??= (async () => {
      await mkdir(this.cfg.dir, { recursive: true, mode: 0o700 });
      await chmod(this.cfg.dir, 0o700).catch(() => undefined);
    })();
    return this.ready;
  }

  /**
   * Only what the CLI needs: no Bridge password, API token or other Facteur
   * secrets reach the child process.
   */
  env(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? this.cfg.dir,
      PROTON_DRIVE_CACHE_DIR: this.cfg.dir,
      PROTON_DRIVE_CREDENTIALS_STORE: process.env.PROTON_DRIVE_CREDENTIALS_STORE || "unsafe_file",
      PROTON_DRIVE_LOG_LEVEL: process.env.PROTON_DRIVE_LOG_LEVEL || "WARNING",
      NO_COLOR: "1",
    };
    for (const k of ["TZ", "LANG", "LC_ALL", "PROTON_DRIVE_BASE_URL", "PROTON_DRIVE_UNSAFE_CACHE", "SSL_CERT_FILE", "HTTPS_PROXY", "NO_PROXY"]) {
      if (process.env[k]) e[k] = process.env[k];
    }
    return e;
  }

  /** run one CLI command and parse its JSON output */
  async run<T = unknown>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
    const job = this.queue.then(() => this.exec(args, opts.timeoutMs ?? this.cfg.timeoutMs));
    this.queue = job.catch(() => undefined);
    return (await job) as T;
  }

  private async exec(args: string[], timeoutMs: number): Promise<unknown> {
    await this.ensureDir();
    const started = Date.now();
    // the command name only: paths and names can be private
    const what = args.slice(0, 2).join(" ");
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.cfg.bin,
        args,
        { env: this.env(), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, windowsHide: true, cwd: this.cfg.dir },
        (err, stdout, stderr) => {
          const ms = Date.now() - started;
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
            if (e.code === "ENOENT") {
              return reject(new Error(`the proton-drive CLI isn't installed here (looked for "${this.cfg.bin}"; set FACTEUR_DRIVE_BIN)`));
            }
            if (e.killed || e.signal === "SIGKILL") {
              log.warn("drive timeout", { cmd: what, ms });
              return reject(new Error(`Proton Drive didn't answer within ${Math.round(timeoutMs / 1000)} s (${what})`));
            }
            const error = cliError(String(stderr), `${what} failed`);
            log.warn("drive error", { cmd: what, ms, error: error.message });
            return reject(error);
          }
          log.debug("drive", { cmd: what, ms });
          try {
            resolve(parseCliJson(String(stdout)));
          } catch (pe) {
            reject(pe as Error);
          }
        },
      );
      // the CLI prompts on conflicts without a strategy; never let it wait
      child.stdin?.end();
    });
  }

  // ---------- reads ----------

  async list(path: string, type?: "file" | "folder"): Promise<(DriveNode | { path: string })[]> {
    const out = await this.run<unknown>(driveArgs.list(path, type));
    return Array.isArray(out) ? (out as DriveNode[]) : [];
  }

  /**
   * Walk a folder breadth-first, one CLI call per folder, up to `maxFolders`
   * folders and `maxEntries` entries.
   */
  async walk(
    root: string,
    o: { maxDepth: number; maxFolders: number; maxEntries: number; type?: "file" | "folder" },
  ): Promise<{ entries: { path: string; depth: number; node: DriveNode }[]; truncated: boolean }> {
    const entries: { path: string; depth: number; node: DriveNode }[] = [];
    const queue: { path: string; depth: number }[] = [{ path: checkDrivePath(root), depth: 0 }];
    let folders = 0;
    let truncated = false;
    while (queue.length) {
      const dir = queue.shift()!;
      if (folders++ >= o.maxFolders) {
        truncated = true;
        break;
      }
      const children = await this.list(dir.path);
      for (const c of children) {
        if ("path" in c) continue;
        const p = childPath(dir.path, nodeName(c));
        if (c.type === "folder" && dir.depth + 1 < o.maxDepth) queue.push({ path: p, depth: dir.depth + 1 });
        if (o.type && c.type !== o.type) continue;
        if (entries.length >= o.maxEntries) {
          truncated = true;
          break;
        }
        entries.push({ path: p, depth: dir.depth, node: c });
      }
      if (entries.length >= o.maxEntries) {
        truncated ||= queue.length > 0;
        break;
      }
    }
    return { entries, truncated: truncated || queue.length > 0 };
  }

  info(path: string): Promise<DriveNode> {
    return this.run<DriveNode>(driveArgs.info(path));
  }

  folderSize(path: string): Promise<Record<string, unknown>> {
    return this.run<Record<string, unknown>>(driveArgs.size(path));
  }

  sharingStatus(path: string): Promise<ShareInfo> {
    return this.run<ShareInfo>(driveArgs.sharingStatus(path));
  }

  /** download one file into memory, refusing anything over maxBytes */
  async download(path: string, maxBytes: number): Promise<{ name: string; contentType: string; data: Buffer; node: DriveNode }> {
    const node = await this.info(path);
    if (node.type !== "file" && node.type !== "photo") throw new Error(`${path} is a ${node.type}, not a file; use drive_list to see what's inside`);
    const size = nodeSize(node);
    if (size !== undefined && size > maxBytes) throw new Error(`${nodeName(node)} is ${mb(size)}, over the ${mb(maxBytes)} limit`);
    const dir = await mkdtemp(join(tmpdir(), "facteur-drive-"));
    try {
      await chmod(dir, 0o700);
      const summary = await this.run<TransferSummary>(driveArgs.download(path, dir), { timeoutMs: this.cfg.transferTimeoutMs });
      if (summary?.failedItems) throw new Error(`download failed: ${summary.failures?.[0]?.error ?? "unknown error"}`);
      const files = await readdir(dir);
      const file = files[0];
      if (!file) throw new Error(`nothing was downloaded (Proton Docs and Sheets can't be downloaded)`);
      const full = join(dir, file);
      const st = await stat(full);
      if (!st.isFile()) throw new Error(`${path} didn't download as a single file`);
      if (st.size > maxBytes) throw new Error(`${file} is ${mb(st.size)}, over the ${mb(maxBytes)} limit`);
      const data = await readFile(full);
      return { name: nodeName(node), contentType: node.mediaType || "application/octet-stream", data, node };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------- writes ----------

  /** upload bytes as `<parent>/<name>` through a private temp file */
  async upload(parent: string, name: string, data: Buffer, ifExists: FileConflict): Promise<TransferSummary> {
    checkName(name);
    const args = (local: string) => driveArgs.upload(local, parent, ifExists);
    args("/x"); // validate before touching the disk
    const dir = await mkdtemp(join(tmpdir(), "facteur-drive-"));
    try {
      await chmod(dir, 0o700);
      const local = join(dir, name);
      await writeFile(local, data, { mode: 0o600 });
      const summary = await this.run<TransferSummary>(args(local), { timeoutMs: this.cfg.transferTimeoutMs });
      if (summary?.failedItems) throw new Error(`upload failed: ${summary.failures?.[0]?.error ?? "unknown error"}`);
      return summary;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  createFolder(parent: string, name: string): Promise<DriveNode> {
    return this.run<DriveNode>(driveArgs.createFolder(parent, name));
  }

  rename(path: string, newName: string): Promise<DriveNode> {
    return this.run<DriveNode>(driveArgs.rename(path, newName));
  }

  async move(paths: string[], to: string): Promise<ItemResult[]> {
    return asItems(await this.run(driveArgs.move(paths, to)));
  }

  async trash(paths: string[]): Promise<ItemResult[]> {
    return asItems(await this.run(driveArgs.trash(paths)));
  }

  async restore(paths: string[]): Promise<ItemResult[]> {
    return asItems(await this.run(driveArgs.restore(paths)));
  }

  setUrl(path: string, o: { role?: "viewer" | "editor"; password?: string; expiration?: string }): Promise<ShareInfo> {
    return this.run<ShareInfo>(driveArgs.setUrl(path, o));
  }

  removeUrl(path: string): Promise<ShareInfo> {
    return this.run<ShareInfo>(driveArgs.removeUrl(path));
  }

  invite(path: string, emails: string[], role: ShareRole, message?: string): Promise<ShareInfo> {
    return this.run<ShareInfo>(driveArgs.invite(path, emails, role, message));
  }

  removeAccess(path: string, emails: string[] | "everyone"): Promise<ShareInfo> {
    return this.run<ShareInfo>(driveArgs.removeAccess(path, emails));
  }
}

function asItems(out: unknown): ItemResult[] {
  return Array.isArray(out) ? (out as ItemResult[]) : [];
}

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
