// What a /workouts access token carries. The shared OAuth layer seals one
// opaque upstream string per token; this bridge needs two upstream
// credentials, so that string is this JSON document.

import { z } from "zod";
import { getConfig } from "./config";

export const IntervalsCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), apiKey: z.string().min(1) }),
  z.object({ kind: z.literal("oauth"), accessToken: z.string().min(1) }),
]);
export type IntervalsCredential = z.infer<typeof IntervalsCredentialSchema>;

export const CredentialsSchema = z.object({
  hevy: z.object({ apiKey: z.string().min(1) }),
  intervals: IntervalsCredentialSchema,
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const IdentitySchema = z.object({
  hevyUserId: z.string().min(1),
  hevyName: z.string().nullable(),
  intervalsAthleteId: z.string().min(1),
  intervalsName: z.string().nullable(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export interface Principal {
  // Stable per (Hevy account, Intervals athlete). Subscription ids derive from it.
  id: string;
  identity: Identity;
  credentials: Credentials;
}

export function encodeCredentials(credentials: Credentials): string {
  return JSON.stringify(credentials);
}

export function principalId(identity: Identity): string {
  return `${identity.hevyUserId}:${identity.intervalsAthleteId}`;
}

// Rebuild the principal from a verified token's payload. Returns null when the
// payload is malformed or either account has since left the allowlist, so
// removing an id from the env revokes its outstanding tokens too.
export function toPrincipal(upstream: string, identity: unknown): Principal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(upstream);
  } catch {
    return null;
  }
  const credentials = CredentialsSchema.safeParse(raw);
  const parsedIdentity = IdentitySchema.safeParse(identity);
  if (!credentials.success || !parsedIdentity.success) return null;
  if (!isAllowed(parsedIdentity.data)) return null;
  return {
    id: principalId(parsedIdentity.data),
    identity: parsedIdentity.data,
    credentials: credentials.data,
  };
}

export function isAllowed(account: { hevyUserId: string; intervalsAthleteId: string }): boolean {
  return getConfig().accounts.some(
    (a) =>
      a.hevyUserId === account.hevyUserId && a.intervalsAthleteId === account.intervalsAthleteId,
  );
}
