import { findOccurrences } from "../text.mjs";
import { bindCopyAndClear } from "../common.mjs";

const term = document.getElementById("occ-term");
const text = document.getElementById("occ-text");
const caseSensitive = document.getElementById("occ-case");
const wholeWord = document.getElementById("occ-whole");
const count = document.getElementById("occ-count");
const preview = document.getElementById("occ-preview");

// Rebuilds the preview from text nodes and <mark>s, never HTML strings, so
// pasted markup is shown as text.
function update() {
  const value = text.value;
  const matches = findOccurrences(value, term.value, {
    caseSensitive: caseSensitive.checked,
    wholeWord: wholeWord.checked,
  });
  count.textContent = matches.length.toLocaleString();

  const parts = [];
  let last = 0;
  for (const [start, end] of matches) {
    parts.push(document.createTextNode(value.slice(last, start)));
    const mark = document.createElement("mark");
    mark.className = "highlight";
    mark.textContent = value.slice(start, end);
    parts.push(mark);
    last = end;
  }
  parts.push(document.createTextNode(value.slice(last)));
  preview.replaceChildren(...parts);
}

term.value = "";
text.value = "";
for (const el of [term, text, caseSensitive, wholeWord]) {
  el.addEventListener("input", update);
}
update();
bindCopyAndClear();
