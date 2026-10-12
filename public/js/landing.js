import { api, remember, recall, $, el } from './util.js';

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Back from the room we just opened: the browser restores this page from its
// back/forward cache exactly as we left it, "Opening as reader…" and all.
// That message was about a navigation that already happened.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) { msg.textContent = ''; msg.className = 'msg'; }
});

// Remember the player's name across sessions.
$('#join-name').value = recall('name') || '';

// Signed in? Label the account link, and refresh the name/settings the account
// carries so a player landing here on a new device gets theirs back.
const sessionToken = localStorage.getItem('bz_sessionToken');
// Whether the session is good (a stale one — the server restarted — isn't).
let signedIn = false;
if (sessionToken) {
  api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(sessionToken)}`)
    .then(({ account }) => {
      signedIn = true;
      $('#account-link').textContent = `Account: ${account.displayName || account.username}`;
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
//
// Only the last day of them: this list is for getting back into the game you
// just stepped out of, and a room you were in last week isn't that — even on
// the rare occasion its code is still live. room.js prunes on the way in too.
const RECENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ago = (ms) => {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ago`;   // nothing older than a day is listed
};

async function showRecentRooms(skip = new Set()) {
  let recent = [];
  try { recent = JSON.parse(recall('recentRooms') || '[]'); } catch { return; }
  const cutoff = Date.now() - RECENT_MAX_AGE_MS;
  recent = recent.filter((r) => r?.code && Number(r.at) > cutoff && !skip.has(r.code));
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
// Rooms this browser created in the last day (create.js records them) that are
// still open, each opening the reader's view: MODAQ, or the reader buzzer.
async function showCreatedRooms() {
  let made = [];
  try { made = JSON.parse(recall('createdRooms') || '[]'); } catch { return []; }
  const cutoff = Date.now() - RECENT_MAX_AGE_MS;
  made = made.filter((r) => r?.code && Number(r.at) > cutoff && recall('staffToken:' + r.code));
  if (!made.length) return [];
  let live = [];
  try {
    live = (await api('GET', `/api/rooms-summary?codes=${made.map((x) => x.code).join(',')}`)).rooms || [];
  } catch { return []; }
  const byCode = new Map(live.map((r) => [r.code, r]));
  const ul = $('#created-list');
  ul.replaceChildren();
  for (const { code: rc, at } of made) {
    const room = byCode.get(rc);
    if (!room) continue;
    const link = el('a', { href: room.modaq ? `/modaq?room=${rc}` : `/r/${rc}?role=reader`, className: 'recent-link' });
    link.append(el('span', { className: 'recent-code' }, rc));
    link.append(el('span', { className: 'recent-name' }, room.name || ''));
    link.append(el('span', { className: 'recent-meta' },
      `${room.players} player${room.players === 1 ? '' : 's'} · created ${ago(at)}`));
    ul.append(el('li', {}, link));
  }
  if (ul.childElementCount) $('#created-section').classList.remove('hidden');
  return [...byCode.keys()];
}
// A room you made is listed there, not again under the rooms you've joined.
showCreatedRooms().then((mine) => showRecentRooms(new Set(mine)));

// Games their hosts put on the board — mostly Discord readings, where being
// findable IS the point. Refreshed while the page is open, because the list is
// a claim about right now: a room with nobody in it is not listed at all.
const PUBLIC_REFRESH_MS = 30000;

function publicMeta(room) {
  const bits = [];
  bits.push(room.players
    ? `${room.players} playing`
    : (room.host ? 'host is setting up' : 'open'));
  if (room.packet) bits.push(`packet ${room.packet.at} of ${room.packet.of}`);
  else if (room.shootout) bits.push('shootout');
  return bits.join(' · ');
}

async function showPublicRooms() {
  let rooms = [];
  try { ({ rooms = [] } = await api('GET', '/api/public-rooms')); } catch { return; }
  const ul = $('#public-list');
  ul.replaceChildren();
  for (const room of rooms) {
    const link = el('a', { href: `/${room.code}`, className: 'recent-link' });
    link.append(el('span', { className: 'recent-code' }, room.code));
    link.append(el('span', { className: 'recent-name' }, room.name));
    link.append(el('span', { className: 'recent-meta' }, publicMeta(room)));
    ul.append(el('li', {}, link));
  }
  $('#public-section').classList.toggle('hidden', !rooms.length);
}
showPublicRooms();
setInterval(() => { if (!document.hidden) showPublicRooms(); }, PUBLIC_REFRESH_MS);

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code) return say('Enter a room code.', false);
  if (name) remember('name', name);
  go(code);
});

