// The consent leg of /workouts OAuth: validate both upstream credentials,
// check the allowlist, and mint the auth code. With an Intervals OAuth app
// configured, Intervals is connected by a redirect round trip instead of a
// pasted API key.

import { randomBytes, timingSafeEqual } from "node:crypto";
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
  // setCookie: a Set-Cookie header value to send with the redirect.
  | { ok: true; redirect: string; setCookie?: string }
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
  nonce: string;
}

// Binds the Intervals round trip to the browser that started it. Without it,
// someone could start a flow with their own Hevy key and send the Intervals
// link to a victim, whose approval would then complete the attacker's flow.
export const NONCE_COOKIE = "workouts_intervals_nonce";

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
  const nonce = randomBytes(24).toString("base64url");
  const claims: PendingClaims = { typ: "intervals-pending", asState, hevy, nonce };
  const state = await encryptJwe(claims, config.oauth.signingKey, 10 * 60);
  const cookiePath = new URL(intervalsCallbackUrl()).pathname;
  const url = new URL(INTERVALS_AUTHORIZE);
  url.searchParams.set("client_id", config.intervalsOAuth.clientId);
  url.searchParams.set("redirect_uri", intervalsCallbackUrl());
  url.searchParams.set("scope", INTERVALS_SCOPE);
  url.searchParams.set("state", state);
  return {
    ok: true,
    redirect: url.toString(),
    setCookie: `${NONCE_COOKIE}=${nonce}; Path=${cookiePath}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  };
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  athlete: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().nullish(),
  }),
});

export async function finishIntervalsOAuth(
  state: string,
  code: string,
  cookieNonce: string | null,
): Promise<ConnectStep> {
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
  const expected = Buffer.from(pending.payload.nonce);
  const actual = Buffer.from(cookieNonce ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      ok: false,
      status: 400,
      title: "wrong browser",
      message:
        "This Intervals.icu approval did not start in this browser. Start the connection again from your AI app.",
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
