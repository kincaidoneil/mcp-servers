// Route-handler factories for the plumbing every bridge shares: DCR,
// token exchange, and .well-known discovery. Each bridge's route file
// re-exports the handlers with its own lazy config getter, so a fix here
// lands on every service at once.

import { protectedResourceHandler } from "mcp-handler";
import { authorizationServerMetadata } from "./metadata";
import { registerClient } from "./register";
import { handleTokenRequest } from "./token";
import type { OAuthConfig } from "./types";

type GetOAuthConfig = () => OAuthConfig;

export function createRegisterRoute(getOAuthConfig: GetOAuthConfig) {
  return {
    POST: async (req: Request) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError(400, "invalid_client_metadata", "request body must be JSON");
      }
      const result = await registerClient(body, getOAuthConfig());
      if (!result.ok) {
        return jsonError(400, result.error.error, result.error.error_description);
      }
      return Response.json(result.response, { status: 201, headers: corsHeaders("POST") });
    },
    OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders("POST") }),
  };
}

export function createTokenRoute(getOAuthConfig: GetOAuthConfig) {
  return {
    POST: async (req: Request) => {
      const body = await parseTokenBody(req);
      const result = await handleTokenRequest(body, getOAuthConfig());
      if (!result.ok) {
        return Response.json(
          { error: result.error.error, error_description: result.error.error_description },
          { status: result.error.status, headers: corsHeaders("POST") },
        );
      }
      return Response.json(result.response, {
        status: 200,
        headers: { ...corsHeaders("POST"), "Cache-Control": "no-store" },
      });
    },
    OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders("POST") }),
  };
}

export function createAsMetadataRoute(getOAuthConfig: GetOAuthConfig, scopes: string[]) {
  return {
    GET: () =>
      Response.json(authorizationServerMetadata(getOAuthConfig().baseUrl, scopes), {
        headers: corsHeaders("GET"),
      }),
    OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders("GET") }),
  };
}

export function createProtectedResourceRoute(getOAuthConfig: GetOAuthConfig) {
  let cached: ((req: Request) => Response) | null = null;
  return {
    GET: (req: Request) => {
      if (!cached) {
        const { baseUrl } = getOAuthConfig();
        cached = protectedResourceHandler({ authServerUrls: [baseUrl], resourceUrl: baseUrl });
      }
      return cached(req);
    },
    OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders("GET") }),
  };
}

async function parseTokenBody(req: Request): Promise<Record<string, string>> {
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

function jsonError(status: number, error: string, error_description: string) {
  return Response.json({ error, error_description }, { status, headers: corsHeaders("POST") });
}

function corsHeaders(method: "GET" | "POST") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": `${method}, OPTIONS`,
    "Access-Control-Allow-Headers":
      method === "POST" ? "Content-Type, Authorization" : "Content-Type",
  };
}
