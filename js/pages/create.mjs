// Create-paste page (index.html.j2). Encrypts the paste in the browser and
// submits only ciphertext to the server.

import {
  PASTE_VERSION,
  arrayBufferToBase64,
  deriveIv,
  deriveKeyWithPassword,
  encryptBytes,
  encryptText,
  exportCryptoKey,
  fragmentKey,
  generateKey,
} from "../crypto.mjs";
import { readPageData, showCopiedPopover } from "../ui.mjs";

const MAX_PASTE_BYTES = 1048576;
const MAX_FILE_BYTES = 26214400;
const MAX_VIEWS = 999999999999;

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

const { host } = readPageData();

const pasteArea = document.getElementById("paste-area");
const maxViewsInput = document.getElementById("max-views");
const titleInput = document.getElementById("paste-title");
const passwordInput = document.getElementById("paste-password");
const fileInput = document.getElementById("fileInput");
const expireDropdown = document.getElementById("expireDropdown");
const displayDropdown = document.getElementById("displayDropdown");
const submitButton = document.getElementById("submit-paste");
const loadingButton = document.getElementById("loading-button");
const copyUrlButton = document.getElementById("copy-url-btn");
const closeUrlButton = document.getElementById("close-url-btn");

let urlModal;
let copied = false;
let fileData;
let fileName;

pasteArea.value = "";
maxViewsInput.value = "0";
titleInput.value = "";
passwordInput.value = "";
fileInput.value = "";
pasteArea.focus();
tabOverride.set(pasteArea);

function resizePasteArea() {
  pasteArea.style.height = "auto";
  pasteArea.style.height = pasteArea.scrollHeight + "px";
}

pasteArea.addEventListener("input", resizePasteArea);

fileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];

  if (file.size > MAX_FILE_BYTES) {
    alert("File is too large. Please keep it under 25MB.");
    fileInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    fileData = e.target.result;
    fileName = file.name;
  };
  reader.readAsArrayBuffer(file);
});

function bindDropdown(itemSelector, button) {
  document.querySelectorAll(itemSelector).forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      button.innerText = item.innerText;
      button.setAttribute("data-value", item.getAttribute("data-value"));
    });
  });
}

bindDropdown(".dropdown-item.expire-dropdown", expireDropdown);
bindDropdown(".dropdown-item.display-dropdown", displayDropdown);

function parseMaxViews(value) {
  if (value === "" || value === "0" || value < 0) {
    return null;
  }
  return Math.min(parseInt(value), MAX_VIEWS);
}

async function uploadEncryptedFile(file, id) {
  await fetch(`/api/upload-attachment/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
}

submitButton.addEventListener("click", async () => {
  const text = pasteArea.value;

  if (text === "") {
    return;
  }

  if (new TextEncoder().encode(text).byteLength > MAX_PASTE_BYTES) {
    alert("Paste is too large. Please keep it under 1MB.");
    return;
  }

  loadingButton.style.display = "block";
  submitButton.style.display = "none";

  const expire = expireDropdown.getAttribute("data-value");
  const syntax = displayDropdown.getAttribute("data-value");
  const password = passwordInput.value.trim();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const pasteKey = await generateKey();
  // With a password, the content key also depends on the password, so the
  // link alone isn't enough to decrypt.
  const key = password === "" ? pasteKey : await deriveKeyWithPassword(pasteKey, password, iv);
  const keyFragments = fragmentKey(await exportCryptoKey(pasteKey));

  const encrypted = await encryptText(text, key, iv);
  let encryptedFile = null;
  let encryptedFileName = null;

  if (fileData) {
    encryptedFile = await encryptBytes(fileData, key, await deriveIv(iv, "file"));
    const cipherName = await encryptText(fileName, key, await deriveIv(iv, "file-name"));
    encryptedFileName = arrayBufferToBase64(cipherName);
  }

  const expireSeconds = EXPIRE_SECONDS[expire] ?? EXPIRE_SECONDS["1year"];
  const title = titleInput.value === "" ? "Untitled" : titleInput.value;

  const paste = {
    content: arrayBufferToBase64(encrypted),
    iv: Array.from(iv),
    expires: Date.now() + expireSeconds * 1000,
    max_views: parseMaxViews(maxViewsInput.value),
    key_fragment: keyFragments.serverKey,
    has_password: password !== "",
    version: PASTE_VERSION,
    title: title.substring(0, 64),
    syntax,
    file_name: encryptedFileName,
  };

  const response = await fetch("/api/submit_paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(paste),
  });
  const data = await response.json();

  if (data.id) {
    if (encryptedFile) {
      await uploadEncryptedFile(encryptedFile, data.id);
    }

    loadingButton.style.display = "none";
    submitButton.style.display = "block";
    openModal(`${host}/paste/${data.id}#${keyFragments.hashFragment}`);
  } else {
    alert("Failed to create paste");
  }
});

function openModal(url) {
  urlModal = new bootstrap.Modal(document.getElementById("url-modal"));
  document.getElementById("paste-url").value = url;

  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  document.getElementById("qrcode-container").innerHTML = qr.createImgTag(4, 2);

  urlModal.show();
}

function closeModal() {
  urlModal.hide();
  closeUrlButton.style.display = "none";
  copyUrlButton.style.display = "block";
  copied = false;
  resizePasteArea();

  const totalPastes = document.getElementById("total-pastes");
  totalPastes.innerText = parseInt(totalPastes.innerText) + 1;
}

function resetForm() {
  pasteArea.value = "";
  maxViewsInput.value = "0";
  passwordInput.value = "";
  titleInput.value = "";
  fileInput.value = "";
  fileData = undefined;
  fileName = undefined;

  expireDropdown.setAttribute("data-value", "3days");
  expireDropdown.innerText = "3 Days";

  displayDropdown.setAttribute("data-value", "plaintext");
  displayDropdown.innerText = "Plaintext";

  pasteArea.focus();
}

// First click copies the URL, after which the button turns into "Close".
function copyUrl() {
  if (copied) {
    closeModal();
    return;
  }

  navigator.clipboard.writeText(document.getElementById("paste-url").value);
  showCopiedPopover(copyUrlButton);
  copied = true;

  setTimeout(() => {
    resetForm();
    closeUrlButton.style.display = "block";
    copyUrlButton.style.display = "none";
  }, 500);
}

document.getElementById("url-modal-close").addEventListener("click", copyUrl);
copyUrlButton.addEventListener("click", copyUrl);
closeUrlButton.addEventListener("click", closeModal);
