// Number base conversion (js/tools/numbers.mjs), checked against BigInt's
// own parsing and printing.
import * as N from "../../js/tools/numbers.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };
const throws = (f, pattern) => { try { f(); return false; } catch (e) { return pattern.test(e.message); } };

ok("empty is null", N.parseNumber("  ", 16) === null);
ok("prefixes, any case", N.parseNumber("0XfF", 16) === 255n && N.parseNumber("0b1010", 2) === 10n && N.parseNumber("0o17", 8) === 15n);
ok("separators", N.parseNumber("1,000,000", 10) === 1000000n && N.parseNumber("dead_beef", 16) === 0xdeadbeefn
  && N.parseNumber("1111 0000", 2) === 240n && N.parseNumber("1'000", 10) === 1000n);
ok("signs, including the typographic minus", N.parseNumber("-ff", 16) === -255n && N.parseNumber("+7", 8) === 7n && N.parseNumber("−42", 10) === -42n);
ok("bases up to 36", N.parseNumber("zz", 36) === 1295n && N.parseNumber("Hello", 36) === BigInt(parseInt("hello", 36)));
ok("a digit too big for the base", throws(() => N.parseNumber("12", 2), /"2" isn't a binary digit/) && throws(() => N.parseNumber("8", 8), /octal digit/)
  && throws(() => N.parseNumber("g", 16), /hex digit/) && throws(() => N.parseNumber("z", 20), /base 20 digit/));
ok("only whole numbers", throws(() => N.parseNumber("1.5", 10), /whole numbers/) && throws(() => N.parseNumber("1e3", 10), /whole numbers/));
ok("a prefix alone", throws(() => N.parseNumber("0x", 16), /Enter some digits/));
ok("no more than MAX_DIGITS", throws(() => N.parseNumber("1".repeat(N.MAX_DIGITS + 1), 10), /more than/) && N.parseNumber("1".repeat(N.MAX_DIGITS), 2) > 0n);

const big = 2n ** 200n + 12345n;
let roundTrips = true;
for (let base = 2; base <= 36; base++) {
  for (const v of [0n, 1n, 35n, 255n, big, -big]) {
    if (N.parseNumber(N.formatNumber(v, base), base) !== v || N.formatNumber(v, base) !== (v < 0n ? "-" + (-v).toString(base) : v.toString(base))) roundTrips = false;
  }
}
ok("every base round-trips, at any size", roundTrips);

ok("two's complement", N.formatNumber(-1n, 16, { width: 8 }) === "ff" && N.formatNumber(-1n, 16, { width: 32 }) === "ffffffff"
  && N.formatNumber(-128n, 2, { width: 8 }) === "10000000" && N.formatNumber(5n, 2, { width: 8 }) === "00000101");
ok("width range: signed min to unsigned max", N.toBits(255n, 8) === 255n && N.toBits(-128n, 8) === 128n
  && throws(() => N.toBits(256n, 8), /doesn't fit in 8 bits/) && throws(() => N.toBits(-129n, 8), /8 bits/));
ok("signed value of bits", N.fromBits(255n, 8) === -1n && N.fromBits(127n, 8) === 127n && N.fromBits(2n ** 63n, 64) === -(2n ** 63n));
ok("options", N.formatNumber(48879n, 16, { upper: true, prefix: true }) === "0xBEEF" && N.formatNumber(-10n, 16, { prefix: true }) === "-0xa"
  && N.formatNumber(1234567n, 10, { group: true }) === "1 234 567" && N.formatNumber(255n, 8, { width: 16, group: true }) === "000 377");
ok("bit lengths", [[0n, 1], [1n, 1], [255n, 8], [256n, 9], [-1n, 1], [-128n, 8], [-129n, 9]].every(([v, n]) => N.bitLength(v) === n));
