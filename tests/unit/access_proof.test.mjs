// Access proofs (js/crypto.mjs): deterministic, separate from the key,
// bound to the password, and hashed the way the server expects.
import { createHash } from "node:crypto";
import * as C from "../../js/crypto.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };

const secret = C.generateLinkSecret();
const salt = crypto.getRandomValues(new Uint8Array(12));
const a = await C.deriveV3Secrets(secret, salt);
const b = await C.deriveV3Secrets(secret, salt);
ok("proof is 32 bytes of hex", /^[0-9a-f]{64}$/.test(a.accessProof));
ok("same link, same proof", a.accessProof === b.accessProof);

// The key from deriveV3Secrets is the key deriveV3Key always made, so pastes
// created before proofs existed still decrypt.
const iv = await C.deriveIv(salt, "title");
const ct = await C.encryptText("hello", await C.deriveV3Key(secret, salt), iv);
ok("key unchanged from deriveV3Key", (await C.decryptText(ct, a.key, iv)) === "hello");

const pw = await C.deriveV3Secrets(secret, salt, "hunter2");
const pw2 = await C.deriveV3Secrets(secret, salt, "hunter3");
ok("password changes the proof", pw.accessProof !== a.accessProof && pw.accessProof !== pw2.accessProof);
ok("other link, other proof", (await C.deriveV3Secrets(C.generateLinkSecret(), salt)).accessProof !== a.accessProof);
ok("other salt, other proof", (await C.deriveV3Secrets(secret, crypto.getRandomValues(new Uint8Array(12)))).accessProof !== a.accessProof);

// Server: SHA-256 of the proof's bytes (secrets::hash_secret).
const expected = createHash("sha256").update(Buffer.from(a.accessProof, "hex")).digest("hex");
ok("accessHash is SHA-256 of the proof bytes", (await C.accessHash(a.accessProof)) === expected);

// The proof reveals nothing usable as the key: it isn't the raw key bytes.
const raw = Buffer.from(await crypto.subtle.exportKey("raw", await crypto.subtle.importKey("raw", Buffer.from(a.accessProof, "hex"), "AES-GCM", true, ["decrypt"]))).toString("hex");
let decryptsWithProof = true;
try { await C.decryptText(ct, await crypto.subtle.importKey("raw", Buffer.from(raw, "hex"), "AES-GCM", false, ["decrypt"]), iv); } catch { decryptsWithProof = false; }
ok("the proof isn't the key", !decryptsWithProof);

let threw = false;
try { await C.deriveV3Secrets(secret.slice(0, -3), salt); } catch { threw = true; }
ok("a truncated link throws before anything is sent", threw);
