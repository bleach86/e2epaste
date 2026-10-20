// View-paste page (paste.html.j2). Rebuilds the key from the link (and the
// password, if any), opens the paste through /api/open (which counts the
// view), then decrypts in the browser.
//
// The page holds no paste content: for v3 pastes the server only sends it
// after checking an access proof derived from the full link and password, so
// a wrong password or a broken link uses no view.

import {
  base64ToArrayBuffer,
  decryptPart,
  decryptText,
  getPasteSecrets,
} from "../crypto.mjs";
import { deleteTokenFor } from "../delete_tokens.mjs";
import { AUTO, effectiveLanguage, languageName } from "../highlight.mjs";
import { cryptoAvailable, readPageData } from "../ui.mjs";

// Details only; the encrypted content comes from /api/open.
const { paste } = readPageData();
const hasPassword = paste.has_password;
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
// The response from /api/open, once a view has been counted. Kept so a wrong
// password on an old (v1/v2) paste, which opens without a proof, can be
// retried without using another view.
let opened = null;
let pasteText = "";
let pasteTitle = "";
let fileName = null;
// The language the paste is highlighted in (chosen, or guessed for "Auto-
// detect"), or null for plain text.
let pasteLanguage = null;
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

  pasteLanguage = effectiveLanguage(paste.syntax, text);
  if (pasteLanguage) {
    // highlight.js escapes the text; its output is safe as HTML.
    viewArea.innerHTML = hljs.highlight(text, { language: pasteLanguage, ignoreIllegals: true }).value;
    viewArea.className = `hljs language-${pasteLanguage}`;
  }
  if (paste.syntax === AUTO) {
    document.getElementById("language-name").textContent = pasteLanguage
      ? `${languageName(pasteLanguage)} (detected)`
      : "Plain text";
  }

  if (pasteLanguage === "markdown") {
    markdownToggle.hidden = false;
    // Rendered by default when the creator chose Markdown; a guess might be
    // wrong, so then it starts as source.
    if (paste.syntax === "markdown") {
      showMarkdown("rendered");
    }
  }
}

// --- Markdown ---------------------------------------------------------------

const markdownToggle = document.getElementById("markdown-toggle");
const markdownView = document.getElementById("markdown-view");
let markdownRendered = false;

async function showMarkdown(view) {
  const rendered = view === "rendered";
  if (rendered && !markdownRendered) {
    // Loaded only for Markdown pastes.
    const { renderMarkdown } = await import(/* webpackChunkName: "markdown" */ "../markdown.mjs");
    markdownView.replaceChildren(renderMarkdown(pasteText));
    for (const code of markdownView.querySelectorAll("pre code[class^='language-']")) {
      const language = code.className.slice("language-".length);
      if (hljs.getLanguage(language)) {
        code.innerHTML = hljs.highlight(code.textContent, { language, ignoreIllegals: true }).value;
        code.classList.add("hljs");
      }
    }
    markdownRendered = true;
  }
  markdownView.hidden = !rendered;
  codeView.hidden = rendered;
  wrapButton.hidden = rendered;
  for (const button of markdownToggle.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
}

markdownToggle.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) {
    showMarkdown(button.dataset.view);
  }
});

