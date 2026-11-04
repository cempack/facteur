import { describe, expect, it } from "vitest";
import { sameOrigin } from "../src/http/app.ts";

const req = (headers: Record<string, string>) => ({ headers }) as never;
const BASE = "https://facteur.example.com";

describe("sameOrigin", () => {
  it("accepts our own forms and refuses others", () => {
    expect(sameOrigin(req({ origin: BASE }), BASE)).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.example" }), BASE)).toBe(false);
    // Origin: null (sandboxed frames, no-referrer pages) needs a matching Referer
    expect(sameOrigin(req({ origin: "null" }), BASE)).toBe(false);
    expect(sameOrigin(req({ origin: "null", referer: `${BASE}/connections` }), BASE)).toBe(true);
    expect(sameOrigin(req({ referer: "https://evil.example/x" }), BASE)).toBe(false);
  });
});
