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

$('#create-tournament').addEventListener('click', async () => {
  const btn = $('#create-tournament');
  btn.disabled = true;
  try {
    const modaqMode = $('#t-def-modaq-mode').value; // off | lite | full
    const defaults = {
      queueMode: $('#t-def-queue').checked,
      allowWithdraw: $('#t-def-withdraw').checked,
      autoClear: $('#t-def-autoclear').checked,
      modaqMode: modaqMode !== 'off',
      modaqLite: modaqMode === 'lite'
    };
    const format = {
      hasBonuses: $('#fmt-bonuses').checked,
      tossupScheme: $('#fmt-scheme').value
    };
    const r = await api('POST', '/api/tournaments', {
      name: $('#tournament-name').value.trim() || undefined,
      defaults,
      format,
      requireReaderAccounts: $('#t-require-accounts').checked,
      date: $('#t-date').value || undefined,
      listed: $('#t-listed').checked
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
