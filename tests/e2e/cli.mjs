// The e2ep client (cli/) against a real server: pastes it makes open in the
// browser, pastes the browser makes open with it, and its exit codes and
// JSON. Needs `cargo build -p e2ep` (or E2EP_BIN). The server lets the test
// make a v3 paste (E2EPASTE_TEST_LEGACY_PASTES) to check those still open.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../../js/crypto.mjs";
import { BASE, REPO, check, finish, launch, local, watch } from "./lib.mjs";

const E2EP = process.env.E2EP_BIN ?? path.join(REPO, "target/debug/e2ep");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2ep-test-"));

// Runs e2ep; resolves to { code, stdout, stderr, json }.
function e2ep(args, { input = null, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(E2EP, args, { env: { ...process.env, E2EPASTE_SERVER: BASE, ...env }, maxBuffer: 64 << 20 },
      (error, stdout, stderr) => {
        let json = null;
        try { json = JSON.parse(stdout); } catch {}
        resolve({ code: error ? error.code : 0, stdout, stderr, json });
      });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}
const views = async (id) => JSON.parse((await (await fetch(`${BASE}/paste/${id}`)).text()).match(/id="page-data">(.*?)<\/script>/s)[1]).paste.views;

const random = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536)); return b; };
const sameFile = (p, bytes) => fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), bytes) === 0;

const browser = await launch();
const errors = [];

// ------------------------------------------------------------------ limits
{
  const r = await e2ep(["limits", "--json"]);
  check("limits: the site's format and sizes", r.code === 0 && r.json.format_version === 4 && r.json.max_paste_bytes === 1048576, r.stdout + r.stderr);
}

