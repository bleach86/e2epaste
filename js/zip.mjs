// Zips several files into one attachment, in the browser.
//
// The archive is a Blob stitched together from small headers and the
// original Files, so nothing is copied into memory: the attachment is read
// a slice at a time when it's uploaded, as a single file is. The only pass
// over the files beforehand is for their CRC-32s, which zip needs.
//
// Files are stored, not compressed: most big files (images, video,
// archives) are compressed already, and the size the server sees is padded
// either way. Attachments are at most 4 GiB, so the archive always fits
// plain zip; there's no Zip64 here.

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_ENTRIES = 0xffff;
const MAX_ZIP_BYTES = 0xffffffff;
// Bit 11: names are UTF-8.
const UTF8_NAMES = 0x0800;
// Made by Unix (3), zip 2.0, so the external attributes are a Unix mode.
const MADE_BY = (3 << 8) | 20;
const FILE_MODE = 0o100644;
const CRC_SLICE_BYTES = 4 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// CRC-32 (as zip uses it) of `bytes`, continuing from `crc`.
export function crc32(bytes, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

// A file's name in the archive, with nothing that could be read as a
// folder: no "/" or "\", and not "." or "..".
export function cleanName(name) {
  const clean = name.replace(/[/\\]/g, "_");
  return clean === "" || clean === "." || clean === ".." ? "file" : clean;
}

// The archive's entries, [{ name, file }], from Files. A name used twice
// gets " (2)", which can happen with files dropped from search results.
export function zipEntries(files) {
  const entries = [];
  const used = new Set();
  for (const file of files) {
    let name = cleanName(file.name);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let n = 2;
      while (used.has(`${stem} (${n})${ext}`)) {
        n++;
      }
      name = `${stem} (${n})${ext}`;
    }
    used.add(name);
    entries.push({ name, file });
  }
  return entries;
}

const encoder = new TextEncoder();

// The archive's size in bytes, known without reading any file.
export function zipSize(entries) {
  let size = END_RECORD;
  for (const { name, file } of entries) {
    const nameBytes = encoder.encode(name).length;
    size += LOCAL_HEADER + CENTRAL_HEADER + 2 * nameBytes + file.size;
  }
  return size;
}

// Whether `entries` fit in one plain zip.
export function zipFits(entries) {
  return entries.length <= MAX_ENTRIES && zipSize(entries) <= MAX_ZIP_BYTES;
}

// MS-DOS date and time, as zip keeps them (local time, 2-second steps).
function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// The CRC-32 of a whole file, read a slice at a time.
async function fileCrc(file, onBytes) {
  let crc = 0;
  for (let start = 0; start < file.size; start += CRC_SLICE_BYTES) {
    const bytes = new Uint8Array(await file.slice(start, start + CRC_SLICE_BYTES).arrayBuffer());
    crc = crc32(bytes, crc);
    onBytes(bytes.length);
  }
  return crc;
}

// The archive of `entries` (from zipEntries), as a Blob. Every entry is
// dated `now`, not with the files' own times, which would say when they
// were last changed. onProgress(done, total) follows the CRC pass.
export async function buildZip(entries, { now = new Date(), onProgress = () => {} } = {}) {
  if (!zipFits(entries)) {
    throw new Error("too much to zip");
  }
  const { time, date } = dosDateTime(now);
  const total = entries.reduce((sum, e) => sum + e.file.size, 0);
  let done = 0;
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, file } of entries) {
    const nameBytes = encoder.encode(name);
    const { size } = file;
    const crc = await fileCrc(file, (n) => {
      done += n;
      onProgress(done, total);
    });

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, file);

    const entry = new DataView(new ArrayBuffer(CENTRAL_HEADER));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, MADE_BY, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, UTF8_NAMES, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    // Extra field, comment, disk number and internal attributes: none.
    entry.setUint32(38, FILE_MODE * 0x10000, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, nameBytes);

    offset += LOCAL_HEADER + nameBytes.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(END_RECORD));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const zip = new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  // A file that changed size since it was picked would misplace everything
  // after it.
  if (zip.size !== zipSize(entries)) {
    throw new Error("a file changed while it was being zipped");
  }
  return zip;
}
