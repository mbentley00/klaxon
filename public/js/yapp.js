// The packet parser page: hand a .docx (or a .zip of them) to YAPP and give the
// result back as a file. Klaxon proxies the call (see /api/yapp/parse in
// server/index.js) so this page never has to reach a third-party origin.
import { $, el } from './util.js';
import { lintPacket, lintSet } from './packet-lint.js';
import { readZip, writeZip } from './zip.js';
import { splitIntoTiebreakers } from './packet-split.js';

const msg = $('#yapp-msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };
const status = $('#yapp-status');

// Matches the API's own ceiling (ParseProcessor rejects anything larger), so an
// oversized file is refused here instead of after a long upload.
const MAX_BYTES = 3 * 1024 * 1024;
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const fileInput = $('#yapp-file');
const formatSel = $('#yapp-format');

// What each format is for, said once rather than crowded into the option list.
const FORMAT_NOTES = {
  json: 'The packet format MODAQ loads and Klaxon stores for a round.',
  yapp2: 'The same JSON plus an “anchored” copy of any question with a pronunciation guide, ' +
    'marking which words the guide covers. Readers that don’t know yapp2 ignore the extra field.',
  html: 'A formatted packet for reading, not for loading into a reader.',
  tiebreakers: 'A zip of one JSON per tossup. Upload them all at once in the director console with ' +
    '“tiebreaker” ticked, and each question becomes a round you can release on its own — so the pool ' +
    'stays hidden until the moment a room needs one question out of it. Bonuses are dropped: a tiebreaker ' +
    'is a tossup.'
};

// The parser has no tiebreaker mode — that split happens here, on the JSON it
// gives back. Everything else is a format it knows.
const TIEBREAKERS = 'tiebreakers';
const parseFormat = (format) => (format === TIEBREAKERS ? 'json' : format);

// The parsed file, kept so Download and Copy don't re-parse.
let result = null;   // { blob, name, text, type }

function refresh() {
  const file = fileInput.files?.[0];
  const isZip = !!file && /\.zip$/i.test(file.name);
  $('#yapp-file-note').textContent = file
    ? `${file.name} · ${size(file.size)}`
    : 'A .docx packet, or a .zip holding up to 30 of them.';
  // Merging only means something for a zip of several packets — and never when
  // splitting into tiebreakers, where merging first would renumber the
  // questions across packets and lose which round each one came from.
  $('#yapp-merge-row').classList.toggle('hidden', !isZip || formatSel.value === TIEBREAKERS);
  $('#yapp-format-note').textContent = FORMAT_NOTES[formatSel.value] || '';
  $('#yapp-parse').disabled = !file;
}

fileInput.addEventListener('change', () => {
  say('');
  hideResult();
  refresh();
});
formatSel.addEventListener('change', refresh);
refresh();

function hideResult() {
  result = null;
  $('#yapp-result-panel').classList.add('hidden');
  $('#yapp-errors').classList.add('hidden');
  $('#yapp-checks-panel').classList.add('hidden');
  $('#yapp-checks').replaceChildren();
}

const fileStem = (file) => file.name.replace(/\.(docx|zip)$/i, '') || 'packet';

// The name to save under: the packet's own name with the new extension.
function outputName(file, format, isZipResult) {
  const stem = fileStem(file);
  if (format === TIEBREAKERS) return `${stem} tiebreakers.zip`;
  if (isZipResult) return `${stem}.zip`;
  return `${stem}.${format === 'html' ? 'html' : 'json'}`;
}

$('#yapp-parse').addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > MAX_BYTES) {
    return say(`That file is ${size(file.size)}. The parser takes up to ${size(MAX_BYTES)}.`, false);
  }
  const btn = $('#yapp-parse');
  btn.disabled = true;
  say('');
  hideResult();
  status.textContent = 'Parsing…';

  const format = formatSel.value;
  const params = new URLSearchParams({
    format: parseFormat(format),
    prettyPrint: String($('#yapp-pretty').checked),
    mergeMultiple: String(format !== TIEBREAKERS && $('#yapp-merge').checked),
    // Ask for the JSON envelope rather than a raw zip stream: it carries the
    // per-packet errors alongside the result, so a set where two packets failed
    // still hands back the other twenty-eight and says which two didn't.
    version: '2'
  });

  try {
    const res = await fetch(`/api/yapp/parse?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file
    });
    const type = res.headers.get('content-type') || '';
    // Always read the body as text and hand THAT back: re-encoding it through
    // JSON.parse/stringify would throw away the parser's own formatting, so
    // "pretty-print" would quietly do nothing.
    const raw = await res.text();
    let parsed = null;
    if (type.includes('application/json')) {
      try { parsed = JSON.parse(raw); } catch { /* not the envelope; treat as text */ }
    }

    if (!res.ok) {
      const lines = parsed?.errorMessages || (parsed?.error ? [parsed.error] : null);
      status.textContent = '';
      return say(lines ? lines.join(' ') : `The parser returned ${res.status}.`, false);
    }

    // A zip of several packets comes back as { contentType, result, errors,
    // successCount } — `result` is base64 for a zip and plain text otherwise.
    const envelope = parsed && !Array.isArray(parsed) &&
      typeof parsed.result === 'string' && typeof parsed.contentType === 'string';
    // Splitting into tiebreakers replaces the parser's own output entirely, so
    // that result is never put on screen — only the zip of split files is. Any
    // packet the parser refused is still worth listing either way.
    const splitting = format === TIEBREAKERS;
    if (envelope) showZipResult(file, format, parsed, { keepResult: !splitting });
    else if (!splitting) {
      showResult(file, format, raw, type || 'text/plain', false);
      say('Parsed.', true);
    }

    // HTML isn't a packet, so there is nothing to open, check or split.
    if (format === 'html') return;
    // Opening a zip is async, and both the checks and the split want the packets
    // rather than the bytes — so gather them once.
    const packets = await parsedPackets(file, envelope ? parsed : null, raw);
    if (packets === null) return unopenableZip();
    if (!packets.length) {
      if (splitting) say('Nothing to split — no packet came out of that file.', false);
      return;
    }
    showChecks(packets);
    if (splitting) splitIntoFiles(file, packets);
  } catch (e) {
    status.textContent = '';
    say('Could not reach the parser: ' + e.message, false);
  } finally {
    btn.disabled = false;
    status.textContent = '';
  }
});

// `keepResult` is false when the caller is going to replace the parser's output
// with something built from it — the per-file failures below still belong on
// screen, but the parser's own zip does not.
function showZipResult(file, format, body, { keepResult = true } = {}) {
  const isZip = body.contentType === 'application/zip';
  if (keepResult) {
    let blob;
    let text = '';
    if (isZip) {
      const bytes = Uint8Array.from(atob(body.result), (c) => c.charCodeAt(0));
      blob = new Blob([bytes], { type: 'application/zip' });
    } else {
      text = body.result;
      blob = new Blob([text], { type: body.contentType });
    }
    showResult(file, format, text, body.contentType, isZip, blob);
  }

  const failed = Object.entries(body.errors || {});
  const ok = body.successCount ?? 0;
  say(failed.length
    ? `Parsed ${ok} packet${ok === 1 ? '' : 's'}; ${failed.length} didn't parse.`
    : `Parsed ${ok} packet${ok === 1 ? '' : 's'}.`, !failed.length);

  const box = $('#yapp-errors');
  box.classList.toggle('hidden', !failed.length);
  $('#yapp-errors-count').textContent = failed.length ? `(${failed.length})` : '';
  const list = $('#yapp-errors-list');
  list.replaceChildren();
  for (const [name, messages] of failed) {
    const li = document.createElement('li');
    li.textContent = `${name}: ${[].concat(messages).join(' ')}`;
    list.append(li);
  }
}

