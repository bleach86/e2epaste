// View-paste page (paste.html.j2). Rebuilds the key from the link (and the
// password, if any), then decrypts in the browser.

import {
  base64ToArrayBuffer,
  decryptPart,
  decryptText,
  getPasteSecrets,
} from "../crypto.mjs";
import { readPageData } from "../ui.mjs";

const { paste, has_password: hasPassword } = readPageData();
const linkHash = window.location.hash.substring(1);

// File extensions for "Download", by syntax-highlighting language.
const EXTENSIONS = {
  bash: "sh", c: "c", cpp: "cpp", csharp: "cs", css: "css", diff: "diff", go: "go", graphql: "graphql",
  ini: "ini", java: "java", javascript: "js", json: "json", kotlin: "kt", less: "less", lua: "lua",
  makefile: "mk", markdown: "md", objectivec: "m", perl: "pl", php: "php", "php-template": "php",
  python: "py", "python-repl": "py", r: "r", ruby: "rb", rust: "rs", scss: "scss", shell: "sh", sql: "sql",
  swift: "swift", typescript: "ts", vbnet: "vb", wasm: "wat", xml: "xml", yaml: "yaml",
};

const viewArea = document.getElementById("view-area");
const codeView = document.getElementById("code-view");
const gutter = document.getElementById("code-gutter");
const titleEl = document.getElementById("paste-title");
const copyButton = document.getElementById("copy-paste-btn");
const downloadButton = document.getElementById("download-paste-btn");
const wrapButton = document.getElementById("wrap-btn");
const passwordInput = document.getElementById("password-input");
const passwordSubmit = document.getElementById("submit-password-btn");
const passwordError = document.getElementById("password-error");
const attachmentButton = document.getElementById("download-link");
const downloadStatus = document.getElementById("download-status");

// Key and IV for this paste, set once decryption succeeds.
let pasteSecrets = null;
let pasteText = "";
let pasteTitle = "";
let fileName = null;
let passwordModal;

// --- Decrypting -----------------------------------------------------------

function showText(text) {
  pasteText = text;
  viewArea.textContent = text;

  // One number per line; a trailing newline doesn't start a visible line.
  let lines = text.split("\n").length;
  if (text.endsWith("\n") && lines > 1) {
    lines -= 1;
  }
  gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");

  if (paste.syntax && paste.syntax !== "plaintext" && hljs.getLanguage(paste.syntax)) {
    hljs.highlightElement(viewArea);
  }
}

// Throws if the password or link is wrong.
async function decrypt(password) {
  const secrets = await getPasteSecrets(paste, linkHash, hasPassword, password);
  const text = await decryptText(base64ToArrayBuffer(paste.content), secrets.key, secrets.iv);
  pasteSecrets = secrets;
  showText(text);

  // v3 titles are encrypted, so the server leaves the heading as a
  // placeholder. A title that won't decrypt shouldn't stop the paste itself
  // from showing.
  if (paste.version >= 3) {
    let title = "";
    try {
      title = new TextDecoder().decode(await decryptPart(secrets, "title", base64ToArrayBuffer(paste.title)));
    } catch (e) {
      console.error("Failed to decrypt title", e);
    }
    pasteTitle = title;
    titleEl.textContent = title || "Untitled";
  } else {
    pasteTitle = paste.title;
  }

  if (paste.file_name) {
    const nameBytes = await decryptPart(secrets, "file-name", base64ToArrayBuffer(paste.file_name));
    fileName = new TextDecoder().decode(nameBytes);
    document.getElementById("attachment-name").textContent = fileName;
    document.getElementById("attachment-section").hidden = false;
  }

  document.getElementById("decrypted-notice").hidden = false;
  copyButton.disabled = false;
  downloadButton.disabled = false;
}

async function showPaste(password) {
  await decrypt(password);
  await markAsViewed();
}

