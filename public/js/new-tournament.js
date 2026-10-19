import { api, remember, recall, readFileText, $ } from './util.js';
import { parseSpreadsheet, toStoredRoster } from './roster-parse.js';

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// A roster pasted from a registration spreadsheet: read as it's pasted, so
// what will be saved is on screen before Create.
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let pastedTeams = [];
function readRosterPaste() {
  const text = $('#t-roster-paste').value;
  const note = $('#t-roster-paste-note');
  if (!text.trim()) { pastedTeams = []; note.textContent = ''; return; }
  const { teams, skipped } = parseSpreadsheet(text);
  pastedTeams = teams;
  if (!teams.length) {
    note.textContent = "Couldn't find any teams there. Copy whole rows, with the header row (Team Name, Player 1, …).";
    return;
  }
  const players = teams.reduce((n, t) => n + t.players.length, 0);
  const unnamed = teams.filter((t) => t.placeholder).length;
  const names = teams.map((t) => t.name);
  note.textContent = `Found ${plural(teams.length, 'team')} (${plural(players, 'player')}): `
    + (names.length > 8 ? names.slice(0, 8).join(', ') + `, and ${names.length - 8} more` : names.join(', ')) + '.'
    + (skipped ? ` Skipped ${plural(skipped, 'row')} with no players.` : '')
    + (unnamed ? ` ${unnamed} had no team name and got a placeholder; fix it in the director console.` : '');
}
$('#t-roster-paste').addEventListener('input', readRosterPaste);

$('#tournament-name').addEventListener('input', (e) => {
  e.target.classList.remove('invalid');
  if (msg.textContent === 'Give the tournament a name.') say('');
});

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
  // A team tournament's packets are for approved readers by default; a
  // shootout is usually its director reading alone. Until someone sets it.
  const acct = $('#t-require-accounts');
  if (!acct.dataset.touched) acct.checked = !shootout;
}
$('#t-require-accounts').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
for (const r of document.querySelectorAll('input[name=t-kind]')) r.addEventListener('change', showKind);
if (new URLSearchParams(location.search).get('kind') === 'shootout') {
  document.querySelector('input[name=t-kind][value=shootout]').checked = true;
}
showKind();

// The withdraw rule, as the room settings it comes down to (the same four the
// shootout's own setup offers; see shootout.withdrawSettings on the server).
const withdrawMode = () => document.querySelector('input[name=so-withdraw]:checked').value;
const showCooldown = () => $('#so-cooldown-row').classList.toggle('hidden', withdrawMode() !== 'rationed');
for (const r of document.querySelectorAll('input[name=so-withdraw]')) r.addEventListener('change', showCooldown);
showCooldown();
function withdrawDefaults() {
  const mode = withdrawMode();
  if (mode === 'none') return { allowWithdraw: false, lockedAnswers: false, withdrawCooldown: 0 };
  if (mode === 'typed') return { allowWithdraw: true, lockedAnswers: true, withdrawCooldown: 0 };
  if (mode === 'rationed') {
    return { allowWithdraw: true, lockedAnswers: false, withdrawCooldown: Math.max(1, Math.min(40, Number($('#so-cooldown').value) || 5)) };
  }
  return { allowWithdraw: true, lockedAnswers: false, withdrawCooldown: 0 };
}

// Every room of a shootout tournament is a MODAQ shootout room.
function shootoutDefaults() {
  const wd = withdrawDefaults();
  return {
    modaqMode: true,
    modaqLite: true,
    shootout: true,
    queueMode: true,
    ...wd,
    // Committing an answer is typing it.
    typedAnswers: $('#so-typed').checked || wd.lockedAnswers,
    shootoutCarry: $('#so-carry').checked,
    shootoutAutoAdd: $('#so-autoadd').checked,
    // A Discord evening is half conversation.
    chat: true,
    playerAlerts: true
  };
}

