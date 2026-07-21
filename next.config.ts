import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // RFC 8414 / RFC 9728 specify path-aware discovery: for an issuer
  // `https://host/<bridge>`, the metadata URL is
  // `https://host/.well-known/oauth-authorization-server/<bridge>`
  // (path inserted between host and well-known, NOT path-suffix).
  // We serve metadata at `/<bridge>/.well-known/...` because that's where
  // each bridge's route handlers naturally live; this rewrite makes the
  // RFC-strict URL forward to the same handler, so clients that go either
  // way (Claude.ai is strict; some are lenient) both succeed.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server/:bridge",
        destination: "/:bridge/.well-known/oauth-authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource/:bridge",
        destination: "/:bridge/.well-known/oauth-protected-resource",
      },
    ];
  },
  // Consent screens handle secrets (the Hevy bridge collects an API key), so
  // lock down framing, referrers, and caching on every bridge's oauth pages.
  //
  // No form-action directive: the Hevy consent form POSTs to /oauth/submit,
  // which 303-redirects to the client's registered callback (e.g. claude.ai).
  // Chrome applies form-action to a form submission's redirect target, so
  // `form-action 'self'` blocks that cross-origin hop and breaks the flow. The
  // redirect target is instead validated server-side against the client's
  // registered redirect_uris, and the API key only ever POSTs same-origin.
  async headers() {
    return [
      {
        source: "/:bridge/oauth/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
