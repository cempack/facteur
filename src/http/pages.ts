import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * The owner's pages, dressed as a small post office: a masthead with a
 * double rule, services as perforated stamps, the activity log as a
 * register with postmarks, the consent screen as an airmail envelope.
 *
 * Server-rendered, no scripts (the CSP forbids them). Type is Archivo (its
 * width axis gives the condensed, signage-like headings) with JetBrains Mono
 * for postmarks and data, both served from this server. Icons are Phosphor.
 */

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- assets ----------

const require = createRequire(import.meta.url);
const iconCache = new Map<string, string>();

/** a Phosphor icon as inline SVG (bold weight reads better at stamp sizes) */
function icon(name: string, cls = "ic", weight: "regular" | "bold" = "regular"): string {
  const key = `${weight}/${name}`;
  let svg = iconCache.get(key);
  if (!svg) {
    const file = weight === "bold" ? `${name}-bold` : name;
    svg = readFileSync(require.resolve(`@phosphor-icons/core/${weight}/${file}.svg`), "utf8").replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
    iconCache.set(key, svg);
  }
  return svg.replace("<svg ", `<svg class="${cls}" `);
}

/** fonts served at /assets/<name> */
export const FONTS: Record<string, string> = {
  "archivo.woff2": require.resolve("@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2"),
  "archivo-ext.woff2": require.resolve("@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2"),
  "mono.woff2": require.resolve("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
};

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

// ---------- style ----------

const CSS = `
@font-face { font-family: "Archivo"; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; src: url(/assets/archivo.woff2) format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2190-2199, U+2212, U+2215; }
@font-face { font-family: "Archivo"; font-style: normal; font-weight: 100 900; font-stretch: 62% 125%; font-display: swap; src: url(/assets/archivo-ext.woff2) format("woff2"); unicode-range: U+0100-024F, U+0259, U+1E00-1EFF, U+20A0-20AB, U+20AD-20CF, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Facteur Mono"; font-style: normal; font-weight: 100 800; font-display: swap; src: url(/assets/mono.woff2) format("woff2"); }

:root {
  color-scheme: light;
  /* paper and ink */
  --bg: #e7e9e1; --card: #f3f4ee; --card-2: #e9ebe3; --line: #c5c9bc; --rule: #1b221d;
  --ink: #18201b; --ink-2: #3f4840; --ink-3: #5d665e;
  /* postmark ink: the one accent */
  --accent: #b23f2d; --accent-ink: #f6f4ee; --accent-soft: rgba(178, 63, 45, 0.09);
  --air: #2e5c8a; /* only in the airmail stripes */
  --ok: #3f6a2a; --ok-soft: rgba(63, 106, 42, 0.1); --warn: #8a5f0e; --warn-soft: rgba(138, 95, 14, 0.09);
  --grain: .05;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #101311; --card: #171b18; --card-2: #1f2420; --line: #2f3731; --rule: #d9d7cf;
    --ink: #ebe9e1; --ink-2: #bcc2ba; --ink-3: #8f988f;
    --accent: #e2786b; --accent-ink: #101311; --accent-soft: rgba(226, 120, 107, 0.12);
    --air: #7fa6cf;
    --ok: #b0cc86; --ok-soft: rgba(176, 204, 134, 0.12); --warn: #e0bd6e; --warn-soft: rgba(224, 189, 110, 0.1);
    --grain: .07;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; background: var(--bg); color: var(--ink);
  font: 400 15.5px/1.55 "Archivo", ui-sans-serif, system-ui, sans-serif; font-stretch: 100%;
}
/* paper grain: one fixed layer, never on scrolling content */
body::after {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 10; opacity: var(--grain);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
a { color: var(--ink); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--accent); }
p { margin: 0; }
.ic { width: 18px; height: 18px; flex: none; }
.ic-sm { width: 15px; height: 15px; flex: none; }
.mono { font-family: "Facteur Mono", ui-monospace, Menlo, monospace; font-size: 13px; letter-spacing: 0; }
.muted { color: var(--ink-3); }
.small { font-size: 13.5px; }
.caps { font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-size: 12.5px; }

/* ---------- masthead ---------- */
.wrap { max-width: 820px; margin: 0 auto; padding: 22px 18px 80px; }
.wrap.narrow { max-width: 520px; padding-top: 6vh; }
.mast { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.mast .name { font-stretch: 62%; font-weight: 850; font-size: clamp(40px, 9vw, 64px); line-height: .82; letter-spacing: -.01em; text-transform: uppercase; color: var(--ink); text-decoration: none; }
.mast .name:hover { color: var(--ink); }
.mast .addr { text-align: right; padding-bottom: 4px; }
.mast .addr .mono { display: block; color: var(--ink-2); }
.mast .addr a { color: var(--ink-3); font-size: 12.5px; }
.rule { height: 0; border-top: 4px solid var(--rule); border-bottom: 1px solid var(--rule); padding-top: 3px; margin: 12px 0 0; }
.nav { display: flex; gap: 22px; margin: 12px 0 34px; overflow-x: auto; }
.nav a { font-stretch: 75%; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; font-size: 13px; color: var(--ink-3); text-decoration: none; padding-bottom: 6px; border-bottom: 2px solid transparent; white-space: nowrap; }
.nav a:hover { color: var(--ink); }
.nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--accent); }
@media (max-width: 560px) { .mast .addr .mono { font-size: 11.5px; } .nav { gap: 16px; } }

/* ---------- type ---------- */
h1 { font-stretch: 68%; font-weight: 800; font-size: clamp(32px, 6vw, 44px); line-height: 1; letter-spacing: -.005em; text-transform: uppercase; margin: 0 0 10px; }
h2 { font-stretch: 75%; font-weight: 750; font-size: 19px; line-height: 1.15; letter-spacing: .01em; text-transform: uppercase; margin: 0; }
.lead { color: var(--ink-2); max-width: 58ch; margin-bottom: 30px; font-size: 16px; }
.section { margin: 40px 0 14px; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--rule); padding-bottom: 8px; }

/* ---------- controls ---------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 18px; border-radius: 2px; border: 2px solid var(--ink); background: transparent; color: var(--ink); font: 700 13.5px/1 "Archivo", ui-sans-serif, sans-serif; font-stretch: 80%; text-transform: uppercase; letter-spacing: .07em; cursor: pointer; white-space: nowrap; text-decoration: none; transition: background .12s, color .12s, transform .06s; }
.btn:hover { background: var(--ink); color: var(--card); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible, input:focus-visible, summary:focus-visible, .nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { filter: brightness(1.08); background: var(--accent); color: var(--accent-ink); }
.btn.link { border-color: transparent; padding: 0 6px; text-decoration: underline; text-underline-offset: 4px; }
.btn.link:hover { background: transparent; color: var(--accent); }
.btn.danger { border-color: var(--accent); color: var(--accent); }
.btn.danger:hover { background: var(--accent); color: var(--accent-ink); }
.btn.small { height: 32px; padding: 0 12px; font-size: 12px; }
.btn.block { width: 100%; height: 46px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 18px; }
form { margin: 0; }
label.field { display: grid; gap: 6px; }
label.field > .caps { color: var(--ink-2); }
input[type=text], input[type=password] { width: 100%; height: 44px; padding: 0 12px; border-radius: 2px; border: 1.5px solid var(--ink-3); background: var(--card); color: var(--ink); font: 400 15px "Archivo", ui-sans-serif, sans-serif; }
input[type=password] { font-family: "Facteur Mono", ui-monospace, monospace; letter-spacing: .04em; }
input::placeholder { color: var(--ink-3); opacity: 1; font-family: "Archivo", ui-sans-serif, sans-serif; letter-spacing: 0; }
.hint { font-size: 13px; color: var(--ink-3); }
.error { color: var(--accent); font-weight: 600; font-size: 14px; }

/* form tick-boxes, like a postal slip */
input.tick { appearance: none; -webkit-appearance: none; flex: none; width: 20px; height: 20px; margin: 1px 0 0; border: 2px solid var(--ink); border-radius: 1px; background: var(--card); position: relative; cursor: pointer; }
input.tick:checked::after { content: ""; position: absolute; left: 5px; top: 1px; width: 6px; height: 11px; border: solid var(--accent); border-width: 0 3px 3px 0; transform: rotate(40deg); }

/* ---------- paper card ---------- */
.sheet { background: var(--card); border: 1px solid var(--line); padding: 24px; position: relative; }
.sheet + .sheet { margin-top: 16px; }

/* ---------- stamps (perforated: page-coloured holes painted on each edge) ---------- */
.stamp {
  --hole: 5px; --gap: 13px;
  position: relative; padding: 16px; background:
    radial-gradient(circle at 50% 0, var(--bg) var(--hole), transparent calc(var(--hole) + .5px)) 0 0 / var(--gap) var(--gap) repeat-x,
    radial-gradient(circle at 50% 100%, var(--bg) var(--hole), transparent calc(var(--hole) + .5px)) 0 100% / var(--gap) var(--gap) repeat-x,
    radial-gradient(circle at 0 50%, var(--bg) var(--hole), transparent calc(var(--hole) + .5px)) 0 0 / var(--gap) var(--gap) repeat-y,
    radial-gradient(circle at 100% 50%, var(--bg) var(--hole), transparent calc(var(--hole) + .5px)) 100% 0 / var(--gap) var(--gap) repeat-y,
    var(--card);
  filter: drop-shadow(0 1px 0 var(--line));
}
.stamp > .face { border: 1px solid var(--line); padding: 18px; height: 100%; display: flex; flex-direction: column; }
.stamp-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.stamp-top .glyph { width: 44px; height: 44px; display: grid; place-items: center; border: 2px solid var(--ink); color: var(--ink); }
.stamp-top .glyph .ic { width: 24px; height: 24px; }
.stamp-body { color: var(--ink-2); font-size: 14.5px; flex: 1; }
.stamps { display: grid; gap: 18px; grid-template-columns: 1fr; }
@media (min-width: 700px) { .stamps { grid-template-columns: 1fr 1fr; } .stamps .wide { grid-column: 1 / -1; } }

/* rubber stamps and postmarks (they carry real state) */
.rubber { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 2px solid currentColor; border-radius: 3px; font-stretch: 70%; font-weight: 800; font-size: 12.5px; letter-spacing: .1em; text-transform: uppercase; transform: rotate(-4deg); white-space: nowrap; }
.rubber.ok { color: var(--ok); }
.rubber.bad { color: var(--accent); }
.rubber.off { color: var(--ink-3); border-style: dashed; }
.rubber.wait { color: var(--warn); }
@media (prefers-reduced-motion: no-preference) { .rubber.wait { animation: thump 1.8s ease-in-out infinite; } @keyframes thump { 50% { opacity: .45; } } }
.postmark { flex: none; width: 64px; height: 64px; border-radius: 50%; border: 2px solid var(--accent); color: var(--accent); display: grid; place-content: center; text-align: center; transform: rotate(-9deg); opacity: .9; }
.postmark b { display: block; font-stretch: 70%; font-weight: 800; font-size: 15px; line-height: 1; letter-spacing: .04em; }
.postmark span { display: block; font-family: "Facteur Mono", ui-monospace, monospace; font-size: 11px; margin-top: 3px; letter-spacing: 0; }
.postmark.dim { border-color: var(--ink-3); color: var(--ink-3); opacity: .75; }

/* callouts */
.slip { margin-top: 16px; padding: 14px 16px; border-left: 4px solid var(--accent); background: var(--accent-soft); color: var(--ink); }
.slip.ok { border-left-color: var(--ok); background: var(--ok-soft); }
.slip p + p { margin-top: 6px; }
details summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; color: var(--ink-3); font-size: 13.5px; text-decoration: underline; text-underline-offset: 3px; }
details summary::-webkit-details-marker { display: none; }
details[open] summary { margin-bottom: 12px; }
.feed { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-top: 1px dashed var(--line); }
.feed:first-child { border-top: 0; }
.form-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 16px; }
@media (min-width: 700px) { .form-grid { grid-template-columns: 210px 1fr auto; align-items: end; } .form-grid .btn { height: 44px; } }

/* ---------- register (activity) ---------- */
.filters { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: -10px 0 8px; }
.filters a { font-stretch: 80%; font-weight: 650; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); text-decoration: none; padding-bottom: 3px; border-bottom: 2px solid transparent; }
.filters a:hover { color: var(--ink); }
.filters a[aria-current="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.entry { display: grid; grid-template-columns: 64px 1fr auto; gap: 18px; align-items: center; padding: 16px 0; border-bottom: 1px solid var(--line); }
.entry .what { font-weight: 600; font-size: 16px; line-height: 1.3; overflow-wrap: anywhere; }
.entry .detail { color: var(--ink-3); font-size: 13.5px; margin-top: 3px; overflow-wrap: anywhere; }
.entry .by { margin-top: 6px; color: var(--ink-2); }
@media (max-width: 560px) { .entry { grid-template-columns: 56px 1fr; } .entry .rubber { grid-column: 2; justify-self: start; } .postmark { width: 56px; height: 56px; } }

/* ---------- apps ---------- */
.label-box { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 12px 14px; border: 1.5px dashed var(--ink-3); background: var(--card-2); overflow-x: auto; }
.label-box .caps { color: var(--ink-3); flex: none; }
.label-box .mono { user-select: all; white-space: nowrap; font-size: 14px; color: var(--ink); }
.how { display: grid; gap: 8px; margin-top: 18px; color: var(--ink-2); font-size: 14.5px; }
.how b { color: var(--ink); font-weight: 650; }
.app { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: start; padding: 18px 0; border-bottom: 1px solid var(--line); }
.mini-stamp { --hole: 3px; --gap: 8px; padding: 6px; width: 52px; height: 60px; }
.mini-stamp > .face { padding: 0; display: grid; place-items: center; font-stretch: 65%; font-weight: 850; font-size: 24px; color: var(--accent); }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.tag { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--line); background: var(--card); font-stretch: 85%; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.tag.care { border-color: var(--accent); color: var(--accent); }
@media (max-width: 560px) { .app { grid-template-columns: auto 1fr; } .app form { grid-column: 2; } }

/* ---------- envelope (consent) ---------- */
.envelope { padding: 9px; background: repeating-linear-gradient(135deg, var(--accent) 0 16px, var(--card) 16px 24px, var(--air) 24px 40px, var(--card) 40px 48px); }
.envelope > .inner { background: var(--card); padding: 26px 24px 24px; }
.env-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
.env-from .caps, .env-to .caps { color: var(--ink-3); }
.env-from p { font-weight: 650; }
.env-to { margin: 22px 0 6px 12%; }
.env-to p { font-stretch: 72%; font-weight: 800; font-size: 26px; text-transform: uppercase; line-height: 1.05; overflow-wrap: anywhere; }
.env-stamp { position: relative; flex: none; }
.env-stamp .postmark { position: absolute; left: -34px; top: 26px; background: transparent; }
.perm-group { margin-top: 22px; }
.perm-group > .caps { display: flex; align-items: center; gap: 8px; color: var(--ink-2); border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
.perm { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px dashed var(--line); cursor: pointer; }
.perm strong { display: block; font-weight: 650; font-size: 15px; }
.perm .hint { display: block; margin-top: 2px; line-height: 1.45; }
.care-mark { display: inline-block; margin-left: 6px; color: var(--accent); font-stretch: 70%; font-weight: 800; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; vertical-align: 2px; }
.signoff { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin-top: 24px; }

/* ---------- misc ---------- */
.sealed { margin-top: 18px; padding: 18px; border: 2px solid var(--ink); background: var(--card-2); font-size: 18px; user-select: all; word-break: break-all; }
.empty { padding: 44px 16px; text-align: center; color: var(--ink-3); border: 1.5px dashed var(--line); }
.empty h2 { color: var(--ink-2); margin-bottom: 6px; }
.foot { margin-top: 22px; text-align: center; font-size: 13px; color: var(--ink-3); }
`;

// ---------- frame ----------

type Tab = "apps" | "activity" | "connections";

interface PageOpts {
  /** owner pages get the masthead nav */
  nav?: { tab?: Tab; owner: string; signOut: boolean };
  narrow?: boolean;
  /** reload every N seconds (sign-in flows waiting for approval) */
  refresh?: number;
}

export function page(title: string, body: string, opts: PageOpts = {}): string {
  const mast = `<header>
<div class="mast"><a class="name" href="/">Facteur</a>${
    opts.nav
      ? `<div class="addr"><span class="mono">${esc(opts.nav.owner)}</span>${opts.nav.signOut ? `<a href="/logout">Sign out</a>` : ""}</div>`
      : ""
  }</div>
<div class="rule"></div>
${
  opts.nav
    ? `<nav class="nav" aria-label="Sections">${(
        [
          ["apps", "/", "Apps"],
          ["activity", "/activity", "Activity"],
          ["connections", "/connections", "Connections"],
        ] as const
      )
        .map(([k, href, label]) => `<a href="${href}"${opts.nav!.tab === k ? ' aria-current="page"' : ""}>${label}</a>`)
        .join("")}</nav>`
    : `<div style="height:28px"></div>`
}
</header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ""}<title>${esc(title)}</title>
<link rel="preload" href="/assets/archivo.woff2" as="font" type="font/woff2" crossorigin><style>${CSS}</style></head>
<body><div class="wrap${opts.narrow ? " narrow" : ""}">${mast}<main>${body}</main></div></body></html>`;
}

function postmark(d: Date, timeZone: string, dim = false): string {
  const day = d.toLocaleDateString("en-GB", { timeZone, day: "2-digit" });
  const month = ROMAN[Number(d.toLocaleDateString("en-GB", { timeZone, month: "numeric" })) - 1] ?? "";
  const time = d.toLocaleTimeString("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" });
  return `<div class="postmark${dim ? " dim" : ""}" aria-label="${esc(d.toISOString())}"><b>${esc(day)} ${esc(month)}</b><span>${esc(time)}</span></div>`;
}

