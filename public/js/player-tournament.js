import { api, $, el } from './util.js';

// Player landing page for a tournament: /tp/CODE?key=SECRET. The key comes
// from the director's shared link; without it the API refuses, so knowing the
// tournament code alone reveals nothing.
const code = location.pathname.split('/').pop().toUpperCase();
const params = new URLSearchParams(location.search);
const key = params.get('key') || '';
// Or a room of the tournament: a player who came from a shared room link.
const fromRoom = (params.get('room') || '').toUpperCase();

// What a room is doing, in words ("Round 4 · tossup 12 of 20").
function statusText(s) {
  if (!s || s.state === 'none') return 'No game yet';
  const r = s.round ? (/^\d+$/.test(s.round) ? `Round ${s.round}` : s.round) : '';
  const join = (...xs) => xs.filter(Boolean).join(' · ');
  switch (s.state) {
    case 'playing': return join(r, s.q ? `tossup ${s.q}${s.of ? ` of ${s.of}` : ''}` : 'playing');
    case 'overtime': return join(r, 'overtime');
    case 'pickban': return join(r, 'pick/ban');
    case 'setup': return join(r, 'setting up');
    case 'idle': return join(r, 'no updates for 10+ minutes');
    case 'finished': return join(r, 'finished ✓');
    default: return '';
  }
}

async function init() {
  $('#tp-name').textContent = `Tournament ${code}`;
  let view;
  try {
    view = await api('GET', `/api/tournaments/${code}/player-view?key=${encodeURIComponent(key)}&room=${encodeURIComponent(fromRoom)}`);
  } catch (e) {
    $('#tp-locked').classList.remove('hidden');
    if (e.message !== 'bad_key') {
      $('#tp-msg').textContent = 'Tournament not found. Check the link.';
      $('#tp-msg').className = 'msg bad';
    }
    return;
  }

  $('#tp-name').textContent = view.name;
  document.title = `${view.name} — Klaxon`;
  if (view.date) $('#tp-date').textContent = view.date;
  $('#tp-body').classList.remove('hidden');

  $('#tp-stats').href = view.statsPath;
  const back = view.rooms.find((r) => r.code === fromRoom);
  if (back) {
    $('#tp-back-link').href = `/r/${back.code}`;
    $('#tp-back-link').textContent = `← Back to ${back.name || back.code}`;
    $('#tp-back').classList.remove('hidden');
  }
  if (view.links?.schedule) {
    const a = $('#tp-schedule');
    a.href = view.links.schedule;
    a.classList.remove('hidden');
  }
  if (view.links?.discord) {
    const a = $('#tp-discord');
    a.href = view.links.discord;
    a.classList.remove('hidden');
  }

  const rooms = $('#tp-rooms');
  for (const r of view.rooms) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    col.append(el('span', { className: 'pname' }, r.name || `Room ${r.code}`));
    const st = el('span', { className: 'pjoined' }, statusText(r.status));
    st.dataset.room = r.code;
    col.append(st);
    li.append(col);
    li.append(el('a', { className: 'btnlink tiny', href: `/r/${r.code}` }, r.code === fromRoom ? 'Back →' : 'Join →'));
    rooms.append(li);
  }
  if (view.rooms.length === 0) {
    rooms.append(el('li', {}, el('span', { className: 'pjoined' }, 'No rooms yet.')));
  }

  // Round schedule (if the director entered one): round -> matchups.
  const sched = Array.isArray(view.schedule) ? view.schedule : [];
  if (sched.length > 0) {
    $('#tp-sched-section').classList.remove('hidden');
    const byRound = new Map();
    for (const row of sched) {
      if (!byRound.has(row.round)) byRound.set(row.round, []);
      byRound.get(row.round).push(row);
    }
    const ul = $('#tp-sched');
    const roundKeys = [...byRound.keys()].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a).localeCompare(String(b));
    });
    for (const round of roundKeys) {
      const li = el('li', {});
      const col = el('span', { className: 'pcol' });
      col.append(el('span', { className: 'pname' }, `Round ${round}`));
      const lines = byRound.get(round).map((row) =>
        `${row.teams?.length ? row.teams.join(' vs ') : '—'}${row.room ? ` · room ${row.room}` : ''}`);
      col.append(el('span', { className: 'pjoined' }, lines.join('   |   ')));
      li.append(col);
      ul.append(li);
    }
  }
}

init();

// Keep each room's state current while the page is open.
setInterval(async () => {
  if (document.visibilityState !== 'visible') return;
  try {
    const { rooms } = await api('GET', `/api/tournaments/${code}/room-status`);
    for (const span of document.querySelectorAll('#tp-rooms [data-room]')) {
      span.textContent = statusText(rooms[span.dataset.room]);
    }
  } catch { /* next time */ }
}, 30000);
