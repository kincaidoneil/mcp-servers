import { describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  registerClient,
  validateAuthorize,
  decodeAsState,
  buildClientCallbackUrl,
  checkAllowlist,
  handleTokenRequest,
  verifyAccessToken,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "..";
import type { OAuthConfig } from "../types";

const config: OAuthConfig = {
  baseUrl: "https://mcp.example.com/notion",
  signingKey: new Uint8Array(32).fill(11),
};

function makePkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function runFlow(opts?: { allowedEmails?: string[] }) {
  const allowedEmails = opts?.allowedEmails ?? ["kincaid@example.com"];

  // 1. DCR
  const reg = await registerClient(
    { client_name: "Claude.ai", redirect_uris: ["https://claude.ai/api/mcp/callback"] },
    config,
  );
  if (!reg.ok) throw new Error("DCR failed");
  const clientId = reg.response.client_id;

  // 2. Authorize
  const { verifier, challenge } = makePkcePair();
  const authResult = await validateAuthorize(
    {
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "claude-state-123",
      scope: "read",
    },
    config,
  );
  if (!authResult.ok) throw new Error("authorize rejected");

  // 3. Upstream "Notion" responds — we decode AS state, build the client callback
  const stateResult = await decodeAsState(authResult.asState, config);
  if (!stateResult.ok) throw new Error("AS state failed to decode");

  const identity = { email: "kincaid@example.com", workspaceId: "ws-1", workspaceName: "Personal" };
  expect(checkAllowlist(identity, allowedEmails, [])).toBe(true);

  const clientCallbackUrl = await buildClientCallbackUrl(
    stateResult.state,
    "notion-access-token-fake",
    identity,
    config,
  );
  const callback = new URL(clientCallbackUrl);
  const code = callback.searchParams.get("code");
  expect(callback.searchParams.get("state")).toBe("claude-state-123");
  if (!code) throw new Error("missing code in callback");

  // 4. Token exchange
  const tokenResult = await handleTokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/callback",
      code_verifier: verifier,
    },
    config,
  );
  if (!tokenResult.ok)
    throw new Error("token exchange failed: " + JSON.stringify(tokenResult.error));

  // 5. Verify access token can be used by withMcpAuth
  const verified = await verifyAccessToken(tokenResult.response.access_token, config);
  expect(verified?.upstreamAccessToken).toBe("notion-access-token-fake");
  expect(verified?.identity).toEqual(identity);

  return { tokenResult, verifier };
}

