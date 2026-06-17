import { api, remember, recall, $, } from './util.js';

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
    const body = {
      name: $('#room-name').value.trim() || undefined,
      tournamentCode: $('#room-tournament').value.trim().toUpperCase() || undefined
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

$('#create-tournament').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const defaults = {
      queueMode: $('#t-def-queue').checked,
      allowWithdraw: $('#t-def-withdraw').checked,
      autoClear: $('#t-def-autoclear').checked
    };
    const r = await api('POST', '/api/tournaments', {
      name: $('#tournament-name').value.trim() || undefined,
      defaults
    });
    remember('directorToken:' + r.code, r.directorToken);
    say(`Tournament ${r.code} created. Opening director console…`);
    location.href = '/t/' + r.code;
  } catch (err) {
    say('Could not create tournament: ' + err.message, false);
  }
});
