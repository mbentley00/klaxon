import { api, remember, recall, $, el } from './util.js';

const code = location.pathname.split('/').pop().toUpperCase();
$('#t-code').textContent = code;

// Reader/co-reader tokens are only ever returned at room-creation time, so the
// director console keeps the rooms it created (with their tokens) in local
// storage. The server is still the source of truth for which rooms exist.
const ROOMS_KEY = 'trooms:' + code;
const loadRooms = () => { try { return JSON.parse(recall(ROOMS_KEY) || '[]'); } catch { return []; } };
const saveRooms = (list) => remember(ROOMS_KEY, JSON.stringify(list));

const msg = $('#t-msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

async function init() {
  try {
    const t = await api('GET', `/api/tournaments/${code}`);
    $('#t-name').textContent = t.name || '';
    document.title = `${t.name || code} — Klaxon`;
    // Merge any rooms that exist server-side but aren't in our local list
    // (created elsewhere): we can still offer the player link for those.
    const known = loadRooms();
    const knownCodes = new Set(known.map((r) => r.code));
    for (const rc of t.rooms || []) {
      if (!knownCodes.has(rc)) known.push({ code: rc, name: '', readerToken: null, coReaderToken: null });
    }
    saveRooms(known);
  } catch {
    say('Tournament not found.', false);
  }
  render();
}

$('#add-rooms').onclick = async () => {
  const base = $('#room-base').value.trim() || 'Room'; // default -> "Room 1", "Room 2", …
  const qty = Math.max(1, Math.min(50, parseInt($('#room-qty').value, 10) || 1));
  $('#add-rooms').disabled = true;
  say(`Creating ${qty} room${qty > 1 ? 's' : ''}…`);
  const rooms = loadRooms();
  const startIndex = rooms.length;
  try {
    for (let i = 0; i < qty; i++) {
      const name = `${base} ${startIndex + i + 1}`;
      const r = await api('POST', '/api/rooms', { tournamentCode: code, name });
      rooms.push({ code: r.code, name: r.name, readerToken: r.readerToken, coReaderToken: r.coReaderToken });
      saveRooms(rooms);          // persist incrementally so nothing is lost
      render();
    }
    say(`Added ${qty} room${qty > 1 ? 's' : ''}.`);
  } catch (e) {
    say('Error creating rooms: ' + e.message, false);
  }
  $('#add-rooms').disabled = false;
};

function linkRow(label, url) {
  const row = el('div', { className: 'copy-field link-row' });
  const input = el('input', { readOnly: true, value: url });
  const copy = el('button', { className: 'ghost tiny' }, 'Copy');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand('copy'); }
    const o = copy.textContent; copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = o; }, 1200);
  };
  const open = el('a', { className: 'btnlink tiny', href: url, target: '_blank', rel: 'noopener' }, 'Open');
  row.append(el('span', { className: 'link-label' }, label), input, copy, open);
  return row;
}

// ---- bulk copy (spreadsheet) ----
function roomLinks(r) {
  const o = location.origin;
  return {
    code: r.code,
    name: r.name || '',
    player: `${o}/r/${r.code}`,
    reader: r.readerToken ? `${o}/r/${r.code}?role=reader&token=${r.readerToken}` : '',
    coreader: r.coReaderToken ? `${o}/r/${r.code}?role=co-reader&token=${r.coReaderToken}` : ''
  };
}
const TSV_COLS = [['code', 'Room'], ['name', 'Name'], ['player', 'Player link'], ['reader', 'Reader link'], ['coreader', 'Co-reader link']];
function tsvTable() {
  const rooms = loadRooms().map(roomLinks);
  const head = $('#tsv-header').checked ? TSV_COLS.map((c) => c[1]).join('\t') + '\n' : '';
  return head + rooms.map((r) => TSV_COLS.map((c) => r[c[0]]).join('\t')).join('\n');
}
const tsvColumn = (field) => loadRooms().map(roomLinks).map((r) => r[field]).join('\n');

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = $('#tsv-preview'); ta.value = text; ta.select(); document.execCommand('copy'); }
  const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 1200);
}
$('#copy-table').onclick = (e) => copyText(tsvTable(), e.currentTarget);
$('#copy-players').onclick = (e) => copyText(tsvColumn('player'), e.currentTarget);
$('#copy-readers').onclick = (e) => copyText(tsvColumn('reader'), e.currentTarget);
$('#copy-coreaders').onclick = (e) => copyText(tsvColumn('coreader'), e.currentTarget);
$('#tsv-header').onchange = renderBulk;
function renderBulk() {
  const has = loadRooms().length > 0;
  $('#bulk-panel').classList.toggle('hidden', !has);
  if (has) $('#tsv-preview').value = tsvTable();
}

function render() {
  renderBulk();
  const rooms = loadRooms();
  $('#room-count').textContent = rooms.length ? `(${rooms.length})` : '';
  $('#rooms-empty').classList.toggle('hidden', rooms.length > 0);
  const wrap = $('#rooms-list');
  wrap.innerHTML = '';
  const origin = location.origin;
  rooms.forEach((r) => {
    const card = el('div', { className: 'room-item' });
    card.append(el('div', { className: 'room-item-head' },
      el('span', { className: 'room-code' }, r.code),
      el('span', { className: 'room-name' }, r.name || '')));
    card.append(linkRow('Players', `${origin}/r/${r.code}`));
    if (r.readerToken) card.append(linkRow('Reader', `${origin}/r/${r.code}?role=reader&token=${r.readerToken}`));
    if (r.coReaderToken) card.append(linkRow('Co-reader', `${origin}/r/${r.code}?role=co-reader&token=${r.coReaderToken}`));
    wrap.append(card);
  });
}

init();
