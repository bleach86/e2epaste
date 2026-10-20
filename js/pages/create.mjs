// Create-paste page (index.html.j2). Encrypts the paste in the browser and
// submits only ciphertext to the server.

import {
  PASTE_VERSION,
  arrayBufferToBase64,
  deriveIv,
  accessHash,
  deriveV3Secrets,
  encryptBytes,
  encryptText,
  generateLinkSecret,
} from "../crypto.mjs";
import { rememberDeleteToken } from "../delete_tokens.mjs";
import { AUTO, detectLanguage, languageName } from "../highlight.mjs";
import { cryptoAvailable } from "../ui.mjs";

const MAX_PASTE_BYTES = 1048576;
const MAX_FILE_BYTES = 26214400;
const MAX_VIEWS = 999999999999;
const DEFAULT_EXPIRY = "3days";
// Above this many characters, re-highlight once typing pauses instead of on
// every keystroke.
const LIVE_HIGHLIGHT_MAX = 20000;
// How long typing has to pause before the language is guessed again.
const DETECT_DELAY_MS = 250;

const EXPIRE_SECONDS = {
  "10min": 600,
  "1hour": 3600,
  "1day": 86400,
  "3days": 259200,
  "1week": 604800,
  "2weeks": 1209600,
  "1month": 2592000,
  "6months": 15552000,
  "1year": 31536000,
};

const pasteArea = document.getElementById("paste-area");
const pasteEditor = document.getElementById("paste-editor");
const pasteHighlight = document.getElementById("paste-highlight");
const pasteStats = document.getElementById("paste-stats");
const titleInput = document.getElementById("paste-title");
const syntaxSelect = document.getElementById("syntax");
const fileInput = document.getElementById("fileInput");
const attachmentRow = document.getElementById("attachment");
const burnSwitch = document.getElementById("burn");
const maxViewsInput = document.getElementById("max-views");
const passwordInput = document.getElementById("paste-password");
const passwordToggle = document.getElementById("toggle-password");
const submitButton = document.getElementById("submit-paste");
const urlModalEl = document.getElementById("url-modal");
const copyUrlButton = document.getElementById("copy-url-btn");
const copyDeleteButton = document.getElementById("copy-delete-btn");

let fileData;
let fileName;
let highlightTimer;
let submitting = false;

// --- Editor ---------------------------------------------------------------

function resizePasteArea() {
  pasteArea.style.height = "auto";
  pasteArea.style.height = pasteArea.scrollHeight + "px";
}

function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStats() {
  const text = pasteArea.value;
  const lines = text === "" ? 0 : text.split("\n").length;
  const bytes = new TextEncoder().encode(text).byteLength;
  pasteStats.textContent = `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} · ${formatBytes(bytes)}`;
  pasteStats.classList.toggle("text-danger", bytes > MAX_PASTE_BYTES);
}

// "Auto-detect"'s current guess, or null for plain text.
let detectedLanguage = null;
let detectTimer;
const autoOption = syntaxSelect.querySelector(`option[value="${AUTO}"]`);

// The highlight.js language to use, or null for plain text.
function selectedLanguage() {
  const language = syntaxSelect.value;
  if (language === AUTO) {
    return detectedLanguage;
  }
  return language !== "plaintext" && hljs.getLanguage(language) ? language : null;
}

// Guesses the language again and shows it in the picker, e.g.
// "Auto-detect (Rust)".
function redetect() {
  detectedLanguage = detectLanguage(pasteArea.value);
  autoOption.textContent = detectedLanguage ? `Auto-detect (${languageName(detectedLanguage)})` : "Auto-detect";
  updateHighlight();
}

function renderHighlight() {
  const language = selectedLanguage();
  if (language) {
    pasteHighlight.innerHTML = hljs.highlight(pasteArea.value, {
      language,
      ignoreIllegals: true,
    }).value;
  }
}

