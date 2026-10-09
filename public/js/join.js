import { api, $, el, remember } from './util.js';

// /t/CODE/join: the director's moderator invite. Signed out, it sends the
// moderator to /account and back; signed in, it asks the director to approve
// them; approved, it lists the rooms, each opening straight into the reader
// gate's account path (so no reader link is needed).
const code = location.pathname.split('/')[2].toUpperCase();
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
    $('#j-signin-link').href = '/account?return=' + encodeURIComponent(location.pathname);
    return show('#j-signin');
  }
  $('#j-who').textContent = account.username;

  // memberStatus, not status: an open tournament reports everyone as able to
  // read packets, but only a member can moderate without a reader link.
  const { memberStatus } = await api('GET', `/api/tournaments/${code}/access?sessionToken=${encodeURIComponent(s)}`);
  if (memberStatus === 'approved') return showRooms();
  if (memberStatus === 'denied') return show('#j-denied');
  if (memberStatus === 'pending') {
    show('#j-pending');
    pollTimer = setTimeout(render, 10000);
    return;
  }
  show('#j-ask');
}

function showRooms() {
  show('#j-approved');
  const rooms = tournament?.rooms || [];
  $('#j-no-rooms').classList.toggle('hidden', rooms.length > 0);
  $('#j-rooms').replaceChildren(...rooms.map((room) => {
    const a = el('a', { className: 'btnlink tiny primary', href: `/r/${room}` }, 'Read here');
    // The room page joins as reader on an approved account when it finds this.
    a.onclick = () => remember('staffRole:' + room, 'reader');
    const name = tournament?.roomNames?.[room];
    return el('li', {}, el('span', { className: 'pname' }, name ? `${name} · ${room}` : `Room ${room}`), a);
  }));
  // A director adding rooms later shouldn't need a reload here.
  pollTimer = setTimeout(async () => {
    try { tournament = await api('GET', `/api/tournaments/${code}`); } catch { /* keep the old list */ }
    render();
  }, 30000);
}

$('#j-request').onclick = async () => {
  $('#j-request').disabled = true;
  try {
    await api('POST', `/api/tournaments/${code}/access`, { sessionToken: session() });
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
  $('#j-date').textContent = tournament.date ? tournament.date : '';
  document.title = `Moderate ${tournament.name || code} — Klaxon`;
  render();
})();
