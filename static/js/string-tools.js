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
    let decoded = hex_to_str(input);
    hex_decode_output.value = decoded;
  });

  hex_encode_btn.addEventListener("click", (e) => {
    let input = hex_encode_input.value;
    let encoded = str_to_hex(input);
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

window.set_string_info = set_string_info;

page_load();
