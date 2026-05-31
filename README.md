# mcp-bridge

> Personal, self-hosted MCP servers

## Services

### Notion

The official Notion MCP gates its database query tools behind Business plans. This MCP server reimplements them, running alongside the official MCP (which exposes CRUD and search).

| Tool                         | What it does                                                |
| ---------------------------- | ----------------------------------------------------------- |
| `notion-query-data-source`   | Query a database with a filter, sorts, and pagination       |
| `notion-query-database-view` | Query a saved view, applying its configured filter and sort |

#### Setup

1. [Create a Notion integration](https://www.notion.so/profile/integrations) (Public). Enable capabilities **Read content** and **User information including email addresses**. Add redirect URI `<PUBLIC_BASE_URL>/notion/oauth/notion-callback`. Then on the deployment, set:

| Env var                        | Value                                          |
| ------------------------------ | ---------------------------------------------- |
| `NOTION_OAUTH_CLIENT_ID`       | From the integration                           |
| `NOTION_OAUTH_CLIENT_SECRET`   | From the integration                           |
| `ALLOWED_NOTION_EMAILS`        | Comma-separated workspace-owner emails (preferred) |
| `ALLOWED_NOTION_WORKSPACE_IDS` | Comma-separated workspace UUIDs (fallback)     |

2. **Connect the MCP.** Add `<PUBLIC_BASE_URL>/notion` to the agent, e.g. Claude.ai. Walk through OAuth, pick an account, and connect.

## Architecture

```
Claude.ai / ChatGPT ── DCR + OAuth 2.1 + PKCE ──▶ mcp-bridge (Vercel) ── upstream OAuth ──▶ service
                                                       │
                                                       └── allowlist check on callback
```

The OAuth layer ([`lib/oauth-as/`](./lib/oauth-as/)) is shared across services:

- Each MCP server is both the OAuth **resource server** (validates bearers on `/<service>`) and its own **authorization server**, brokering the upstream service's OAuth.
- **Stateless.** Every artifact (auth code, access/refresh token, `client_id`) is a [`jose`](https://github.com/panva/jose) JWT signed/encrypted with one secret. No DB, no KV.
- **DCR** (RFC 7591) for client registration, **PKCE** required, **refresh tokens** so clients don't re-auth.

| Artifact        | TTL                   |
| --------------- | --------------------- |
| `client_id`     | none (HMAC-validated) |
| Authorize state | 10 min                |
| Auth code       | 5 min                 |
| Access token    | 1 h                   |
| Refresh token   | 365 days              |

## Deploy

It's a Next.js app. On Vercel, set these shared env vars alongside each service's own:

| Env var           | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL` | Deployment apex, no path or trailing slash. E.g. `https://mcp.example.com` |
| `JWT_SIGNING_KEY` | `openssl rand -base64 32`                                                  |

## Local development

```bash
pnpm install
cp .env.example .env   # fill in
pnpm dev               # localhost:3000/notion
```

`pnpm test` (vitest), `typecheck`, `lint` (oxlint), `format` (oxfmt), `build`. Drive OAuth locally with `@modelcontextprotocol/inspector`; Notion needs an HTTPS redirect URI, so use ngrok or a preview deploy for the full handshake.

## Adding a service

A service is a section here plus a folder. Drop `app/<service>/` alongside `app/notion/`: `route.ts` (MCP endpoint), `oauth/*` (OAuth endpoints), `_internal/` (tools, client, identity; underscore keeps it off the router). Reuse `lib/oauth-as/` as-is. Set `BRIDGE_PATH` in `_internal/config.ts`; the only new env vars are that service's own OAuth + allowlist.

## Threat model

Built for one operator and an allowlist of trusted accounts. Run it otherwise and these stop holding.

- **No per-token revocation.** Tokens live until expiry; rotate `JWT_SIGNING_KEY` to kill all of them.
- **Nothing at rest.** No DB/session store. Only secret is `JWT_SIGNING_KEY`.
- **Allowlist on the upstream callback.** A stranger who starts a flow gets a 403 once the service returns their identity, before any token is minted.
- **Redirect URIs checked twice.** Must match a DCR registration at `/authorize`, and the auth code's value at `/token`.

### OAuth phishing

DCR lets anyone register a `client_id` for any `redirect_uri`, so an attacker can send you an authorization link that diverts your auth code to their own server.

The consent screen blunts this: before handing you off to the upstream service, it shows the **domain** your auth code would be sent to. It also rejects internationalized domains outright, failing closed on homographs like `clаude.ai`.
