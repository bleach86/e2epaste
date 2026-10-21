// Number base converter (templates/tools/number-base.html.j2): typing in any
// field converts into all the others.
import { bitLength, formatNumber, fromBits, parseNumber, toBits } from "../numbers.mjs";
import { bindCopyAndClear } from "../common.mjs";

const converter = document.getElementById("base-converter");
const fields = [...converter.querySelectorAll("[data-base]")];
const customBase = document.getElementById("custom-base");
const customField = document.getElementById("num-custom");
const widthSelect = document.getElementById("bit-width");
const upperBox = document.getElementById("opt-upper");
const groupBox = document.getElementById("opt-group");
const prefixBox = document.getElementById("opt-prefix");
const info = document.getElementById("num-info");

// The field last typed in, which the others follow.
let source = null;

function baseOf(field) {
  return field === customField ? Number(customBase.value) : Number(field.dataset.base);
}

function errorOf(field) {
  return document.getElementById(`${field.id}-error`);
}

// Each field is one line that grows to fit a long number.
function fit(field) {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight + 2}px`;
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function update() {
  for (const field of fields) {
    errorOf(field).textContent = "";
  }
  info.textContent = "";
  if (!source) {
    return;
  }
  const others = fields.filter((f) => f !== source);
  const clearOthers = () => others.forEach((f) => (f.value = ""));

  let value;
  try {
    value = parseNumber(source.value, baseOf(source));
  } catch (e) {
    errorOf(source).textContent = e.message;
    clearOthers();
    return;
  }
  if (value === null) {
    clearOthers();
    return;
  }

  const width = Number(widthSelect.value) || null;
  let shown = value;
  if (width) {
    let bits;
    try {
      bits = toBits(value, width);
    } catch (e) {
      errorOf(source).textContent = e.message;
      clearOthers();
      return;
    }
    // Like a programmer's calculator: decimal shows the signed value.
    shown = fromBits(bits, width);
    info.textContent = `As ${width} bits: signed ${shown.toLocaleString()}, unsigned ${bits.toLocaleString()}`;
  } else {
    const bits = bitLength(value);
    info.textContent = `Needs ${plural(bits, "bit")} (${plural(Math.ceil(bits / 8), "byte")})${value < 0n ? " as two's complement" : ""}`;
  }

  const options = { upper: upperBox.checked, group: groupBox.checked, prefix: prefixBox.checked };
  for (const field of others) {
    const base = baseOf(field);
    field.value =
      base === 10
        ? formatNumber(shown, 10, { group: options.group })
        : formatNumber(value, base, { ...options, width });
  }
}

function updateAndFit() {
  update();
  fields.forEach(fit);
}

for (const field of fields) {
  field.addEventListener("input", () => {
    source = field;
    updateAndFit();
  });
  // One line each: Enter doesn't add a new one.
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  });
}

for (const option of [widthSelect, upperBox, groupBox, prefixBox]) {
  option.addEventListener("change", updateAndFit);
}

// A new base re-reads the custom field's digits if that's what was typed in,
// and otherwise rewrites it.
customBase.addEventListener("change", () => {
  customField.placeholder = `Base ${customBase.value}`;
  updateAndFit();
});

// Clear: every field, and nothing to follow.
document.getElementById("num-clear").addEventListener("click", () => {
  source = null;
  fields.forEach((f) => (f.value = ""));
  updateAndFit();
  fields[0].focus();
});

bindCopyAndClear();

// A variant page (e.g. Hex to Decimal) starts in its "from" field.
const start = converter.querySelector(`[data-base="${converter.dataset.from}"]`) ?? fields[0];
start.focus();