const rubber = (kind: "ok" | "bad" | "off" | "wait", label: string) => `<span class="rubber ${kind}">${esc(label)}</span>`;

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
    `<div class="sheet">
<h2 style="margin-bottom:6px">Counter closed</h2>
<p class="muted" style="margin-bottom:20px">Enter the owner password to open it.</p>
<form method="post" action="${esc(action)}" style="display:grid;gap:14px">
<label class="field"><span class="caps">Password</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<button class="btn primary block" type="submit">Sign in</button>
</form></div>`,
    { narrow: true },
  );
}

// ---------- consent: an airmail envelope ----------

export function consentPage(o: { clientName: string; redirectHost: string; account: string; scopes: string[]; optIn: string[]; form: string; owner: string; timeZone?: string }): string {
  const groups = new Map<string, string[]>();
  for (const s of o.scopes) {
    const g = SCOPE_TEXT[s]?.group ?? "Other";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const blocks = [...groups]
    .map(
      ([g, list]) => `<div class="perm-group"><div class="caps">${icon(GROUP_ICON[g] ?? "plugs-connected", "ic-sm", "bold")}${esc(g)}</div>${list
        .map((s) => {
          const t = SCOPE_TEXT[s] ?? { title: s, detail: "", group: "Other", short: s };
          const on = o.optIn.includes(s) ? "" : " checked";
          return `<label class="perm"><input class="tick" type="checkbox" name="scope" value="${esc(s)}"${on}><span><strong>${esc(t.title)}${t.risky ? `<span class="care-mark">Handle with care</span>` : ""}</strong><span class="hint">${esc(t.detail)}</span></span></label>`;
        })
        .join("")}</div>`,
    )
    .join("");
  const initial = (o.clientName.trim()[0] ?? "?").toUpperCase();
  return page(
    "Connect · Facteur",
    `<div class="envelope"><div class="inner">
<div class="env-head">
<div class="env-from"><span class="caps">From</span><p>${esc(o.clientName)}</p><p class="mono muted">${esc(o.redirectHost)}</p></div>
<div class="env-stamp"><div class="stamp mini-stamp"><div class="face">${esc(initial)}</div></div>${postmark(new Date(), o.timeZone ?? "Europe/Paris")}</div>
</div>
<div class="env-to"><span class="caps">Asking for access to</span><p>${esc(o.account)}</p></div>
<p class="hint" style="margin-top:14px">Approve only if you just started this from ${esc(o.clientName)}. You'll go back to <span class="mono">${esc(o.redirectHost)}</span>.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${esc(o.form)}">
${blocks}
<div class="signoff">
<button class="btn primary block" type="submit" name="decision" value="allow">Sign and allow</button>
<button class="btn link" style="height:46px" type="submit" name="decision" value="deny">Return to sender</button>
</div></form></div></div>
<p class="foot">Signed in as ${esc(o.owner)}. Disconnect any app later under Apps.</p>`,
    { narrow: true },
  );
}

// ---------- apps ----------

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
    ? o.grants
        .map(
          (g) => `<div class="app">
<div class="stamp mini-stamp"><div class="face">${esc((g.client.trim()[0] ?? "?").toUpperCase())}</div></div>
<div><h2>${esc(g.client)}</h2><p class="mono muted" style="margin-top:2px">${esc(g.redirectHost)}</p>
<p class="small muted" style="margin-top:6px">Connected ${esc(g.created)}. Last used ${esc(g.lastUsed)}.</p>
<div class="tags">${g.scopes.map((s) => `<span class="tag${SCOPE_TEXT[s]?.risky ? " care" : ""}">${esc(SCOPE_TEXT[s]?.short ?? s)}</span>`).join("")}</div></div>
<form method="post" action="/grants/${esc(g.id)}/revoke"><button class="btn danger small" type="submit">Disconnect</button></form></div>`,
        )
        .join("")
    : `<div class="empty"><h2>No apps yet</h2><p class="small">Add the address above to an AI app, then approve it here.</p></div>`;
  return page(
    "Apps · Facteur",
    `<h1>Apps</h1>
<p class="lead">AI apps that can work with ${esc(o.account)} and your other Proton services.</p>
<div class="sheet">
<h2>Connect an AI app</h2>
<div class="label-box"><span class="caps">Address</span><span class="mono">${esc(o.mcpUrl)}</span></div>
<div class="how">
<p><b>claude.ai and the Claude apps:</b> Settings, Connectors, Add custom connector.</p>
<p><b>Claude Code:</b> <span class="mono">claude mcp add --transport http facteur ${esc(o.mcpUrl)}</span></p>
<p><b>ChatGPT, Cursor and others:</b> add a remote MCP server with this address.</p>
${o.tokenEnabled ? `<p class="hint">Scripts can use the static API token as a Bearer token instead.</p>` : ""}
</div></div>
<div class="section"><h2>Connected</h2><span class="mono muted">${o.grants.length}</span></div>
${rows}`,
    { nav: { tab: "apps", owner: o.owner, signOut: o.ownerMode === "password" } },
  );
}

