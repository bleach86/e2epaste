// The timestamp and byte size converters' logic (js/tools/time.mjs,
// js/tools/bytes.mjs). Run with TZ unset: dates with no zone use the local
// one, so those checks compare against Date's own reading.
import * as T from "../../js/tools/time.mjs";
import * as B from "../../js/tools/bytes.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };
const throws = (f, pattern) => { try { f(); return false; } catch (e) { return pattern.test(e.message); } };

// timestamps
ok("empty is null", T.parseTime(" ") === null);
const at = (text, unit) => T.parseTime(text, unit);
ok("units guessed from size", at("1700000000").unit === "s" && at("1700000000000").unit === "ms"
  && at("1700000000000000").unit === "us" && at("1700000000000000000").unit === "ns" && at("1700000000").guessed);
ok("every unit lands on the same moment", ["1700000000", "1700000000000", "1700000000000000", "1700000000000000000"]
  .every((s) => Math.round(at(s).ms) === 1700000000000));
ok("a chosen unit wins", at("1700000000", "ms").ms === 1700000000 && !at("1700000000", "ms").guessed);
ok("negative and fractional", at("-86400").ms === -86400000 && at("1.5").ms === 1500);
ok("separators", at("1,700,000,000").ms === 1700000000000 && at("1_700_000_000").ms === 1700000000000);
ok("too far from 1970", throws(() => at("9".repeat(17), "s"), /too far/));
ok("ISO with a zone, no note", at("2026-10-21T14:30:00Z").ms === Date.UTC(2026, 9, 21, 14, 30) && at("2026-10-21T14:30:00Z").note === ""
  && at("2026-10-21T16:30:00+02:00").ms === Date.UTC(2026, 9, 21, 14, 30));
ok("a date alone is midnight UTC, and says so", at("2026-10-21").ms === Date.UTC(2026, 9, 21) && /midnight UTC/.test(at("2026-10-21").note));
ok("no zone: local time, and says so", at("2026-10-21T14:30").ms === new Date(2026, 9, 21, 14, 30).getTime() && /local time/.test(at("2026-10-21T14:30").note));
ok("email-style dates", at("Wed, 21 Oct 2026 14:30:00 GMT").ms === Date.UTC(2026, 9, 21, 14, 30) && at("Wed, 21 Oct 2026 14:30:00 GMT").note === "");
ok("nonsense", throws(() => at("next tuesday"), /isn't a timestamp or a date/));

const local = T.isoLocal(new Date(Date.UTC(2026, 9, 21, 14, 30, 5)));
ok("ISO in local time is the same moment", Date.parse(local) === Date.UTC(2026, 9, 21, 14, 30, 5) && /[+-]\d{2}:\d{2}$/.test(local), local);
const now = Date.UTC(2026, 9, 21, 12);
ok("relative times", T.relativeTime(now - 3 * 86400000, now, "en") === "3 days ago" && T.relativeTime(now + 2 * 3600000, now, "en") === "in 2 hours"
  && T.relativeTime(now, now, "en") === "now" && T.relativeTime(now - 86400000, now, "en") === "yesterday",
  [T.relativeTime(now - 3 * 86400000, now, "en"), T.relativeTime(now, now, "en")].join());

// byte sizes
ok("amounts", B.parseAmount("1,000.5") === 1000.5 && B.parseAmount(".5") === 0.5 && B.parseAmount("1e3") === 1000 && B.parseAmount("") === null);
ok("no negatives or words", throws(() => B.parseAmount("-1"), /can't be negative/) && throws(() => B.parseAmount("ten"), /Enter a size/));
ok("decimal and binary", B.convert(1, "TB", "GB") === 1000 && B.convert(1, "GiB", "MiB") === 1024 && B.convert(1, "KiB", "B") === 1024);
ok("the 931 GB drive", B.formatAmount(B.convert(1, "TB", "GiB"), "en") === "931.322574615");
ok("bits", B.convert(100, "Mbit", "MB") === 12.5 && B.convert(1, "B", "bit") === 8);
ok("formatting", B.formatAmount(1234567.5, "en") === "1,234,567.5" && B.formatAmount(0, "en") === "0"
  && B.formatAmount(1e-12, "en") === "1e-12" && B.formatAmount(B.convert(1, "B", "PB"), "en") === "1e-15");
ok("every unit is known", B.UNITS.every((u) => B.unit(u.id) === u) && new Set(B.UNITS.map((u) => u.id)).size === B.UNITS.length);
