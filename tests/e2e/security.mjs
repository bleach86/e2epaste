// Security and privacy: response headers, access proofs, server-side view
// counting, burn after reading, download tickets, the unlock rate limit,
// delete links and the admin API.
// Server settings (tests/run-e2e.mjs): unlock_attempts_per_hour = 8 and
// admin_token = ADMIN_TOKEN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, check, finish, launch, local, openIfAsked, watch } from "./lib.mjs";

const ADMIN = process.env.ADMIN_TOKEN;
const browser = await launch();
await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const errors = [];
async function newPage() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  await watch(p, errors);
  return p;
}
const api = (path, opts = {}) => fetch(BASE + path, opts);
// Every request in this file gets its own made-up client IP unless given one,
// so the unlock limit is only hit where a test means to.
let ipCounter = 1;
const freshIp = () => `198.51.100.${ipCounter++}`;
const openApi = (id, proof, ip = freshIp()) =>
  api(`/api/open/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify({ proof }) });

// Creates a paste through the real page; returns { url, id, secret, deleteUrl }.
async function createPaste({ text = "secret text", password = "", burn = false, file = null, syntax = null, title = "", deleteAfterOpen = null } = {}) {
  const p = await newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, text);
  if (syntax) await p.select("#syntax", syntax);
  if (title) await p.type("#paste-title", title);
  if (deleteAfterOpen) await p.select("#delete-after-open", String(deleteAfterOpen));
  if (password) await p.type("#paste-password", password);
  if (burn) await p.click('label[for="burn"]');
  if (file) { const input = await p.$("#fileInput"); await input.uploadFile(file); }
  await p.click("#submit-paste");
  await p.waitForSelector("#url-modal.show", { timeout: 20000 });
  const url = await p.$eval("#paste-url", (e) => e.value);
  const deleteUrl = await p.$eval("#delete-url", (e) => e.value);
  const chips = await p.$$eval("#link-summary .chip", (els) => els.map((e) => e.textContent.trim()));
  await p.close();
  const [, id, secret] = url.match(/\/s\/(\w+)#(.+)$/);
  return { url, id, secret, deleteUrl, chips };
}

// Opens a paste in a fresh page and waits for it to decrypt (or fail).
async function view(url, password = null) {
  const p = await newPage();
  await p.goto(local(url), { waitUntil: "networkidle0" });
  await openIfAsked(p);
  if (password !== null) {
    await p.waitForSelector("#password-modal.show");
    await p.type("#password-input", password);
    await p.click("#submit-password-btn");
  }
  await p.waitForFunction(() =>
    !document.getElementById("decrypted-notice").hidden || !document.getElementById("decrypt-error").hidden ||
    !document.getElementById("open-error").hidden || !document.getElementById("password-error").hidden, { timeout: 20000 });
  return p;
}

// --------------------------------------------------------------- headers
{
  const home = await api("/");
  const csp = home.headers.get("content-security-policy") ?? "";
  check("headers: CSP allows only same-origin scripts, no inline", csp.includes("script-src 'self'") && !csp.includes("unsafe-inline") && csp.includes("frame-ancestors 'none'"), csp);
  for (const [name, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "no-referrer"], ["cross-origin-opener-policy", "same-origin"]]) {
    check(`headers: ${name}`, home.headers.get(name) === value, home.headers.get(name));
  }
  check("headers: no HSTS on an http site_url", home.headers.get("strict-transport-security") === null);
  const paste = await api("/paste/AAAAAAAA");
  check("headers: paste pages are no-store", paste.headers.get("cache-control") === "no-store");
  check("headers: API is no-store", (await openApi("AAAAAAAA", null)).headers.get("cache-control") === "no-store");
  const asset = await api("/public/css/styles.css");
  check("headers: assets cached long, embeddable", /max-age=15552000/.test(asset.headers.get("cache-control")) && asset.headers.get("cross-origin-resource-policy") === null);
  check("robots: /delete/ disallowed", (await (await api("/robots.txt")).text()).includes("Disallow: /delete/"));
}

// ---------------------------------------- what the server learns (v4)
{
  const decoded = (base64) => (base64.length / 4) * 3 - (base64.match(/=*$/)[0].length);
  const isPadme = (n) => { const e = n.toString(2).length - 1; const step = 2 ** (e - e.toString(2).length); return n % step === 0; };
  const attachment = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-")), "v4.bin");
  // Over 2 MiB: uploaded and downloaded in 3 chunks. With its 8-byte size in
  // front it's exactly 2.5 MiB, a padded size, so nothing is added.
  const attachmentBytes = Buffer.alloc(2.5 * 1048576 - 8);
  for (let i = 0; i < attachmentBytes.length; i += 65536) crypto.getRandomValues(attachmentBytes.subarray(i, i + 65536));
  fs.writeFileSync(attachment, attachmentBytes);
  const secret = await createPaste({ text: "fn main() {}\n".repeat(30), password: "pw-1", syntax: "rust", title: "Private title", file: attachment });
  const page = JSON.parse((await (await api(`/paste/${secret.id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]).paste;
  check("v4: the server is told no language", page.syntax === "auto" && page.version === 4, page.syntax);
  check("v4: the server isn't told there's a password", page.has_password === false);

  const p = await newPage();
  let opened = null;
  p.on("response", async (r) => { if (r.url().includes("/api/open/") && r.ok()) opened = await r.json(); });
  await p.goto(local(secret.url), { waitUntil: "networkidle0" });
  await p.waitForSelector("#password-modal.show");
  check("v4: the link says to ask for the password", true);
  await p.type("#password-input", "pw-1");
  await p.click("#submit-password-btn");
  await p.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("v4: the title decrypts", (await p.$eval("#paste-title", (e) => e.textContent)) === "Private title");
  check("v4: the chosen language comes from the encrypted title", (await p.$eval("#language-name", (e) => e.textContent)) === "Rust" && (await p.$eval("#view-area", (e) => e.className)).includes("language-rust"));
  const sizes = { content: decoded(opened.content) - 16, title: decoded(opened.title) - 16, name: decoded(opened.file_name) - 16 };
  check("v4: the server only has padded sizes", isPadme(sizes.content) && sizes.content >= 4096 && sizes.title === 512 && sizes.name === 1024, JSON.stringify(sizes));
  // Capture the decrypted file instead of saving it.
  await p.evaluate(() => {
    window.__dl = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => window.__dl.push(Array.from(new Uint8Array(b)))); return create(blob); };
    HTMLAnchorElement.prototype.click = function () {};
  });
  const [download] = await Promise.all([
    p.waitForResponse((r) => r.url().includes("/api/download-attachment/")),
    p.$eval("#download-link", (b) => b.click()),
  ]);
  // From the header: the page reads the body as a stream, and Chrome doesn't
  // always keep a copy of streamed bodies for DevTools to hand out.
  const fileSize = Number(download.headers()["content-length"]);
  check("v4: the attachment is stored padded, in chunks", fileSize === 2621440 + 3 * 16, fileSize);
  await p.waitForFunction(() => window.__dl.length === 1, { timeout: 20000 });
  check("v4: the attachment decrypts to the original", Buffer.compare(Buffer.from(await p.evaluate(() => window.__dl[0])), attachmentBytes) === 0);
  await p.close();
}

