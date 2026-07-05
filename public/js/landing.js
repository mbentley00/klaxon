import { api, remember, recall, $, el } from './util.js';

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Remember the player's name across sessions.
$('#join-name').value = recall('name') || '';

function go(code, extra = '') {
  location.href = `/r/${code}${extra}`;
}

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code) return say('Enter a room code.', false);
  if (name) remember('name', name);
  go(code);
});

$('#create-room').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const modaqMode = $('#room-modaq-mode').value; // off | lite | full
    const settings =
      modaqMode === 'lite' ? { modaqMode: true, modaqLite: true }
        : modaqMode === 'full' ? { modaqMode: true }
          : undefined;
    const body = {
      name: $('#room-name').value.trim() || undefined,
      tournamentCode: $('#room-tournament').value.trim().toUpperCase() || undefined,
      settings
    };
    const r = await api('POST', '/api/rooms', body);
    // Persist the capabilities for this room: the reader token authorizes us as
    // reader; the co-reader token is kept so the room UI can build invite links.
    remember('staffToken:' + r.code, r.readerToken);
    remember('coReaderToken:' + r.code, r.coReaderToken);
    say(`Created room ${r.code}. Opening as reader…`);
    go(r.code, '?role=reader');
  } catch (err) {
    say('Could not create room: ' + err.message, false);
  }
});

// Tournament creation lives on its own page (/new-tournament).

// "Your tournaments": everything this browser created (director tokens) or
// opened via a link (recorded by the tournament page). All local — no account.
(() => {
  let recents = [];
  try { recents = JSON.parse(recall('recentTournaments') || '[]').filter((e) => e && e.code); }
  catch { /* ignore */ }
  const seen = new Set(recents.map((e) => e.code));
  // Tournaments created before visit-tracking existed still have a director
  // token; show them by code until they're next opened (which fills the name).
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('bz_directorToken:')) {
      const code = k.slice('bz_directorToken:'.length);
      if (!seen.has(code)) recents.push({ code, name: code, date: '' });
    }
  }
  if (!recents.length) return;
  $('#my-tournaments').classList.remove('hidden');
  const ul = $('#my-tournaments-list');
  for (const t of recents.slice(0, 8)) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    col.append(el('span', { className: 'pname' }, t.name || t.code));
    col.append(el('span', { className: 'pjoined' }, `${t.date || ''}${t.date ? ' · ' : ''}code ${t.code}`));
    li.append(col);
    li.append(el('a', { className: 'btnlink tiny', href: '/t/' + t.code },
      recall('directorToken:' + t.code) ? 'Director console' : 'Open'));
    ul.append(li);
  }
})();

// Reflect signed-in state on the account link.
(async () => {
  const s = localStorage.getItem('bz_sessionToken');
  const link = $('#account-link');
  if (!s || !link) return;
  try {
    const { account } = await api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(s)}`);
    link.textContent = `Account · ${account.username}`;
  } catch { localStorage.removeItem('bz_sessionToken'); }
})();
