// A page loaded over plain HTTP from a name that isn't localhost, where
// browsers turn off Web Crypto: the warning banner, a disabled submit button,
// and no decryption (so no view is used).
import { artifact, BASE, check, finish, launch, PORT, watch } from "./lib.mjs";

// insecure.test is a non-loopback name, so http:// there is not a secure context.
const INSECURE = `http://insecure.test:${PORT}`;
const browser = await launch(["--host-resolver-rules=MAP insecure.test 127.0.0.1"]);
const errors = [];
const page = await browser.newPage();
await watch(page, errors);
await page.setViewport({ width: 1280, height: 800 });

// Secure (localhost): no banner.
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
check("localhost: banner hidden", await page.$eval("#insecure-warning", (e) => e.hidden));
check("localhost: submit enabled", !(await page.$eval("#submit-paste", (e) => e.disabled)));

// Make a paste over the secure origin to open insecurely.
await page.type("#paste-area", "secret text");
await page.click("#submit-paste");
await page.waitForFunction(() => document.getElementById("paste-url").value.includes("#"));
const link = await page.$eval("#paste-url", (e) => e.value);
const [, id, secret] = link.match(/\/s\/(\w+)#(.+)$/);

await page.goto(INSECURE + "/", { waitUntil: "networkidle0" });
check("insecure: isSecureContext false", !(await page.evaluate(() => window.isSecureContext)));
check("insecure: banner shown", !(await page.$eval("#insecure-warning", (e) => e.hidden)));
check("insecure: submit disabled", await page.$eval("#submit-paste", (e) => e.disabled));
await page.screenshot({ path: artifact("insecure-home.png") });
const href = await page.$eval("#insecure-https-link", (e) => (e.hidden ? null : e.getAttribute("href")));
check("insecure: HTTPS link " + href, href === "https://insecure.test/");

const viewRequests = [];
page.on("request", (r) => r.url().includes("/api/open/") && viewRequests.push(r.url()));
await page.goto(`${INSECURE}/s/${id}#${secret}`, { waitUntil: "networkidle0" });
check("insecure paste: redirected to /paste/ with hash", page.url().endsWith(`/paste/${id}#${secret}`));
check("insecure paste: banner shown", !(await page.$eval("#insecure-warning", (e) => e.hidden)));
check("insecure paste: nothing decrypted", (await page.$eval("#view-area", (e) => e.textContent)) === "");
check("insecure paste: no view used", viewRequests.length === 0);
const pasteHref = await page.$eval("#insecure-https-link", (e) => e.getAttribute("href"));
check("insecure paste: HTTPS link keeps the secret", pasteHref === `https://insecure.test/paste/${id}#${secret}`);

await page.setViewport({ width: 390, height: 844 });
await page.reload({ waitUntil: "networkidle0" });
check("mobile: no horizontal scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.screenshot({ path: artifact("insecure-mobile.png") });

// The paste still opens fine afterwards from the secure origin.
await page.goto(`${BASE}/paste/${id}#${secret}`, { waitUntil: "networkidle0" });
await page.waitForFunction(() => document.getElementById("view-area").textContent !== "");
check("secure paste still decrypts", (await page.$eval("#view-area", (e) => e.textContent)) === "secret text");
check("no JS errors or CSP violations", errors.length === 0, errors.join(" | "));
await browser.close();
finish();
