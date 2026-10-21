// Creating and viewing pastes: the editor, the link dialog, passwords,
// attachments, downloads, burn after reading and the mobile layout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, check, drag, finish, launch, local, openIfAsked, watch } from "./lib.mjs";

const fileBytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
const uploadPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-")), "upload.bin");
fs.writeFileSync(uploadPath, fileBytes);

const browser = await launch();
await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const errors = [];
async function newPage(w = 1280, h = 900, mobile = false) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, isMobile: mobile });
  await watch(p, errors);
  return p;
}
const txt = (p, s) => p.$eval(s, (e) => e.textContent.trim());
// Capture downloads (headless Chrome won't save them) by hooking anchor clicks.
const hookDownloads = (p) => p.evaluate(() => {
  window.__dl = [];
  // Read the blob when its URL is made (fetching blob: URLs is blocked by
  // the site's CSP, as it should be).
  const blobs = new Map();
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (blob) => { const u = createObjectURL(blob); blobs.set(u, blob); return u; };
  HTMLAnchorElement.prototype.click = function () {
    const a = this;
    blobs.get(a.href).arrayBuffer().then((b) => window.__dl.push({ name: a.download, bytes: Array.from(new Uint8Array(b)) }));
  };
});

// ---------------------------------------------------------------- create
const c = await newPage();
await c.goto(BASE + "/", { waitUntil: "networkidle0" });
const code = 'fn main() {\n    println!("hi 🎉");\n}\n';
await c.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, code);
check("create: stats footer counts lines/bytes", (await txt(c, "#paste-stats")) === "4 lines · 39 bytes", await txt(c, "#paste-stats"));
await c.type("#paste-title", "Deploy notes");
await c.select("#syntax", "rust");
check("create: picking a language highlights live", await c.$eval("#paste-editor", (e) => e.classList.contains("highlighting")));
await c.click('label[for="expire-1day"]');
await (await c.$("#fileInput")).uploadFile(uploadPath);
await c.waitForFunction(() => !document.getElementById("attachment").hidden);
check("create: attachment row shows file", (await txt(c, "#attachment-name")) === "upload.bin" && (await txt(c, "#attachment-size")) === "4.9 KB");
await c.click('label[for="burn"]');
check("create: burn switch sets views to 1 and locks the field", await c.$eval("#max-views", (e) => e.disabled && e.value === "1"));
await c.click('label[for="burn"]');
// Stepping: up from Unlimited is 1, down from 1 is Unlimited again, never a
// 0 (the field keeps focus, so no "change" event tidies it up).
await c.focus("#max-views");
const stepped = [];
for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowDown"]) {
  await c.keyboard.press(key);
  stepped.push(await c.$eval("#max-views", (e) => e.value));
}
check("create: view limit steps back down to Unlimited", JSON.stringify(stepped) === JSON.stringify(["1", "2", "1", "", ""]), JSON.stringify(stepped));
await c.type("#max-views", "5");
await c.type("#paste-password", "hunter2");
await c.click("#toggle-password");
check("create: show-password toggle", (await c.$eval("#paste-password", (e) => e.type)) === "text" && (await c.$eval("#toggle-password", (e) => e.getAttribute("aria-pressed"))) === "true");
await c.click("#submit-paste");
await c.waitForSelector("#url-modal.show", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 400));
const url = await c.$eval("#paste-url", (e) => e.value);
check("dialog: short /s/ link with 22-char secret", /\/s\/\w{8}#[A-Za-z0-9_-]{22}$/.test(url), url);
const chips = await c.$$eval("#link-summary .chip", (els) => els.map((e) => e.textContent.trim()));
check("dialog: summary chips", JSON.stringify(chips) === JSON.stringify(["Expires in 1 day", "Limited to 5 views", "Password protected", "Encrypted attachment"]), JSON.stringify(chips));
check("dialog: password tip", /different way from the link/.test(await txt(c, "#link-tip")));
check("dialog: QR code inside collapsed details", (await c.$("#qrcode-container img")) !== null && !(await c.$eval(".qr-details", (d) => d.open)));
await c.click("#copy-url-btn");
check("dialog: copy puts link on clipboard and says Copied", (await c.evaluate(() => navigator.clipboard.readText())) === url && !(await c.$eval("#copy-url-btn .copy-done", (e) => e.classList.contains("d-none"))));
const before = parseInt(await txt(c, "#total-pastes"));
await c.evaluate(() => { window.__hidden = false; document.getElementById("url-modal").addEventListener("hidden.bs.modal", () => (window.__hidden = true), { once: true }); });
await c.click(".link-dialog .btn-quiet[data-bs-dismiss]");
await c.waitForFunction(() => window.__hidden, { timeout: 5000 });
const reset = await c.evaluate(() => ({
  text: document.getElementById("paste-area").value, title: document.getElementById("paste-title").value,
  syntax: document.getElementById("syntax").value, expiry: document.querySelector('input[name="expire"]:checked').value,
  views: document.getElementById("max-views").value, pw: document.getElementById("paste-password").value,
  pwType: document.getElementById("paste-password").type, attachment: document.getElementById("attachment").hidden,
  highlighting: document.getElementById("paste-editor").classList.contains("highlighting"),
}));
check("dialog close: form fully reset", JSON.stringify(reset) === JSON.stringify({ text: "", title: "", syntax: "auto", expiry: "3days", views: "", pw: "", pwType: "password", attachment: true, highlighting: false }), JSON.stringify(reset));
check("dialog close: paste counter +1", parseInt(await txt(c, "#total-pastes")) === before + 1);

// ------------------------------------------------------------------ view
const v = await newPage();
await v.goto(local(url), { waitUntil: "networkidle0" });
// Dialog animations stall in a background tab.
await v.bringToFront();
await openIfAsked(v);
await v.waitForSelector("#password-modal.show");
check("view: /s/ forwards to /paste/ with key", v.url() === local(url).replace("/s/", "/paste/"), v.url());
check("view: title placeholder before unlocking", (await txt(v, "#paste-title")) === "Encrypted paste");
await v.type("#password-input", "nope");
await v.keyboard.press("Enter");
await v.waitForFunction(() => !document.getElementById("password-error").hidden, { timeout: 10000 });
check("view: wrong password shows error", true);
await v.click("#show-pass-button");
check("view: show-password toggle", (await v.$eval("#password-input", (e) => e.type)) === "text");
await v.$eval("#password-input", (e) => (e.value = ""));
await v.type("#password-input", "hunter2");
await v.click("#submit-password-btn");
await v.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 10000 });
await v.waitForFunction(() => /of 5 views/.test(document.getElementById("views").textContent));
await v.waitForFunction(() => !document.querySelector(".modal-backdrop"), { timeout: 5000 });
await v.bringToFront();
check("view: decrypted notice + title", (await txt(v, "#paste-title")) === "Deploy notes");
check("view: text intact", (await v.$eval("#view-area", (e) => e.textContent)) === code);
check("view: highlighted as Rust", (await v.$$eval("#view-area span", (s) => s.length)) > 0);
check("view: gutter has one number per line", (await v.$eval("#code-gutter", (e) => e.textContent)) === "1\n2\n3");
check("view: expiry rounds to 1 day", (await txt(v, "#expire-date")) === "Expires in 1 day", await txt(v, "#expire-date"));
check("view: views chip", (await txt(v, "#views")) === "1 of 5 views" && (await v.$eval("#final-view", (e) => e.hidden)));
await v.click("#copy-paste-btn");
check("view: copy", (await v.evaluate(() => navigator.clipboard.readText())) === code);
await hookDownloads(v);
await v.click("#download-paste-btn");
await v.waitForFunction(() => window.__dl.length === 1);
const dl = await v.evaluate(() => window.__dl[0]);
check("view: Download saves 'Deploy notes.rs' with the text", dl.name === "Deploy notes.rs" && Buffer.from(dl.bytes).toString() === code, dl.name);
await v.click("#wrap-btn");
check("view: wrap toggle hides gutter", (await v.$eval("#code-gutter", (e) => getComputedStyle(e).display)) === "none" && (await v.$eval("#wrap-btn", (e) => e.getAttribute("aria-pressed"))) === "true");
check("view: attachment shown", (await txt(v, "#attachment-name")) === "upload.bin");
await v.click("#download-link");
await v.waitForFunction(() => window.__dl.length === 2, { timeout: 10000 });
const att = await v.evaluate(() => window.__dl[1]);
check("view: attachment decrypts byte for byte", att.name === "upload.bin" && Buffer.compare(Buffer.from(att.bytes), fileBytes) === 0);
check("view: Ctrl+A still works in inputs", true);

