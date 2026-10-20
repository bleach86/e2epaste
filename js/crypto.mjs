// Paste encryption, key handling and the on-the-wire paste format.
//
// Paste format versions:
//   1 - legacy: IV = SHA-256(password || salt)[0..12], password only checked
//       against a hash. Only decrypted, never created.
//   2 - legacy: IV is random. The server stores the AES key with 6-10
//       characters swapped out and the link holds the real ones, but the
//       key's structure gives most of them away. Only decrypted.
//   3 - the link holds a 128-bit random secret and the server stores no key
//       material. The AES key is derived from the secret (and the password,
//       if any) with HKDF. The title is encrypted too. An access proof is
//       derived the same way (with different HKDF info): the server stores
//       its SHA-256, and only sends the paste to a browser that has the proof.
//
// Each part of a paste (text, title, file name, file) is encrypted with its
// own IV; see deriveIv.

import { deflate, inflate } from "pako";

export const PASTE_VERSION = 3;

const PBKDF2_ITERATIONS = 600000;
const HKDF_INFO_V2_PASSWORD = "e2epaste-v2-password";
const HKDF_INFO_V3 = "e2epaste-v3";
const HKDF_INFO_V3_PASSWORD = "e2epaste-v3-password";
const HKDF_INFO_V3_ACCESS = "e2epaste-v3-access";
const HKDF_INFO_V3_PASSWORD_ACCESS = "e2epaste-v3-password-access";
const LINK_SECRET_BYTES = 16;

// Characters used to encode v2 key-fragment positions in the URL hash.
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EXPORTED_KEY_LENGTH = 58;

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// --- Encoding ---------------------------------------------------------------

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  return new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
}

export function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- Keys -------------------------------------------------------------------

// A new paste's link secret: 128 random bits as 22 base64url characters.
export function generateLinkSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
  return arrayBufferToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeLinkSecret(secret) {
  const base64 = secret.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = new Uint8Array(base64ToArrayBuffer(base64));
  if (bytes.length !== LINK_SECRET_BYTES) {
    throw new Error("Invalid link secret");
  }
  return bytes;
}

async function passwordBits(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    passwordKey,
    256,
  );
  return new Uint8Array(bits);
}

async function hkdfAesKey(ikm, salt, info) {
  const hkdfKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function hkdfBits(ikm, salt, info) {
  const hkdfKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    hkdfKey,
    256,
  );
  return new Uint8Array(bits);
}

// v3: the AES key for a paste and its access proof (hex), from its link
// secret, its stored IV (used as the salt, so every paste's derivation
// differs) and the password, if any. Throws if the link secret is malformed.
//
// The proof shows the server that the browser has the full link (and the
// right password) without revealing either: HKDF outputs for different info
// strings are independent, so the proof says nothing about the key.
export async function deriveV3Secrets(linkSecret, salt, password = null) {
  const secret = decodeLinkSecret(linkSecret);
  const withPassword = password !== null;
  // PBKDF2 is slow on purpose; run it once for both.
  const ikm = withPassword ? concatBytes(secret, await passwordBits(password, salt)) : secret;
  const key = await hkdfAesKey(ikm, salt, withPassword ? HKDF_INFO_V3_PASSWORD : HKDF_INFO_V3);
  const proof = await hkdfBits(ikm, salt, withPassword ? HKDF_INFO_V3_PASSWORD_ACCESS : HKDF_INFO_V3_ACCESS);
  return { key, accessProof: toHex(proof) };
}

export async function deriveV3Key(linkSecret, salt, password = null) {
  return (await deriveV3Secrets(linkSecret, salt, password)).key;
}

// What the server stores in place of the access proof.
export async function accessHash(accessProofHex) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", fromHex(accessProofHex))));
}


// v2: imports the key rebuilt by reconstructKey.
function importCryptoKey(urlSafeBase64Key) {
  const base64 = urlSafeBase64Key.replace(/-/g, "+").replace(/_/g, "/");
  const jwk = {
    kty: "oct",
    k: atob(base64),
    alg: "A256GCM",
    ext: true,
    key_ops: ["encrypt", "decrypt"],
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM" },
    true, // extractable, needed by deriveKeyWithPassword
    ["encrypt", "decrypt"],
  );
}


