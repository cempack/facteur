# Facteur

An [MCP](https://modelcontextprotocol.io) server for a **Proton** account. Claude, ChatGPT, Cursor or any MCP client can use it to read, search, organize and send your **Mail** through [Proton Mail Bridge](https://proton.me/mail/bridge), look up and manage **Pass** items through Proton's official [`pass-cli`](https://protonpass.github.io/pass-cli/), and read your **Calendar**.

*Facteur* is French for postman.

```
AI app ──HTTPS + OAuth──▶ Facteur ─┬─ IMAP/SMTP (private network) ──▶ Proton Mail Bridge
                                   ├─ pass-cli, signed in as a Pass agent ──▶ Proton Pass
                                   └─ calendar share links (ICS, read-only) ──▶ Proton Calendar
```

- **Remote server with built-in OAuth 2.1.** Add the URL as a custom connector in claude.ai, the Claude apps, ChatGPT or Claude Code, then approve it once in your browser. A static token also works for scripts.
- **Per-connection permissions.** Each app gets *read*, *organize & drafts*, and/or *send*. A read-only connection doesn't even see the other tools.
- **Self-contained.** Node 26 runs the TypeScript directly, so there is no build step. The only state is one JSON file and an audit log.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_mailboxes` | read | System mailboxes, folders and labels, with total and unread counts |
| `search_emails` | read | Search one mailbox or `all`: text, from, to, subject, body, unread, starred, date ranges (`7d`, `2026-11-01`), size, has attachment. Paged, newest first, with previews |
| `get_email` | read | Full message: headers, readable body (HTML converted), attachments, labels, List-Unsubscribe |
| `get_thread` | read | The whole conversation across folders (sent and received), oldest first |
| `get_attachment` | read | Images as images, text as text, PDFs and other files as embedded resources |
| `mark_emails` | write | Read/unread, starred, replied |
| `move_emails` | write | To inbox, archive, spam, trash or any folder; returns the new ids |
| `label_emails` | write | Add or remove labels (optionally creating the label) |
| `delete_emails` | write | To Trash, or permanently |
| `manage_mailbox` | write | Create, rename or delete folders and labels |
| `create_draft` / `update_draft` | write | Drafts that sync to every Proton app, for review before sending |
| `send_email` | send | New message: Markdown or plain text, Cc/Bcc, attachments, choice of sender address |
| `reply_email` | send* | Reply or reply-all with threading headers, quoting, and the right sender address. Can save as a draft instead (`write`) |
| `forward_email` | send* | Forward with the original attachments, or save as a draft |
| `send_draft` | send | Send a saved draft |

### Proton Pass (only when `PROTON_PASS_AGENT_TOKEN` is set)

| Tool | Scope | What it does |
|---|---|---|
| `pass_list_vaults` | pass.read | Vaults shared with Facteur's agent |
| `pass_search` | pass.read | Find items by title, username, email or website, optionally by vault or type. Non-secret fields only |
| `pass_get_item` | pass.read | One item's non-secret details, plus the *names* of its secret fields |
| `pass_reveal` | pass.read / pass.reveal | With `pass.reveal`: a password, 2FA code, note or hidden field. Without it: a one-time link the user opens to see the value themselves. A reason is always required and is logged by Proton |
| `pass_generate_password` | pass.read | Random password or passphrase |
| `pass_create_login` | pass.write | Save a login, with a generated password by default |
| `pass_update_item` | pass.write | Change fields (`password: "generate"` rotates it) |
| `pass_trash_item` | pass.write | Move to the Pass trash, or restore. Never deletes permanently |

### Proton Calendar (only when `FACTEUR_CALENDARS` is set)

| Tool | Scope | What it does |
|---|---|---|
| `calendar_events` | calendar.read | Events between two dates (`today`, `+7d`, `2026-12-01`...), recurring ones expanded, searchable |

Proton Calendar has no API or CalDAV, so this is read-only, through each calendar's share link.

The bulk tools (`mark`, `move`, `label`, `delete`) take either `ids` or a `search`, so "archive every newsletter from last month" is one call. A `max` guard refuses searches that match more than expected.

Prompts are included for clients that support them: `triage_inbox`, `summarize_unread`, `draft_reply` and `clean_up_newsletters`.

Message ids look like `INBOX/4521`: the mailbox, a slash, then the IMAP uid.

## Security

Facteur holds the keys to a mailbox, so it is built to be safe to expose:

- **Nothing is reachable without a token.** `/mcp` requires an OAuth access token or the static API token. Tokens are 256-bit random, stored only as SHA-256 hashes, and expire after 1 hour. Refresh tokens rotate on every use, and reusing an old one revokes the whole connection.
- **Only the owner can approve a connection.** The consent page sits behind Cloudflare Access, where the server verifies the Access JWT itself, or behind an admin password. Approving shows the app's name and where it sends you back, and lets you untick permissions. PKCE (S256) is mandatory, redirect URIs must match exactly, and the authorization codes are single-use and last 5 minutes.
- **Connections can be revoked at any time** from the dashboard at `/`.
- **Every change is audited.** Each move, delete, label, draft and send is appended to `/data/audit.jsonl` with the app, the message ids, and for sends the recipients and subject (never the body).
- **Pass secrets are opt-in, per app.** Facteur signs in to Pass as a [Pass agent](https://protonpass.github.io/pass-cli/): a token limited to the vaults you choose, revocable from Pass, with Proton's own audit log (`pass-cli agent monitor facteur`). Item lists and details never contain secret values. Values come only from `pass_reveal`, which needs the `pass.reveal` scope (unticked on the consent page) and a reason that Proton records. Apps without that scope get a one-time link (single use, 10 minutes, behind your sign-in), and the value goes from Pass to your screen without passing through the AI. The static API token can't reveal unless `FACTEUR_API_TOKEN_SCOPES` says so. `pass-cli` runs with argument arrays (no shell). New passwords go over stdin, never on the command line. The session lives in a private directory that isn't persisted.
- **Email content is treated as untrusted.** Bodies and attachments are wrapped in `<email_body untrusted>` markers. The server's instructions tell the model never to act on instructions found in mail, and to draft rather than send when unsure. The send tools are annotated as destructive and open-world, so clients ask before running them.
- **Sending is limited to your own addresses.** Mail can only go out from the addresses in `FACTEUR_FROM`.
- **Hardened HTTP.** Responses have a strict CSP with no scripts and no framing. Requests are rate-limited per IP, forms are same-origin only, and session cookies are `HttpOnly` with `SameSite=Lax`. The container runs as the unprivileged `node` user.
- **Bridge never leaves the private network.** Bridge's self-signed TLS is accepted only because the hop is internal. Set `BRIDGE_TLS_VERIFY=true` if your Bridge has a real certificate.

**Threat model in one line:** anyone who can reach the URL can register a client, but only you can approve it. Anyone holding a valid token can act on your mail within its scopes, so give apps only the scopes they need.

If you deploy from a public fork with a PaaS that builds pull-request previews (Coolify, Vercel...), **turn previews off** for this app. A preview build can inherit production secrets.

## Run it

### Docker (next to Bridge)

```sh
docker build -t facteur .
docker run -d --name facteur --network <bridge-network> -p 8080:8080 \
  -v facteur-data:/data --env-file .env facteur
```

See [`.env.example`](.env.example). The required variables are `BRIDGE_USER` and `BRIDGE_PASSWORD`, the Bridge password shown by `info` in the Bridge CLI, not your Proton password. HTTP mode also needs `FACTEUR_PUBLIC_URL`, plus either `FACTEUR_ADMIN_PASSWORD` or Cloudflare Access (`FACTEUR_ACCESS_TEAM` and `FACTEUR_ACCESS_AUD`).

| Variable | Default | |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | Bridge host name |
| `BRIDGE_IMAP_PORT` / `BRIDGE_SMTP_PORT` | `1143` / `1025` | |
| `BRIDGE_TLS` | `starttls` | `starttls`, `tls` or `none` |
| `BRIDGE_TLS_VERIFY` | `false` | Verify Bridge's certificate |
| `BRIDGE_POOL_SIZE` | `3` | IMAP connections kept open at most |
| `FACTEUR_FROM` | `BRIDGE_USER` | Allowed sender addresses, default first |
| `FACTEUR_PUBLIC_URL` | `http://localhost:8080` | Public origin, also the OAuth issuer |
| `FACTEUR_ADMIN_PASSWORD` | | Approve connections with a password |
| `FACTEUR_ACCESS_TEAM` / `FACTEUR_ACCESS_AUD` | | Approve connections through Cloudflare Access instead |
| `FACTEUR_API_TOKEN` | | Static bearer token (≥ 24 chars) |
| `FACTEUR_API_TOKEN_SCOPES` | all but `pass.reveal` | What the static token may do |
| `PROTON_PASS_AGENT_TOKEN` | | Pass agent token (`pst_…::…`), turns Pass on |
| `FACTEUR_CALENDARS` | | `Name\|https://…ics, Other\|https://…ics` calendar share links, turns Calendar on |
| `FACTEUR_SESSION_DAYS` | `30` | How long a password sign-in lasts on the approval page and dashboard |
| `FACTEUR_DATA_DIR` | `/data` (image) | OAuth state and audit log |
| `FACTEUR_MAX_ATTACHMENT_MB` | `15` | Largest attachment returned to the model |
| `TZ` / `FACTEUR_TIMEZONE` | system | Time zone for dates in tool output |
| `FACTEUR_TRANSPORT` | `http` | `stdio` for a local, single-user process |

`GET /healthz` checks the process, and `GET /healthz?deep` also checks the IMAP connection.

### Proton Pass

With `pass-cli` signed in as yourself (`pass-cli login`), create an agent that sees only the vaults you choose, then give its token to Facteur:

```sh
pass-cli agent create --expiration 1y --vault Personal --vault Work facteur      # prints pst_…::…
pass-cli agent access grant facteur --vault-name Personal --role editor           # only if it may edit
```

Renew it before it expires with `pass-cli agent renew --expiration 1y facteur`. See what it accessed with `pass-cli agent monitor facteur`.

### Proton Calendar

In Proton Calendar, go to Settings → Calendars → your calendar → Share → **Share with anyone** (full view) and copy the link. The link contains the key to the calendar, so treat it as a secret.

### Behind Cloudflare Access (recommended)

1. Create an Access application for the whole host, limited to yourself.
2. Add a **bypass** application for `/mcp`, `/token`, `/register`, `/revoke` and `/.well-known/*`, since AI apps call those directly. Those paths are protected by the tokens.
3. Set `FACTEUR_ACCESS_TEAM` and `FACTEUR_ACCESS_AUD`. The consent page and dashboard then need no password.

## Connect an app

The MCP URL is `https://<your host>/mcp`.

- **claude.ai / Claude Desktop / Claude mobile:** Settings → Connectors → Add custom connector → paste the URL → Connect → approve.
- **Claude Code:** `claude mcp add --transport http facteur https://<your host>/mcp`, then run `/mcp` to sign in. Or skip OAuth with `--header "Authorization: Bearer $FACTEUR_API_TOKEN"`.
- **ChatGPT:** Settings → Connectors → Create → paste the URL, authentication OAuth.
- **Cursor, VS Code, others:** add a remote/HTTP MCP server with the URL. They discover OAuth on their own.
- **Local stdio** (Bridge on your machine): `FACTEUR_TRANSPORT=stdio node src/main.ts` with the Bridge variables set.

## Develop

```sh
npm install
npm run check   # tsc, types only
npm test        # vitest
npm run dev     # needs a Bridge; see .env.example
FACTEUR_URL=http://localhost:8080/mcp FACTEUR_TOKEN=... npm run smoke   # end-to-end, never sends
```

Layout:
- `src/mail/` holds everything that talks to Bridge: the IMAP pool, mailboxes, search, message parsing, composing and SMTP.
- `src/mcp/` holds the tools, prompts and output formatting.
- `src/http/` holds the OAuth server, consent pages and the MCP endpoint.

MIT licensed.
