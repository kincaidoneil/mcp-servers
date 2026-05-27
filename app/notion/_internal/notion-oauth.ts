// Notion OAuth helpers — building the upstream authorize URL and exchanging
// the upstream code for an access token. We hand-roll the HTTP calls rather
// than going through @notionhq/client.oauth because we want a plain typed
// shape we can validate.

import { z } from "zod";
import { Client } from "@notionhq/client";

const NotionTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  bot_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string().nullable().optional(),
  workspace_icon: z.string().nullable().optional(),
  owner: z
    .object({
      type: z.string().optional(),
      user: z
        .object({
          id: z.string().optional(),
          person: z.object({ email: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  duplicated_template_id: z.string().nullable().optional(),
  request_id: z.string().optional(),
});

export type NotionTokenResponse = z.infer<typeof NotionTokenResponseSchema>;

export function buildNotionAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeNotionCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ ok: true; value: NotionTokenResponse } | { ok: false; reason: string }> {
  const notion = new Client({ auth: opts.clientSecret });
  try {
    const response = await notion.oauth.token({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const parsed = NotionTokenResponseSchema.safeParse(response);
    if (!parsed.success) {
      return { ok: false, reason: `unexpected Notion token response: ${parsed.error.message}` };
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Notion token exchange failed: ${message}` };
  }
}

export interface NotionIdentity {
  workspaceId: string;
  workspaceName: string | null;
  email: string | null;
  botId: string;
}

export function identityFromTokenResponse(token: NotionTokenResponse): NotionIdentity {
  return {
    workspaceId: token.workspace_id,
    workspaceName: token.workspace_name ?? null,
    email: token.owner?.user?.person?.email ?? null,
    botId: token.bot_id,
  };
}
