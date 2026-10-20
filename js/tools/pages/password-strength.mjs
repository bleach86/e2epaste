import { bindCopyAndClear } from "../common.mjs";

const LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
const COLORS = ["bg-danger", "bg-danger", "bg-warning", "bg-info", "bg-success"];
const CRACK_TIMES = {
  "crack-online-throttled": "onlineThrottlingXPerHour",
  "crack-online": "onlineNoThrottlingXPerSecond",
  "crack-offline-slow": "offlineSlowHashingXPerSecond",
  "crack-offline-fast": "offlineFastHashingXPerSecond",
};

const input = document.getElementById("strength-in");
const loading = document.getElementById("strength-loading");
const result = document.getElementById("strength-result");
const bar = document.getElementById("strength-bar");
const warning = document.getElementById("strength-warning");
const suggestions = document.getElementById("strength-suggestions");

let zxcvbn = null;

// The dictionaries are large, so load them in a separate chunk after the
// page is up.
async function loadChecker() {
  const [{ ZxcvbnFactory }, common, en] = await Promise.all([
    import(/* webpackChunkName: "zxcvbn" */ "@zxcvbn-ts/core"),
    import(/* webpackChunkName: "zxcvbn" */ "@zxcvbn-ts/language-common"),
    import(/* webpackChunkName: "zxcvbn" */ "@zxcvbn-ts/language-en"),
  ]);
  zxcvbn = new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
    translations: en.translations,
  });
}

function update() {
  if (!zxcvbn) {
    return;
  }
  const password = input.value;
  result.hidden = password === "";
  if (password === "") {
    return;
  }

  const r = zxcvbn.check(password);
  document.getElementById("strength-label").textContent = LABELS[r.score];
  document.getElementById("strength-score").textContent = `Score ${r.score} of 4`;
  bar.className = `progress-bar ${COLORS[r.score]}`;
  bar.style.width = `${((r.score + 1) / 5) * 100}%`;
  document.getElementById("strength-bar-wrap").setAttribute("aria-valuenow", r.score);

  warning.hidden = !r.feedback.warning;
  warning.textContent = r.feedback.warning ?? "";
  suggestions.replaceChildren(
    ...r.feedback.suggestions.map((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      return li;
    }),
  );

  for (const [id, key] of Object.entries(CRACK_TIMES)) {
    document.getElementById(id).textContent = r.crackTimes[key].display;
  }
}

function toggleVisibility() {
  const button = document.getElementById("strength-show");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.setAttribute("aria-pressed", String(show));
  button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  button.querySelector(".pw-show").classList.toggle("d-none", show);
  button.querySelector(".pw-hide").classList.toggle("d-none", !show);
  button.querySelector(".pw-hide").classList.toggle("d-inline-flex", show);
}

input.value = "";
input.addEventListener("input", update);
document.getElementById("strength-show").addEventListener("click", toggleVisibility);
bindCopyAndClear();

loadChecker()
  .then(() => {
    loading.hidden = true;
    update();
  })
  .catch((e) => {
    loading.textContent = "The checker failed to load. Please reload the page.";
    console.error(e);
  });
