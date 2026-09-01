import { api, remember, recall, $, el } from './util.js';

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Remember the player's name across sessions.
$('#join-name').value = recall('name') || '';

// Signed in? Label the account link, and refresh the name/settings the account
// carries so a player landing here on a new device gets theirs back.
const sessionToken = localStorage.getItem('bz_sessionToken');
if (sessionToken) {
  api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(sessionToken)}`)
    .then(({ account }) => {
      $('#account-link').textContent = `Account: ${account.displayName || account.username} →`;
      $('#account-link').href = '/account';
      if (account.displayName) remember('name', account.displayName);
      for (const [k, v] of Object.entries(account.prefs || {})) remember(k, v);
      $('#join-name').value = recall('name') || '';
    })
    .catch(() => { /* stale session: the link still offers log in */ });
}

function go(code, extra = '') {
  location.href = `/r/${code}${extra}`;
}

// Rooms this browser joined before, if they're still running. Minimal: code,
// name, how many players are in there now, and when we were last in.
const ago = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

async function showRecentRooms() {
  let recent = [];
  try { recent = JSON.parse(recall('recentRooms') || '[]'); } catch { return; }
  recent = recent.filter((r) => r?.code);
  if (!recent.length) return;
  let live = [];
  try {
    const r = await api('GET', `/api/rooms-summary?codes=${recent.map((x) => x.code).join(',')}`);
    live = r.rooms || [];
  } catch { return; }
  if (!live.length) return;                     // all of them are gone
  const byCode = new Map(live.map((r) => [r.code, r]));
  const ul = $('#recent-list');
  ul.replaceChildren();
  for (const { code: rc, at } of recent) {
    const room = byCode.get(rc);
    if (!room) continue;                        // expired since we were there
    const link = el('a', { href: `/${rc}`, className: 'recent-link' });
    link.append(el('span', { className: 'recent-code' }, rc));
    link.append(el('span', { className: 'recent-name' }, room.name || ''));
    link.append(el('span', { className: 'recent-meta' },
      `${room.players} player${room.players === 1 ? '' : 's'} · ${ago(at)}`));
    ul.append(el('li', {}, link));
  }
  if (ul.childElementCount) $('#recent-section').classList.remove('hidden');
}
showRecentRooms();

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code) return say('Enter a room code.', false);
  if (name) remember('name', name);
  go(code);
});

// The home page creates a plain buzzer room with no questions asked. Room name,
// tournament code, MODAQ and the game options live on /advanced.
async function createRoom(settings, open) {
  try {
    const r = await api('POST', '/api/rooms', settings ? { settings } : {});
    // Persist the capabilities for this room: the reader token authorizes us as
    // reader; the co-reader token is kept so the room UI can build invite links.
    remember('staffToken:' + r.code, r.readerToken);
    remember('coReaderToken:' + r.code, r.coReaderToken);
    say(`Created room ${r.code}. Opening as reader…`);
    open(r.code);
  } catch (err) {
    say('Could not create room: ' + err.message, false);
  }
}

$('#create-room').addEventListener('submit', (e) => {
  e.preventDefault();
  createRoom(null, (code) => go(code, '?role=reader'));
});

// One-off packet reading: a MODAQ-lite room (MODAQ reader + buzzer, no
// tournament artifacts), opened straight into the MODAQ page.
$('#create-modaq').addEventListener('click', () => {
  createRoom({ modaqMode: true, modaqLite: true }, (code) => {
    location.href = `/modaq?room=${code}`;
  });
});
