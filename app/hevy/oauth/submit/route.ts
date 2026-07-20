// Form handler for the Hevy consent screen. Replaces the upstream OAuth
// callback leg that providers like Notion have: the user pastes their Hevy
// API key, we validate it against Hevy, check the allowlist, and issue the
// auth code with the key sealed inside (as the upstream access token).
//
// CSRF: the signed as_state JWS is the gate. There are no cookies, so a
// cross-site POST has no ambient authority to ride on, and the state binds
// this submission to a validated /authorize request.

import { buildClientCallbackUrl, decodeAsState } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import { validateApiKey } from "../../_internal/hevy-auth";

export async function POST(req: Request) {
  const config = getConfig();

  const form = await req.formData().catch(() => null);
  if (!form) {
    return errorPage(400, "invalid request", "Expected a form submission.");
  }
  const asStateParam =
    typeof form.get("as_state") === "string" ? (form.get("as_state") as string) : null;
  const apiKey =
    typeof form.get("api_key") === "string" ? (form.get("api_key") as string).trim() : "";

  const stateResult = await decodeAsState(asStateParam, config.oauth);
  if (!stateResult.ok) {
    return errorPage(
      400,
      "invalid state",
      `Consent submission rejected: ${stateResult.reason}. Go back to your app and start the connection again.`,
    );
  }
  const asState = stateResult.state;

  if (apiKey.length === 0) {
    return errorPage(
      400,
      "missing API key",
      "Paste your Hevy API key on the consent screen. Use your browser's back button to return to it.",
    );
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.ok) {
    return errorPage(
      validation.unauthorized ? 400 : 502,
      validation.unauthorized ? "invalid API key" : "Hevy unreachable",
      `${validation.reason} Use your browser's back button to try again.`,
    );
  }

  const allowed = config.allowlist.userIds.includes(validation.identity.userId);
  if (!allowed) {
    return errorPage(
      403,
      "not authorized",
      `Hevy account "${validation.identity.name ?? validation.identity.userId}" is not on the allowlist for this bridge.`,
    );
  }

  const redirectUrl = await buildClientCallbackUrl(
    asState,
    apiKey,
    validation.identity,
    config.oauth,
  );
  // 303 so the browser converts our POST into a GET at the client's callback.
  return new Response(null, {
    status: 303,
    headers: { Location: redirectUrl, "Cache-Control": "no-store" },
  });
}

function errorPage(status: number, error: string, description: string): Response {
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(description);
  return new Response(
    `<!doctype html><html><head><title>${safeError}</title></head><body><h1>${safeError}</h1><p>${safeDescription}</p></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
