// Delete tokens for the pastes made in this browser, so their creator gets a
// Delete button on the paste page without keeping the delete link. Stored in
// localStorage by paste ID until the paste expires. Only the token is kept,
// never the link's key: what's stored can delete a paste but not read it.
//
// Storage can be missing or refuse writes (private windows, blocked site
// data); then there's simply no button, and the delete link still works.

const STORAGE_KEY = "e2epaste.deleteTokens";

// { id: { token, expires } }, without the expired ones.
function load() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(saved).filter(([, entry]) => typeof entry?.token === "string" && entry.expires > now),
  );
}

function save(tokens) {
  try {
    if (Object.keys(tokens).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    }
  } catch {
    // Not stored; the delete link is still in the link dialog.
  }
}

// `lifetime` in seconds, as sent to the server.
export function rememberDeleteToken(id, token, lifetime) {
  save({ ...load(), [id]: { token, expires: Date.now() + lifetime * 1000 } });
}

export function deleteTokenFor(id) {
  return load()[id]?.token ?? null;
}

export function forgetDeleteToken(id) {
  const tokens = load();
  delete tokens[id];
  save(tokens);
}
