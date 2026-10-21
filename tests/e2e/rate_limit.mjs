// Paste creation limits (default settings: 10 pastes a minute, 250 MiB of
// attachments an hour): creating pastes until the server refuses one, and
// the message saying which limit it was.
import { BASE, check, finish, launch } from "./lib.mjs";

const browser = await launch();
const page = await browser.newPage();
let dialog = null;
page.on("dialog", async (d) => {
  dialog = d.message();
  await d.dismiss();
});

let created = 0;
for (let i = 0; i < 15 && !dialog; i++) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.type("#paste-area", "hello " + i);
  await page.click("#submit-paste");
  await page.waitForFunction(
    () => document.getElementById("paste-url").value.includes("#") || !document.getElementById("submit-paste").disabled,
    { timeout: 10000 },
  );
  await new Promise((r) => setTimeout(r, 300));
  if (!dialog) created++;
}

// The bucket refills while the loop runs, so a few more than 10 can get in.
check("rate limit: about 10 pastes before refusing", created >= 10 && created <= 12, `created ${created}`);
check("rate limit: says which limit and how long to wait",
  /^You've created 10 pastes in the last minute, this site's limit\. Please try again in \d+ (second|minute)s?\.$/.test(dialog ?? ""), dialog);
check("rate limit: button usable again afterwards", !(await page.$eval("#submit-paste", (e) => e.disabled)));

// The server names the limit and its setting.
const b64 = (n) => "A".repeat(Math.floor(n / 3) * 4) + ["", "AA==", "AAA="][n % 3];
const paste = (fileSize) => ({ content: b64(4096 + 16), iv: Array(12).fill(7), expires_in: 3600, max_views: null,
  key_fragment: "", version: 4, title: b64(512 + 16), syntax: "auto", access_hash: "ab".repeat(32),
  file_name: fileSize ? b64(1024 + 16) : null, file_size: fileSize });
const submit = (body, ip) => fetch(BASE + "/api/submit_paste", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify(body) });
let res;
for (let i = 0; i < 11; i++) res = await submit(paste(null), "192.0.2.50");
const minute = await res.json();
check("rate limit: the response names the limit", res.status === 429 && minute.limit === "pastes_per_minute" && minute.allowed === 10, JSON.stringify(minute));

// 25 MB attachments, each stored as about 25.5 MiB: the tenth would go over
// 250 MiB an hour while the per-minute limit still has room.
const maxFile = 26738688 + 26 * 16;
for (let i = 0; i < 10; i++) res = await submit(paste(maxFile), "192.0.2.51");
const upload = await res.json();
check("rate limit: the hourly attachment allowance is named as such",
  res.status === 429 && upload.limit === "upload_mib_per_hour" && upload.allowed === 250, JSON.stringify(upload));
check("rate limit: a paste without an attachment still goes through", (await submit(paste(null), "192.0.2.51")).status === 200);
await browser.close();
finish();
