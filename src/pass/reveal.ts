import { randomBytes } from "node:crypto";
import type { ItemRef } from "./service.ts";

/**
 * One-time reveal links, for apps that may not see secrets: the model gets a
 * link, the owner opens it (signed in), and the value goes from Pass to the
 * owner's screen without ever passing through the AI. Links live in memory,
 * for 10 minutes, and work once.
 */
export interface PendingReveal {
  ref: ItemRef;
  title: string;
  field: string;
  client: string;
  reason: string;
  expires: number;
}

const TTL = 10 * 60_000;

export class RevealStore {
  private pending = new Map<string, PendingReveal>();

  create(r: Omit<PendingReveal, "expires">): string {
    this.sweep();
    const id = randomBytes(24).toString("base64url");
    this.pending.set(id, { ...r, expires: Date.now() + TTL });
    return id;
  }

  peek(id: string): PendingReveal | undefined {
    const r = this.pending.get(id);
    return r && r.expires > Date.now() ? r : undefined;
  }

  /** single use: gone after this */
  take(id: string): PendingReveal | undefined {
    const r = this.peek(id);
    this.pending.delete(id);
    return r;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    if (this.pending.size > 200) this.pending.clear();
  }
}
