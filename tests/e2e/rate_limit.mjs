// Paste creation limits: creating pastes until the server's per-IP limit
// (default settings: 10 a minute) refuses one, and the message the page shows.
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
check("rate limit: says how long to wait", /lot of pastes.*try again in \d+ (second|minute)s?\./.test(dialog ?? ""), dialog);
check("rate limit: button usable again afterwards", !(await page.$eval("#submit-paste", (e) => e.disabled)));
await browser.close();
finish();
