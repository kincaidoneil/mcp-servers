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
    const rejection = rejectRedirectUri(uri);
    if (rejection) {
      return {
        ok: false,
        error: { error: "invalid_redirect_uri", error_description: rejection },
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

// Returns null if accepted, or a human-readable rejection reason.
//
// The Punycode (`xn--*`) reject is a deliberate fail-closed: we don't expect
// to use this bridge with any internationalized domain, and IDN/homograph
// attacks on the consent screen are a real DCR phishing vector. If you do
// want to support an IDN destination one day, remove the xn-- check and add
// a visible warning on the consent screen instead.
function rejectRedirectUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `redirect_uri is not a valid URL: ${uri}`;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:") {
    if (containsPunycodeLabel(hostname)) {
      return `redirect_uri uses an internationalized (Punycode) domain, which this bridge rejects: ${uri}`;
    }
    return null;
  }
  if (parsed.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return null;
  }
  return `redirect_uri must use https (or http on localhost): ${uri}`;
}

function containsPunycodeLabel(hostname: string): boolean {
  return hostname.split(".").some((label) => label.startsWith("xn--"));
}