// ---------- connections: a sheet of stamps ----------

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

const busy = (f?: FlowView) => Boolean(f && ["starting", "waiting", "finishing"].includes(f.status));

function flowSlip(f: FlowView | undefined, what: string): string {
  if (!f) return "";
  if (f.status === "starting" || f.status === "finishing") return `<div class="slip"><p class="small">${esc(f.message ?? "One moment.")}</p></div>`;
  if (f.status === "waiting")
    return `<div class="slip"><p><strong>Approve the sign-in in Proton</strong></p><p class="small">Open it on any device within 10 minutes. This page updates by itself.</p>
<div class="actions" style="margin-top:12px"><a class="btn primary" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">Open Proton sign-in ${icon("arrow-up-right", "ic-sm", "bold")}</a></div></div>`;
  if (f.status === "done") return `<div class="slip ok"><p class="small">${esc(f.message)}</p></div>`;
  return `<div class="slip"><p><strong>${esc(what)} sign-in didn't finish</strong></p><p class="small">${esc(f.message)}</p></div>`;
}

function stampCard(o: { icon: string; name: string; status: string; wide?: boolean; body: string; foot?: string }): string {
  return `<section class="stamp${o.wide ? " wide" : ""}"><div class="face">
<div class="stamp-top"><div><div class="glyph">${icon(o.icon, "ic", "bold")}</div><h2 style="margin-top:12px">${esc(o.name)}</h2></div>${o.status}</div>
<div class="stamp-body">${o.body}</div>${o.foot ?? ""}
</div></section>`;
}

