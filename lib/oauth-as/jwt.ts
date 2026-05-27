import {
  CompactEncrypt,
  compactDecrypt,
  SignJWT,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
} from "jose";

const HMAC_ALG = "HS256";
const ENC_ALG = "A256GCM";
const KEY_WRAP_ALG = "dir";

export type JwtResult<T> = { ok: true; payload: T } | { ok: false; reason: JwtFailure };

export type JwtFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-type"
  | "bad-encryption";

export type BaseClaims = {
  typ: string;
  exp?: number;
};

function toJwtPayload(value: object): JWTPayload {
  // jose's SignJWT/CompactEncrypt accept JWTPayload (`{[k: string]: unknown}`); our
  // typed claim records satisfy that structurally but TS treats interfaces as closed.
  return Object.fromEntries(Object.entries(value));
}

export async function signJws<T extends BaseClaims>(
  payload: T,
  signingKey: Uint8Array,
  ttlSeconds?: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = toJwtPayload({
    ...payload,
    iat: now,
    ...(ttlSeconds ? { exp: now + ttlSeconds } : {}),
  });
  return await new SignJWT(claims).setProtectedHeader({ alg: HMAC_ALG }).sign(signingKey);
}

export async function verifyJws<T extends BaseClaims>(
  token: string,
  signingKey: Uint8Array,
  expectedTyp: T["typ"],
): Promise<JwtResult<T>> {
  try {
    const { payload } = await jwtVerify(token, signingKey, { algorithms: [HMAC_ALG] });
    const claims = payload as unknown as T;
    if (claims.typ !== expectedTyp) return { ok: false, reason: "wrong-type" };
    return { ok: true, payload: claims };
  } catch (err) {
    return { ok: false, reason: classifyJoseError(err) };
  }
}

export async function encryptJwe<T extends BaseClaims>(
  payload: T,
  signingKey: Uint8Array,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + ttlSeconds };
  const encoded = new TextEncoder().encode(JSON.stringify(claims));
  return await new CompactEncrypt(encoded)
    .setProtectedHeader({ alg: KEY_WRAP_ALG, enc: ENC_ALG })
    .encrypt(signingKey);
}

export async function decryptJwe<T extends BaseClaims>(
  token: string,
  signingKey: Uint8Array,
  expectedTyp: T["typ"],
): Promise<JwtResult<T>> {
  try {
    const { plaintext } = await compactDecrypt(token, signingKey);
    const claims = JSON.parse(new TextDecoder().decode(plaintext)) as T & { exp: number };
    if (claims.typ !== expectedTyp) return { ok: false, reason: "wrong-type" };
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) return { ok: false, reason: "expired" };
    return { ok: true, payload: claims };
  } catch (err) {
    return { ok: false, reason: classifyJoseError(err) };
  }
}

function classifyJoseError(err: unknown): JwtFailure {
  if (err instanceof joseErrors.JWTExpired) return "expired";
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "bad-signature";
  if (err instanceof joseErrors.JWEDecryptionFailed) return "bad-encryption";
  if (err instanceof joseErrors.JOSEError) return "malformed";
  return "malformed";
}
