import { redirect } from "next/navigation";
import { getDomain } from "tldts";
import { validateAuthorize } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import { buildNotionAuthorizeUrl } from "../../_internal/notion-oauth";

type SearchParams = Promise<{ [k: string]: string | string[] | undefined }>;

export const dynamic = "force-dynamic";

export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const config = getConfig();

  const result = await validateAuthorize(
    {
      client_id: pick(sp, "client_id"),
      redirect_uri: pick(sp, "redirect_uri"),
      response_type: pick(sp, "response_type"),
      code_challenge: pick(sp, "code_challenge"),
      code_challenge_method: pick(sp, "code_challenge_method"),
      state: pick(sp, "state"),
      scope: pick(sp, "scope"),
    },
    config.oauth,
  );

  if (!result.ok) {
    if (result.status === 302) {
      // Bad PKCE/response_type — bounce back to the client with ?error=
      redirect(result.redirectUrl);
    }
    return (
      <ErrorScreen
        title="Authorization request rejected"
        error={result.error}
        description={result.error_description}
      />
    );
  }

  // Defense in depth: even if a Punycode redirect_uri slipped past DCR, also
  // block here.
  const parsed = new URL(result.clientRedirectUri);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    return (
      <ErrorScreen
        title="Authorization request rejected"
        error="invalid_redirect_uri"
        description="This bridge rejects redirect URIs that use internationalized (Punycode) domains."
      />
    );
  }

  const notionUrl = buildNotionAuthorizeUrl(
    config.notion.clientId,
    config.notion.redirectUri,
    result.asState,
  );
  const cancelUrl = buildCancelUrl(result.clientRedirectUri, result.clientState);
  const registrableDomain = getDomain(hostname) ?? hostname;

  return (
    <Shell>
      <header className="mb-8">
        <p className="mb-3 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-soft">
          Authorize OAuth access
        </p>
        <h1 className="font-serif text-3xl leading-tight font-medium tracking-tight text-ink">
          Send Notion data to{" "}
          <span className="font-serif italic text-rust">{registrableDomain}</span>?
        </h1>
      </header>

      <section className="mb-7 rounded-sm border-l-[3px] border-rust bg-paper-deep px-6 pt-6 pb-5">
        <p className="mb-2 font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft">
          Authorization code will be sent to
        </p>
        <p className="mb-5 font-serif text-[32px] leading-[1.1] font-medium tracking-tight break-all text-ink">
          {registrableDomain}
        </p>
        <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft">
          Full redirect URI:
        </p>
        <code className="block font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink">
          {result.clientRedirectUri}
        </code>
      </section>

      <section className="mb-8 text-sm leading-relaxed text-ink">
        <strong className="font-semibold text-rust">Verify the domain before continuing.</strong>{" "}
        Anyone can start an OAuth flow against this bridge — only the domain above is bound to where
        your authorization code will end up. If you didn&rsquo;t start this on{" "}
        <code className="rounded-sm bg-paper-deep px-1.5 py-px font-mono text-[13px]">
          {registrableDomain}
        </code>
        , cancel.
      </section>

      <section className="mb-7 flex items-center gap-4">
        <a
          href={notionUrl}
          className="inline-flex items-center justify-center rounded-sm border border-ink bg-ink px-6 py-3 font-sans text-[15px] font-medium tracking-[0.01em] text-paper transition-colors duration-100 hover:border-rust hover:bg-rust"
        >
          Continue to Notion
        </a>
        <a
          href={cancelUrl}
          className="font-sans text-[15px] font-medium text-ink-soft underline decoration-1 underline-offset-4 hover:text-ink"
        >
          Cancel
        </a>
      </section>

      <footer className="border-t border-ink/8 pt-6 text-[13px] leading-relaxed text-ink-soft">
        Clicking Continue sends you to Notion&rsquo;s standard consent screen. Notion then redirects
        back through this bridge, which sends the authorization code to the domain above.
      </footer>
    </Shell>
  );
}

function ErrorScreen({
  title,
  error,
  description,
}: {
  title: string;
  error: string;
  description: string;
}) {
  return (
    <Shell>
      <header className="mb-8">
        <p className="mb-3 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-soft">
          {error}
        </p>
        <h1 className="font-serif text-3xl leading-tight font-medium tracking-tight text-ink">
          {title}
        </h1>
      </header>
      <p className="text-[15px] leading-relaxed text-ink">{description}</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="grid min-h-screen place-items-center bg-paper px-6 py-12 font-sans text-ink"
      style={{
        backgroundImage:
          "radial-gradient(circle at 12% 18%, rgba(182, 65, 26, 0.04), transparent 35%), radial-gradient(circle at 88% 82%, rgba(74, 93, 35, 0.05), transparent 40%)",
      }}
    >
      <article className="w-full max-w-[560px] rounded border border-ink/10 bg-paper px-11 py-10 shadow-[0_1px_0_rgba(31,26,20,0.04),0_24px_48px_-24px_rgba(31,26,20,0.18)]">
        {children}
      </article>
    </main>
  );
}

function pick(sp: { [k: string]: string | string[] | undefined }, key: string): string | null {
  const v = sp[key];
  return typeof v === "string" ? v : null;
}

function buildCancelUrl(redirectUri: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "user cancelled at consent screen");
  if (state) url.searchParams.set("state", state);
  return url.toString();
}
