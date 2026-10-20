const pass_el = document.getElementById("password");
const gen_btn = document.getElementById("password-gen");
const pass_strength_el = document.getElementById("strength-meter");
const pass_input_el = document.getElementById("password-strength");
const use_special_chars = document.getElementById("use-special");
const pass_length = document.getElementById("password-len");
const pass_len_display = document.getElementById("pass-len-display");

if (pass_length) {
  pass_length.value = 14;
  pass_len_display.textContent = 14;

  pass_length.addEventListener("input", function () {
    pass_len_display.textContent = pass_length.value;
    const pass = generatePassword(pass_length.value, use_special_chars.checked);
    if (pass_el) pass_el.value = pass;
  });
}

if (gen_btn) {
  gen_btn.addEventListener("click", async () => {
    const pass = generatePassword(pass_length.value, use_special_chars.checked);
    if (pass_el) pass_el.value = pass;
  });
}

if (use_special_chars) {
  use_special_chars.addEventListener("change", async () => {
    const pass = generatePassword(pass_length.value, use_special_chars.checked);
    if (pass_el) pass_el.value = pass;
  });
}

if (pass_input_el) {
  pass_input_el.addEventListener("input", (e) => {
    const pass = e.target.value;
    get_password_strength(pass);
  });
}

async function page_load() {
  if (pass_el && pass_length && use_special_chars) {
    while (window.generatePassword === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const pass = generatePassword(pass_length.value, use_special_chars.checked);
    pass_el.value = pass;
  }
}

function get_password_strength(pass) {
  let strength = get_pass_strength(pass);

  if (strength === "Weak") {
    pass_strength_el.classList.forEach((c) => {
      if (c.startsWith("btn-")) {
        pass_strength_el.classList.remove(c);
      }
    });
    pass_strength_el.classList.add("btn-danger");
  } else if (strength === "Medium") {
    pass_strength_el.classList.forEach((c) => {
      if (c.startsWith("btn-")) {
        pass_strength_el.classList.remove(c);
      }
    });
    pass_strength_el.classList.add("btn-warning");
  } else if (strength === "Strong") {
    pass_strength_el.classList.forEach((c) => {
      if (c.startsWith("btn-")) {
        pass_strength_el.classList.remove(c);
      }
    });
    pass_strength_el.classList.add("btn-primary");
  } else if (strength === "Very Strong") {
    pass_strength_el.classList.forEach((c) => {
      if (c.startsWith("btn-")) {
        pass_strength_el.classList.remove(c);
      }
    });
    pass_strength_el.classList.add("btn-success");
  }

  pass_strength_el.innerText = strength;
}

function get_pass_strength(pass) {
  let score = 0;

  if (pass.length >= 8) score++;
  if (pass.length >= 12) score++;
  if (/[A-Z]/.test(pass)) score++;
  if (/[a-z]/.test(pass)) score++;
  if (/[0-9]/.test(pass)) score++;
  if (/[^A-Za-z0-9]/.test(pass)) score++;

  if (score <= 2) return "Weak";
  else if (score <= 4) return "Medium";
  else if (score === 5) return "Strong";
  else return "Very Strong";
}

function randomInt(length) {
  const array = new Uint32Array(1);
  window.crypto.getRandomValues(array);
  return array[0] % length;
}

function generatePassword(length, useSpecialChars) {
  const lowerChars = "abcdefghijklmnopqrstuvwxyz";
  const upperChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numberChars = "0123456789";
  const specialChars = "!@#$%^&*()_+[]{}|;:,.<>?";

  let allChars = lowerChars + upperChars + numberChars;
  if (useSpecialChars) {
    allChars += specialChars;
  }

  let password = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = randomInt(allChars.length);
    password += allChars[randomIndex];
  }

  return password;
}

function showCopiedPopover(button) {
  const popover = new bootstrap.Popover(button, {
    content: "Successfully Copied to clipboard!",
    placement: "top",
    trigger: "manual",
    customClass: "bg-success",
  });
  popover.show();
  setTimeout(() => popover.hide(), 1500);
}

if (pass_input_el) {
  pass_input_el.value = "";
}

const copy_password_btn = document.getElementById("copy-password");
if (copy_password_btn) {
  copy_password_btn.addEventListener("click", () => {
    navigator.clipboard.writeText(pass_el.value);
    showCopiedPopover(copy_password_btn);
  });
}

const clear_strength_btn = document.getElementById("clear-password-strength");
if (clear_strength_btn) {
  clear_strength_btn.addEventListener("click", () => {
    pass_input_el.value = "";
    get_password_strength("");
  });
}

page_load();
