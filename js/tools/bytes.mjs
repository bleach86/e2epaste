// Pure functions behind the byte size converter.

// Every unit, by how many bytes it is. Decimal (SI) units go up in 1000s,
// binary (IEC) ones in 1024s; bits are an eighth of a byte.
export const UNITS = [
  { id: "B", name: "Bytes", bytes: 1, kind: "decimal" },
  { id: "KB", name: "Kilobytes", bytes: 1e3, kind: "decimal" },
  { id: "MB", name: "Megabytes", bytes: 1e6, kind: "decimal" },
  { id: "GB", name: "Gigabytes", bytes: 1e9, kind: "decimal" },
  { id: "TB", name: "Terabytes", bytes: 1e12, kind: "decimal" },
  { id: "PB", name: "Petabytes", bytes: 1e15, kind: "decimal" },
  { id: "KiB", name: "Kibibytes", bytes: 2 ** 10, kind: "binary" },
  { id: "MiB", name: "Mebibytes", bytes: 2 ** 20, kind: "binary" },
  { id: "GiB", name: "Gibibytes", bytes: 2 ** 30, kind: "binary" },
  { id: "TiB", name: "Tebibytes", bytes: 2 ** 40, kind: "binary" },
  { id: "PiB", name: "Pebibytes", bytes: 2 ** 50, kind: "binary" },
  { id: "bit", name: "Bits", bytes: 1 / 8, kind: "bits" },
  { id: "kbit", name: "Kilobits", bytes: 1e3 / 8, kind: "bits" },
  { id: "Mbit", name: "Megabits", bytes: 1e6 / 8, kind: "bits" },
  { id: "Gbit", name: "Gigabits", bytes: 1e9 / 8, kind: "bits" },
];

export function unit(id) {
  return UNITS.find((u) => u.id === id);
}

// Reads an amount: digits with an optional decimal point, and spaces,
// commas or underscores between thousands. Null for empty input.
export function parseAmount(text) {
  const s = text.trim().replace(/[\s,_]/g, "");
  if (s === "") {
    return null;
  }
  if (!/^\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    throw new Error("Enter a size, like 1.5 or 1,000. Sizes can't be negative.");
  }
  const value = Number(s);
  if (!Number.isFinite(value)) {
    throw new Error("That's too big.");
  }
  return value;
}

// `amount` of the unit `from`, in the unit `to`.
export function convert(amount, from, to) {
  return (amount * unit(from).bytes) / unit(to).bytes;
}

// A size for reading: up to 12 significant digits, so binary units show
// their real fractions (1 GB = 0.931322574615 GiB), and exponents only for
// sizes too small or too large to write out.
export function formatAmount(value, locale) {
  if (value === 0) {
    return "0";
  }
  if (Math.abs(value) < 1e-9 || Math.abs(value) >= 1e21) {
    return value.toExponential(6).replace(/\.?0+e/, "e");
  }
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 12 }).format(value);
}