function updateHighlight() {
  clearTimeout(highlightTimer);
  const language = selectedLanguage();
  pasteEditor.classList.toggle("highlighting", language !== null);

  if (!language) {
    pasteHighlight.textContent = "";
  } else if (pasteArea.value.length <= LIVE_HIGHLIGHT_MAX) {
    renderHighlight();
  } else {
    // Keep the text lined up right away and colour it once typing pauses.
    pasteHighlight.textContent = pasteArea.value;
    highlightTimer = setTimeout(renderHighlight, 300);
  }
}

pasteArea.addEventListener("input", () => {
  resizePasteArea();
  // Keeps the last guess's colours while typing; guesses again on a pause.
  updateHighlight();
  updateStats();
  if (syntaxSelect.value === AUTO) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(redetect, DETECT_DELAY_MS);
  }
});

syntaxSelect.addEventListener("change", () => {
  if (syntaxSelect.value === AUTO) {
    redetect();
  } else {
    updateHighlight();
  }
  resizePasteArea();
});

tabOverride.set(pasteArea);

// --- Attachment -----------------------------------------------------------

function clearAttachment() {
  fileInput.value = "";
  fileData = undefined;
  fileName = undefined;
  attachmentRow.hidden = true;
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) {
    clearAttachment();
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    alert("File is too large. Please keep it under 25 MB.");
    clearAttachment();
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    fileData = e.target.result;
    fileName = file.name;
    document.getElementById("attachment-name").textContent = file.name;
    document.getElementById("attachment-size").textContent = formatBytes(file.size);
    attachmentRow.hidden = false;
  };
  reader.readAsArrayBuffer(file);
});

document.getElementById("attachment-remove").addEventListener("click", clearAttachment);

// --- Options --------------------------------------------------------------

function selectedExpiry() {
  return document.querySelector('input[name="expire"]:checked')?.value ?? DEFAULT_EXPIRY;
}

function expiryLabel(value) {
  return document.querySelector(`label[for="expire-${value}"]`)?.textContent.trim() ?? value;
}

// Burn after reading is a view limit of 1.
burnSwitch.addEventListener("change", () => {
  maxViewsInput.disabled = burnSwitch.checked;
  maxViewsInput.value = burnSwitch.checked ? "1" : "";
});

function maxViews() {
  if (burnSwitch.checked) {
    return 1;
  }
  const n = parseInt(maxViewsInput.value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_VIEWS) : null;
}

function setPasswordVisible(visible) {
  passwordInput.type = visible ? "text" : "password";
  passwordToggle.setAttribute("aria-pressed", String(visible));
  passwordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
}

passwordToggle.addEventListener("click", () => setPasswordVisible(passwordInput.type === "password"));

// --- Submit ---------------------------------------------------------------

function setBusy(busy) {
  submitting = busy;
  submitButton.disabled = busy;
  submitButton.querySelector(".submit-idle").classList.toggle("d-none", busy);
  submitButton.querySelector(".submit-busy").classList.toggle("d-none", !busy);
  submitButton.querySelector(".submit-busy").classList.toggle("d-inline-flex", busy);
}

// An error with a message for the user, from a refused API request.
class RefusedError extends Error {}

