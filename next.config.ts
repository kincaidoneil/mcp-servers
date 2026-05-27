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
};

export default nextConfig;
