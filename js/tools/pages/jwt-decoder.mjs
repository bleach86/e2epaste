// JWT decoder (templates/tools/jwt-decoder.html.j2).
import { decodeJwt, keyKind, tokenTimes, verifyJwt } from "../jwt.mjs";
import { relativeTime } from "../time.mjs";
import { bindCopyAndClear } from "../common.mjs";

const input = document.getElementById("jwt-in");
const error = document.getElementById("jwt-error");
const summary = document.getElementById("jwt-summary");
const decoded = document.getElementById("jwt-decoded");
const claims = document.getElementById("jwt-claims");
const secret = document.getElementById("jwt-secret");
const secretBase64 = document.getElementById("jwt-secret-b64");
const publicKey = document.getElementById("jwt-public");
const keyHelp = document.getElementById("jwt-key-help");
const result = document.getElementById("jwt-verify-result");

const CLAIMS = {
  iss: "Issuer",
  sub: "Subject",
  aud: "Audience",
  exp: "Expires",
  nbf: "Not valid before",
  iat: "Issued",
  jti: "Token ID",
};
const TIME_CLAIMS = new Set(["exp", "nbf", "iat"]);
const readable = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" });

let token = null;
// Each check gets a number, so a slow one can't overwrite a newer result.
let check = 0;

function chip(text, tone = "") {
  const span = document.createElement("span");
  span.className = `chip${tone ? ` chip-${tone}` : ""}`;
  span.textContent = text;
  summary.append(span);
}

function showClaims(payload) {
  claims.replaceChildren();
  for (const [claim, label] of Object.entries(CLAIMS)) {
    if (!(claim in payload)) continue;
    const value = payload[claim];
    const dt = document.createElement("dt");
    dt.textContent = `${label} (${claim})`;
    const dd = document.createElement("dd");
    if (TIME_CLAIMS.has(claim) && typeof value === "number") {
      // Dates only go to about the year 275760; a bigger number (or NaN
      // from a huge one) would make the formatter throw.
      const ms = value * 1000;
      const date = new Date(ms);
      dd.textContent = Number.isFinite(date.getTime())
        ? `${readable.format(date)} (${relativeTime(ms, Date.now())})`
        : `${value} (invalid: not a date)`;
    } else {
      dd.textContent = typeof value === "string" ? value : JSON.stringify(value);
    }
    claims.append(dt, dd);
  }
}

function decode() {
  error.textContent = "";
  summary.replaceChildren();
  token = null;
  try {
    token = decodeJwt(input.value);
  } catch (e) {
    error.textContent = e.message;
  }
  decoded.hidden = !token;
  if (!token) {
    return;
  }

  // Each box is as tall as its JSON.
  for (const [id, value] of [["jwt-header", token.header], ["jwt-payload", token.payload]]) {
    const box = document.getElementById(id);
    box.value = JSON.stringify(value, null, 2);
    box.rows = Math.min(30, box.value.split("\n").length);
  }
  showClaims(token.payload);

  const alg = String(token.header.alg ?? "missing");
  chip(`Algorithm: ${alg}`, alg === "none" ? "warn" : "");
  const { status, expires, notBefore } = tokenTimes(token.payload, Date.now());
  // Same guard as the claims list: "1e400" parses as Infinity.
  const when = (ms) => (Number.isFinite(ms) ? relativeTime(ms, Date.now()) : "at an invalid time");
  if (status === "expired") chip(`Expired ${when(expires)}`, "warn");
  if (status === "valid") chip(`Expires ${when(expires)}`, "ok");
  if (status === "not-yet") chip(`Not valid until ${when(notBefore)}`, "warn");
  if (status === "no-expiry") chip("Never expires");

  const kind = keyKind(token.header.alg);
  document.getElementById("jwt-secret-box").hidden = kind !== "secret";
  document.getElementById("jwt-public-box").hidden = kind !== "public";
  keyHelp.textContent =
    kind === "secret"
      ? `${alg} is signed with a shared secret. Enter it to check the signature.`
      : kind === "public"
        ? `${alg} is signed with a private key. Paste the matching public key (PEM, JWK or a JWKS) to check the signature.`
        : "";
  verify();
}

async function verify() {
  const mine = ++check;
  result.className = "jwt-verify mt-3 mb-0";
  result.textContent = "";
  if (!token) return;
  const kind = keyKind(token.header.alg);
  const key = kind === "secret" ? secret.value : publicKey.value;
  if (kind && key.trim() === "") return;

  let outcome;
  try {
    outcome = (await verifyJwt(token, key, { secretIsBase64: secretBase64.checked })) ? "ok" : "bad";
  } catch (e) {
    outcome = e.message;
  }
  if (mine !== check) return;
  if (outcome === "ok") {
    result.classList.add("text-accent");
    result.textContent = "✓ Signature verified: the token was signed with this key and hasn't been changed.";
  } else if (outcome === "bad") {
    result.classList.add("text-warn");
    result.textContent = "✗ The signature doesn't match: it's the wrong key, or the token was changed.";
  } else {
    result.classList.add("text-warn");
    result.textContent = outcome;
  }
}

input.addEventListener("input", decode);
for (const field of [secret, publicKey]) field.addEventListener("input", verify);
secretBase64.addEventListener("change", verify);
document.getElementById("jwt-clear").addEventListener("click", () => {
  input.value = "";
  secret.value = "";
  publicKey.value = "";
  decode();
  input.focus();
});

bindCopyAndClear();
decode();
input.focus();