// --------------------------------------------------- page holds no content
const plain = await createPaste({ text: "the quick brown fox" });
{
  const html = await (await api(`/paste/${plain.id}`)).text();
  const data = JSON.parse(html.match(/id="page-data">(.*?)<\/script>/s)[1]);
  check("page: no encrypted content, title or key material in the page", !("content" in data.paste) && !("key_fragment" in data.paste) && !("access_hash" in data.paste) && !("delete_hash" in data.paste) && data.paste.title === null, JSON.stringify(data.paste));
  check("page: loading it uses no view", data.paste.views === 0);

  const noProof = await openApi(plain.id, null);
  check("open: without a proof is refused (403)", noProof.status === 403);
  check("open: with a made-up proof is refused", (await openApi(plain.id, "ab".repeat(32))).status === 403);
  const again = JSON.parse((await (await api(`/paste/${plain.id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]);
  check("open: refused attempts used no views", again.paste.views === 0, again.paste.views);

  const p = await view(plain.url);
  check("open: the real link decrypts", (await p.$eval("#view-area", (e) => e.textContent)) === "the quick brown fox");
  check("open: and counts exactly one view", (await p.$eval("#views", (e) => e.textContent.trim())) === "1 view");
  await p.close();
}

// ------------------------------------------------------------- password
{
  const pw = await createPaste({ text: "pw text", password: "correct horse" });
  const p = await view(pw.url, "wrong password");
  check("password: wrong one shows an error", !(await p.$eval("#password-error", (e) => e.hidden)));
  await p.$eval("#password-input", (e) => (e.value = ""));
  await p.type("#password-input", "correct horse");
  await p.click("#submit-password-btn");
  await p.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("password: right one decrypts", (await p.$eval("#view-area", (e) => e.textContent)) === "pw text");
  check("password: the wrong attempt used no view", (await p.$eval("#views", (e) => e.textContent.trim())) === "1 view");
  await p.close();
}

// -------------------------------------------------------- truncated link
{
  const short = await createPaste({ text: "short link", burn: true });
  const p = await view(short.url.slice(0, -4));
  check("bad link: shows the link error", !(await p.$eval("#decrypt-error", (e) => e.hidden)));
  await p.close();
  const p2 = await view(short.url);
  check("bad link: burn paste still opens afterwards", (await p2.$eval("#view-area", (e) => e.textContent)) === "short link");
  await p2.close();
}

// ----------------------------------------------------------------- burn
{
  const burn = await createPaste({ text: "burn after reading", burn: true });
  const p = await view(burn.url);
  check("burn: opens once, marked as the final view", !(await p.$eval("#final-view", (e) => e.hidden)));
  await p.close();
  check("burn: gone from the server immediately", (await api(`/paste/${burn.id}`)).status === 404);
  const p2 = await newPage();
  await p2.goto(local(burn.url), { waitUntil: "networkidle0" });
  check("burn: a second visit gets the not-found page", (await p2.title()).startsWith("Paste Not Found"), await p2.title());
  await p2.close();
}

// ------------------------------------------------------ download tickets
{
  const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 13) % 256));
  const ticketFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-")), "ticket.bin");
  fs.writeFileSync(ticketFile, bytes);
  const withFile = await createPaste({ text: "has a file", burn: true, file: ticketFile });
  check("tickets: download without a ticket is refused", (await api(`/api/download-attachment/${withFile.id}`)).status === 403);
  check("tickets: made-up ticket refused", (await api(`/api/download-attachment/${withFile.id}`, { headers: { "X-Download-Ticket": "ab".repeat(32) } })).status === 403);

  const p = await view(withFile.url);
  check("tickets: burn paste with a file opens", (await p.$eval("#view-area", (e) => e.textContent)) === "has a file");
  check("tickets: the page can't be opened again", (await api(`/paste/${withFile.id}`)).status === 404);
  // Download through the page, capturing the blob.
  await p.evaluate(() => {
    window.__dl = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => window.__dl.push(Array.from(new Uint8Array(b)))); return create(blob); };
    HTMLAnchorElement.prototype.click = function () {};
  });
  await p.click("#download-link");
  await p.waitForFunction(() => window.__dl.length === 1, { timeout: 20000 });
  check("tickets: the viewer downloads the attachment", Buffer.compare(Buffer.from(await p.evaluate(() => window.__dl[0])), bytes) === 0);
  // Downloading again: the burned paste and its file were deleted after the
  // first download.
  await p.click("#download-link");
  await p.waitForFunction(() => !document.getElementById("download-link").disabled, { timeout: 10000 });
  check("tickets: a burned paste's file is deleted after its download", (await p.evaluate(() => window.__dl.length)) === 1 && !(await api(`/paste/${withFile.id}`)).ok);
  await p.close();
}

// ------------------------------------------------------------ unlock limit
{
  const target = await createPaste({ text: "guess me" });
  const ip = "203.0.113.99";
  let statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await openApi(target.id, "cd".repeat(32), ip)).status);
  check("unlock limit: 8 wrong attempts, then 429", statuses.slice(0, 8).every((s) => s === 403) && statuses[8] === 429, statuses.join(","));
  const limited = await openApi(target.id, "cd".repeat(32), ip);
  check("unlock limit: says how long to wait", limited.status === 429 && Number(limited.headers.get("retry-after")) > 0);
  check("unlock limit: other IPs unaffected", (await openApi(target.id, null, "203.0.113.100")).status === 403);
}

// ------------------------------------------------------------ delete link
{
  const del = await createPaste({ text: "delete me" });
  check("delete: link dialog has a delete link", /\/delete\/\w+#[0-9a-f]{64}$/.test(del.deleteUrl), del.deleteUrl);
  const wrong = await newPage();
  await wrong.goto(local(del.deleteUrl.replace(/#.*/, "#" + "0".repeat(64))), { waitUntil: "networkidle0" });
  await wrong.click("#delete-btn");
  await wrong.waitForFunction(() => !document.getElementById("delete-error").hidden);
  check("delete: a wrong token is refused", /isn't valid/.test(await wrong.$eval("#delete-error", (e) => e.textContent)));
  await wrong.close();
  check("delete: paste still there after the wrong token", (await api(`/paste/${del.id}`)).status === 200);

  const p = await newPage();
  await p.goto(local(del.deleteUrl), { waitUntil: "networkidle0" });
  check("delete: page is noindex", (await p.$eval('meta[name="robots"]', (e) => e.content)).includes("noindex"));
  await p.click("#delete-btn");
  await p.waitForFunction(() => !document.getElementById("delete-done").hidden, { timeout: 10000 });
  check("delete: confirms", true);
  check("delete: paste is gone", (await api(`/paste/${del.id}`)).status === 404);
  await p.reload({ waitUntil: "networkidle0" });
  await p.click("#delete-btn");
  await p.waitForFunction(() => !document.getElementById("delete-error").hidden);
  check("delete: second time says it's already gone", /doesn't exist/.test(await p.$eval("#delete-error", (e) => e.textContent)));
  await p.close();
}

// ------------------------------------- delete button in the creator's browser
{
  const STORAGE_KEY = "e2epaste.deleteTokens";
  const stored = (p) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), STORAGE_KEY);
  const mine = await createPaste({ text: "mine to delete" });
  const token = mine.deleteUrl.split("#")[1];

  const p = await view(mine.url);
  const entry = (await stored(p))[mine.id];
  check("delete button: token kept until the paste expires", entry?.token === token && Math.abs(entry.expires - (Date.now() + 3 * 86400e3)) < 60e3, JSON.stringify(entry));
  check("delete button: only the token is stored, not the key", !JSON.stringify(await stored(p)).includes(mine.secret));
  const href = await p.$eval("#delete-paste-btn", (e) => (e.hidden ? null : e.getAttribute("href")));
  check("delete button: shown to the creator", href === `/delete/${mine.id}#${token}`, href);

  // Someone else with the link (another browser profile) doesn't get one.
  const other = await browser.createBrowserContext();
  const op = await other.newPage();
  await op.goto(local(mine.url), { waitUntil: "networkidle0" });
  await op.waitForFunction(() => !document.getElementById("decrypted-notice").hidden);
  check("delete button: hidden from other viewers", await op.$eval("#delete-paste-btn", (e) => e.hidden));
  await other.close();

  await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0" }), p.click("#delete-paste-btn")]);
  await p.click("#delete-btn");
  await p.waitForFunction(() => !document.getElementById("delete-done").hidden, { timeout: 10000 });
  check("delete button: deletes the paste", (await api(`/paste/${mine.id}`)).status === 404);
  check("delete button: token forgotten afterwards", !(mine.id in (await stored(p))));
  await p.close();

  // Password pastes: the password dialog covers the page, so it has the link.
  const locked = await createPaste({ text: "locked", password: "hunter2" });
  const lp = await newPage();
  await lp.goto(local(locked.url), { waitUntil: "networkidle0" });
  await lp.waitForSelector("#password-modal.show");
  check("delete button: in the password dialog too", await lp.$eval("#password-delete-link", (e, id) => !e.hidden && e.getAttribute("href").startsWith(`/delete/${id}#`), locked.id));
  // The delete page without a token in the link uses the kept one.
  await lp.goto(`${BASE}/delete/${locked.id}`, { waitUntil: "networkidle0" });
  await lp.click("#delete-btn");
  await lp.waitForFunction(() => !document.getElementById("delete-done").hidden, { timeout: 10000 });
  check("delete page: uses the kept token when the link has none", (await api(`/paste/${locked.id}`)).status === 404);

  // Expired entries are ignored, and a broken store doesn't break the page.
  const old = await createPaste({ text: "expired entry" });
  await lp.evaluate((k, id) => {
    const tokens = JSON.parse(localStorage.getItem(k));
    tokens[id].expires = Date.now() - 1;
    localStorage.setItem(k, JSON.stringify(tokens));
  }, STORAGE_KEY, old.id);
  await lp.goto(local(old.url), { waitUntil: "networkidle0" });
  await lp.waitForFunction(() => !document.getElementById("decrypted-notice").hidden);
  check("delete button: not shown once the paste would have expired", await lp.$eval("#delete-paste-btn", (e) => e.hidden));
  await lp.evaluate((k) => localStorage.setItem(k, "{not json"), STORAGE_KEY);
  await lp.reload({ waitUntil: "networkidle0" });
  await lp.waitForFunction(() => !document.getElementById("decrypted-notice").hidden);
  check("delete button: a broken store is ignored", await lp.$eval("#delete-paste-btn", (e) => e.hidden));
  await lp.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);

  // "Remember on this device" off: nothing is kept, and the choice sticks.
  await lp.goto(BASE + "/", { waitUntil: "networkidle0" });
  check("remember switch: on by default", await lp.$eval("#remember-delete", (e) => e.checked));
  await lp.click("#remember-delete");
  await lp.$eval("#paste-area", (el) => { el.value = "not remembered"; el.dispatchEvent(new Event("input")); });
  await lp.click("#submit-paste");
  await lp.waitForSelector("#url-modal.show", { timeout: 20000 });
  check("remember switch: off keeps nothing", (await lp.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)) === null);
  check("remember switch: link dialog doesn't claim it's remembered", await lp.$eval("#delete-remembered", (e) => e.hidden));
  const forgotten = local(await lp.$eval("#paste-url", (e) => e.value));
  await lp.reload({ waitUntil: "networkidle0" });
  check("remember switch: stays off on the next visit", !(await lp.$eval("#remember-delete", (e) => e.checked)));
  await lp.goto(forgotten, { waitUntil: "networkidle0" });
  await lp.waitForFunction(() => !document.getElementById("decrypted-notice").hidden);
  check("remember switch: no Delete button when off", await lp.$eval("#delete-paste-btn", (e) => e.hidden));
  // Back on, for the rest of this file.
  await lp.goto(BASE + "/", { waitUntil: "networkidle0" });
  await lp.click("#remember-delete");
  await lp.reload({ waitUntil: "networkidle0" });
  check("remember switch: back on sticks too", await lp.$eval("#remember-delete", (e) => e.checked));
  await lp.close();
}

// ------------------------------- asking the creator before using up a view
{
  const pageData = async (id) => JSON.parse((await (await api(`/paste/${id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]).paste;
  const burn = await createPaste({ text: "only once", burn: true });
  const p = await newPage();
  await p.goto(local(burn.url), { waitUntil: "networkidle0" });
  check("creator prompt: shown for this browser's burn paste", !(await p.$eval("#owner-prompt", (e) => e.hidden)));
  check("creator prompt: says it's the last view", /uses its last view/.test(await p.$eval("#owner-prompt-text", (e) => e.textContent)));
  check("creator prompt: nothing opened or counted yet", (await pageData(burn.id)).views === 0 && (await p.$eval("#decrypted-notice", (e) => e.hidden)));
  check("creator prompt: Delete goes to the delete page", (await p.$eval("#owner-delete-link", (e) => e.getAttribute("href"))) === `/delete/${burn.id}#${burn.deleteUrl.split("#")[1]}`);
  await p.click("#owner-open-btn");
  await p.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("creator prompt: Open opens it", (await p.$eval("#view-area", (e) => e.textContent)) === "only once" && !(await p.$eval("#final-view", (e) => e.hidden)));
  await p.close();

  const limited = await createPaste({ text: "three views" });
  const q = await newPage();
  await q.goto(local(limited.url), { waitUntil: "networkidle0" });
  await q.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("creator prompt: not for a paste with nothing to lose", await q.$eval("#owner-prompt", (e) => e.hidden));
  await q.close();

  // Someone else (another browser profile) opens it straight away.
  const other = await createPaste({ text: "for someone else", burn: true });
  const ctx = await browser.createBrowserContext();
  const o = await ctx.newPage();
  await o.goto(local(other.url), { waitUntil: "networkidle0" });
  await o.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("creator prompt: not for other people", await o.$eval("#owner-prompt", (e) => e.hidden));
  await ctx.close();
}

// ------------------------------------------------- delete after opening
{
  const pageData = async (id) => JSON.parse((await (await api(`/paste/${id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]).paste;
  const timed = await createPaste({ text: "ten minutes", deleteAfterOpen: 600 });
  check("timer: shown in the link dialog", timed.chips.includes("Deleted 10 minutes after opening"), JSON.stringify(timed.chips));
  const before = await pageData(timed.id);
  check("timer: stored, not started", before.delete_after_open === 600 && before.expires > Date.now() + 2 * 86400e3);

  const p = await newPage();
  await p.goto(local(timed.url), { waitUntil: "networkidle0" });
  check("timer: the creator is told opening starts it", /starts its timer: it's deleted 10 minutes later/.test(await p.$eval("#owner-prompt-text", (e) => e.textContent)));
  check("timer: chip before the first view", (await p.$eval("#timer-text", (e) => e.textContent)) === "Deleted 10 minutes after it's first opened");
  await p.close();

  // The reader, in another browser profile.
  const ctx = await browser.createBrowserContext();
  const r = await ctx.newPage();
  await r.goto(local(timed.url), { waitUntil: "networkidle0" });
  await r.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("timer: the first view starts it", (await r.$eval("#expire-date", (e) => e.textContent)) === "Expires in 10 minutes" && (await r.$eval("#timer-chip", (e) => e.hidden)));
  await ctx.close();
  const after = await pageData(timed.id);
  check("timer: the server moved the expiry", after.expires <= Date.now() + 600e3 && after.expires > Date.now() + 590e3);

  const again = await newPage();
  await again.goto(local(timed.url), { waitUntil: "networkidle0" });
  await again.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("timer: once started, the creator isn't asked again", await again.$eval("#owner-prompt", (e) => e.hidden));
  await again.close();
}

// ----------------------------------------------------------------- admin
{
  const reported = await createPaste({ text: "reported" });
  const adminDelete = (auth) => api(`/api/admin/delete/${reported.id}`, { method: "POST", headers: { ...(auth ? { Authorization: auth } : {}), "X-Real-IP": freshIp() } });
  check("admin: no token -> 401", (await adminDelete(null)).status === 401);
  check("admin: wrong token -> 403", (await adminDelete("Bearer nope-nope-nope-nope-nope-nope-nope")).status === 403);
  const res = await adminDelete(`Bearer ${ADMIN}`);
  check("admin: right token deletes", res.status === 200 && (await res.json()).deleted === true);
  check("admin: paste gone", (await api(`/paste/${reported.id}`)).status === 404);
  const again = await adminDelete(`Bearer ${ADMIN}`);
  check("admin: deleting again reports nothing deleted", (await again.json()).deleted === false);
}

// --------------------------------------------- what the server accepts
{
  // Base64 that decodes to `n` bytes (the server only checks the sizes).
  const b64 = (n) => "A".repeat(Math.floor(n / 3) * 4) + ["", "AA==", "AAA="][n % 3];
  // A valid paste as the create page sends it, with every part padded (plus
  // the 16-byte tag); each check below spoils it.
  const valid = () => ({ content: b64(4096 + 16), iv: Array(12).fill(7), expires_in: 3600, max_views: null,
    key_fragment: "", version: 4, title: b64(512 + 16), syntax: "auto", file_name: null, access_hash: "ab".repeat(32) });
  const submit = (body) => api("/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": freshIp() }, body: JSON.stringify(body) });
  const pageData = async (id) => JSON.parse((await (await api(`/paste/${id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]).paste;

  const ok = await submit(valid());
  check("create: a valid paste is accepted", ok.status === 200, ok.status);
  const year = 365 * 24 * 60 * 60 * 1000;
  const forever = await (await submit({ ...valid(), expires_in: Number.MAX_SAFE_INTEGER })).json();
  check("create: lifetime capped at a year", (await pageData(forever.id)).expires <= Date.now() + year);
  const absolute = await (await submit({ ...valid(), expires_in: undefined, expires: Number.MAX_SAFE_INTEGER })).json();
  check("create: older clients' absolute expiry capped too", absolute.id && (await pageData(absolute.id)).expires <= Date.now() + year);

  for (const [label, body] of [
    ["no access hash", { ...valid(), access_hash: undefined }],
    ["a malformed access hash", { ...valid(), access_hash: "nope" }],
    ["an old format (v2)", { ...valid(), version: 2, key_fragment: "abc" }],
    ["the previous format (v3)", { ...valid(), version: 3 }],
    ["key material", { ...valid(), key_fragment: "abc" }],
    ["an expiry in the past", { ...valid(), expires_in: 0 }],
    ["an unknown language", { ...valid(), syntax: "<script>" }],
    // What v4 keeps from the server.
    ["a language in the clear", { ...valid(), syntax: "rust" }],
    ["the password flag", { ...valid(), has_password: true }],
    ["unpadded content", { ...valid(), content: b64(5000 + 16) }],
    ["content under the minimum", { ...valid(), content: b64(100) }],
    ["an unpadded title", { ...valid(), title: b64(40) }],
    ["an attachment without its size", { ...valid(), file_name: b64(1024 + 16) }],
    ["an unpadded attachment", { ...valid(), file_name: b64(1024 + 16), file_size: 5000 + 16 }],
    ["an unpadded file name", { ...valid(), file_name: b64(30), file_size: 4096 + 16 }],
    ["a view limit of 0", { ...valid(), max_views: 0 }],
    ["a short IV", { ...valid(), iv: [1, 2, 3] }],
    ["a huge title", { ...valid(), title: "a".repeat(5000) }],
  ]) {
    const res = await submit(body);
    const reason = res.status === 400 ? (await res.json()).reason : "";
    check(`create: refuses ${label}`, res.status === 400 && reason.length > 0, `${res.status} ${reason}`);
  }

  // Attachments are uploaded in 1 MiB chunks (plus a 16-byte tag each), in
  // order, and must add up to exactly the size declared with the paste.
  const CHUNK = 1048576 + 16;
  // A file whose padded stream is 2.5 MiB (2,621,440 bytes, a Padmé size):
  // 3 chunks.
  const declared = 2621440 + 3 * 16;
  const withFile = await (await submit({ ...valid(), file_name: b64(1024 + 16), file_size: declared })).json();
  const upload = (index, last, bytes, token = withFile.upload_token) => api(`/api/upload-attachment/${withFile.id}/${index}?last=${last}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Upload-Token": token }, body: new Uint8Array(bytes) });
  check("upload: a declared size that isn't padded is refused", (await submit({ ...valid(), file_name: b64(1024 + 16), file_size: declared + 1 })).status === 400);
  check("upload: needs the upload token", (await upload(0, false, CHUNK, "nope")).status === 403);
  check("upload: a chunk ahead of the others is refused", (await upload(1, false, CHUNK)).status === 400);
  check("upload: a short chunk that isn't the last is refused", (await upload(0, false, 1000)).status === 400);
  check("upload: the first chunk", (await upload(0, false, CHUNK)).status === 200);
  check("upload: a chunk can be sent again", (await upload(0, false, CHUNK)).status === 200 && (await upload(1, false, CHUNK)).status === 200);
  check("upload: going past the declared size is refused (413)", (await upload(2, false, CHUNK)).status === 413);
  const wrongEnd = await upload(2, true, 1000);
  check("upload: a total other than declared is refused", wrongEnd.status === 400, wrongEnd.status);
  check("upload: the right last chunk completes it", (await upload(2, true, declared - 2 * CHUNK)).status === 200);
  check("upload: nothing more after it's complete", (await upload(2, true, declared - 2 * CHUNK)).status === 403);
}

// --------------------------------------------------------- service worker
{
  const p = await newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  const count = await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  check("service worker: none registered", count === 0);
  check("service worker: the old script is gone", (await api("/public/js/sw.js")).status === 404);
  await p.close();
}

check("no JS errors or CSP violations", errors.length === 0, JSON.stringify(errors));
await browser.close();
finish();
