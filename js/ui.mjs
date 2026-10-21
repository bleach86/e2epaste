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

// Briefly shows a "copied" popover on `button`.
export function showCopiedPopover(button) {
  const popover = new bootstrap.Popover(button, {
    content: "Successfully Copied to clipboard!",
    placement: "top",
    trigger: "manual",
    customClass: "bg-success",
  });
  popover.show();
  setTimeout(() => popover.hide(), 1500);
  return popover;
}
