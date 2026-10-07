// The consent leg of /workouts OAuth: validate both upstream credentials,
// check the allowlist, and mint the auth code. With an Intervals OAuth app
// configured, Intervals is connected by a redirect round trip instead of a
// pasted API key.

import { z } from "zod";
import { validateApiKey } from "@/app/hevy/_internal/hevy-auth";
import { buildClientCallbackUrl, decryptJwe, encryptJwe } from "@/lib/oauth-as";
import { getConfig, normalizeAthleteId } from "./config";
import {
  encodeCredentials,
  isAllowed,
  type Credentials,
  type Identity,
  type IntervalsCredential,
} from "./credentials";
import { createIntervalsClient } from "./intervals";

type AsState = Parameters<typeof buildClientCallbackUrl>[0];

export type ConnectStep =
  | { ok: true; redirect: string }
  | { ok: false; status: number; title: string; message: string };

type HevyPart = { apiKey: string; userId: string; name: string | null };

export async function validateHevy(
  apiKey: string,
): Promise<{ ok: true; hevy: HevyPart } | Extract<ConnectStep, { ok: false }>> {
  const result = await validateApiKey(apiKey);
  if (!result.ok) {
    return {
      ok: false,
      status: result.unauthorized ? 400 : 502,
      title: result.unauthorized ? "invalid Hevy API key" : "Hevy unreachable",
      message: result.reason,
    };
  }
  return { ok: true, hevy: { apiKey, userId: result.identity.userId, name: result.identity.name } };
}

async function intervalsAthlete(credential: IntervalsCredential) {
  const result = await createIntervalsClient(credential).getAthlete();
  return result.ok
    ? {
        ok: true as const,
        id: normalizeAthleteId(result.value.id),
        name: result.value.name ?? null,
      }
    : { ok: false as const, code: result.code };
}

async function finish(
  asState: AsState,
  hevy: HevyPart,
  intervals: IntervalsCredential,
  athlete: { id: string; name: string | null },
): Promise<ConnectStep> {
  const identity: Identity = {
    hevyUserId: hevy.userId,
    hevyName: hevy.name,
    intervalsAthleteId: athlete.id,
    intervalsName: athlete.name,
  };
  if (!isAllowed(identity)) {
    return {
      ok: false,
      status: 403,
      title: "not authorized",
      message: `Hevy account ${hevy.userId} with Intervals athlete ${athlete.id} is not on this bridge's allowlist.`,
    };
  }
  const credentials: Credentials = { hevy: { apiKey: hevy.apiKey }, intervals };
  return {
    ok: true,
    redirect: await buildClientCallbackUrl(
      asState,
      encodeCredentials(credentials),
      identity,
      getConfig().oauth,
    ),
  };
}

export async function connectWithIntervalsKey(
  asState: AsState,
  hevy: HevyPart,
  intervalsApiKey: string,
): Promise<ConnectStep> {
  const credential: IntervalsCredential = { kind: "api_key", apiKey: intervalsApiKey };
  const athlete = await intervalsAthlete(credential);
  if (!athlete.ok) {
    return {
      ok: false,
      status: athlete.code === "unauthorized" ? 400 : 502,
      title:
        athlete.code === "unauthorized" ? "invalid Intervals API key" : "Intervals unreachable",
      message: `Intervals.icu answered ${athlete.code} when checking the API key.`,
    };
  }
  return finish(asState, hevy, credential, athlete);
}

// ---- Intervals OAuth round trip ----

const INTERVALS_AUTHORIZE = "https://intervals.icu/oauth/authorize";
const INTERVALS_TOKEN = "https://intervals.icu/api/oauth/token";
const INTERVALS_SCOPE = "ACTIVITY:READ";

interface PendingClaims {
  typ: "intervals-pending";
  asState: AsState;
  hevy: HevyPart;
}

export function intervalsCallbackUrl(): string {
  return `${getConfig().oauth.baseUrl}/oauth/intervals-callback`;
}

// Carry the validated Hevy half through Intervals' `state`, encrypted, so the
// round trip needs no server-side session.
export async function startIntervalsOAuth(asState: AsState, hevy: HevyPart): Promise<ConnectStep> {
  const config = getConfig();
  if (!config.intervalsOAuth) {
    return {
      ok: false,
      status: 500,
      title: "misconfigured",
      message: "Intervals OAuth is not configured.",
    };
  }
  const claims: PendingClaims = { typ: "intervals-pending", asState, hevy };
  const state = await encryptJwe(claims, config.oauth.signingKey, 10 * 60);
  const url = new URL(INTERVALS_AUTHORIZE);
  url.searchParams.set("client_id", config.intervalsOAuth.clientId);
  url.searchParams.set("redirect_uri", intervalsCallbackUrl());
  url.searchParams.set("scope", INTERVALS_SCOPE);
  url.searchParams.set("state", state);
  return { ok: true, redirect: url.toString() };
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  athlete: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().nullish(),
  }),
});

export async function finishIntervalsOAuth(state: string, code: string): Promise<ConnectStep> {
  const config = getConfig();
  if (!config.intervalsOAuth) {
    return {
      ok: false,
      status: 500,
      title: "misconfigured",
      message: "Intervals OAuth is not configured.",
    };
  }
  const pending = await decryptJwe<PendingClaims>(
    state,
    config.oauth.signingKey,
    "intervals-pending",
  );
  if (!pending.ok) {
    return {
      ok: false,
      status: 400,
      title: "invalid state",
      message: `The Intervals.icu callback could not be matched to a consent screen (${pending.reason}). Start the connection again.`,
    };
  }

  let body: unknown;
  try {
    const response = await fetch(INTERVALS_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.intervalsOAuth.clientId,
        client_secret: config.intervalsOAuth.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        title: "Intervals token exchange failed",
        message: `Intervals.icu answered HTTP ${response.status}. Codes expire after two minutes; start again.`,
      };
    }
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      status: 502,
      title: "Intervals unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const token = TokenResponseSchema.safeParse(body);
  if (!token.success) {
    return {
      ok: false,
      status: 502,
      title: "unexpected Intervals response",
      message: token.error.message,
    };
  }
  return finish(
    pending.payload.asState,
    pending.payload.hevy,
    { kind: "oauth", accessToken: token.data.access_token },
    { id: normalizeAthleteId(token.data.athlete.id), name: token.data.athlete.name ?? null },
  );
}
