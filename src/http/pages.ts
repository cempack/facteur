import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The owner's pages: sign-in, consent, apps, connections, secret reveal.
 * Server-rendered, no scripts (the CSP forbids them). The look follows
 * emOS "Moss" from elliotmoreau.fr: near-black greens, warm paper text,
 * one moss accent; Inter served from this server; Phosphor icons inlined.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- assets ----------

const require = createRequire(import.meta.url);
const iconCache = new Map<string, string>();

/** a Phosphor icon (regular weight) as inline SVG */
function icon(name: string, cls = "ic"): string {
  let svg = iconCache.get(name);
  if (!svg) {
    svg = readFileSync(require.resolve(`@phosphor-icons/core/regular/${name}.svg`), "utf8").replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
    iconCache.set(name, svg);
  }
  return svg.replace("<svg ", `<svg class="${cls}" `);
}

export const FONT_FILE = require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
export const FONT_FILE_EXT = require.resolve("@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2");

// ---------- style ----------

const CSS = `
@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/assets/inter.woff2) format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215; }
@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/assets/inter-ext.woff2) format("woff2"); unicode-range: U+0100-024F, U+0259, U+1E00-1EFF, U+20A0-20AB, U+20AD-20CF, U+2C60-2C7F, U+A720-A7FF; }
:root {
  color-scheme: dark;
  --bg: #101311; --bg-deep: #0a0c0b; --surface: #161a17; --surface-2: #1f2420;
  --line: #2b322d; --line-2: #3f4842;
  --text: #ebe9e1; --text-2: #bcc2ba; --text-3: #8f988f;
  --accent: #b0cc86; --accent-hover: #c2d99e; --accent-ink: #101311; --accent-soft: rgba(176, 204, 134, 0.12);
  --sage: #89b4a8; --ember: #e0bd6e; --ember-soft: rgba(224, 189, 110, 0.1); --flare: #e2786b; --flare-soft: rgba(226, 120, 107, 0.12);
  --shadow: 0 1px 0 rgba(255, 255, 255, 0.035) inset, 0 24px 48px -28px rgba(0, 0, 0, 0.7);
  --glow-a: rgba(176, 204, 134, 0.07); --glow-b: rgba(137, 180, 168, 0.06);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #eef0eb; --bg-deep: #e6e9e2; --surface: #f8f9f6; --surface-2: #eceee8;
    --line: #d9ddd4; --line-2: #c3c9bd;
    --text: #151915; --text-2: #3c443d; --text-3: #5b645c;
    --accent: #4d6a2b; --accent-hover: #3f5822; --accent-ink: #f6f7f2; --accent-soft: rgba(77, 106, 43, 0.1);
    --sage: #356357; --ember: #85600f; --ember-soft: rgba(133, 96, 15, 0.08); --flare: #b03d2d; --flare-soft: rgba(176, 61, 45, 0.08);
    --shadow: 0 1px 2px rgba(31, 40, 30, 0.05), 0 18px 40px -28px rgba(31, 40, 30, 0.35);
    --glow-a: rgba(77, 106, 43, 0.07); --glow-b: rgba(53, 99, 87, 0.05);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; color: var(--text);
  font: 15px/1.55 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-feature-settings: "cv11", "ss01"; letter-spacing: -0.006em;
  background:
    radial-gradient(1100px 520px at 0% -10%, var(--glow-a), transparent 65%),
    radial-gradient(900px 480px at 100% 0%, var(--glow-b), transparent 60%),
    var(--bg);
  background-attachment: fixed;
}
a { color: var(--sage); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.ic { width: 18px; height: 18px; flex: none; }
.ic-sm { width: 15px; height: 15px; flex: none; }
.mono { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; letter-spacing: 0; }
.muted { color: var(--text-3); }
.small { font-size: 13px; }

/* shell */
.shell { max-width: 760px; margin: 0 auto; padding: 0 16px 72px; }
.narrow { max-width: 460px; margin: 0 auto; padding: 7vh 16px 72px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 68px; margin-bottom: 20px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 15px; color: var(--text); }
.brand:hover { text-decoration: none; }
.mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); border: 1px solid var(--line); }
.tabs { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--surface); border: 1px solid var(--line); }
.tabs a { padding: 6px 12px; border-radius: 7px; color: var(--text-2); font-weight: 550; font-size: 13.5px; }
.tabs a:hover { text-decoration: none; color: var(--text); }
.tabs a[aria-current="page"] { background: var(--surface-2); color: var(--text); box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset; }
.who { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: 13px; }
.who a { color: var(--text-3); display: inline-flex; }
.who a:hover { color: var(--text); }
@media (max-width: 640px) { .who span { display: none; } .top { height: 60px; } .brand { font-size: 0; gap: 0; } }

/* type */
h1 { font-size: 26px; line-height: 1.2; letter-spacing: -0.022em; font-weight: 650; margin: 0 0 6px; }
h2 { font-size: 15px; letter-spacing: -0.01em; font-weight: 620; margin: 0; }
.lead { color: var(--text-2); margin: 0 0 24px; max-width: 60ch; }
p { margin: 0; }

/* surfaces */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px; box-shadow: var(--shadow); }
.panel + .panel, .stack > * + * { margin-top: 14px; }
.section-title { display: flex; align-items: baseline; justify-content: space-between; margin: 30px 0 12px; }
.tile { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); color: var(--text-2); flex: none; font-weight: 650; }
.tile.accent { background: var(--accent-soft); color: var(--accent); }
.tile.flare { background: var(--flare-soft); color: var(--flare); }
.tile.ember { background: var(--ember-soft); color: var(--ember); }
.row { display: flex; align-items: center; gap: 14px; }
.grow { flex: 1; min-width: 0; }
.divided > * + * { border-top: 1px solid var(--line); }

/* controls */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 38px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--surface-2); color: var(--text); font: 600 14px/1 "Inter", ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.005em; cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s, transform .08s; }
.btn:hover { text-decoration: none; border-color: var(--text-3); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible, input:focus-visible, summary:focus-visible, .tabs a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.btn.primary:hover { background: var(--accent-hover); }
.btn.quiet { background: transparent; }
.btn.danger { background: transparent; color: var(--flare); border-color: var(--line-2); }
.btn.danger:hover { background: var(--flare-soft); border-color: var(--flare); }
.btn.block { width: 100%; height: 42px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
form { margin: 0; }
label.field { display: grid; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-2); }
input[type=text], input[type=password] {
  width: 100%; height: 42px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--line-2);
  background: var(--bg-deep); color: var(--text); font: 400 15px "Inter", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0;
}
input::placeholder { color: var(--text-3); opacity: 1; }
.hint { font-size: 12.5px; color: var(--text-3); font-weight: 400; }
.error { font-size: 13px; color: var(--flare); font-weight: 500; }

/* switches: checkboxes drawn as toggles (full-round, like pills) */
input.switch { appearance: none; -webkit-appearance: none; flex: none; width: 38px; height: 22px; margin: 2px 0 0; border-radius: 999px; background: var(--line-2); position: relative; cursor: pointer; transition: background .18s; }
input.switch::before { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 999px; background: var(--text); transition: transform .18s cubic-bezier(.22,1,.36,1); }
input.switch:checked { background: var(--accent); }
input.switch:checked::before { transform: translateX(16px); background: var(--accent-ink); }
.perm { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; cursor: pointer; }
.perm strong { display: block; font-weight: 600; font-size: 14.5px; }
.perm .hint { display: block; margin-top: 2px; line-height: 1.45; }
.perm.risky strong { color: var(--ember); }
.group { padding: 4px 0 6px; }
.group + .group { border-top: 1px solid var(--line); padding-top: 10px; }
.group-head { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12.5px; font-weight: 600; padding: 6px 0 2px; }

/* status (dots carry real state) */
.pill { display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
.pill.ok { color: var(--accent); background: var(--accent-soft); }
.pill.bad { color: var(--flare); background: var(--flare-soft); }
.pill.off { color: var(--text-3); background: var(--surface-2); }
.pill.wait { color: var(--ember); background: var(--ember-soft); }
@media (prefers-reduced-motion: no-preference) {
  .pill.wait::before { animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: .25; } }
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 550; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); }
.chip.risky { color: var(--ember); border-color: color-mix(in srgb, var(--ember) 35%, var(--line)); }

/* connections grid */
.services { display: grid; gap: 14px; grid-template-columns: 1fr; }
@media (min-width: 680px) { .services { grid-template-columns: 1fr 1fr; } .services .wide { grid-column: 1 / -1; } }
.services .panel { margin: 0; display: flex; flex-direction: column; }
.service-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.service-body { color: var(--text-2); font-size: 14px; flex: 1; }
.callout { margin-top: 14px; padding: 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); background: var(--accent-soft); color: var(--text); }
.callout.bad { border-color: color-mix(in srgb, var(--flare) 40%, var(--line)); background: var(--flare-soft); }
.callout p + p { margin-top: 6px; }
details summary { cursor: pointer; color: var(--text-3); font-size: 13px; list-style: none; display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; }
details summary::-webkit-details-marker { display: none; }
details summary:hover { color: var(--text); }
details[open] summary { margin-bottom: 12px; }
.cal { display: flex; align-items: center; gap: 12px; padding: 10px 0; }
.form-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 16px; }
@media (min-width: 680px) { .form-grid { grid-template-columns: 200px 1fr auto; align-items: end; } .form-grid .btn { height: 42px; } }

/* misc */
.value { margin-top: 16px; padding: 16px; border-radius: 10px; background: var(--bg-deep); border: 1px solid var(--line-2); font-size: 17px; user-select: all; word-break: break-all; }
.url-box { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 0 12px; height: 44px; border-radius: 8px; background: var(--bg-deep); border: 1px solid var(--line-2); color: var(--text); overflow-x: auto; white-space: nowrap; }
.url-box span { user-select: all; }
.how { display: grid; gap: 8px; margin-top: 16px; font-size: 13.5px; color: var(--text-2); }
.how b { color: var(--text); font-weight: 600; }
.empty { text-align: center; padding: 34px 16px; color: var(--text-3); }
.empty .tile { margin: 0 auto 12px; }
.foot { margin-top: 22px; text-align: center; font-size: 12.5px; color: var(--text-3); }
`;

