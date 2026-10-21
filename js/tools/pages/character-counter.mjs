import { textStats } from "../text.mjs";
import { bindCopyAndClear } from "../common.mjs";

const input = document.getElementById("counter-in");
const fields = {
  length: "stat-length",
  noSpaces: "stat-nospace",
  bytes: "stat-bytes",
  words: "stat-words",
  lines: "stat-lines",
  uniqueWords: "stat-uwords",
  uniqueChars: "stat-uchars",
};

function update() {
  const stats = textStats(input.value);
  for (const [key, id] of Object.entries(fields)) {
    document.getElementById(id).textContent = stats[key].toLocaleString();
  }
}

input.value = "";
input.addEventListener("input", update);
update();
bindCopyAndClear();