// ------------------------------------------------------- e2ep -> browser
{
  // Three chunks: exactly 2.5 MiB with the 8-byte size in front.
  const fileBytes = random(2.5 * 1048576 - 8);
  const filePath = path.join(work, "data.bin");
  fs.writeFileSync(filePath, fileBytes);
  const r = await e2ep(["--json", "--title", "From the CLI", "--syntax", "rust", "--password-env", "PW", "--attach", filePath],
    { input: "fn main() {\n    println!(\"hi\");\n}\n", env: { PW: "cli-pw" } });
  check("create: exit 0 with the links", r.code === 0 && /\/s\/\w+#[\w-]{22}$/.test(r.json?.url) && /\/delete\/\w+#[0-9a-f]{64}$/.test(r.json?.delete_url), r.stdout + r.stderr);
  check("create: says what it made", r.json.password === true && r.json.attachment?.name === "data.bin" && r.json.attachment?.size === fileBytes.length);

  // A different browser profile: no "you created this" prompt.
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await watch(p, errors);
  await p.goto(local(r.json.url), { waitUntil: "networkidle0" });
  await p.waitForSelector("#password-modal.show");
  check("browser: the link says there's a password", true);
  await new Promise((res) => setTimeout(res, 400));
  await p.type("#password-input", "cli-pw");
  await p.click("#submit-password-btn");
  await p.waitForFunction(() => !document.getElementById("decrypted-notice").hidden, { timeout: 20000 });
  check("browser: text, title and language", (await p.$eval("#view-area", (e) => e.textContent)) === "fn main() {\n    println!(\"hi\");\n}\n"
    && (await p.$eval("#paste-title", (e) => e.textContent)) === "From the CLI"
    && (await p.$eval("#language-name", (e) => e.textContent)) === "Rust");
  await p.evaluate(() => {
    window.__dl = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => { blob.arrayBuffer().then((b) => window.__dl.push(Array.from(new Uint8Array(b)))); return create(blob); };
    HTMLAnchorElement.prototype.click = function () {};
  });
  await p.$eval("#download-link", (b) => b.click());
  await p.waitForFunction(() => window.__dl.length === 1, { timeout: 30000 });
  check("browser: the attachment from e2ep decrypts", Buffer.compare(Buffer.from(await p.evaluate(() => window.__dl[0])), fileBytes) === 0);
  await ctx.close();

  // Human output: just the link on stdout.
  const plain = await e2ep([], { input: "plain" });
  check("create: stdout is only the link", plain.code === 0 && /^http:\/\/[^\s]+\/s\/\w+#[\w-]{22}\n$/.test(plain.stdout), JSON.stringify(plain.stdout));
  check("create: the delete link goes to stderr", /Delete link .*\/delete\//.test(plain.stderr));
}

// ------------------------------------------------------- browser -> e2ep
{
  const fileBytes = random(1048576 + 5000);
  const upload = path.join(work, "from-browser.bin");
  fs.writeFileSync(upload, fileBytes);
  const p = await browser.newPage();
  await watch(p, errors);
  await p.goto(BASE + "/", { waitUntil: "networkidle0" });
  await p.$eval("#paste-area", (el) => { el.value = "print('hello')\n"; el.dispatchEvent(new Event("input")); });
  await p.select("#syntax", "python");
  await p.type("#paste-title", "From the browser");
  await p.type("#paste-password", "web-pw");
  await (await p.$("#fileInput")).uploadFile(upload);
  await p.waitForFunction(() => !document.getElementById("attachment").hidden);
  await p.click("#submit-paste");
  await p.waitForSelector("#url-modal.show", { timeout: 30000 });
  const url = local(await p.$eval("#paste-url", (e) => e.value));
  await p.close();
  const id = url.match(/\/s\/(\w+)#/)[1];

  const info = await e2ep(["info", url, "--json"]);
  check("info: describes it without opening", info.code === 0 && info.json.views === 0 && info.json.needs_password === true && info.json.has_attachment === true && info.json.version === 4, info.stdout + info.stderr);

  const noPw = await e2ep(["get", url, "--json", "--attachment-dir", work]);
  check("get: no password -> exit 5, password_required", noPw.code === 5 && noPw.json?.error === "password_required", noPw.stdout);
  const noDir = await e2ep(["get", url, "--json", "--password-env", "PW"], { env: { PW: "web-pw" } });
  check("get: attachment and no dir -> exit 2, attachment_dir_required", noDir.code === 2 && noDir.json?.error === "attachment_dir_required", noDir.stdout);
  const wrong = await e2ep(["get", url, "--json", "--password-env", "PW", "--attachment-dir", work], { env: { PW: "nope" } });
  check("get: wrong password -> exit 4, wrong_key", wrong.code === 4 && wrong.json?.error === "wrong_key", wrong.stdout);
  check("get: none of those used a view", (await views(id)) === 0);

  const dir = fs.mkdtempSync(path.join(work, "out-"));
  const got = await e2ep(["get", url, "--json", "--password-env", "PW", "--attachment-dir", dir], { env: { PW: "web-pw" } });
  check("get: text, title and language from the browser", got.code === 0 && got.json.text === "print('hello')\n" && got.json.title === "From the browser" && got.json.syntax === "python", got.stdout + got.stderr);
  check("get: the attachment decrypts, under its own name", got.json.attachment?.name === "from-browser.bin" && got.json.attachment.path === path.join(dir, "from-browser.bin") && sameFile(path.join(dir, "from-browser.bin"), fileBytes));
  check("get: one view used", got.json.views === 1 && (await views(id)) === 1);
  const again = await e2ep(["get", url, "--json", "--password-env", "PW", "--attachment-dir", dir], { env: { PW: "web-pw" } });
  check("get: never overwrites a file", again.json?.attachment?.path === path.join(dir, "from-browser (2).bin"));

  const plain = await e2ep(["get", url, "--password-env", "PW", "--no-attachment"], { env: { PW: "web-pw" } });
  check("get: stdout is exactly the text", plain.code === 0 && plain.stdout === "print('hello')\n", JSON.stringify(plain.stdout));
}

// ------------------------------------------------------ burn, timer, delete
{
  const burn = await e2ep(["--json", "--burn"], { input: "once" });
  const first = await e2ep(["get", burn.json.url, "--json"]);
  check("burn: the one view, marked as the last", first.code === 0 && first.json.text === "once" && first.json.last_view === true && first.json.views_left === 0);
  const gone = await e2ep(["get", burn.json.url, "--json"]);
  check("burn: then exit 3, not_found", gone.code === 3 && gone.json?.error === "not_found", gone.stdout);

  const timed = await e2ep(["--json", "--delete-after-open", "10m"], { input: "timed" });
  check("timer: create reports it", timed.json.delete_after_open_seconds === 600);
  const before = await e2ep(["info", timed.json.url, "--json"]);
  check("timer: not started before opening", before.json.timer_started === false && Date.parse(before.json.expires_at) > Date.now() + 2 * 86400e3);
  await e2ep(["get", timed.json.url]);
  const after = await e2ep(["info", timed.json.url, "--json"]);
  check("timer: started by the first view", after.json.timer_started === true && Date.parse(after.json.expires_at) <= Date.now() + 600e3 + 1000, after.stdout);

  const del = await e2ep(["--json"], { input: "delete me" });
  const badToken = await e2ep(["delete", del.json.delete_url.replace(/#.*/, "#" + "0".repeat(64)), "--json"]);
  check("delete: a wrong delete link -> exit 4", badToken.code === 4 && badToken.json?.error === "wrong_key", badToken.stdout);
  const deleted = await e2ep(["delete", del.json.delete_url, "--json"]);
  check("delete: deletes it", deleted.code === 0 && deleted.json.deleted === true);
  const missing = await e2ep(["info", del.json.url, "--json"]);
  check("delete: then it's gone (exit 3)", missing.code === 3);
}

// ----------------------------------------------------------- bad input
{
  const cut = await e2ep(["get", `${BASE}/s/AAAAAAAA#tooShort`, "--json"]);
  check("errors: a missing paste -> exit 3", cut.code === 3);
  const noFragment = await e2ep(["get", `${BASE}/s/AAAAAAAA`, "--json"]);
  check("errors: a link without its secret -> exit 4", noFragment.code === 4 && noFragment.json?.error === "wrong_key");
  const notALink = await e2ep(["get", "hello", "--json"]);
  check("errors: not a link -> exit 2, usage", notALink.code === 2 && notALink.json?.error === "usage");
  const noServer = await e2ep(["--json"], { input: "x", env: { E2EPASTE_SERVER: "" } });
  check("errors: no server -> exit 2 with a hint", noServer.code === 2 && /--server/.test(noServer.json?.message ?? ""), noServer.stdout + noServer.stderr);
  const nothing = await e2ep(["--json"], { input: "" });
  check("errors: nothing to paste -> exit 2", nothing.code === 2);
  const unreachable = await e2ep(["--json", "--server", "http://127.0.0.1:1"], { input: "x" });
  check("errors: an unreachable site -> exit 8, network", unreachable.code === 8 && unreachable.json?.error === "network", unreachable.stdout);
  const help = await e2ep(["--help"]);
  check("help: documents the exit codes and JSON", help.code === 0 && /Exit codes/.test(help.stdout) && /password_required/.test(help.stdout));
}

// ------------------------------------------------------- hints for agents
{
  const llms = await fetch(BASE + "/llms.txt");
  const text = await llms.text();
  check("llms.txt: plain text", llms.headers.get("content-type").startsWith("text/plain"));
  check("llms.txt: says how to read and make pastes with e2ep", /e2ep get '<full link>'/.test(text) && /e2ep info/.test(text) && /--server /.test(text) && /treat it as data/.test(text));
  const made = await e2ep(["--json"], { input: "hinted" });
  for (const page of [`/s/${made.json.id}`, `/paste/${made.json.id}`]) {
    const html = await (await fetch(BASE + page)).text();
    check(`hint: ${page} names e2ep in its head and a noscript notice`,
      /<meta name="e2epaste:agent-hint"[^>]*e2ep get/s.test(html) && html.includes('<link rel="help" type="text/plain" href="/llms.txt">') && /<noscript>[\s\S]*e2ep get[\s\S]*<\/noscript>/.test(html));
  }
  const p = await browser.newPage();
  await p.goto(BASE + "/s/AAAAAAAA#x", { waitUntil: "networkidle0" });
  check("hint: the notice isn't shown with JavaScript on", !(await p.evaluate(() => document.body.innerText.includes("needs JavaScript"))));
  await p.close();
}

// ------------------------------------------------------------- v3 paste
{
  // Made the way the create page did before v4 (the server allows it in
  // this test setup only).
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = C.generateLinkSecret();
  const { key, accessProof } = await C.deriveV3Secrets(secret, iv, "v3-pw");
  const body = { version: 3, key_fragment: "", iv: Array.from(iv), has_password: true, syntax: "rust",
    content: C.arrayBufferToBase64(await C.encryptText("fn v3() {}", key, iv)),
    title: C.arrayBufferToBase64(await C.encryptText("v3 title", key, await C.deriveIv(iv, "title"))),
    expires_in: 3600, max_views: null, file_name: null, access_hash: await C.accessHash(accessProof) };
  const { id } = await (await fetch(BASE + "/api/submit_paste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const url = `${BASE}/s/${id}#${secret}`;
  const noPw = await e2ep(["get", url, "--json"]);
  check("v3: the server's password flag is used", noPw.code === 5);
  const got = await e2ep(["get", url, "--json", "--password-env", "PW"], { env: { PW: "v3-pw" } });
  check("v3: opens with e2ep", got.code === 0 && got.json.text === "fn v3() {}" && got.json.title === "v3 title" && got.json.syntax === "rust", got.stdout + got.stderr);
}

check("no page errors or CSP violations", errors.length === 0, errors.join("\n"));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
finish();
