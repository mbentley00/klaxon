import { api, remember, recall, $ } from './util.js';

// Creating a room: MODAQ or not, teams or a shootout, and the options those
// choices imply. A room is one game at a time; several rounds are a tournament.
const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Back from the room we just opened: the browser restores this page from its
// back/forward cache exactly as we left it, "Opening as reader…" and all.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) { msg.textContent = ''; msg.className = 'msg'; }
});

const useModaq = $('#use-modaq');
const queue = $('#opt-queue');
const withdraw = $('#opt-withdraw');
const typed = $('#opt-typed');
const format = () => document.querySelector('input[name=format]:checked').value;

// What each choice turns on before the reader touches anything. A shootout is
// the Discord setup: a queue (with several people racing, the order is the
// interesting part), withdrawing (a reaction buzz should cost nothing), and
// typed answers (twenty people saying answers over voice is noise).
function preset() {
  const shootout = format() === 'shootout';
  queue.checked = shootout;
  withdraw.checked = shootout;
  typed.checked = shootout;
  $('#opt-require-team').checked = !shootout;
  $('#opt-locked').checked = false;
  chatDefault();
  sync();
}

// A shootout read with MODAQ gets a chat: it's the Discord setup, where the
// room talks in text. Off otherwise. Once the reader sets it, it stays theirs.
const chat = $('#opt-chat');
chat.addEventListener('change', () => { chat.dataset.touched = '1'; });
function chatDefault() {
  if (!chat.dataset.touched) chat.checked = format() === 'shootout' && useModaq.checked;
}
useModaq.addEventListener('change', chatDefault);

// Show only the options that mean something for the choices made, so the form
// can't promise what the room won't do.
function sync() {
  const shootout = format() === 'shootout';
  $('#opt-withdraw-row').classList.toggle('hidden', !queue.checked);
  $('#opt-cooldown-row').classList.toggle('hidden', !(queue.checked && withdraw.checked));
  // MODAQ clears the buzzer when you rule on the answer.
  $('#opt-autoclear-row').classList.toggle('hidden', queue.checked || useModaq.checked);
  // A competitor in a shootout is their own team.
  $('#players-group').classList.toggle('hidden', shootout);
  $('#opt-locked-row').classList.toggle('hidden', !(typed.checked && queue.checked));
  // Evening totals come from MODAQ's scoresheet; a shootout carries its own.
  $('#opt-evening-set').classList.toggle('hidden', shootout || !useModaq.checked);
  $('#no-account-warn').classList.toggle('hidden', !useModaq.checked || signedIn);
}

for (const r of document.querySelectorAll('input[name=format]')) r.addEventListener('change', preset);
for (const c of [useModaq, queue, withdraw, typed]) c.addEventListener('change', sync);

// A MODAQ game is kept on the server (see /games), but a logged-out reader
// can only get it back from this browser: say so before the room exists.
let signedIn = false;
const sessionToken = localStorage.getItem('bz_sessionToken');
if (sessionToken) {
  api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(sessionToken)}`)
    .then(() => { signedIn = true; sync(); })
    .catch(() => {});
}
if (new URLSearchParams(location.search).get('format') === 'shootout') {
  document.querySelector('input[name=format][value=shootout]').checked = true;
}
preset();

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shootout = format() === 'shootout';
  const modaq = useModaq.checked;
  const q = queue.checked;
  try {
    const settings = {
      modaqMode: modaq,
      modaqLite: modaq,
      shootout,
      queueMode: q,
      allowWithdraw: q && withdraw.checked,
      withdrawCooldown: q && withdraw.checked ? Number($('#opt-cooldown').value) : 0,
      autoClear: !q && !modaq && $('#opt-autoclear').checked,
      requireTeam: !shootout && $('#opt-require-team').checked,
      playerAlerts: $('#opt-player-alerts').checked,
      typedAnswers: typed.checked,
      lockedAnswers: typed.checked && q && $('#opt-locked').checked,
      listed: $('#opt-listed').checked,
      chat: $('#opt-chat').checked,
      // A shootout's leaderboard is its own evening total (shootoutCarry).
      eveningTotals: modaq && !shootout && $('#opt-evening').checked
    };
    const r = await api('POST', '/api/rooms', { name: $('#room-name').value.trim() || undefined, settings });
    // The reader token authorizes us as reader; the co-reader token is kept so
    // the room UI can build invite links.
    remember('staffToken:' + r.code, r.readerToken);
    remember('coReaderToken:' + r.code, r.coReaderToken);
    // The home page lists the rooms made here in the last day, so a reader who
    // closed the tab can get back to the game (see landing.js).
    try {
      const day = Date.now() - 24 * 60 * 60 * 1000;
      const made = JSON.parse(recall('createdRooms') || '[]').filter((x) => x?.code && Number(x.at) > day);
      made.unshift({ code: r.code, at: Date.now() });
      remember('createdRooms', JSON.stringify(made.slice(0, 8)));
    } catch { remember('createdRooms', JSON.stringify([{ code: r.code, at: Date.now() }])); }
    say(`Created room ${r.code}. Opening as reader…`);
    location.href = modaq ? `/modaq?room=${r.code}` : `/r/${r.code}?role=reader`;
  } catch (err) {
    say('Could not create room: ' + err.message, false);
  }
});

