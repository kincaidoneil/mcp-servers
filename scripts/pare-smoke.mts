// HTTP smoke test for the pare bridge. Walks discovery, DCR, the consent
// form, PKCE token exchange, and every tool over Streamable HTTP against a
// running server, the way a real MCP client does. Stops at the first failure.
//
//   PARE_ACCESS_CODE=<code> PARE_BASE_URL=http://localhost:3100 pnpm smoke:pare
//
// oxlint-disable no-console

import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const base = (process.env["PARE_BASE_URL"] ?? "http://localhost:3100").replace(/\/$/, "");
const accessCode = requireAccessCode();

function requireAccessCode(): string {
  const value = process.env["PARE_ACCESS_CODE"];
  if (value) return value;
  console.error("PARE_ACCESS_CODE is required (a code from the server's PARE_ACCESS_CODES).");
  return process.exit(2);
}

const pare = `${base}/pare`;
// http://localhost is the one non-https redirect DCR accepts.
const redirectUri = "http://localhost:8765/callback";
const clientState = `smoke-${randomBytes(6).toString("hex")}`;

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

// ---- Reporting ---------------------------------------------------------------

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

let stepNumber = 0;
async function step<T>(label: string, run: () => Promise<{ detail: string; value: T }>) {
  stepNumber += 1;
  const { detail, value } = await run();
  console.log(`ok ${String(stepNumber).padStart(2)}  ${label}: ${detail}`);
  return value;
}

// ---- HTTP helpers ------------------------------------------------------------

async function readJson<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const text = await res.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(`${what}: expected JSON, got ${res.status} ${text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(`${what}: unexpected shape\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function postForm(url: string, fields: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

// ---- Schemas for what comes back --------------------------------------------

const AsMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()),
});
const ResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
});
const Registration = z.object({ client_id: z.string().min(1) });
const Tokens = z.object({ access_token: z.string().min(1), token_type: z.literal("Bearer") });

const Started = z.object({ session_id: z.string().min(1), total: z.number() });
const Loaded = z.object({
  session: z.object({ id: z.string(), version: z.number(), queue: z.array(z.string()) }),
});
const Recorded = z.object({ version: z.number(), decided: z.number(), status: z.string() });
const Results = z.object({
  decided: z.number(),
  decisions: z.array(z.object({ item_id: z.string(), note: z.string().optional() })),
});
const Sessions = z.object({ sessions: z.array(z.object({ id: z.string() })) });

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  const content = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(result.content ?? []);
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<{ data: T; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) fail(`${name} returned an error: ${textOf(result)}`);
  const parsed = schema.safeParse(result.structuredContent);
  if (!parsed.success) {
    fail(`${name}: unexpected structuredContent\n${z.prettifyError(parsed.error)}`);
  }
  return { data: parsed.data, text: textOf(result) };
}

// ---- The flow ---------------------------------------------------------------

