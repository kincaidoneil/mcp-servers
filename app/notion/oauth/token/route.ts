import { handleTokenRequest } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

export async function POST(req: Request) {
  const config = getConfig();
  const body = await parseBody(req);
  const result = await handleTokenRequest(body, config.oauth);
  if (!result.ok) {
    return Response.json(
      { error: result.error.error, error_description: result.error.error_description },
      { status: result.error.status, headers: corsHeaders() },
    );
  }
  return Response.json(result.response, {
    status: 200,
    headers: { ...corsHeaders(), "Cache-Control": "no-store" },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function parseBody(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  }
  try {
    const json = (await req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
