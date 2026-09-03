// The pare consent flow: DCR, authorize, access-code submit, token exchange,
// and the identity.user claim the tools key sessions on.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleTokenRequest,
  registerClient,
  validateAuthorize,
  verifyAccessToken,
} from "@/lib/oauth-as";
import { findUserByCode, POST as submitPost } from "../../oauth/submit/route";
import { getConfig, parseAccessCodes, resetConfigCacheForTesting } from "../config";

const REDIRECT_URI = "https://claude.ai/api/mcp/callback";

beforeEach(() => {
  process.env["PUBLIC_BASE_URL"] = "https://mcp.example.com";
  process.env["JWT_SIGNING_KEY"] = Buffer.alloc(32, 7).toString("base64");
  process.env["PARE_ACCESS_CODES"] = "kincaid:secret-a,guest:secret-b";
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
  const req = new Request("https://mcp.example.com/pare/oauth/submit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return submitPost(req);
}

describe("pare consent flow", () => {
  it("issues a token whose identity names the code's owner", async () => {
    const { asState, verifier } = await startAuthorize();

    const response = await submitForm({ as_state: asState, access_code: " secret-b " });
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
    expect(verified?.identity).toEqual({ user: "guest" });
  });

  it("rejects a wrong or missing code with 403 and no redirect", async () => {
    const { asState } = await startAuthorize();
    const responses = await Promise.all(
      ["secret-c", "secret-", ""].map((access_code) =>
        submitForm({ as_state: asState, access_code }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(bodies[i]).toContain("not authorized");
    }
  });

  it("rejects a tampered as_state with 400", async () => {
    const { asState } = await startAuthorize();
    const tampered = asState.slice(0, -8) + "AAAAAAAA";
    const response = await submitForm({ as_state: tampered, access_code: "secret-a" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("pare config", () => {
  it("parses name:code pairs, splitting on the first colon", () => {
    expect([...parseAccessCodes(" a:1 , b:x:y ,, :z, c: ").entries()]).toEqual([
      ["a", "1"],
      ["b", "x:y"],
    ]);
  });

  it("throws when PARE_ACCESS_CODES is empty", () => {
    process.env["PARE_ACCESS_CODES"] = "";
    resetConfigCacheForTesting();
    expect(() => getConfig()).toThrow(/PARE_ACCESS_CODES/);
  });

  it("matches codes without leaking which name they belong to", () => {
    const codes = parseAccessCodes("kincaid:secret-a,guest:secret-b");
    expect(findUserByCode(codes, "secret-a")).toBe("kincaid");
    expect(findUserByCode(codes, "secret-b")).toBe("guest");
    expect(findUserByCode(codes, "secret-ab")).toBeNull();
    expect(findUserByCode(codes, "")).toBeNull();
  });
});
