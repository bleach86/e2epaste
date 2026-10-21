// Pastes made by older versions: a v2 paste created with the old crypto code
// opens end to end through /api/open, including a wrong password first; a v3
// paste (unpadded, language and password flag on the server) opens as
// before; and a v3 paste from before access proofs opens without one. The server only
// accepts these old formats because tests/run-e2e.mjs starts it with
// E2EPASTE_TEST_LEGACY_PASTES (debug builds only).
import * as C from "../../js/crypto.mjs";
import * as OLD from "../fixtures/crypto_v2.mjs";
import { BASE, check, finish, launch, watch } from "./lib.mjs";

async function createV2(password, maxViews) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pasteKey = await OLD.generateKey();
  const key = password ? await OLD.deriveKeyWithPassword(pasteKey, password, iv) : pasteKey;
  const frag = OLD.fragmentKey(await OLD.exportCryptoKey(pasteKey));
  const body = { version: 2, key_fragment: frag.serverKey, iv: Array.from(iv), has_password: !!password,
    content: OLD.arrayBufferToBase64(await OLD.encryptText("v2 text ✓", key, iv)),
    expires: null, max_views: maxViews, title: "Old title", syntax: "plaintext", file_name: null };
  const { id } = await (await fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": "192.0.2.77" }, body: JSON.stringify(body) })).json();
  return `${BASE}/paste/${id}#${frag.hashFragment}`;
}

const browser = await launch();
const errors = [];
const page = await browser.newPage();
await watch(page, errors);

await page.goto(await createV2("", null), { waitUntil: "networkidle0" });
await page.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
check("v2: opens and decrypts", (await page.$eval("#view-area", (e) => e.textContent)) === "v2 text ✓");
check("v2: plaintext title shown", (await page.$eval("#paste-title", (e) => e.textContent)) === "Old title");

// Two views allowed: a wrong password then the right one must use only one.
await page.goto(await createV2("hunter2", 2), { waitUntil: "networkidle0" });
await page.waitForSelector("#password-modal.show");
await page.type("#password-input", "wrong");
await page.click("#submit-password-btn");
await page.waitForFunction(() => !document.getElementById("password-error").hidden, { timeout: 20000 });
check("v2 password: wrong one shows an error", true);
await page.$eval("#password-input", (e) => (e.value = ""));
await page.type("#password-input", "hunter2");
await page.click("#submit-password-btn");
await page.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
check("v2 password: right one decrypts", (await page.$eval("#view-area", (e) => e.textContent)) === "v2 text ✓");
check("v2 password: one view used, not two", (await page.$eval("#views", (e) => e.textContent.trim())) === "1 of 2 views", await page.$eval("#views", (e) => e.textContent.trim()));
// v3, created the way the create page did before v4: unpadded parts, the
// language and the password flag told to the server, no flag in the link.
{
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = C.generateLinkSecret();
  const { key, accessProof } = await C.deriveV3Secrets(secret, iv, "pw-v3");
  const b64 = async (data) => C.arrayBufferToBase64(data);
  const body = { version: 3, key_fragment: "", iv: Array.from(iv), has_password: true, syntax: "rust",
    content: await b64(await C.encryptText("fn v3() {}", key, iv)),
    title: await b64(await C.encryptText("v3 title", key, await C.deriveIv(iv, "title"))),
    expires_in: 3600, max_views: null, file_name: null, access_hash: await C.accessHash(accessProof) };
  const res = await fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": "192.0.2.78" }, body: JSON.stringify(body) });
  const { id } = await res.json();
  await page.goto(`${BASE}/s/${id}#${secret}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#password-modal.show");
  check("v3: asks for the password (the server says there is one)", true);
  await page.type("#password-input", "pw-v3");
  await page.click("#submit-password-btn");
  await page.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("v3: text, title and language as before",
    (await page.$eval("#view-area", (e) => e.textContent)) === "fn v3() {}" &&
    (await page.$eval("#paste-title", (e) => e.textContent)) === "v3 title" &&
    (await page.$eval("#view-area", (e) => e.className)).includes("language-rust"));
}

// A v3 paste created before access proofs: no access hash, so it opens
// without a proof (and the view is still counted by the server).
{
  const body = { content: "eA==", iv: Array(12).fill(1), expires_in: 3600, max_views: null, key_fragment: "", version: 3,
    title: "t", syntax: "plaintext", file_name: null };
  const { id } = await (await fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const res = await fetch(`${BASE}/api/open/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proof: null }) });
  check("v3 without a proof: opens, view counted", res.status === 200 && (await res.json()).views === 1);
}
check("no JS errors or CSP violations", errors.length === 0, JSON.stringify(errors));
await browser.close();
finish();
