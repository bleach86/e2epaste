// Language auto-detection, and safe Markdown rendering against hostile
// pastes: scripts, event handlers, javascript: links, tracking images and
// attempts to borrow the site's styles.
import hljs from "highlight.js/lib/common";
import { SAMPLES } from "../fixtures/language_samples.mjs";
import { artifact, BASE, check, finish, launch, local, watch } from "./lib.mjs";

const browser = await launch();
const errors = [];
const requests = [];
async function newPage() {
  const p = await browser.newPage();
  p.on("dialog", async (d) => { errors.push(p.url() + " dialog: " + d.message()); await d.dismiss(); });
  await p.setViewport({ width: 1280, height: 900 });
  p.on("request", (r) => requests.push(r.url()));
  await watch(p, errors);
  return p;
}

// ------------------------------------------------------ detection accuracy
const expected = { c: ["c", "cpp"] }; // C highlighted as C++ is fine
// The page's own display names (js/highlight.mjs) where they differ from highlight.js's.
const DISPLAY = { xml: "HTML/XML", php: "PHP", ini: "INI", bash: "Bash" };
const c = await newPage();
await c.goto(BASE + "/", { waitUntil: "networkidle0" });
check("create: Auto-detect is the default", (await c.$eval("#syntax", (e) => e.value)) === "auto");
let right = 0;
for (const [label, text] of Object.entries(SAMPLES)) {
  await c.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, text);
  await new Promise((r) => setTimeout(r, 400));
  const option = await c.$eval('#syntax option[value="auto"]', (e) => e.textContent);
  const guess = await c.evaluate(() => {
    const m = document.querySelector('#syntax option[value="auto"]').textContent.match(/\((.*)\)/);
    return m ? m[1] : null;
  });
  const want = label.startsWith("plain:") ? null : label;
  // Names as the page shows them: its own (DISPLAY), else highlight.js's,
  // from the same npm package the page bundles.
  const names = [want, ...(expected[want] ?? [])].map((l) => (l ? DISPLAY[l] ?? hljs.getLanguage(l).name : null));
  const good = want === null ? guess === null : names.includes(guess);
  if (good) right++;
  check(`detect ${label}: ${guess ?? "plain text"}`, good, option);
}
console.log(`  ${right}/${Object.keys(SAMPLES).length} samples right`);
const highlighted = await c.evaluate(() => {
  const area = document.getElementById("paste-area");
  area.value = "fn main() {\n    let x: Vec<u32> = vec![1, 2, 3];\n    println!(\"{:?}\", x);\n}\n";
  area.dispatchEvent(new Event("input"));
  return new Promise((r) => setTimeout(() => r(document.querySelectorAll("#paste-highlight span").length), 400));
});
check("create: live highlighting follows the guess", highlighted > 0);

// ------------------------------------------------ auto paste, viewed
await c.click("#submit-paste");
await c.waitForSelector("#url-modal.show", { timeout: 20000 });
const autoUrl = await c.$eval("#paste-url", (e) => e.value);
check("create: picker resets to plain Auto-detect", true);
const v = await newPage();
await v.goto(local(autoUrl), { waitUntil: "networkidle0" });
await v.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
check("view: chip shows the detected language", (await v.$eval("#language-name", (e) => e.textContent)) === "Rust (detected)", await v.$eval("#language-name", (e) => e.textContent));
check("view: highlighted", (await v.$$eval("#view-area span", (s) => s.length)) > 0);
check("view: no Markdown toggle for Rust", await v.$eval("#markdown-toggle", (e) => e.hidden));
await v.close();

// ------------------------------------------------------- markdown, nasty
const NASTY = [
  "# Heading",
  "Some **bold**, _italic_, `code` and a [safe link](https://example.com/page).",
  "- [x] done\n- [ ] not done",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "```rust\nfn main() {}\n```",
  "> quoted",
  '<script>window.__xss = "script"</script>',
  '<img src="x" onerror="window.__xss = \'onerror\'">',
  "[js link](javascript:window.__xss='link')",
  '<a href="javascript:window.__xss=1">raw js link</a>',
  '<iframe src="https://evil.example/"></iframe>',
  '<form action="https://evil.example/"><input name="q"><button>Go</button></form>',
  '<div class="notice btn btn-accent" style="position:fixed;inset:0">fake UI</div>',
  '<svg><script>window.__xss="svg"</script></svg>',
  "![tracker](https://tracker.example/pixel.gif)",
  '<img src="/api/open/AAAAAAAA">',
  "![inline](data:image/gif;base64,R0lGODlhAQABAAAAACw=)",
  "[jump](#section)",
  '<a href="//evil.example/x">protocol-relative</a>',
  "<details open><summary>more</summary>hidden text</details>",
  '<p id="paste-title" name="copy-paste-btn">clobber attempt</p>',
].join("\n\n");

await c.goto(BASE + "/", { waitUntil: "networkidle0" });
await c.select("#syntax", "markdown");
await c.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, NASTY);
await c.click("#submit-paste");
await c.waitForSelector("#url-modal.show", { timeout: 20000 });
const mdUrl = await c.$eval("#paste-url", (e) => e.value);

