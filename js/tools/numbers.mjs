// Pure number functions behind the number tools. Numbers are BigInts, so
// they can be any size. Parsers throw an Error with a user-facing message
// when the input can't be read.

// Longer input is refused: converting is quadratic in the number of digits.
export const MAX_DIGITS = 10000;
export const WIDTHS = [8, 16, 32, 64, 128];

const PREFIXES = { 2: "0b", 8: "0o", 16: "0x" };
const DIGIT_NAMES = {
  2: "a binary digit (0 or 1)",
  8: "an octal digit (0 to 7)",
  10: "a decimal digit",
  16: "a hex digit (0 to 9, a to f)",
};
// Digit groups for display: binary in nibbles, hex in 16-bit words.
const GROUP_SIZES = { 2: 4, 8: 3, 10: 3, 16: 4 };

function digitName(base) {
  return DIGIT_NAMES[base] ?? `a base ${base} digit`;
}

// Reads a whole number written in `base` (2 to 36), or null for empty
// input. Allows a sign, the base's usual prefix (0x, 0b, 0o, in any case),
// and spaces, underscores, commas and apostrophes between digits.
export function parseNumber(text, base) {
  let s = text.trim();
  if (s === "") {
    return null;
  }
  let negative = false;
  if (/^[-+−]/.test(s)) {
    negative = s[0] !== "+";
    s = s.slice(1).trimStart();
  }
  s = s.replace(/[\s_,']/g, "");
  const prefix = PREFIXES[base];
  if (prefix && s.toLowerCase().startsWith(prefix)) {
    s = s.slice(2);
  }
  if (s === "") {
    throw new Error("Enter some digits.");
  }
  if (s.length > MAX_DIGITS) {
    throw new Error(`That's more than ${MAX_DIGITS.toLocaleString()} digits.`);
  }
  if (base === 10 && /^\d*[.eE]/.test(s)) {
    throw new Error("Only whole numbers can be converted.");
  }

  let value = 0n;
  const big = BigInt(base);
  for (const ch of s) {
    const digit = parseInt(ch, 36);
    if (Number.isNaN(digit) || digit >= base) {
      throw new Error(`"${ch}" isn't ${digitName(base)}.`);
    }
    value = value * big + BigInt(digit);
  }
  return negative ? -value : value;
}

// The two's-complement bits of `value` in `width` bits, as an unsigned
// BigInt. Accepts anything from the most negative signed value to the
// largest unsigned one (so 255 and -1 are both 8-bit 0xff).
export function toBits(value, width) {
  const size = 1n << BigInt(width);
  if (value < -(size >> 1n) || value >= size) {
    throw new Error(`That doesn't fit in ${width} bits.`);
  }
  return value < 0n ? value + size : value;
}

// The signed value of `width` bits.
export function fromBits(bits, width) {
  const size = 1n << BigInt(width);
  return bits >= size >> 1n ? bits - size : bits;
}

// Writes `value` in `base`. With a `width`, negative numbers are shown as
// their two's complement and 2, 8 and 16 are padded to the full width.
export function formatNumber(value, base, { width = null, upper = false, group = false, prefix = false } = {}) {
  let negative = value < 0n;
  let digits;
  if (width) {
    const bits = toBits(value, width);
    negative = false;
    digits = bits.toString(base);
    const fullLength = { 2: width, 8: Math.ceil(width / 3), 16: width / 4 }[base];
    if (fullLength) {
      digits = digits.padStart(fullLength, "0");
    }
  } else {
    digits = (negative ? -value : value).toString(base);
  }
  if (upper) {
    digits = digits.toUpperCase();
  }
  if (group) {
    digits = groupDigits(digits, GROUP_SIZES[base] ?? 4);
  }
  return (negative ? "-" : "") + (prefix && PREFIXES[base] ? PREFIXES[base] : "") + digits;
}

// "11111111" -> "1111 1111", grouped from the right.
function groupDigits(digits, size) {
  const groups = [];
  for (let end = digits.length; end > 0; end -= size) {
    groups.unshift(digits.slice(Math.max(0, end - size), end));
  }
  return groups.join(" ");
}

// The fewest bits that hold `value`: unsigned for 0 and up, two's
// complement for negatives.
export function bitLength(value) {
  if (value < 0n) {
    return (-value - 1n).toString(2).replace(/^0$/, "").length + 1;
  }
  return value === 0n ? 1 : value.toString(2).length;
}
