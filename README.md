# mcp-servers

> Kincaid's custom MCP servers

## Notion

The official Notion MCP gates its database query tools behind Business plans. This MCP server reimplements them, running alongside the official MCP (which exposes CRUD and search).

| Tool                         | Description                                                 |
| :--------------------------- | :---------------------------------------------------------- |
| `notion-query-data-source`   | Query a database with a filter, sorts, and pagination       |
| `notion-query-database-view` | Query a saved view, applying its configured filter and sort |

#### Setup

1. **[Create a Notion integration](https://www.notion.so/profile/integrations).** Enable capabilities **Read content** and **User information including email addresses**. Add redirect URI `<PUBLIC_BASE_URL>/notion/oauth/notion-callback`. Then on the deployment, set:

   | Environment variable           | Value                                              |
   | :----------------------------- | :------------------------------------------------- |
   | `NOTION_OAUTH_CLIENT_ID`       | From the integration                               |
   | `NOTION_OAUTH_CLIENT_SECRET`   | From the integration                               |
   | `ALLOWED_NOTION_EMAILS`        | Comma-separated workspace-owner emails (preferred) |
   | `ALLOWED_NOTION_WORKSPACE_IDS` | Comma-separated workspace UUIDs (fallback)         |

2. **Connect the MCP.** Add `<PUBLIC_BASE_URL>/notion` to the agent, e.g. Claude.ai. Walk through OAuth, pick an account, and connect.

## Hevy

Read and log [Hevy](https://hevy.com) workouts, build routines, and track body measurements from an agent.

| Tool                           | Description                                             |
| :----------------------------- | :------------------------------------------------------ |
| `hevy-list-workouts`           | List logged workouts with exercises and sets            |
| `hevy-get-workout`             | Fetch one workout by id                                 |
| `hevy-get-workout-count`       | Total workout count                                     |
| `hevy-get-exercise-history`    | Every logged set of one exercise, for progress analysis |
| `hevy-save-workout`            | Log a workout, or update one (full replace)             |
| `hevy-list-routines`           | List routines                                           |
| `hevy-get-routine`             | Fetch one routine by id                                 |
| `hevy-save-routine`            | Create a routine, or update one (full replace)          |
| `hevy-list-exercise-templates` | List exercises with muscle groups and equipment         |
| `hevy-get-exercise-template`   | Fetch one exercise template by id                       |
| `hevy-list-routine-folders`    | List routine folders, or fetch one by id                |
| `hevy-create-routine-folder`   | Create a routine folder                                 |
| `hevy-list-body-measurements`  | List body weight and circumference measurements         |
| `hevy-log-body-measurement`    | Log a body measurement for a date                       |

The Hevy API has no deletes, so neither does this server. All values are metric (`weight_kg`, `distance_meters`, `duration_seconds`, circumferences in cm).

#### Setup

Hevy has no OAuth; its API uses a static per-user key ([Hevy Pro](https://hevy.com/settings?developer) required). The bridge still fronts the MCP endpoint with OAuth: the consent screen collects your API key, validates it against `GET /v1/user/info`, and seals it inside the encrypted tokens it issues. The key is never stored server-side. To revoke, rotate `JWT_SIGNING_KEY` or regenerate the key in Hevy.

1. **Set the allowlist.** On the deployment, set `ALLOWED_HEVY_USER_IDS` to comma-separated Hevy user ids (the `data.id` from `curl -H "api-key: $KEY" https://api.hevyapp.com/v1/user/info`).

2. **Connect the MCP.** Add `<PUBLIC_BASE_URL>/hevy` to the agent. On the consent screen, paste your API key from [Hevy settings → Developer](https://hevy.com/settings?developer).

## Architecture

```mermaid
flowchart LR
    client["Claude.ai / ChatGPT"]
    bridge["mcp-servers · Vercel"]
    notion["Notion"]
    hevy["Hevy"]

    client -->|"DCR · OAuth 2.1 · PKCE"| bridge
    bridge -->|"upstream OAuth"| notion
    notion -.->|"allowlist check on callback"| bridge
    bridge -->|"API-key validation"| hevy
```

Each service's endpoint is its own OAuth authorization server (shared code in [`lib/oauth-as/`](./lib/oauth-as/)): it issues the tokens clients use and handles the upstream credential underneath. For providers with OAuth (Notion), it brokers the upstream flow; for API-key providers (Hevy), the consent screen collects and validates the key instead.

It holds no state: auth codes and access/refresh tokens are self-contained [`jose`](https://github.com/panva/jose) JWTs, so the server needs no database or key-value store. To revoke all issued tokens, rotate `JWT_SIGNING_KEY`.

## Deployment

Deploy the Next.js app (e.g. on Vercel), configuring these environment variables:

| Environment variable | Value                                      |
| :------------------- | :----------------------------------------- |
| `PUBLIC_BASE_URL`    | Deployment apex, no path or trailing slash |
| `JWT_SIGNING_KEY`    | `openssl rand -base64 32`                  |

## Local development

```bash
pnpm install
cp .env.example .env   # fill in
pnpm dev               # localhost:3000/notion
```

`pnpm test` (vitest), `typecheck`, `lint` (oxlint), `format` (oxfmt), `build`

Drive OAuth locally with `@modelcontextprotocol/inspector`. Notion needs an HTTPS redirect URI, so use ngrok or a preview deploy for the full handshake. Hevy has no upstream redirect, so its full flow works on plain localhost.

## Note on OAuth phishing

Dynamic client registration lets anyone register a `client_id` for any `redirect_uri`. An attacker may trick users into opening an authorization link and approving, gaining access to the upstream provider.

To blunt this, we render an interstitial consent screen that prominently displays the _registrable domain_ (eTLD+1) of the site requesting access, so `claude.ai.evil.com` shows as `evil.com` rather than `claude.ai`. It also rejects internationalized domains outright, failing closed on homographs like `clаude.ai` (which could be confused with the legitimate `claude.ai`).
