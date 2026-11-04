import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";

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
    void this.ready
      .then(() => appendFile(this.file, line, { mode: 0o600 }))
      .catch((e) => log.warn("audit write failed", { error: String(e) }));
  }
}
