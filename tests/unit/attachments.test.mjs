// v4 attachments (js/crypto.mjs encryptFile / decryptFile): chunked
// encryption round trips at every edge, sizes match what the server checks
// (src/padding.rs), and changed, reordered, dropped or cut-off chunks are
// refused.
import * as C from "../../js/crypto.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

const MiB = C.FILE_CHUNK_BYTES;
const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function encrypt(bytes, k = key, salt = iv) {
  const chunks = [];
  await C.encryptFile(new Blob([bytes]), k, salt, async (index, last, chunk) => chunks.push({ index, last, chunk }));
  return chunks;
}

// A download that arrives in pieces of `pieceSize` bytes.
function streamOf(chunks, pieceSize = 100000) {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= all.length) return controller.close();
      controller.enqueue(all.slice(offset, offset + pieceSize));
      offset += pieceSize;
    },
  });
}

const same = async (blob, bytes) => {
  const back = new Uint8Array(await blob.arrayBuffer());
  return back.length === bytes.length && back.every((b, i) => b === bytes[i]);
};

for (const size of [0, 1, 4000, MiB - 8, MiB - 7, MiB, 3 * MiB + 5]) {
  const bytes = randomBytes(size);
  const chunks = await encrypt(bytes);
  const total = chunks.reduce((n, c) => n + c.chunk.length, 0);
  ok(`${size} bytes: stored size is the declared one`, total === C.encryptedFileLength(size), `${total} vs ${C.encryptedFileLength(size)}`);
  ok(`${size} bytes: every chunk but the last is 1 MiB + tag`, chunks.slice(0, -1).every((c) => c.chunk.length === MiB + 16) && chunks.at(-1).last && chunks.slice(0, -1).every((c) => !c.last));
  for (const piece of [7, 65536, MiB + 16, 5 * MiB]) {
    const blob = await C.decryptFile(streamOf(chunks.map((c) => c.chunk), piece), key, iv);
    if (!(await same(blob, bytes))) ok(`${size} bytes in ${piece}-byte pieces: round trip`, false);
  }
  ok(`${size} bytes: round trip, however the download arrives`, true);
}

// Padding hides the exact size: files a little apart are stored the same.
ok("similar sizes store the same", C.encryptedFileLength(5000) === C.encryptedFileLength(5100) && C.encryptedFileLength(10) === C.encryptedFileLength(4000));

const bytes = randomBytes(3 * MiB + 5);
const chunks = (await encrypt(bytes)).map((c) => c.chunk);
const fails = (list) => rejects(() => C.decryptFile(streamOf(list), key, iv));
ok("reordered chunks are refused", await fails([chunks[1], chunks[0], ...chunks.slice(2)]));
ok("a dropped last chunk is refused", await fails(chunks.slice(0, -1)));
ok("a dropped middle chunk is refused", await fails([chunks[0], ...chunks.slice(2)]));
ok("a cut-off download is refused", await fails([...chunks.slice(0, -1), chunks.at(-1).slice(0, 100)]));
const flipped = chunks.map((c) => c.slice());
flipped[2][500] ^= 1;
ok("a changed byte is refused", await fails(flipped));
const other = (await encrypt(randomBytes(3 * MiB + 5), key, crypto.getRandomValues(new Uint8Array(12)))).map((c) => c.chunk);
ok("a chunk from another file is refused", await fails([chunks[0], other[1], ...chunks.slice(2)]));
const wrongKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
ok("the wrong key is refused", await rejects(() => C.decryptFile(streamOf(chunks), wrongKey, iv)));

let reported = 0;
await C.decryptFile(streamOf(chunks, 500000), key, iv, (n) => (reported = n));
ok("progress reaches the full size", reported === chunks.reduce((n, c) => n + c.length, 0));