export function connectionsPage(s: ConnectionsView, flows: { drive?: FlowView; pass?: FlowView }, bridgeHint: string, owner: { owner: string; signOut: boolean }): string {
  const mailOk = s.mail.imap && s.mail.smtp;
  const mail = stampCard({
    icon: "envelope-simple",
    name: "Mail",
    status: mailOk ? rubber("ok", "In service") : rubber("bad", "Out of service"),
    body: `<p>Through Proton Mail Bridge. Reading ${s.mail.imap ? "works" : "fails"}, sending ${s.mail.smtp ? "works" : "fails"}.</p>
${mailOk ? "" : `<div class="slip"><p class="small">${esc(s.mail.error ?? "")}</p><p class="small">If Bridge was signed out, sign it in again on the server: <span class="mono">${esc(bridgeHint)}</span></p></div>`}`,
    foot: `<details><summary>Bridge has a new password?</summary>
<form method="post" action="/connections/bridge/password" style="display:grid;gap:10px">
<label class="field"><span class="caps">Bridge password</span><input type="password" name="password" required autocomplete="off"><span class="hint">Shown by <span class="mono">info</span> in the Bridge CLI after signing in.</span></label>
<div><button class="btn small" type="submit">Save and reconnect</button></div></form></details>`,
  });

  const pass = stampCard({
    icon: "key",
    name: "Pass",
    status: busy(flows.pass) ? rubber("wait", "Waiting") : s.pass.ok ? rubber("ok", "In service") : rubber("off", "Not connected"),
    body: `<p>${s.pass.ok ? `Signed in as Facteur's own Pass agent${s.pass.source === "env" ? ", with the token from the server settings" : ""}.` : esc(s.pass.error ?? "Not connected yet.")}</p>
<p class="hint" style="margin-top:6px">${s.pass.ok ? "Renewing signs you in once, extends the agent by a year, then signs you out." : "You sign in once. Facteur creates its own agent and keeps its token; your session ends right after."}</p>
${flowSlip(flows.pass, "Pass")}`,
    foot: `<form method="post" action="/connections/pass/login" class="actions"><button class="btn${s.pass.ok ? " small" : " primary"}" type="submit">${s.pass.ok ? "Renew for a year" : "Connect Pass"}</button></form>`,
  });

  const drive = s.drive.enabled
    ? stampCard({
        icon: "hard-drives",
        name: "Drive",
        status: busy(flows.drive) ? rubber("wait", "Waiting") : s.drive.signedIn ? rubber("ok", "In service") : rubber("off", "Signed out"),
        body: `<p>${s.drive.signedIn ? "Facteur can browse, download and upload." : "Sign in to let Facteur browse and upload files."}</p>${flowSlip(flows.drive, "Drive")}`,
        foot: `<div class="actions"><form method="post" action="/connections/drive/login"><button class="btn${s.drive.signedIn ? " small" : " primary"}" type="submit">${s.drive.signedIn ? "Sign in again" : "Sign in to Drive"}</button></form>${
          s.drive.signedIn ? `<form method="post" action="/connections/drive/logout"><button class="btn link small" type="submit">Sign out</button></form>` : ""
        }</div>`,
      })
    : stampCard({ icon: "hard-drives", name: "Drive", status: rubber("off", "Off"), body: `<p>Turned off on this server (FACTEUR_DRIVE).</p>` });

  const feeds = s.calendars.length
    ? `<div>${s.calendars
        .map(
          (c) => `<div class="feed"><span style="flex:1;min-width:0"><strong>${esc(c.name)}</strong> <span class="mono muted">${esc(c.host)}</span></span>${
            c.fromEnv
              ? `<span class="caps muted">Server setting</span>`
              : `<form method="post" action="/connections/calendars/remove"><input type="hidden" name="name" value="${esc(c.name)}"><button class="btn link small" type="submit">Remove</button></form>`
          }</div>`,
        )
        .join("")}</div>`
    : `<p>No calendar yet. In Proton Calendar, open Settings, Calendars, pick one, then Share, <em>Share with anyone</em> (full view), and copy the link.</p>`;
  const calendar = stampCard({
    icon: "calendar-blank",
    name: "Calendar",
    wide: true,
    status: s.calendars.length ? rubber("ok", `${s.calendars.length} ${s.calendars.length === 1 ? "feed" : "feeds"}`) : rubber("off", "None"),
    body: feeds,
    foot: `<form method="post" action="/connections/calendars/add" class="form-grid">
<label class="field"><span class="caps">Name</span><input type="text" name="name" required maxlength="40" placeholder="Personnel"></label>
<label class="field"><span class="caps">Share link</span><input type="password" name="url" required autocomplete="off" placeholder="https://… or webcal://…"></label>
<button class="btn" type="submit">Add</button>
</form>
<p class="hint" style="margin-top:10px">Read-only: Proton offers no calendar API. Links hold the calendar's key, so they're stored like secrets.</p>`,
  });

  return page(
    "Connections · Facteur",
    `<h1>Connections</h1><p class="lead">The Proton services Facteur signs in to, and what to do when one needs you.</p>
<div class="stamps">${mail}${pass}${drive}${calendar}</div>`,
    { nav: { tab: "connections", ...owner }, ...((busy(flows.drive) || busy(flows.pass)) && { refresh: 4 }) },
  );
}

// ---------- activity: the register ----------

export interface ActivityRow {
  time: Date;
  client: string;
  icon: string;
  kind: string;
  title: string;
  detail?: string;
  ok: boolean;
  sensitive?: boolean;
  stamp?: string;
}

export function activityPage(o: { items: ActivityRow[]; apps: string[]; current?: string; timeZone: string; owner: { owner: string; signOut: boolean } }): string {
  const day = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: o.timeZone });
  const today = day(new Date());
  const yesterday = day(new Date(Date.now() - 86_400_000));
  const label = (k: string) =>
    k === today ? "Today" : k === yesterday ? "Yesterday" : new Date(`${k}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  const filter = (name: string, href: string, on: boolean) => `<a href="${esc(href)}"${on ? ' aria-current="true"' : ""}>${esc(name)}</a>`;
  const filters = `<nav class="filters" aria-label="Filter">${[
    filter("Everything", "/activity", !o.current),
    filter("Handle with care", "/activity?only=sensitive", o.current === "sensitive"),
    filter("Returned", "/activity?only=failed", o.current === "failed"),
    ...o.apps.map((a) => filter(a, `/activity?app=${encodeURIComponent(a)}`, o.current === `app:${a}`)),
  ].join("")}</nav>`;

  const intro = `<h1>Activity</h1><p class="lead">Everything AI apps changed, sent or revealed, newest first. Reading mail isn't listed.</p>${filters}`;
  if (!o.items.length) {
    return page("Activity · Facteur", `${intro}<div class="empty" style="margin-top:24px"><h2>Nothing in the register</h2><p class="small">Sends, moves, deletes, Pass reveals and Drive changes are written here as they happen.</p></div>`, {
      nav: { tab: "activity", ...o.owner },
    });
  }

  const groups = new Map<string, ActivityRow[]>();
  for (const it of o.items) {
    const k = day(it.time);
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const rows = [...groups]
    .map(
      ([k, items]) => `<div class="section"><h2>${esc(label(k))}</h2><span class="mono muted">${items.length}</span></div>${items
        .map((it) => {
          const mark = !it.ok ? rubber("bad", "Returned") : it.stamp ? rubber("bad", it.stamp) : "";
          return `<div class="entry">${postmark(it.time, o.timeZone, it.kind === "owner")}
<div><p class="what">${esc(it.title)}</p>${it.detail ? `<p class="detail">${esc(it.detail)}</p>` : ""}<p class="by caps">${esc(it.kind === "owner" ? "You" : it.client)}</p></div>
${mark}</div>`;
        })
        .join("")}`,
    )
    .join("");
  return page("Activity · Facteur", `${intro}${rows}`, { nav: { tab: "activity", ...o.owner } });
}

// ---------- reveal: a registered letter ----------

export function revealConfirmPage(o: { title: string; field: string; client: string; reason: string; action: string }): string {
  return page(
    "Reveal · Facteur",
    `<div class="sheet">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div><span class="caps muted">Registered letter</span><h2 style="margin-top:6px">The ${esc(o.field)} of ${esc(o.title)}</h2></div>${rubber("bad", "Handle with care")}</div>
<p style="margin-top:16px;color:var(--ink-2)"><strong style="color:var(--ink)">${esc(o.client)}</strong> asked for it: ${esc(o.reason)}</p>
<p class="hint" style="margin-top:8px">It opens only here, once. The app never sees it.</p>
<form method="post" action="${esc(o.action)}" class="actions"><button class="btn primary block" type="submit">Open it</button></form>
</div>`,
    { narrow: true },
  );
}

export function revealPage(o: { title: string; field: string; value: string }): string {
  return page(
    "Reveal · Facteur",
    `<div class="sheet">
<span class="caps muted">${esc(o.field)}</span><h2 style="margin-top:6px">${esc(o.title)}</h2>
<div class="sealed mono">${esc(o.value)}</div>
<p class="hint" style="margin-top:12px">Click the value to select it. This link is now used up; close the tab when you're done.</p>
</div>`,
    { narrow: true },
  );
}

// ---------- errors: return to sender ----------

export function errorPage(title: string, message: string, back?: { href: string; label: string }): string {
  return page(
    `${title} · Facteur`,
    `<div class="sheet">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><h2>${esc(title)}</h2>${rubber("bad", "Returned")}</div>
<p style="margin-top:12px;color:var(--ink-2)">${esc(message)}</p>
${back ? `<div class="actions"><a class="btn small" href="${esc(back.href)}">${esc(back.label)}</a></div>` : ""}
</div>`,
    { narrow: true },
  );
}
