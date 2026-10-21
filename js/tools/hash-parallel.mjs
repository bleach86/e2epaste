// Hashes a file with several algorithms at once, one Web Worker each
// (js/tools/hash-worker.mjs), so they run side by side and the page stays
// responsive. The file is read once, a slice at a time; each worker gets its
// own copy of each slice. The next slice is read while the workers hash the
// current one, but no further, so memory stays at a few slices whatever the
// file's size.
import { ALGORITHMS, hashFile } from "./hashes.mjs";

const SLICE_BYTES = 4 * 1024 * 1024;

function startWorker() {
  return new Worker(new URL("./hash-worker.mjs", import.meta.url), { type: "module" });
}

// A worker's replies, one at a time, in order: next() waits for the next
// one, and fail(error) ends every wait, now and later, with `error`.
function replies(worker) {
  const waiting = [];
  const queued = [];
  let failed = null;
  const fail = (error) => {
    failed ??= error;
    while (waiting.length) waiting.shift().reject(failed);
  };
  worker.onmessage = ({ data }) => (waiting.length ? waiting.shift().resolve(data) : queued.push(data));
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new Error(event.message || "A hash worker failed."));
  };
  const next = () =>
    new Promise((resolve, reject) => {
      if (queued.length) return resolve(queued.shift());
      if (failed) return reject(failed);
      waiting.push({ resolve, reject });
    });
  return { next, fail };
}

// Like hashFile in hashes.mjs: { id: bytes } for the algorithms in `ids`,
// HMACs with a `key`. Falls back to hashFile where workers aren't available.
export async function hashFileInParallel(file, ids, { key = null, onProgress = () => {}, signal } = {}) {
  const keyed = key?.length ? key : null;
  const chosen = ALGORITHMS.filter((a) => ids.includes(a.id) && !(keyed && a.noHmac)).map((a) => a.id);
  if (chosen.length === 0) {
    return {};
  }
  let workers;
  try {
    workers = chosen.map((id) => ({ id, worker: startWorker() }));
  } catch {
    return hashFile(file, ids, { key, onProgress, signal });
  }
  for (const w of workers) {
    Object.assign(w, replies(w.worker));
  }
  const stopAll = () => workers.forEach(({ worker }) => worker.terminate());
  // A stopped worker never replies, so stopping also ends the waits.
  const abort = () => {
    stopAll();
    workers.forEach((w) => w.fail(signal.reason));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for (const w of workers) {
      w.worker.postMessage({ algorithm: w.id, key: keyed });
    }
    const read = (start) => file.slice(start, start + SLICE_BYTES).arrayBuffer();
    let pending = file.size > 0 ? read(0) : null;
    for (let start = 0; start < file.size; start += SLICE_BYTES) {
      signal?.throwIfAborted();
      const slice = new Uint8Array(await pending);
      // Read ahead while this slice is hashed.
      pending = start + SLICE_BYTES < file.size ? read(start + SLICE_BYTES) : null;
      workers.forEach(({ worker }, i) => {
        // The last worker can have the slice itself; the others get copies.
        const bytes = i === workers.length - 1 ? slice : slice.slice();
        worker.postMessage({ bytes }, [bytes.buffer]);
      });
      await Promise.all(workers.map((w) => w.next()));
      onProgress(Math.min(file.size, start + SLICE_BYTES), file.size);
    }
    signal?.throwIfAborted();
    for (const { worker } of workers) worker.postMessage({ finish: true });
    const digests = await Promise.all(workers.map((w) => w.next()));
    return Object.fromEntries(workers.map((w, i) => [w.id, digests[i].digest]));
  } finally {
    signal?.removeEventListener("abort", abort);
    stopAll();
  }
}
