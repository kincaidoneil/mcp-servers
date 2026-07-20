import { redirect } from "next/navigation";
import { getDomain } from "tldts";
import { validateAuthorize } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";

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

  const cancelUrl = buildCancelUrl(result.clientRedirectUri, result.clientState);
  const registrableDomain = getDomain(hostname) ?? hostname;

  return (
    <Shell>
      <header className="mb-7">
        <p className="mb-4 font-mono text-[11px] tracking-[0.18em] uppercase text-ink-soft">
          Authorize access
        </p>
        <h1 className="text-ink">
          <span className="block font-mono text-[32px] leading-[1.1] font-semibold break-all text-rust">
            {registrableDomain}
          </span>
          <span className="mt-2 block font-sans text-xl leading-snug font-medium tracking-tight">
            requests access to your Hevy
          </span>
        </h1>
      </header>

      <div className="mb-8">
        <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft">
          Full URL
        </p>
        <code className="block font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-ink-soft">
          {result.clientRedirectUri}
        </code>
      </div>

      <p className="mb-8 text-sm leading-relaxed text-ink">
        <strong className="font-semibold text-rust">
          Continue only if you started this connection yourself
        </strong>{" "}
        from an AI agent or chatbot you trust with your Hevy training data, and you recognize the
        domain above. Anyone can send you this link.
      </p>

      <form method="post" action={`${config.oauth.baseUrl}/oauth/submit`}>
        <input type="hidden" name="as_state" value={result.asState} />
        <label
          htmlFor="api_key"
          className="mb-1.5 block font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft"
        >
          Hevy API key
        </label>
        <input
          id="api_key"
          name="api_key"
          type="password"
          required
          autoComplete="new-password"
          placeholder="00000000-0000-0000-0000-000000000000"
          className="mb-2 block w-full rounded-sm border border-ink/25 bg-paper px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-soft/50 focus:border-ink focus:outline-none"
        />
        <p className="mb-7 text-[13px] leading-relaxed text-ink-soft">
          From the Hevy web app: Settings → Developer (
          <span className="font-mono">hevy.com/settings?developer</span>, requires Hevy Pro). The
          key is validated with Hevy, sealed inside encrypted tokens, and never stored on this
          server.
        </p>
        <section className="flex items-center gap-4">
          <button
            type="submit"
            className="inline-flex cursor-pointer items-center justify-center rounded-sm border border-ink bg-ink px-6 py-3 font-sans text-[15px] font-medium tracking-[0.01em] text-paper transition-colors duration-100 hover:border-rust hover:bg-rust"
          >
            Connect Hevy
          </button>
          <a
            href={cancelUrl}
            className="font-sans text-[15px] font-medium text-ink-soft underline decoration-1 underline-offset-4 hover:text-ink"
          >
            Cancel
          </a>
        </section>
      </form>
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
        <h1 className="font-sans text-2xl leading-tight font-semibold tracking-tight text-ink">
          {title}
        </h1>
      </header>
      <p className="text-[15px] leading-relaxed text-ink">{description}</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-paper-deep px-6 py-12 font-sans text-ink">
      <article className="w-full max-w-[520px] rounded-sm border border-ink/15 bg-paper px-10 py-9">
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
