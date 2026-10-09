// Form handler for the /workouts consent screen. Validates the Hevy key, then
// either validates the pasted Intervals key or hands off to Intervals OAuth.
// CSRF: the signed as_state JWS binds the submission to a validated
// /authorize request, and the Origin check refuses cross-site posts, which
// would otherwise let a third-party page skip this consent screen.

import { decodeAsState, htmlErrorPage } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import {
  connectWithIntervalsKey,
  startIntervalsOAuth,
  validateHevy,
  type ConnectStep,
} from "../../_internal/connect";

export async function POST(req: Request) {
  const config = getConfig();
  if (!isSameOrigin(req, config.oauth.baseUrl)) {
    return htmlErrorPage(
      403,
      "cross-site request",
      "Submit this form from the consent page itself.",
    );
  }
  const form = await req.formData().catch(() => null);
  if (!form) return htmlErrorPage(400, "invalid request", "Expected a form submission.");
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };

  const state = await decodeAsState(field("as_state") || null, config.oauth);
  if (!state.ok) {
    return htmlErrorPage(
      400,
      "invalid state",
      `Consent submission rejected: ${state.reason}. Go back to your app and start the connection again.`,
    );
  }

  const hevyKey = field("hevy_api_key");
  if (!hevyKey) return htmlErrorPage(400, "missing API key", "Paste your Hevy API key.");
  const hevy = await validateHevy(hevyKey);
  if (!hevy.ok) return respond(hevy);

  if (config.intervalsOAuth) return respond(await startIntervalsOAuth(state.state, hevy.hevy));

  const intervalsKey = field("intervals_api_key");
  if (!intervalsKey)
    return htmlErrorPage(400, "missing API key", "Paste your Intervals.icu API key.");
  return respond(await connectWithIntervalsKey(state.state, hevy.hevy, intervalsKey));
}

function respond(step: ConnectStep): Response {
  if (!step.ok) {
    return htmlErrorPage(
      step.status,
      step.title,
      `${step.message} Use your browser's back button to try again.`,
    );
  }
  // 303 turns the POST into a GET at the next hop.
  const headers = new Headers({ Location: step.redirect, "Cache-Control": "no-store" });
  if (step.setCookie) headers.set("Set-Cookie", step.setCookie);
  return new Response(null, { status: 303, headers });
}

// Browsers send Origin on every form POST; Sec-Fetch-Site backs it up for
// clients that strip Origin. Anything else is refused.
function isSameOrigin(req: Request, baseUrl: string): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(baseUrl).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
