// Shared setup for the browser suites. tests/run-e2e.mjs runs each suite
// against its own server, at BASE_URL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BASE = process.env.BASE_URL ?? "http://localhost:8765";
export const PORT = new URL(BASE).port;

// Screenshots go here; CI keeps them when a run fails.
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? path.join(os.tmpdir(), "e2epaste-artifacts");
export function artifact(name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  return path.join(ARTIFACTS, name);
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function launch(args = []) {
  const executablePath = CHROME_PATHS.find((p) => p && fs.existsSync(p));
  if (!executablePath) {
    throw new Error("Chrome not found. Install it, or set CHROME_PATH to its executable.");
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    // CI runners don't allow Chrome's sandbox.
    args: ["--no-sandbox", ...args],
  });
}

// A link the app made for this site's real address, pointed at the test server.
export const local = (url) => url.replace(/^https?:\/\/[^/]+/, BASE);

let failures = 0;

export function check(label, passed, detail = "") {
  console.log((passed ? "PASS " : "FAIL ") + label + (passed || detail === "" ? "" : `  ${detail}`));
  if (!passed) {
    failures++;
  }
}

// Prints the result and sets the exit code; call at the end of a suite.
export function finish() {
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exitCode = failures ? 1 : 0;
}

// Records page errors, Content-Security-Policy violations and unexpected
// dialogs in `errors`.
export async function watch(page, errors) {
  page.on("pageerror", (e) => errors.push(`${page.url()} ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  page.on("console", (m) => m.text().startsWith("CSP violation") && errors.push(`${page.url()} ${m.text()}`));
}