// ---------- frame ----------

type Tab = "apps" | "connections";

interface PageOpts {
  /** owner pages get the top bar */
  nav?: { tab?: Tab; owner: string; signOut: boolean };
  /** centered narrow column (sign-in, consent, reveal, errors) */
  narrow?: boolean;
  /** reload every N seconds (sign-in flows waiting for approval) */
  refresh?: number;
}

export function page(title: string, body: string, opts: PageOpts = {}): string {
  const brand = `<span class="mark">${icon("envelope-simple", "ic-sm")}</span>Facteur`;
  const top = opts.nav
    ? `<header class="top">
  <a class="brand" href="/">${brand}</a>
  <nav class="tabs" aria-label="Sections">
    <a href="/"${opts.nav.tab === "apps" ? ' aria-current="page"' : ""}>Apps</a>
    <a href="/connections"${opts.nav.tab === "connections" ? ' aria-current="page"' : ""}>Connections</a>
  </nav>
  <div class="who"><span>${esc(opts.nav.owner)}</span>${opts.nav.signOut ? `<a href="/logout" title="Sign out" aria-label="Sign out">${icon("sign-out")}</a>` : ""}</div>
</header>`
    : `<header class="top" style="justify-content:center"><span class="brand">${brand}</span></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ""}<title>${esc(title)}</title>
<link rel="preload" href="/assets/inter.woff2" as="font" type="font/woff2" crossorigin><style>${CSS}</style></head>
<body><div class="${opts.narrow ? "narrow" : "shell"}">${top}<main>${body}</main></div></body></html>`;
}

