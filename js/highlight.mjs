// Guessing a paste's language for syntax highlighting ("Auto-detect"), with
// the highlight.js loaded by the page (static/js/highlight.min.js, the
// global `hljs`).
//
// The guess is made in the browser, by the creator's page while typing and
// again by each viewer's page after decrypting. The server stores only
// "auto", so it doesn't learn what kind of content a paste holds.

export const AUTO = "auto";

// Languages a guess can be, most commonly pasted first; the order breaks
// ties. Left out because they're rarely pasted and get confused with common
// ones: VB.NET (matches prose and SQL), PHP template (matches HTML), Python
// REPL, WebAssembly, shell sessions and plain text.
const CANDIDATES = [
  "javascript", "python", "java", "typescript", "csharp", "cpp", "c", "go", "rust", "php", "ruby", "kotlin",
  "swift", "sql", "bash", "json", "yaml", "xml", "css", "scss", "markdown", "diff", "ini", "lua", "perl", "r",
  "makefile", "graphql", "objectivec", "less",
];

// Below this highlight.js relevance, the text is treated as plain text.
// Prose and log files score up to about 5; real code from 7 up.
const MIN_RELEVANCE = 6;

// Only the start of a long paste is looked at, so guessing stays fast.
const SAMPLE_CHARS = 20000;

// highlight.js scores C++ as C, and both look the same highlighted as C++
// anyway; these only appear in C++.
const CPP_MARKERS = /\bstd::|\bnamespace\b|\btemplate\s*<|\bcout\b|\bclass\s+\w+/;

// The most likely language of `text`, or null if it doesn't look like code.
export function detectLanguage(text) {
  const sample = text.slice(0, SAMPLE_CHARS);
  if (sample.trim().length < 20) {
    return null;
  }

  let best = null;
  CANDIDATES.forEach((language, rank) => {
    if (!hljs.getLanguage(language)) {
      return;
    }
    const result = hljs.highlight(sample, { language, ignoreIllegals: false });
    // Syntax the language doesn't allow rules it out.
    if (result.illegal) {
      return;
    }
    if (!best || result.relevance > best.relevance) {
      best = { language, rank, relevance: result.relevance };
    }
  });

  if (!best || best.relevance < MIN_RELEVANCE) {
    return null;
  }
  return best.language === "c" && CPP_MARKERS.test(sample) ? "cpp" : best.language;
}

// The language to highlight a paste in: its chosen one, a guess for "auto",
// or null for plain text (or a language this page can't highlight).
export function effectiveLanguage(syntax, text) {
  if (syntax === AUTO) {
    return detectLanguage(text);
  }
  return syntax && syntax !== "plaintext" && hljs.getLanguage(syntax) ? syntax : null;
}

// Names to show where highlight.js's own are missing or long-winded.
const NAMES = {
  bash: "Bash", php: "PHP", ini: "INI", xml: "HTML/XML", objectivec: "Objective-C", makefile: "Makefile",
  graphql: "GraphQL", r: "R", plaintext: "Plain text",
};

// The display name of a highlight.js language, e.g. "JavaScript".
export function languageName(language) {
  return NAMES[language] ?? hljs.getLanguage(language)?.name ?? language;
}