// v2: puts the real characters from the URL hash back into the server's copy.
function reconstructKey(serverKey, hashFragment) {
  const keyArray = Array(EXPORTED_KEY_LENGTH).fill("");

  for (let i = 0; i < hashFragment.length; i += 2) {
    const position = BASE64_CHARS.indexOf(hashFragment[i]);
    if (position === -1 || position >= EXPORTED_KEY_LENGTH) {
      throw new Error("Invalid key fragment");
    }
    keyArray[position] = hashFragment[i + 1];
  }

  // The server key has the same length; take every position not supplied by
  // the hash fragment from it.
  for (let i = 0; i < EXPORTED_KEY_LENGTH; i++) {
    if (keyArray[i] === "") {
      if (i >= serverKey.length) {
        throw new Error("Server key is too short to fill the array");
      }
      keyArray[i] = serverKey[i];
    }
  }

  return keyArray.join("");
}

// v2: combines the paste key with a password-derived key. `pasteKey` must be
// extractable; `salt` is the paste's stored IV.
async function deriveKeyWithPassword(pasteKey, password, salt) {
  const rawPasteKey = new Uint8Array(await crypto.subtle.exportKey("raw", pasteKey));
  return hkdfAesKey(concatBytes(rawPasteKey, await passwordBits(password, salt)), salt, HKDF_INFO_V2_PASSWORD);
}

// --- IVs --------------------------------------------------------------------

// Derives a separate AES-GCM IV for each part of a paste ("title",
// "file-name", "file"; the text uses the base IV) so the same key + IV pair is
// never used twice.
export async function deriveIv(baseIv, label) {
  const input = concatBytes(baseIv, new TextEncoder().encode(label));
  const hash = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(hash).slice(0, 12);
}

// v1 pastes: IV = SHA-256(password || salt)[0..12].
async function legacyIv(password, salt) {
  const input = concatBytes(new TextEncoder().encode(password), salt);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return new Uint8Array(hash).slice(0, 12);
}

// --- Encrypt / decrypt ------------------------------------------------------

// Content is deflated before encryption.
export async function encryptBytes(data, key, iv) {
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    deflate(new Uint8Array(data)),
  );
  return new Uint8Array(encrypted);
}

export function encryptText(text, key, iv) {
  return encryptBytes(new TextEncoder().encode(text), key, iv);
}

// Pastes created before compression was added are not deflated, so fall
// back to the raw bytes if inflate fails.
function maybeInflate(data) {
  const bytes = new Uint8Array(data);
  try {
    return inflate(bytes);
  } catch (e) {
    return bytes;
  }
}

// Throws if the key or IV is wrong.
export async function decryptBytes(encrypted, key, iv) {
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return maybeInflate(decrypted);
}

export async function decryptText(encrypted, key, iv) {
  return new TextDecoder().decode(await decryptBytes(encrypted, key, iv));
}

// --- Viewing a stored paste -------------------------------------------------

// Returns the key, base IV and (v3) access proof for a paste. `paste` has
// `iv` and `version`, and for v1/v2 `key_fragment`; `linkHash` is the part of
// the link after "#".
export async function getPasteSecrets(paste, linkHash, hasPassword, password) {
  const salt = new Uint8Array(paste.iv);

  if (paste.version >= 3) {
    const { key, accessProof } = await deriveV3Secrets(linkHash, salt, hasPassword ? password : null);
    return { key, iv: salt, version: paste.version, accessProof };
  }

  // v1/v2: the link holds the characters swapped out of the server's copy.
  const pasteKey = await importCryptoKey(reconstructKey(paste.key_fragment, linkHash));

  if (paste.version >= 2) {
    const key = hasPassword ? await deriveKeyWithPassword(pasteKey, password, salt) : pasteKey;
    return { key, iv: salt, version: paste.version };
  }

  // v1: the password only feeds into the IV.
  return { key: pasteKey, iv: await legacyIv(password, salt), version: paste.version };
}

// Decrypts one part of a paste other than its text ("title", "file-name" or
// "file"). Attachments on v1 pastes may predate per-part IVs and use the
// paste IV, so retry with it.
export async function decryptPart(secrets, label, encrypted) {
  try {
    return await decryptBytes(encrypted, secrets.key, await deriveIv(secrets.iv, label));
  } catch (e) {
    if (secrets.version >= 2) {
      throw e;
    }
    return decryptBytes(encrypted, secrets.key, secrets.iv);
  }
}
