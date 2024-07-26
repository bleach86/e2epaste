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

window.get_password_strength = get_password_strength;

page_load();
