const stringLength = document.getElementById("string-length");
const stringBytes = document.getElementById("string-bytes");
const stringWords = document.getElementById("string-words");
const stringUwords = document.getElementById("string-uwords");
const stringUchars = document.getElementById("string-uchars");
const stringLines = document.getElementById("string-lines");
const byteCounterInput = document.getElementById("byte-counter-input");

const base64_encode_input = document.getElementById("base64-encode-in");
const base64_encode_output = document.getElementById("base64-encode-out");
const base64_encode_btn = document.getElementById("encode-base64");

const base64_decode_input = document.getElementById("base64-decode-in");
const base64_decode_output = document.getElementById("base64-decode-out");
const base64_decode_btn = document.getElementById("decode-base64");

const hex_encode_input = document.getElementById("hex-encode-in");
const hex_encode_output = document.getElementById("hex-encode-out");
const hex_encode_btn = document.getElementById("encode-hex");

const hex_decode_input = document.getElementById("hex-decode-in");
const hex_decode_output = document.getElementById("hex-decode-out");
const hex_decode_btn = document.getElementById("decode-hex");

const binary_encode_input = document.getElementById("binary-encode-in");
const binary_encode_output = document.getElementById("binary-encode-out");
const binary_encode_btn = document.getElementById("encode-binary");

const binary_decode_input = document.getElementById("binary-decode-in");
const binary_decode_output = document.getElementById("binary-decode-out");
const binary_decode_btn = document.getElementById("decode-binary");

const reverse_input = document.getElementById("reverse-in");
const reverse_output = document.getElementById("reverse-out");
const reverse_btn = document.getElementById("reverse-button");

const random_input = document.getElementById("random-in");
const random_output = document.getElementById("random-out");
const random_btn = document.getElementById("random-button");

const substr_input = document.getElementById("substring-input");
const search_str_input = document.getElementById("search-string-input");
const substr_output_count = document.getElementById("str-in-str-count");
const count_button = document.getElementById("count-button");
const use_case = document.getElementById("use-case");

const graphemeSegmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

async function page_load() {
  while (window.get_string === undefined) {
    await new Promise((r) => setTimeout(r, 100));
  }

  byteCounterInput.value = "";
  base64_encode_input.value = "";
  base64_decode_input.value = "";
  base64_encode_output.value = "";
  base64_decode_output.value = "";

  hex_encode_input.value = "";
  hex_decode_input.value = "";
  hex_encode_output.value = "";
  hex_decode_output.value = "";

  binary_encode_input.value = "";
  binary_decode_input.value = "";
  binary_encode_output.value = "";
  binary_decode_output.value = "";

  reverse_input.value = "";
  reverse_output.value = "";

  random_input.value = "";
  random_output.value = "";

  substr_input.value = "";
  search_str_input.value = "";

  count_button.addEventListener("click", (e) => {
    let sub_str = substr_input.value;
    let search_str = search_str_input.innerText;

    let res = substr_in_str(search_str, sub_str, use_case.checked);

    search_str_input.innerHTML = "";
    search_str_input.innerHTML = res.modified_str;

    search_str_input.querySelectorAll("span").forEach((span) => {
      span.addEventListener("input", (e) => {
        let input = e.target.value;
        if (input === "") {
          e.target.remove();
        }
      });
    });

    substr_output_count.innerText = res.count;
  });

  random_btn.addEventListener("click", (e) => {
    let input = random_input.value;
    let random = rand_uppercase(input);
    random_output.value = random;
  });

  reverse_btn.addEventListener("click", (e) => {
    let input = reverse_input.value;
    let reversed = rev_str(input);
    reverse_output.value = reversed;
  });

  binary_encode_btn.addEventListener("click", (e) => {
    let input = binary_encode_input.value;
    let encoded = str_to_bin(input);
    binary_encode_output.value = encoded;
  });

  binary_decode_btn.addEventListener("click", (e) => {
    let input = binary_decode_input.value;
    let decoded = bin_to_str(input);
    binary_decode_output.value = decoded;
  });

  hex_decode_btn.addEventListener("click", (e) => {
    let input = hex_decode_input.value;
    let decoded = hex_decode(input);
    hex_decode_output.value = decoded;
  });

  hex_encode_btn.addEventListener("click", (e) => {
    let input = hex_encode_input.value;
    console.log("Encoding hex for input:", input);
    let encoded = hex_encode(input);
    hex_encode_output.value = encoded;
  });

  base64_encode_btn.addEventListener("click", (e) => {
    let input = base64_encode_input.value;
    let encoded = base64_encode(input);
    base64_encode_output.value = encoded;
  });

  base64_decode_btn.addEventListener("click", (e) => {
    let input = base64_decode_input.value;
    let decoded = base64_decode(input);
    base64_decode_output.value = decoded;
  });

  byteCounterInput.addEventListener("input", (e) => {
    let input = e.target.value;
    set_string_info(input);
  });
}

