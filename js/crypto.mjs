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
//   4 - v3, with nothing left for the server to learn from sizes or flags.
//       Each part is length-prefixed and zero-padded before encryption (see
//       padPart), so the server only sees rounded sizes. The language is
//       encrypted along with the title, and whether there's a password is
//       carried in the link (see generateLinkSecret), not told to the server.
//       Attachments are encrypted in chunks (see encryptFile), so files of
//       any size are never held in memory whole.
//
// Each part of a paste (text, title, file name, file) is encrypted with its
// own IV; see deriveIv.

import { deflate, inflate } from "pako";

export const PASTE_VERSION = 4;

const PBKDF2_ITERATIONS = 600000;
const HKDF_INFO_V2_PASSWORD = "e2epaste-v2-password";
const HKDF_INFO_V3 = "e2epaste-v3";
const HKDF_INFO_V3_PASSWORD = "e2epaste-v3-password";
const HKDF_INFO_V3_ACCESS = "e2epaste-v3-access";
const HKDF_INFO_V3_PASSWORD_ACCESS = "e2epaste-v3-password-access";
const LINK_SECRET_BYTES = 16;
const LINK_SECRET_CHARS = 22;
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// 16 bytes take 22 base64 characters, which hold 132 bits: the last
// character's low 4 bits are spare. v4 links use one for "has a password".
const LINK_SPARE_BITS = 0b1111;
const LINK_FLAG_PASSWORD = 0b0001;

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
// With `password`, one of the last character's spare bits is set, so the
// viewer's page knows to ask for it without the server knowing (v4). The
// link is no longer, and looks just as random either way.
export function generateLinkSecret({ password = false } = {}) {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
  const secret = arrayBufferToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return password ? withLastChar(secret, (value) => value | LINK_FLAG_PASSWORD) : secret;
}

// v4: whether the link says the paste has a password. Only a complete link
// is read: a cut-off one should get "check the link", not a password prompt.
export function linkHasPassword(linkSecret) {
  if (linkSecret.length !== LINK_SECRET_CHARS) {
    return false;
  }
  const value = BASE64URL_CHARS.indexOf(linkSecret.at(-1));
  return value !== -1 && (value & LINK_FLAG_PASSWORD) !== 0;
}

function withLastChar(secret, change) {
  const value = BASE64URL_CHARS.indexOf(secret.at(-1) ?? "");
  if (value === -1) {
    return secret;
  }
  return secret.slice(0, -1) + BASE64URL_CHARS[change(value)];
}

function decodeLinkSecret(linkSecret) {
  // The flags aren't part of the secret.
  const secret = withLastChar(linkSecret, (value) => value & ~LINK_SPARE_BITS);
  if (secret.length !== LINK_SECRET_CHARS) {
    throw new Error("Invalid link secret");
  }
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

// --- v4 padding ---------------------------------------------------------------

// Padmé (Nikitin et al., "Reducing Metadata Leakage from Encrypted Files and
// Communication with PURBs", 2019): rounds `length` up so that only its top
// few bits can vary. The overhead is at most 12% and shrinks as sizes grow;
// what's left of the length says about log log of it. Must match
// src/padding.rs, which checks new pastes are padded.
export function padme(length) {
  if (length < 2) {
    return length;
  }
  const exponent = bitLength(length) - 1;
  const step = 2 ** (exponent - bitLength(exponent));
  return Math.ceil(length / step) * step;
}

function bitLength(n) {
  return n.toString(2).length;
}

// How each v4 part is padded (before encryption; the server sees 16 bytes
// more, the AES-GCM tag). Every short text is the same size; the title,
// with the language, is always the same size. Attachments: see encryptFile.
export const PART_PADDING = {
  text: { min: 4096 },
  "file-name": { min: 1024 },
  title: { fixed: 512 },
};

const LENGTH_BYTES = 4;

// The padded size for `length` bytes of data, with its length prefix.
export function paddedLength(length, padding) {
  const framed = LENGTH_BYTES + length;
  if (padding.fixed !== undefined) {
    if (framed > padding.fixed) {
      throw new Error("Too long for its fixed size");
    }
    return padding.fixed;
  }
  return padme(Math.max(padding.min, framed));
}

// [4-byte big-endian length][data][zero bytes up to the padded size]
export function padPart(data, padding) {
  const out = new Uint8Array(paddedLength(data.length, padding));
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, LENGTH_BYTES);
  return out;
}

