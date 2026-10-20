// DOM wiring shared by the tool pages.

import { showCopiedPopover } from "../ui.mjs";

// data-copy="<id>": copy that field's value.
// data-clear="<id> [<id>...]": empty those fields. An input event is fired on
// each so whatever depends on them recalculates.
export function bindCopyAndClear() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(document.getElementById(button.dataset.copy).value);
      showCopiedPopover(button);
    });
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
