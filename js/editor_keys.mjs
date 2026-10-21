// Code-editor keys for a textarea: Tab indents (every selected line, when
// the selection spans lines), Shift+Tab outdents, and Enter keeps the
// current line's indentation.
//
// Edits go through the browser's own "insert text" command, like typing, so
// they fire `input` (the create page redraws its highlighting on that) and
// can be undone with Ctrl+Z. Setting `value` directly does neither.
//
// Tab never leaves the editor, so Escape hands the next Tab back to the
// browser, to move focus on to the next control.

const INDENT = "\t";

// Replaces the text from `start` to `end` and selects `select` (default: a
// caret after the new text).
function replace(textarea, start, end, text, select = null) {
  textarea.setSelectionRange(start, end);
  // execCommand is deprecated but still the only edit that keeps the undo
  // history; every current browser supports it in textareas.
  if (!document.execCommand("insertText", false, text)) {
    textarea.setRangeText(text, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (select) {
    textarea.setSelectionRange(select[0], select[1]);
  }
}

function lineStart(value, index) {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function indent(textarea, outdent) {
  const { value, selectionStart, selectionEnd } = textarea;
  const multiLine = value.slice(selectionStart, selectionEnd).includes("\n");
  if (!multiLine && !outdent) {
    replace(textarea, selectionStart, selectionEnd, INDENT);
    return;
  }

  // Whole lines, from the selection's first line to its last. A selection
  // ending at the start of a line doesn't include that line.
  const start = lineStart(value, selectionStart);
  let end = selectionEnd;
  if (multiLine && value[end - 1] === "\n") {
    end -= 1;
  }
  end = value.indexOf("\n", end);
  if (end === -1) {
    end = value.length;
  }

  const lines = value.slice(start, end).split("\n");
  const changed = lines.map((line) => {
    if (!outdent) {
      return line === "" ? line : INDENT + line;
    }
    // One tab, or up to four spaces.
    return line.replace(/^(\t| {1,4})/, "");
  });
  const block = changed.join("\n");
  if (block === value.slice(start, end)) {
    return;
  }
  if (multiLine) {
    replace(textarea, start, end, block, [start, start + block.length]);
  } else {
    // Outdenting the caret's line: keep the caret where it was in the text.
    const removed = lines[0].length - changed[0].length;
    const caret = Math.max(start, selectionStart - removed);
    replace(textarea, start, end, block, [caret, Math.max(caret, selectionEnd - removed)]);
  }
}

function newLine(textarea) {
  const { value, selectionStart, selectionEnd } = textarea;
  const start = lineStart(value, selectionStart);
  const leading = value.slice(start, selectionStart).match(/^[ \t]*/)[0];
  replace(textarea, selectionStart, selectionEnd, "\n" + leading);
}

export function enableEditorKeys(textarea) {
  let tabReleased = false;

  textarea.addEventListener("keydown", (event) => {
    // Typing in an input method's composition window.
    if (event.isComposing || event.defaultPrevented) {
      return;
    }
    if (event.key === "Escape") {
      tabReleased = true;
      return;
    }
    const released = tabReleased;
    tabReleased = false;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key === "Tab" && !released) {
      event.preventDefault();
      indent(textarea, event.shiftKey);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      newLine(textarea);
    }
  });
  textarea.addEventListener("blur", () => {
    tabReleased = false;
  });
}
