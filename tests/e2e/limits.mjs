// A site with its own size limits (tests/run-e2e.mjs: max_paste_kib = 8,
// max_file_mib = 1, max_attachment_storage_mib = 1): the create page and FAQ
// say so, the page stops what's too big, the server refuses it anyway, and
// a full attachment store gets its own message.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, check, finish, launch, watch } from "./lib.mjs";

const browser = await launch();
const errors = [];
const p = await browser.newPage();
await p.setViewport({ width: 1280, height: 900 });
await watch(p, errors);
const alerts = [];
p.on("dialog", async (d) => { alerts.push(d.message()); await d.dismiss(); });
await p.goto(BASE + "/", { waitUntil: "networkidle0" });

check("create page: shows the site's limits", (await p.$eval(".panel-foot", (e) => e.textContent.replace(/\s+/g, " "))).includes("Up to 8 KB of text · files up to 1 MB"));

// Text over the limit: the counter turns red and the page won't send it.
await p.$eval("#paste-area", (el) => { el.value = "x".repeat(9 * 1024); el.dispatchEvent(new Event("input")); });
check("create page: over-size text is flagged", await p.$eval("#paste-stats", (e) => e.classList.contains("text-danger")));
await p.click("#submit-paste");
await p.waitForFunction(() => true);
await new Promise((r) => setTimeout(r, 300));
check("create page: over-size text isn't sent", alerts.at(-1) === "Paste is too large. Please keep it under 8 KB.", alerts.at(-1));

// A file over the limit.
const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-")), "big.bin");
fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
await (await p.$("#fileInput")).uploadFile(big);
await new Promise((r) => setTimeout(r, 300));
check("create page: an over-size file is refused", alerts.at(-1) === "File is too large. Please keep it under 1 MB.", alerts.at(-1));

// Within the limits it still works, with an attachment.
const small = path.join(path.dirname(big), "small.bin");
fs.writeFileSync(small, Buffer.alloc(1000, 7));
await p.$eval("#paste-area", (el) => { el.value = "fits"; el.dispatchEvent(new Event("input")); });
await (await p.$("#fileInput")).uploadFile(small);
await p.waitForFunction(() => !document.getElementById("attachment").hidden);
await p.click("#submit-paste");
await p.waitForSelector("#url-modal.show", { timeout: 20000 });
check("create page: a paste within the limits is created", true);

// Just under the 1 MB file limit, but stored with padding (1,048,592 bytes)
// it's over the 1 MiB attachment storage cap.
const almost = path.join(path.dirname(big), "almost.bin");
fs.writeFileSync(almost, Buffer.alloc(1048000, 3));
// Wait for the link dialog's fade-in to finish before closing it.
await new Promise((r) => setTimeout(r, 500));
await p.click("#url-modal .btn-close");
await p.waitForFunction(() => document.getElementById("paste-area").value === "");
await p.$eval("#paste-area", (el) => { el.value = "storage"; el.dispatchEvent(new Event("input")); });
await (await p.$("#fileInput")).uploadFile(almost);
await p.waitForFunction(() => !document.getElementById("attachment").hidden);
await p.click("#submit-paste");
await p.waitForFunction(() => !document.getElementById("submit-paste").disabled, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));
check("create page: a full attachment store is explained",
  alerts.at(-1) === "This site has reached its storage limit for attachments. You can still create a paste without one.", alerts.at(-1));

const faq = await (await fetch(BASE + "/faq")).text();
check("faq: states the site's limits", /Text can be up to 8 KB, and you can\s+attach files of up to 1 MB in all/.test(faq));

// The server applies the same limits to the encrypted sizes.
const b64 = (n) => "A".repeat(Math.floor(n / 3) * 4) + ["", "AA==", "AAA="][n % 3];
const valid = () => ({ content: b64(4096 + 16), iv: Array(12).fill(7), expires_in: 3600, max_views: null,
  key_fragment: "", version: 4, title: b64(512 + 16), syntax: "auto", file_name: null, access_hash: "ab".repeat(32) });
let ip = 1;
const submit = (body) => fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": `198.51.100.${ip++}` }, body: JSON.stringify(body) });
// 8 KiB of text that won't compress pads to 8704 bytes; the next size up is 9216.
check("server: the largest padded text is accepted", (await submit({ ...valid(), content: b64(8704 + 16) })).status === 200);
const over = await submit({ ...valid(), content: b64(9216 + 16) });
check("server: larger text is refused", over.status === 400 && /larger than this site allows/.test((await over.json()).reason));
// What a 2 MiB file is stored as: padded to 2,162,688 bytes, in 3 chunks.
const bigFile = await submit({ ...valid(), file_name: b64(1024 + 16), file_size: 2162688 + 3 * 16 });
check("server: a larger attachment is refused (413)", bigFile.status === 413, bigFile.status);
const huge = await submit({ ...valid(), content: b64(300000) });
check("server: the request size limit follows max_paste_kib", huge.status === 413, huge.status);

check("no page errors or CSP violations", errors.length === 0, errors.join("\n"));
await browser.close();
finish();
