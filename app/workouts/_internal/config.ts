import { loadOAuthConfigFromEnv, parseList, requiredEnv } from "@/lib/oauth-as";
import type { OAuthConfig } from "@/lib/oauth-as";

export const SERVICE_PATH = "/workouts";

export interface WorkoutsConfig {
  oauth: OAuthConfig;
  // Accounts allowed to connect, each an explicit (Hevy user, Intervals
  // athlete) pair, so nobody can combine their Hevy with someone else's
  // Intervals.
  accounts: { hevyUserId: string; intervalsAthleteId: string }[];
  // Set once an Intervals.icu OAuth app exists. The consent screen then sends
  // the user through Intervals OAuth instead of asking for an API key, which
  // is what makes the athlete eligible for the app's webhooks.
  intervalsOAuth: { clientId: string; clientSecret: string } | null;
  // The secret configured on the Intervals app's webhook. Webhooks only make
  // delivery faster: the tick keeps polling as a backstop either way.
  intervalsWebhookSecret: string | null;
  // Bearer secret the scheduler (QStash, or Vercel Cron) sends to /workouts/tick.
  tickSecret: string;
  display: {
    timeZone: string;
    units: "metric" | "imperial";
  };
}

let cached: WorkoutsConfig | null = null;

export function getConfig(): WorkoutsConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

export function resetConfigCacheForTesting() {
  cached = null;
}

function loadConfig(): WorkoutsConfig {
  const accounts = parseList(process.env["ALLOWED_WORKOUT_ACCOUNTS"]).map((pair) => {
    const [hevyUserId, athleteId, ...rest] = pair.split(":");
    if (!hevyUserId || !athleteId || rest.length > 0) {
      throw new Error(
        `ALLOWED_WORKOUT_ACCOUNTS entry "${pair}" is not hevyUserId:intervalsAthleteId.`,
      );
    }
    return { hevyUserId, intervalsAthleteId: normalizeAthleteId(athleteId) };
  });
  if (accounts.length === 0) throw new Error("ALLOWED_WORKOUT_ACCOUNTS must be set.");

  const clientId = process.env["INTERVALS_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["INTERVALS_OAUTH_CLIENT_SECRET"];

  return {
    oauth: loadOAuthConfigFromEnv(SERVICE_PATH),
    accounts,
    intervalsOAuth: clientId && clientSecret ? { clientId, clientSecret } : null,
    intervalsWebhookSecret: process.env["INTERVALS_WEBHOOK_SECRET"] || null,
    tickSecret: requiredEnv("WORKOUTS_TICK_SECRET"),
    display: { timeZone: "America/New_York", units: "imperial" },
  };
}

// Intervals writes athlete ids both ways: "i651018" in activities and webhooks,
// bare "651018" in the OAuth token response. Compare them in the prefixed form.
export function normalizeAthleteId(id: string): string {
  return id.startsWith("i") ? id : `i${id}`;
}