// ---------- scopes ----------

export const SCOPE_TEXT: Record<string, { title: string; detail: string; group: string; short: string; risky?: boolean }> = {
  "mail.read": { group: "Mail", short: "Mail: read", title: "Read your mail", detail: "Search and read messages, conversations and attachments." },
  "mail.write": { group: "Mail", short: "Mail: organize", title: "Organize mail and write drafts", detail: "Mark, move, label, trash, manage folders, save drafts." },
  "mail.send": { group: "Mail", short: "Mail: send", title: "Send mail as you", detail: "New emails, replies and forwards from your addresses." },
  "pass.read": { group: "Pass", short: "Pass: look up", title: "Look up Pass items", detail: "Titles, usernames and websites. Secrets stay hidden; it can send you a one-time link instead." },
  "pass.reveal": { group: "Pass", short: "Pass: secrets", title: "See passwords and 2FA codes", detail: "Only for apps you trust with your vault. Every reveal is logged here and in Proton Pass.", risky: true },
  "pass.write": { group: "Pass", short: "Pass: edit", title: "Create and edit Pass items", detail: "Save logins, change fields, move items to the trash. Never deletes for good." },
  "calendar.read": { group: "Calendar", short: "Calendar", title: "Read your calendar", detail: "Events from the calendars you shared with Facteur." },
  "drive.read": { group: "Drive", short: "Drive: read", title: "Browse and open Drive files", detail: "List folders, see sharing, download files." },
  "drive.write": { group: "Drive", short: "Drive: write", title: "Upload and organize Drive", detail: "Upload (email attachments too), folders, rename, move, trash, share links." },
};

