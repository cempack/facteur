import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OAuthProvider, sign, unsign } from "../src/http/oauth/provider.ts";
import { OAuthStore } from "../src/http/oauth/store.ts";

const ISSUER = "https://facteur.example.com";
const SCOPES = ["mail.read", "mail.write", "mail.send"];

function setup() {
  const store = new OAuthStore(join(mkdtempSync(join(tmpdir(), "facteur-")), "oauth.json"));
  const p = new OAuthProvider({ store, issuer: ISSUER, resource: `${ISSUER}/mcp`, scopes: SCOPES, apiToken: "x".repeat(32) });
  return { store, p };
}

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function authorize(p: OAuthProvider, clientId: string, extra: Record<string, string> = {}) {
  const req = p.parseAuthorize({
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
    ...extra,
  });
  return new URL(p.approve(req, ["mail.read", "mail.write"]));
}

describe("oauth", () => {
  it("runs register → authorize → token → refresh → revoke", () => {
    const { p } = setup();
    const c = p.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }) as { client_id: string };
    const back = authorize(p, c.client_id);
    expect(back.searchParams.get("state")).toBe("st");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    const code = back.searchParams.get("code")!;
    const t = p.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback" });
    expect(t.scope).toBe("mail.read mail.write");
    expect(p.verify(t.access_token)?.scopes).toEqual(["mail.read", "mail.write"]);
    // codes are single use
    expect(() => p.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: c.client_id })).toThrow(/invalid or expired/);
    const r = p.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id });
    expect(p.verify(t.access_token)).toBeUndefined();
    expect(p.verify(r.access_token)).toBeDefined();
    // reusing the old refresh token revokes everything
    expect(() => p.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: c.client_id })).toThrow(/reuse/);
    expect(p.verify(r.access_token)).toBeUndefined();
  });

  it("rejects a bad PKCE verifier, a wrong redirect and http redirects", () => {
    const { p } = setup();
    const c = p.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) as { client_id: string };
    const code = authorize(p, c.client_id).searchParams.get("code")!;
    expect(() => p.token({ grant_type: "authorization_code", code, code_verifier: "w".repeat(50), client_id: c.client_id })).toThrow(/PKCE/);
    expect(() => p.parseAuthorize({ client_id: c.client_id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" })).toThrow(/redirect_uri/);
    expect(() => p.register({ redirect_uris: ["http://evil.example/cb"] })).toThrow();
    expect(() => p.register({ redirect_uris: ["javascript:alert(1)"] })).toThrow();
    expect(p.register({ redirect_uris: ["http://localhost:3334/callback", "cursor://anysphere.cursor-retrieval/oauth/callback"] })).toHaveProperty("client_id");
  });

  it("requires PKCE and checks the resource", () => {
    const { p } = setup();
    const c = p.register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) as { client_id: string };
    expect(() => authorize(p, c.client_id, { code_challenge_method: "plain" })).toThrow();
    expect(() => authorize(p, c.client_id, { resource: "https://other.example/mcp" })).toThrow(/only issues tokens/);
    expect(authorize(p, c.client_id, { resource: ISSUER }).searchParams.get("code")).toBeTruthy();
  });

  it("accepts the static API token with every scope", () => {
    const { p } = setup();
    expect(p.verify("x".repeat(32))?.scopes).toEqual(SCOPES);
    expect(p.verify("y".repeat(32))).toBeUndefined();
  });

  it("signs and expires blobs", () => {
    const s = sign("k", { a: 1 }, 1000);
    expect(unsign<{ a: number }>("k", s)?.a).toBe(1);
    expect(unsign("other", s)).toBeUndefined();
    expect(unsign("k", sign("k", { a: 1 }, -1))).toBeUndefined();
  });
});
