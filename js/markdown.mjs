// Renders Markdown pastes as HTML (paste.mjs loads this only for Markdown
// pastes). The paste is untrusted, so:
//
// - HTML written in the Markdown is shown as text, not passed through. Only
//   Markdown syntax is rendered.
// - What marked produces still goes through DOMPurify, then a second pass in
//   an inert document for this site's rules:
//   - Remote images become links: loading them would tell whoever hosts them
//     the IP of everyone who opens the paste (and the CSP blocks them anyway).
//   - Only http(s) and mailto links are kept. In-page "#..." links would
//     replace the link secret in the address bar.
//   - No class attributes (except code block languages), so a paste can't
//     borrow the site's own styles to imitate its buttons or notices.
//
// The page's Content Security Policy (no inline script or style) is a further
// line of defence if anything got through.

import DOMPurify from "dompurify";
import { Marked } from "marked";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    // Raw HTML, in a block of its own or inline: shown as the text it is.
    html({ text, block }) {
      return block ? `<p>${escapeHtml(text.trim())}</p>\n` : escapeHtml(text);
    },
  },
});

const SANITIZE = {
  USE_PROFILES: { html: true }, // no SVG or MathML
  FORBID_TAGS: [
    "style", "form", "button", "textarea", "select", "option", "iframe", "frame", "object", "embed", "video",
    "audio", "source", "track", "picture", "dialog", "template", "link", "meta", "base",
  ],
  FORBID_ATTR: ["style", "id", "name", "srcset", "target", "formaction"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const LINK_PROTOCOLS = /^(https?:|mailto:)/i;
const IMAGE_DATA_URL = /^data:image\/(png|gif|jpe?g|webp|avif);/i;
const CODE_LANGUAGE = /^language-[\w+#-]+$/;

// Returns a fragment of sanitized HTML for `text`.
export function renderMarkdown(text) {
  const clean = DOMPurify.sanitize(marked.parse(text), SANITIZE);

  // DOMParser documents are inert: nothing in them loads or runs.
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  const body = doc.body;

  for (const el of body.querySelectorAll("[class]")) {
    const keep = el.tagName === "CODE" && CODE_LANGUAGE.test(el.getAttribute("class"));
    if (!keep) {
      el.removeAttribute("class");
    }
  }

  for (const a of body.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (LINK_PROTOCOLS.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow ugc");
    } else {
      a.removeAttribute("href");
    }
  }

  for (const img of body.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (IMAGE_DATA_URL.test(src)) {
      continue;
    }
    // Shown as a link the reader can choose to open.
    const label = `Image: ${img.getAttribute("alt") || src || "(no address)"}`;
    const replacement = doc.createElement(/^https?:/i.test(src) ? "a" : "span");
    replacement.textContent = label;
    replacement.className = "md-image-link";
    if (replacement.tagName === "A") {
      replacement.setAttribute("href", src);
      replacement.setAttribute("target", "_blank");
      replacement.setAttribute("rel", "noopener noreferrer nofollow ugc");
      replacement.title = "Not loaded, to keep your IP address private. Opens in a new tab.";
    }
    img.replaceWith(replacement);
  }

  // Task list checkboxes are the only inputs marked makes; keep them read-only.
  for (const input of body.querySelectorAll("input")) {
    if (input.getAttribute("type") === "checkbox") {
      input.setAttribute("disabled", "");
    } else {
      input.remove();
    }
  }

  const fragment = document.createDocumentFragment();
  fragment.append(...Array.from(body.childNodes, (node) => document.importNode(node, true)));
  return fragment;
}