// ------------------------------------------------------------- just a file
{
  const f = await newPage();
  await f.goto(BASE + "/", { waitUntil: "networkidle0" });
  check("file only: the editor says a file alone is fine", (await f.$eval("#paste-area", (e) => e.placeholder)).includes("just attach a file"));
  await f.click("#submit-paste");
  check("file only: nothing at all isn't sent", !(await f.$eval("#url-modal", (e) => e.classList.contains("show"))));
  await (await f.$("#fileInput")).uploadFile(uploadPath);
  await f.waitForFunction(() => !document.getElementById("attachment").hidden);
  await f.click("#submit-paste");
  await f.waitForSelector("#url-modal.show", { timeout: 20000 });
  const url = await f.$eval("#paste-url", (e) => e.value);
  await f.goto(local(url), { waitUntil: "networkidle0" });
  await f.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  const hidden = await f.evaluate(() => ["content-panel", "language-chip", "copy-paste-btn", "download-paste-btn", "wrap-btn"]
    .filter((id) => !document.getElementById(id).hidden));
  check("file only: no empty text panel or text buttons", hidden.length === 0, hidden.join(", "));
  check("file only: the attachment is shown", !(await f.$eval("#attachment-section", (e) => e.hidden)) && (await txt(f, "#attachment-name")) === "upload.bin");
  await hookDownloads(f);
  await f.$eval("#download-link", (b) => b.click());
  await f.waitForFunction(() => window.__dl.length === 1, { timeout: 10000 });
  const file = await f.evaluate(() => window.__dl[0]);
  check("file only: the attachment downloads", file.name === "upload.bin" && Buffer.compare(Buffer.from(file.bytes), fileBytes) === 0);
  await f.close();
}

