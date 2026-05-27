import { validateAuthorize } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import { buildNotionAuthorizeUrl } from "../../_internal/notion-oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const config = getConfig();
  const result = await validateAuthorize(
    {
      client_id: url.searchParams.get("client_id"),
      redirect_uri: url.searchParams.get("redirect_uri"),
      response_type: url.searchParams.get("response_type"),
      code_challenge: url.searchParams.get("code_challenge"),
      code_challenge_method: url.searchParams.get("code_challenge_method"),
      state: url.searchParams.get("state"),
      scope: url.searchParams.get("scope"),
    },
    config.oauth,
  );

  if (!result.ok) {
    if (result.status === 302) {
      return Response.redirect(result.redirectUrl, 302);
    }
    return errorPage(result.status, result.error, result.error_description);
  }

  const notionUrl = buildNotionAuthorizeUrl(
    config.notion.clientId,
    config.notion.redirectUri,
    result.asState,
  );
  return Response.redirect(notionUrl, 302);
}

function errorPage(status: number, error: string, description: string): Response {
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(description);
  return new Response(
    `<!doctype html><html><head><title>OAuth error</title></head><body><h1>${safeError}</h1><p>${safeDescription}</p></body></html>`,
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
