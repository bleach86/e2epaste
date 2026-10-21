// Paste formats (js/crypto.mjs): v3 pastes round-trip, and pastes in the
// older v1 and v2 formats, made with the code that created them, still open.
import * as NEW from "../../js/crypto.mjs";
import * as OLD from "../fixtures/crypto_v2.mjs";

const s = crypto.subtle;
let fails = 0;
const ok = (l, c) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) fails++; };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
const file = crypto.getRandomValues(new Uint8Array(3000));

async function viewAll(paste, hash, hasPw, pw, fileCipher) {
  const sec = await NEW.getPasteSecrets(paste, hash, hasPw, pw);
  const text = await NEW.decryptText(NEW.base64ToArrayBuffer(paste.content), sec.key, sec.iv);
  const name = paste.file_name && new TextDecoder().decode(await NEW.decryptPart(sec, "file-name", NEW.base64ToArrayBuffer(paste.file_name)));
  const f = fileCipher && (await NEW.decryptPart(sec, "file", fileCipher.buffer));
  return { text, name, fileOk: f ? Buffer.compare(Buffer.from(f), Buffer.from(file)) === 0 : null };
}

// --- v3, created exactly like js/pages/create.mjs ---
async function createV3(password) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = NEW.generateLinkSecret();
  const key = await NEW.deriveV3Key(secret, iv, password || null);
  return {
    secret,
    paste: { version: 3, key_fragment: "", iv: Array.from(iv),
      content: NEW.arrayBufferToBase64(await NEW.encryptText("v3 text ✓", key, iv)),
      file_name: NEW.arrayBufferToBase64(await NEW.encryptText("a.bin", key, await NEW.deriveIv(iv, "file-name"))) },
    fileCipher: await NEW.encryptBytes(file, key, await NEW.deriveIv(iv, "file")),
  };
}
const secrets = new Set(Array.from({ length: 1000 }, () => NEW.generateLinkSecret()));
ok("link secret is 22 base64url chars and random", [...secrets].every((x) => /^[A-Za-z0-9_-]{22}$/.test(x)) && secrets.size === 1000);

for (const pw of ["", "hunter2"]) {
  const label = pw ? "v3 password" : "v3 no password";
  const v = await createV3(pw);
  const r = await viewAll(v.paste, v.secret, !!pw, pw, v.fileCipher);
  ok(`${label}: text, file name, file`, r.text === "v3 text ✓" && r.name === "a.bin" && r.fileOk);
  const flipped = (v.secret[0] === "A" ? "B" : "A") + v.secret.slice(1);
  ok(`${label}: one wrong link char rejected`, await rejects(() => viewAll(v.paste, flipped, !!pw, pw)));
  ok(`${label}: truncated link rejected`, await rejects(() => viewAll(v.paste, v.secret.slice(0, 16), !!pw, pw)));
  if (pw) {
    ok(`${label}: wrong password rejected`, await rejects(() => viewAll(v.paste, v.secret, true, "wrong")));
    ok(`${label}: no password rejected`, await rejects(() => viewAll(v.paste, v.secret, true, "")));
  }
}

// --- v2, created by the previous code ---
async function createV2(password) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pasteKey = await OLD.generateKey();
  const key = password ? await OLD.deriveKeyWithPassword(pasteKey, password, iv) : pasteKey;
  const frag = OLD.fragmentKey(await OLD.exportCryptoKey(pasteKey));
  return {
    hash: frag.hashFragment,
    paste: { version: 2, key_fragment: frag.serverKey, iv: Array.from(iv),
      content: OLD.arrayBufferToBase64(await OLD.encryptText("v2 text ✓", key, iv)),
      file_name: OLD.arrayBufferToBase64(await OLD.encryptText("b.bin", key, await OLD.deriveIv(iv, "file-name"))) },
    fileCipher: await OLD.encryptBytes(file, key, await OLD.deriveIv(iv, "file")),
  };
}
for (const pw of ["", "hunter2"]) {
  const label = pw ? "v2 password" : "v2 no password";
  const v = await createV2(pw);
  const r = await viewAll(v.paste, v.hash, !!pw, pw, v.fileCipher);
  ok(`${label} (old code): text, file name, file`, r.text === "v2 text ✓" && r.name === "b.bin" && r.fileOk);
  if (pw) ok(`${label}: wrong password rejected`, await rejects(() => viewAll(v.paste, v.hash, true, "wrong")));
}

// --- v1 (uncompressed, IV = SHA-256(password||salt), attachments on base IV) ---
for (const pw of ["", "oldpw"]) {
  const salt = crypto.getRandomValues(new Uint8Array(12));
  const iv = new Uint8Array(await s.digest("SHA-256", new Uint8Array([...new TextEncoder().encode(pw), ...salt]))).slice(0, 12);
  const key = await OLD.generateKey();
  const frag = OLD.fragmentKey(await OLD.exportCryptoKey(key));
  const enc = async (b) => new Uint8Array(await s.encrypt({ name: "AES-GCM", iv }, key, b));
  const paste = { version: 1, key_fragment: frag.serverKey, iv: Array.from(salt),
    content: OLD.arrayBufferToBase64(await enc(new TextEncoder().encode("v1 text ✓"))),
    file_name: OLD.arrayBufferToBase64(await enc(new TextEncoder().encode("c.bin"))) };
  const r = await viewAll(paste, frag.hashFragment, !!pw, pw, await enc(file));
  ok(`v1 ${pw ? "password" : "no password"}: text, file name, file`, r.text === "v1 text ✓" && r.name === "c.bin" && r.fileOk);
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exitCode = fails ? 1 : 0;