async function markAsViewed() {
  const response = await fetch(`/api/advance-views/${paste.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (response.ok) {
    const data = await response.json();
    showViews(data.views);
    document.getElementById("total-views").textContent = data.total_views;
  }
}

// --- Password prompt --------------------------------------------------------

function setUnlocking(busy) {
  passwordSubmit.disabled = busy;
  passwordSubmit.querySelector(".unlock-idle").classList.toggle("d-none", busy);
  passwordSubmit.querySelector(".unlock-busy").classList.toggle("d-none", !busy);
  passwordSubmit.querySelector(".unlock-busy").classList.toggle("d-inline-flex", busy);
}

async function decryptWithPassword() {
  // There is no password hash to check against: a wrong password simply
  // fails to decrypt.
  passwordError.hidden = true;
  setUnlocking(true);
  try {
    await decrypt(passwordInput.value.trim());
  } catch (e) {
    passwordError.hidden = false;
    passwordInput.select();
    return;
  } finally {
    setUnlocking(false);
  }

  passwordModal.hide();
  await markAsViewed();
}

function togglePasswordVisibility() {
  const button = document.getElementById("show-pass-button");
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  button.setAttribute("aria-pressed", String(show));
  button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  button.querySelector(".pw-show").classList.toggle("d-none", show);
  button.querySelector(".pw-hide").classList.toggle("d-none", !show);
  button.querySelector(".pw-hide").classList.toggle("d-inline-flex", show);
}

passwordSubmit.addEventListener("click", decryptWithPassword);
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    decryptWithPassword();
  }
});
document.getElementById("show-pass-button").addEventListener("click", togglePasswordVisibility);

// --- Actions ----------------------------------------------------------------

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(pasteText);
  copyButton.querySelector(".copy-idle").classList.add("d-none");
  copyButton.querySelector(".copy-done").classList.replace("d-none", "d-inline-flex");
  setTimeout(() => {
    copyButton.querySelector(".copy-done").classList.replace("d-inline-flex", "d-none");
    copyButton.querySelector(".copy-idle").classList.remove("d-none");
  }, 2000);
});

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

downloadButton.addEventListener("click", () => {
  const base = (pasteTitle || "paste").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").trim() || "paste";
  const ext = EXTENSIONS[paste.syntax] ?? "txt";
  saveBlob(new Blob([pasteText], { type: "text/plain;charset=utf-8" }), `${base}.${ext}`);
});

wrapButton.addEventListener("click", () => {
  const wrap = !codeView.classList.contains("wrap");
  codeView.classList.toggle("wrap", wrap);
  wrapButton.setAttribute("aria-pressed", String(wrap));
});

function setAttachmentBusy(busy, status) {
  attachmentButton.disabled = busy;
  attachmentButton.querySelector(".dl-idle").classList.toggle("d-none", busy);
  attachmentButton.querySelector(".dl-busy").classList.toggle("d-none", !busy);
  attachmentButton.querySelector(".dl-busy").classList.toggle("d-inline-flex", busy);
  downloadStatus.textContent = status;
}

attachmentButton.addEventListener("click", async () => {
  setAttachmentBusy(true, "Downloading encrypted file...");
  try {
    const res = await fetch(`/api/download-attachment/${paste.id}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    setAttachmentBusy(true, "Decrypting...");
    const decrypted = await decryptPart(pasteSecrets, "file", await res.arrayBuffer());
    saveBlob(new Blob([decrypted], { type: "application/octet-stream" }), fileName);
    setAttachmentBusy(false, "Encrypted attachment");
  } catch (e) {
    console.error(e);
    setAttachmentBusy(false, "Download failed. Please try again.");
  }
});

// --- Paste details ----------------------------------------------------------

function timeUntil(timestamp) {
  const seconds = Math.floor((timestamp - Date.now()) / 1000);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  // Use the largest unit that (nearly) fits, then round, so a fresh 3-day
  // paste says "3 days" rather than "2 days" (2 days 23 hours), and a 1-day
  // paste says "1 day" rather than "24 hours".
  for (const [unit, size] of units) {
    if (seconds >= size * 0.98) {
      const count = Math.round(seconds / size);
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return "less than a minute";
}

function showViews(views) {
  const max = paste.max_views;
  document.getElementById("views").textContent = max
    ? `${views.toLocaleString()} of ${max.toLocaleString()} views`
    : `${views.toLocaleString()} ${views === 1 ? "view" : "views"}`;
  document.getElementById("final-view").hidden = !(max && views >= max);
}

document.getElementById("expire-date").textContent =
  paste.expires === null ? "Never expires" : `Expires in ${timeUntil(paste.expires)}`;

document.getElementById("paste-date").textContent = new Date(paste.timestamp * 1000).toLocaleDateString(
  "en-US",
  { year: "numeric", month: "short", day: "numeric" },
);

showViews(paste.views);

// Ctrl/Cmd+A selects only the paste content (but still works in text fields).
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "a" && !event.target.closest("input, textarea")) {
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(viewArea);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

// --- Start ------------------------------------------------------------------

if (hasPassword) {
  passwordModal = new bootstrap.Modal(document.getElementById("password-modal"));
  document.getElementById("password-modal").addEventListener("shown.bs.modal", () => passwordInput.focus());
  passwordModal.show();
} else {
  showPaste("").catch((e) => {
    console.error("Failed to decrypt paste", e);
    document.getElementById("decrypt-error").hidden = false;
  });
}
