import { describe, expect, it } from "vitest";
import {
  checkCallbackUrl,
  checkSigningSecret,
  createSafeCallbackFetch,
  isPublicAddress,
} from "../events/callback";
import { canonicalJson } from "../events/subscriptions";

describe("callback guards", () => {
  it("classifies addresses", () => {
    for (const ip of ["8.8.8.8", "104.18.32.7", "2606:4700::6810:84e5"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
      "2002:7f00:1::",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("checks callback URLs statically", () => {
    expect(checkCallbackUrl("https://hooks.chatgpt.com/x").ok).toBe(true);
    for (const url of [
      "http://hooks.chatgpt.com/x",
      "https://user:pw@hooks.chatgpt.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://intranet/x",
      "not a url",
    ]) {
      expect(checkCallbackUrl(url).ok, url).toBe(false);
    }
  });

  it("checks signing secrets", () => {
    expect(checkSigningSecret(`whsec_${Buffer.alloc(32, 1).toString("base64")}`).ok).toBe(true);
    expect(checkSigningSecret(`whsec_${Buffer.alloc(16, 1).toString("base64")}`).ok).toBe(false);
    expect(checkSigningSecret(`whsec_${Buffer.alloc(65, 1).toString("base64")}`).ok).toBe(false);
    expect(checkSigningSecret(Buffer.alloc(32, 1).toString("base64")).ok).toBe(false);
    expect(checkSigningSecret("whsec_not*base64").ok).toBe(false);
  });

  it("canonicalizes key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  // Uses real DNS: localtest.me resolves to 127.0.0.1, which passes the static
  // URL check, so only the connection-time lookup guard can stop it.
  it.skipIf(!process.env["NETWORK_TESTS"])(
    "refuses hostnames that resolve to private addresses",
    async () => {
      const post = createSafeCallbackFetch();
      await expect(
        post("https://localtest.me/x", {
          headers: {},
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    },
  );
});
