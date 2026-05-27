import { protectedResourceHandler } from "mcp-handler";
import { getConfig } from "../../_internal/config";

let cached: ((req: Request) => Response) | null = null;
function handler() {
  if (cached) return cached;
  const { oauth } = getConfig();
  cached = protectedResourceHandler({
    authServerUrls: [oauth.baseUrl],
    resourceUrl: oauth.baseUrl,
  });
  return cached;
}

export function GET(req: Request) {
  return handler()(req);
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