// --- editing an existing tournament (/new-tournament?edit=CODE) --------------
// The same form, filled in from the tournament, saving what is safe to change
// (see PATCH /api/tournaments/:code/settings for what that is and why).
const editCode = (new URLSearchParams(location.search).get('edit') || '').toUpperCase() || null;
let editToken = null;
let gamesPlayed = 0;
let loadedScoring = '';
const scoringNow = () => kind() === 'shootout'
  ? `${$('#so-scheme').value}|${$('#so-bonuses').checked}`
  : `${$('#fmt-scheme').value}|${$('#fmt-bonuses').checked}`;

async function directorTokenFor(code) {
  const kept = recall('directorToken:' + code);
  if (kept) return kept;
  // On another device, a signed-in director's account brings it (as in the console).
  const s = localStorage.getItem('bz_sessionToken');
  if (!s) return null;
  try {
    const { tournaments } = await api('GET', `/api/accounts/me/tournaments?sessionToken=${encodeURIComponent(s)}`);
    const mine = tournaments.find((x) => x.code === code && x.directorToken);
    if (mine) remember('directorToken:' + code, mine.directorToken);
    return mine?.directorToken || null;
  } catch { return null; }
}

async function startEditing() {
  const btn = $('#create-tournament');
  btn.disabled = true;
  document.title = 'Tournament settings — Klaxon';
  $('#page-title').textContent = 'Tournament settings';
  document.querySelector('.crumb[aria-current]').textContent = 'Settings';
  for (const x of document.querySelectorAll('.create-only')) x.classList.add('hidden');
  btn.textContent = 'Save changes';
  const cancel = $('#edit-cancel');
  cancel.href = '/t/' + editCode;
  cancel.classList.remove('hidden');

  editToken = await directorTokenFor(editCode);
  if (!editToken) return say(`Only ${editCode}'s director can change its settings. Open it from the browser that created it, or sign in to the account that did.`, false);
  let t;
  try { t = await api('GET', `/api/tournaments/${editCode}`); } catch (e) { return say('Could not load the tournament: ' + e.message, false); }
  try {
    const { exports } = await api('GET', `/api/tournaments/${editCode}/exports?directorToken=${encodeURIComponent(editToken)}`);
    gamesPlayed = exports.length;
  } catch { /* the warning is a courtesy */ }

  // Teams vs shootout is fixed once the tournament exists.
  const shootout = t.format?.kind === 'shootout';
  document.querySelector(`input[name=t-kind][value=${shootout ? 'shootout' : 'teams'}]`).checked = true;
  for (const r of document.querySelectorAll('input[name=t-kind]')) r.disabled = true;
  showKind();
  // After showKind, which would otherwise show the roster again.
  for (const x of document.querySelectorAll('.create-only')) x.classList.add('hidden');

  const d = t.defaults || {}, f = t.format || {};
  $('#tournament-name').value = t.name || '';
  $('#t-date').value = t.date || '';
  $('#t-listed').checked = t.listed === true;
  $('#t-require-accounts').checked = t.requireReaderAccounts === true;
  $('#t-require-accounts').dataset.touched = '1';
  if (shootout) {
    $('#so-carry').checked = d.shootoutCarry === true;
    $('#so-autoadd').checked = d.shootoutAutoAdd !== false;
    $('#so-typed').checked = d.typedAnswers === true;
    const mode = d.lockedAnswers ? 'typed' : d.allowWithdraw === false ? 'none' : d.withdrawCooldown > 0 ? 'rationed' : 'free';
    document.querySelector(`input[name=so-withdraw][value=${mode}]`).checked = true;
    if (d.withdrawCooldown > 0) $('#so-cooldown').value = d.withdrawCooldown;
    showCooldown();
    $('#so-scheme').value = f.tossupScheme || '15/10/-5';
    $('#so-bonuses').checked = f.hasBonuses === true;
    $('#so-notes').value = f.notes || '';
  } else {
    $('#fmt-scheme').value = f.tossupScheme || '15/10/-5';
    $('#fmt-bonuses').checked = f.hasBonuses !== false;
    $('#fmt-player-scoresheet').checked = t.playerScoresheet !== false;
    $('#fmt-scoresheet-categories').checked = t.scoresheetCategories === true;
    $('#fmt-show-questions').checked = t.showQuestions === true;
    $('#fmt-question-lag').value = t.questionLag ?? 2;
    showLag();
    $('#fmt-buzz-points').checked = t.buzzPoints === true;
    $('#fmt-massinger').checked = f.massinger === true;
    $('#fmt-massinger-timer').value = f.massingerTimerSec ?? 30;
    $('#fmt-massinger-control').value = f.massingerControl || 'captain';
    showMassingerOptions();
    $('#t-def-modaq-mode').value = !d.modaqMode ? 'off' : d.modaqLite ? 'lite' : 'full';
    $('#t-def-queue').checked = d.queueMode === true;
    $('#t-def-withdraw').checked = d.allowWithdraw === true;
    $('#t-def-autoclear').checked = d.autoClear === true;
    $('#t-def-require-team').checked = d.requireTeam === true;
    $('#t-def-roster-join').checked = d.rosterJoin === true;
    $('#t-def-player-alerts').checked = d.playerAlerts !== false;
  }
  loadedScoring = scoringNow();

  const rooms = t.rooms?.length || 0;
  $('#edit-note').textContent = `${t.code} · ${shootout ? 'Shootout' : 'Teams'} (can't be changed).`
    + ' Display and buzz-recording changes reach every room at once. Scoring applies to games started after you save.'
    + (rooms ? ` Room settings apply to rooms you add from now on; the ${rooms} existing room${rooms === 1 ? ' keeps' : 's keep'} their own.` : '')
    + ' Packets and the roster are in the director console.';
  $('#edit-note').classList.remove('hidden');
  $('#defaults-legend').textContent = 'Rooms added from now on start with';
  btn.disabled = false;
}

