import { api, $, el } from './util.js';

// Player landing page for a tournament: /tp/CODE?key=SECRET. The key comes
// from the director's shared link; without it the API refuses, so knowing the
// tournament code alone reveals nothing.
const code = location.pathname.split('/').pop().toUpperCase();
const key = new URLSearchParams(location.search).get('key') || '';

async function init() {
  $('#tp-name').textContent = `Tournament ${code}`;
  let view;
  try {
    view = await api('GET', `/api/tournaments/${code}/player-view?key=${encodeURIComponent(key)}`);
  } catch (e) {
    $('#tp-locked').classList.remove('hidden');
    if (e.message !== 'bad_key') {
      $('#tp-msg').textContent = 'Tournament not found — check the link.';
      $('#tp-msg').className = 'msg bad';
    }
    return;
  }

  $('#tp-name').textContent = view.name;
  document.title = `${view.name} — Klaxon`;
  if (view.date) $('#tp-date').textContent = view.date;
  $('#tp-body').classList.remove('hidden');

  $('#tp-stats').href = view.statsPath;
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
    col.append(el('span', { className: 'pjoined' }, `code ${r.code}`));
    li.append(col);
    li.append(el('a', { className: 'btnlink tiny', href: `/r/${r.code}` }, 'Join →'));
    rooms.append(li);
  }
  if (view.rooms.length === 0) {
    rooms.append(el('li', {}, el('span', { className: 'pjoined' }, 'No rooms yet — check back closer to start time.')));
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
