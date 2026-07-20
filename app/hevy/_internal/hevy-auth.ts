// Hevy has no OAuth. The consent screen collects the user's static API key,
// and this module validates it against GET /v1/user/info. The returned
// identity is what the allowlist checks and what gets embedded in issued
// tokens alongside the key.

import { createHevyClient } from "./client";

export interface HevyIdentity extends Record<string, unknown> {
  userId: string;
  name: string | null;
}

export type ValidateApiKeyResult =
  | { ok: true; identity: HevyIdentity }
  | { ok: false; reason: string; unauthorized: boolean };

export async function validateApiKey(apiKey: string): Promise<ValidateApiKeyResult> {
  const result = await createHevyClient(apiKey).getUserInfo();
  if (!result.ok) {
    if (result.code === "unauthorized") {
      return { ok: false, reason: "Hevy rejected this API key.", unauthorized: true };
    }
    return {
      ok: false,
      reason: `Could not reach Hevy to validate the API key (${result.code}).`,
      unauthorized: false,
    };
  }
  return {
    ok: true,
    identity: { userId: result.value.data.id, name: result.value.data.name ?? null },
  };
}
