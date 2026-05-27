import { describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { verifyPkce } from "../pkce";

function makePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("verifyPkce", () => {
  test("accepts a valid (verifier, S256 challenge) pair", () => {
    const { verifier, challenge } = makePair();
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  test("rejects a mismatched challenge", () => {
    const { verifier } = makePair();
    const { challenge: otherChallenge } = makePair();
    expect(verifyPkce(verifier, otherChallenge, "S256")).toBe(false);
  });

  test("rejects a verifier shorter than 43 characters", () => {
    const verifier = "tooShort";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });

  test("rejects a verifier containing disallowed characters", () => {
    const verifier = "$".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });
});
