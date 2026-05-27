import { describe, expect, test } from "vitest";
import { signJws, verifyJws, encryptJwe, decryptJwe } from "../jwt";

const key = new Uint8Array(32).fill(7);
const wrongKey = new Uint8Array(32).fill(8);

describe("signJws / verifyJws", () => {
  test("round-trips a payload", async () => {
    const token = await signJws({ typ: "test-jws", foo: "bar" }, key);
    const result = await verifyJws<{ typ: "test-jws"; foo: string }>(token, key, "test-jws");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.foo).toBe("bar");
  });

  test("rejects a token signed with a different key", async () => {
    const token = await signJws({ typ: "test-jws", foo: "bar" }, key);
    const result = await verifyJws(token, wrongKey, "test-jws");
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("rejects a token with the wrong typ", async () => {
    const token = await signJws({ typ: "test-jws", foo: "bar" }, key);
    const result = await verifyJws(token, key, "different-typ");
    expect(result).toEqual({ ok: false, reason: "wrong-type" });
  });

  test("rejects a malformed token", async () => {
    const result = await verifyJws("not-a-jws", key, "test-jws");
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  test("rejects an expired token", async () => {
    const token = await signJws({ typ: "test-jws", foo: "bar" }, key, -1);
    const result = await verifyJws(token, key, "test-jws");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});

describe("encryptJwe / decryptJwe", () => {
  test("round-trips a payload", async () => {
    const token = await encryptJwe({ typ: "test-jwe", secret: "shhh" }, key, 60);
    const result = await decryptJwe<{ typ: "test-jwe"; secret: string }>(token, key, "test-jwe");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.secret).toBe("shhh");
  });

  test("rejects a JWE encrypted with a different key", async () => {
    const token = await encryptJwe({ typ: "test-jwe", secret: "shhh" }, key, 60);
    const result = await decryptJwe(token, wrongKey, "test-jwe");
    expect(result).toEqual({ ok: false, reason: "bad-encryption" });
  });

  test("rejects a JWE with the wrong typ", async () => {
    const token = await encryptJwe({ typ: "test-jwe", secret: "shhh" }, key, 60);
    const result = await decryptJwe(token, key, "different-typ");
    expect(result).toEqual({ ok: false, reason: "wrong-type" });
  });

  test("rejects an expired JWE", async () => {
    const token = await encryptJwe({ typ: "test-jwe", secret: "shhh" }, key, -1);
    const result = await decryptJwe(token, key, "test-jwe");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});
