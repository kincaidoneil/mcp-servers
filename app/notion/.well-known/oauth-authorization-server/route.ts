import { authorizationServerMetadata } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

const SCOPES = ["mcp:read"];

export function GET() {
  const { oauth } = getConfig();
  return Response.json(authorizationServerMetadata(oauth.baseUrl, SCOPES), {
    headers: corsHeaders(),
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