function showResult(file, format, text, contentType, isZip, blob) {
  const name = outputName(file, format, isZip);
  result = { blob: blob || new Blob([text], { type: contentType }), name, text, type: contentType };
  $('#yapp-result-panel').classList.remove('hidden');
  $('#yapp-result-meta').textContent = `${name} · ${size(result.blob.size)}`;
  // A zip is binary: there's nothing readable to preview, only to download.
  $('#yapp-copy').classList.toggle('hidden', isZip);
  const preview = $('#yapp-preview');
  if (isZip) {
    preview.textContent = '';
    $('#yapp-preview-note').textContent = 'A zip with one file per packet — download it to open.';
    return;
  }
  const CAP = 4000;
  preview.textContent = text.slice(0, CAP);
  $('#yapp-preview-note').textContent = text.length > CAP
    ? `First ${CAP.toLocaleString()} characters of ${text.length.toLocaleString()}.`
    : '';
}

// --- the packets themselves --------------------------------------------------
// Both the checks and the tiebreaker split work on parsed packets rather than on
// what the parser sent, and the parser sends three different shapes: a bare JSON
// document for one .docx, an envelope holding one for a merged set, and an
// envelope holding a base64 zip for a set kept as separate files.
//
// Returns [{ name, packet }], or null when a zip is there but can't be opened —
// which the caller has to say out loud rather than treat as an empty set.
async function parsedPackets(file, envelope, raw) {
  const one = (text, name) => {
    try { return [{ name, packet: JSON.parse(text) }]; } catch { return []; }
  };
  if (!envelope) return one(raw, fileStem(file));
  if (envelope.contentType !== 'application/zip') return one(envelope.result, fileStem(file));

  try {
    const bytes = Uint8Array.from(atob(envelope.result), (c) => c.charCodeAt(0));
    const out = [];
    for (const entry of await readZip(bytes)) {
      if (!entry.text) continue;
      // A file we can't parse is one the parser already reported; its own error
      // list covers it, so it's dropped rather than mentioned twice.
      try { out.push({ name: entry.name.replace(/\.json$/i, ''), packet: JSON.parse(entry.text) }); }
      catch { /* see above */ }
    }
    return out;
  } catch {
    return null;
  }
}