const GROUP_ICON: Record<string, string> = { Mail: "envelope-simple", Pass: "key", Calendar: "calendar-blank", Drive: "hard-drives" };

// ---------- sign-in ----------

export function loginPage(action: string, error?: string): string {
  return page(
    "Sign in · Facteur",
    `<div class="panel">
<h1>Sign in</h1>
<p class="lead" style="margin-bottom:20px">Enter the owner password to manage Facteur.</p>
<form method="post" action="${esc(action)}" class="stack">
<label class="field">Password
<input type="password" name="password" autocomplete="current-password" autofocus required></label>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<button class="btn primary block" type="submit">Sign in</button>
</form></div>`,
    { narrow: true },
  );
}

// ---------- consent ----------

export function consentPage(o: { clientName: string; redirectHost: string; account: string; scopes: string[]; optIn: string[]; form: string; owner: string }): string {
  const groups = new Map<string, string[]>();
  for (const s of o.scopes) {
    const g = SCOPE_TEXT[s]?.group ?? "Other";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const blocks = [...groups]
    .map(
      ([g, list]) => `<div class="group"><div class="group-head">${icon(GROUP_ICON[g] ?? "plugs-connected", "ic-sm")}${esc(g)}</div>${list
        .map((s) => {
          const t = SCOPE_TEXT[s] ?? { title: s, detail: "", group: "Other", short: s };
          const on = o.optIn.includes(s) ? "" : " checked";
          return `<label class="perm${t.risky ? " risky" : ""}"><input class="switch" type="checkbox" name="scope" value="${esc(s)}"${on}><span><strong>${esc(t.title)}</strong><span class="hint">${esc(t.detail)}</span></span></label>`;
        })
        .join("")}</div>`,
    )
    .join("");
  const initial = (o.clientName.trim()[0] ?? "?").toUpperCase();
  return page(
    "Connect · Facteur",
    `<div class="panel">
<div class="row" style="margin-bottom:18px"><div class="tile accent" style="width:46px;height:46px;font-size:19px">${esc(initial)}</div>
<div class="grow"><h1 style="margin:0">Connect ${esc(o.clientName)}</h1><p class="muted small">to ${esc(o.account)}</p></div></div>
<p class="small" style="display:flex;align-items:center;gap:8px;color:var(--text-2)">${icon("arrow-up-right", "ic-sm")}Sends you back to <span class="mono">${esc(o.redirectHost)}</span></p>
<p class="hint" style="margin:4px 0 10px">Only approve if you just started this from that app.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${esc(o.form)}">
${blocks}
<div class="actions" style="display:grid;grid-template-columns:1fr auto">
<button class="btn primary block" type="submit" name="decision" value="allow">Allow</button>
<button class="btn quiet" style="height:42px" type="submit" name="decision" value="deny">Deny</button>
</div></form></div>
<p class="foot">Signed in as ${esc(o.owner)}. Disconnect any app later under Apps.</p>`,
    { narrow: true },
  );
}

// ---------- apps (home) ----------

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
    ? `<div class="panel divided" style="padding:4px 22px">${o.grants
        .map(
          (g) => `<div class="row" style="padding:16px 0;align-items:flex-start">
<div class="tile">${esc((g.client.trim()[0] ?? "?").toUpperCase())}</div>
<div class="grow"><div class="row" style="gap:8px;flex-wrap:wrap"><h2>${esc(g.client)}</h2><span class="mono muted">${esc(g.redirectHost)}</span></div>
<p class="muted small" style="margin-top:2px">Connected ${esc(g.created)}, last used ${esc(g.lastUsed)}</p>
<div class="chips">${g.scopes.map((s) => `<span class="chip${SCOPE_TEXT[s]?.risky ? " risky" : ""}">${esc(SCOPE_TEXT[s]?.short ?? s)}</span>`).join("")}</div></div>
<form method="post" action="/grants/${esc(g.id)}/revoke"><button class="btn danger" type="submit">Disconnect</button></form></div>`,
        )
        .join("")}</div>`
    : `<div class="panel empty"><div class="tile">${icon("plugs-connected")}</div><p style="color:var(--text-2);font-weight:600">No app connected yet</p><p class="small" style="margin-top:4px">Add the URL above to an AI app, then approve it here.</p></div>`;
  return page(
    "Apps · Facteur",
    `<h1>Apps</h1>
<p class="lead">AI apps with access to ${esc(o.account)} and your other Proton services.</p>
<div class="panel">
<h2>Connect an AI app</h2>
<div class="url-box mono">${icon("link-simple", "ic-sm")}<span>${esc(o.mcpUrl)}</span></div>
<div class="how">
<p><b>claude.ai and the Claude apps:</b> Settings, Connectors, Add custom connector.</p>
<p><b>Claude Code:</b> <span class="mono">claude mcp add --transport http facteur ${esc(o.mcpUrl)}</span></p>
<p><b>ChatGPT, Cursor and others:</b> add a remote MCP server with this URL.</p>
${o.tokenEnabled ? `<p class="hint">Scripts can use the static API token as a Bearer token instead.</p>` : ""}
</div></div>
<div class="section-title"><h2>Connected</h2><span class="muted small">${o.grants.length || ""}</span></div>
${rows}`,
    { nav: { tab: "apps", owner: o.owner, signOut: o.ownerMode === "password" } },
  );
}