// ---------------------------------------------------------- drag and drop
{
  const d = await newPage();
  await d.goto(BASE + "/", { waitUntil: "networkidle0" });
  const overlay = () => d.$eval("#drop-overlay", (e) => !e.hidden);
  const notes = [{ name: "notes.txt", text: "dropped in" }];

  await drag(d, "dragenter", "#paste-area");
  check("drop: dragging text doesn't show the overlay", !(await overlay()));
  await drag(d, "dragenter", "#paste-area", notes);
  await drag(d, "dragenter", ".create-options", notes);
  await drag(d, "dragleave", "#paste-area", notes);
  check("drop: overlay while files are over the page", await overlay());
  await drag(d, "dragleave", ".create-options", notes);
  check("drop: overlay gone when they leave", !(await overlay()));
  check("drop: overlay says what to do", /Drop to attach\s+One file, up to/.test(await txt(d, "#drop-overlay")));

  await drag(d, "dragenter", ".create-options", notes);
  const taken = await drag(d, "drop", ".create-options", notes);
  check("drop: a file dropped anywhere is attached", taken && !(await overlay()) && (await txt(d, "#attachment-name")) === "notes.txt"
    && (await txt(d, "#attachment-size")) === "10 bytes", await txt(d, "#attachment-size"));

  let said = "";
  d.once("dialog", (dialog) => { said = dialog.message(); dialog.dismiss(); });
  await drag(d, "drop", "#paste-area", [{ name: "a.txt", text: "a" }, { name: "b.txt", text: "b" }]);
  check("drop: several files are refused, saying why", /one file/.test(said) && (await txt(d, "#attachment-name")) === "notes.txt", said);

  await drag(d, "drop", "#paste-area", [{ name: "other.txt", text: "replacement" }]);
  check("drop: another file replaces the first", (await txt(d, "#attachment-name")) === "other.txt");

  await d.click("#submit-paste");
  await d.waitForSelector("#url-modal.show", { timeout: 20000 });
  await d.goto(local(await d.$eval("#paste-url", (e) => e.value)), { waitUntil: "networkidle0" });
  await d.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  await hookDownloads(d);
  await d.$eval("#download-link", (b) => b.click());
  await d.waitForFunction(() => window.__dl.length === 1, { timeout: 10000 });
  const dropped = await d.evaluate(() => window.__dl[0]);
  check("drop: the dropped file arrives intact", dropped.name === "other.txt" && Buffer.from(dropped.bytes).toString() === "replacement");
  await d.close();
}

