// Paste encryption, key handling and the on-the-wire paste format.
//
// Paste format versions:
//   1 - legacy: IV = SHA-256(password || salt)[0..12], password only checked
//       against a hash. Only decrypted, never created.
//   2 - IV is random. With a password, the AES key is derived from both the
//       random paste key and the password, so the password is required to
//       decrypt.

import { deflate, inflate } from "pako";

export const PASTE_VERSION = 2;

const PBKDF2_ITERATIONS = 600000;
const HKDF_INFO = "e2epaste-v2-password";

// Characters used to encode key-fragment positions in the URL hash.
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EXPORTED_KEY_LENGTH = 58;

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// --- Encoding ---------------------------------------------------------------

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

export function generateKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable
    ["encrypt", "decrypt"],
  );
}

export async function exportCryptoKey(key) {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const base64 = btoa(jwk.k);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function importCryptoKey(urlSafeBase64Key) {
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

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);

  const range = max - min + 1;
  const bytesNeeded = Math.ceil(Math.log2(range) / 8);
  const maxByteValue = Math.pow(2, bytesNeeded * 8) - 1;

  if (range > maxByteValue) {
    throw new Error("Range too large for random number generation");
  }

  const array = new Uint8Array(bytesNeeded);
  let randomValue;

  // Rejection sampling to avoid modulo bias.
  do {
    crypto.getRandomValues(array);
    randomValue = array.reduce((acc, byte) => (acc << 8) | byte, 0);
  } while (randomValue > maxByteValue - (maxByteValue % range));

  return min + (randomValue % range);
}

// Splits an exported key into a copy for the server with 6-10 characters
// replaced by random ones, and a URL hash fragment holding the real ones.
export function fragmentKey(key) {
  const numPositions = getRandomInt(6, 10);
  const positions = new Set();

  while (positions.size < numPositions) {
    positions.add(getRandomInt(0, key.length - 1));
  }

  const keyArray = key.split("");
  const removedBytes = [];

  positions.forEach((pos) => {
    removedBytes.push({ position: BASE64_CHARS.charAt(pos), byte: keyArray[pos] });

    let randomByte;
    do {
      randomByte = BASE64_CHARS[getRandomInt(0, BASE64_CHARS.length - 1)];
    } while (randomByte === keyArray[pos]);

    keyArray[pos] = randomByte;
  });

  return {
    serverKey: keyArray.join(""),
    hashFragment: removedBytes.map((item) => `${item.position}${item.byte}`).join(""),
  };
}

export function reconstructKey(serverKey, hashFragment) {
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

// Combines the random paste key with a password-derived key. `pasteKey` must
// be extractable; `salt` is the paste's stored IV.
export async function deriveKeyWithPassword(pasteKey, password, salt) {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const passwordBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    passwordKey,
    256,
  );
  const rawPasteKey = await crypto.subtle.exportKey("raw", pasteKey);

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    concatBytes(new Uint8Array(rawPasteKey), new Uint8Array(passwordBits)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(HKDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- IVs --------------------------------------------------------------------

// Derives a separate AES-GCM IV for each part of a paste (text, file name,
// file) so the same key + IV pair is never used twice.
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

// Returns the key and base IV for a paste as stored by the server.
// `paste` has `key_fragment`, `iv` and `version`.
export async function getPasteSecrets(paste, keyFragment, hasPassword, password) {
  const salt = new Uint8Array(paste.iv);
  const pasteKey = await importCryptoKey(reconstructKey(paste.key_fragment, keyFragment));

  if (paste.version >= 2) {
    const key = hasPassword ? await deriveKeyWithPassword(pasteKey, password, salt) : pasteKey;
    return { key, iv: salt, version: paste.version };
  }

  // v1: the password only feeds into the IV.
  return { key: pasteKey, iv: await legacyIv(password, salt), version: paste.version };
}

// Decrypts one attachment part ("file" or "file-name"). Attachments on v1
// pastes may predate per-part IVs and use the paste IV, so retry with it.
export async function decryptAttachmentPart(secrets, label, encrypted) {
  try {
    return await decryptBytes(encrypted, secrets.key, await deriveIv(secrets.iv, label));
  } catch (e) {
    if (secrets.version >= 2) {
      throw e;
    }
    return decryptBytes(encrypted, secrets.key, secrets.iv);
  }
}
