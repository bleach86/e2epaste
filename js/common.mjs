// Loaded on every page by layout.html.j2, after Bootstrap.

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/public/js/sw.js");
}

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
