// Decompression limits (js/crypto.mjs inflateCapped / decryptPart): the
// server only checks a paste's encrypted size, so a megabyte of deflated
// zeros must be refused by the viewer rather than inflated to a gigabyte.
import { deflate } from "pako";
import * as C from "../../js/crypto.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };
const tooLarge = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof C.TooLargeError; } };
const MIB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

// --- inflateCapped on its own ---
const bomb = deflate(new Uint8Array(4 * MIB));
ok("4 MiB of zeros deflate to a few KiB", bomb.length < 8 * 1024, bomb.length);
ok("the bomb is refused at a 1 MiB cap", await tooLarge(() => C.inflateCapped(bomb, MIB)));
ok("it's allowed room for exactly its size", C.inflateCapped(bomb, 4 * MIB).length === 4 * MIB);
ok("one byte less is refused", await tooLarge(() => C.inflateCapped(bomb, 4 * MIB - 1)));
const text = enc.encode("fn main() {\n    println!(\"hi\");\n}\n".repeat(2000));
ok("a normal paste passes", dec.decode(C.inflateCapped(deflate(text), MIB)) === dec.decode(text));
ok("empty input round-trips", C.inflateCapped(deflate(new Uint8Array(0)), MIB).length === 0);
let damaged = false;
try { C.inflateCapped(new Uint8Array([1, 2, 3, 4, 5]), MIB); } catch (e) { damaged = !(e instanceof C.TooLargeError); }
ok("a damaged stream is an ordinary error, not too-large", damaged);

// --- through decryptPart, v4 ---
const iv = crypto.getRandomValues(new Uint8Array(12));
const secret = C.generateLinkSecret();
const key = await C.deriveV3Key(secret, iv);
const viewer = { key, iv, version: 4 };
const bombPart = await C.encryptPart(key, iv, "text", new Uint8Array(4 * MIB));
ok("v4: the stored bomb is small", bombPart.length < 16 * 1024, bombPart.length);
ok("v4: the bomb is refused at the site's limit", await tooLarge(() => C.decryptPart(viewer, "text", bombPart.buffer, { maxBytes: MIB })));
const textPart = await C.encryptPart(key, iv, "text", text);
ok("v4: a normal paste decrypts", dec.decode(await C.decryptPart(viewer, "text", textPart.buffer, { maxBytes: MIB })) === dec.decode(text));
const titleBomb = await C.encryptPart(key, iv, "title", new Uint8Array(200 * 1024));
ok("v4: a title bomb is refused by the default small cap", await tooLarge(() => C.decryptPart(viewer, "title", titleBomb.buffer)));
const title = await C.encryptPart(key, iv, "title", C.encodeDetails("My title", "rust"));
ok("v4: a real title passes the small cap", C.decodeDetails(await C.decryptPart(viewer, "title", title.buffer)).title === "My title");

// --- v3: deflated, with the raw-bytes fallback for older pastes ---
const v3 = { key, iv, version: 3 };
const v3Bomb = await C.encryptBytes(new Uint8Array(4 * MIB), key, iv);
ok("v3: the bomb is refused, not handed back as raw bytes", await tooLarge(() => C.decryptPart(v3, "text", v3Bomb.buffer, { maxBytes: MIB })));
ok("v3: a normal paste decrypts", dec.decode(await C.decryptPart(v3, "text", (await C.encryptText("v3 text", key, iv)).buffer, { maxBytes: MIB })) === "v3 text");
// A paste from before compression: not a zlib stream, so it's taken as is.
const raw = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode("plain old text")));
ok("v3: an uncompressed legacy paste still opens", dec.decode(await C.decryptPart(v3, "text", raw.buffer, { maxBytes: MIB })) === "plain old text");