// ------------------------------------------------------------------ burn
const b = await newPage();
await b.goto(BASE + "/", { waitUntil: "networkidle0" });
await b.$eval("#paste-area", (el) => { el.value = "burn me"; el.dispatchEvent(new Event("input")); });
await b.click('label[for="burn"]');
await b.click("#submit-paste");
await b.waitForSelector("#url-modal.show", { timeout: 15000 });
const burnUrl = await b.$eval("#paste-url", (e) => e.value);
check("burn: dialog chip", (await b.$$eval("#link-summary .chip", (els) => els.map((e) => e.textContent.trim()))).includes("Burns after 1 view"));
const bv = await newPage();
await bv.goto(local(burnUrl), { waitUntil: "networkidle0" });
await openIfAsked(bv);
await bv.waitForFunction(() => !document.getElementById("final-view").hidden, { timeout: 10000 });
check("burn: final-view chip on the one view", (await txt(bv, "#views")) === "1 of 1 views");
const again = await newPage();
const res = await again.goto(local(burnUrl), { waitUntil: "networkidle0" });
check("burn: second open is 404 'Paste not found'", res.status() === 404 && (await txt(again, "h1")) === "Paste not found");

// ------------------------------------------------------------- bad link
const bad = await newPage();
const plainUrl = await (async () => {
  const p = await newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.$eval("#paste-area", (el) => { el.value = "plain"; el.dispatchEvent(new Event("input")); });
  await p.click("#submit-paste");
  await p.waitForSelector("#url-modal.show", { timeout: 15000 });
  return p.$eval("#paste-url", (e) => e.value);
})();
await bad.goto(local(plainUrl).slice(0, -3) + "AAA", { waitUntil: "networkidle0" });
await bad.waitForFunction(() => !document.getElementById("decrypt-error").hidden, { timeout: 10000 });
check("bad link: clear error, no view counted", (await txt(bad, "#views")) === "0 views");
const good = await newPage();
await good.goto(local(plainUrl), { waitUntil: "networkidle0" });
await good.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 10000 });
check("no password: opens directly, 'Untitled'", (await txt(good, "#paste-title")) === "Untitled" && (await good.$eval("#view-area", (e) => e.textContent)) === "plain");

// ---------------------------------------------------------------- mobile
const m = await newPage(390, 844, true);
await m.goto(BASE + "/", { waitUntil: "networkidle0" });
const btn = await m.$eval("#submit-paste", (e) => { const r = e.getBoundingClientRect(); return { bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), pos: getComputedStyle(e).position }; });
check("mobile: submit button pinned to the bottom", btn.pos === "fixed" && btn.bottom === 16 && btn.w === 358, JSON.stringify(btn));
check("mobile: no horizontal scroll", !(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)));

check("no JS errors or CSP violations", errors.length === 0, errors.join(" | "));
await browser.close();
finish();
