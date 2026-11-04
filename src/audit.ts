import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";

export interface AuditEntry {
  t: string;
  client: string;
  tool: string;
  ok: boolean;
  [k: string]: unknown;
}

/** the log is rotated past this size (one previous file is kept) */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * An append-only record of every change an AI made: which client, which
 * tool, which messages, and for sends the recipients and subject (never the
 * body). It lives next to the OAuth state in the data directory.
 */
export class Audit {
  private readonly file: string;
  private ready: Promise<unknown>;

  constructor(dataDir: string) {
    this.file = join(dataDir, "audit.jsonl");
    this.ready = mkdir(dataDir, { recursive: true }).catch(() => undefined);
  }

  record(entry: { client: string; tool: string; ok: boolean; [k: string]: unknown }) {
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n";
    log.info("audit", entry);
    this.ready = this.ready
      .then(async () => {
        const size = await stat(this.file).then((s) => s.size, () => 0);
        if (size > MAX_BYTES) await rename(this.file, `${this.file}.1`);
        await appendFile(this.file, line, { mode: 0o600 });
      })
      .catch((e) => log.warn("audit write failed", { error: String(e) }));
  }

  /** the newest entries first (reads only the end of the file) */
  async recent(limit = 300): Promise<AuditEntry[]> {
    await this.ready;
    let fh;
    try {
      fh = await open(this.file, "r");
    } catch {
      return [];
    }
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      if (len < size) lines.shift(); // first line may be cut
      const out: AuditEntry[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const l = lines[i]!.trim();
        if (!l) continue;
        try {
          out.push(JSON.parse(l) as AuditEntry);
        } catch {
          /* skip a damaged line */
        }
      }
      return out;
    } finally {
      await fh.close();
    }
  }
}
