// DOM wiring shared by the tool pages.

import { copyText, showCopiedPopover, showCopyFailed } from "../ui.mjs";

// Copies `text` when `button` is clicked, and says whether it worked.
export function bindCopy(button, text) {
  button.addEventListener("click", async () => {
    if (await copyText(typeof text === "function" ? text() : text)) {
      showCopiedPopover(button);
    } else {
      showCopyFailed(button);
    }
  });
}

// data-copy="<id>": copy that field's value.
// data-clear="<id> [<id>...]": empty those fields. An input event is fired on
// each so whatever depends on them recalculates.
export function bindCopyAndClear() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    bindCopy(button, () => document.getElementById(button.dataset.copy).value);
  });

  document.querySelectorAll("[data-clear]").forEach((button) => {
    button.addEventListener("click", () => {
      for (const id of button.dataset.clear.split(" ")) {
        const el = document.getElementById(id);
        el.value = "";
        el.dispatchEvent(new Event("input"));
        el.focus();
      }
    });
  });
}

// Live converter for a panel from templates/tool_macros.html.j2: converts
// "<id>-in" into "<id>-out" on every input and shows errors in "<id>-error".
// Returns a function that re-runs the conversion.
export function bindConverter(id, convert) {
  const input = document.getElementById(`${id}-in`);
  const output = document.getElementById(`${id}-out`);
  const error = document.getElementById(`${id}-error`);

  function run() {
    try {
      const result = convert(input.value);
      const { text, warning = "" } = typeof result === "string" ? { text: result } : result;
      output.value = text;
      error.textContent = warning;
    } catch (e) {
      output.value = "";
      error.textContent = e.message;
    }
  }

  input.value = "";
  input.addEventListener("input", run);
  run();
  return run;
}
