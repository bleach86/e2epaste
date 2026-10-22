// UUID and random token generator (templates/tools/uuid-generator.html.j2).
import { formatUuid, inspectUuid, randomToken, tokenBits, uuids } from "../random.mjs";
import { bindCopyAndClear } from "../common.mjs";

const $ = (id) => document.getElementById(id);

// A whole number from a number field, kept within its min and max.
function count(input) {
  const n = Math.floor(Number(input.value));
  return Math.min(Number(input.max), Math.max(Number(input.min), Number.isFinite(n) ? n : Number(input.min)));
}

function makeUuids() {
  const version = Number(document.querySelector('input[name="uuid-version"]:checked').value);
  const options = { upper: $("uuid-upper").checked, hyphens: $("uuid-hyphens").checked, braces: $("uuid-braces").checked };
  $("uuid-out").value = uuids(version, count($("uuid-count")))
    .map((u) => formatUuid(u, options))
    .join("\n");
}

function makeTokens() {
  const format = $("token-format").value;
  const length = count($("token-length"));
  $("token-unit").textContent = format === "alphanumeric" ? "characters" : "bytes";
  $("token-out").value = Array.from({ length: count($("token-count")) }, () => randomToken(format, length)).join("\n");
  const bits = tokenBits(format, length);
  $("token-strength").textContent = `${bits.toLocaleString()} bits of randomness each${bits < 128 ? ": short for a secret, 128 bits or more is safer" : ""}.`;
}

const readable = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" });

function inspect() {
  const out = $("inspect-out");
  out.replaceChildren();
  $("inspect-error").textContent = "";
  let info;
  try {
    info = inspectUuid($("inspect-in").value);
  } catch (e) {
    $("inspect-error").textContent = e.message;
  }
  if (!info) return;
  const rows = [
    ["UUID", info.uuid],
    ["Version", info.version === null ? "none" : String(info.version)],
    ["Variant", info.variant],
  ];
  if (info.time !== undefined) rows.push(["Made", readable.format(new Date(info.time))]);
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    out.append(dt, dd);
  }
}

for (const id of ["uuid-v4", "uuid-v7", "uuid-count", "uuid-upper", "uuid-hyphens", "uuid-braces"]) {
  $(id).addEventListener("change", makeUuids);
}
for (const id of ["token-format", "token-length", "token-count"]) {
  $(id).addEventListener("change", makeTokens);
}
$("uuid-again").addEventListener("click", makeUuids);
$("token-again").addEventListener("click", makeTokens);
$("inspect-in").addEventListener("input", inspect);

bindCopyAndClear();
makeUuids();
makeTokens();
