// Env parsing shared by every bridge's config module. Each service keeps its
// own config shape and cache; only the mechanics of reading env live here.

import type { OAuthConfig } from "./types";

// Read the shared PUBLIC_BASE_URL + JWT_SIGNING_KEY and scope them to one
// service path (e.g. "/notion" → https://apex/notion).
export function loadOAuthConfigFromEnv(servicePath: string): OAuthConfig {
  const apex = stripTrailingSlash(requiredEnv("PUBLIC_BASE_URL"));
  return {
    baseUrl: `${apex}${servicePath}`,
    signingKey: decodeSigningKey(requiredEnv("JWT_SIGNING_KEY")),
  };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function decodeSigningKey(raw: string): Uint8Array {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length < 32) {
    throw new Error(
      `JWT_SIGNING_KEY must be ≥32 bytes (got ${bytes.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return new Uint8Array(bytes.subarray(0, 32));
}

export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
