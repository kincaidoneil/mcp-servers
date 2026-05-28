# mcp-bridge

Small read-only MCP bridges for services whose official MCP servers gate the features I actually want. Self-hosted on Vercel.

Today: a Notion bridge that exposes the database-query and saved-view-query operations the [official Notion MCP](https://developers.notion.com/docs/mcp) reserves for Business plans.

| Tool                         | What it does                                                | Why it exists                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion-query-data-source`   | Query a Notion database with filter, sorts, and pagination  | The official MCP only has `notion-search`, which returns semantically-ranked results — useless for "last 10 Journal entries by Date descending" |
| `notion-query-database-view` | Query a saved view, applying its pre-configured filter+sort | Same gap, applied to saved views                                                                                                                |

This is **additive** to the official Notion MCP — both run side-by-side; create/update/fetch/search continue to flow through the official one.

---

## Architecture

```
Claude.ai / ChatGPT ── DCR + OAuth 2.1 + PKCE ──▶ mcp-bridge (Vercel) ── Notion OAuth ──▶ Notion
                                                       │
                                                       └── allowlist check on callback
```

The bridge is both the OAuth **Resource Server** (validating bearer tokens on `/notion`) and a minimal **Authorization Server** (issuing those tokens). It wraps an upstream Notion OAuth handshake. Stateless — every OAuth artifact (auth code, access token, refresh token, even the `client_id`) is a signed/encrypted JWT via [`jose`](https://github.com/panva/jose). No KV / DB.

Token TTLs:

| Artifact                | TTL                   |
| ----------------------- | --------------------- |
| `client_id` (CIMD)      | none (HMAC-validated) |
| Authorize-request state | 10 min                |
| Auth code               | 5 min                 |
| Access token            | 1 h                   |
| Refresh token           | 365 days              |

Revocation primitive: **rotate `JWT_SIGNING_KEY` env var in Vercel** → all tokens (and `client_id`s) become invalid → connected clients re-run DCR + OAuth. Suitable for a personal bridge; not appropriate as a multi-tenant SaaS.

---

## Set up

### 1. Create a Notion integration

1. Go to <https://www.notion.so/profile/integrations> → **New integration** → **Public integration**.
2. **Capabilities** → enable:
   - Read content
   - **User information including email addresses** (required if you want to use email-based allowlist)
3. **OAuth Domain & URIs** → add `https://<your-domain>/notion/oauth/notion-callback` (you'll know the exact domain after step 3 — come back here to update once Vercel assigns it).
4. Note `OAuth client ID` and `OAuth client secret`.

### 2. Deploy to Vercel

1. Fork this repo or push your own copy to GitHub.
2. <https://vercel.com/new> → import the repo.
3. **Build settings** → leave defaults (Next.js detected automatically).
4. **Environment Variables** → set:

   | Name                           | Value                                                                                                                            |
   | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
   | `PUBLIC_BASE_URL`              | Apex URL of this deployment (no path, no trailing slash). E.g. `https://mcp.example.com`. Shared across all bridges in this repo |
   | `JWT_SIGNING_KEY`              | Output of `openssl rand -base64 32`                                                                                              |
   | `NOTION_OAUTH_CLIENT_ID`       | From step 1                                                                                                                      |
   | `NOTION_OAUTH_CLIENT_SECRET`   | From step 1                                                                                                                      |
   | `ALLOWED_NOTION_EMAILS`        | Comma-separated emails (preferred)                                                                                               |
   | `ALLOWED_NOTION_WORKSPACE_IDS` | Comma-separated workspace UUIDs (optional fallback if the integration capability isn't enabled)                                  |

5. Deploy.
6. Optionally attach a custom domain (e.g. `mcp.example.com`) — update `PUBLIC_BASE_URL` to match the apex.
7. Go back to your Notion integration and add the **final** redirect URI: `<PUBLIC_BASE_URL>/notion/oauth/notion-callback`.

### 3. Add to Claude.ai

1. <https://claude.ai/settings/connectors> → **Add custom connector**.
2. URL: `https://<your-vercel-domain>/notion` (no `/api/mcp` suffix; the subdomain says MCP already).
3. Claude walks you through OAuth → choose the Notion workspace to connect.
4. Try one of these:
   - "Give me my 10 most recent Journal entries sorted by Date descending, with Tags and Satisfaction."
   - "What's in my In Progress view?" (Claude composes `notion-fetch` + this bridge's `notion-query-database-view`.)
   - "Page through everything in my Tags data source 25 at a time."

### Multiple Notion accounts

Re-run "Connect" in Claude.ai with the same URL and pick a different Notion workspace. If Claude.ai refuses to add the same URL twice, deploy a second Vercel project on a different subdomain (e.g. `mcp-work.example.com`).

---

## Local development

```bash
pnpm install
cp .env.example .env  # then fill in
pnpm dev              # http://localhost:3000/notion
```

Useful scripts:

|                  |                                                                     |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm test`      | Run vitest (53 tests covering OAuth AS + property renderer + tools) |
| `pnpm typecheck` | `tsc --noEmit`                                                      |
| `pnpm lint`      | oxlint                                                              |
| `pnpm format`    | oxfmt write                                                         |
| `pnpm build`     | Verify production build                                             |

OAuth flow can be exercised locally using the `mcp-cli` or `@modelcontextprotocol/inspector`. Note that Notion's OAuth requires HTTPS redirect URIs for production credentials — use ngrok or a Vercel preview deploy if you need to test the full handshake.

---

## Adding more bridges

Each bridge lives under `app/<name>/` with its own MCP route at `app/<name>/route.ts` and OAuth endpoints at `app/<name>/oauth/*`. Reuse [`lib/oauth-as/`](./lib/oauth-as/) — the AS layer is upstream-agnostic. The Notion bridge under [`app/notion/`](./app/notion/) is the reference implementation.

Bridge-specific code (tools, upstream client, identity extraction) lives in `app/<name>/_internal/`. Next.js skips folders prefixed `_` for routing, so they live alongside the route handlers without being exposed.

`PUBLIC_BASE_URL` is the **apex** URL of the deployment (e.g. `https://mcp.example.com`); each bridge's `_internal/config.ts` declares its own `BRIDGE_PATH` constant (`/notion`, `/strava`, etc.) and appends it. Adding a bridge does not require new env vars for the host.

---

## Threat model

This bridge is designed for a **single human operator (the person running the deployment)** plus a small allowlist of trusted Notion workspaces. Key properties:

- **No per-token revocation.** Tokens are valid until their natural expiry. To invalidate everything immediately, rotate `JWT_SIGNING_KEY` in Vercel and redeploy.
- **No state storage.** Stolen logs / KV dumps reveal nothing: the only secret is `JWT_SIGNING_KEY`.
- **Allowlist enforced on Notion callback.** Random Claude.ai users who manage to discover the URL and start an OAuth flow are rejected with a 403 once Notion returns their workspace info; they never receive an access token from this bridge.
- **PKCE required.** No `client_secret` is issued for DCR clients (`token_endpoint_auth_method: "none"`); PKCE binds the auth code to the original authorize request.
- **Redirect URIs are validated.** During `/authorize`, the `redirect_uri` must be one that was registered via DCR. During `/token`, the `redirect_uri` must match the one used in the auth code.
- **Consent screen interrupts every OAuth flow.** Before forwarding to Notion, `/oauth/authorize` renders a server-side consent page that prominently displays the registrable domain (eTLD+1) the authorization code would be sent to. Even if you click a phisher's crafted authorize URL, you get a chance to verify the domain before reaching Notion's screen. The DCR-self-reported `client_name` is deliberately not shown — only the cryptographically-bound redirect URI is.
- **Punycode redirect URIs are rejected.** Internationalized domains (`xn--*`, or any Unicode hostname that Node normalizes to Punycode) are refused at DCR time. This fails closed against IDN homograph attacks like `clаude.ai` (Cyrillic а). If you actually need to use this with an IDN destination one day, remove the check in `lib/oauth-as/register.ts` and add a visible Punycode warning on the consent screen instead.

Inappropriate for: multi-tenant SaaS, hosting at scale, anything where you don't control the deploy.

### OAuth phishing — the inherent risk to know about

DCR (Dynamic Client Registration) lets any party self-register a `client_id` and pick any `redirect_uri`. An attacker can craft an `/oauth/authorize?client_id=...&redirect_uri=https://attacker.com/cb` URL and send it to you. If you click it AND click "Allow" on Notion's screen, the authorization code goes to the attacker — same pattern as every OAuth phishing attack. Mitigations in this bridge:

1. The consent screen showing the registrable domain (see above) — your last chance to notice before the upstream consent.
2. Punycode rejection — homograph variants of trusted domains can't even register.
3. The workspace allowlist — limits blast radius to workspaces you've already authorized.

None of these prevent you from authorizing a hostile request you actively confirm. The usual OAuth-hygiene rule applies: don't click `oauth/authorize?...` URLs from untrusted sources.
