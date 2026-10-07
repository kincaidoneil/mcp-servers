// Outbound requests to ChatGPT callback URLs: address checks, Standard
// Webhooks signing, and the verification handshake.

import { randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { Webhook } from "standardwebhooks";
import { Agent, fetch as undiciFetch } from "undici";

// text() yields at most the first few KB: nothing this server needs from a
// callback is larger, and an endless body must not exhaust memory.
export type CallbackResponse = { status: number; text(): Promise<string> };
const MAX_RESPONSE_BYTES = 4096;

// The one seam tests replace: production pins every connection to a vetted
// public address; tests deliver to an in-process receiver.
export type CallbackFetch = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<CallbackResponse>;

const TIMEOUT_MS = 10_000;
export const MAX_EVENT_BYTES = 256 * 1024;

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 96], // ::, ::1, and IPv4-compatible ::a.b.c.d
  ["::ffff:0:0:0", 96], // SIIT-translated IPv4
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // includes Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can embed any IPv4 address
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(prefix, bits, "ipv6");
}

// BlockList already checks IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4
// rules, and it applies a ::ffff:0:0/96 rule to every IPv4 address, so that
// range must not be listed.
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type CallbackUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

// Static checks. Name resolution is checked again on every connection, since
// DNS can change between subscribe and delivery.
export function checkCallbackUrl(raw: string): CallbackUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "callback URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "callback URL must use https" };
  if (url.username || url.password) {
    return { ok: false, reason: "callback URL must not carry credentials" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Node never runs the DNS lookup hook for IP literals, so vet them here.
  if (net.isIP(host) !== 0 && !isPublicAddress(host)) {
    return { ok: false, reason: "callback URL points at a non-public address" };
  }
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    return { ok: false, reason: "callback URL points at a non-public host" };
  }
  return { ok: true, url: url.toString() };
}

// Resolve, vet every address, then connect to a vetted one. TLS still
// verifies against the original hostname because only the socket address is
// substituted. Redirects are refused.
export function createSafeCallbackFetch(): CallbackFetch {
  const agent = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { all: true }, (err, addresses) => {
          if (err) return callback(err, "", 4);
          if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
            const blockedErr = Object.assign(
              new Error(`${hostname} resolves to a non-public address`),
              { code: "EBLOCKED" },
            );
            return callback(blockedErr, "", 4);
          }
          if (options.all) return callback(null, addresses);
          const [first] = addresses;
          return callback(null, first!.address, first!.family);
        });
      },
    },
  });
  return async (url, init) => {
    const response = await undiciFetch(url, {
      method: "POST",
      redirect: "error",
      dispatcher: agent,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    const head = await readHead(response.body, MAX_RESPONSE_BYTES);
    return { status: response.status, text: async () => head };
  };
}

// Typed by shape: undici's stream type differs from the DOM one.
interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

async function readHead(body: ByteStream | null, limit: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

export type SecretCheck = { ok: true } | { ok: false; reason: string };

export function checkSigningSecret(secret: string): SecretCheck {
  if (!secret.startsWith("whsec_")) return { ok: false, reason: "secret must start with whsec_" };
  const encoded = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return { ok: false, reason: "secret must be base64 after the whsec_ prefix" };
  }
  const bytes = Buffer.from(encoded, "base64").length;
  if (bytes < 24 || bytes > 64) {
    return { ok: false, reason: "secret must decode to 24-64 bytes" };
  }
  return { ok: true };
}

export type PostOutcome =
  | { kind: "accepted"; body: string }
  | { kind: "rejected"; status: number }
  | { kind: "failed"; reason: "timeout" | "connection_refused" | "tls_error" };

// One signed POST. Every secret signs, space-separated, so a receiver mid
// rotation accepts either key.
export async function postSigned(
  callbackFetch: CallbackFetch,
  req: { url: string; secrets: string[]; subscriptionId: string; messageId: string; body: string },
): Promise<PostOutcome> {
  const signedAt = new Date();
  const signature = req.secrets
    .map((secret) => new Webhook(secret).sign(req.messageId, signedAt, req.body))
    .join(" ");
  try {
    const response = await callbackFetch(req.url, {
      headers: {
        "content-type": "application/json",
        "webhook-id": req.messageId,
        "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
        "webhook-signature": signature,
        "x-mcp-subscription-id": req.subscriptionId,
      },
      body: req.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) {
      return { kind: "rejected", status: response.status };
    }
    return { kind: "accepted", body: await response.text().catch(() => "") };
  } catch (err) {
    return { kind: "failed", reason: classifyFailure(err) };
  }
}

// Categories from the MCP Events design sketch. A blocked address, a DNS
// failure, and a refused redirect all read as connection_refused.
function classifyFailure(err: unknown): "timeout" | "connection_refused" | "tls_error" {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timeout";
  }
  const cause = err instanceof Error ? err.cause : undefined;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  return /TLS|SSL|CERT|UNABLE_TO_VERIFY/.test(code) ? "tls_error" : "connection_refused";
}

export type VerificationFailure =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

export async function verifyCallback(
  callbackFetch: CallbackFetch,
  req: { url: string; secret: string; subscriptionId: string },
): Promise<{ ok: true } | { ok: false; reason: VerificationFailure }> {
  const challenge = randomBytes(24).toString("base64url");
  const outcome = await postSigned(callbackFetch, {
    url: req.url,
    secrets: [req.secret],
    subscriptionId: req.subscriptionId,
    messageId: `msg_verification_${randomBytes(12).toString("hex")}`,
    body: JSON.stringify({ type: "verification", challenge }),
  });
  if (outcome.kind === "failed") return { ok: false, reason: outcome.reason };
  if (outcome.kind === "rejected") {
    return { ok: false, reason: outcome.status >= 500 ? "http_5xx" : "http_4xx" };
  }
  let echoed: unknown;
  try {
    echoed = (JSON.parse(outcome.body) as { challenge?: unknown }).challenge;
  } catch {
    return { ok: false, reason: "challenge_failed" };
  }
  if (typeof echoed !== "string") return { ok: false, reason: "challenge_failed" };
  const a = Buffer.from(echoed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "challenge_failed" };
}
