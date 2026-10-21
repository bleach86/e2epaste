// The tool pages: every tool's behaviour, the hubs and the 404 for unknown tools.
import { createHash, createHmac, createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, check, drag, finish, launch, watch } from "./lib.mjs";

const bigBytes = Buffer.from(Array.from({ length: 10 * 1024 * 1024 + 5 }, (_, i) => (i * 31) % 256));
const bigFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-")), "big.bin");
fs.writeFileSync(bigFile, bigBytes);

const browser = await launch();
await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);

async function open(path) {
  const p = await browser.newPage();
  p.errors = [];
  await watch(p, p.errors);
  p.on("console", (m) => m.type() === "error" && p.errors.push(m.text()));
  p.on("requestfailed", (r) => p.errors.push("request failed " + r.url()));
  const res = await p.goto(BASE + path, { waitUntil: "networkidle0" });
  p.status = res.status();
  return p;
}
const setValue = (p, sel, v) => p.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, v);
const val = (p, sel) => p.$eval(sel, (el) => el.value ?? el.textContent);
const txt = (p, sel) => p.$eval(sel, (el) => el.textContent);

// hubs
for (const path of ["/tools/password", "/tools/strings", "/tools/numbers", "/tools/security"]) {
  const p = await open(path);
  const cards = await p.$$eval(".tool-card", (els) => els.map((e) => e.getAttribute("href")));
  check(`${path}: 200, lists all 15 tools (not the variants)`, p.status === 200 && cards.length === 15
    && !cards.includes("/tools/hex-to-decimal"), `${p.status} ${cards.length}`);
  check(`${path}: own group first`, (await p.$eval("section h2 a", (a) => a.getAttribute("href"))) === path);
  check(`${path}: no JS errors`, p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}

// base64
let p = await open("/tools/base64");
await setValue(p, "#encode-in", "héllo 👍");
check("base64: live encode unicode", (await val(p, "#encode-out")) === "aMOpbGxvIPCfkY0=", await val(p, "#encode-out"));
await setValue(p, "#decode-in", "abc$");
check("base64: decode error shown", /valid Base64/.test(await txt(p, "#decode-error")));
await setValue(p, "#decode-in", "aMOpbGxvIPCfkY0");
check("base64: decode clears error", (await val(p, "#decode-out")) === "héllo 👍" && (await txt(p, "#decode-error")) === "");
await p.$eval('[data-copy="encode-out"]', (b) => b.click());
check("base64: copy", (await p.evaluate(() => navigator.clipboard.readText())) === "aMOpbGxvIPCfkY0=");
await p.$eval('[data-clear="encode-in"]', (b) => b.click());
check("base64: clear empties input and output", (await val(p, "#encode-in")) === "" && (await val(p, "#encode-out")) === "");
const related = await p.$$eval(".tool-card", (els) => els.map((e) => e.getAttribute("href")));
check("base64: related tools exclude itself", related.length === 14 && !related.includes("/tools/base64"));
const crumbs = await p.$$eval(".breadcrumb-item", (els) => els.map((e) => e.textContent.trim()));
check("base64: breadcrumb", crumbs.join(" > ") === "Home > String Tools > Base64 Encoder & Decoder", crumbs.join(" > "));
check("base64: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// hex / binary
for (const [slug, enc, dec] of [["hex", "e282ac", "0xe2 0x82 0xac"], ["binary", "11100010 10000010 10101100", "111000101000001010101100"]]) {
  p = await open(`/tools/${slug}`);
  await setValue(p, "#encode-in", "€");
  check(`${slug}: encode €`, (await val(p, "#encode-out")) === enc, await val(p, "#encode-out"));
  await setValue(p, "#decode-in", dec);
  check(`${slug}: decode`, (await val(p, "#decode-out")) === "€", await val(p, "#decode-out"));
  check(`${slug}: no JS errors`, p.errors.length === 0, p.errors.join(" | "));
}

// character counter
p = await open("/tools/character-counter");
await setValue(p, "#counter-in", "Hi 👍🏽\nhi");
check("counter: stats", [await txt(p, "#stat-length"), await txt(p, "#stat-bytes"), await txt(p, "#stat-words"), await txt(p, "#stat-lines"), await txt(p, "#stat-uwords")].join(",") === "7,14,3,2,2",
  [await txt(p, "#stat-length"), await txt(p, "#stat-bytes"), await txt(p, "#stat-words"), await txt(p, "#stat-lines"), await txt(p, "#stat-uwords")].join(","));
await p.$eval('[data-clear="counter-in"]', (b) => b.click());
check("counter: clear resets", (await txt(p, "#stat-length")) === "0");
check("counter: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// reverse / random case
p = await open("/tools/reverse-text");
await setValue(p, "#reverse-in", "ab👍🏽c");
check("reverse: live", (await val(p, "#reverse-out")) === "c👍🏽ba");
p = await open("/tools/random-case");
await setValue(p, "#random-in", "abcdefghijklmnopqrstuvwxyz");
const r1 = await val(p, "#random-out");
let changed = false;
for (let i = 0; i < 5 && !changed; i++) { await p.click("#rerandomize"); changed = (await val(p, "#random-out")) !== r1; }
check("random case: randomize again changes output", changed && r1.toLowerCase() === "abcdefghijklmnopqrstuvwxyz");
check("reverse/random: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// count occurrences
p = await open("/tools/count-occurrences");
await setValue(p, "#occ-text", "The cat <b>sat</b> on the category cat.");
await setValue(p, "#occ-term", "cat");
check("occ: count", (await txt(p, "#occ-count")) === "3");
await p.click("#occ-whole");
check("occ: whole word", (await txt(p, "#occ-count")) === "2");
check("occ: highlights + markup shown as text", (await p.$$eval("#occ-preview mark", (m) => m.length)) === 2 && (await txt(p, "#occ-preview")).includes("<b>sat</b>") && (await p.$$eval("#occ-preview b", (b) => b.length)) === 0);
await setValue(p, "#occ-term", "");
check("occ: empty term doesn't hang", (await txt(p, "#occ-count")) === "0");
check("occ: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// password generator
p = await open("/tools/password-generator");
const pw = await val(p, "#password");
check("gen: 16-char default", pw.length === 16, pw);
check("gen: entropy shown", /About 103 bits/.test(await txt(p, "#password-entropy")), await txt(p, "#password-entropy"));
await p.click("#use-special");
const pw2 = await val(p, "#password");
check("gen: no symbols when unticked", /^[A-Za-z0-9]{16}$/.test(pw2) && /About 95 bits/.test(await txt(p, "#password-entropy")));
await p.$eval("#password-len", (el) => { el.value = "40"; el.dispatchEvent(new Event("input")); });
check("gen: length slider", (await val(p, "#password")).length === 40 && (await txt(p, "#pass-len-display")) === "40");
await p.click("#password-gen");
await p.$eval('[data-copy="password"]', (b) => b.click());
check("gen: copy", (await p.evaluate(() => navigator.clipboard.readText())) === (await val(p, "#password")));
check("gen: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// password strength
p = await open("/tools/password-strength");
await p.waitForFunction(() => document.getElementById("strength-loading").hidden, { timeout: 15000 });
check("strength: checker loaded (chunk from /public/js/dist/chunks/)", true);
for (const [pwd, label] of [["Password1!", "Weak"], ["aaaaaaaaaaaA1!", "Weak"], ["correct horse battery staple", "Very strong"]]) {
  await setValue(p, "#strength-in", pwd);
  check(`strength: ${pwd} -> ${label}`, (await txt(p, "#strength-label")) === label, await txt(p, "#strength-label"));
}
await setValue(p, "#strength-in", "Password1!");
check("strength: warning + suggestions + crack times", !(await p.$eval("#strength-warning", (e) => e.hidden)) && (await p.$$eval("#strength-suggestions li", (l) => l.length)) > 0 && (await txt(p, "#crack-offline-fast")).length > 0);
check("strength: input is masked", (await p.$eval("#strength-in", (e) => e.type)) === "password");
await p.click("#strength-show");
check("strength: show toggle", (await p.$eval("#strength-in", (e) => e.type)) === "text");
await p.$eval('[data-clear="strength-in"]', (b) => b.click());
check("strength: clear hides result", await p.$eval("#strength-result", (e) => e.hidden));
check("strength: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// number base converter
p = await open("/tools/number-base");
const nums = () => p.evaluate(() => Object.fromEntries(["dec", "hex", "bin", "oct", "custom"]
  .map((k) => [k, document.getElementById(`num-${k}`).value])));
const order = () => p.$$eval("#base-converter .num-field", (els) => els.map((e) => e.id));
check("base: starts in decimal, then hex", (await p.evaluate(() => document.activeElement.id)) === "num-dec"
  && (await order()).join() === "num-dec,num-hex,num-bin,num-oct,num-custom", (await order()).join());
await setValue(p, "#num-dec", "255");
check("base: decimal fills the rest", JSON.stringify(await nums()) === JSON.stringify({ dec: "255", hex: "ff", bin: "11111111", oct: "377", custom: "73" }), JSON.stringify(await nums()));
check("base: says how many bits", (await txt(p, "#num-info")) === "Needs 8 bits (1 byte)", await txt(p, "#num-info"));
await setValue(p, "#num-hex", "0xDEAD_BEEF");
check("base: hex with prefix and separators", (await nums()).dec === "3735928559" && (await nums()).bin === "11011110101011011011111011101111");
await setValue(p, "#num-bin", "10 2");
check("base: a bad digit says which", (await txt(p, "#num-bin-error")) === "\"2\" isn't a binary digit (0 or 1)." && (await nums()).dec === "", await txt(p, "#num-bin-error"));
const big = "123456789012345678901234567890123456789";
await setValue(p, "#num-dec", big);
check("base: numbers of any size", BigInt("0x" + (await nums()).hex) === BigInt(big));
await setValue(p, "#num-dec", "-1");
check("base: negatives with a minus sign", (await nums()).hex === "-1" && (await txt(p, "#num-info")).endsWith("as two's complement"));
await p.select("#bit-width", "8");
check("base: 8-bit two's complement", JSON.stringify(await nums()) === JSON.stringify({ dec: "-1", hex: "ff", bin: "11111111", oct: "377", custom: "73" })
  && (await txt(p, "#num-info")) === "As 8 bits: signed -1, unsigned 255", JSON.stringify(await nums()) + " " + await txt(p, "#num-info"));
await setValue(p, "#num-hex", "80");
check("base: decimal shows the signed value", (await nums()).dec === "-128");
await setValue(p, "#num-hex", "1ff");
check("base: too big for the width", /doesn't fit in 8 bits/.test(await txt(p, "#num-hex-error")));
await p.select("#bit-width", "16");
await p.click("#opt-upper");
await p.click("#opt-group");
await p.click("#opt-prefix");
check("base: uppercase, grouped, prefixed and padded", JSON.stringify(await nums()) === JSON.stringify({ dec: "511", hex: "1ff", bin: "0b0000 0001 1111 1111", oct: "0o000 777", custom: "E7" }),
  JSON.stringify(await nums()));
await p.select("#custom-base", "3");
check("base: picking another base rewrites that field", (await nums()).custom === "20 0221", (await nums()).custom);
await p.click("#num-clear");
check("base: clear empties everything", Object.values(await nums()).every((v) => v === "") && (await txt(p, "#num-info")) === "");
await setValue(p, "#num-dec", "42");
await p.$eval('[data-copy="num-bin"]', (b) => b.click());
check("base: copy a field", (await p.evaluate(() => navigator.clipboard.readText())) === "0b0000 0000 0010 1010");
check("base: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// a variant page: the same tool, its own title, heading and starting field
p = await open("/tools/hex-to-decimal");
check("hex-to-decimal: own title and heading", p.status === 200 && (await p.title()).startsWith("Hex to Decimal Converter")
  && (await txt(p, "h1")) === "Hex to Decimal Converter", await p.title());
check("hex-to-decimal: canonical is itself", (await p.$eval('link[rel="canonical"]', (l) => l.href)).endsWith("/tools/hex-to-decimal"));
check("hex-to-decimal: hex first and focused, decimal second", (await order()).slice(0, 2).join() === "num-hex,num-dec"
  && (await p.evaluate(() => document.activeElement.id)) === "num-hex");
await p.keyboard.type("ff");
check("hex-to-decimal: typing converts", (await nums()).dec === "255");
const links = await p.$$eval(".num-links a", (els) => els.map((a) => a.getAttribute("href")));
check("hex-to-decimal: links to the other conversions, not itself", links.includes("/tools/number-base") && links.includes("/tools/decimal-to-hex")
  && !links.includes("/tools/hex-to-decimal") && links.length === 8, links.join());
const crumbs2 = await p.$$eval(".breadcrumb-item", (els) => els.map((e) => e.textContent.trim()));
check("hex-to-decimal: breadcrumb", crumbs2.join(" > ") === "Home > Number Tools > Hex to Decimal Converter", crumbs2.join(" > "));
check("hex-to-decimal: no JS errors", p.errors.length === 0, p.errors.join(" | "));

const sitemap = await (await fetch(BASE + "/sitemap.xml")).text();
check("sitemap: has the numbers hub, the tool and its variants", ["/tools/numbers<", "/tools/number-base<", "/tools/hex-to-decimal<", "/tools/decimal-to-octal<"]
  .every((s) => sitemap.includes(s)));

// unix timestamp, in a fixed time zone
p = await browser.newPage();
p.errors = [];
await watch(p, p.errors);
await p.emulateTimezone("America/New_York");
await p.goto(BASE + "/tools/unix-timestamp", { waitUntil: "networkidle0" });
const ts = () => p.evaluate(() => Object.fromEntries(["s", "ms", "iso", "local-iso", "local", "http", "rel"]
  .map((k) => [k, document.getElementById(`out-${k}`).value])));
const nowS = Number(await val(p, "#now-s"));
check("timestamp: shows the current time", Math.abs(nowS - Date.now() / 1000) < 5 && (await val(p, "#now-ms")).startsWith(String(nowS).slice(0, 8)));
check("timestamp: names the time zone", (await txt(p, "#tz-name")) === "America/New_York");
await setValue(p, "#ts-in", "1700000000");
let r = await ts();
check("timestamp: seconds to dates", r.ms === "1700000000000" && r.iso === "2023-11-14T22:13:20.000Z" && r["local-iso"] === "2023-11-14T17:13:20-05:00"
  && r.http === "Tue, 14 Nov 2023 22:13:20 GMT" && /ago$/.test(r.rel) && (await txt(p, "#ts-note")) === "Read as seconds.", JSON.stringify(r));
await setValue(p, "#ts-in", "1700000000000");
check("timestamp: milliseconds guessed", (await ts()).s === "1700000000" && (await txt(p, "#ts-note")) === "Read as milliseconds.");
await setValue(p, "#ts-in", "1700000000");
await p.select("#ts-unit", "ms");
check("timestamp: a chosen unit", (await ts()).iso === "1970-01-20T16:13:20.000Z" && (await txt(p, "#ts-note")) === "", (await ts()).iso);
await setValue(p, "#ts-in", "99999999999999999");
await p.select("#ts-unit", "s");
check("timestamp: too far from 1970", (await txt(p, "#ts-error")).includes("too far") && (await ts()).s === "");
await p.select("#ts-unit", "auto");
await setValue(p, "#ts-in", "2026-10-21T14:30");
r = await ts();
check("timestamp: a date with no zone is local time", r.s === "1792607400" && r["local-iso"] === "2026-10-21T14:30:00-04:00"
  && /local time/.test(await txt(p, "#ts-note")), JSON.stringify(r));
await setValue(p, "#ts-in", "soon");
check("timestamp: can't read it, says so", /isn't a timestamp or a date/.test(await txt(p, "#ts-error")) && (await ts()).iso === "");
await p.$eval("#ts-pick", (e) => { e.value = "2038-01-18T22:14:07"; e.dispatchEvent(new Event("change")); });
check("timestamp: the date picker, in local time", (await ts()).s === "2147483647", (await ts()).s);
await p.click("#ts-now");
check("timestamp: Now", Math.abs(Number((await ts()).s) - Date.now() / 1000) < 5 && (await ts()).rel === "now");
await p.$eval('[data-copy="out-iso"]', (b) => b.click());
check("timestamp: copy", (await p.evaluate(() => navigator.clipboard.readText())) === (await ts()).iso);
await p.click("#ts-clear");
check("timestamp: clear", (await val(p, "#ts-in")) === "" && Object.values(await ts()).every((v) => v === ""));
check("timestamp: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// byte sizes
p = await open("/tools/byte-size");
const sizes = () => p.$$eval(".bytes-row", (rows) => Object.fromEntries(rows.map((r) => [r.dataset.unit, r.querySelector("input").value])));
check("bytes: starts with an example, 1 GB in GiB", (await val(p, "#bytes-in")) === "1" && (await val(p, "#bytes-unit")) === "GB"
  && (await txt(p, "#bytes-headline")) === "1 GB = 0.931322574615 GiB" && (await p.$eval(".is-target", (e) => e.dataset.unit)) === "GiB", await txt(p, "#bytes-headline"));
await setValue(p, "#bytes-in", "1");
await p.select("#bytes-unit", "TB");
let s = await sizes();
check("bytes: every unit at once", s.B === "1,000,000,000,000" && s.GB === "1,000" && s.GiB === "931.322574615" && s.TiB === "0.909494701773" && s.Gbit === "8,000", JSON.stringify(s));
await setValue(p, "#bytes-in", "-5");
check("bytes: bad input says why", /can't be negative/.test(await txt(p, "#bytes-error")) && (await sizes()).B === "" && (await txt(p, "#bytes-headline")) === "");
check("bytes: no JS errors", p.errors.length === 0, p.errors.join(" | "));
p = await open("/tools/mb-to-gb");
check("mb-to-gb: own heading, starts at 1 MB in GB", (await txt(p, "h1")) === "MB to GB Converter" && (await txt(p, "#bytes-headline")) === "1 MB = 0.001 GB"
  && (await p.$eval(".is-target", (e) => e.dataset.unit)) === "GB", await txt(p, "#bytes-headline"));
await setValue(p, "#bytes-in", "1536");
check("mb-to-gb: typing converts", (await txt(p, "#bytes-headline")) === "1,536 MB = 1.536 GB");
const byteLinks = await p.$$eval(".num-links a", (els) => els.map((a) => a.getAttribute("href")));
check("mb-to-gb: links to the tool and the other byte pages only", byteLinks[0] === "/tools/byte-size" && byteLinks.includes("/tools/gb-to-gib")
  && !byteLinks.includes("/tools/mb-to-gb") && !byteLinks.includes("/tools/hex-to-decimal") && byteLinks.length === 6, byteLinks.join());
check("mb-to-gb: no JS errors", p.errors.length === 0, p.errors.join(" | "));

// JWT decoder
{
  const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const nowS = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "ada", iat: nowS - 60, exp: nowS + 7200 })}`;
  const hsToken = `${body}.${createHmac("sha256", "s3cret").update(body).digest("base64url")}`;
  p = await open("/tools/jwt-decoder");
  await setValue(p, "#jwt-in", `Bearer ${hsToken}`);
  const chips = () => p.$$eval("#jwt-summary .chip", (els) => els.map((e) => e.textContent));
  check("jwt: decodes, says how it's signed and when it expires", !(await p.$eval("#jwt-decoded", (e) => e.hidden))
    && JSON.parse(await val(p, "#jwt-payload")).sub === "ada" && JSON.stringify(await chips()) === JSON.stringify(["Algorithm: HS256", "Expires in 2 hours"]),
    JSON.stringify(await chips()));
  check("jwt: claims as dates", /Expires \(exp\)/.test(await txt(p, "#jwt-claims")) && /1 minute ago/.test(await txt(p, "#jwt-claims")), await txt(p, "#jwt-claims"));
  check("jwt: asks for the secret, not a public key", !(await p.$eval("#jwt-secret-box", (e) => e.hidden)) && await p.$eval("#jwt-public-box", (e) => e.hidden));
  await setValue(p, "#jwt-secret", "s3cret");
  await p.waitForFunction(() => document.getElementById("jwt-verify-result").textContent !== "");
  check("jwt: the right secret verifies", (await txt(p, "#jwt-verify-result")).startsWith("✓ Signature verified"));
  await setValue(p, "#jwt-secret", "wrong");
  await p.waitForFunction(() => document.getElementById("jwt-verify-result").textContent.startsWith("✗"));
  check("jwt: the wrong one doesn't", true);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsBody = `${b64url({ alg: "RS256", kid: "a" })}.${b64url({ sub: "bob", exp: nowS - 86400 * 3 })}`;
  const rsToken = `${rsBody}.${createSign("RSA-SHA256").update(rsBody).sign(privateKey).toString("base64url")}`;
  await setValue(p, "#jwt-in", rsToken);
  check("jwt: an expired token says so", (await chips()).includes("Expired 3 days ago"), JSON.stringify(await chips()));
  await setValue(p, "#jwt-public", publicKey.export({ type: "spki", format: "pem" }));
  await p.waitForFunction(() => document.getElementById("jwt-verify-result").textContent !== "");
  check("jwt: RS256 verifies with a PEM public key", (await txt(p, "#jwt-verify-result")).startsWith("✓"), await txt(p, "#jwt-verify-result"));
  await setValue(p, "#jwt-in", "a.b.c.d.e");
  check("jwt: an encrypted token is explained", /encrypted token/.test(await txt(p, "#jwt-error")) && await p.$eval("#jwt-decoded", (e) => e.hidden));
  check("jwt: no JS errors", p.errors.length === 0, p.errors.join(" | "));
}

// hash generator
{
  p = await open("/tools/hash-generator");
  const rows = () => p.$$eval("#hash-results [data-algorithm]", (els) => Object.fromEntries(els.map((r) => [r.querySelector("label").textContent, r.querySelector("input").value])));
  check("hash: nothing for empty text", Object.keys(await rows()).length === 0);
  await setValue(p, "#hash-text", "abc");
  let r = await rows();
  check("hash: the usual four, live", JSON.stringify(Object.keys(r)) === JSON.stringify(["MD5", "SHA-1", "SHA-256", "SHA-512"])
    && r["SHA-256"] === createHash("sha256").update("abc").digest("hex") && r.MD5 === createHash("md5").update("abc").digest("hex"), JSON.stringify(r));
  await p.click("#algo-blake3");
  await p.select("#hash-format", "HEX");
  r = await rows();
  check("hash: more algorithms, upper case", r.BLAKE3 === "6437B3AC38465133FFB63B75273A8DB548C558465D79DB03FD359C6CD5BD9D85" && r.MD5 === r.MD5.toUpperCase(), r.BLAKE3);
  await setValue(p, "#hash-compare", createHash("sha1").update("abc").digest("hex"));
  check("hash: compare finds the match", (await txt(p, "#hash-compare-result")) === "✓ Matches the SHA-1." && (await p.$eval(".is-match", (e) => e.dataset.algorithm)) === "sha1");
  await setValue(p, "#hash-key", "key");
  r = await rows();
  check("hash: HMAC with a key, BLAKE3 sits out", r["HMAC-SHA-256"] === createHmac("sha256", "key").update("abc").digest("hex").toUpperCase() && !("BLAKE3" in r)
    && /No match/.test(await txt(p, "#hash-compare-result")), JSON.stringify(Object.keys(r)));
  await setValue(p, "#hash-key", "");
  await setValue(p, "#hash-compare", "");
  await p.click('label[for="mode-file"]');
  await (await p.$("#hash-file")).uploadFile(bigFile);
  await p.waitForFunction(() => document.getElementById("hash-progress").hidden && document.querySelector("#hash-results [data-algorithm]"), { timeout: 30000 });
  r = await rows();
  check("hash: a 10 MB file, in pieces", r["SHA-256"] === createHash("sha256").update(bigBytes).digest("hex").toUpperCase()
    && (await txt(p, "#hash-file-name")) === "big.bin", r["SHA-256"]);
  // Every ticked algorithm, as HMACs, each in its own worker.
  const workers = [];
  p.on("workercreated", (w) => workers.push(w.url()));
  await p.select("#hash-format", "hex");
  await setValue(p, "#hash-key", "key");
  await p.waitForFunction(() => document.getElementById("hash-progress").hidden && document.querySelector("#hash-results [data-algorithm]"), { timeout: 30000 });
  r = await rows();
  const hmacs = { md5: "HMAC-MD5", sha1: "HMAC-SHA-1", sha256: "HMAC-SHA-256", sha512: "HMAC-SHA-512" };
  check("hash: a file's HMACs, one worker per algorithm", Object.entries(hmacs).every(([alg, label]) => r[label] === createHmac(alg, "key").update(bigBytes).digest("hex"))
    && !("BLAKE3" in r) && workers.length === 4 && workers.every((u) => /\/public\/js\/dist\/chunks\//.test(u)), JSON.stringify({ r: Object.keys(r), workers }));
  // A new file while the old one is still hashing: only the new one's hashes.
  await setValue(p, "#hash-key", "");
  const second = path.join(path.dirname(bigFile), "small.txt");
  fs.writeFileSync(second, "small");
  await p.evaluate(() => document.getElementById("hash-key").dispatchEvent(new Event("input")));
  await (await p.$("#hash-file")).uploadFile(second);
  await p.waitForFunction(() => document.getElementById("hash-file-name").textContent === "small.txt" && document.getElementById("hash-progress").hidden
    && document.querySelector("#hash-results [data-algorithm]"), { timeout: 30000 });
  r = await rows();
  check("hash: a new file replaces one still hashing", r["SHA-256"] === createHash("sha256").update("small").digest("hex"), r["SHA-256"]);
  check("hash: no JS errors", p.errors.length === 0, p.errors.join(" | "));

  // Firefox brings back the chosen mode on a reload, before the page's script
  // runs; the page must show the box for it.
  p = await browser.newPage();
  p.errors = [];
  await watch(p, p.errors);
  await p.evaluateOnNewDocument(() => {
    new MutationObserver((_, observer) => {
      const file = document.getElementById("mode-file");
      if (file) {
        file.checked = true;
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await p.goto(BASE + "/tools/hash-generator", { waitUntil: "networkidle0" });
  check("hash: a mode kept over a reload shows its box", !(await p.$eval("#hash-file-box", (e) => e.hidden)) && await p.$eval("#hash-text-box", (e) => e.hidden));
  check("hash: no JS errors after the reload", p.errors.length === 0, p.errors.join(" | "));
  await p.close();

  p = await open("/tools/sha256-hash");
  check("sha256-hash: own heading, SHA-256 first", (await txt(p, "h1")) === "SHA-256 Hash Generator"
    && (await p.$eval("#hash-algorithms input", (e) => e.id)) === "algo-sha256");
  await setValue(p, "#hash-text", "abc");
  check("sha256-hash: shown first", (await p.$eval("#hash-results [data-algorithm]", (e) => e.dataset.algorithm)) === "sha256");
  await drag(p, "drop", "#hash-tool", [{ name: "dropped.txt", text: "abc" }]);
  await p.waitForFunction(() => document.getElementById("hash-file-name").textContent === "dropped.txt" && document.querySelector("#hash-results [data-algorithm]"));
  check("sha256-hash: a dropped file switches to file mode", (await p.$eval("#mode-file", (e) => e.checked))
    && (await rows())["SHA-256"] === createHash("sha256").update("abc").digest("hex"));
  check("sha256-hash: no JS errors", p.errors.length === 0, p.errors.join(" | "));
}

// UUIDs and tokens
{
  p = await open("/tools/uuid-generator");
  let lines = (await val(p, "#uuid-out")).split("\n");
  check("uuid: five v4s to start", lines.length === 5 && lines.every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)), lines[0]);
  await p.click('label[for="uuid-v7"]');
  await p.$eval("#uuid-count", (e) => { e.value = "20"; e.dispatchEvent(new Event("change")); });
  lines = (await val(p, "#uuid-out")).split("\n");
  check("uuid: v7s, in order", lines.length === 20 && lines.every((u, i) => /-7/.test(u) && (i === 0 || lines[i - 1] < u)));
  await p.click("#uuid-upper");
  await p.click("#uuid-hyphens");
  await p.click("#uuid-braces");
  check("uuid: formats", /^\{[0-9A-F]{32}\}$/.test((await val(p, "#uuid-out")).split("\n")[0]));
  check("token: 32 random bytes of hex", /^[0-9a-f]{64}$/.test(await val(p, "#token-out")) && (await txt(p, "#token-strength")).startsWith("256 bits"));
  await p.select("#token-format", "alphanumeric");
  await p.$eval("#token-length", (e) => { e.value = "10"; e.dispatchEvent(new Event("change")); });
  check("token: letters and digits, with a warning when short", /^[A-Za-z0-9]{10}$/.test(await val(p, "#token-out")) && (await txt(p, "#token-unit")) === "characters"
    && /128 bits or more is safer/.test(await txt(p, "#token-strength")));
  await setValue(p, "#inspect-in", "017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
  check("uuid: inspect a v7, with its time", /Version\s*7/.test(await txt(p, "#inspect-out")) && /2022/.test(await txt(p, "#inspect-out")), await txt(p, "#inspect-out"));
  await setValue(p, "#inspect-in", "nope");
  check("uuid: inspect says what's wrong", /32 hex digits/.test(await txt(p, "#inspect-error")));
  check("uuid: no JS errors", p.errors.length === 0, p.errors.join(" | "));
}

p = await open("/tools/nope");
check("unknown tool: 404", p.status === 404, p.status);
await browser.close();
finish();
