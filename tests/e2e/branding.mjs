// A self-hosted copy: site_url https://paste.example.com, no site_name (so
// the host name is used) and source_url pointing at a fork. No page may show
// the upstream name or link (tests/run-e2e.mjs sets this up).
import { execFileSync } from "node:child_process";
import { BASE, check, finish, launch, watch } from "./lib.mjs";

const NAME = "paste.example.com";
const SOURCE = "https://git.example.com/someone/e2epaste-fork";
const PAGES = ["/", "/faq", "/credits", "/tools/password", "/tools/base64", "/paste/AAAAAAAA", "/delete/AAAAAAAA"];

for (const path of PAGES) {
  // The templates escape "/" in attributes as &#x2f;, which browsers decode.
  const html = (await (await fetch(BASE + path)).text()).replaceAll("&#x2f;", "/");
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1] ?? "";
  check(`${path}: title names the site`, title.includes(NAME), title);
  check(`${path}: no upstream name`, !/e2ePaste\.XYZ/i.test(html), html.match(/.{40}e2ePaste\.XYZ.{40}/is)?.[0]);
  check(`${path}: no upstream links`, !html.includes("github.com/bleach86"));
  check(`${path}: link preview uses the name`, html.includes(`property="og:site_name" content="${NAME}"`));
  if (path === "/" || path === "/credits") {
    check(`${path}: source links point at the fork`, html.includes(`href="${SOURCE}"`));
  }
}

const manifest = await fetch(BASE + "/site.webmanifest");
check("manifest: served as a web manifest", manifest.headers.get("content-type").startsWith("application/manifest+json"));
check("manifest: carries the name", (await manifest.json()).name === NAME);

const browser = await launch();
const errors = [];
const page = await browser.newPage();
await watch(page, errors);
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
const brand = await page.$eval(".brand", (e) => ({ text: e.textContent.trim(), suffix: e.querySelector(".brand-suffix")?.textContent }));
check("header: shows the name, last part lighter", brand.text === NAME && brand.suffix === ".com", JSON.stringify(brand));
const icon = await page.$eval(`.site-header a[href="${SOURCE}"] svg`, (svg) => svg.innerHTML);
check("header: generic code icon for a non-GitHub source", !icon.includes("M9 19c-4.3"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "--short", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") ? "-dirty" : "";
const build = await page.$eval(".site-footer a[href*='/commit/']", (a) => ({ text: a.textContent.trim(), href: a.href }));
check("footer: the commit it was built from (and if it had changes), linked at the source",
  build.text === `Build ${commit}${dirty}` && build.href === `${SOURCE}/commit/${commit}`, JSON.stringify(build));
check("no JS errors or CSP violations", errors.length === 0, errors.join(" | "));
await browser.close();
finish();
