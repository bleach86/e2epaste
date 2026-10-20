// On phones the create page pins "Encrypt & get link" to the bottom of the
// screen; scrolled to the end, the footer must sit above it, not under it.
import { artifact, BASE, check, finish, launch } from "./lib.mjs";

const browser = await launch();
const p = await browser.newPage();
for (const [w, h] of [[390, 844], [360, 640], [768, 1024]]) {
  await p.setViewport({ width: w, height: h, isMobile: true });
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await new Promise((r) => setTimeout(r, 200));
  const gap = await p.evaluate(() => {
    const footer = document.querySelector(".site-footer").getBoundingClientRect();
    const button = document.getElementById("submit-paste").getBoundingClientRect();
    return Math.round(button.top - footer.bottom);
  });
  check(`${w}x${h}: footer clear of the button`, gap >= 0, `overlaps by ${-gap}px`);
  if (w === 390) await p.screenshot({ path: artifact("mobile-footer.png") });
}
await p.setViewport({ width: 1280, height: 900 });
await p.goto(BASE + "/", { waitUntil: "networkidle0" });
check("desktop: no extra space under the footer", (await p.evaluate(() => getComputedStyle(document.body).paddingBottom)) === "0px");
await browser.close();
finish();