async function saveEdits() {
  if (gamesPlayed && scoringNow() !== loadedScoring
    && !confirm(`${gamesPlayed} game${gamesPlayed === 1 ? ' has' : 's have'} already been scored. They keep the format they were read with; only games started from now on use the new scoring.\n\nSave the new scoring?`)) {
    return;
  }
  const body = {
    directorToken: editToken,
    name: $('#tournament-name').value.trim(),
    date: $('#t-date').value,
    listed: $('#t-listed').checked,
    requireReaderAccounts: $('#t-require-accounts').checked
  };
  if (kind() === 'shootout') {
    body.defaults = shootoutDefaults();
    body.format = { tossupScheme: $('#so-scheme').value, hasBonuses: $('#so-bonuses').checked, notes: $('#so-notes').value };
  } else {
    Object.assign(body, teamSettings());
  }
  await api('PATCH', `/api/tournaments/${editCode}/settings`, body);
  say('Saved. Opening the director console…');
  location.href = '/t/' + editCode;
}

// What a team tournament's form says, shared by Create and Save.
function teamSettings() {
  const modaqMode = $('#t-def-modaq-mode').value; // off | lite | full
  return {
    defaults: {
      queueMode: $('#t-def-queue').checked,
      allowWithdraw: $('#t-def-withdraw').checked,
      autoClear: $('#t-def-autoclear').checked,
      requireTeam: $('#t-def-require-team').checked,
      rosterJoin: $('#t-def-roster-join').checked,
      playerAlerts: $('#t-def-player-alerts').checked,
      modaqMode: modaqMode !== 'off',
      modaqLite: modaqMode === 'lite'
    },
    format: {
      hasBonuses: $('#fmt-bonuses').checked,
      tossupScheme: $('#fmt-scheme').value,
      massinger: $('#fmt-massinger').checked,
      massingerTimerSec: Number($('#fmt-massinger-timer').value),
      massingerControl: $('#fmt-massinger-control').value
    },
    playerScoresheet: $('#fmt-player-scoresheet').checked,
    scoresheetCategories: $('#fmt-scoresheet-categories').checked,
    buzzPoints: $('#fmt-buzz-points').checked,
    showQuestions: $('#fmt-show-questions').checked,
    questionLag: Number($('#fmt-question-lag').value)
  };
}

if (editCode) startEditing();

