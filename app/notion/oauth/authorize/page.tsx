import { redirect } from "next/navigation";
import { getDomain } from "tldts";
import { validateAuthorize } from "@/lib/oauth-as";
import { getConfig } from "../../_internal/config";
import { buildNotionAuthorizeUrl } from "../../_internal/notion-oauth";
import styles from "./consent.module.css";

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

  // Defense in depth: even if a pre-rejection client_id slipped through DCR,
  // also block here.
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
    <main className={styles.main}>
      <article className={styles.card}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Authorize OAuth access</p>
          <h1 className={styles.title}>
            Send Notion data to <span className={styles.domainInline}>{registrableDomain}</span>?
          </h1>
        </header>

        <section className={styles.domainBlock}>
          <p className={styles.domainBlockLabel}>Authorization code will be sent to</p>
          <p className={styles.domain}>{registrableDomain}</p>
          <p className={styles.urlLabel}>Full redirect URI:</p>
          <code className={styles.url}>{result.clientRedirectUri}</code>
        </section>

        <section className={styles.warning}>
          <strong>Verify the domain before continuing.</strong> Anyone can start an OAuth flow
          against this bridge — only the domain above is bound to where your authorization code will
          end up. If you didn&rsquo;t start this on <code>{registrableDomain}</code>, cancel.
        </section>

        <section className={styles.actions}>
          <a className={styles.continueButton} href={notionUrl}>
            Continue to Notion
          </a>
          <a className={styles.cancelButton} href={cancelUrl}>
            Cancel
          </a>
        </section>

        <footer className={styles.footer}>
          Clicking Continue sends you to Notion&rsquo;s standard consent screen. Notion then
          redirects back through this bridge, which sends the authorization code to the domain
          above.
        </footer>
      </article>
    </main>
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
    <main className={styles.main}>
      <article className={styles.card}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>{error}</p>
          <h1 className={styles.title}>{title}</h1>
        </header>
        <p className={styles.errorBody}>{description}</p>
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
