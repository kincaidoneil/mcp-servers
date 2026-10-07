// Where Intervals.icu sends the browser back after OAuth consent.

import { htmlErrorPage } from "@/lib/oauth-as";
import { finishIntervalsOAuth } from "../../_internal/connect";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const error = params.get("error");
  if (error) {
    return htmlErrorPage(
      400,
      "Intervals.icu declined",
      `Intervals.icu returned "${error}". Start the connection again.`,
    );
  }
  const state = params.get("state");
  const code = params.get("code");
  if (!state || !code) {
    return htmlErrorPage(
      400,
      "invalid callback",
      "The Intervals.icu callback is missing its code or state.",
    );
  }
  const step = await finishIntervalsOAuth(state, code);
  if (!step.ok) return htmlErrorPage(step.status, step.title, step.message);
  return new Response(null, {
    status: 302,
    headers: { Location: step.redirect, "Cache-Control": "no-store" },
  });
}
