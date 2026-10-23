// Highlights a long paste off the page's main thread (paste.mjs, for text
// over DIRECT_HIGHLIGHT_MAX), and splits the result into blocks of lines the
// page can swap in one at a time.
//
// highlight.js has to see the whole text: a comment or string can run across
// lines, so pieces highlighted on their own would come out wrong. Splitting
// its output afterwards is safe as long as every line closes the spans still
// open at its end and the next line reopens them, which splitLines does.

import { hljs } from "./highlight.mjs";

// highlight.js output split at newlines, each line with balanced spans.
function splitLines(html) {
  const lines = [];
  const open = [];
  let line = "";
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (part.startsWith("<span")) {
      open.push(part);
      line += part;
    } else if (part === "</span>") {
      open.pop();
      line += part;
    } else {
      line += part;
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

// { text, language, linesPerBlock } -> one HTML string per block, each but
// the last ending in a newline, like the plain blocks the page shows first.
self.onmessage = ({ data: { text, language, linesPerBlock } }) => {
  const lines = splitLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  const blocks = [];
  for (let i = 0; i < lines.length; i += linesPerBlock) {
    const end = i + linesPerBlock;
    blocks.push(lines.slice(i, end).join("\n") + (end < lines.length ? "\n" : ""));
  }
  self.postMessage(blocks);
};