export function unpadPart(padded) {
  if (padded.length < LENGTH_BYTES) {
    throw new Error("Padded part is too short");
  }
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (LENGTH_BYTES + length > padded.length) {
    throw new Error("Padded part's length is out of range");
  }
  return padded.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
}

// v4: encrypts one part of a paste ("text", "title" or "file-name"):
// deflated, then padded, each with its own IV.
export async function encryptPart(key, baseIv, label, data) {
  const plain = padPart(deflate(new Uint8Array(data)), PART_PADDING[label]);
  const iv = label === "text" ? baseIv : await deriveIv(baseIv, label);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
}

// v4: the title part holds the title and the language ("auto" to guess it
// after decrypting), so the server learns neither.
export function encodeDetails(title, syntax) {
  return new TextEncoder().encode(JSON.stringify({ title, syntax }));
}

export function decodeDetails(bytes) {
  const details = JSON.parse(new TextDecoder().decode(bytes));
  return {
    title: typeof details.title === "string" ? details.title : "",
    syntax: typeof details.syntax === "string" ? details.syntax : "auto",
  };
}

// --- v4 attachments -----------------------------------------------------------
//
// An attachment is the stream [8-byte big-endian size][the file][zero bytes],
// padded to a Padmé size (at least 4 KiB) and cut into 1 MiB chunks, each
// encrypted on its own (the STREAM construction, as in age and Tink). A
// chunk's nonce is a per-file prefix, the chunk's number and whether it's
// the last one, so chunks can't be reordered, dropped, or swapped in from
// another file, and a cut-off file fails to decrypt rather than coming out
// short. Every chunk but the last is the same size.
//
// Attachments aren't compressed: the server would see both the size
// declared up front (from the original) and the stored one, which together
// would say how compressible, so roughly what kind of file, it is. Most
// large files are compressed already. Must match src/padding.rs.

export const FILE_CHUNK_BYTES = 1024 * 1024;
const FILE_SIZE_BYTES = 8;
const FILE_MIN_PADDED = 4096;
const TAG_BYTES = 16;

// The padded size of a file of `size` bytes, before encryption.
export function paddedFileLength(size) {
  return padme(Math.max(FILE_MIN_PADDED, FILE_SIZE_BYTES + size));
}

// What the server stores for a file of `size` bytes: the padded size plus a
// tag per chunk. Declared when the paste is created.
export function encryptedFileLength(size) {
  const padded = paddedFileLength(size);
  return padded + TAG_BYTES * Math.ceil(padded / FILE_CHUNK_BYTES);
}

async function chunkNoncePrefix(baseIv) {
  return (await deriveIv(baseIv, "file")).subarray(0, 7);
}

// [7-byte prefix][4-byte chunk number][1 if the last chunk, else 0]
function chunkNonce(prefix, index, last) {
  const nonce = new Uint8Array(12);
  nonce.set(prefix);
  new DataView(nonce.buffer).setUint32(7, index);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

// Encrypts `file` (a Blob or File), reading one chunk's worth at a time, and
// awaits `send(index, last, encryptedChunk)` for each chunk in order.
export async function encryptFile(file, key, baseIv, send) {
  const padded = paddedFileLength(file.size);
  const count = Math.ceil(padded / FILE_CHUNK_BYTES);
  const prefix = await chunkNoncePrefix(baseIv);
  for (let index = 0; index < count; index++) {
    // This chunk's part of the stream: [start, end).
    const start = index * FILE_CHUNK_BYTES;
    const end = Math.min(padded, start + FILE_CHUNK_BYTES);
    const plain = new Uint8Array(end - start);
    if (index === 0) {
      new DataView(plain.buffer).setBigUint64(0, BigInt(file.size));
    }
    const fileStart = Math.max(0, start - FILE_SIZE_BYTES);
    const fileEnd = Math.min(file.size, end - FILE_SIZE_BYTES);
    if (fileEnd > fileStart) {
      const bytes = new Uint8Array(await file.slice(fileStart, fileEnd).arrayBuffer());
      plain.set(bytes, fileStart + FILE_SIZE_BYTES - start);
    }
    const last = index === count - 1;
    const iv = chunkNonce(prefix, index, last);
    await send(index, last, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain)));
  }
}

