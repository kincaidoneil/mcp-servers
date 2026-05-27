import { z } from "zod";
import { signJws } from "./jwt";
import type { ClientIdClaims, OAuthConfig } from "./types";

const RegisterRequestSchema = z
  .object({
    client_name: z.string().max(200).optional(),
    redirect_uris: z.array(z.url()).min(1).max(10),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export interface RegisterResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

export interface RegisterError {
  error: "invalid_client_metadata" | "invalid_redirect_uri";
  error_description: string;
}

export async function registerClient(
  rawBody: unknown,
  config: OAuthConfig,
): Promise<{ ok: true; response: RegisterResponse } | { ok: false; error: RegisterError }> {
  const parsed = RegisterRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        error: "invalid_client_metadata",
        error_description: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
    };
  }

  const { client_name, redirect_uris } = parsed.data;

  for (const uri of redirect_uris) {
    if (!isAcceptableRedirectUri(uri)) {
      return {
        ok: false,
        error: {
          error: "invalid_redirect_uri",
          error_description: `redirect_uri must use https (or http on localhost): ${uri}`,
        },
      };
    }
  }

  const clientNameNormalized = client_name ?? null;
  const claims: ClientIdClaims = {
    typ: "client",
    client_name: clientNameNormalized,
    redirect_uris,
  };
  const clientId = await signJws(claims, config.signingKey);

  return {
    ok: true,
    response: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientNameNormalized,
      redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  )
    return true;
  return false;
}
