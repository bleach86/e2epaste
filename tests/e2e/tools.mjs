// The tool pages: every tool's behaviour, the hubs and the 404 for unknown tools.
import { BASE, check, finish, launch, watch } from "./lib.mjs";

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
for (const path of ["/tools/password", "/tools/strings", "/tools/numbers"]) {
  const p = await open(path);
  const cards = await p.$$eval(".tool-card", (els) => els.map((e) => e.getAttribute("href")));
  check(`${path}: 200, lists all 10 tools (not the variants)`, p.status === 200 && cards.length === 10
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
check("base64: related tools exclude itself", related.length === 9 && !related.includes("/tools/base64"));
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

p = await open("/tools/nope");
check("unknown tool: 404", p.status === 404, p.status);
await browser.close();
finish();
