import { registerClient } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_client_metadata", "request body must be JSON");
  }
  const { oauth } = getConfig();
  const result = await registerClient(body, oauth);
  if (!result.ok) {
    return jsonError(400, result.error.error, result.error.error_description);
  }
  return Response.json(result.response, { status: 201, headers: corsHeaders() });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function jsonError(status: number, error: string, error_description: string) {
  return Response.json({ error, error_description }, { status, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
