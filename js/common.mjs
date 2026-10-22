// Loaded on every page by layout.html.j2, before the page's own script.

import * as bootstrap from "bootstrap";
import { cryptoAvailable } from "./ui.mjs";

// Bootstrap's components, for the pages' scripts as the global `bootstrap`.
// It's loaded only here, so a page has one copy: a second would set up its
// own handlers, and menus and dialogs would toggle twice.
window.bootstrap = bootstrap;

// Banner from layout.html.j2 for pages loaded over plain HTTP, where the
// browser has no Web Crypto API and nothing can be encrypted or decrypted.
if (!cryptoAvailable()) {
  document.getElementById("insecure-warning").hidden = false;

  if (location.protocol === "http:") {
    const link = document.getElementById("insecure-https-link");
    // Same page on the default HTTPS port, keeping the #secret of paste links.
    link.href = `https://${location.hostname}${location.pathname}${location.search}${location.hash}`;
    link.hidden = false;
  }
}

// Older versions registered a service worker that did nothing useful (its
// scope covered no pages). Remove it from browsers that still have it.
navigator.serviceWorker?.getRegistrations().then((registrations) => {
  registrations.forEach((registration) => registration.unregister());
});

document
  .querySelectorAll('[data-bs-toggle="popover"]')
  .forEach((el) => new bootstrap.Popover(el));

// Back-to-top button, on pages that have one.
const backToTop = document.getElementById("btn-back-to-top");

if (backToTop) {
  backToTop.addEventListener("click", () => {
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
  });

  window.addEventListener("scroll", () => {
    const scrolled = document.body.scrollTop > 20 || document.documentElement.scrollTop > 20;
    backToTop.style.display = scrolled ? "block" : "none";
  });
}