// ---------- connections ----------

export interface FlowView {
  status: "starting" | "waiting" | "finishing" | "done" | "failed";
  url?: string;
  message?: string;
}

export interface ConnectionsView {
  mail: { imap: boolean; smtp: boolean; error?: string };
  pass: { ok: boolean; source?: "dashboard" | "env"; error?: string };
  drive: { enabled: boolean; signedIn: boolean };
  calendars: { name: string; host: string; fromEnv: boolean }[];
}

const pill = (kind: "ok" | "bad" | "off" | "wait", label: string) => `<span class="pill ${kind}">${esc(label)}</span>`;
const busy = (f?: FlowView) => Boolean(f && ["starting", "waiting", "finishing"].includes(f.status));

function flowCallout(f: FlowView | undefined, what: string): string {
  if (!f) return "";
  if (f.status === "starting" || f.status === "finishing")
    return `<div class="callout"><p class="row" style="gap:10px">${pill("wait", f.status === "starting" ? "Starting" : "Finishing")}<span class="small">${esc(f.message ?? "One moment.")}</span></p></div>`;
  if (f.status === "waiting")
    return `<div class="callout"><p style="font-weight:600">Approve the sign-in in Proton</p>
<p class="small" style="color:var(--text-2)">Open the link on any device within 10 minutes. This page updates by itself.</p>
<div class="actions" style="margin-top:12px"><a class="btn primary" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Open Proton sign-in ${icon("arrow-up-right", "ic-sm")}</a></div></div>`;
  if (f.status === "done") return `<div class="callout"><p class="row" style="gap:10px">${icon("check-circle")}<span>${esc(f.message)}</span></p></div>`;
  return `<div class="callout bad"><p style="font-weight:600">${esc(what)} sign-in didn't finish</p><p class="small">${esc(f.message)}</p></div>`;
}

