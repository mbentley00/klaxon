// Just enough ZIP reading to look inside a parsed set. The packet parser hands
// a whole tournament back as a zip of one .json per round, and the checks in
// packet-lint.js can only run on the packets themselves — so the page has to
// open the zip before it can say anything about what's in it.
//
// Reading only, and only what the parser writes: deflate or stored entries, no
// encryption, no Zip64. Anything else is reported as unreadable rather than
// guessed at. (server/zip.js is the writing half, for report downloads.)

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
