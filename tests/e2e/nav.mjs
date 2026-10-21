// The header: active links, the Tools menu on desktop and mobile.
import { artifact, BASE, check, finish, launch, watch } from "./lib.mjs";

const browser = await launch();
const errors = [];
const p = await browser.newPage();
await watch(p, errors);

// active highlighting per page
const active = async () => p.$$eval(".navbar .active", (els) => els.map((e) => e.textContent.trim()));
for (const [path, want] of [["/", []], ["/faq", ["FAQ"]], ["/tools/strings", ["Tools"]], ["/tools/base64", ["Tools", "Base64 Encoder & Decoder"]], ["/paste/doesnotexist", []]]) {
  await p.goto(BASE + path, { waitUntil: "networkidle0" });
  const got = await active();
  check(`active on ${path}: ${want.join(", ") || "(none)"}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
const aria = await p.goto(BASE + "/tools/hex", { waitUntil: "networkidle0" }).then(() => p.$$eval('.navbar [aria-current="page"]', (e) => e.map((x) => x.textContent.trim())));
check("aria-current on the current tool only", JSON.stringify(aria) === JSON.stringify(["Text to Hex Converter"]), JSON.stringify(aria));

// desktop
await p.setViewport({ width: 1200, height: 800 });
await p.goto(BASE + "/", { waitUntil: "networkidle0" });
await p.click(".navbar .dropdown-toggle");
await new Promise((r) => setTimeout(r, 300));
const links = await p.$$eval(".tools-menu a", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("href")]));
check("menu lists 3 hub headings + 10 tools", links.length === 13, links.length);
const groups = await p.$$eval(".tools-menu-group", (g) => g.map((x) => x.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.top)]));
check("desktop: groups side by side", groups.length === 3 && groups.every((g) => g[1] === groups[0][1]) && groups[1][0] > groups[0][0]
  && groups[2][0] > groups[1][0], JSON.stringify(groups));
await p.screenshot({ path: artifact("nav-desktop.png"), clip: { x: 0, y: 0, width: 1200, height: 420 } });
let bad = [];
for (const [, href] of links) { const r = await fetch(BASE + href); if (r.status !== 200) bad.push(href + " " + r.status); }
check("every menu link returns 200", bad.length === 0, bad.join(", "));
await p.keyboard.press("ArrowDown");
await p.keyboard.press("ArrowDown");
check("keyboard: arrow keys move through items", (await p.evaluate(() => document.activeElement.textContent.trim())) === "Password Generator", await p.evaluate(() => document.activeElement.textContent.trim()));

// mobile
await p.setViewport({ width: 390, height: 844, isMobile: true });
await p.goto(BASE + "/", { waitUntil: "networkidle0" });
await p.click(".navbar-toggler");
await new Promise((r) => setTimeout(r, 500));
await p.click(".navbar .dropdown-toggle");
await new Promise((r) => setTimeout(r, 300));
const mgroups = await p.$$eval(".tools-menu-group", (g) => g.map((x) => Math.round(x.getBoundingClientRect().top)));
check("mobile: groups stacked", mgroups[1] > mgroups[0], JSON.stringify(mgroups));
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check("mobile: no horizontal scroll", !overflow);
await p.screenshot({ path: artifact("nav-mobile.png"), fullPage: false });
check("no JS errors or CSP violations", errors.length === 0, errors.join(" | "));
await browser.close();
finish();
