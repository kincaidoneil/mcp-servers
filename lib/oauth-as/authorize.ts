import { signJws, verifyJws } from "./jwt";
import type { AsStateClaims, ClientIdClaims, OAuthConfig } from "./types";
import { TTL } from "./types";

export interface AuthorizeRequest {
  client_id: string | null;
  redirect_uri: string | null;
  response_type: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  scope: string | null;
}

export type AuthorizeResult =
  | { ok: true; asState: string; clientRedirectUri: string; clientState: string | null }
  | { ok: false; status: 302; redirectUrl: string }
  | { ok: false; status: 400; error: string; error_description: string };

export async function validateAuthorize(
  request: AuthorizeRequest,
  config: OAuthConfig,
): Promise<AuthorizeResult> {
  // Step 1: validate client_id (do this first; if it's bad we can't redirect anywhere safely)
  if (!request.client_id) {
    return badRequest("invalid_request", "missing client_id");
  }
  const clientResult = await verifyJws<ClientIdClaims>(
    request.client_id,
    config.signingKey,
    "client",
  );
  if (!clientResult.ok) {
    return badRequest("invalid_client", `client_id rejected (${clientResult.reason})`);
  }

  // Step 2: validate redirect_uri matches one registered
  if (!request.redirect_uri) {
    return badRequest("invalid_request", "missing redirect_uri");
  }
  if (!clientResult.payload.redirect_uris.includes(request.redirect_uri)) {
    return badRequest("invalid_request", "redirect_uri not registered for this client_id");
  }

  // From here on, errors redirect to the client with ?error=...
  if (request.response_type !== "code") {
    return redirectError(
      request.redirect_uri,
      "unsupported_response_type",
      request.state,
      "only response_type=code is supported",
    );
  }
  if (!request.code_challenge) {
    return redirectError(
      request.redirect_uri,
      "invalid_request",
      request.state,
      "missing code_challenge",
    );
  }
  if (request.code_challenge_method !== "S256") {
    return redirectError(
      request.redirect_uri,
      "invalid_request",
      request.state,
      "only S256 code_challenge_method is supported",
    );
  }

  const asStateClaims: AsStateClaims = {
    typ: "as-state",
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    code_challenge: request.code_challenge,
    code_challenge_method: "S256",
    client_state: request.state,
    scope: request.scope ?? "",
  };
  const asState = await signJws(asStateClaims, config.signingKey, TTL.asState);

  return { ok: true, asState, clientRedirectUri: request.redirect_uri, clientState: request.state };
}

function badRequest(error: string, error_description: string): AuthorizeResult {
  return { ok: false, status: 400, error, error_description };
}

function redirectError(
  redirectUri: string,
  error: string,
  state: string | null,
  description: string,
): AuthorizeResult {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return { ok: false, status: 302, redirectUrl: url.toString() };
}
