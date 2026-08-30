import { api, remember, recall, $ } from './util.js';

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
