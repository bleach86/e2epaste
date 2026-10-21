// A site with attachments turned off (tests/run-e2e.mjs: allow_files =
// false): no attach button, the FAQ says so, and the server refuses them.
import { BASE, check, finish, launch, watch } from "./lib.mjs";

const browser = await launch();
const errors = [];
const p = await browser.newPage();
await p.setViewport({ width: 1280, height: 900 });
await watch(p, errors);
await p.goto(BASE + "/", { waitUntil: "networkidle0" });

check("create page: no attach button", (await p.$("#fileInput")) === null && (await p.$(".file-pick")) === null);
const foot = await p.$eval(".panel-foot", (e) => e.textContent.replace(/\s+/g, " "));
check("create page: limits don't mention files", foot.includes("Up to 1 MB of text") && !foot.includes("file"), foot);

await p.$eval("#paste-area", (el) => { el.value = "no files here"; el.dispatchEvent(new Event("input")); });
await p.click("#submit-paste");
await p.waitForSelector("#url-modal.show", { timeout: 20000 });
check("create page: pastes still work", true);
// Wait for the dialog's fade-in to finish before closing it.
await new Promise((r) => setTimeout(r, 500));
await p.click("#url-modal .btn-close");
await p.waitForFunction(() => document.getElementById("paste-area").value === "", { timeout: 5000 });
check("create page: the form resets without attachments", true);

const faq = await (await fetch(BASE + "/faq")).text();
check("faq: says attachments aren't accepted", /This site doesn't accept\s+attachments/.test(faq));

const b64 = (n) => "A".repeat(Math.floor(n / 3) * 4) + ["", "AA==", "AAA="][n % 3];
const res = await fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: b64(4096 + 16), iv: Array(12).fill(7), expires_in: 3600, max_views: null, key_fragment: "",
    version: 4, title: b64(512 + 16), syntax: "auto", file_name: b64(1024 + 16), file_size: 4096 + 16, access_hash: "ab".repeat(32) }) });
check("server: refuses a paste with an attachment", res.status === 400 && (await res.json()).reason === "this site doesn't accept attachments");

check("no page errors or CSP violations", errors.length === 0, errors.join("\n"));
await browser.close();
finish();
