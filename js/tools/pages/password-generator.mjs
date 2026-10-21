import { bindCopyAndClear } from "../common.mjs";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()_+[]{}|;:,.<>?";

const output = document.getElementById("password");
const lengthInput = document.getElementById("password-len");
const lengthDisplay = document.getElementById("pass-len-display");
const useSymbols = document.getElementById("use-special");
const entropy = document.getElementById("password-entropy");

// Uniform random index in [0, n). Rejects values from the incomplete last
// block of the 32-bit range so no index is more likely than another.
function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

function generate() {
  const charset = LOWER + UPPER + DIGITS + (useSymbols.checked ? SYMBOLS : "");
  const length = Number(lengthInput.value);

  let password = "";
  for (let i = 0; i < length; i++) {
    password += charset[randomIndex(charset.length)];
  }

  output.value = password;
  lengthDisplay.textContent = length;
  const bits = Math.round(length * Math.log2(charset.length));
  entropy.textContent = `About ${bits} bits of entropy (${length} characters from a set of ${charset.length}).`;
}

lengthInput.addEventListener("input", generate);
useSymbols.addEventListener("change", generate);
document.getElementById("password-gen").addEventListener("click", generate);
generate();
bindCopyAndClear();