export function connectionsPage(s: ConnectionsView, flows: { drive?: FlowView; pass?: FlowView }, bridgeHint: string, owner: { owner: string; signOut: boolean }): string {
  const mailOk = s.mail.imap && s.mail.smtp;
  const mail = `<section class="panel">
<div class="service-head"><div class="tile ${mailOk ? "accent" : "flare"}">${icon("envelope-simple")}</div><h2 class="grow">Mail</h2>${mailOk ? pill("ok", "Working") : pill("bad", "Failing")}</div>
<div class="service-body"><p>Through Proton Mail Bridge. Reading ${s.mail.imap ? "works" : "fails"}, sending ${s.mail.smtp ? "works" : "fails"}.</p>
${mailOk ? "" : `<div class="callout bad"><p class="small">${esc(s.mail.error ?? "")}</p><p class="small">If Bridge was signed out, sign it in again on the server: <span class="mono">${esc(bridgeHint)}</span></p></div>`}</div>
<details><summary>${icon("key", "ic-sm")}Bridge has a new password?</summary>
<form method="post" action="/connections/bridge/password" class="stack">
<label class="field">Bridge password<input type="password" name="password" required autocomplete="off"><span class="hint">Shown by <span class="mono">info</span> in the Bridge CLI after signing in.</span></label>
<button class="btn" type="submit">Save and reconnect</button></form></details>
</section>`;

  const pass = `<section class="panel">
<div class="service-head"><div class="tile ${s.pass.ok ? "accent" : ""}">${icon("key")}</div><h2 class="grow">Pass</h2>${
    busy(flows.pass) ? pill("wait", "Waiting") : s.pass.ok ? pill("ok", "Connected") : pill("off", "Not connected")
  }</div>
<div class="service-body"><p>${s.pass.ok ? `Signed in as Facteur's own Pass agent${s.pass.source === "env" ? ", with the token from the server settings" : ""}.` : esc(s.pass.error ?? "Not connected yet.")}</p>
<p class="hint" style="margin-top:6px">${s.pass.ok ? "Renewing signs you in once, extends the agent by a year, then signs you out." : "You sign in once; Facteur creates its own agent and keeps its token. Your session ends right after."}</p>
${flowCallout(flows.pass, "Pass")}</div>
<form method="post" action="/connections/pass/login" class="actions"><button class="btn${s.pass.ok ? "" : " primary"}" type="submit">${s.pass.ok ? "Renew for a year" : "Connect Pass"}</button></form>
</section>`;

  const drive = s.drive.enabled
    ? `<section class="panel">
<div class="service-head"><div class="tile ${s.drive.signedIn ? "accent" : ""}">${icon("hard-drives")}</div><h2 class="grow">Drive</h2>${
        busy(flows.drive) ? pill("wait", "Waiting") : s.drive.signedIn ? pill("ok", "Signed in") : pill("off", "Signed out")
      }</div>
<div class="service-body"><p>${s.drive.signedIn ? "Facteur can browse, download and upload." : "Sign in to let Facteur browse and upload files."}</p>
${flowCallout(flows.drive, "Drive")}</div>
<div class="actions"><form method="post" action="/connections/drive/login"><button class="btn${s.drive.signedIn ? "" : " primary"}" type="submit">${s.drive.signedIn ? "Sign in again" : "Sign in to Drive"}</button></form>
${s.drive.signedIn ? `<form method="post" action="/connections/drive/logout"><button class="btn danger" type="submit">Sign out</button></form>` : ""}</div>
</section>`
    : `<section class="panel"><div class="service-head"><div class="tile">${icon("hard-drives")}</div><h2 class="grow">Drive</h2>${pill("off", "Off")}</div><p class="service-body">Turned off on this server (FACTEUR_DRIVE).</p></section>`;

  const cals = s.calendars.length
    ? `<div class="divided">${s.calendars
        .map(
          (c) => `<div class="cal"><span class="grow"><strong>${esc(c.name)}</strong> <span class="mono muted">${esc(c.host)}</span></span>${
            c.fromEnv
              ? `<span class="muted small">server setting</span>`
              : `<form method="post" action="/connections/calendars/remove"><input type="hidden" name="name" value="${esc(c.name)}"><button class="btn danger" style="height:32px;padding:0 12px" type="submit">Remove</button></form>`
          }</div>`,
        )
        .join("")}</div>`
    : `<p class="service-body">No calendar yet. In Proton Calendar, open Settings, Calendars, pick one, then Share, <em>Share with anyone</em> (full view), and copy the link.</p>`;
  const calendar = `<section class="panel wide">
<div class="service-head"><div class="tile ${s.calendars.length ? "accent" : ""}">${icon("calendar-blank")}</div><h2 class="grow">Calendar</h2>${s.calendars.length ? pill("ok", `${s.calendars.length} connected`) : pill("off", "None")}</div>
${cals}
<form method="post" action="/connections/calendars/add" class="form-grid">
<label class="field">Name<input type="text" name="name" required maxlength="40" placeholder="Personnel"></label>
<label class="field">Share link<input type="password" name="url" required autocomplete="off" placeholder="https://calendar.proton.me/..."></label>
<button class="btn" type="submit">${icon("plus", "ic-sm")}Add</button>
</form>
<p class="hint" style="margin-top:10px">Read-only: Proton offers no calendar API. Links hold the calendar's key, so they're stored like secrets.</p>
</section>`;

  return page(
    "Connections · Facteur",
    `<h1>Connections</h1><p class="lead">The Proton services Facteur signs in to, and what to click when one needs you.</p>
<div class="services">${mail}${pass}${drive}${calendar}</div>`,
    { nav: { tab: "connections", ...owner }, ...((busy(flows.drive) || busy(flows.pass)) && { refresh: 4 }) },
  );
}

// ---------- reveal ----------

export function revealConfirmPage(o: { title: string; field: string; client: string; reason: string; action: string }): string {
  return page(
    "Reveal · Facteur",
    `<div class="panel">
<div class="row" style="margin-bottom:16px"><div class="tile ember">${icon("lock-key")}</div><div class="grow"><h1 style="margin:0;font-size:22px">Show the ${esc(o.field)}</h1><p class="muted small">${esc(o.title)}</p></div></div>
<p style="color:var(--text-2)"><strong style="color:var(--text)">${esc(o.client)}</strong> asked for it: ${esc(o.reason)}</p>
<p class="hint" style="margin-top:8px">It appears only here, once. The app never sees it.</p>
<form method="post" action="${esc(o.action)}" class="actions"><button class="btn primary block" type="submit">${icon("eye", "ic-sm")}Show it</button></form>
</div>`,
    { narrow: true },
  );
}

export function revealPage(o: { title: string; field: string; value: string }): string {
  return page(
    "Reveal · Facteur",
    `<div class="panel">
<div class="row"><div class="tile accent">${icon("key")}</div><div class="grow"><h1 style="margin:0;font-size:22px">${esc(o.title)}</h1><p class="muted small">${esc(o.field)}</p></div></div>
<div class="value mono">${esc(o.value)}</div>
<p class="hint" style="margin-top:12px">Click the value to select it. This link is now used up; close the tab when you're done.</p>
</div>`,
    { narrow: true },
  );
}

// ---------- errors ----------

export function errorPage(title: string, message: string, back?: { href: string; label: string }): string {
  return page(
    `${title} · Facteur`,
    `<div class="panel">
<div class="row" style="margin-bottom:12px"><div class="tile flare">${icon("warning-circle")}</div><h1 style="margin:0;font-size:22px">${esc(title)}</h1></div>
<p style="color:var(--text-2)">${esc(message)}</p>
${back ? `<div class="actions"><a class="btn" href="${esc(back.href)}">${esc(back.label)}</a></div>` : ""}
</div>`,
    { narrow: true },
  );
}
