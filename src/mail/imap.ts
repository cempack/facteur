import { ImapFlow } from "imapflow";
import type { Config } from "../config.ts";
import { log } from "../log.ts";

/**
 * A small pool of IMAP connections to Proton Mail Bridge.
 *
 * One IMAP connection has one selected mailbox at a time, so concurrent tool
 * calls each borrow their own connection. Connections are opened lazily,
 * reused while healthy, and closed after a few idle minutes so Bridge isn't
 * holding sessions nobody uses.
 */
export class ImapPool {
  private idle: { client: ImapFlow; since: number }[] = [];
  private open = 0;
  private waiters: { resolve: (c: ImapFlow) => void; reject: (e: unknown) => void }[] = [];
  private sweeper: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly bridge: Config["bridge"];
  private readonly idleMs: number;

  constructor(bridge: Config["bridge"], idleMs = 3 * 60_000) {
    this.bridge = bridge;
    this.idleMs = idleMs;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  /** borrow a connection for the length of `fn` */
  async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    let healthy = true;
    try {
      return await fn(client);
    } catch (e) {
      // a protocol or socket error leaves the connection in an unknown state
      if (!client.usable || isConnectionError(e)) healthy = false;
      throw e;
    } finally {
      this.release(client, healthy);
    }
  }

  /** borrow a connection with `path` selected (read-write unless readOnly) */
  async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    return this.withClient(async (client) => {
      const lock = await client.getMailboxLock(path, { readOnly: opts.readOnly ?? false });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  /** log out idle connections; busy ones are dropped when they come back */
  async reset() {
    const all = this.idle.splice(0);
    this.open = Math.max(0, this.open - all.length);
    await Promise.allSettled(all.map(({ client }) => client.logout()));
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweeper);
    const all = this.idle.splice(0);
    await Promise.allSettled(all.map(({ client }) => client.logout()));
  }

  private async acquire(): Promise<ImapFlow> {
    if (this.closed) throw new Error("mail connection pool is closed");
    while (this.idle.length) {
      const { client } = this.idle.pop()!;
      if (client.usable) return client;
      this.drop(client);
    }
    if (this.open < this.bridge.poolSize) {
      this.open++;
      try {
        return await this.connect();
      } catch (e) {
        this.open--;
        throw e;
      }
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(client: ImapFlow, healthy: boolean) {
    if (!healthy || !client.usable || this.closed) {
      this.drop(client);
      this.pump();
      return;
    }
    const next = this.waiters.shift();
    if (next) next.resolve(client);
    else this.idle.push({ client, since: Date.now() });
  }

  /** a slot freed up: open a fresh connection for the first waiting call */
  private pump() {
    if (!this.waiters.length || this.open >= this.bridge.poolSize || this.closed) return;
    const next = this.waiters.shift()!;
    this.open++;
    this.connect().then(next.resolve, (e) => {
      this.open--;
      next.reject(e);
    });
  }

  private drop(client: ImapFlow) {
    this.open = Math.max(0, this.open - 1);
    client.close();
  }

  private sweep() {
    const now = Date.now();
    const keep: typeof this.idle = [];
    for (const entry of this.idle) {
      if (now - entry.since > this.idleMs || !entry.client.usable) {
        this.open = Math.max(0, this.open - 1);
        entry.client.logout().catch(() => entry.client.close());
      } else keep.push(entry);
    }
    this.idle = keep;
  }

  private async connect(): Promise<ImapFlow> {
    const b = this.bridge;
    const client = new ImapFlow({
      host: b.host,
      port: b.imapPort,
      secure: b.tls === "tls",
      doSTARTTLS: b.tls === "starttls" ? true : b.tls === "none" ? false : undefined,
      auth: { user: b.user, pass: b.password },
      tls: b.verifyTls ? { rejectUnauthorized: true, servername: b.host } : { rejectUnauthorized: false },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 5 * 60_000,
    });
    // without a listener, a socket error would crash the process
    client.on("error", (e: Error) => log.warn("imap connection error", { error: e.message }));
    await client.connect();
    return client;
  }
}

function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  return /^(ECONN|EPIPE|ETIMEDOUT|NoConnection|ClosedAfterConnect)/i.test(code);
}
