import { api, remember, $ } from './util.js';

// Advanced room creation: the options the simplified home page leaves out.
const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Auto-clear only applies in lock-to-first mode, and "withdraw" only in queue
// mode — mirror the room's own Game options panel so the form can't lie.
const queue = $('#opt-queue');
function syncQueueRows() {
  $('#opt-withdraw-row').classList.toggle('hidden', !queue.checked);
  $('#opt-autoclear-row').classList.toggle('hidden', queue.checked);
}
queue.addEventListener('change', syncQueueRows);
syncQueueRows();

$('#create-room').onclick = async () => {
  try {
    const modaqMode = $('#room-modaq-mode').value; // off | lite | full
    const settings = {
      queueMode: queue.checked,
      allowWithdraw: queue.checked && $('#opt-withdraw').checked,
      autoClear: !queue.checked && $('#opt-autoclear').checked,
      requireTeam: $('#opt-require-team').checked,
      playerAlerts: $('#opt-player-alerts').checked,
      modaqMode: modaqMode !== 'off',
      modaqLite: modaqMode === 'lite'
    };
    const r = await api('POST', '/api/rooms', {
      name: $('#room-name').value.trim() || undefined,
      tournamentCode: $('#room-tournament').value.trim().toUpperCase() || undefined,
      settings
    });
    // Persist the capabilities for this room: the reader token authorizes us as
    // reader; the co-reader token is kept so the room UI can build invite links.
    remember('staffToken:' + r.code, r.readerToken);
    remember('coReaderToken:' + r.code, r.coReaderToken);
    say(`Created room ${r.code}. Opening as reader…`);
    location.href = `/r/${r.code}?role=reader`;
  } catch (err) {
    say('Could not create room: ' + err.message, false);
  }
};