// Bytes arriving in pieces of any size, taken out in fixed-size chunks.
class ByteQueue {
  constructor() {
    this.pieces = [];
    this.length = 0;
  }

  push(bytes) {
    this.pieces.push(bytes);
    this.length += bytes.length;
  }

  take(count) {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const piece = this.pieces[0];
      const used = Math.min(piece.length, count - filled);
      out.set(piece.subarray(0, used), filled);
      filled += used;
      if (used === piece.length) {
        this.pieces.shift();
      } else {
        this.pieces[0] = piece.subarray(used);
      }
    }
    this.length -= count;
    return out;
  }
}

// Decrypted pieces are gathered into a Blob every so often, which the
// browser can keep on disk rather than in memory.
const BLOB_EVERY_BYTES = 32 * 1024 * 1024;

// Decrypts a v4 attachment as it downloads. `stream` is the response body;
// `onProgress(bytesReceived)` is called as it arrives. Returns the file as a
// Blob. Throws if anything was changed, reordered or cut off.
export async function decryptFile(stream, key, baseIv, onProgress = () => {}) {
  const encryptedChunk = FILE_CHUNK_BYTES + TAG_BYTES;
  const prefix = await chunkNoncePrefix(baseIv);
  const queue = new ByteQueue();
  let index = 0;
  let size = null;
  let remaining = 0;
  let parts = [];
  let unblobbed = 0;
  let received = 0;

  const open = async (chunk, last) => {
    const iv = chunkNonce(prefix, index, last);
    let plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, chunk));
    index++;
    if (size === null) {
      size = Number(new DataView(plain.buffer).getBigUint64(0));
      remaining = size;
      plain = plain.subarray(FILE_SIZE_BYTES);
    }
    // What's left after the file is padding.
    const used = Math.min(remaining, plain.length);
    if (used > 0) {
      parts.push(plain.subarray(0, used));
      remaining -= used;
      unblobbed += used;
      if (unblobbed >= BLOB_EVERY_BYTES) {
        parts = [new Blob(parts)];
        unblobbed = 0;
      }
    }
  };

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    queue.push(value);
    received += value.length;
    onProgress(received);
    // Keep at least one chunk back: only the end of the stream says which
    // one is the last.
    while (queue.length > encryptedChunk) {
      await open(queue.take(encryptedChunk), false);
    }
  }
  if (queue.length <= TAG_BYTES) {
    throw new Error("The attachment is cut off");
  }
  await open(queue.take(queue.length), true);
  if (remaining !== 0) {
    throw new Error("The attachment is shorter than it says");
  }
  return new Blob(parts, { type: "application/octet-stream" });
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

// Decrypts one part of a paste: "text", "title", "file-name" or "file".
// Attachments on v1 pastes may predate per-part IVs and use the paste IV, so
// retry with it.
export async function decryptPart(secrets, label, encrypted) {
  if (secrets.version >= 4) {
    const iv = label === "text" ? secrets.iv : await deriveIv(secrets.iv, label);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, secrets.key, encrypted);
    return inflate(unpadPart(new Uint8Array(plain)));
  }
  if (label === "text") {
    return decryptBytes(encrypted, secrets.key, secrets.iv);
  }
  try {
    return await decryptBytes(encrypted, secrets.key, await deriveIv(secrets.iv, label));
  } catch (e) {
    if (secrets.version >= 2) {
      throw e;
    }
    return decryptBytes(encrypted, secrets.key, secrets.iv);
  }
}
