// Just enough ZIP for the packet parser page, in the browser.
//
// Reading: the parser hands a whole tournament back as a zip of one .json per
// round, and the checks in packet-lint.js can only run on the packets
// themselves, so the page has to open the zip first. Deflate or stored entries
// only — no encryption, no Zip64; anything else is reported as unreadable
// rather than guessed at.
//
// Writing: splitting a packet into tiebreakers produces twenty-odd small files,
// and a browser will not hand over twenty downloads. Entries are stored rather
// than deflated — CompressionStream would work, but a split packet is a few
// hundred kilobytes and not worth the asymmetry with the reader above.
//
// (server/zip.js is the same format for Node, where Buffer does the work; the
// two are kept apart rather than shared because neither runtime's primitives
// belong in the other.)

const EOCD = 0x06054b50;      // end of central directory
const CENTRAL = 0x02014b50;   // central directory file header
const LOCAL = 0x04034b50;     // local file header

// The end-of-directory record sits at the end of the file, after a comment of
// unknown length, so it has to be found by scanning backwards for its signature.
function findEndRecord(view) {
  const max = Math.min(view.byteLength, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const at = view.byteLength - i;
    if (view.getUint32(at, true) === EOCD) return at;
  }
  return -1;
}

async function inflate(bytes, method) {
  if (method === 0) return bytes;                  // stored
  if (method !== 8) throw new Error(`unsupported compression method ${method}`);
  // "deflate-raw" is deflate without the zlib header, which is what ZIP stores.
  if (typeof DecompressionStream !== 'function') throw new Error('no DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads a zip into [{ name, text }], smallest useful surface. Entries that are
 * directories or that fail to inflate are skipped, so one damaged file doesn't
 * cost the caller the rest of the set.
 */
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(view);
  if (end < 0) throw new Error('not a zip file');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);   // offset of the central directory
  const decoder = new TextDecoder('utf-8');
  const out = [];

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) break;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;

    // The local header repeats the name and extra fields, and its extra field
    // length can differ from the central one — so the data offset has to be
    // read from the local header rather than assumed.
    if (view.getUint32(localAt, true) !== LOCAL) continue;
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localName + localExtra;
    try {
      const raw = await inflate(bytes.subarray(dataAt, dataAt + compressedSize), method);
      out.push({ name, text: decoder.decode(raw) });
    } catch {
      out.push({ name, text: null });
    }
  }
  return out;
}

// --- writing -----------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Builds a zip from [{ name, text }] and returns it as a Blob, ready to hand to
 * a download. Stored (uncompressed) entries — see the note at the top.
 */
export function writeZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.text ?? '');
    const crc = crc32(data);

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL, true);
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 1 << 11, true);       // flags: names are UTF-8
    lv.setUint16(8, 0, true);             // method: store
    lv.setUint16(10, 0, true);            // mod time
    lv.setUint16(12, 0x21, true);         // mod date (1980-01-01, a valid DOS date)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);  // compressed size
    lv.setUint32(22, data.length, true);  // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);            // extra length

    const entry = new Uint8Array(46);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 1 << 11, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);       // where the local header sits

    chunks.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const directory = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, files.length, true);    // entries on this disk
  ev.setUint16(10, files.length, true);   // entries total
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, offset, true);         // where the directory starts

  return new Blob([concat(chunks), directory, end], { type: 'application/zip' });
}
