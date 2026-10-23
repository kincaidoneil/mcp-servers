import { redirect } from "next/navigation";
import {
  ConsentHeader,
  ConsentRedirectUri,
  ConsentShell,
  ErrorScreen,
  resolveAuthorizePage,
  type SearchParams,
} from "@/lib/consent";
import { getConfig } from "../../_internal/config";

export const dynamic = "force-dynamic";

const LABEL = "mb-1.5 block font-mono text-[11px] tracking-[0.12em] uppercase text-ink-soft";
const INPUT =
  "mb-2 block w-full rounded-sm border border-ink/25 bg-paper px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-soft/50 focus:border-ink focus:outline-none";
const HINT = "mb-6 text-[13px] leading-relaxed text-ink-soft";

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const config = getConfig();
  const result = await resolveAuthorizePage(await searchParams, config.oauth);

  if (!result.ok) {
    if (result.kind === "redirect") redirect(result.redirectUrl);
    return (
      <ErrorScreen
        title="Authorization request rejected"
        error={result.error}
        description={result.description}
      />
    );
  }

  const intervalsOAuth = config.intervalsOAuth !== null;

  return (
    <ConsentShell>
      <ConsentHeader
        registrableDomain={result.registrableDomain}
        serviceLabel="Hevy and Intervals.icu workouts"
      />
      <ConsentRedirectUri uri={result.clientRedirectUri} />

      <p className="mb-8 text-sm leading-relaxed text-ink">
        <strong className="font-semibold text-rust">
          Continue only if you started this connection yourself
        </strong>{" "}
        from an AI agent or chatbot you trust with your training data, and you recognize the domain
        above. Once connected, it can read your workouts and subscribe to be notified of new ones.
        Anyone can send you this link.
      </p>

      <form method="post" action={`${config.oauth.baseUrl}/oauth/submit`}>
        <input type="hidden" name="as_state" value={result.asState} />

        <label htmlFor="hevy_api_key" className={LABEL}>
          Hevy API key
        </label>
        <input
          id="hevy_api_key"
          name="hevy_api_key"
          type="password"
          required
          autoComplete="new-password"
          placeholder="00000000-0000-0000-0000-000000000000"
          className={INPUT}
        />
        <p className={HINT}>
          Hevy web app: Settings → Developer (
          <span className="font-mono">hevy.com/settings?developer</span>, requires Hevy Pro).
          Connecting registers this server as the account&apos;s Hevy webhook when a subscription
          starts.
        </p>

        {intervalsOAuth ? (
          <p className={HINT}>
            Next, Intervals.icu will ask you to approve read access to your activities.
          </p>
        ) : (
          <>
            <label htmlFor="intervals_api_key" className={LABEL}>
              Intervals.icu API key
            </label>
            <input
              id="intervals_api_key"
              name="intervals_api_key"
              type="password"
              required
              autoComplete="new-password"
              className={INPUT}
            />
            <p className={HINT}>
              Intervals.icu: Settings → Developer Settings (
              <span className="font-mono">intervals.icu/settings</span>).
            </p>
          </>
        )}

        <p className={HINT}>
          Keys are validated upstream and sealed inside encrypted tokens. While a subscription is
          active, and for one day after it ends, an encrypted copy is kept: to fetch new workouts
          without you, and then to remove this server&apos;s Hevy webhook.
        </p>

        <section className="flex items-center gap-4">
          <button
            type="submit"
            className="inline-flex cursor-pointer items-center justify-center rounded-sm border border-ink bg-ink px-6 py-3 font-sans text-[15px] font-medium tracking-[0.01em] text-paper transition-colors duration-100 hover:border-rust hover:bg-rust"
          >
            {intervalsOAuth ? "Continue to Intervals.icu" : "Connect"}
          </button>
          <a
            href={result.cancelUrl}
            className="font-sans text-[15px] font-medium text-ink-soft underline decoration-1 underline-offset-4 hover:text-ink"
          >
            Cancel
          </a>
        </section>
      </form>
    </ConsentShell>
  );
}
