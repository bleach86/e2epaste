// Unix timestamp converter (templates/tools/unix-timestamp.html.j2).
import { UNITS, isoLocal, parseTime, relativeTime } from "../time.mjs";
import { bindCopyAndClear } from "../common.mjs";

const input = document.getElementById("ts-in");
const unitSelect = document.getElementById("ts-unit");
const picker = document.getElementById("ts-pick");
const error = document.getElementById("ts-error");
const note = document.getElementById("ts-note");
const out = (id) => document.getElementById(`out-${id}`);
const OUTPUTS = ["s", "ms", "iso", "local-iso", "local", "http", "rel"];

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
document.getElementById("tz-name").textContent = zone;
const readable = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

// The time being shown, for the relative time to keep up with the clock.
let shownMs = null;

// Up to 3 decimals, without trailing zeros: 1700000000.5.
function decimal(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

function convert() {
  error.textContent = "";
  note.textContent = "";
  shownMs = null;
  let parsed;
  try {
    parsed = parseTime(input.value, unitSelect.value);
  } catch (e) {
    error.textContent = e.message;
  }
  if (!parsed) {
    OUTPUTS.forEach((id) => (out(id).value = ""));
    return;
  }

  const { ms } = parsed;
  if (parsed.kind === "timestamp") {
    note.textContent = parsed.guessed ? `Read as ${UNITS[parsed.unit].name}.` : "";
  } else {
    note.textContent = parsed.note;
  }
  const date = new Date(ms);
  out("s").value = decimal(ms / 1000);
  out("ms").value = decimal(ms);
  out("iso").value = date.toISOString();
  out("local-iso").value = isoLocal(date);
  out("local").value = readable.format(date);
  out("http").value = date.toUTCString();
  shownMs = ms;
  tick();
}

// Once a second: the current time, and how long ago the shown one was.
function tick() {
  const now = Date.now();
  document.getElementById("now-s").value = String(Math.floor(now / 1000));
  document.getElementById("now-ms").value = String(now);
  out("rel").value = shownMs === null ? "" : relativeTime(shownMs, now);
}

input.addEventListener("input", convert);
unitSelect.addEventListener("change", convert);

// The picker gives a local date and time without a zone, which parseTime
// reads as local time.
picker.addEventListener("change", () => {
  input.value = picker.value;
  convert();
});

document.getElementById("ts-now").addEventListener("click", () => {
  input.value = String(Math.floor(Date.now() / 1000));
  unitSelect.value = "auto";
  convert();
});

document.getElementById("ts-clear").addEventListener("click", () => {
  input.value = "";
  picker.value = "";
  convert();
  input.focus();
});

bindCopyAndClear();
tick();
setInterval(tick, 1000);
input.focus();