// "4 minutes", "30 seconds", "2 hours"
function waitText(seconds) {
  let [count, unit] = [seconds, "second"];
  if (seconds >= 5400) {
    [count, unit] = [Math.ceil(seconds / 3600), "hour"];
  } else if (seconds >= 90) {
    [count, unit] = [Math.ceil(seconds / 60), "minute"];
  }
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// Turns a refused request into a RefusedError explaining why.
async function refusal(response, what) {
  const body = await response.json().catch(() => ({}));
  switch (response.status) {
    case 429: {
      const retryAfter = Number(body.retry_after ?? response.headers.get("Retry-After")) || 60;
      return new RefusedError(
        `You've created a lot of pastes in a short time. Please try again in ${waitText(retryAfter)}.`,
      );
    }
    case 507:
      return new RefusedError("The server is out of storage space right now, so it can't take new pastes.");
    case 413:
      return new RefusedError("The attachment is too large. Please keep it under 25 MB.");
    default:
      return new Error(`The server didn't accept the ${what} (${response.status})`);
  }
}

// `token` is the one-time upload token the server returned with the paste ID.
async function uploadEncryptedFile(file, id, token) {
  const response = await fetch(`/api/upload-attachment/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Upload-Token": token },
    body: file,
  });
  if (!response.ok) {
    throw await refusal(response, "attachment");
  }
}

async function createPaste() {
  const text = pasteArea.value;

  if (text === "") {
    pasteArea.focus();
    return;
  }

  if (new TextEncoder().encode(text).byteLength > MAX_PASTE_BYTES) {
    alert("Paste is too large. Please keep it under 1 MB.");
    return;
  }

  const expire = selectedExpiry();
  const lifetime = EXPIRE_SECONDS[expire] ?? EXPIRE_SECONDS["1year"];
  const views = maxViews();
  const password = passwordInput.value.trim();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // The secret only ever goes in the link's #fragment, which browsers never
  // send to the server. With a password, the key also depends on it.
  const linkSecret = generateLinkSecret();
  const { key, accessProof } = await deriveV3Secrets(linkSecret, iv, password === "" ? null : password);

  const encrypted = await encryptText(text, key, iv);
  let encryptedFile = null;
  let encryptedFileName = null;

  if (fileData) {
    encryptedFile = await encryptBytes(fileData, key, await deriveIv(iv, "file"));
    const cipherName = await encryptText(fileName, key, await deriveIv(iv, "file-name"));
    encryptedFileName = arrayBufferToBase64(cipherName);
  }

  // Encrypted like everything else; an empty title is shown as "Untitled".
  // Cut by code point so the 64-character limit can't split an emoji.
  const titleText = Array.from(titleInput.value).slice(0, 64).join("");
  const title = await encryptText(titleText, key, await deriveIv(iv, "title"));

  const paste = {
    content: arrayBufferToBase64(encrypted),
    iv: Array.from(iv),
    // A lifetime, not a time: the server works out when, so a wrong clock here
    // doesn't matter.
    expires_in: lifetime,
    max_views: views,
    key_fragment: "", // v3 stores no key material on the server
    has_password: password !== "",
    version: PASTE_VERSION,
    title: arrayBufferToBase64(title),
    syntax: syntaxSelect.value,
    file_name: encryptedFileName,
    // So the server can check it against the limits before creating anything.
    file_size: encryptedFile ? encryptedFile.byteLength : null,
    // The server only sends the paste to a browser that has the proof; it
    // keeps just this hash of it.
    access_hash: await accessHash(accessProof),
  };

  const response = await fetch("/api/submit_paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(paste),
  });
  if (!response.ok) {
    throw await refusal(response, "paste");
  }
  const data = await response.json();

  if (!data.id) {
    throw new Error("The server didn't accept the paste");
  }
  // For the Delete button on the paste page, in this browser. Before the
  // upload, so a paste whose attachment failed can still be deleted.
  rememberDeleteToken(data.id, data.delete_token, lifetime);
  if (encryptedFile) {
    await uploadEncryptedFile(encryptedFile, data.id, data.upload_token);
  }

  // Hand out /s/ (short for /share/) links: link-preview bots can fetch that
  // page (robots.txt blocks /paste/) and it forwards browsers on. The origin
  // is the address this page was loaded from, so links work whatever
  // site_url is set to.
  showLink(`${location.origin}/s/${data.id}#${linkSecret}`, `${location.origin}/delete/${data.id}#${data.delete_token}`, {
    expiry: expiryLabel(expire),
    views,
    password: password !== "",
    attachment: Boolean(encryptedFile),
  });
}

