// Small DOM helpers shared by the page scripts. No side effects on import.

// Server data for the page, rendered by the template as
// <script type="application/json" id="page-data">.
export function readPageData() {
  const el = document.getElementById("page-data");
  return el ? JSON.parse(el.textContent) : {};
}

// The Web Crypto API (crypto.subtle), which all encryption here uses, only
// exists in secure contexts: HTTPS pages and http://localhost.
export function cryptoAvailable() {
  return window.isSecureContext && Boolean(window.crypto?.subtle);
}

// Puts `text` on the clipboard. Resolves to whether it worked: the browser
// can refuse (no permission, an insecure page, or the page isn't focused).
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.error("Copying to the clipboard failed", e);
    return false;
  }
}

const COPIED = { content: "Successfully Copied to clipboard!", customClass: "bg-success" };
const COPY_FAILED = { content: "Couldn't copy. Select the text and copy it yourself.", customClass: "bg-danger" };

// Briefly shows a popover on `button`. One Popover per button: Bootstrap
// keeps each instance's handlers and tip element, so a new one per click
// would pile them up.
function showPopover(button, { content, customClass }) {
  let popover = bootstrap.Popover.getInstance(button);
  // A different message than last time (copied, then failed): start over.
  if (popover && button.dataset.popoverContent !== content) {
    popover.dispose();
    popover = null;
  }
  if (!popover) {
    popover = new bootstrap.Popover(button, { content, placement: "top", trigger: "manual", customClass });
    button.dataset.popoverContent = content;
  }
  clearTimeout(Number(button.dataset.popoverTimer));
  popover.show();
  button.dataset.popoverTimer = setTimeout(() => popover.hide(), 1500);
  return popover;
}

// Briefly shows a "copied" popover on `button`.
export function showCopiedPopover(button) {
  return showPopover(button, COPIED);
}

// Briefly says on `button` that copying didn't work.
export function showCopyFailed(button) {
  return showPopover(button, COPY_FAILED);
}