$('#create-tournament').addEventListener('click', async () => {
  const btn = $('#create-tournament');
  const nameBox = $('#tournament-name');
  if (!nameBox.value.trim()) {
    nameBox.classList.add('invalid');
    nameBox.focus();
    nameBox.scrollIntoView({ block: 'center' });
    return say('Give the tournament a name.', false);
  }
  btn.disabled = true;
  if (editCode) {
    try { await saveEdits(); } catch (err) { say('Could not save: ' + err.message, false); }
    btn.disabled = false;
    return;
  }
  try {
    if (kind() === 'shootout') return await createShootout();
    const r = await api('POST', '/api/tournaments', {
      name: $('#tournament-name').value.trim() || undefined,
      ...teamSettings(),
      requireReaderAccounts: $('#t-require-accounts').checked,
      date: $('#t-date').value || undefined,
      listed: $('#t-listed').checked,
      playtest: $('#fmt-playtest').checked,
      // Signed in, the creator is approved to read in their own tournament.
      sessionToken: localStorage.getItem('bz_sessionToken') || undefined
    });
    remember('directorToken:' + r.code, r.directorToken);

    // Optional roster upload (needs the code + director token we just got).
    // A file wins over a paste: it's the more deliberate of the two.
    const rosterText = (await readFileText($('#t-roster-file')))
      || (pastedTeams.length ? toStoredRoster($('#tournament-name').value, pastedTeams) : '');
    if (rosterText) {
      try {
        JSON.parse(rosterText);
        await api('PUT', `/api/tournaments/${r.code}/roster`, { directorToken: r.directorToken, roster: rosterText });
      } catch (err) {
        say(`Tournament ${r.code} created, but the roster was invalid (${err.message}). Re-upload it in the console.`, false);
        return void location.assign('/t/' + r.code);
      }
    }

    const uploaded = await uploadPackets(r);
    const note = uploaded ? ` Uploaded ${uploaded} round${uploaded > 1 ? 's' : ''} (hidden until released).` : '';
    say(`Tournament ${r.code} created.${note} Opening director console…`);
    location.href = '/t/' + r.code;
  } catch (err) {
    say('Could not create tournament: ' + err.message, false);
    btn.disabled = false;
  }
});

// Optional multi-packet upload: one round per file, filename → round label.
async function uploadPackets(r) {
  let uploaded = 0;
  for (const file of [...($('#t-packet-files').files || [])]) {
    try {
      const packet = JSON.parse(await file.text());
      if (!Array.isArray(packet.tossups)) throw new Error('no tossups');
      const round = file.name.replace(/\.[^.]+$/, '');
      await api('POST', `/api/tournaments/${r.code}/packets`, { directorToken: r.directorToken, round, packet });
      uploaded++;
    } catch { /* skip invalid file */ }
  }
  return uploaded;
}

// A shootout tournament starts with its one room; the director adds more
// rooms from the console if the evening needs them. Everything a room would
// otherwise set up for itself (packets, scoring, the withdraw rule, notes) is
// the director's, here and in the console.
async function createShootout() {
  const r = await api('POST', '/api/tournaments', {
    name: $('#tournament-name').value.trim() || undefined,
    defaults: shootoutDefaults(),
    format: {
      kind: 'shootout',
      tossupScheme: $('#so-scheme').value,
      hasBonuses: $('#so-bonuses').checked,
      notes: $('#so-notes').value
    },
    requireReaderAccounts: $('#t-require-accounts').checked,
    date: $('#t-date').value || undefined,
    listed: $('#t-listed').checked,
    sessionToken: localStorage.getItem('bz_sessionToken') || undefined
  });
  remember('directorToken:' + r.code, r.directorToken);
  const uploaded = await uploadPackets(r);
  const room = await api('POST', '/api/rooms', { tournamentCode: r.code, name: 'Shootout' });
  remember('staffToken:' + room.code, room.readerToken);
  remember('coReaderToken:' + room.code, room.coReaderToken);
  const note = uploaded ? ` Uploaded ${uploaded} packet${uploaded > 1 ? 's' : ''}, ready for the rooms.` : '';
  say(`Shootout ${r.code} created with room ${room.code}.${note} Opening director console…`);
  location.href = '/t/' + r.code;
}
