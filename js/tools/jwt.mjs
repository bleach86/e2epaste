// JSON Web Tokens for the JWT decoder: reading them, their times, and
// checking signatures with Web Crypto. Errors carry a user-facing message.

const decoder = new TextDecoder("utf-8", { fatal: true });

function base64UrlToBytes(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("isn't base64url");
  }
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function readJson(part, name) {
  let value;
  try {
    value = JSON.parse(decoder.decode(base64UrlToBytes(part)));
  } catch {
    throw new Error(`The ${name} isn't base64url-encoded JSON, so this isn't a valid JWT.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${name} isn't a JSON object, so this isn't a valid JWT.`);
  }
  return value;
}

// A token's parts, or null for empty input. Accepts "Bearer <token>" and
// stray whitespace, as tokens are often copied from headers.
export function decodeJwt(text) {
  const token = text.trim().replace(/^bearer\s+/i, "").replace(/\s+/g, "");
  if (token === "") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length === 5) {
    throw new Error("This is an encrypted token (JWE). Its claims can only be read with the key it was encrypted for.");
  }
  if (parts.length !== 3) {
    throw new Error(`A JWT has three parts separated by dots; this has ${parts.length}.`);
  }
  const header = readJson(parts[0], "header");
  const payload = readJson(parts[1], "payload");
  let signature;
  try {
    signature = base64UrlToBytes(parts[2]);
  } catch {
    throw new Error("The signature isn't base64url, so this isn't a valid JWT.");
  }
  return {
    header,
    payload,
    signature,
    signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    parts,
  };
}

// The token's time claims, and whether it's in date at `nowMs`. "exp",
// "nbf" and "iat" are seconds since 1970.
export function tokenTimes(payload, nowMs) {
  const at = (claim) => (typeof payload[claim] === "number" ? payload[claim] * 1000 : null);
  const expires = at("exp");
  const notBefore = at("nbf");
  const issued = at("iat");
  let status = "no-expiry";
  if (notBefore !== null && nowMs < notBefore) {
    status = "not-yet";
  } else if (expires !== null) {
    status = nowMs >= expires ? "expired" : "valid";
  }
  return { expires, notBefore, issued, status };
}

const SHA = { 256: "SHA-256", 384: "SHA-384", 512: "SHA-512" };

// What each "alg" needs from Web Crypto. ES512 uses P-521, as the JWT spec
// says.
function algorithmFor(alg) {
  const match = /^(HS|RS|PS|ES)(256|384|512)$/.exec(alg ?? "");
  if (alg === "EdDSA" || alg === "Ed25519") {
    return { kind: "public", import: { name: "Ed25519" }, verify: { name: "Ed25519" } };
  }
  if (!match) {
    return null;
  }
  const [, family, bits] = match;
  const hash = SHA[bits];
  switch (family) {
    case "HS":
      return { kind: "secret", import: { name: "HMAC", hash }, verify: { name: "HMAC" } };
    case "RS":
      return { kind: "public", import: { name: "RSASSA-PKCS1-v1_5", hash }, verify: { name: "RSASSA-PKCS1-v1_5" } };
    case "PS":
      return { kind: "public", import: { name: "RSA-PSS", hash }, verify: { name: "RSA-PSS", saltLength: Number(bits) / 8 } };
    default: {
      const namedCurve = { 256: "P-256", 384: "P-384", 512: "P-521" }[bits];
      return { kind: "public", import: { name: "ECDSA", namedCurve }, verify: { name: "ECDSA", hash } };
    }
  }
}

// Whether `alg` takes a shared secret ("secret"), a public key ("public"),
// or isn't something this can check (null).
export function keyKind(alg) {
  return algorithmFor(alg)?.kind ?? null;
}

async function importPublicKey(text, algorithm, header) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let jwk;
    try {
      jwk = JSON.parse(trimmed);
    } catch {
      throw new Error("The key looks like JSON but can't be read.");
    }
    // A key set (JWKS): the key the token names, or the only one.
    if (Array.isArray(jwk.keys)) {
      const found = jwk.keys.find((k) => k.kid === header.kid) ?? (jwk.keys.length === 1 ? jwk.keys[0] : null);
      if (!found) {
        throw new Error(`The key set has no key with the token's kid${header.kid ? ` (${header.kid})` : ""}.`);
      }
      jwk = found;
    }
    const { d, p, q, dp, dq, qi, ...publicPart } = jwk;
    return crypto.subtle.importKey("jwk", { ...publicPart, key_ops: ["verify"], ext: true }, algorithm, false, ["verify"]);
  }

  const pem = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(trimmed);
  if (!pem) {
    throw new Error("Paste the public key as a PEM block (-----BEGIN PUBLIC KEY-----) or as a JWK.");
  }
  if (pem[1] === "CERTIFICATE") {
    throw new Error("That's a certificate. Paste the public key from it instead (openssl x509 -pubkey -noout).");
  }
  if (pem[1] !== "PUBLIC KEY") {
    throw new Error(`That's a "${pem[1]}" block. Paste the "PUBLIC KEY" form (openssl pkey -pubout converts it).`);
  }
  const der = Uint8Array.from(atob(pem[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("spki", der, algorithm, false, ["verify"]);
}

// Checks the signature of `token` (from decodeJwt). `key` is the shared
// secret for HS*, or a public key (PEM or JWK) for the rest; with
// `secretIsBase64`, the secret is base64 or base64url text of its bytes.
// Resolves true or false, or rejects with a message when it can't check.
export async function verifyJwt(token, key, { secretIsBase64 = false } = {}) {
  const alg = token.header.alg;
  if (alg === "none") {
    throw new Error('This token says "alg": "none": it isn\'t signed at all, so anyone could have made it.');
  }
  const algorithm = algorithmFor(alg);
  if (!algorithm) {
    throw new Error(`This can't check "${alg}" signatures.`);
  }
  if (!crypto?.subtle) {
    throw new Error("Your browser only checks signatures on secure (HTTPS) pages.");
  }

  let cryptoKey;
  try {
    if (algorithm.kind === "secret") {
      let secret;
      if (secretIsBase64) {
        try {
          secret = base64UrlToBytes(key.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
        } catch {
          throw new Error("The secret isn't valid base64.");
        }
      } else {
        secret = new TextEncoder().encode(key);
      }
      if (secret.length === 0) {
        throw new Error("Enter the secret.");
      }
      cryptoKey = await crypto.subtle.importKey("raw", secret, algorithm.import, false, ["verify"]);
    } else {
      cryptoKey = await importPublicKey(key, algorithm.import, token.header);
    }
  } catch (e) {
    // Web Crypto's own errors (a key of the wrong type, say) are terse.
    if (e instanceof DOMException) {
      throw new Error(`That key can't be used for ${alg}: ${e.message}`);
    }
    throw e;
  }
  return crypto.subtle.verify(algorithm.verify, cryptoKey, token.signature, token.signingInput);
}