requests.length = 0;
const m = await newPage();
await m.goto(local(mdUrl), { waitUntil: "networkidle0" });
await m.waitForFunction(() => !document.getElementById("markdown-view").hidden, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));
const hashBefore = await m.evaluate(() => location.hash);
const report = await m.evaluate(() => {
  const md = document.getElementById("markdown-view");
  return {
    xss: window.__xss ?? null,
    scripts: md.querySelectorAll("script").length,
    handlers: [...md.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on"))).length,
    styles: md.querySelectorAll("[style]").length,
    classes: [...md.querySelectorAll("[class]")].map((e) => `${e.tagName}.${e.className}`),
    ids: md.querySelectorAll("[id],[name]").length,
    forbidden: md.querySelectorAll("iframe,form,button,svg,object,embed").length,
    inputs: [...md.querySelectorAll("input")].map((i) => `${i.type}:${i.disabled}`),
    hrefs: [...md.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
    links: [...md.querySelectorAll("a[href]")].every((a) => a.target === "_blank" && a.rel.includes("noopener") && a.rel.includes("noreferrer")),
    imgs: [...md.querySelectorAll("img")].map((i) => i.getAttribute("src").slice(0, 15)),
    imageLinks: [...md.querySelectorAll(".md-image-link")].map((e) => e.textContent),
    h1: md.querySelector("h1")?.textContent,
    table: md.querySelectorAll("table td").length,
    codeHighlighted: md.querySelectorAll("pre code.hljs span").length,
    quote: md.querySelector("blockquote")?.textContent.trim(),
    details: md.querySelectorAll("details").length,
    rawShownAsText: md.textContent.includes('<script>window.__xss = "script"</script>') && md.textContent.includes("<details open>"),
    titleIntact: document.getElementById("paste-title").tagName === "H1",
  };
});
check("md: rendered by default when Markdown was chosen", !(await m.$eval("#markdown-toggle", (e) => e.hidden)) && (await m.$eval("#code-view", (e) => e.hidden)));
check("md: no script ran", report.xss === null, report.xss);
check("md: no <script>, event handlers or style attributes", report.scripts === 0 && report.handlers === 0 && report.styles === 0, JSON.stringify(report));
check("md: no iframe, form, button or SVG", report.forbidden === 0);
// Only code block languages, our image links and highlight.js's own spans.
check("md: no site classes borrowed (only code languages)", report.classes.every((c) => /^CODE\.language-\w+( hljs)?$|^(A|SPAN)\.md-image-link$|^SPAN\.hljs-/.test(c)), report.classes.join(" "));
check("md: no id/name attributes (DOM clobbering)", report.ids === 0 && report.titleIntact);
check("md: task list checkboxes kept, read-only", report.inputs.join() === "checkbox:true,checkbox:true", report.inputs.join());
check("md: only http(s) links kept", report.hrefs.every((h) => /^https:\/\//.test(h)) && report.hrefs.includes("https://example.com/page"), report.hrefs.join(" "));
check("md: links open in a new tab without referrer", report.links);
check("md: remote images become links, not loaded", report.imageLinks.some((t) => t.includes("tracker")) && !requests.some((u) => u.includes("tracker.example")), report.imageLinks.join(" | "));
check("md: same-site image paths not requested", !requests.some((u) => u.includes("/api/open/AAAAAAAA")));
check("md: inline data: image allowed", report.imgs.length === 1 && report.imgs[0].startsWith("data:image/gif"), report.imgs.join());
check("md: headings, tables and quotes render", report.h1 === "Heading" && report.table === 2 && report.quote === "quoted", JSON.stringify(report));
check("md: raw HTML is shown as text, not rendered", report.rawShownAsText && report.details === 0);
check("md: fenced code highlighted", report.codeHighlighted > 0);
await m.click("#markdown-view");
check("md: the #secret stays in the address bar", (await m.evaluate(() => location.hash)) === hashBefore);
check("md: no requests to other sites", !requests.some((u) => !u.startsWith(BASE) && !u.startsWith("data:")), requests.filter((u) => !u.startsWith(BASE)).join(" "));

// Back to the top first: Puppeteer would otherwise click the toggle while
// it's under the sticky header.
await m.evaluate(() => scrollTo(0, 0));
check("md: the source isn't filled in until it's asked for", await m.$eval("#view-area", (e) => e.childNodes.length === 0));
await m.click('#markdown-toggle [data-view="source"]');
const sourceState = await m.evaluate(() => ({ codeShown: !document.getElementById("code-view").hidden, hasScriptText: document.getElementById("view-area").textContent.includes("<script>"), start: document.getElementById("view-area").textContent.slice(0, 40) }));
check("md: Source shows the raw text", sourceState.codeShown && sourceState.hasScriptText, JSON.stringify(sourceState));
check("md: Copy still copies the source", true);
await m.click('#markdown-toggle [data-view="rendered"]');
check("md: back to Rendered", !(await m.$eval("#markdown-view", (e) => e.hidden)));

await m.setViewport({ width: 390, height: 844 });
check("md: no horizontal page scroll on mobile", await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await m.screenshot({ path: artifact("markdown.png") });

// ------------------------------------- auto-detected markdown starts as source
// Puppeteer can't click in a background tab, so close the viewer first.
await m.close();
await c.bringToFront();
await c.goto(BASE + "/", { waitUntil: "networkidle0" });
await c.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, SAMPLES.markdown);
await new Promise((r) => setTimeout(r, 400));
await c.click("#submit-paste");
await c.waitForSelector("#url-modal.show", { timeout: 20000 });
const autoMd = await c.$eval("#paste-url", (e) => e.value);
const am = await newPage();
await am.goto(local(autoMd), { waitUntil: "networkidle0" });
await am.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
check("auto md: toggle offered, starts as source", !(await am.$eval("#markdown-toggle", (e) => e.hidden)) && !(await am.$eval("#code-view", (e) => e.hidden)));

// ------------------------------------------------------------- long paste
// Over 100,000 characters: shown plain in blocks of 200 lines at once, then
// highlighted in a worker and coloured a block at a time (paste.mjs).
await am.close();
await c.bringToFront();
const filler = Array.from({ length: 198 }, (_, i) => `let a${i} = ${i};`);
// A comment across the first block boundary (lines 199-202), and one very long line.
const comment = ["/* starts in block one", "still in block one", "carries on in block two", "ends here */"];
const longLine = `const long = "${"x".repeat(3000)}";`;
let body = "";
while (body.length < 300000) body += "function f(x) {\n  return x * 2; // double\n}\n";
const longText = [...filler, ...comment, longLine, body].join("\n");
await c.goto(BASE + "/", { waitUntil: "networkidle0" });
await c.select("#syntax", "javascript");
await c.$eval("#paste-area", (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, longText);
await c.click("#submit-paste");
await c.waitForSelector("#url-modal.show", { timeout: 20000 });
const longUrl = await c.$eval("#paste-url", (e) => e.value);
const lp = await newPage();
await lp.goto(local(longUrl), { waitUntil: "networkidle0" });
await lp.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
const lines = longText.split("\n").length;
const shown = await lp.evaluate(() => ({
  blocks: document.querySelectorAll("#view-area > .code-block").length,
  same: document.getElementById("view-area").textContent,
}));
check("long: shown in blocks of 200 lines", shown.blocks === Math.ceil(lines / 200), `${shown.blocks} blocks for ${lines} lines`);
check("long: exactly the paste's text", shown.same === longText);
const coloured = await lp.waitForFunction(
  () => [...document.querySelectorAll("#view-area > .code-block")].every((b) => b.querySelector("span")),
  { timeout: 30000 },
).then(() => true, () => false);
check("long: every block gets coloured", coloured);
const boundary = await lp.evaluate(() => {
  const second = document.querySelectorAll("#view-area > .code-block")[1];
  const first = second.firstElementChild;
  return { cls: first?.className, text: first?.textContent.slice(0, 23), same: document.getElementById("view-area").textContent };
});
check("long: a comment across blocks is still a comment", boundary.cls === "hljs-comment" && boundary.text === "carries on in block two", JSON.stringify({ cls: boundary.cls, text: boundary.text }));
check("long: still exactly the text once coloured", boundary.same === longText);
const layout = await lp.evaluate(() => {
  const blocks = document.querySelectorAll("#view-area > .code-block");
  blocks[1].scrollIntoView();
  const lineHeight = parseFloat(getComputedStyle(blocks[0]).lineHeight);
  const pre = document.querySelector(".code-body");
  return {
    first: blocks[0].getBoundingClientRect().height / lineHeight,
    second: blocks[1].getBoundingClientRect().height / lineHeight,
    total: document.getElementById("view-area").getBoundingClientRect().height,
    gutter: document.getElementById("code-gutter").getBoundingClientRect().height,
    // Scrolled to its end, the end of the long line is in view.
    scrolls: (() => {
      pre.scrollLeft = pre.scrollWidth;
      const end = blocks[1].getBoundingClientRect().right;
      return pre.scrollWidth > 3000 * 7 && end <= pre.getBoundingClientRect().right + 20;
    })(),
    width: [pre.scrollWidth, blocks[1].getBoundingClientRect().width],
  };
});
check("long: each block is exactly its lines tall", layout.first === 200 && layout.second === 200, JSON.stringify(layout));
check("long: the text lines up with the line numbers", Math.abs(layout.total + 32 - layout.gutter) < 2, JSON.stringify(layout));
check("long: a very long line scrolls, not cut off", layout.scrolls, JSON.stringify(layout));
await lp.evaluate(() => scrollTo(0, 0));
await lp.click("#wrap-btn");
const wrapped = await lp.evaluate(() => {
  const pre = document.querySelector(".code-body");
  return pre.scrollWidth <= pre.clientWidth + 1;
});
check("long: Wrap wraps the long line", wrapped);
await lp.screenshot({ path: artifact("long_paste.png") });

check("no JS errors or CSP violations", errors.length === 0, JSON.stringify(errors));
await browser.close();
finish();
