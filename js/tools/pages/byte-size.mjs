// Byte size converter (templates/tools/byte-size.html.j2): one amount, in
// every unit at once.
import { UNITS, convert, formatAmount, parseAmount } from "../bytes.mjs";
import { bindCopyAndClear } from "../common.mjs";

const converter = document.getElementById("byte-converter");
const input = document.getElementById("bytes-in");
const unitSelect = document.getElementById("bytes-unit");
const error = document.getElementById("bytes-error");
const headline = document.getElementById("bytes-headline");
const target = converter.dataset.to;

function update() {
  error.textContent = "";
  headline.textContent = "";
  let amount = null;
  try {
    amount = parseAmount(input.value);
  } catch (e) {
    error.textContent = e.message;
  }
  for (const u of UNITS) {
    document.getElementById(`bytes-${u.id}`).value =
      amount === null ? "" : formatAmount(convert(amount, unitSelect.value, u.id));
  }
  if (amount !== null) {
    // e.g. "1 GB = 0.931322574615 GiB", or in bytes when the two match.
    const to = target === unitSelect.value ? "B" : target;
    headline.textContent = `${formatAmount(amount)} ${unitSelect.value} = ${formatAmount(convert(amount, unitSelect.value, to))} ${to}`;
  }
}

// The variant's "to" unit (GiB on the main page) stands out in the table.
converter.querySelector(`.bytes-row[data-unit="${target}"]`)?.classList.add("is-target");
unitSelect.value = converter.dataset.from;
input.addEventListener("input", update);
unitSelect.addEventListener("change", update);
bindCopyAndClear();
update();
input.focus();
input.select();