async function main() {
  console.log(`pare smoke against ${base}`);

  await step("discovery", async () => {
    const asRes = await fetch(`${base}/.well-known/oauth-authorization-server/pare`);
    expect(asRes.status === 200, `AS metadata returned ${asRes.status}`);
    const as = await readJson(asRes, AsMetadata, "AS metadata");
    expect(as.issuer === pare, `issuer is ${as.issuer}, expected ${pare}`);
    expect(
      as.authorization_endpoint === `${pare}/oauth/authorize`,
      `authorization_endpoint is ${as.authorization_endpoint}`,
    );
    expect(as.token_endpoint === `${pare}/oauth/token`, `token_endpoint is ${as.token_endpoint}`);
    expect(
      as.registration_endpoint === `${pare}/oauth/register`,
      `registration_endpoint is ${as.registration_endpoint}`,
    );
    expect(as.code_challenge_methods_supported.includes("S256"), "S256 not advertised");

    const prRes = await fetch(`${pare}/.well-known/oauth-protected-resource`);
    expect(prRes.status === 200, `protected resource metadata returned ${prRes.status}`);
    const pr = await readJson(prRes, ResourceMetadata, "protected resource metadata");
    expect(pr.resource === pare, `resource is ${pr.resource}, expected ${pare}`);
    expect(pr.authorization_servers.includes(pare), "authorization_servers lacks the bridge");
    return { detail: `issuer ${as.issuer}`, value: undefined };
  });

  const clientId = await step("dynamic client registration", async () => {
    const res = await fetch(`${pare}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "pare smoke", redirect_uris: [redirectUri] }),
    });
    expect(res.status === 201, `register returned ${res.status}`);
    const { client_id } = await readJson(res, Registration, "registration");
    return { detail: `client_id ${client_id.slice(0, 24)}...`, value: client_id };
  });

  const asState = await step("authorize page", async () => {
    const url = new URL(`${pare}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", clientState);
    url.searchParams.set("scope", "mcp:read");
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status === 200, `authorize returned ${res.status}`);
    const html = await res.text();
    const match = /<input[^>]*name="as_state"[^>]*value="([^"]+)"/.exec(html);
    expect(match !== null, "no as_state input in the consent form");
    const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
    expect(action === `${pare}/oauth/submit`, `form posts to ${action ?? "(none)"}`);
    return {
      detail: `form posts to ${action}, as_state ${match[1]!.length} chars`,
      value: match[1]!,
    };
  });

  const code = await step("consent submit", async () => {
    const good = await postForm(`${pare}/oauth/submit`, {
      as_state: asState,
      access_code: accessCode,
    });
    expect(good.status === 303, `correct code returned ${good.status}, expected 303`);
    const location = good.headers.get("location");
    expect(location !== null, "303 without a Location header");
    const target = new URL(location);
    expect(
      target.origin + target.pathname === redirectUri,
      `redirected to ${target.origin + target.pathname}, expected ${redirectUri}`,
    );
    expect(target.searchParams.get("state") === clientState, "state did not round-trip");
    const authCode = target.searchParams.get("code");
    expect(authCode !== null && authCode.length > 0, "no code in the redirect");

    const bad = await postForm(`${pare}/oauth/submit`, {
      as_state: asState,
      access_code: `${accessCode}-wrong`,
    });
    expect(bad.status === 403, `wrong code returned ${bad.status}, expected 403`);
    return { detail: "303 with code for the right code, 403 for a wrong one", value: authCode };
  });

  const accessToken = await step("token exchange", async () => {
    const res = await postForm(`${pare}/oauth/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (res.status !== 200) fail(`token returned ${res.status}: ${await res.text()}`);
    const tokens = await readJson(res, Tokens, "token response");
    return {
      detail: `access_token ${tokens.access_token.length} chars`,
      value: tokens.access_token,
    };
  });

  const client = new Client({ name: "pare-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(pare), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  try {
    await step("mcp initialize + tools/list", async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const wanted = [
        "pare-start",
        "pare-resume",
        "pare-get-results",
        "pare-list-sessions",
        "pare-load",
        "pare-record",
      ];
      const missing = wanted.filter((name) => !byName.has(name));
      expect(missing.length === 0, `missing tools: ${missing.join(", ")}`);
      const Ui = z.object({
        ui: z.object({
          resourceUri: z.string().optional(),
          visibility: z.array(z.string()).optional(),
        }),
      });
      const uiOf = (name: string) => {
        // oxlint-disable-next-line no-underscore-dangle
        const parsed = Ui.safeParse(byName.get(name)?._meta);
        return parsed.success ? parsed.data.ui : undefined;
      };
      expect(
        uiOf("pare-start")?.resourceUri === "ui://pare/app.html",
        "pare-start lacks _meta.ui.resourceUri",
      );
      for (const name of ["pare-load", "pare-record"]) {
        const visibility = uiOf(name)?.visibility;
        expect(
          visibility !== undefined && visibility.length === 1 && visibility[0] === "app",
          `${name} visibility is ${JSON.stringify(visibility)}, expected ["app"]`,
        );
      }
      const serverName = client.getServerVersion()?.name;
      return { detail: `server "${serverName}", ${tools.length} tools`, value: undefined };
    });

    await step("resources/read ui://pare/app.html", async () => {
      const { contents } = await client.readResource({ uri: "ui://pare/app.html" });
      expect(contents.length === 1, `expected one content item, got ${contents.length}`);
      const item = contents[0]!;
      expect(
        item.mimeType === "text/html;profile=mcp-app",
        `mimeType is ${item.mimeType ?? "(none)"}`,
      );
      expect("text" in item, "resource content is a blob, expected text");
      expect(/^<!doctype html>/i.test(item.text), "HTML does not start with <!doctype html>");
      const kb = Math.round(item.text.length / 1024);
      expect(item.text.length > 100 * 1024, `HTML is only ${kb} KB, expected more than 100 KB`);
      return { detail: `${item.mimeType}, ${kb} KB`, value: undefined };
    });

    const sessionId = await step("pare-start", async () => {
      const { data } = await callTool(
        client,
        "pare-start",
        {
          title: "Smoke test",
          keep: { label: "Keep" },
          dispose: { label: "Drop" },
          items: [
            { id: "s1", title: "First", subtitle: "smoke" },
            { id: "s2", title: "Second", suggestion: { action: "dispose", reason: "unused" } },
            { id: "s3", title: "Third" },
          ],
        },
        Started,
      );
      expect(data.total === 3, `total is ${data.total}`);
      return { detail: `session ${data.session_id}, ${data.total} items`, value: data.session_id };
    });

    await step("pare-load", async () => {
      const { data } = await callTool(client, "pare-load", { session_id: sessionId }, Loaded);
      expect(data.session.id === sessionId, `loaded ${data.session.id}`);
      expect(data.session.version === 0, `version is ${data.session.version}`);
      expect(
        data.session.queue.join(",") === "s1,s2,s3",
        `queue is ${JSON.stringify(data.session.queue)}`,
      );
      return { detail: `queue ${data.session.queue.join(",")}`, value: undefined };
    });

    const note = "smoke note";
    await step("pare-record", async () => {
      const { data } = await callTool(
        client,
        "pare-record",
        {
          session_id: sessionId,
          decisions: [
            { item_id: "s2", action: "dispose", note, decided_at: new Date().toISOString() },
          ],
        },
        Recorded,
      );
      expect(data.version === 1, `version is ${data.version}, expected 1`);
      expect(data.decided === 1, `decided is ${data.decided}, expected 1`);
      return { detail: `version ${data.version}, ${data.decided} decided`, value: undefined };
    });

    await step("pare-get-results", async () => {
      const { data, text } = await callTool(
        client,
        "pare-get-results",
        { session_id: sessionId },
        Results,
      );
      expect(data.decided === 1, `decided is ${data.decided}`);
      expect(data.decisions[0]?.note === note, "note missing from structuredContent");
      expect(text.includes(note), `note missing from text:\n${text}`);
      expect(text.includes("Drop (1)"), `dispose label missing from text:\n${text}`);
      return { detail: text.split("\n")[0] ?? "", value: undefined };
    });

    await step("pare-list-sessions", async () => {
      const { data } = await callTool(client, "pare-list-sessions", {}, Sessions);
      expect(
        data.sessions.some((s) => s.id === sessionId),
        `session ${sessionId} not in the list`,
      );
      return {
        detail: `${data.sessions.length} session(s), includes ${sessionId}`,
        value: undefined,
      };
    });
  } finally {
    await client.close().catch(() => undefined);
  }

  await step("unauthenticated tools/list", async () => {
    const res = await fetch(pare, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status === 401, `returned ${res.status}, expected 401`);
    const www = res.headers.get("www-authenticate");
    expect(www !== null && www.length > 0, "401 without WWW-Authenticate");
    return { detail: `401, WWW-Authenticate: ${www}`, value: undefined };
  });

  console.log("all steps passed");
}

main().catch((err: unknown) => {
  if (err instanceof SmokeFailure) {
    console.error(`FAIL step ${stepNumber}: ${err.message}`);
  } else {
    console.error(`FAIL step ${stepNumber}:`, err);
  }
  process.exit(1);
});
