// Security and privacy: response headers, access proofs, server-side view
// counting, burn after reading, download tickets, the unlock rate limit,
// delete links and the admin API.
// Server settings (tests/run-e2e.mjs): unlock_attempts_per_hour = 8 and
// admin_token = ADMIN_TOKEN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, check, finish, launch, local, watch } from "./lib.mjs";

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
async function createPaste({ text = "secret text", password = "", burn = false, file = null } = {}) {
  const p = await newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, text);
  if (password) await p.type("#paste-password", password);
  if (burn) await p.click('label[for="burn"]');
  if (file) { const input = await p.$("#fileInput"); await input.uploadFile(file); }
  await p.click("#submit-paste");
  await p.waitForSelector("#url-modal.show", { timeout: 20000 });
  const url = await p.$eval("#paste-url", (e) => e.value);
  const deleteUrl = await p.$eval("#delete-url", (e) => e.value);
  await p.close();
  const [, id, secret] = url.match(/\/s\/(\w+)#(.+)$/);
  return { url, id, secret, deleteUrl };
}

// Opens a paste in a fresh page and waits for it to decrypt (or fail).
async function view(url, password = null) {
  const p = await newPage();
  await p.goto(local(url), { waitUntil: "networkidle0" });
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
  // A valid paste as the create page sends it; each check below spoils it.
  const valid = () => ({ content: "Y2lwaGVydGV4dA==", iv: Array(12).fill(7), expires_in: 3600, max_views: null,
    key_fragment: "", version: 3, title: "dGl0bGU=", syntax: "auto", file_name: null, access_hash: "ab".repeat(32) });
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
    ["key material in a v3 paste", { ...valid(), key_fragment: "abc" }],
    ["an expiry in the past", { ...valid(), expires_in: 0 }],
    ["an unknown language", { ...valid(), syntax: "<script>" }],
    ["a view limit of 0", { ...valid(), max_views: 0 }],
    ["a short IV", { ...valid(), iv: [1, 2, 3] }],
    ["a huge title", { ...valid(), title: "a".repeat(5000) }],
  ]) {
    const res = await submit(body);
    const reason = res.status === 400 ? (await res.json()).reason : "";
    check(`create: refuses ${label}`, res.status === 400 && reason.length > 0, `${res.status} ${reason}`);
  }
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
