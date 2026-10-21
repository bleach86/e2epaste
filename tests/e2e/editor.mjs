// The create page's editor keys (js/editor_keys.mjs): Tab, Shift+Tab, Enter's
// auto-indent and Escape, with the highlighting kept in step and Ctrl+Z
// still working.
import { BASE, check, finish, launch, watch } from "./lib.mjs";

const browser = await launch();
const errors = [];
const p = await browser.newPage();
await p.setViewport({ width: 1280, height: 900 });
await watch(p, errors);
await p.goto(BASE + "/", { waitUntil: "networkidle0" });

const value = () => p.$eval("#paste-area", (e) => e.value);
// The highlighting overlay shows exactly the textarea's text.
const inStep = () => p.evaluate(() => document.getElementById("paste-highlight").textContent === document.getElementById("paste-area").value);
const press = async (...keys) => {
  for (const key of keys) await p.keyboard.press(key);
};
const chord = async (modifier, key) => {
  await p.keyboard.down(modifier);
  await p.keyboard.press(key);
  await p.keyboard.up(modifier);
};
// Sets the text (as a paste would) and puts the caret, or a selection, at
// the given offsets.
async function setText(text, start = text.length, end = start) {
  await p.$eval("#paste-area", (el, t, s, e) => {
    el.focus();
    el.value = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(s, e);
  }, text, start, end);
}

// Enough Rust to be detected, so the highlighting overlay is showing.
const RUST = 'use std::collections::HashMap;\n\nfn main() {\n    let m: HashMap<String, u32> = HashMap::new();\n    println!("{:?}", m);\n}\n\n';
await setText(RUST);
await p.waitForFunction(() => document.querySelector('#syntax option[value="auto"]').textContent.includes("Rust"));
check("detected as Rust, highlighting on", await p.$eval("#paste-editor", (e) => e.classList.contains("highlighting")));

// The reported case: Enter between the braces.
await p.keyboard.type("fn thing() -> String {}");
await press("ArrowLeft", "Enter");
check("enter: new line inside the braces", (await value()).endsWith("fn thing() -> String {\n}"), JSON.stringify((await value()).slice(-30)));
check("enter: highlighting shows it straight away", await inStep());

// Enter keeps the line's indentation.
await setText(RUST + "fn f() {\n    let x = 1;");
await press("Enter");
await p.keyboard.type("x");
check("enter: keeps the indentation", (await value()).endsWith("    let x = 1;\n    x"), JSON.stringify((await value()).slice(-24)));
check("enter: in step after typing on", await inStep());

// Tab, then undo.
await setText(RUST + "fn g() {\n}", RUST.length + 8);
await press("Tab");
check("tab: inserts a tab", (await value()).endsWith("fn g() {\t\n}"), JSON.stringify((await value()).slice(-12)));
check("tab: highlighting shows it straight away", await inStep());
await chord("Control", "z");
check("tab: Ctrl+Z undoes it", (await value()).endsWith("fn g() {\n}"), JSON.stringify((await value()).slice(-12)));
check("tab: in step after undo", await inStep());
await press("Enter");
await chord("Control", "z");
check("enter: Ctrl+Z undoes it", (await value()).endsWith("fn g() {\n}"), JSON.stringify((await value()).slice(-12)));

// Several lines selected: Tab indents each, Shift+Tab takes it off again.
const block = "a();\nb();\n\nc();";
await setText(RUST + block, RUST.length, RUST.length + block.length);
await press("Tab");
check("tab: indents every selected line, not empty ones", (await value()).endsWith("\ta();\n\tb();\n\n\tc();"), JSON.stringify((await value()).slice(-20)));
check("tab: the indented lines stay selected", await p.$eval("#paste-area", (e) => e.value.slice(e.selectionStart, e.selectionEnd) === "\ta();\n\tb();\n\n\tc();"));
await chord("Shift", "Tab");
check("shift+tab: outdents them again", (await value()).endsWith("\n" + block));
check("shift+tab: in step", await inStep());

// Shift+Tab on one line takes off up to four spaces, keeping the caret's
// place in the text.
await setText(RUST + "      x();", RUST.length + 6);
await chord("Shift", "Tab");
const [line, afterCaret] = await p.$eval("#paste-area", (e) => [e.value.slice(e.value.lastIndexOf("\n") + 1), e.value.slice(e.selectionStart)]);
check("shift+tab: one line loses one indent", line === "  x();", JSON.stringify(line));
check("shift+tab: caret stays before the same text", afterCaret === "x();", JSON.stringify(afterCaret));

// Escape, then Tab, leaves the editor (for keyboard users).
await setText(RUST);
await press("Escape", "Tab");
check("escape then tab: moves focus on", await p.evaluate(() => document.activeElement?.id !== "paste-area"));
check("escape then tab: nothing inserted", (await value()) === RUST);
await p.focus("#paste-area");
await press("Tab");
check("tab: indents again after coming back", (await value()) === RUST + "\t");

check("no page errors or CSP violations", errors.length === 0, errors.join("\n"));
await browser.close();
finish();
