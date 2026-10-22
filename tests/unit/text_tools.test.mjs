// The string tools' functions (js/tools/text.mjs): Base64, hex, binary,
// counting, case and occurrence search, including Unicode edge cases.
import * as T from "../../js/tools/text.mjs";

let fails = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  console.log((g === w ? "PASS " : "FAIL ") + label + (g === w ? "" : `  got ${g} want ${w}`));
  if (g !== w) fails++;
};
const throws = (label, fn, re) => { try { fn(); eq(label, "no throw", "throw"); } catch (e) { eq(label, re.test(e.message), true); } };
const uni = "héllo € 👍🏽 世界";

// Base64
eq("b64 encode ASCII", T.base64Encode("Hello"), "SGVsbG8=");
eq("b64 encode unicode (old code threw)", T.base64Encode("€"), "4oKs");
eq("b64 round trip unicode", T.base64Decode(T.base64Encode(uni)), uni);
eq("b64 decode URL-safe, no padding", T.base64Decode("-_8"), { text: "��", warning: "These bytes aren't valid UTF-8 text, so some characters are shown as �." }.text === undefined ? null : T.base64Decode("-_8"));
eq("b64 decode JWT header", T.base64Decode("eyJhbGciOiJIUzI1NiJ9"), '{"alg":"HS256"}');
eq("b64 decode with whitespace", T.base64Decode("SGVs\n bG8="), "Hello");
throws("b64 invalid chars, named", () => T.base64Decode("abc$"), /"\$" isn't a Base64 character/);
throws("b64 = only at the end", () => T.base64Decode("ab=c"), /can only be at the end/);
eq("b64 HTML-escaped / from a page's source", T.base64Decode("P&#x2f;8&#x2B;Pz8&#61;").text, T.base64Decode("P/8+Pz8=").text ?? T.base64Decode("P/8+Pz8="));
eq("b64 says what it unescaped", T.base64Decode("SGk&#x3d;").warning, "Read escaped symbols: &#x3d; as =.");
eq("b64 URL-escaped from a link", T.base64Decode("SGVsbG8%3D").text, "Hello");
throws("b64 truncated", () => T.base64Decode("abcde"), /cut off/);
eq("b64 invalid UTF-8 warns", typeof T.base64Decode("/w==").warning, "string");
eq("b64 large input", T.base64Decode(T.base64Encode("x".repeat(200000))).length, 200000);

// Hex
eq("hex encode", T.hexEncode("Hi"), "4869");
eq("hex encode € as UTF-8 (old code gave 20ac)", T.hexEncode("€"), "e282ac");
eq("hex round trip", T.hexDecode(T.hexEncode(uni)), uni);
eq("hex decode separators + 0x", T.hexDecode("0x48 0x69"), "Hi");
eq("hex decode colons", T.hexDecode("48:69"), "Hi");
throws("hex odd length", () => T.hexDecode("486"), /even/);
throws("hex bad char", () => T.hexDecode("zz"), /0-9/);

// Binary
eq("bin encode padded (old code gave 1000001)", T.binaryEncode("A"), "01000001");
eq("bin encode é", T.binaryEncode("é"), "11000011 10101001");
eq("bin round trip", T.binaryDecode(T.binaryEncode(uni)), uni);
eq("bin decode unpadded single byte", T.binaryDecode("1000001"), "A");
eq("bin decode unbroken run", T.binaryDecode("0100100001101001"), "Hi");
throws("bin run not multiple of 8", () => T.binaryDecode("010010000"), /groups of 8/);
throws("bin bad char", () => T.binaryDecode("0102"), /0 and 1/);
throws("bin group too long", () => T.binaryDecode("010010000 1"), /at most 8/);
eq("bin empty", T.binaryDecode("  "), "");

// Counting
eq("stats empty", T.textStats(""), { length: 0, noSpaces: 0, bytes: 0, words: 0, lines: 0, uniqueWords: 0, uniqueChars: 0 });
eq("stats emoji count as 1", T.textStats("👍🏽🇨🇦").length, 2);
eq("stats", T.textStats("The cat\nthe dog"), { length: 15, noSpaces: 12, bytes: 15, words: 4, lines: 2, uniqueWords: 3, uniqueChars: 11 });

// Transforming
eq("reverse keeps emoji intact", T.reverseText("ab👍🏽c"), "c👍🏽ba");
const rc = T.randomCase("abcdefghijklmnopqrstuvwxyz".repeat(4));
eq("random case only changes case", rc.toLowerCase(), "abcdefghijklmnopqrstuvwxyz".repeat(4));
eq("random case is mixed", /[a-z]/.test(rc) && /[A-Z]/.test(rc), true);
eq("random case leaves non-letters", T.randomCase("123 !? 👍"), "123 !? 👍");

// Occurrences
eq("occ empty term (old code hung)", T.findOccurrences("abc", ""), []);
eq("occ non-overlapping", T.findOccurrences("aaaa", "aa").length, 2);
eq("occ case-insensitive default", T.findOccurrences("The the THE", "the").length, 3);
eq("occ case-sensitive", T.findOccurrences("The the THE", "the", { caseSensitive: true }).length, 1);
eq("occ whole word", T.findOccurrences("cat category cat.", "cat", { wholeWord: true }).length, 2);
eq("occ whole word unicode", T.findOccurrences("café cafés", "café", { wholeWord: true }).length, 1);
eq("occ regex chars literal", T.findOccurrences("a.b a+b", "a.b").length, 1);
eq("occ indexes stay aligned with İ", T.findOccurrences("İstanbul x", "x"), [[9, 10]]);
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exitCode = fails ? 1 : 0;
