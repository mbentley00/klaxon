import { recall, playerId, $ } from './util.js';

// A room's settings on a page of their own, for the reader of a MODAQ room:
// the reader page there is MODAQ, and the plain buzzer view (with its own game
// controls) only muddied which page runs the game. Nothing here starts, ends
// or moves a game, and the room stays a MODAQ room.
const code = location.pathname.split('/')[2].toUpperCase();
$('#ro-code').textContent = code;
document.title = `Room options · ${code} — Klaxon`;
// Opened beside the reader: going back is closing this tab, not opening a
// second reader screen on the same game.
$('#ro-back').href = `/modaq?room=${code}`;
if (window.opener) {
  $('#ro-back').textContent = '← Done (back to the reader)';
  $('#ro-back').onclick = (e) => { e.preventDefault(); window.close(); };
}

const role = recall('staffRole:' + code);
const staffToken = recall('staffToken:' + code);
const sessionToken = localStorage.getItem('bz_sessionToken') || '';
const msg = $('#ro-msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

if (!role || !(staffToken || sessionToken)) {
  $('#ro-denied').classList.remove('hidden');
} else {
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  const pill = $('#ro-conn');
  const join = () => socket.emit('join', {
    roomCode: code, playerId: playerId(), role, name: recall('name') || 'Reader',
    staffToken: staffToken || undefined, sessionToken: sessionToken || undefined
  }, (resp) => {
    if (!resp?.ok || resp.staffDenied) {
      $('#ro-denied').classList.remove('hidden');
      return;
    }
    $('#ro-form').classList.remove('hidden');
    $('#ro-links').classList.remove('hidden');
  });
  socket.on('connect', () => { pill.textContent = 'connected'; pill.className = 'pill good'; join(); });
  socket.on('disconnect', () => { pill.textContent = 'reconnecting…'; pill.className = 'pill bad'; });
  socket.on('state', render);

  const set = (options) => socket.emit('reader_action', { action: 'set_options', options }, (r) => {
    if (r?.error) say('Could not change that: ' + r.error, false);
    else say('Saved.');
  });
  $('#ro-queue').onchange = (e) => set({ queueMode: e.target.checked });
  $('#ro-withdraw').onchange = (e) => set({ allowWithdraw: e.target.checked });
  $('#ro-cooldown').onchange = (e) => set({ withdrawCooldown: Number(e.target.value) });
  $('#ro-autoclear').onchange = (e) => set({ autoClear: e.target.checked });
  $('#ro-alerts').onchange = (e) => set({ playerAlerts: e.target.checked });
  $('#ro-team').onchange = (e) => set({ requireTeam: e.target.checked });
  $('#ro-typed').onchange = (e) => set({ typedAnswers: e.target.checked });
  $('#ro-locked').onchange = (e) => set({ lockedAnswers: e.target.checked });
  $('#ro-secs').onchange = (e) => set({ answerSeconds: Number(e.target.value) });
  $('#ro-grace').onchange = (e) => set({ answerGraceSeconds: Number(e.target.value) });
  $('#ro-chat').onchange = (e) => set({ chat: e.target.checked });
  $('#ro-listed').onchange = (e) => set({ listed: e.target.checked });
}

function render(s) {
  const st = s.settings || {};
  const queue = !!st.queueMode;
  const withdraw = !!st.allowWithdraw;
  const typed = !!st.typedAnswers;
  $('#ro-queue').checked = queue;
  $('#ro-withdraw').checked = withdraw;
  $('#ro-withdraw-row').classList.toggle('hidden', !queue);
  const cd = String(st.withdrawCooldown || 0);
  const sel = $('#ro-cooldown');
  if (![...sel.options].some((o) => o.value === cd)) sel.append(new Option(`Free again after ${cd} questions`, cd));
  sel.value = cd;
  $('#ro-cooldown-row').classList.toggle('hidden', !(queue && withdraw));
  // MODAQ clears the buzzer when you rule on the answer; auto-clear is for
  // the plain buzzer in lock-to-first mode only.
  $('#ro-autoclear').checked = !!st.autoClear;
  $('#ro-autoclear-row').classList.toggle('hidden', queue || !!st.modaqMode);
  $('#ro-alerts').checked = st.playerAlerts !== false;
  // A competitor in a shootout is their own team.
  $('#ro-team').checked = !!st.requireTeam;
  $('#ro-players').classList.toggle('hidden', !!st.shootout);
  $('#ro-typed').checked = typed;
  $('#ro-locked').checked = !!st.lockedAnswers;
  $('#ro-locked-row').classList.toggle('hidden', !(typed && queue));
  $('#ro-timing').classList.toggle('hidden', !typed);
  if (document.activeElement !== $('#ro-secs')) $('#ro-secs').value = st.answerSeconds ?? 7;
  if (document.activeElement !== $('#ro-grace')) $('#ro-grace').value = st.answerGraceSeconds ?? 2;
  $('#ro-chat').checked = s.chatOn ?? !!st.shootout;
  $('#ro-listed').checked = !!(s.listed ?? st.listed);

  $('#ro-player-link').value = `${location.origin}/${code}`;
  const co = recall('coReaderToken:' + code);
  $('#ro-coreader-row').classList.toggle('hidden', !co);
  if (co) $('#ro-coreader-link').value = `${location.origin}/r/${code}?role=co-reader&token=${co}`;
  const token = staffToken || co || '';
  $('#ro-log').href = `/api/rooms/${code}/log?token=${encodeURIComponent(token)}`
    + (sessionToken ? `&sessionToken=${encodeURIComponent(sessionToken)}` : '');
}

document.querySelectorAll('.copy-btn').forEach((b) => {
  b.onclick = async () => {
    const input = document.getElementById(b.dataset.target);
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    const old = b.textContent;
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = old; }, 1200);
  };
});
