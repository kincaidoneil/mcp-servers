// End-to-end test of the Hevy consent flow: DCR → authorize → form submit
// (key validation + allowlist) → token exchange → verified access token
// carrying the pasted API key as the upstream token.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleTokenRequest,
  registerClient,
  validateAuthorize,
  verifyAccessToken,
} from "@/lib/oauth-as";
import { POST as submitPost } from "../../oauth/submit/route";
import { getConfig, resetConfigCacheForTesting } from "../config";
import {
  HEVY_BASE,
  HttpResponse,
  http,
  setupHevyMockServer,
  TEST_API_KEY,
  userInfoFixture,
} from "./test-helpers";

const server = setupHevyMockServer();

const ALLOWED_USER_ID = "9c465af3-de7d-42bc-9c7c-f0170396358b";
const REDIRECT_URI = "https://claude.ai/api/mcp/callback";

beforeEach(() => {
  process.env["PUBLIC_BASE_URL"] = "https://mcp.example.com";
  process.env["JWT_SIGNING_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["ALLOWED_HEVY_USER_IDS"] = ALLOWED_USER_ID;
  resetConfigCacheForTesting();
});

afterEach(() => {
  resetConfigCacheForTesting();
});

function makePkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function startAuthorize() {
  const config = getConfig();
  const reg = await registerClient(
    { client_name: "Claude.ai", redirect_uris: [REDIRECT_URI] },
    config.oauth,
  );
  if (!reg.ok) throw new Error("DCR failed");

  const { verifier, challenge } = makePkcePair();
  const auth = await validateAuthorize(
    {
      client_id: reg.response.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "claude-state-123",
      scope: "mcp:read",
    },
    config.oauth,
  );
  if (!auth.ok) throw new Error("authorize rejected");
  return { asState: auth.asState, verifier };
}

function submitForm(fields: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams(fields);
  const req = new Request("https://mcp.example.com/hevy/oauth/submit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return submitPost(req);
}

function stubUserInfo() {
  server.use(
    http.get(`${HEVY_BASE}/user/info`, ({ request }) => {
      if (request.headers.get("api-key") !== TEST_API_KEY) {
        return HttpResponse.json({ error: "invalid api key" }, { status: 401 });
      }
      return HttpResponse.json(userInfoFixture({ id: ALLOWED_USER_ID }));
    }),
  );
}

describe("Hevy consent flow", () => {
  it("issues a token that carries the pasted API key end-to-end", async () => {
    stubUserInfo();
    const { asState, verifier } = await startAuthorize();

    const response = await submitForm({ as_state: asState, api_key: TEST_API_KEY });
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("claude-state-123");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResult = await handleTokenRequest(
      {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
      getConfig().oauth,
    );
    if (!tokenResult.ok) throw new Error(JSON.stringify(tokenResult.error));

    const verified = await verifyAccessToken(tokenResult.response.access_token, getConfig().oauth);
    expect(verified?.upstreamAccessToken).toBe(TEST_API_KEY);
    expect(verified?.identity).toMatchObject({ userId: ALLOWED_USER_ID });
  });

  it("rejects a tampered as_state with 400 and no redirect", async () => {
    stubUserInfo();
    const { asState } = await startAuthorize();
    const tampered = asState.slice(0, -8) + "AAAAAAAA";

    const response = await submitForm({ as_state: tampered, api_key: TEST_API_KEY });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a missing as_state with 400", async () => {
    const response = await submitForm({ api_key: TEST_API_KEY });
    expect(response.status).toBe(400);
  });

  it("rejects a missing API key with 400 before calling Hevy", async () => {
    const { asState } = await startAuthorize();
    const response = await submitForm({ as_state: asState, api_key: "   " });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("missing API key");
  });

  it("rejects a key Hevy does not recognize", async () => {
    stubUserInfo();
    const { asState } = await startAuthorize();
    const response = await submitForm({
      as_state: asState,
      api_key: "99999999-9999-9999-9999-999999999999",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("invalid API key");
    expect(html).not.toContain("99999999-9999-9999-9999-999999999999");
  });

  it("rejects a valid key whose user is not allowlisted with 403", async () => {
    server.use(
      http.get(`${HEVY_BASE}/user/info`, () =>
        HttpResponse.json(userInfoFixture({ id: "someone-else", name: "Stranger" })),
      ),
    );
    const { asState } = await startAuthorize();
    const response = await submitForm({ as_state: asState, api_key: TEST_API_KEY });
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("Stranger");
    expect(html).not.toContain(TEST_API_KEY);
  });

  it("returns 502 when Hevy is unreachable", async () => {
    server.use(http.get(`${HEVY_BASE}/user/info`, () => HttpResponse.error()));
    const { asState } = await startAuthorize();
    const response = await submitForm({ as_state: asState, api_key: TEST_API_KEY });
    expect(response.status).toBe(502);
  });
});

describe("Hevy config", () => {
  it("throws when ALLOWED_HEVY_USER_IDS is empty", () => {
    process.env["ALLOWED_HEVY_USER_IDS"] = "";
    resetConfigCacheForTesting();
    expect(() => getConfig()).toThrow(/ALLOWED_HEVY_USER_IDS/);
  });

  it("uses the hardcoded display preferences", () => {
    expect(getConfig().display).toEqual({ timeZone: "America/New_York", units: "imperial" });
  });
});
