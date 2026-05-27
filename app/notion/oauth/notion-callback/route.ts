import {
  buildClientCallbackUrl,
  buildClientErrorUrl,
  checkAllowlist,
  decodeAsState,
} from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import { exchangeNotionCode, identityFromTokenResponse } from "../../_internal/notion-oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const config = getConfig();

  const stateParam = url.searchParams.get("state");
  const stateResult = await decodeAsState(stateParam, config.oauth);
  if (!stateResult.ok) {
    return errorPage(
      400,
      "invalid state parameter",
      `Notion callback rejected: ${stateResult.reason}`,
    );
  }
  const asState = stateResult.state;

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return Response.redirect(
      buildClientErrorUrl(asState, upstreamError, url.searchParams.get("error_description") ?? ""),
      302,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return Response.redirect(buildClientErrorUrl(asState, "invalid_request", "missing code"), 302);
  }

  const exchange = await exchangeNotionCode({
    code,
    clientId: config.notion.clientId,
    clientSecret: config.notion.clientSecret,
    redirectUri: config.notion.redirectUri,
  });
  if (!exchange.ok) {
    return Response.redirect(buildClientErrorUrl(asState, "server_error", exchange.reason), 302);
  }

  const identity = identityFromTokenResponse(exchange.value);
  const allowed = checkAllowlist(
    { email: identity.email, workspaceId: identity.workspaceId },
    config.allowlist.emails,
    config.allowlist.workspaceIds,
  );
  if (!allowed) {
    return errorPage(
      403,
      "not authorized",
      `Notion workspace "${identity.workspaceName ?? identity.workspaceId}" (owner ${identity.email ?? "unknown"}) is not on the allowlist for this bridge.`,
    );
  }

  const redirectUrl = await buildClientCallbackUrl(
    asState,
    exchange.value.access_token,
    identity as unknown as Record<string, unknown>,
    config.oauth,
  );
  return Response.redirect(redirectUrl, 302);
}

function errorPage(status: number, error: string, description: string): Response {
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(description);
  return new Response(
    `<!doctype html><html><head><title>${safeError}</title></head><body><h1>${safeError}</h1><p>${safeDescription}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
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
