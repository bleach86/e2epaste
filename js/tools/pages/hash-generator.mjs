// Hash generator (templates/tools/hash-generator.html.j2): text is hashed as
// it's typed; a file is read a piece at a time, with progress.
import { ALGORITHMS, findMatch, formatDigest, hashBytes, parseDigest } from "../hashes.mjs";
import { hashFileInParallel } from "../hash-parallel.mjs";
import { bindCopy, bindCopyAndClear } from "../common.mjs";

const tool = document.getElementById("hash-tool");
const textInput = document.getElementById("hash-text");
const fileInput = document.getElementById("hash-file");
const keyInput = document.getElementById("hash-key");
const formatSelect = document.getElementById("hash-format");
const compareInput = document.getElementById("hash-compare");
const compareResult = document.getElementById("hash-compare-result");
const results = document.getElementById("hash-results");
const progress = document.getElementById("hash-progress");
const hashError = document.getElementById("hash-error");
const algorithmsBox = document.getElementById("hash-algorithms");
const encoder = new TextEncoder();

// On a variant's page (e.g. SHA-256) its algorithm comes first, ticked.
const first = tool.dataset.first;
const algorithms = [...ALGORITHMS].sort((a, b) => (b.id === first) - (a.id === first));

for (const a of algorithms) {
  const box = document.createElement("div");
  box.className = "form-check m-0";
  box.innerHTML = '<input class="form-check-input" type="checkbox"><label class="form-check-label"></label>';
  const [check, label] = box.children;
  check.id = `algo-${a.id}`;
  check.value = a.id;
  check.checked = Boolean(a.common) || a.id === first;
  label.htmlFor = check.id;
  label.textContent = a.name;
  algorithmsBox.append(box);
  check.addEventListener("change", run);
}

let file = null;
let digests = {};
// Hashing a file can take a while; a newer run stops the older one.
let running = null;

function mode() {
  return document.querySelector('input[name="hash-mode"]:checked').value;
}

function chosen() {
  return [...algorithmsBox.querySelectorAll("input:checked")].map((c) => c.value);
}

function key() {
  return keyInput.value === "" ? null : encoder.encode(keyInput.value);
}

function showResults() {
  results.replaceChildren();
  const keyed = Boolean(key());
  for (const a of algorithms) {
    if (!(a.id in digests)) continue;
    const row = document.createElement("div");
    row.className = "row g-2 align-items-center";
    row.dataset.algorithm = a.id;
    row.innerHTML = `<div class="col-md-3 col-lg-2"><label class="num-label pt-0"></label></div>
      <div class="col"><input class="form-control font-monospace" type="text" readonly></div>
      <div class="col-auto"><button type="button" class="btn btn-quiet" aria-label="Copy"></button></div>`;
    const label = row.querySelector("label");
    const output = row.querySelector("input");
    const copy = row.querySelector("button");
    output.id = `hash-out-${a.id}`;
    label.htmlFor = output.id;
    label.textContent = keyed ? `HMAC-${a.name}` : a.name;
    output.value = formatDigest(digests[a.id], formatSelect.value);
    copy.append(document.querySelector("#copy-icon svg").cloneNode(true));
    bindCopy(copy, () => output.value);
    results.append(row);
  }
  compare();
}

function compare() {
  compareResult.className = "small mt-2 mb-0";
  compareResult.textContent = "";
  results.querySelectorAll(".is-match").forEach((r) => r.classList.remove("is-match"));
  if (compareInput.value.trim() === "" || Object.keys(digests).length === 0) return;
  const expected = parseDigest(compareInput.value);
  const match = expected && findMatch(digests, expected);
  if (match) {
    const name = ALGORITHMS.find((a) => a.id === match).name;
    results.querySelector(`[data-algorithm="${match}"]`).classList.add("is-match");
    compareResult.classList.add("text-accent");
    compareResult.textContent = `✓ Matches the ${key() ? `HMAC-${name}` : name}.`;
  } else {
    compareResult.classList.add("text-warn");
    compareResult.textContent = expected
      ? "✗ No match with any of the hashes above. Check the algorithm is ticked, and that it's the right file."
      : "That doesn't look like a hash (hex or base64).";
  }
}

async function run() {
  running?.abort();
  running = null;
  progress.hidden = true;
  hashError.hidden = true;
  if (mode() === "text") {
    digests = textInput.value === "" ? {} : hashBytes(encoder.encode(textInput.value), chosen(), key());
    showResults();
    return;
  }
  digests = {};
  showResults();
  if (!file) return;

  const job = new AbortController();
  running = job;
  const bar = progress.firstElementChild;
  bar.style.width = "0%";
  progress.hidden = false;
  try {
    digests = await hashFileInParallel(file, chosen(), {
      key: key(),
      signal: job.signal,
      onProgress: (done, total) => {
        const percent = Math.floor((done / total) * 100);
        bar.style.width = `${percent}%`;
        progress.setAttribute("aria-valuenow", String(percent));
      },
    });
  } catch (e) {
    if (job.signal.aborted) return;
    // Reading the file can fail (it was moved or changed since it was
    // chosen, or the worker didn't start). Say so and leave the page usable,
    // rather than a progress bar that never finishes.
    console.error("Hashing the file failed", e);
    progress.hidden = true;
    running = null;
    hashError.textContent = `The file couldn't be hashed: ${e.message || e}. Choose it again to retry.`;
    hashError.hidden = false;
    return;
  }
  progress.hidden = true;
  running = null;
  showResults();
}

const DROP_PROMPT = {
  name: document.getElementById("hash-file-name").textContent,
  size: document.getElementById("hash-file-size").textContent,
};

// Clear: the text and the file, and any hashing still going. The key, the
// checksum to compare with and the ticked algorithms stay.
document.getElementById("hash-clear").addEventListener("click", () => {
  textInput.value = "";
  file = null;
  fileInput.value = "";
  document.getElementById("hash-file-name").textContent = DROP_PROMPT.name;
  document.getElementById("hash-file-size").textContent = DROP_PROMPT.size;
  run();
  if (mode() === "text") textInput.focus();
});

function chooseFile(chosenFile) {
  file = chosenFile;
  document.getElementById("hash-file-name").textContent = file.name;
  document.getElementById("hash-file-size").textContent = `${file.size.toLocaleString()} bytes`;
  run();
}

// Shows the box for the chosen mode.
function showMode() {
  document.getElementById("hash-text-box").hidden = mode() !== "text";
  document.getElementById("hash-file-box").hidden = mode() !== "file";
}

for (const radio of document.querySelectorAll('input[name="hash-mode"]')) {
  radio.addEventListener("change", () => {
    showMode();
    run();
  });
}
fileInput.addEventListener("change", () => fileInput.files[0] && chooseFile(fileInput.files[0]));

// A file dropped anywhere on the panel switches to file mode.
tool.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
tool.addEventListener("drop", (event) => {
  const dropped = event.dataTransfer?.files[0];
  if (!dropped) return;
  event.preventDefault();
  document.getElementById("mode-file").checked = true;
  showMode();
  chooseFile(dropped);
});

textInput.addEventListener("input", run);
keyInput.addEventListener("input", run);
formatSelect.addEventListener("change", showResults);
compareInput.addEventListener("input", compare);

bindCopyAndClear();
// After a reload, browsers can bring back the chosen mode (and file).
showMode();
if (mode() === "file" && fileInput.files[0]) {
  chooseFile(fileInput.files[0]);
} else {
  run();
}
if (mode() === "text") textInput.focus();
