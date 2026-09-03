// Form handler for the pare consent screen. The user pastes an access code;
// the matching name from PARE_ACCESS_CODES becomes identity.user in the
// issued tokens and owns every session created through them.
//
// CSRF: the signed as_state JWS is the gate. There are no cookies, so a
// cross-site POST has no ambient authority to ride on, and the state binds
// this submission to a validated /authorize request.

import { timingSafeEqual } from "node:crypto";
import { buildClientCallbackUrl, decodeAsState, htmlErrorPage as errorPage } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

export async function POST(req: Request) {
  const config = getConfig();

  const form = await req.formData().catch(() => null);
  if (!form) {
    return errorPage(400, "invalid request", "Expected a form submission.");
  }
  const asStateParam =
    typeof form.get("as_state") === "string" ? (form.get("as_state") as string) : null;
  const accessCode =
    typeof form.get("access_code") === "string" ? (form.get("access_code") as string).trim() : "";

  const stateResult = await decodeAsState(asStateParam, config.oauth);
  if (!stateResult.ok) {
    return errorPage(
      400,
      "invalid state",
      `Consent submission rejected: ${stateResult.reason}. Go back to your app and start the connection again.`,
    );
  }
  const asState = stateResult.state;

  const user = findUserByCode(config.accessCodes, accessCode);
  if (user === null) {
    return errorPage(403, "not authorized", "That access code is not recognized.");
  }

  // The access code doubles as the upstream token slot; there is no upstream
  // service, but the token format requires one.
  const redirectUrl = await buildClientCallbackUrl(asState, accessCode, { user }, config.oauth);
  // 303 so the browser converts our POST into a GET at the client's callback.
  return new Response(null, {
    status: 303,
    headers: { Location: redirectUrl, "Cache-Control": "no-store" },
  });
}

// Constant-time per candidate. A length mismatch is a non-match rather than
// a comparison, since timingSafeEqual requires equal-length buffers.
export function findUserByCode(accessCodes: Map<string, string>, submitted: string): string | null {
  if (submitted.length === 0) return null;
  const candidate = Buffer.from(submitted, "utf8");
  let match: string | null = null;
  for (const [name, code] of accessCodes) {
    const expected = Buffer.from(code, "utf8");
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      match ??= name;
    }
  }
  return match;
}
