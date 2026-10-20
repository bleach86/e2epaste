// View-paste page (paste.html.j2). Rebuilds the key from the server's copy
// and the URL hash, then decrypts in the browser.

import {
  base64ToArrayBuffer,
  decryptPart,
  decryptText,
  getPasteSecrets,
} from "../crypto.mjs";
import { readPageData } from "../ui.mjs";

const { paste, has_password: hasPassword } = readPageData();
const keyFragment = window.location.hash.substring(1);

const viewArea = document.getElementById("view-area");
const passwordInput = document.getElementById("password-input");
const passwordSubmit = document.getElementById("submit-password-btn");
const downloadLink = document.getElementById("download-link");
const downloadSpinner = document.getElementById("download-spinner");
const downloadStatus = document.getElementById("download-status");

// Key and IV for this paste, set once decryption succeeds.
let pasteSecrets = null;
let fileName = null;
let passwordModal;

// Throws if the password or link is wrong.
async function decrypt(password) {
  const secrets = await getPasteSecrets(paste, keyFragment, hasPassword, password);
  const text = await decryptText(base64ToArrayBuffer(paste.content), secrets.key, secrets.iv);
  pasteSecrets = secrets;

  viewArea.textContent = text;
  viewArea.style.height = "100%";

  // v3 titles are encrypted, so the server leaves the heading empty. A title
  // that won't decrypt shouldn't stop the paste itself from showing.
  if (paste.version >= 3) {
    let title = "";
    try {
      title = new TextDecoder().decode(await decryptPart(secrets, "title", base64ToArrayBuffer(paste.title)));
    } catch (e) {
      console.error("Failed to decrypt title", e);
    }
    document.getElementById("paste-title").textContent = title || "Untitled";
  }

  if (paste.file_name) {
    document.getElementById("attachment-section").classList.remove("d-none");

    const nameBytes = await decryptPart(
      secrets,
      "file-name",
      base64ToArrayBuffer(paste.file_name),
    );
    fileName = new TextDecoder().decode(nameBytes);
    downloadLink.textContent = fileName;
  }
}

async function showPaste(password) {
  await decrypt(password);
  hljs.highlightAll();
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
    document.getElementById("views").innerText = "Views: " + data.views;
    document.getElementById("total-views").innerText = data.total_views;
  }
}

// --- Password prompt --------------------------------------------------------

function openPasswordModal() {
  passwordModal = new bootstrap.Modal(document.getElementById("password-modal"));
  passwordModal.show();
  setTimeout(() => passwordInput.focus(), 500);
}

async function decryptWithPassword() {
  // There is no password hash to check against: a wrong password simply
  // fails to decrypt.
  passwordSubmit.disabled = true;
  try {
    await decrypt(passwordInput.value.trim());
  } catch (e) {
    const passError = document.getElementById("password-error");
    passError.style.display = "block";
    setTimeout(() => {
      passError.style.display = "none";
    }, 3000);
    return;
  } finally {
    passwordSubmit.disabled = false;
  }

  passwordModal.hide();
  hljs.highlightAll();
  await markAsViewed();
}

function togglePasswordVisibility() {
  const icon = document.getElementById("show-pass-icon");
  const show = passwordInput.type === "password";

  passwordInput.type = show ? "text" : "password";
  icon.classList.toggle("bi-eye", !show);
  icon.classList.toggle("bi-eye-slash", show);
}

passwordSubmit.addEventListener("click", decryptWithPassword);
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    decryptWithPassword();
  }
});
document.getElementById("show-pass-button").addEventListener("click", togglePasswordVisibility);

// --- Attachment download ----------------------------------------------------

downloadLink.addEventListener("click", async (event) => {
  event.preventDefault();

  downloadSpinner.classList.remove("d-none");
  downloadLink.classList.add("d-none");

  const res = await fetch(`/api/download-attachment/${paste.id}`);
  if (!res.ok) {
    alert("Download failed");
    return;
  }

  downloadStatus.textContent = "Decrypting file...";
  const decrypted = await decryptPart(pasteSecrets, "file", await res.arrayBuffer());

  const url = URL.createObjectURL(new Blob([decrypted], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  downloadSpinner.classList.add("d-none");
  downloadLink.classList.remove("d-none");
  downloadStatus.textContent = "Downloading encrypted file from server...";
});

// --- Paste info -------------------------------------------------------------

function timeUntil(timestamp) {
  const difference = timestamp - Date.now();

  if (difference <= 0) {
    return " Never";
  }

  const seconds = Math.floor(difference / 1000);
  const units = [
    ["years", 31536000],
    ["months", 2592000],
    ["days", 86400],
    ["hours", 3600],
    ["minutes", 60],
  ];

  for (const [unit, size] of units) {
    const count = Math.floor(seconds / size);
    if (count > 1) {
      return count + " " + unit;
    }
  }
  return seconds + " seconds";
}

document.getElementById("expire-date").innerText =
  paste.expires === null ? " Never" : timeUntil(paste.expires);

document.getElementById("paste-date").innerText = new Date(paste.timestamp * 1000).toLocaleDateString(
  "en-US",
  { year: "numeric", month: "long", day: "numeric" },
);

document.getElementById("max-views").innerText = paste.max_views ? paste.max_views : "∞";

// --- Copy / select all ------------------------------------------------------

document.getElementById("copy-paste-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(viewArea.textContent);
});

// Ctrl/Cmd+A selects only the paste content.
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "a") {
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
  openPasswordModal();
} else {
  showPaste("").catch((e) => console.error("Failed to decrypt paste", e));
}
