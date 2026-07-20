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
import { buildNotionAuthorizeUrl } from "../../_internal/notion-oauth";

export const dynamic = "force-dynamic";

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

  const notionUrl = buildNotionAuthorizeUrl(
    config.notion.clientId,
    config.notion.redirectUri,
    result.asState,
  );

  return (
    <ConsentShell>
      <ConsentHeader registrableDomain={result.registrableDomain} serviceLabel="Notion" />
      <ConsentRedirectUri uri={result.clientRedirectUri} />

      <p className="mb-8 text-sm leading-relaxed text-ink">
        <strong className="font-semibold text-rust">
          Approve only if you recognize this domain
        </strong>{" "}
        as an AI agent or chatbot you trust with your Notion. Anyone can send you this link.
      </p>

      <section className="flex items-center gap-4">
        <a
          href={notionUrl}
          className="inline-flex items-center justify-center rounded-sm border border-ink bg-ink px-6 py-3 font-sans text-[15px] font-medium tracking-[0.01em] text-paper transition-colors duration-100 hover:border-rust hover:bg-rust"
        >
          Continue to Notion
        </a>
        <a
          href={result.cancelUrl}
          className="font-sans text-[15px] font-medium text-ink-soft underline decoration-1 underline-offset-4 hover:text-ink"
        >
          Cancel
        </a>
      </section>
    </ConsentShell>
  );
}
