// Create-paste page (index.html.j2). Encrypts the paste in the browser and
// submits only ciphertext to the server.

import {
  PASTE_VERSION,
  accessHash,
  arrayBufferToBase64,
  deriveV3Secrets,
  encodeDetails,
  encryptFile,
  encryptedFileLength,
  encryptPart,
  generateLinkSecret,
} from "../crypto.mjs";
import {
  rememberDeleteToken,
  rememberingEnabled,
  setRemembering,
} from "../delete_tokens.mjs";
import { enableEditorKeys } from "../editor_keys.mjs";
import qrcode from "qrcode-generator";
import { AUTO, detectLanguage, hljs, languageName } from "../highlight.mjs";
import {
  copyText,
  cryptoAvailable,
  readPageData,
  showCopyFailed,
} from "../ui.mjs";
import { buildZip, zipEntries, zipFits, zipSize } from "../zip.mjs";

// The site's limits (max_paste_kib, max_file_mib, allow_files), before
// encryption. max_file_bytes is null when the site takes no attachments.
const { limits } = readPageData();
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
const rememberSwitch = document.getElementById("remember-delete");
const maxViewsInput = document.getElementById("max-views");
const deleteAfterOpenSelect = document.getElementById("delete-after-open");
const passwordInput = document.getElementById("paste-password");
const passwordToggle = document.getElementById("toggle-password");
const submitButton = document.getElementById("submit-paste");
const submitStatus = document.getElementById("submit-status");
const urlModalEl = document.getElementById("url-modal");
const copyUrlButton = document.getElementById("copy-url-btn");
const copyDeleteButton = document.getElementById("copy-delete-btn");

// The attachment: { name, file } for one file, read a chunk at a time on
// upload, or { name, entries } for several files, zipped into one when the
// paste is sent.
let attachment;
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
  pasteStats.classList.toggle("text-danger", bytes > limits.max_paste_bytes);
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
  return language !== "plaintext" && hljs.getLanguage(language)
    ? language
    : null;
}

