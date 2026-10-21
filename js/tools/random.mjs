// UUIDs and random tokens. Everything random comes from
// crypto.getRandomValues, the browser's cryptographically secure generator.

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uuidText(bytes) {
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Sets the version (high 4 bits of byte 6) and the RFC 9562 variant (10 in
// the high bits of byte 8).
function stamp(bytes, version) {
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

// A random UUID: 122 random bits.
export function uuidV4() {
  return uuidText(stamp(randomBytes(16), 4));
}

// A time-ordered UUID: the time in milliseconds, then 74 random bits.
// Sorting v7 UUIDs as text sorts them by when they were made.
export function uuidV7(nowMs = Date.now()) {
  const bytes = randomBytes(16);
  let ms = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  return uuidText(stamp(bytes, 7));
}

// `count` UUIDs of `version` (4 or 7). A batch of v7s is sorted, so it's in
// order even within one millisecond.
export function uuids(version, count) {
  const list = Array.from({ length: count }, () => (version === 7 ? uuidV7() : uuidV4()));
  return version === 7 ? list.sort() : list;
}

export function formatUuid(uuid, { upper = false, hyphens = true, braces = false } = {}) {
  let text = hyphens ? uuid : uuid.replace(/-/g, "");
  if (upper) text = text.toUpperCase();
  return braces ? `{${text}}` : text;
}

// What a UUID says about itself, or null for empty input: { uuid, version,
// variant, time? } with `time` in ms for versions 1, 6 and 7.
export function inspectUuid(text) {
  const s = text.trim().replace(/^\{|\}$/g, "").replace(/^urn:uuid:/i, "");
  if (s === "") {
    return null;
  }
  const h = s.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h) || (s.includes("-") && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))) {
    throw new Error("A UUID is 32 hex digits, usually written 8-4-4-4-12.");
  }
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  if (/^0+$/.test(h)) return { uuid, version: null, variant: "the nil UUID" };
  if (/^f+$/.test(h)) return { uuid, version: null, variant: "the max UUID" };

  const variantBits = parseInt(h[16], 16);
  const variant =
    variantBits < 8 ? "NCS (old)" : variantBits < 12 ? "RFC 9562" : variantBits < 14 ? "Microsoft (old)" : "reserved";
  const version = variant === "RFC 9562" ? parseInt(h[12], 16) : null;
  let time;
  if (version === 7) {
    time = Number(BigInt(`0x${h.slice(0, 12)}`));
  } else if (version === 1 || version === 6) {
    // 100-nanosecond steps since 15 October 1582.
    const ticks =
      version === 1
        ? BigInt(`0x${h.slice(13, 16)}${h.slice(8, 12)}${h.slice(0, 8)}`)
        : BigInt(`0x${h.slice(0, 12)}${h.slice(13, 16)}`);
    time = Number(ticks / 10000n - 12219292800000n);
  }
  return { uuid, version, variant, time };
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// A random token. For "hex", "base64" and "base64url", `length` is the
// number of random bytes; for "alphanumeric" it's the number of characters,
// each picked evenly (bytes of 248 and up are thrown away, so none is
// likelier than another).
export function randomToken(format, length) {
  if (format === "alphanumeric") {
    let out = "";
    while (out.length < length) {
      for (const b of randomBytes(length)) {
        if (b < 248 && out.length < length) out += ALPHANUMERIC[b % 62];
      }
    }
    return out;
  }
  const bytes = randomBytes(length);
  if (format === "hex") return hex(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return format === "base64url" ? base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : base64;
}

// How many random bits a token of `format` and `length` holds.
export function tokenBits(format, length) {
  return format === "alphanumeric" ? Math.floor(length * Math.log2(62)) : length * 8;
}