// Without Web Crypto (a plain-HTTP page) nothing can be encrypted; the
// banner from layout.html.j2 explains why.
if (!cryptoAvailable()) {
  submitButton.disabled = true;
}

submitButton.addEventListener("click", async () => {
  if (submitting || !cryptoAvailable()) {
    return;
  }
  setBusy(true);
  try {
    await createPaste();
  } catch (e) {
    console.error(e);
    alert(e instanceof RefusedError ? e.message : "Failed to create paste. Please try again.");
  } finally {
    setBusy(false);
  }
});

// --- Link dialog ----------------------------------------------------------

const urlModal = new bootstrap.Modal(urlModalEl);

function chip(icon, text, warn = false) {
  const li = document.createElement("li");
  li.className = warn ? "chip chip-warn" : "chip";
  const svg = document.querySelector(`#chip-icons [data-icon="${icon}"] svg`);
  if (svg) {
    li.append(svg.cloneNode(true));
  }
  li.append(document.createTextNode(text));
  return li;
}

function showLink(url, deleteUrl, settings) {
  document.getElementById("paste-url").value = url;
  document.getElementById("delete-url").value = deleteUrl;
  urlModalEl.querySelector(".delete-details").open = false;

  const chips = [chip("clock", `Expires in ${settings.expiry}`)];
  if (settings.views === 1) {
    chips.push(chip("flame", "Burns after 1 view", true));
  } else if (settings.views) {
    chips.push(chip("eye", `Limited to ${settings.views.toLocaleString()} views`));
  }
  if (settings.password) {
    chips.push(chip("lock", "Password protected"));
  }
  if (settings.attachment) {
    chips.push(chip("paperclip", "Encrypted attachment"));
  }
  document.getElementById("link-summary").replaceChildren(...chips);

  document.getElementById("link-tip").textContent = settings.password
    ? "Send the password a different way from the link, for example the link by email and the password by text. A lost link or password can't be recovered."
    : "Anyone who gets this link can read the paste, so share it only where you'd share the content itself. A lost link can't be recovered.";

  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  document.getElementById("qrcode-container").innerHTML = qr.createImgTag(4, 2, "QR code of the link");
  urlModalEl.querySelector(".qr-details").open = false;

  setCopied(copyUrlButton, false);
  setCopied(copyDeleteButton, false);
  urlModal.show();
}

function setCopied(button, copied) {
  button.querySelector(".copy-idle").classList.toggle("d-none", copied);
  button.querySelector(".copy-done").classList.toggle("d-none", !copied);
  button.querySelector(".copy-done").classList.toggle("d-inline-flex", copied);
}

for (const [button, field] of [
  [copyUrlButton, "paste-url"],
  [copyDeleteButton, "delete-url"],
]) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById(field).value);
    setCopied(button, true);
    setTimeout(() => setCopied(button, false), 2000);
  });
  document.getElementById(field).addEventListener("focus", (e) => e.target.select());
}

// However the dialog closes, start a fresh paste.
urlModalEl.addEventListener("hidden.bs.modal", () => {
  resetForm();
  const totalPastes = document.getElementById("total-pastes");
  totalPastes.textContent = (parseInt(totalPastes.textContent, 10) || 0) + 1;
});

// --- Reset ----------------------------------------------------------------

function resetForm() {
  pasteArea.value = "";
  titleInput.value = "";
  syntaxSelect.value = AUTO;
  clearTimeout(detectTimer);
  detectedLanguage = null;
  autoOption.textContent = "Auto-detect";
  clearAttachment();
  document.getElementById(`expire-${DEFAULT_EXPIRY}`).checked = true;
  burnSwitch.checked = false;
  maxViewsInput.disabled = false;
  maxViewsInput.value = "";
  passwordInput.value = "";
  setPasswordVisible(false);

  updateHighlight();
  updateStats();
  resizePasteArea();
  pasteArea.focus();
}

resetForm();
