import { describe as suite, expect, it } from "vitest";
import { describe } from "../src/http/activity.ts";

const t = "2026-11-04T15:00:00.000Z";

suite("activity lines", () => {
  it("reads sends, deletes, reveals and failures", () => {
    expect(describe({ t, client: "Claude", tool: "reply_email", ok: true, subject: "Lunch", to: ["ana@x.com"], cc: [], attachments: 1, from: "me@x.com" }).title).toBe("Replied “Lunch”");
    const del = describe({ t, client: "Claude", tool: "delete_emails", ok: true, trashed: 2, deleted: 1 });
    expect(del.title).toBe("Moved 2 messages to Trash, deleted 1 for good");
    expect(describe({ t, client: "Claude", tool: "delete_emails", ok: true, trashed: 0, deleted: 1 }).title).toBe("Deleted 1 message for good");
    expect(del.sensitive).toBe(true);
    const rev = describe({ t, client: "Claude", tool: "pass_reveal", ok: true, mode: "value", field: "password", reason: "log in to the bank" });
    expect([rev.title, rev.sensitive]).toEqual(["Read a password", true]);
    expect(describe({ t, client: "Claude", tool: "move_emails", ok: false, error: "no mailbox" }).ok).toBe(false);
    expect(describe({ t, client: "owner", tool: "drive_signin", ok: true }).kind).toBe("owner");
    expect(describe({ t, client: "Claude", tool: "brand_new_tool", ok: true }).title).toBe("brand new tool");
  });
});