// An old browser without DecompressionStream, or a zip we can't walk. The
// download still works; say so rather than implying the set came back clean.
function unopenableZip() {
  $('#yapp-checks-panel').classList.remove('hidden');
  $('#yapp-checks-meta').textContent = '';
  $('#yapp-checks').replaceChildren(el('p', { className: 'hint' },
    "This browser can't open the zip, so the packets inside it weren't checked. Parse a single .docx to check one."));
}

// --- checks ------------------------------------------------------------------
// The parser only refuses a packet it can't read at all. What gets through can
// still be damaged — see packet-lint.js for what's looked for and why.
function showChecks(packets) {
  // A set gets the extra check a single packet can't make: the one round that
  // is a question shorter than all the others.
  const reports = packets.length > 1
    ? lintSet(packets)
    : [lintPacket(packets[0].packet, { name: packets[0].name })];
  renderChecks(reports, packets.length);
}

// --- tiebreakers -------------------------------------------------------------
// One JSON per tossup, zipped, because a browser won't hand over twenty
// downloads. See packet-split.js for what each file holds and why.
function splitIntoFiles(file, packets) {
  const pretty = $('#yapp-pretty').checked;
  const files = [];
  for (const { name, packet } of packets) {
    // A single .docx is labelled by the file it came from; a set labels each
    // question with its own round, so "Round 3 TB 07" says where to find it.
    for (const tb of splitIntoTiebreakers(packet, { label: name })) {
      files.push({ name: `${tb.name}.json`, text: JSON.stringify(tb.packet, null, pretty ? 2 : 0) });
    }
  }
  if (!files.length) return say('Nothing to split — no tossups came out of this packet.', false);

  showResult(file, TIEBREAKERS, '', 'application/zip', true, writeZip(files));
  $('#yapp-preview-note').textContent =
    `${files.length} file${files.length === 1 ? '' : 's'}, one per tossup — upload them all at once in the ` +
    'director console with “tiebreaker” ticked.';
  // Any packet the parser refused is listed on its own above; this counts what
  // actually got split, so the two numbers can be read together.
  const from = packets.length > 1 ? ` from ${packets.length} packets` : '';
  say(`Split into ${files.length} tiebreaker${files.length === 1 ? '' : 's'}${from}.`, true);
}

const LEVEL_WORD = { error: 'error', warning: 'warning', note: 'note' };

function renderChecks(reports, packetCount) {
  const panel = $('#yapp-checks-panel');
  const box = $('#yapp-checks');
  box.replaceChildren();
  panel.classList.remove('hidden');

  const errors = reports.reduce((n, r) => n + r.findings.filter((f) => f.level === 'error').length, 0);
  const warnings = reports.reduce((n, r) => n + r.findings.filter((f) => f.level === 'warning').length, 0);
  const notes = reports.reduce((n, r) => n + r.findings.filter((f) => f.level === 'note').length, 0);
  const bits = [];
  if (errors) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) bits.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (notes) bits.push(`${notes} note${notes === 1 ? '' : 's'}`);
  $('#yapp-checks-meta').textContent = bits.length
    ? bits.join(', ')
    : `nothing flagged in ${packetCount} packet${packetCount === 1 ? '' : 's'}`;

  for (const r of reports) {
    const stats = [
      `${r.summary.tossups} tossup${r.summary.tossups === 1 ? '' : 's'}`,
      `${r.summary.bonuses} bonus${r.summary.bonuses === 1 ? '' : 'es'}`
    ];
    if (r.summary.powered) stats.push('powered');
    if (r.summary.categories) stats.push('categories');

    // Only a set needs each packet named; for one file the page already says
    // which file it was.
    const head = el('div', { className: 'yapp-pk-head' });
    if (reports.length > 1) head.append(el('span', { className: 'yapp-pk-name', textContent: r.name || 'packet' }));
    head.append(el('span', { className: 'yapp-pk-stats', textContent: stats.join(' · ') }));
    const block = el('div', { className: 'yapp-pk' }, head);

    if (!r.findings.length) {
      block.append(el('p', { className: 'yapp-clean', textContent: 'Nothing looks wrong.' }));
    } else {
      const list = el('ul', { className: 'yapp-finds' });
      for (const f of r.findings) {
        list.append(el('li', { className: `lvl-${f.level}` },
          el('span', { className: 'yapp-where', textContent: f.where || LEVEL_WORD[f.level] }),
          el('span', { textContent: f.message })));
      }
      block.append(list);
    }
    box.append(block);
  }
}

$('#yapp-download').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(result.blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: result.name });
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke on the next tick; Safari needs the URL to still be live at click time.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#yapp-copy').addEventListener('click', async () => {
  if (!result?.text) return;
  try {
    await navigator.clipboard.writeText(result.text);
    say('Copied.', true);
  } catch {
    say('Could not copy — download it instead.', false);
  }
});
