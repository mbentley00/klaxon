import { api, remember, readFileText, $ } from './util.js';

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Default the date to today (local time).
const today = new Date();
$('#t-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

// A tournament with centralized MODAQ packets should default its read links to
// the MODAQ view — so as soon as packets are chosen, pick full MODAQ mode.
$('#t-packet-files').addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length && $('#t-def-modaq-mode').value === 'off') {
    $('#t-def-modaq-mode').value = 'full';
  }
});

// MASSINGER's two settings are noise for the tournaments that don't run it, so
// they only appear once the checkbox is on. They keep their values either way —
// the payload below reads them regardless, and the server ignores them when
// massinger is off.
// The lag only means anything once the questions are being shown at all.
const showQuestionsBox = $('#fmt-show-questions');
const showLag = () => $('#fmt-question-lag-row').classList.toggle('hidden', !showQuestionsBox.checked);
showQuestionsBox.addEventListener('change', showLag);
showLag();

const massingerBox = $('#fmt-massinger');
const showMassingerOptions = () => $('#massinger-options').classList.toggle('hidden', !massingerBox.checked);
massingerBox.addEventListener('change', showMassingerOptions);
showMassingerOptions();

// Teams or a shootout: each shows only its own settings.
const kind = () => document.querySelector('input[name=t-kind]:checked').value;
function showKind() {
  const shootout = kind() === 'shootout';
  for (const el of document.querySelectorAll('.teams-only')) el.classList.toggle('hidden', shootout);
  for (const el of document.querySelectorAll('.shootout-only')) el.classList.toggle('hidden', !shootout);
}
for (const r of document.querySelectorAll('input[name=t-kind]')) r.addEventListener('change', showKind);
if (new URLSearchParams(location.search).get('kind') === 'shootout') {
  document.querySelector('input[name=t-kind][value=shootout]').checked = true;
}
showKind();

// Every room of a shootout tournament is a MODAQ shootout room.
function shootoutDefaults() {
  return {
    modaqMode: true,
    modaqLite: true,
    shootout: true,
    queueMode: true,
    allowWithdraw: $('#so-withdraw').checked,
    typedAnswers: $('#so-typed').checked,
    shootoutCarry: $('#so-carry').checked,
    shootoutAutoAdd: $('#so-autoadd').checked,
    // A Discord evening is half conversation.
    chat: true,
    playerAlerts: true
  };
}

$('#create-tournament').addEventListener('click', async () => {
  const btn = $('#create-tournament');
  btn.disabled = true;
  try {
    if (kind() === 'shootout') return await createShootout();
    const modaqMode = $('#t-def-modaq-mode').value; // off | lite | full
    const defaults = {
      queueMode: $('#t-def-queue').checked,
      allowWithdraw: $('#t-def-withdraw').checked,
      autoClear: $('#t-def-autoclear').checked,
      requireTeam: $('#t-def-require-team').checked,
      rosterJoin: $('#t-def-roster-join').checked,
      playerAlerts: $('#t-def-player-alerts').checked,
      modaqMode: modaqMode !== 'off',
      modaqLite: modaqMode === 'lite'
    };
    const format = {
      hasBonuses: $('#fmt-bonuses').checked,
      tossupScheme: $('#fmt-scheme').value,
      massinger: $('#fmt-massinger').checked,
      massingerTimerSec: Number($('#fmt-massinger-timer').value),
      massingerControl: $('#fmt-massinger-control').value
    };
    const r = await api('POST', '/api/tournaments', {
      name: $('#tournament-name').value.trim() || undefined,
      defaults,
      format,
      requireReaderAccounts: $('#t-require-accounts').checked,
      date: $('#t-date').value || undefined,
      listed: $('#t-listed').checked,
      playerScoresheet: $('#fmt-player-scoresheet').checked,
      scoresheetCategories: $('#fmt-scoresheet-categories').checked,
      buzzPoints: $('#fmt-buzz-points').checked,
      playtest: $('#fmt-playtest').checked,
      showQuestions: $('#fmt-show-questions').checked,
      questionLag: Number($('#fmt-question-lag').value),
      // Signed in, the creator is approved to read in their own tournament.
      sessionToken: localStorage.getItem('bz_sessionToken') || undefined
    });
    remember('directorToken:' + r.code, r.directorToken);

    // Optional roster upload (needs the code + director token we just got).
    const rosterText = await readFileText($('#t-roster-file'));
    if (rosterText) {
      try {
        JSON.parse(rosterText);
        await api('PUT', `/api/tournaments/${r.code}/roster`, { directorToken: r.directorToken, roster: rosterText });
      } catch (err) {
        say(`Tournament ${r.code} created, but the roster was invalid (${err.message}). Re-upload it in the console.`, false);
        return void location.assign('/t/' + r.code);
      }
    }

    // Optional multi-packet upload: one round per file, filename → round label.
    const packetFiles = [...($('#t-packet-files').files || [])];
    let uploaded = 0;
    for (const file of packetFiles) {
      try {
        const packet = JSON.parse(await file.text());
        if (!Array.isArray(packet.tossups)) throw new Error('no tossups');
        const round = file.name.replace(/\.[^.]+$/, '');
        await api('POST', `/api/tournaments/${r.code}/packets`, { directorToken: r.directorToken, round, packet });
        uploaded++;
      } catch { /* skip invalid file */ }
    }
    const note = uploaded ? ` Uploaded ${uploaded} round${uploaded > 1 ? 's' : ''} (hidden until released).` : '';
    say(`Tournament ${r.code} created.${note} Opening director console…`);
    location.href = '/t/' + r.code;
  } catch (err) {
    say('Could not create tournament: ' + err.message, false);
    btn.disabled = false;
  }
});

// A shootout tournament starts with its one room, ready to set up; the
// director adds more rooms from the console if the evening needs them.
async function createShootout() {
  const r = await api('POST', '/api/tournaments', {
    name: $('#tournament-name').value.trim() || undefined,
    defaults: shootoutDefaults(),
    format: { kind: 'shootout', hasBonuses: false },
    date: $('#t-date').value || undefined,
    listed: $('#t-listed').checked,
    sessionToken: localStorage.getItem('bz_sessionToken') || undefined
  });
  remember('directorToken:' + r.code, r.directorToken);
  const room = await api('POST', '/api/rooms', { tournamentCode: r.code, name: 'Shootout' });
  remember('staffToken:' + room.code, room.readerToken);
  remember('coReaderToken:' + room.code, room.coReaderToken);
  say(`Shootout ${r.code} created with room ${room.code}. Opening director console…`);
  location.href = '/t/' + r.code;
}
