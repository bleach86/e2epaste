// The creator's delete link (delete.html.j2): /delete/<id>#<token>. The token
// stays in the hash, which browsers don't send, until the creator confirms.
// Without one, the token this browser kept when creating the paste is used.

import { deleteTokenFor, forgetDeleteToken } from "../delete_tokens.mjs";
import { readPageData } from "../ui.mjs";

const { paste_id: pasteId } = readPageData();
const token = window.location.hash.substring(1) || deleteTokenFor(pasteId) || "";

const button = document.getElementById("delete-btn");
const errorEl = document.getElementById("delete-error");

const MESSAGES = {
  403: "This delete link isn't valid. Check that you have all of it, including everything after the #.",
  404: "This paste doesn't exist any more. It may have expired, reached its view limit or already been deleted.",
  429: "Too many failed attempts from your network. Please try again later.",
};

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function setBusy(busy) {
  button.disabled = busy;
  button.querySelector(".delete-idle").classList.toggle("d-none", busy);
  button.querySelector(".delete-busy").classList.toggle("d-none", !busy);
  button.querySelector(".delete-busy").classList.toggle("d-inline-flex", busy);
}

if (token === "") {
  button.disabled = true;
  showError(MESSAGES[403]);
}

button.addEventListener("click", async () => {
  errorEl.hidden = true;
  setBusy(true);
  try {
    const response = await fetch(`/api/delete/${pasteId}`, {
      method: "POST",
      headers: { "X-Delete-Token": token },
    });
    if (response.ok || response.status === 404) {
      forgetDeleteToken(pasteId);
    }
    if (response.ok) {
      document.getElementById("delete-ask").hidden = true;
      document.getElementById("delete-done").hidden = false;
      return;
    }
    showError(MESSAGES[response.status] ?? "The paste couldn't be deleted. Please try again.");
  } catch (e) {
    console.error(e);
    showError("The paste couldn't be deleted. Please try again.");
  } finally {
    setBusy(false);
  }
});
