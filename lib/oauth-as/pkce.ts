import { createHash } from "node:crypto";

export type PkceMethod = "S256";

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifyPkce(verifier: string, challenge: string, method: PkceMethod): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  if (method !== "S256") return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(computed, challenge);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
