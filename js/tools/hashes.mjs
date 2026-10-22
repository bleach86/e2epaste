// Hashes for the hash generator, from @noble/hashes: incremental, so a file
// is read a slice at a time rather than all at once.
import { blake3 } from "@noble/hashes/blake3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { sha3_256, sha3_512 } from "@noble/hashes/sha3.js";

// In the order shown. `common` ones are ticked to start with. BLAKE3 has
// its own keyed mode instead of HMAC, so it's left out when there's a key.
export const ALGORITHMS = [
  { id: "md5", name: "MD5", hash: md5, common: true },
  { id: "sha1", name: "SHA-1", hash: sha1, common: true },
  { id: "sha256", name: "SHA-256", hash: sha256, common: true },
  { id: "sha384", name: "SHA-384", hash: sha384 },
  { id: "sha512", name: "SHA-512", hash: sha512, common: true },
  { id: "sha3_256", name: "SHA3-256", hash: sha3_256 },
  { id: "sha3_512", name: "SHA3-512", hash: sha3_512 },
  { id: "blake3", name: "BLAKE3", hash: blake3, noHmac: true },
];

const SLICE_BYTES = 4 * 1024 * 1024;

function hashers(ids, key) {
  return ALGORITHMS.filter((a) => ids.includes(a.id) && !(key && a.noHmac)).map((a) => ({
    id: a.id,
    state: key ? hmac.create(a.hash, key) : a.hash.create(),
  }));
}

// { id: bytes } for the algorithms in `ids`; HMACs when `key` (bytes) is
// given and not empty.
export function hashBytes(bytes, ids, key = null) {
  const list = hashers(ids, key?.length ? key : null);
  return Object.fromEntries(list.map(({ id, state }) => [id, state.update(bytes).digest()]));
}

// The same for a File or Blob, read a slice at a time. onProgress(done,
// total) after each slice; stops with an AbortError when `signal` aborts.
export async function hashFile(file, ids, { key = null, onProgress = () => {}, signal } = {}) {
  const list = hashers(ids, key?.length ? key : null);
  for (let start = 0; start < file.size; start += SLICE_BYTES) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(start, start + SLICE_BYTES).arrayBuffer());
    for (const { state } of list) {
      state.update(bytes);
    }
    onProgress(Math.min(file.size, start + SLICE_BYTES), file.size);
  }
  signal?.throwIfAborted();
  return Object.fromEntries(list.map(({ id, state }) => [id, state.digest()]));
}

export function formatDigest(bytes, format) {
  if (format === "base64") {
    return btoa(String.fromCharCode(...bytes));
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return format === "HEX" ? hex.toUpperCase() : hex;
}

// The bytes of a pasted checksum: hex (any case, spaces and colons
// allowed) or base64. Null if it's neither.
export function parseDigest(text) {
  const s = text.trim();
  const hex = s.replace(/[\s:]/g, "");
  if (/^([0-9a-f]{2})+$/i.test(hex)) {
    return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    try {
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

// Which of `results` ({ id: bytes }) equals `expected` (bytes), or null.
export function findMatch(results, expected) {
  for (const [id, bytes] of Object.entries(results)) {
    if (bytes.length === expected.length && bytes.every((b, i) => b === expected[i])) {
      return id;
    }
  }
  return null;
}
