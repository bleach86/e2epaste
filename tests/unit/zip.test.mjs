// Zipping several files into one attachment (js/zip.mjs): the archives are
// read back by Python's zipfile, so a reader other than ours checks them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Z from "../../js/zip.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };

ok("crc32 check value", Z.crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
const halves = Z.crc32(new TextEncoder().encode("56789"), Z.crc32(new TextEncoder().encode("1234")));
ok("crc32 continues across pieces", halves === 0xcbf43926);

ok("names can't name folders", Z.cleanName("../etc/passwd") === ".._etc_passwd" && Z.cleanName("a\\b") === "a_b" && Z.cleanName("..") === "file");

const big = new Uint8Array(5 * 1024 * 1024 + 3).map((_, i) => (i * 31) % 251);
const entries = Z.zipEntries([
  new File([big], "cat.jpg"),
  new File(["hello\n"], "notes ✓.txt"),
  new File([], "empty.txt"),
  new File(["again\n"], "notes ✓.txt"),
  new File(["third\n"], "notes ✓.txt"),
]);
ok("entries: a repeated name gets (2), (3)",
  JSON.stringify(entries.map((e) => e.name)) === JSON.stringify(["cat.jpg", "notes ✓.txt", "empty.txt", "notes ✓ (2).txt", "notes ✓ (3).txt"]),
  JSON.stringify(entries.map((e) => e.name)));

let progress = 0;
const zip = await Z.buildZip(entries, { now: new Date(2026, 9, 21, 13, 37, 42), onProgress: (done) => { progress = done; } });
ok("size is known before zipping", zip.size === Z.zipSize(entries), `${zip.size} vs ${Z.zipSize(entries)}`);
ok("progress covers every byte", progress === big.length + 6 + 6 + 6);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2epaste-zip-"));
const zipPath = path.join(dir, "files.zip");
fs.writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()));
const read = JSON.parse(execFileSync("python3", ["-I", "-c", `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "entries": [
        {"name": i.filename, "dir": i.is_dir(), "size": i.file_size, "time": list(i.date_time),
         "mode": oct(i.external_attr >> 16), "sha": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]}))
`, zipPath]).toString());
const sha = (bytes) => execFileSync("python3", ["-I", "-c", "import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], { input: bytes }).toString().trim();
ok("python reads it, every CRC right", read.bad === null && read.entries.length === 5, JSON.stringify(read.bad));
const byName = Object.fromEntries(read.entries.map((e) => [e.name, e]));
ok("contents byte for byte", byName["cat.jpg"].sha === sha(Buffer.from(big)) && byName["notes ✓.txt"].sha === sha("hello\n")
  && byName["notes ✓ (2).txt"].sha === sha("again\n") && byName["empty.txt"].size === 0);
ok("plain files, mode 644", read.entries.every((e) => !e.dir && e.mode === "0o100644"));
ok("dated when zipped, not the files' own dates", read.entries.every((e) => JSON.stringify(e.time) === "[2026,10,21,13,37,42]"));

const unzipDir = path.join(dir, "out");
try {
  execFileSync("unzip", ["-q", zipPath, "-d", unzipDir]);
  ok("unzip extracts it", fs.readFileSync(path.join(unzipDir, "notes ✓ (3).txt"), "utf8") === "third\n");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.log("SKIP unzip isn't installed");
}

const tooMany = Z.zipEntries(Array.from({ length: 0x10000 }, (_, i) => new File([], `f${i}`)));
ok("too many entries don't fit", !Z.zipFits(tooMany) && Z.zipFits(tooMany.slice(1)));
fs.rmSync(dir, { recursive: true });
