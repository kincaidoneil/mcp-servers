// Shared pieces of the consent (authorize) pages. Each bridge renders its own
// action area — Notion links to upstream OAuth, Hevy collects an API key —
// inside the same shell, with the same request validation in front.

import { getDomain } from "tldts";
import { validateAuthorize } from "./oauth-as";
import type { OAuthConfig } from "./oauth-as";

export type SearchParams = { [k: string]: string | string[] | undefined };

export type AuthorizePageResult =
  | {
      ok: true;
      asState: string;
      clientRedirectUri: string;
      clientState: string | null;
      registrableDomain: string;
      cancelUrl: string;
    }
  | { ok: false; kind: "redirect"; redirectUrl: string }
  | { ok: false; kind: "error"; error: string; description: string };

// Validate the OAuth authorize request and apply the Punycode defense.
// The caller handles the redirect case (next/navigation redirect() must be
// called from the page itself).
export async function resolveAuthorizePage(
  sp: SearchParams,
  oauth: OAuthConfig,
): Promise<AuthorizePageResult> {
  const result = await validateAuthorize(
    {
      client_id: pickParam(sp, "client_id"),
      redirect_uri: pickParam(sp, "redirect_uri"),
      response_type: pickParam(sp, "response_type"),
      code_challenge: pickParam(sp, "code_challenge"),
      code_challenge_method: pickParam(sp, "code_challenge_method"),
      state: pickParam(sp, "state"),
      scope: pickParam(sp, "scope"),
    },
    oauth,
  );

  if (!result.ok) {
    if (result.status === 302) {
      return { ok: false, kind: "redirect", redirectUrl: result.redirectUrl };
    }
    return { ok: false, kind: "error", error: result.error, description: result.error_description };
  }

  // Defense in depth: even if a Punycode redirect_uri slipped past DCR, also
  // block here.
  const hostname = new URL(result.clientRedirectUri).hostname.toLowerCase();
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    return {
      ok: false,
      kind: "error",
      error: "invalid_redirect_uri",
      description:
        "This bridge rejects redirect URIs that use internationalized (Punycode) domains.",
    };
  }

  return {
    ok: true,
    asState: result.asState,
    clientRedirectUri: result.clientRedirectUri,
    clientState: result.clientState,
    registrableDomain: getDomain(hostname) ?? hostname,
    cancelUrl: buildCancelUrl(result.clientRedirectUri, result.clientState),
  };
}

export function pickParam(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  return typeof v === "string" ? v : null;
}

export function buildCancelUrl(redirectUri: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "user cancelled at consent screen");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-paper-deep px-6 py-12 font-sans text-ink">
      <article className="w-full max-w-[520px] rounded-sm border border-ink/15 bg-paper px-10 py-9">
        {children}
      </article>
    </main>
  );
}

export function ConsentHeader({
  registrableDomain,
  serviceLabel,
}: {
  registrableDomain: string;
  serviceLabel: string;
}) {
  return (
    <header className="mb-7">
      <p className="mb-4 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-soft">
        Authorize access
      </p>
      <h1 className="text-ink">
        <span className="block font-mono text-[32px] leading-[1.1] font-semibold break-all text-rust">
          {registrableDomain}
        </span>
        <span className="mt-2 block font-sans text-xl leading-snug font-medium tracking-tight">
          requests access to your {serviceLabel}
        </span>
      </h1>
    </header>
  );
}

export function ConsentRedirectUri({ uri }: { uri: string }) {
  return (
    <div className="mb-8">
      <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft">
        Full URL
      </p>
      <code className="block font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink-soft">
        {uri}
      </code>
    </div>
  );
}

export function ErrorScreen({
  title,
  error,
  description,
}: {
  title: string;
  error: string;
  description: string;
}) {
  return (
    <ConsentShell>
      <header className="mb-8">
        <p className="mb-3 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-soft">
          {error}
        </p>
        <h1 className="font-sans text-2xl leading-tight font-semibold tracking-tight text-ink">
          {title}
        </h1>
      </header>
      <p className="text-[15px] leading-relaxed text-ink">{description}</p>
    </ConsentShell>
  );
}
