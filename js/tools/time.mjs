// Pure time functions behind the Unix timestamp converter. Parsers throw an
// Error with a user-facing message when the input can't be read.

// Milliseconds in each timestamp unit.
export const UNITS = {
  s: { ms: 1000, name: "seconds" },
  ms: { ms: 1, name: "milliseconds" },
  us: { ms: 1e-3, name: "microseconds" },
  ns: { ms: 1e-6, name: "nanoseconds" },
};

// The furthest a JavaScript date reaches either side of 1970.
const MAX_MS = 8.64e15;

// The unit a timestamp is probably in, from its size: seconds up to about
// the year 5000, then milliseconds, microseconds and nanoseconds.
export function guessUnit(value) {
  const size = Math.abs(value);
  if (size < 1e11) return "s";
  if (size < 1e14) return "ms";
  if (size < 1e17) return "us";
  return "ns";
}

// Whether a date string names its time zone (Z, +02:00, GMT, UTC...).
function hasZone(text) {
  return /(?:z|[+-]\d{2}:?\d{2}|\b(?:gmt|utc|[ecmp][sd]t)\b)$/i.test(text.trim());
}

// Reads a timestamp or a date. Returns null for empty input, or
// { ms, kind: "timestamp", unit, guessed } or { ms, kind: "date", note }.
// `unit` is "auto" or one of UNITS.
export function parseTime(text, unit = "auto") {
  const s = text.trim();
  if (s === "") {
    return null;
  }

  // Spaces, underscores and commas between digits are ignored.
  const digits = s.replace(/[\s_,]/g, "");
  if (/^[-+]?\d+(\.\d+)?$/.test(digits)) {
    const value = Number(digits);
    const guessed = unit === "auto";
    const chosen = guessed ? guessUnit(value) : unit;
    const ms = value * UNITS[chosen].ms;
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) {
      throw new Error("That's too far from 1970 to be a date.");
    }
    return { ms, kind: "timestamp", unit: chosen, guessed };
  }

  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error("That isn't a timestamp or a date this can read. Try 1700000000 or 2026-10-21T14:30:00Z.");
  }
  let note = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    note = "A date alone is read as midnight UTC.";
  } else if (!hasZone(s)) {
    note = "No time zone given, so it's read as your local time.";
  }
  return { ms, kind: "date", note };
}

function pad(n, width = 2) {
  return String(Math.abs(n)).padStart(width, "0");
}

// ISO 8601 in the browser's time zone, with its offset:
// 2026-10-21T16:30:00+02:00.
export function isoLocal(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const year = date.getFullYear();
  const yearText = year >= 0 && year <= 9999 ? pad(year, 4) : (year < 0 ? "-" : "+") + pad(year, 6);
  return (
    `${yearText}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    (date.getMilliseconds() ? `.${pad(date.getMilliseconds(), 3)}` : "") +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

const RELATIVE_STEPS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

// "3 days ago", "in 2 hours", "now"; rounded to the largest whole unit.
export function relativeTime(ms, nowMs, locale) {
  const seconds = (ms - nowMs) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return format.format(Math.trunc(seconds / size), unit);
    }
  }
  return "";
}
