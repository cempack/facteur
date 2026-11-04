/**
 * End-to-end check against a running Facteur: lists mailboxes, searches,
 * reads a message and its thread, then saves and deletes a draft. Never sends.
 *   FACTEUR_URL=https://facteur.example.com/mcp FACTEUR_TOKEN=... node scripts/smoke.ts
 */
const url = process.env.FACTEUR_URL ?? "http://localhost:8080/mcp";
const token = process.env.FACTEUR_TOKEN;
if (!token) throw new Error("set FACTEUR_TOKEN");
let id = 0;

async function rpc(method: string, params: unknown = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${body.slice(0, 300)}`);
  const json = JSON.parse(body.startsWith("event:") || body.startsWith("data:") ? body.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : body);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function tool(name: string, args: Record<string, unknown>) {
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const out = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");
  console.log(`\n### ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${r.isError ? " ERROR" : ""}\n${out.slice(0, 1500)}`);
  if (r.isError) process.exitCode = 1;
  return out;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
console.log("server:", init.serverInfo, "\ninstructions:", init.instructions);
const tools = await rpc("tools/list");
console.log("tools:", tools.tools.map((t: { name: string }) => t.name).join(", "));
await tool("list_mailboxes", {});
const list = await tool("search_emails", { mailbox: "inbox", limit: 3 });
const first = /• (\S+\/\d+)/.exec(list)?.[1];
if (first) {
  await tool("get_email", { id: first, max_chars: 800 });
  await tool("get_thread", { id: first, max_chars_per_message: 200, limit: 5 });
}
await tool("search_emails", { mailbox: "all", unread: true, since: "30d", limit: 2, preview: false });
await tool("search_emails", { mailbox: "inbox", has_attachment: true, limit: 2, preview: false });
const draft = await tool("create_draft", { to: "nobody@example.com", subject: "Facteur smoke test (safe to delete)", body: "Hello **world**" });
const draftId = /Draft saved as (\S+)\./.exec(draft)?.[1];
if (draftId) {
  await tool("get_email", { id: draftId });
  const upd = await tool("update_draft", { id: draftId, subject: "Facteur smoke test, edited (safe to delete)" });
  const newId = /Draft saved as (\S+)\./.exec(upd)?.[1] ?? draftId;
  await tool("delete_emails", { ids: [newId], permanent: true });
}
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