function set_string_info(input) {
  let stringInfo = get_string(input);
  stringLength.innerText = stringInfo.length;
  stringBytes.innerText = stringInfo.bytes;
  stringWords.innerText = stringInfo.words;
  stringLines.innerText = stringInfo.lines;
  stringUwords.innerText = stringInfo.unique_words;
  stringUchars.innerText = stringInfo.unique_chars;
}

// Split into user-perceived characters so emoji (incl. ZWJ sequences,
// skin tones, flags) count as one. Falls back to code points.
function graphemes(str) {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

function get_string(input) {
  let chars = graphemes(input);
  let length = chars.length;

  if (length === 0) {
    return {
      length: 0,
      bytes: 0,
      words: 0,
      lines: 0,
      unique_words: 0,
      unique_chars: 0,
    };
  }

  let bytes = new Blob([input]).size;
  let words = input.trim().split(/\s+/).filter(Boolean).length;
  let lines = input.split(/\r\n|\r|\n/).length;
  let unique_words = new Set(
    input.trim().toLowerCase().split(/\s+/).filter(Boolean),
  ).size;
  let unique_chars = new Set(chars).size;

  return {
    length,
    bytes,
    words,
    lines,
    unique_words,
    unique_chars,
  };
}

function bin_to_str(bin) {
  let bytes = bin.split(" ");
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(parseInt(bytes[i], 2));
  }
  return str;
}

function str_to_bin(str) {
  let bin = "";
  for (let i = 0; i < str.length; i++) {
    bin += str.charCodeAt(i).toString(2) + " ";
  }
  return bin.trim();
}

function rev_str(str) {
  return graphemes(str).reverse().join("");
}

function randBoolean() {
  const array = new Uint32Array(1);
  window.crypto.getRandomValues(array);
  return array[0] % 2 === 0;
}

function rand_uppercase(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    let char = str.charAt(i);
    result += randBoolean() ? char.toUpperCase() : char.toLowerCase();
  }
  return result;
}

function substr_in_str(str, sub_str, case_sensitive) {
  let count = 0;
  let modified_str = "";
  let search_str = case_sensitive ? str : str.toLowerCase();
  let search_sub_str = case_sensitive ? sub_str : sub_str.toLowerCase();

  let index = search_str.indexOf(search_sub_str);
  let lastIndex = 0;

  while (index !== -1) {
    count++;
    modified_str += str.substring(lastIndex, index);
    modified_str += `<span contenteditable="true" class="highlight">${str.substring(index, index + sub_str.length)}</span>`;
    lastIndex = index + sub_str.length;
    index = search_str.indexOf(search_sub_str, lastIndex);
  }

  modified_str += str.substring(lastIndex);

  return { count, modified_str };
}

function base64_encode(str) {
  return btoa(str);
}

function base64_decode(b64) {
  return atob(b64);
}

function hex_encode(str) {
  let hex = "";
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

function hex_decode(hex) {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
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

// data-copy="<id>": copy that field's value.
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById(button.dataset.copy).value);
    showCopiedPopover(button);
  });
});

// data-clear="<id> [<id>...]": empty those fields.
document.querySelectorAll("[data-clear]").forEach((button) => {
  button.addEventListener("click", () => {
    for (const id of button.dataset.clear.split(" ")) {
      document.getElementById(id).value = "";
    }
    if (button.dataset.clear === "byte-counter-input") {
      set_string_info("");
    }
  });
});

document.getElementById("clear-substring").addEventListener("click", () => {
  substr_input.value = "";
  search_str_input.innerHTML = "";
  substr_output_count.textContent = "0";
});

page_load();
