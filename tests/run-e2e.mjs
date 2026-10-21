// Runs the browser suites in tests/e2e/. Each gets its own server, on its own
// port with an empty data directory and the settings it needs, so suites
// can't affect each other (for example by using up a rate limit).
//
//   node tests/run-e2e.mjs              all suites
//   node tests/run-e2e.mjs security     only suites whose name contains "security"
//
// Needs a built server and client (cargo build --workspace; or set
// E2EPASTE_BIN and E2EP_BIN) and Chrome (or set CHROME_PATH). Server logs of
// failed suites are printed at the end.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TESTS, "..");
const BIN = process.env.E2EPASTE_BIN ?? path.join(REPO, "target/debug/e2epaste");
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef0123456789";

// The default limits, whatever Rocket.toml says locally, so the suites test
// the same thing everywhere. A suite's own settings go on top.
const DEFAULTS = {
  ROCKET_MAX_PASTE_KIB: "1024",
  ROCKET_ALLOW_FILES: "true",
  ROCKET_MAX_FILE_MIB: "25",
  ROCKET_PASTES_PER_MINUTE: "10",
  ROCKET_PASTES_PER_HOUR: "60",
  ROCKET_UPLOAD_MIB_PER_HOUR: "250",
  ROCKET_UNLOCK_ATTEMPTS_PER_HOUR: "30",
  ROCKET_MAX_ATTACHMENT_STORAGE_MIB: "0",
};

// Most suites create a lot of pastes quickly, so the paste limits are off;
// rate_limit.mjs runs with the defaults to test them.
const NO_PASTE_LIMITS = { ROCKET_PASTES_PER_MINUTE: "0", ROCKET_PASTES_PER_HOUR: "0" };

const SUITES = [
  { file: "create_view.mjs", env: NO_PASTE_LIMITS },
  {
    file: "security.mjs",
    env: { ...NO_PASTE_LIMITS, ROCKET_UNLOCK_ATTEMPTS_PER_HOUR: "8", ROCKET_ADMIN_TOKEN: ADMIN_TOKEN },
  },
  { file: "markdown_and_detection.mjs", env: NO_PASTE_LIMITS },
  { file: "editor.mjs", env: NO_PASTE_LIMITS },
  // Lets the server create pastes in old formats (debug builds only).
  { file: "legacy_pastes.mjs", env: { ...NO_PASTE_LIMITS, E2EPASTE_TEST_LEGACY_PASTES: "1" } },
  { file: "insecure_context.mjs", env: NO_PASTE_LIMITS },
  { file: "tools.mjs", env: NO_PASTE_LIMITS },
  { file: "nav.mjs", env: NO_PASTE_LIMITS },
  { file: "mobile_footer.mjs", env: NO_PASTE_LIMITS },
  {
    file: "branding.mjs",
    env: { ROCKET_SITE_URL: "https://paste.example.com", ROCKET_SOURCE_URL: "https://git.example.com/someone/e2epaste-fork" },
  },
  { file: "limits.mjs", env: { ...NO_PASTE_LIMITS, ROCKET_MAX_PASTE_KIB: "8", ROCKET_MAX_FILE_MIB: "1", ROCKET_MAX_ATTACHMENT_STORAGE_MIB: "1" } },
  { file: "no_files.mjs", env: { ...NO_PASTE_LIMITS, ROCKET_ALLOW_FILES: "false" } },
  // Also lets the test make a v3 paste, to check e2ep still opens those.
  { file: "cli.mjs", env: { ...NO_PASTE_LIMITS, E2EPASTE_TEST_LEGACY_PASTES: "1" } },
  { file: "mcp.mjs", env: NO_PASTE_LIMITS },
  { file: "rate_limit.mjs", env: {} },
];

if (!fs.existsSync(BIN)) {
  console.error(`No server at ${BIN}. Run \`cargo build\` first, or set E2EPASTE_BIN.`);
  process.exit(1);
}

const filter = process.argv[2];
const suites = SUITES.filter((s) => !filter || s.file.includes(filter));
if (suites.length === 0) {
  console.error(`No suite matches "${filter}".`);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-e2e-"));
const results = [];
for (const [i, suite] of suites.entries()) {
  results.push(await runSuite(suite, 18765 + i));
}

console.log("\n" + results.map((r) => `${r.passed ? "ok  " : "FAIL"}  ${r.file} (${r.seconds}s)`).join("\n"));
for (const r of results.filter((r) => !r.passed)) {
  console.log(`\n--- last server log lines for ${r.file} ---\n${tail(r.log, 40)}`);
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(results.every((r) => r.passed) ? 0 : 1);

async function runSuite(suite, port) {
  const name = path.basename(suite.file, ".mjs");
  const dataDir = path.join(work, name);
  const log = path.join(work, `${name}.log`);
  const started = Date.now();
  console.log(`\n=== ${suite.file}`);

  const server = spawn(BIN, [], {
    cwd: REPO, // for templates/ and static/
    env: {
      ...process.env,
      ROCKET_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
      ROCKET_DATA_DIR: dataDir,
      ...DEFAULTS,
      ...suite.env,
    },
    stdio: ["ignore", fs.openSync(log, "w"), fs.openSync(log, "a")],
  });

  let passed = false;
  try {
    const base = `http://localhost:${port}`;
    await waitForServer(base, server);
    const code = await run(process.execPath, [path.join(TESTS, "e2e", suite.file)], {
      ...process.env,
      BASE_URL: base,
      ADMIN_TOKEN,
    });
    passed = code === 0;
  } catch (e) {
    console.log(`FAIL ${e.message}`);
  } finally {
    server.kill();
  }
  return { file: suite.file, passed, log, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

async function waitForServer(base, server) {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) {
      throw new Error(`the server exited with code ${server.exitCode}`);
    }
    try {
      if ((await fetch(base + "/")).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the server didn't start within 10 seconds");
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function tail(file, lines) {
  return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}
