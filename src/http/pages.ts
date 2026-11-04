/**
 * The few HTML pages Facteur serves: sign-in, consent, dashboard. Plain
 * server-rendered HTML, no scripts (the CSP forbids them).
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root { --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e3e1db; --accent:#6d4aff; --danger:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --card:#1f1f1d; --ink:#ecebe7; --muted:#a3a19b; --line:#33322f; --accent:#9b85ff; --danger:#ff6b5b; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 560px; margin: 8vh auto; padding: 0 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:24px 0 8px; }
p { margin: 8px 0; } .muted { color:var(--muted); font-size:13px; }
code { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:1px 6px; font-size:13px; word-break: break-all; }
label.scope { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-top:1px solid var(--line); }
label.scope:first-of-type { border-top:0; } label.scope input { margin-top:4px; }
.row { display:flex; gap:10px; margin-top:20px; }
button, .btn { font:inherit; border-radius:10px; padding:9px 16px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; text-decoration:none; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--danger); }
input[type=password] { width:100%; font:inherit; padding:9px 12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--ink); }
table { width:100%; border-collapse:collapse; font-size:14px; } td { padding:8px 4px; border-top:1px solid var(--line); vertical-align:top; }
.warn { border-left:3px solid var(--danger); padding-left:10px; }
.logo { font-size:28px; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><div class="card"><div class="logo">✉︎</div>${body}</div></main></body></html>`;
}

export const SCOPE_TEXT: Record<string, { title: string; detail: string }> = {
  "mail.read": { title: "Read your mail", detail: "List mailboxes, search, read messages, threads and attachments." },
  "mail.write": { title: "Organize your mail and write drafts", detail: "Mark read/starred, move, label, trash or delete, manage folders and labels, save drafts." },
  "mail.send": { title: "Send mail as you", detail: "Send new emails, replies and forwards from your addresses." },
};

export function loginPage(action: string, error?: string): string {
  return page(
    "Sign in · Facteur",
    `<h1>Sign in</h1><p class="muted">Facteur needs the owner's password to approve a connection.</p>
<form method="post" action="${esc(action)}">
${error ? `<p class="warn">${esc(error)}</p>` : ""}
<p><input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password"></p>
<div class="row"><button class="primary" type="submit">Sign in</button></div></form>`,
  );
}

export function consentPage(o: {
  clientName: string;
  redirectHost: string;
  account: string;
  scopes: string[];
  form: string;
  owner: string;
}): string {
  const boxes = o.scopes
    .map((s) => {
      const t = SCOPE_TEXT[s] ?? { title: s, detail: "" };
      return `<label class="scope"><input type="checkbox" name="scope" value="${esc(s)}" checked><span><strong>${esc(t.title)}</strong><br><span class="muted">${esc(t.detail)}</span></span></label>`;
    })
    .join("");
  return page(
    "Connect · Facteur",
    `<h1>Connect ${esc(o.clientName)}?</h1>
<p><strong>${esc(o.clientName)}</strong> wants access to <strong>${esc(o.account)}</strong>.</p>
<p class="muted">After you approve, it goes back to <code>${esc(o.redirectHost)}</code>. Only approve if you just started this from that app.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${esc(o.form)}">
<h2>Allow it to</h2>${boxes}
<div class="row"><button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div></form>
<p class="muted" style="margin-top:20px">Signed in as ${esc(o.owner)}. You can disconnect it any time from this server's home page.</p>`,
  );
}

export function errorPage(title: string, message: string): string {
  return page(`${title} · Facteur`, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

export interface DashboardGrant {
  id: string;
  client: string;
  redirectHost: string;
  scopes: string[];
  created: string;
  lastUsed: string;
}

export function dashboardPage(o: { account: string; mcpUrl: string; owner: string; grants: DashboardGrant[]; ownerMode: string; tokenEnabled: boolean }): string {
  const rows = o.grants.length
    ? `<table>${o.grants
        .map(
          (g) => `<tr><td><strong>${esc(g.client)}</strong><br><span class="muted">${esc(g.redirectHost)} · ${esc(g.scopes.map((s) => s.replace("mail.", "")).join(", "))}</span>
<br><span class="muted">connected ${esc(g.created)} · last used ${esc(g.lastUsed)}</span></td>
<td style="text-align:right"><form method="post" action="/grants/${esc(g.id)}/revoke"><button class="danger" type="submit">Disconnect</button></form></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">Nothing connected yet.</p>`;
  return page(
    "Facteur",
    `<h1>Facteur</h1><p class="muted">MCP server for ${esc(o.account)}</p>
<h2>Connect an AI app</h2><p>Add a custom connector / remote MCP server with this URL, then approve it here:</p><p><code>${esc(o.mcpUrl)}</code></p>
${o.tokenEnabled ? `<p class="muted">Scripts and CLI clients can also use the static API token as a Bearer token.</p>` : ""}
<h2>Connected apps</h2>${rows}
<p class="muted" style="margin-top:20px">Signed in as ${esc(o.owner)}${o.ownerMode === "password" ? ` · <a href="/logout">sign out</a>` : ""}</p>`,
  );
}
