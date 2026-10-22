// One hash, computed off the page's thread (js/tools/hash-parallel.mjs
// starts one of these per algorithm). Messages in: { algorithm, key } to
// start, then { bytes } for each slice of the file, then { finish: true }.
// Messages out: "ack" after each slice, then { digest }.
import { ALGORITHMS } from "./hashes.mjs";
import { hmac } from "@noble/hashes/hmac.js";

let state = null;

self.onmessage = ({ data }) => {
  if (data.algorithm) {
    const { hash } = ALGORITHMS.find((a) => a.id === data.algorithm);
    state = data.key ? hmac.create(hash, data.key) : hash.create();
  } else if (data.bytes) {
    state.update(data.bytes);
    self.postMessage("ack");
  } else if (data.finish) {
    self.postMessage({ digest: state.digest() });
  }
};