// Why /api/open refused: "wrong-key" (link or password), "not-found",
// "rate-limited" (with `retryAfter` seconds) or "failed".
class OpenError extends Error {
  constructor(kind, retryAfter = null) {
    super(`Opening the paste failed: ${kind}`);
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

async function requestOpen(proof) {
  const response = await fetch(`/api/open/${paste.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof: proof ?? null }),
  });
  if (response.ok) {
    return response.json();
  }
  const kinds = { 403: "wrong-key", 404: "not-found", 429: "rate-limited" };
  const body = await response.json().catch(() => ({}));
  throw new OpenError(kinds[response.status] ?? "failed", body.retry_after ?? null);
}

// "4 minutes", "30 seconds"
function waitText(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return seconds < 90 ? `${seconds} seconds` : `${minutes} minutes`;
}

// Throws an OpenError, or another error if the link or password is wrong.
async function decrypt(password) {
  let secrets;
  if (paste.version >= 3) {
    // The key and access proof come first: the server only sends the paste
    // to a browser that proves it has the full link and password. A
    // malformed link throws here, before anything is asked of the server.
    secrets = await getPasteSecrets(paste, linkHash, hasPassword, password);
    opened ??= await requestOpen(secrets.accessProof);
  } else {
    // v1/v2 keys need the key fragment the server sends with the paste.
    opened ??= await requestOpen(null);
    secrets = await getPasteSecrets({ ...paste, key_fragment: opened.key_fragment }, linkHash, hasPassword, password);
  }

  const text = await decryptText(base64ToArrayBuffer(opened.content), secrets.key, secrets.iv);
  pasteSecrets = secrets;
  showText(text);

  // v3 titles are encrypted, so the server leaves the heading as a
  // placeholder. A title that won't decrypt shouldn't stop the paste itself
  // from showing.
  if (paste.version >= 3) {
    let title = "";
    try {
      title = new TextDecoder().decode(await decryptPart(secrets, "title", base64ToArrayBuffer(opened.title)));
    } catch (e) {
      console.error("Failed to decrypt title", e);
    }
    pasteTitle = title;
    titleEl.textContent = title || "Untitled";
  } else {
    pasteTitle = opened.title;
  }

  if (opened.file_name) {
    const nameBytes = await decryptPart(secrets, "file-name", base64ToArrayBuffer(opened.file_name));
    fileName = new TextDecoder().decode(nameBytes);
    document.getElementById("attachment-name").textContent = fileName;
    document.getElementById("attachment-section").hidden = false;
  }

  showViews(opened.views);
  document.getElementById("total-views").textContent = opened.total_views;
  document.getElementById("decrypted-notice").hidden = false;
  copyButton.disabled = false;
  downloadButton.disabled = false;
}

// For errors other than a wrong link or password.
function showOpenError(error) {
  const messages = {
    "not-found": "This paste doesn't exist any more. It may have expired, been deleted, or reached its view limit.",
    "rate-limited": `Too many failed attempts to open pastes from your network. Please try again in ${waitText(
      error.retryAfter ?? 60,
    )}.`,
  };
  document.getElementById("open-error-text").textContent =
    messages[error.kind] ?? "The paste couldn't be opened. Please try again.";
  document.getElementById("open-error").hidden = false;
}

// --- Password prompt --------------------------------------------------------

function setUnlocking(busy) {
  passwordSubmit.disabled = busy;
  passwordSubmit.querySelector(".unlock-idle").classList.toggle("d-none", busy);
  passwordSubmit.querySelector(".unlock-busy").classList.toggle("d-none", !busy);
  passwordSubmit.querySelector(".unlock-busy").classList.toggle("d-inline-flex", busy);
}

const WRONG_PASSWORD = "That password didn't work. Check it and try again.";

async function decryptWithPassword() {
  // The server rejects a wrong password for v3 pastes (the access proof
  // doesn't match); for older ones it simply fails to decrypt.
  passwordError.hidden = true;
  setUnlocking(true);
  try {
    await decrypt(passwordInput.value.trim());
  } catch (e) {
    if (e instanceof OpenError && e.kind === "not-found") {
      passwordModal.hide();
      showOpenError(e);
      return;
    }
    passwordError.textContent =
      e instanceof OpenError && e.kind === "rate-limited"
        ? `Too many wrong attempts. Please try again in ${waitText(e.retryAfter ?? 60)}.`
        : WRONG_PASSWORD;
    passwordError.hidden = false;
    passwordInput.select();
    return;
  } finally {
    setUnlocking(false);
  }

  passwordModal.hide();
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
  const ext = EXTENSIONS[pasteLanguage] ?? "txt";
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
    // The ticket came with this view, from /api/open.
    const res = await fetch(`/api/download-attachment/${paste.id}`, {
      headers: { "X-Download-Ticket": opened.download_ticket },
    });
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

// The creator's browser kept the delete token (js/delete_tokens.mjs); the
// confirm page takes it from the hash, which isn't sent to the server.
const deleteToken = deleteTokenFor(paste.id);
if (deleteToken) {
  for (const link of [document.getElementById("delete-paste-btn"), document.getElementById("password-delete-link")]) {
    link.href = `/delete/${paste.id}#${deleteToken}`;
    link.hidden = false;
  }
}

// --- Start ------------------------------------------------------------------

if (!cryptoAvailable()) {
  // Plain-HTTP page: the banner from layout.html.j2 explains. Nothing is
  // decrypted, so no view is used up.
} else if (hasPassword) {
  passwordModal = new bootstrap.Modal(document.getElementById("password-modal"));
  document.getElementById("password-modal").addEventListener("shown.bs.modal", () => passwordInput.focus());
  passwordModal.show();
} else {
  decrypt("").catch((e) => {
    console.error("Failed to open paste", e);
    if (e instanceof OpenError && e.kind !== "wrong-key") {
      showOpenError(e);
    } else {
      document.getElementById("decrypt-error").hidden = false;
    }
  });
}