// Guesses the language again and shows it in the picker, e.g.
// "Auto-detect (Rust)".
function redetect() {
  detectedLanguage = detectLanguage(pasteArea.value);
  autoOption.textContent = detectedLanguage
    ? `Auto-detect (${languageName(detectedLanguage)})`
    : "Auto-detect";
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

enableEditorKeys(pasteArea);

// --- Attachment -----------------------------------------------------------

function clearAttachment() {
  attachment = undefined;
  // Neither is on the page when the site takes no attachments.
  if (fileInput) {
    fileInput.value = "";
    attachmentRow.hidden = true;
    attachmentRow.title = "";
  }
}

function showAttachment(name, details, contents = "") {
  document.getElementById("attachment-name").textContent = name;
  document.getElementById("attachment-size").textContent = details;
  attachmentRow.title = contents;
  attachmentRow.hidden = false;
}

// From the picker or a drop; replaces whatever was attached before. One
// file goes as it is; several are zipped.
function attachFiles(files) {
  if (files.length === 1) {
    const [file] = files;
    if (file.size > limits.max_file_bytes) {
      alert(`File is too large. Please keep it under ${limits.max_file_label}.`);
      clearAttachment();
      return;
    }
    attachment = { name: file.name, file };
    showAttachment(file.name, formatBytes(file.size));
    return;
  }

  const entries = zipEntries(files);
  const size = zipSize(entries);
  if (!zipFits(entries) || size > limits.max_file_bytes) {
    alert(
      `Those files come to ${formatBytes(size)}. Please keep them under ${limits.max_file_label}.`,
    );
    clearAttachment();
    return;
  }
  attachment = { name: "files.zip", entries };
  const shown = entries.slice(0, 40).map((e) => e.name);
  if (entries.length > shown.length) {
    shown.push(`and ${entries.length - shown.length} more`);
  }
  showAttachment(
    "files.zip",
    `${formatBytes(size)} · ${entries.length.toLocaleString()} files, zipped`,
    shown.join("\n"),
  );
}

fileInput?.addEventListener("change", (event) => {
  const files = [...event.target.files];
  if (files.length) {
    attachFiles(files);
  } else {
    clearAttachment();
  }
});

// Files dropped anywhere on the page. Dragged text is left to the browser,
// so it still drops into the editor as text. On a site that takes no files
// the drop is still caught, so the browser doesn't open the file instead.
const dropOverlay = document.getElementById("drop-overlay");
let dragDepth = 0;

function draggingFiles(event) {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

function showDropOverlay(show) {
  dropOverlay.hidden = !show;
  if (!show) {
    dragDepth = 0;
  }
}

document.addEventListener("dragenter", (event) => {
  if (draggingFiles(event)) {
    // dragenter/dragleave fire for every element crossed; count them.
    dragDepth++;
    showDropOverlay(!submitting);
  }
});

document.addEventListener("dragleave", (event) => {
  if (draggingFiles(event) && --dragDepth <= 0) {
    showDropOverlay(false);
  }
});

document.addEventListener("dragover", (event) => {
  if (draggingFiles(event)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = fileInput && !submitting ? "copy" : "none";
  }
});

document.addEventListener("drop", (event) => {
  if (!draggingFiles(event)) {
    return;
  }
  event.preventDefault();
  showDropOverlay(false);
  if (!fileInput || submitting) {
    return;
  }

  // A folder shows up as a file that can't be read; only its entry says
  // what it is.
  const folder = [...event.dataTransfer.items].some(
    (i) => i.kind === "file" && i.webkitGetAsEntry?.()?.isDirectory,
  );
  if (folder) {
    alert("Folders can't be attached. Zip the folder first, or drop the files in it.");
    return;
  }
  const files = [...event.dataTransfer.files];
  if (files.length) {
    // The picker would still show its old choice.
    fileInput.value = "";
    attachFiles(files);
  }
});

document
  .getElementById("attachment-remove")
  ?.addEventListener("click", clearAttachment);

// --- Options --------------------------------------------------------------

function selectedExpiry() {
  return (
    document.querySelector('input[name="expire"]:checked')?.value ??
    DEFAULT_EXPIRY
  );
}

function expiryLabel(value) {
  return (
    document
      .querySelector(`label[for="expire-${value}"]`)
      ?.textContent.trim() ?? value
  );
}

// The field's minimum is 0 so stepping down from 1 is possible; 0 becomes
// "Unlimited" at once, before it's drawn, however it was stepped to (arrow
// keys and the wheel only fire "change" when the field loses focus).
maxViewsInput.addEventListener("input", () => {
  if (maxViewsInput.value === "0") {
    maxViewsInput.value = "";
  }
});

// Anything else out of range, once it's typed.
maxViewsInput.addEventListener("change", () => {
  const n = parseInt(maxViewsInput.value, 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_VIEWS) {
    maxViewsInput.value = "";
  }
});

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
  passwordToggle.setAttribute(
    "aria-label",
    visible ? "Hide password" : "Show password",
  );
}

passwordToggle.addEventListener("click", () =>
  setPasswordVisible(passwordInput.type === "password"),
);

// --- Submit ---------------------------------------------------------------

function setBusy(busy) {
  submitting = busy;
  submitStatus.textContent = "Encrypting...";
  submitButton.disabled = busy;
  submitButton.querySelector(".submit-idle").classList.toggle("d-none", busy);
  submitButton.querySelector(".submit-busy").classList.toggle("d-none", !busy);
  submitButton
    .querySelector(".submit-busy")
    .classList.toggle("d-inline-flex", busy);
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

// What the server says when a limit is reached (src/api.rs ApiError), for
// people. `wait` is e.g. "4 minutes".
const LIMIT_MESSAGES = {
  pastes_per_minute: (n, wait) =>
    `You've created ${n} ${n === 1 ? "paste" : "pastes"} in the last minute, this site's limit. Please try again in ${wait}.`,
  pastes_per_hour: (n, wait) =>
    `You've created ${n} ${n === 1 ? "paste" : "pastes"} in the last hour, this site's limit. Please try again in ${wait}.`,
  upload_mib_per_hour: (n, wait) =>
    `This attachment would go over this site's limit of ${n} MB of attachments an hour. Please try again in ${wait}, or use a smaller file.`,
};

// Turns a refused request into a RefusedError explaining why.
async function refusal(response, what) {
  const body = await response.json().catch(() => ({}));
  switch (response.status) {
    case 429: {
      const retryAfter =
        Number(body.retry_after ?? response.headers.get("Retry-After")) || 60;
      const message = LIMIT_MESSAGES[body.limit];
      return new RefusedError(
        message
          ? message(body.allowed, waitText(retryAfter))
          : `You've reached one of this site's limits. Please try again in ${waitText(retryAfter)}.`,
      );
    }
    case 507:
      return new RefusedError(
        body.reason === "attachments"
          ? "This site has reached its storage limit for attachments. You can still create a paste without one."
          : "The server is out of storage space right now, so it can't take new pastes.",
      );
    case 413:
      return new RefusedError(
        what === "attachment" || attachment
          ? `The attachment is too large. Please keep it under ${limits.max_file_label}.`
          : `The paste is too large. Please keep it under ${limits.max_paste_label}.`,
      );
    case 400:
      if (body.reason) {
        return new RefusedError(
          `The server didn't accept the ${what}: ${body.reason}.`,
        );
      }
      return new Error(`The server didn't accept the ${what} (400)`);
    default:
      return new Error(
        `The server didn't accept the ${what} (${response.status})`,
      );
  }
}

const UPLOAD_TRIES = 4;

// Encrypts the attachment and uploads it one chunk at a time, so it's never
// in memory whole. `token` is the one-time upload token the server returned
// with the paste ID. A chunk that fails on the network (or the server) is
// sent again; the server replaces it.
async function uploadFile(file, key, iv, id, token) {
  const total = encryptedFileLength(file.size);
  let sent = 0;
  const showProgress = () => {
    submitStatus.textContent = `Encrypting and uploading... ${Math.floor((sent / total) * 100)}%`;
  };
  showProgress();
  await encryptFile(file, key, iv, async (index, last, chunk) => {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetch(
          `/api/upload-attachment/${id}/${index}?last=${last}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Upload-Token": token,
            },
            body: chunk,
          },
        );
      } catch (e) {
        if (attempt >= UPLOAD_TRIES) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (response.ok) {
        break;
      }
      if (response.status < 500 || attempt >= UPLOAD_TRIES) {
        throw await refusal(response, "attachment");
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    sent += chunk.length;
    showProgress();
  });
}

async function createPaste() {
  const text = pasteArea.value;

  // A paste can be just an attachment.
  if (text === "" && !attachment) {
    pasteArea.focus();
    return;
  }

  if (new TextEncoder().encode(text).byteLength > limits.max_paste_bytes) {
    alert(
      `Paste is too large. Please keep it under ${limits.max_paste_label}.`,
    );
    return;
  }

  const expire = selectedExpiry();
  const lifetime = EXPIRE_SECONDS[expire] ?? EXPIRE_SECONDS["1year"];
  const views = maxViews();
  const deleteAfterOpen = Number(deleteAfterOpenSelect.value) || null;
  const password = passwordInput.value.trim();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Several files are zipped first: the paste says the attachment's size.
  let file = attachment?.file ?? null;
  if (attachment?.entries) {
    file = await buildZip(attachment.entries, {
      onProgress: (done, total) => {
        submitStatus.textContent = `Zipping files... ${Math.floor((done / total) * 100)}%`;
      },
    }).catch((e) => {
      console.error(e);
      throw new RefusedError(
        "One of the files couldn't be read, or changed since it was attached. Please attach them again.",
      );
    });
    submitStatus.textContent = "Encrypting...";
  }

  // The secret only ever goes in the link's #fragment, which browsers never
  // send to the server. With a password, the key also depends on it, and the
  // link (not the server) says there is one.
  const linkSecret = generateLinkSecret({ password: password !== "" });
  const { key, accessProof } = await deriveV3Secrets(
    linkSecret,
    iv,
    password === "" ? null : password,
  );

  // Every part is padded to a rounded size before encryption, so the server
  // can't tell much from sizes (see PART_PADDING in crypto.mjs).
  const encode = (value) => new TextEncoder().encode(value);
  const encrypted = await encryptPart(key, iv, "text", encode(text));
  // The attachment itself is encrypted as it's uploaded, after the paste is
  // created (uploadFile).
  const encryptedFileName = file
    ? arrayBufferToBase64(
        await encryptPart(key, iv, "file-name", encode(attachment.name)),
      )
    : null;

  // The title and the language are encrypted together; an empty title is
  // shown as "Untitled". Cut by code point so the 64-character limit can't
  // split an emoji.
  const titleText = Array.from(titleInput.value).slice(0, 64).join("");
  const title = await encryptPart(
    key,
    iv,
    "title",
    encodeDetails(titleText, syntaxSelect.value),
  );

  const paste = {
    content: arrayBufferToBase64(encrypted),
    iv: Array.from(iv),
    // A lifetime, not a time: the server works out when, so a wrong clock here
    // doesn't matter.
    expires_in: lifetime,
    max_views: views,
    // Seconds; the server starts the timer at the first view.
    delete_after_open: deleteAfterOpen,
    key_fragment: "", // no key material is stored on the server
    // In the link instead (see above).
    has_password: false,
    version: PASTE_VERSION,
    title: arrayBufferToBase64(title),
    // Encrypted with the title instead.
    syntax: "auto",
    file_name: encryptedFileName,
    // So the server can check it against the limits before creating anything.
    file_size: file ? encryptedFileLength(file.size) : null,
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
  const remembered = rememberSwitch.checked;
  if (remembered) {
    rememberDeleteToken(data.id, data.delete_token, lifetime);
  }
  // The paste exists from here on, whatever happens to the attachment: a
  // failed upload leaves the text paste in place (with an attachment that
  // can't be downloaded), so the link is shown either way, with the
  // problem spelled out. A refused upload (a limit) is an error of its own.
  let uploadFailed = null;
  if (file) {
    try {
      await uploadFile(file, key, iv, data.id, data.upload_token);
    } catch (e) {
      if (e instanceof RefusedError) {
        throw e;
      }
      console.error("Uploading the attachment failed", e);
      uploadFailed = e;
    }
  }

  // Hand out /s/ (short for /share/) links: link-preview bots can fetch that
  // page (robots.txt blocks /paste/) and it forwards browsers on. The origin
  // is the address this page was loaded from, so links work whatever
  // site_url is set to.
  showLink(
    `${location.origin}/s/${data.id}#${linkSecret}`,
    `${location.origin}/delete/${data.id}#${data.delete_token}`,
    {
      expiry: expiryLabel(expire),
      views,
      deleteAfterOpen:
        deleteAfterOpen &&
        deleteAfterOpenSelect.selectedOptions[0].dataset.chip,
      password: password !== "",
      attachment: Boolean(file),
      uploadFailed: Boolean(uploadFailed),
      remembered,
    },
  );
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
    alert(
      e instanceof RefusedError
        ? e.message
        : "Failed to create paste. Please try again.",
    );
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
  document.getElementById("delete-remembered").hidden = !settings.remembered;

  const chips = [chip("clock", `Expires in ${settings.expiry}`)];
  if (settings.views === 1) {
    chips.push(chip("flame", "Burns after 1 view", true));
  } else if (settings.views) {
    chips.push(
      chip("eye", `Limited to ${settings.views.toLocaleString()} views`),
    );
  }
  if (settings.deleteAfterOpen) {
    chips.push(chip("clock", settings.deleteAfterOpen, true));
  }
  if (settings.password) {
    chips.push(chip("lock", "Password protected"));
  }
  if (settings.attachment) {
    chips.push(
      settings.uploadFailed
        ? chip("paperclip", "Attachment not uploaded", true)
        : chip("paperclip", "Encrypted attachment"),
    );
  }
  document.getElementById("link-summary").replaceChildren(...chips);
  document.getElementById("upload-failed").hidden = !settings.uploadFailed;
  // Point at the delete link, since that's the way out.
  urlModalEl.querySelector(".delete-details").open = Boolean(settings.uploadFailed);

  document.getElementById("link-tip").textContent = settings.password
    ? "Send the password a different way from the link, for example the link by email and the password by text. A lost link or password can't be recovered."
    : "Anyone who gets this link can read the paste, so share it only where you'd share the content itself. A lost link can't be recovered.";

  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  document.getElementById("qrcode-container").innerHTML = qr.createImgTag(
    4,
    2,
    "QR code of the link",
  );
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
    // Only say "Copied" if it was; the field can still be selected by hand.
    if (!(await copyText(document.getElementById(field).value))) {
      showCopyFailed(button);
      return;
    }
    setCopied(button, true);
    setTimeout(() => setCopied(button, false), 2000);
  });
  document
    .getElementById(field)
    .addEventListener("focus", (e) => e.target.select());
}

// However the dialog closes, start a fresh paste.
urlModalEl.addEventListener("hidden.bs.modal", () => {
  resetForm();
  const totalPastes = document.getElementById("total-pastes");
  totalPastes.textContent = (parseInt(totalPastes.textContent, 10) || 0) + 1;
});

// Kept across visits, not reset with the form.
rememberSwitch.checked = rememberingEnabled();
rememberSwitch.addEventListener("change", () =>
  setRemembering(rememberSwitch.checked),
);

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
  deleteAfterOpenSelect.value = "";
  passwordInput.value = "";
  setPasswordVisible(false);

  updateHighlight();
  updateStats();
  resizePasteArea();
  pasteArea.focus();
}

resetForm();
