import { api, $, el, remember } from './util.js';

// /t/CODE/join: the director's moderator invite. Signed out, it sends the
// moderator to /account and back; signed in, it asks the director to approve
// them; approved, it lists the rooms, each opening straight into the reader
// gate's account path (so no reader link is needed).
const code = location.pathname.split('/')[2].toUpperCase();
// The bye-reader invite (/t/CODE/join?as=bye): a player asking to read on
// their byes, approved for no room until the director assigns one.
const asBye = new URLSearchParams(location.search).get('as') === 'bye';
const session = () => localStorage.getItem('bz_sessionToken');
const STATES = ['#j-signin', '#j-ask', '#j-pending', '#j-denied', '#j-approved'];
const show = (id) => STATES.forEach((s) => $(s).classList.toggle('hidden', s !== id));
const say = (t, ok = true) => { $('#j-msg').textContent = t; $('#j-msg').className = 'msg ' + (ok ? 'good' : 'bad'); };

let tournament = null;
let pollTimer = null;

async function render() {
  clearTimeout(pollTimer);
  const s = session();
  let account = null;
  if (s) {
    try { ({ account } = await api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(s)}`)); }
    catch { localStorage.removeItem('bz_sessionToken'); }
  }
  $('#account-pill').textContent = account ? account.username : 'Log in';
  if (!account) {
    $('#j-signin-link').href = '/account?return=' + encodeURIComponent(location.pathname + location.search);
    return show('#j-signin');
  }
  $('#j-who').textContent = account.username;

  // memberStatus, not status: an open tournament reports everyone as able to
  // read packets, but only a member can moderate without a reader link.
  const access = await api('GET', `/api/tournaments/${code}/access?sessionToken=${encodeURIComponent(s)}`);
  const { memberStatus } = access;
  if (memberStatus === 'approved') return showRooms(access);
  if (memberStatus === 'denied') return show('#j-denied');
  if (memberStatus === 'pending') {
    show('#j-pending');
    pollTimer = setTimeout(render, 10000);
    return;
  }
  show('#j-ask');
}

// "Round 4", or the round's own name when it already says "round"
// ("MASSINGER Round 01"), never "Round MASSINGER Round 01".
const roundName = (r) => (/\bround\b/i.test(String(r)) ? String(r) : `Round ${r}`);
const roomName = (room) => {
  const name = tournament?.roomNames?.[room];
  return name ? `${name} · ${room}` : `Room ${room}`;
};
// The room page joins as reader on an approved account when it finds this.
const readHere = (room) => {
  const a = el('a', { className: 'btnlink tiny primary', href: `/r/${room}` }, 'Read here');
  a.onclick = () => remember('staffRole:' + room, 'reader');
  return a;
};

function showRooms(access) {
  show('#j-approved');
  // Assigned rounds only (a player who reads on their byes): just those.
  const assigned = access?.scope === 'assigned';
  // The bye-reader link, opened by someone who can already read everywhere
  // (most often the director, signed in as themselves): it changes nothing
  // for them, and a page listing every room would look like it had failed.
  const already = $('#j-bye-already');
  already.classList.toggle('hidden', !(asBye && !assigned));
  if (asBye && !assigned) {
    already.textContent = (access?.director
      ? "You're signed in as this tournament's director, "
      : "You're signed in as a full moderator of this tournament, ") +
      'so this bye-reader link doesn\'t change anything: you can still read in every room. ' +
      'To see what a bye reader gets, open the link signed in with a different account.';
  }
  $('#j-approved-full').classList.toggle('hidden', assigned);
  $('#j-approved-assigned').classList.toggle('hidden', !assigned);
  if (assigned) {
    const list = access.assignments || [];
    $('#j-no-rooms').classList.add('hidden');
    $('#j-no-assignments').classList.toggle('hidden', list.length > 0);
    $('#j-rooms').replaceChildren(...list.map((a) =>
      el('li', {}, el('span', { className: 'pname' }, el('strong', {}, roundName(a.round)), ` · ${roomName(a.room)}`), readHere(a.room))));
  } else {
    const rooms = tournament?.rooms || [];
    $('#j-no-assignments').classList.add('hidden');
    $('#j-no-rooms').classList.toggle('hidden', rooms.length > 0);
    $('#j-rooms').replaceChildren(...rooms.map((room) => el('li', {}, el('span', { className: 'pname' }, roomName(room)), readHere(room))));
  }
  // A director adding rooms (or assigning rounds) later shouldn't need a reload here.
  pollTimer = setTimeout(async () => {
    try { tournament = await api('GET', `/api/tournaments/${code}`); } catch { /* keep the old list */ }
    render();
  }, 30000);
}

$('#j-request').onclick = async () => {
  $('#j-request').disabled = true;
  try {
    await api('POST', `/api/tournaments/${code}/access`, { sessionToken: session(), ...(asBye ? { as: 'bye' } : {}) });
    say('');
    render();
  } catch (e) {
    say('Could not send the request: ' + e.message, false);
    $('#j-request').disabled = false;
  }
};

(async () => {
  try {
    tournament = await api('GET', `/api/tournaments/${code}`);
  } catch {
    $('#j-name').textContent = `Tournament ${code}`;
    return say("This tournament doesn't exist, or it has ended. Check the link with the director.", false);
  }
  $('#j-name').textContent = tournament.name || `Tournament ${code}`;
  if (asBye) {
    $('#j-ask-text').textContent = 'Ask the director to let you read during your bye rounds. Once they approve you and give you a round and room, it shows up here.';
    $('#j-request').textContent = 'Request to read on my byes';
  }
  $('#j-date').textContent = tournament.date ? tournament.date : '';
  document.title = `Moderate ${tournament.name || code} — Klaxon`;
  render();
})();
