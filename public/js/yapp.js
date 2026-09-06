// The packet parser page: hand a .docx (or a .zip of them) to YAPP and give the
// result back as a file. Klaxon proxies the call (see /api/yapp/parse in
// server/index.js) so this page never has to reach a third-party origin.
import { $, el } from './util.js';
import { lintPacket, lintSet } from './packet-lint.js';
import { readZip } from './unzip.js';

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
  html: 'A formatted packet for reading, not for loading into a reader.'
};

// The parsed file, kept so Download and Copy don't re-parse.
let result = null;   // { blob, name, text, type }

function refresh() {
  const file = fileInput.files?.[0];
  const isZip = !!file && /\.zip$/i.test(file.name);
  $('#yapp-file-note').textContent = file
    ? `${file.name} · ${size(file.size)}`
    : 'A .docx packet, or a .zip holding up to 30 of them.';
  // Merging only means something for a zip of several packets.
  $('#yapp-merge-row').classList.toggle('hidden', !isZip);
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

// The name to save under: the packet's own name with the new extension.
function outputName(file, format, isZipResult) {
  const stem = file.name.replace(/\.(docx|zip)$/i, '') || 'packet';
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
    format,
    prettyPrint: String($('#yapp-pretty').checked),
    mergeMultiple: String($('#yapp-merge').checked),
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
    if (envelope) {
      showZipResult(file, format, parsed);
      // A zip has to be opened before the packets inside it can be checked, and
      // that's async — the result is already on screen either way.
      checkZip(parsed, format);
    } else {
      showResult(file, format, raw, type || 'text/plain', false);
      say('Parsed.', true);
      checkOne(raw, format, file.name);
    }
  } catch (e) {
    status.textContent = '';
    say('Could not reach the parser: ' + e.message, false);
  } finally {
    btn.disabled = false;
    status.textContent = '';
  }
});

function showZipResult(file, format, body) {
  const isZip = body.contentType === 'application/zip';
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

// --- checks ------------------------------------------------------------------
// The parser only refuses a packet it can't read at all. What gets through can
// still be damaged — see packet-lint.js for what's looked for and why. HTML
// output isn't a packet, so there's nothing to check there.

function checkOne(text, format, fileName) {
  if (format === 'html') return;
  let packet;
  try { packet = JSON.parse(text); } catch { return; }
  renderChecks([lintPacket(packet, { name: fileName })], 1);
}

async function checkZip(envelope, format) {
  if (format === 'html') return;
  // Merging several packets gives one JSON document, not a zip.
  if (envelope.contentType !== 'application/zip') return checkOne(envelope.result, format, '');

  const note = $('#yapp-checks');
  try {
    const bytes = Uint8Array.from(atob(envelope.result), (c) => c.charCodeAt(0));
    const entries = await readZip(bytes);
    const packets = [];
    for (const entry of entries) {
      if (!entry.text) continue;
      try { packets.push({ name: entry.name.replace(/\.json$/i, ''), packet: JSON.parse(entry.text) }); }
      catch { /* not a packet we can read; the parser's own error list covers it */ }
    }
    if (!packets.length) return;
    renderChecks(lintSet(packets), packets.length);
  } catch {
    // An old browser without DecompressionStream, or a zip we can't walk. The
    // download is unaffected; say so rather than implying the set is clean.
    $('#yapp-checks-panel').classList.remove('hidden');
    $('#yapp-checks-meta').textContent = '';
    note.replaceChildren(el('p', { className: 'hint' },
      "This browser can't open the zip, so the packets inside it weren't checked. Parse a single .docx to check one."));
  }
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
