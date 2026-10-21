// v4 paste format (js/crypto.mjs): Padmé sizes (the same values
// src/padding.rs checks), padding round trips, the password flag in the
// link, and the worst cases fitting the server's limits.
import * as C from "../../js/crypto.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };

const PADME = [[0, 0], [1, 1], [2, 2], [3, 3], [9, 10], [100, 104], [4096, 4096], [4097, 4352], [5000, 5120],
  [300000, 303104], [1000000, 1015808], [26214404, 26738688]];
const wrong = PADME.filter(([n, padded]) => C.padme(n) !== padded);
ok("padme matches src/padding.rs", wrong.length === 0, JSON.stringify(wrong.map(([n]) => [n, C.padme(n)])));

let worst = 0;
for (let n = 2; n < 200000; n += 7) worst = Math.max(worst, C.padme(n) / n);
ok("padme overhead at most 12%", worst <= 1.12, worst);

// Every short text is the same size; a little more text only moves to the
// next step.
const sizes = new Set([1, 50, 1000, 4000].map((n) => C.paddedLength(n, C.PART_PADDING.text)));
ok("short texts all pad to 4 KiB", sizes.size === 1 && sizes.has(4096), [...sizes]);
ok("title is a fixed size", C.paddedLength(0, C.PART_PADDING.title) === 512 && C.paddedLength(400, C.PART_PADDING.title) === 512);

for (const data of [new Uint8Array(0), new Uint8Array([1, 2, 3]), crypto.getRandomValues(new Uint8Array(9000))]) {
  const padded = C.padPart(data, C.PART_PADDING.text);
  const back = C.unpadPart(padded);
  ok(`pad/unpad round trip (${data.length} bytes)`, back.length === data.length && back.every((b, i) => b === data[i]));
}
let threw = false;
try { C.unpadPart(new Uint8Array([0, 0, 1, 0, 9])); } catch { threw = true; }
ok("a length past the end is refused", threw);

// Worst cases against the server's limits (src/incoming.rs, config.rs).
const b64 = (bytes) => Math.ceil(bytes / 3) * 4;
const text = b64(C.paddedLength(1048576 + 400, C.PART_PADDING.text) + 16);
ok("1 MiB of incompressible text fits MAX_CONTENT_CHARS", text <= 1450000, text);
const file = C.encryptedFileLength(26214400);
ok("a 25 MiB file stores in under 26 MiB", file <= 26 * 1048576, file);
// 64 code points that all need JSON escapes, the longest language name.
const details = C.encodeDetails("\u0001".repeat(64), "php-template");
ok("the longest title and language fit the title part", C.paddedLength(details.length + 11, C.PART_PADDING.title) === 512, details.length);
ok("title part fits MAX_TITLE_CHARS", b64(512 + 16) <= 1024);
ok("details round trip", JSON.stringify(C.decodeDetails(C.encodeDetails("Hi 🎉", "rust"))) === '{"title":"Hi 🎉","syntax":"rust"}');

// The password flag in the link's spare bits.
const plain = Array.from({ length: 500 }, () => C.generateLinkSecret());
const flagged = Array.from({ length: 500 }, () => C.generateLinkSecret({ password: true }));
ok("links stay 22 base64url characters", [...plain, ...flagged].every((s) => /^[A-Za-z0-9_-]{22}$/.test(s)));
ok("flag read back", plain.every((s) => !C.linkHasPassword(s)) && flagged.every((s) => C.linkHasPassword(s)));
ok("a cut-off link never reads as having a password", flagged.every((s) => !C.linkHasPassword(s.slice(0, -4)) && !C.linkHasPassword(s + "A")));
// v3 links never had a spare bit set.
ok("v3-style links read as no password", plain.every((s) => "AQgw".includes(s.at(-1))));

// The flag doesn't change the key: the same secret with and without it
// decrypts the same paste.
const salt = crypto.getRandomValues(new Uint8Array(12));
const secret = plain[0];
const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const withFlag = secret.slice(0, -1) + last[last.indexOf(secret.at(-1)) | 1];
const a = await C.deriveV3Secrets(secret, salt);
const b = await C.deriveV3Secrets(withFlag, salt);
ok("flag isn't part of the key or proof", a.accessProof === b.accessProof);

// A whole v4 paste round trip, as create.mjs and paste.mjs do it.
const pw = await C.deriveV3Secrets(flagged[0], salt, "hunter2");
const enc = new TextEncoder();
const parts = {
  text: await C.encryptPart(pw.key, salt, "text", enc.encode("v4 text ✓")),
  title: await C.encryptPart(pw.key, salt, "title", C.encodeDetails("My title", "rust")),
  "file-name": await C.encryptPart(pw.key, salt, "file-name", enc.encode("a.bin")),
};
ok("encrypted sizes are padded sizes plus the tag",
  parts.text.length === 4096 + 16 && parts.title.length === 512 + 16 && parts["file-name"].length === 1024 + 16,
  Object.values(parts).map((p) => p.length));
const viewer = await C.getPasteSecrets({ version: 4, iv: Array.from(salt) }, flagged[0], C.linkHasPassword(flagged[0]), "hunter2");
const dec = new TextDecoder();
ok("v4 text decrypts", dec.decode(await C.decryptPart(viewer, "text", parts.text.buffer)) === "v4 text ✓");
ok("v4 details decrypt", JSON.stringify(C.decodeDetails(await C.decryptPart(viewer, "title", parts.title.buffer))) === '{"title":"My title","syntax":"rust"}');
ok("v4 file name decrypts", dec.decode(await C.decryptPart(viewer, "file-name", parts["file-name"].buffer)) === "a.bin");
let rejected = false;
try { await C.decryptPart(await C.getPasteSecrets({ version: 4, iv: Array.from(salt) }, flagged[0], true, "wrong"), "text", parts.text.buffer); } catch { rejected = true; }
ok("v4 wrong password rejected", rejected);
