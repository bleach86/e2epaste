// Pure text functions behind the tool pages. Converters return a string, or
// { text, warning } when the result is usable but suspect, and throw an Error
// with a user-facing message when the input can't be converted.

const encoder = new TextEncoder();

const graphemeSegmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

// Split into user-perceived characters so emoji (incl. ZWJ sequences, skin
// tones, flags) count as one. Falls back to code points.
export function graphemes(str) {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

// Reads bytes as UTF-8, warning (rather than failing) on invalid sequences.
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    return {
      text: new TextDecoder().decode(bytes),
      warning: "These bytes aren't valid UTF-8 text, so some characters are shown as �.",
    };
  }
}

// --- Base64 -----------------------------------------------------------------

export function base64Encode(text) {
  const bytes = encoder.encode(text);
  let binary = "";
  // Chunked so huge inputs don't overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Accepts standard and URL-safe Base64, whitespace and missing padding.
// Base64's symbols as they look when copied from an HTML page's source
// (&#x2f;) or a URL (%2F).
const ESCAPED_SYMBOLS = [
  [/&#x2b;|&#43;|&plus;|%2b/gi, "+"],
  [/&#x2f;|&#47;|&sol;|%2f/gi, "/"],
  [/&#x3d;|&#61;|&equals;|%3d/gi, "="],
];

export function base64Decode(input) {
  let b64 = input.replace(/\s+/g, "");
  const unescaped = new Set();
  for (const [pattern, symbol] of ESCAPED_SYMBOLS) {
    b64 = b64.replace(pattern, (escaped) => {
      unescaped.add(`${escaped} as ${symbol}`);
      return symbol;
    });
  }
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    const bad = b64.match(/[^A-Za-z0-9+/=]/)?.[0];
    throw new Error(
      bad
        ? `This isn't valid Base64: "${bad}" isn't a Base64 character.`
        : "This isn't valid Base64: \"=\" can only be at the end.",
    );
  }
  b64 = b64.replace(/=+$/, "");
  if (b64.length % 4 === 1) {
    throw new Error("This isn't valid Base64: it looks cut off.");
  }
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);

  const binary = atob(b64);
  const result = decodeUtf8(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  if (unescaped.size === 0) {
    return result;
  }
  // Say what was read differently, with any warning about the text itself.
  const note = `Read escaped symbols: ${[...unescaped].join(", ")}.`;
  return typeof result === "string" ? { text: result, warning: note } : { text: result.text, warning: `${note} ${result.warning}` };
}

// --- Hex --------------------------------------------------------------------

export function hexEncode(text) {
  return Array.from(encoder.encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Ignores spaces, colons, commas, dashes and 0x prefixes.
export function hexDecode(input) {
  const hex = input.replace(/0x/gi, "").replace(/[\s:,-]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Hex can only contain the digits 0-9 and letters a-f.");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("Hex needs an even number of digits: two per byte.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return decodeUtf8(bytes);
}

// --- Binary -----------------------------------------------------------------

export function binaryEncode(text) {
  return Array.from(encoder.encode(text), (b) => b.toString(2).padStart(8, "0")).join(" ");
}

// Takes bytes separated by whitespace, or one unbroken run of bits in groups
// of 8.
export function binaryDecode(input) {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }
  if (/[^01\s]/.test(trimmed)) {
    throw new Error("Binary can only contain 0 and 1, with spaces between bytes.");
  }

  let groups = trimmed.split(/\s+/);
  if (groups.length === 1 && trimmed.length > 8) {
    if (trimmed.length % 8 !== 0) {
      throw new Error("Bits without spaces must come in groups of 8.");
    }
    groups = trimmed.match(/.{8}/g);
  }
  if (groups.some((g) => g.length > 8)) {
    throw new Error("A byte has at most 8 bits. Separate bytes with spaces.");
  }
  return decodeUtf8(Uint8Array.from(groups, (g) => parseInt(g, 2)));
}

// --- Counting ---------------------------------------------------------------

export function textStats(text) {
  if (text === "") {
    return { length: 0, noSpaces: 0, bytes: 0, words: 0, lines: 0, uniqueWords: 0, uniqueChars: 0 };
  }
  const chars = graphemes(text);
  const words = text.trim().split(/\s+/).filter(Boolean);

  return {
    length: chars.length,
    noSpaces: chars.filter((c) => !/^\s+$/.test(c)).length,
    bytes: encoder.encode(text).length,
    words: words.length,
    lines: text.split(/\r\n|\r|\n/).length,
    uniqueWords: new Set(words.map((w) => w.toLowerCase())).size,
    uniqueChars: new Set(chars).size,
  };
}

// --- Transforming -----------------------------------------------------------

export function reverseText(text) {
  return graphemes(text).reverse().join("");
}

export function randomCase(text) {
  const chars = Array.from(text);
  const random = crypto.getRandomValues(new Uint8Array(chars.length));
  return chars.map((c, i) => (random[i] & 1 ? c.toUpperCase() : c.toLowerCase())).join("");
}

// Non-overlapping matches of `term` in `text` as [start, end) index pairs.
// Uses a regex so case-insensitive matching never shifts indexes (lowercasing
// some characters changes their length).
export function findOccurrences(text, term, { caseSensitive = false, wholeWord = false } = {}) {
  if (term === "") {
    return [];
  }
  let pattern = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) {
    pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
  }
  const regex = new RegExp(pattern, caseSensitive ? "gu" : "giu");
  return Array.from(text.matchAll(regex), (m) => [m.index, m.index + m[0].length]);
}