describe("OAuth AS — full integration", () => {
  test("DCR → authorize → callback → token → MCP request succeeds", async () => {
    await runFlow();
  });

  test("refresh_token grant issues a fresh access token", async () => {
    const { tokenResult } = await runFlow();
    if (!tokenResult.ok) throw new Error("setup failed");

    const refreshed = await handleTokenRequest(
      { grant_type: "refresh_token", refresh_token: tokenResult.response.refresh_token },
      config,
    );
    if (!refreshed.ok) throw new Error("refresh failed: " + JSON.stringify(refreshed.error));

    const verified = await verifyAccessToken(refreshed.response.access_token, config);
    expect(verified?.upstreamAccessToken).toBe("notion-access-token-fake");
  });

  test("rejects PKCE verifier mismatch", async () => {
    const reg = await registerClient(
      { client_name: "Test", redirect_uris: ["https://claude.ai/api/mcp/callback"] },
      config,
    );
    if (!reg.ok) throw new Error("DCR failed");

    const { challenge } = makePkcePair();
    const auth = await validateAuthorize(
      {
        client_id: reg.response.client_id,
        redirect_uri: "https://claude.ai/api/mcp/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: null,
        scope: null,
      },
      config,
    );
    if (!auth.ok) throw new Error("authorize rejected");

    const stateResult = await decodeAsState(auth.asState, config);
    if (!stateResult.ok) throw new Error("AS state failed");

    const callbackUrl = await buildClientCallbackUrl(stateResult.state, "tok", {}, config);
    const code = new URL(callbackUrl).searchParams.get("code");

    // Use a fresh, mismatching verifier
    const { verifier: wrongVerifier } = makePkcePair();
    const result = await handleTokenRequest(
      {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: "https://claude.ai/api/mcp/callback",
        code_verifier: wrongVerifier,
      },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_grant");
  });

  test("rejects mismatched redirect_uri at token exchange", async () => {
    const reg = await registerClient(
      { client_name: "Test", redirect_uris: ["https://claude.ai/api/mcp/callback"] },
      config,
    );
    if (!reg.ok) throw new Error("DCR failed");
    const { verifier, challenge } = makePkcePair();
    const auth = await validateAuthorize(
      {
        client_id: reg.response.client_id,
        redirect_uri: "https://claude.ai/api/mcp/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: null,
        scope: null,
      },
      config,
    );
    if (!auth.ok) throw new Error("authorize rejected");
    const stateResult = await decodeAsState(auth.asState, config);
    if (!stateResult.ok) throw new Error("AS state failed");
    const callbackUrl = await buildClientCallbackUrl(stateResult.state, "tok", {}, config);
    const code = new URL(callbackUrl).searchParams.get("code");

    const result = await handleTokenRequest(
      {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: "https://attacker.example/cb",
        code_verifier: verifier,
      },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_grant");
  });

  test("rejects an authorize request with an unregistered redirect_uri", async () => {
    const reg = await registerClient(
      { client_name: "Test", redirect_uris: ["https://claude.ai/api/mcp/callback"] },
      config,
    );
    if (!reg.ok) throw new Error("DCR failed");

    const { challenge } = makePkcePair();
    const result = await validateAuthorize(
      {
        client_id: reg.response.client_id,
        redirect_uri: "https://attacker.example/cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: null,
        scope: null,
      },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // unregistered redirect_uri must NOT redirect to it; must be a 400 error
      expect(result.status).toBe(400);
    }
  });

  test("rejects a tampered client_id JWS", async () => {
    const reg = await registerClient(
      { client_name: "Test", redirect_uris: ["https://claude.ai/api/mcp/callback"] },
      config,
    );
    if (!reg.ok) throw new Error("DCR failed");

    // tamper: flip the last 8 characters of the signature
    const tampered = reg.response.client_id.slice(0, -8) + "AAAAAAAA";
    const { challenge } = makePkcePair();
    const result = await validateAuthorize(
      {
        client_id: tampered,
        redirect_uri: "https://claude.ai/api/mcp/callback",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: null,
        scope: null,
      },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  test("allowlist rejects identity not on the list", () => {
    expect(
      checkAllowlist(
        { email: "stranger@example.com", workspaceId: "ws-x" },
        ["kincaid@example.com"],
        ["ws-1"],
      ),
    ).toBe(false);
  });

  test("allowlist accepts identity matching workspace_id when email is missing", () => {
    expect(checkAllowlist({ email: null, workspaceId: "ws-1" }, [], ["ws-1"])).toBe(true);
  });

  test("DCR rejects non-https redirect_uris (except localhost)", async () => {
    const result = await registerClient(
      { client_name: "Test", redirect_uris: ["http://attacker.example/cb"] },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  test("DCR rejects Punycode redirect_uris (homograph defense)", async () => {
    const result = await registerClient(
      { client_name: "Test", redirect_uris: ["https://xn--clude-7we.ai/cb"] },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  test("DCR rejects Punycode in a subdomain too", async () => {
    const result = await registerClient(
      { client_name: "Test", redirect_uris: ["https://xn--clude-7we.example.com/cb"] },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  test("DCR Punycode-normalizes Unicode input and rejects", async () => {
    // `clаude.ai` with a Cyrillic 'а' — new URL() will Punycode-normalize the
    // hostname, and our check sees an xn-- label.
    const result = await registerClient(
      { client_name: "Test", redirect_uris: ["https://clаude.ai/cb"] },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe("invalid_redirect_uri");
  });

  test("DCR accepts http://localhost redirect_uri", async () => {
    const result = await registerClient(
      { client_name: "Test", redirect_uris: ["http://localhost:8080/cb"] },
      config,
    );
    expect(result.ok).toBe(true);
  });

  test("authorization server metadata advertises required capabilities", () => {
    const md = authorizationServerMetadata("https://mcp.example.com/notion", ["read"]);
    expect(md.issuer).toBe("https://mcp.example.com/notion");
    expect(md.authorization_endpoint).toBe("https://mcp.example.com/notion/oauth/authorize");
    expect(md.token_endpoint).toBe("https://mcp.example.com/notion/oauth/token");
    expect(md.registration_endpoint).toBe("https://mcp.example.com/notion/oauth/register");
    expect(md.code_challenge_methods_supported).toContain("S256");
    expect(md.grant_types_supported).toContain("authorization_code");
    expect(md.grant_types_supported).toContain("refresh_token");
  });

  test("protected resource metadata points at the AS", () => {
    const md = protectedResourceMetadata("https://mcp.example.com/notion", ["read"]);
    expect(md.resource).toBe("https://mcp.example.com/notion");
    expect(md.authorization_servers).toEqual(["https://mcp.example.com/notion"]);
    expect(md.bearer_methods_supported).toContain("header");
  });
});
