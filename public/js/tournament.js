import { api, remember, recall, readFileText, $, el } from './util.js';

const code = location.pathname.split('/').pop().toUpperCase();
$('#t-code').textContent = code;

// The director token is minted once at tournament creation and kept locally.
// It's required for every MODAQ management call below.
const directorToken = recall('directorToken:' + code);

// Reader/co-reader tokens are only ever returned at room-creation time, so the
// director console keeps the rooms it created (with their tokens) in local
// storage. The server is still the source of truth for which rooms exist.
const ROOMS_KEY = 'trooms:' + code;
const loadRooms = () => { try { return JSON.parse(recall(ROOMS_KEY) || '[]'); } catch { return []; } };
const saveRooms = (list) => remember(ROOMS_KEY, JSON.stringify(list));

const msg = $('#t-msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Remember every tournament this browser opens (director or not) so the
// landing page and directory can list "your tournaments" without an account.
function rememberVisit(name, date) {
  try {
    const list = JSON.parse(recall('recentTournaments') || '[]').filter((e) => e && e.code !== code);
    list.unshift({ code, name: name || code, date: date || '', at: Date.now() });
    remember('recentTournaments', JSON.stringify(list.slice(0, 20)));
  } catch { /* localStorage may be unavailable */ }
}

async function init() {
  try {
    const t = await api('GET', `/api/tournaments/${code}`);
    $('#t-name').textContent = t.name || '';
    document.title = `${t.name || code} — Klaxon`;
    rememberVisit(t.name, t.date);
    // Merge any rooms that exist server-side but aren't in our local list
    // (created elsewhere): we can still offer the player link for those.
    const known = loadRooms();
    const knownCodes = new Set(known.map((r) => r.code));
    for (const rc of t.rooms || []) {
      if (!knownCodes.has(rc)) known.push({ code: rc, name: '', readerToken: null, coReaderToken: null });
    }
    saveRooms(known);
    initLinks(t);
    initAutoRelease(t);
  } catch {
    say('Tournament not found.', false);
  }
  render();
  initModaq();
  initPublicStats();
  initStructure();
}

// Auto-release: when every room's game in a round is final, the server makes
// the next hidden packet visible without the director clicking anything.
function initAutoRelease(t) {
  const cb = $('#auto-release');
  if (!cb) return;
  cb.checked = t.autoRelease === true;
  cb.onchange = async () => {
    try {
      await api('PUT', `/api/tournaments/${code}/auto-release`, { directorToken, enabled: cb.checked });
      msay(cb.checked
        ? 'Auto-release on: the next packet is released as soon as a round finishes everywhere.'
        : 'Auto-release off.');
    } catch (e) {
      msay('Could not change auto-release: ' + e.message, false);
      cb.checked = !cb.checked;
    }
  };
}

// Player-facing links (schedule + Discord). Anyone sees the current values;
// only the director can save.
function initLinks(t) {
  const sched = $('#link-schedule');
  const disc = $('#link-discord');
  const save = $('#links-save');
  if (!sched || !disc || !save) return;
  sched.value = t.links?.schedule || '';
  disc.value = t.links?.discord || '';
  const lmsg = $('#links-msg');
  if (!directorToken) {
    sched.disabled = disc.disabled = save.disabled = true;
    return;
  }
  save.onclick = async () => {
    try {
      const sent = { schedule: sched.value.trim(), discord: disc.value.trim() };
      const { links } = await api('PUT', `/api/tournaments/${code}/links`, { directorToken, links: sent });
      const rejected = Object.keys(sent).filter((k) => sent[k] && !links[k]);
      sched.value = links.schedule;
      disc.value = links.discord;
      lmsg.textContent = rejected.length
        ? `Saved, but the ${rejected.join(' and ')} link was dropped — links must start with http(s)://`
        : 'Saved. Players see these links in every room.';
      lmsg.className = 'msg ' + (rejected.length ? 'bad' : 'good');
    } catch (e) {
      lmsg.textContent = 'Could not save links: ' + e.message;
      lmsg.className = 'msg bad';
    }
  };
}

// --- Tournament structure editor (phases + divisions), director only -------
let knownTeams = [];
let divisionRows = []; // [{ phase, name, teams:[] }]

function initStructure() {
  const panel = $('#structure-panel');
  if (!panel) return;
  if (!directorToken) { panel.classList.add('hidden'); return; }

  refreshStructure();
  $('#div-add').onclick = () => { divisionRows.push({ phase: '', name: '', teams: [] }); renderDivisions(); };
  $('#phases-text').addEventListener('input', updatePhaseDatalist);
  $('#structure-save').onclick = saveStructure;
}

const smsg = (t, ok = true) => { const m = $('#structure-msg'); m.textContent = t; m.className = 'msg ' + (ok ? 'good' : 'bad'); };

async function refreshStructure() {
  try {
    const { structure, teams } = await api('GET', `/api/tournaments/${code}/structure?directorToken=${qt(directorToken)}`);
    knownTeams = teams || [];
    const phases = structure?.phases || [];
    $('#phases-text').value = phases.map((p) => `${p.name}: ${(p.rounds || []).join(', ')}`).join('\n');
    divisionRows = (structure?.divisions || []).map((d) => ({ phase: d.phase || '', name: d.name || '', teams: d.teams || [] }));
    updatePhaseDatalist();
    renderDivisions();
  } catch { /* ignore */ }
}

function parsePhasesText() {
  return $('#phases-text').value.split('\n').map((line) => {
    const i = line.indexOf(':');
    if (i < 0) return null;
    const name = line.slice(0, i).trim();
    const rounds = line.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean);
    return name ? { name, rounds } : null;
  }).filter(Boolean);
}

function updatePhaseDatalist() {
  const dl = $('#phase-names');
  if (!dl) return;
  dl.innerHTML = '';
  for (const p of parsePhasesText()) dl.append(el('option', { value: p.name }));
}

function renderDivisions() {
  $('#div-count').textContent = divisionRows.length ? `(${divisionRows.length})` : '';
  const wrap = $('#div-rows');
  wrap.innerHTML = '';
  divisionRows.forEach((row, idx) => {
    const box = el('div', { className: 'modaq-block' });
    const line = el('div', { className: 'sound-row' });
    const phase = el('input', { placeholder: 'Phase', value: row.phase, list: 'phase-names' });
    phase.style.maxWidth = '140px';
    phase.oninput = (e) => { row.phase = e.target.value; };
    const name = el('input', { placeholder: 'Division / tier name', value: row.name });
    name.oninput = (e) => { row.name = e.target.value; };
    const remove = el('button', { className: 'tiny ghost' }, 'Remove');
    remove.onclick = () => { divisionRows.splice(idx, 1); renderDivisions(); };
    line.append(phase, name, remove);
    box.append(line);
    // Team multiselect from known teams.
    const sel = el('select', { multiple: true, size: Math.min(6, Math.max(3, knownTeams.length)) });
    sel.style.width = '100%';
    for (const t of knownTeams) {
      const opt = el('option', { value: t }, t);
      if (row.teams.includes(t)) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => { row.teams = [...sel.selectedOptions].map((o) => o.value); };
    box.append(el('p', { className: 'hint' }, knownTeams.length ? 'Ctrl/Cmd-click to select this division\'s teams:' : 'No teams have played yet.'));
    box.append(sel);
    wrap.append(box);
  });
}

async function saveStructure() {
  const structure = { phases: parsePhasesText(), divisions: divisionRows.filter((d) => d.name.trim()) };
  try {
    await api('PUT', `/api/tournaments/${code}/structure`, { directorToken, structure });
    smsg('Structure saved. Stats will now group by phase and division.');
  } catch (e) { smsg('Could not save structure: ' + e.message, false); }
}

// Public stats link + YellowFruit download — no director token required to view.
function initPublicStats() {
  const link = `${location.origin}/t/${code}/stats`;
  const input = $('#stats-link');
  if (input) input.value = link;
  const open = $('#stats-open');
  if (open) open.href = link;
  const copy = $('#stats-copy');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link); } catch { input.select(); document.execCommand('copy'); }
    const o = copy.textContent; copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = o; }, 1200);
  };
  const dl = $('#stats-download');
  if (dl) dl.onclick = () => { window.location = `/t/${code}/stats.zip`; };

  // Games in progress: which rooms are still playing, the score, where they are
  // in the packet, and how long they've been going. Public data; refreshes live.
  refreshLive();
  setInterval(refreshLive, 15000);
}

async function refreshLive() {
  try {
    const { games, now } = await api('GET', `/api/tournaments/${code}/live`);
    $('#live-count').textContent = games.length ? `(${games.length})` : '';
    $('#live-empty').classList.toggle('hidden', games.length > 0);
    const ul = $('#live-list');
    ul.innerHTML = '';
    for (const g of games) {
      const li = el('li', {});
      const col = el('span', { className: 'pcol' });
      const score = [...g.teams].sort((a, b) => b.total - a.total).map((t) => `${t.name} ${t.total}`).join(', ');
      col.append(el('span', { className: 'pname' }, `Round ${g.round} · ${score}`));
      const bits = [];
      if (g.currentQuestion) bits.push(`on question ${g.currentQuestion}${g.tuh ? ` of ${g.tuh}` : ''}`);
      if (g.startedAt) bits.push(`running ${Math.max(0, Math.round((now - g.startedAt) / 60000))} min`);
      if (g.room) bits.push(`room ${g.room}`);
      col.append(el('span', { className: 'pjoined' }, bits.join(' · ')));
      li.append(col);
      ul.append(li);
    }
  } catch { /* stats may not exist yet; leave the panel as-is */ }
}

// --- MODAQ management (director only) --------------------------------------
const mmsg = $('#modaq-msg');
const msay = (t, ok = true) => { mmsg.textContent = t; mmsg.className = 'msg ' + (ok ? 'good' : 'bad'); };
const qt = (s) => encodeURIComponent(s);

function initModaq() {
  const panel = $('#modaq-panel');
  if (!panel) return;
  if (!directorToken) {
    // Without the director token this browser can't manage MODAQ artifacts.
    panel.querySelector('.hint').textContent =
      'MODAQ management is only available in the browser that created this tournament (it holds the director token).';
    panel.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
    return;
  }
  refreshRoster();
  refreshPackets();
  refreshExports();
  refreshErrata();
  refreshProtests();
  $('#protests-refresh').onclick = refreshProtests;

  $('#roster-upload').onclick = async () => {
    const text = await readFileText($('#roster-file'));
    if (!text) return msay('Choose a roster file first.', false);
    try {
      JSON.parse(text);
      await api('PUT', `/api/tournaments/${code}/roster`, { directorToken, roster: text });
      msay('Roster uploaded.');
      refreshRoster();
    } catch (e) { msay('Roster upload failed: ' + e.message, false); }
  };

  $('#packet-upload').onclick = async () => {
    const files = [...($('#packet-files').files || [])];
    if (!files.length) return msay('Choose one or more packet JSON files first.', false);
    const tiebreaker = $('#packet-tiebreaker').checked;
    let ok = 0;
    for (const file of files) {
      try {
        const packet = JSON.parse(await file.text());
        if (!Array.isArray(packet.tossups)) throw new Error('no tossups');
        const round = file.name.replace(/\.[^.]+$/, '');
        await api('POST', `/api/tournaments/${code}/packets`, { directorToken, round, packet, tiebreaker });
        ok++;
      } catch { /* skip bad file */ }
    }
    const kind = tiebreaker ? ' tiebreaker' : '';
    msay(ok ? `Uploaded ${ok}${kind} round${ok > 1 ? 's' : ''} (hidden until you make them visible).` : 'No valid packets found.', ok > 0);
    $('#packet-files').value = '';
    $('#packet-tiebreaker').checked = false;
    refreshPackets();
  };

  $('#yf-import').onclick = async () => {
    const text = await readFileText($('#yf-file'));
    if (!text) return msay('Choose your YellowFruit (.yft) file first.', false);
    try {
      const yft = JSON.parse(text);
      const { updated, added } = await api('POST', `/api/tournaments/${code}/yf-import`, { directorToken, yft });
      msay(`YellowFruit import: ${updated} game${updated === 1 ? '' : 's'} updated, ${added} added.`);
      $('#yf-file').value = '';
      refreshExports();
      refreshProtests();
    } catch (e) { msay('YellowFruit import failed: ' + e.message, false); }
  };

  $('#exports-refresh').onclick = refreshExports;
  $('#errata-refresh').onclick = refreshErrata;
  $('#tb-refresh').onclick = refreshTiebreakers;
  refreshTiebreakers();
  $('#members-refresh').onclick = refreshMembers;
  $('#member-add').onclick = async () => {
    const identifier = $('#member-add-id').value.trim();
    if (!identifier) return msay('Enter the email or username of a registered account.', false);
    try {
      const { member } = await api('POST', `/api/tournaments/${code}/members`, { directorToken, identifier });
      msay(`${member.username} added as an approved moderator.`);
      $('#member-add-id').value = '';
      refreshMembers();
    } catch (e) {
      msay(e.message === 'account_not_found'
        ? 'No registered account with that email or username — ask them to create one at /account first.'
        : 'Could not add moderator: ' + e.message, false);
    }
  };
  refreshMembers();
  setInterval(refreshMembers, 20000);
  $('#exports-download-all').onclick = () => {
    // The endpoint sets Content-Disposition, so navigating to it downloads the file.
    window.location = `/api/tournaments/${code}/stats?directorToken=${qt(directorToken)}`;
  };

  // Stats sync live from moderators, so keep the exports + errata + protest
  // lists fresh without the director having to click Refresh. Packets refresh
  // too, so an auto-release shows up in the list and on the release button.
  setInterval(() => { refreshExports(); refreshErrata(); refreshProtests(); refreshPackets(); }, 15000);
}

async function refreshRoster() {
  try {
    const { roster } = await api('GET', `/api/tournaments/${code}/roster?directorToken=${qt(directorToken)}`);
    $('#roster-status').textContent = roster ? '· uploaded' : '· none yet';
  } catch { /* leave as-is */ }
}

async function refreshPackets() {
  try {
    const { packets } = await api('GET', `/api/tournaments/${code}/packets?directorToken=${qt(directorToken)}`);
    const visibleCount = packets.filter((p) => p.visible).length;
    $('#packets-count').textContent = packets.length ? `(${visibleCount}/${packets.length} visible)` : '';
    updateReleaseNext(packets);
    const ul = $('#packets-list');
    ul.innerHTML = '';
    if (!packets.length) { ul.append(el('li', { className: 'empty' }, 'No round packets yet')); return; }
    for (const p of packets) {
      const li = el('li', {});
      const nameWrap = el('span', { className: 'pname' });
      nameWrap.append(document.createTextNode(`Round ${p.round}`));
      if (p.tiebreaker) nameWrap.append(el('span', { className: 'offline-badge' }, 'TB'));
      li.append(nameWrap);
      const controls = el('span', { className: 'sound-row' });
      controls.append(packetToggle(p, 'visibility', 'visible', 'Visible'));
      controls.append(packetToggle(p, 'tiebreaker', 'tiebreaker', 'Tiebreaker'));
      li.append(controls);
      ul.append(li);
    }
  } catch { /* ignore */ }
}

// One-click release of the next round: the button always names exactly which
// packet it will make visible to moderators, so mid-tournament it's a single
// unambiguous action.
function updateReleaseNext(packets) {
  const btn = $('#release-next');
  if (!btn) return;
  const unreleased = packets.filter((p) => !p.visible && !p.tiebreaker);
  unreleased.sort((a, b) => {
    const na = Number(a.round), nb = Number(b.round);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.round).localeCompare(String(b.round));
  });
  const next = unreleased[0];
  if (!next) {
    btn.disabled = true;
    btn.textContent = packets.some((p) => !p.tiebreaker) ? 'All packets released' : 'Release next packet';
    return;
  }
  btn.disabled = false;
  btn.textContent = `Release "Round ${next.round}" packet`;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('PUT', `/api/tournaments/${code}/packets/${qt(next.round)}/visibility`, { directorToken, visible: true });
      msay(`Released the Round ${next.round} packet — moderators can load it now.`);
      refreshPackets();
      refreshTiebreakers();
    } catch (e) {
      msay('Could not release: ' + e.message, false);
      btn.disabled = false;
    }
  };
}

// A labeled checkbox that flips one flag (visibility/tiebreaker) on a round.
function packetToggle(p, endpoint, flag, label) {
  const toggle = el('label', { className: 'toggle' });
  const cb = el('input', { type: 'checkbox' });
  cb.checked = !!p[flag];
  cb.onchange = async () => {
    try {
      await api('PUT', `/api/tournaments/${code}/packets/${qt(p.round)}/${endpoint}`, { directorToken, [flag]: cb.checked });
      refreshPackets();
      refreshTiebreakers();
    } catch (e) { msay(`Could not change ${label.toLowerCase()}: ` + e.message, false); cb.checked = !cb.checked; }
  };
  toggle.append(cb, document.createTextNode(' ' + label));
  return toggle;
}

async function refreshMembers() {
  try {
    const { members } = await api('GET', `/api/tournaments/${code}/members?directorToken=${qt(directorToken)}`);
    const pending = members.filter((m) => m.status === 'pending').length;
    $('#members-count').textContent = members.length ? `(${pending} pending / ${members.length})` : '';
    $('#members-empty').classList.toggle('hidden', members.length > 0);
    const ul = $('#members-list');
    ul.innerHTML = '';
    // Pending first.
    const order = { pending: 0, approved: 1, denied: 2 };
    for (const m of [...members].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3))) {
      const li = el('li', { className: m.status === 'denied' ? 'gone' : '' });
      const col = el('span', { className: 'pcol' });
      col.append(el('span', { className: 'pname' }, m.username));
      col.append(el('span', { className: 'pjoined' }, `Status: ${m.status}`));
      li.append(col);
      const actions = el('span', { className: 'sound-row' });
      const setStatus = async (status) => {
        try { await api('PUT', `/api/tournaments/${code}/members/${m.accountId}`, { directorToken, status }); refreshMembers(); }
        catch (e) { msay('Could not update account: ' + e.message, false); }
      };
      if (m.status !== 'approved') actions.append(mkBtn('Approve', 'tiny primary', () => setStatus('approved')));
      if (m.status !== 'denied') actions.append(mkBtn('Deny', 'tiny ghost', () => setStatus('denied')));
      li.append(actions);
      ul.append(li);
    }
  } catch { /* ignore */ }
}
function mkBtn(text, className, onclick) {
  const b = el('button', { className }, text);
  b.onclick = onclick;
  return b;
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\(\*\)/g, '').replace(/\s+/g, ' ').trim();

async function refreshTiebreakers() {
  try {
    const { tossups, usage } = await api('GET', `/api/tournaments/${code}/tiebreakers?directorToken=${qt(directorToken)}`);
    $('#tb-count').textContent = tossups.length ? `(${tossups.length} questions)` : '';
    $('#tb-empty').classList.toggle('hidden', tossups.length > 0);
    // Which teams heard each tiebreaker question.
    const heard = new Map();
    for (const u of usage) {
      const key = `${u.tbRound}|${u.questionNumber}`;
      if (!heard.has(key)) heard.set(key, { teams: new Set(), where: [] });
      const h = heard.get(key);
      (u.teams || []).forEach((t) => h.teams.add(t));
      h.where.push(`Room ${u.room} · R${u.gameRound}`);
    }
    const ul = $('#tb-list');
    ul.innerHTML = '';
    for (const tu of tossups) {
      const h = heard.get(`${tu.round}|${tu.questionNumber}`);
      const li = el('li', { className: h ? 'gone' : '' });
      const col = el('span', { className: 'pcol' });
      col.append(el('span', { className: 'pname' }, `${tu.round} #${tu.questionNumber}: ${stripHtml(tu.question).slice(0, 70)}…`));
      col.append(el('span', { className: 'pjoined' },
        h ? `Heard by: ${[...h.teams].join(', ')}  (${h.where.join('; ')})` : 'Unused'));
      li.append(col);
      ul.append(li);
    }
  } catch { /* ignore */ }
}

async function refreshExports() {
  try {
    const { exports } = await api('GET', `/api/tournaments/${code}/exports?directorToken=${qt(directorToken)}`);
    $('#exports-count').textContent = exports.length ? `(${exports.length})` : '';
    $('#exports-empty').classList.toggle('hidden', exports.length > 0);
    const ul = $('#exports-list');
    ul.innerHTML = '';
    for (const x of exports) {
      const li = el('li', {});
      li.append(el('span', { className: 'pcol' },
        el('span', { className: 'pname' }, x.filename),
        el('span', { className: 'pjoined' }, `${(x.size / 1024).toFixed(1)} KB · ${new Date(x.savedAt).toLocaleString()}`)));
      const url = `/api/tournaments/${code}/exports/${qt(x.filename)}?directorToken=${qt(directorToken)}`;
      li.append(el('a', { className: 'btnlink tiny', href: url, download: x.filename }, 'Download'));
      ul.append(li);
    }
  } catch { /* ignore */ }
}

async function refreshErrata() {
  try {
    const { errata } = await api('GET', `/api/tournaments/${code}/errata?directorToken=${qt(directorToken)}`);
    $('#errata-count').textContent = errata.length ? `(${errata.length})` : '';
    $('#errata-empty').classList.toggle('hidden', errata.length > 0);
    const ul = $('#errata-list');
    ul.innerHTML = '';
    // Newest first, grouped visually by the room/round that reported them.
    for (const e of [...errata].sort((a, b) => (b.at || 0) - (a.at || 0))) {
      const li = el('li', { className: e.thrownOut ? 'gone' : '' });
      const col = el('span', { className: 'pcol' });
      col.append(el('span', { className: 'pname' },
        `${e.questionType === 'bonus' ? 'Bonus' : 'Tossup'} ${e.questionNumber} — Round ${e.round} · Room ${e.room}`));
      const detail = `${e.thrownOut ? 'THROWN OUT. ' : ''}${e.text || ''}`.trim();
      if (detail) col.append(el('span', { className: 'pjoined' }, detail));
      li.append(col);
      ul.append(li);
    }
  } catch { /* ignore */ }
}

async function refreshProtests() {
  try {
    const { protests } = await api('GET', `/api/tournaments/${code}/protests?directorToken=${qt(directorToken)}`);
    const open = protests.filter((p) => p.status === 'pending' || p.status === 'matters').length;
    $('#protests-count').textContent = protests.length ? `(${open} open / ${protests.length})` : '';
    $('#protests-empty').classList.toggle('hidden', protests.length > 0);
    const ul = $('#protests-list');
    ul.innerHTML = '';
    const statusLabel = {
      pending: 'game in progress', matters: 'COULD CHANGE RESULT', moot: 'moot',
      upheld: 'UPHELD', denied: 'denied',
    };
    for (const p of protests) {
      const settled = p.status === 'moot' || p.status === 'denied';
      const li = el('li', { className: settled ? 'gone' : '' });
      const col = el('span', { className: 'pcol' });
      const what = p.type === 'bonus' ? `Bonus ${p.question}${p.part ? ` part ${p.part}` : ''}` : `Tossup ${p.question}`;
      const nameRow = el('span', { className: 'pname-wrap' });
      nameRow.append(el('span', { className: 'pname' }, `${what} — Round ${p.round} · Room ${p.room} · ${p.team}`));
      if (p.status === 'matters') nameRow.append(el('span', { className: 'offline-badge' }, 'DECIDES GAME'));
      col.append(nameRow);
      const score = p.teams.map((t) => `${t.name} ${t.total}`).join(', ');
      let detail = `${statusLabel[p.status] || p.status} · ${score}${p.reason ? ` · "${p.reason}"` : ''}`;
      if (p.ruling) {
        const adj = (p.ruling.adjustments || []).map((a) => `${a.points > 0 ? '+' : ''}${a.points} ${a.team}`).join(', ');
        detail = `${statusLabel[p.status]}${adj ? ` (${adj})` : ''}${p.ruling.note ? ` · "${p.ruling.note}"` : ''} · ${score}`;
      }
      col.append(el('span', { className: 'pjoined' }, detail));
      li.append(col);
      // Ruling controls: rule an open protest, or clear an existing ruling.
      const actions = el('span', { className: 'sound-row' });
      if (p.ruling) {
        actions.append(mkBtn('Clear ruling', 'tiny ghost', () => ruleProtest(p, null, '', [])));
      } else if (!p.live) {
        actions.append(mkBtn('Rule…', 'tiny primary', () => toggleRuleForm(li, p)));
      }
      li.append(actions);
      ul.append(li);
    }
  } catch { /* ignore */ }
}

// Inline ruling form: per-team point adjustments (applied only on Uphold, as a
// score correction to that game in stats) plus an optional note.
function toggleRuleForm(li, p) {
  const existing = li.querySelector('.rule-form');
  if (existing) { existing.remove(); return; }
  const form = el('div', { className: 'sound-row rule-form' });
  const inputs = p.teams.map((t) => {
    const inp = el('input', { type: 'number', value: '0' });
    inp.style.width = '64px';
    const wrap = el('label', { className: 'vol' });
    wrap.append(document.createTextNode(t.name + ' '), inp);
    form.append(wrap);
    return { name: t.name, inp };
  });
  const note = el('input', { placeholder: 'Ruling note (optional)' });
  form.append(note);
  form.append(mkBtn('Uphold', 'tiny primary', () => ruleProtest(p, 'upheld', note.value,
    inputs.map((x) => ({ team: x.name, points: Number(x.inp.value) || 0 })))));
  form.append(mkBtn('Deny', 'tiny ghost', () => ruleProtest(p, 'denied', note.value, [])));
  // Stack the form under the protest text rather than beside the buttons.
  (li.querySelector('.pcol') || li).append(form);
}

async function ruleProtest(p, status, note, adjustments) {
  try {
    await api('PUT', `/api/tournaments/${code}/protests/ruling`, {
      directorToken,
      room: p.room, round: p.round, type: p.type, question: p.question, part: p.part, team: p.team,
      status, note, adjustments,
    });
    msay(status == null ? 'Ruling cleared — the protest is open again.'
      : status === 'upheld' ? 'Protest upheld — the score correction is live in the stats.'
        : 'Protest denied.');
    refreshProtests();
  } catch (e) { msay('Could not save ruling: ' + e.message, false); }
}

$('#add-rooms').onclick = async () => {
  const base = $('#room-base').value.trim() || 'Room'; // default -> "Room 1", "Room 2", …
  const qty = Math.max(1, Math.min(50, parseInt($('#room-qty').value, 10) || 1));
  $('#add-rooms').disabled = true;
  say(`Creating ${qty} room${qty > 1 ? 's' : ''}…`);
  const rooms = loadRooms();
  const startIndex = rooms.length;
  try {
    for (let i = 0; i < qty; i++) {
      const name = `${base} ${startIndex + i + 1}`;
      const r = await api('POST', '/api/rooms', { tournamentCode: code, name });
      rooms.push({ code: r.code, name: r.name, readerToken: r.readerToken, coReaderToken: r.coReaderToken });
      saveRooms(rooms);          // persist incrementally so nothing is lost
      render();
    }
    say(`Added ${qty} room${qty > 1 ? 's' : ''}.`);
  } catch (e) {
    say('Error creating rooms: ' + e.message, false);
  }
  $('#add-rooms').disabled = false;
};

function linkRow(label, url) {
  const row = el('div', { className: 'copy-field link-row' });
  const input = el('input', { readOnly: true, value: url });
  const copy = el('button', { className: 'ghost tiny' }, 'Copy');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand('copy'); }
    const o = copy.textContent; copy.textContent = 'Copied!'; setTimeout(() => { copy.textContent = o; }, 1200);
  };
  const open = el('a', { className: 'btnlink tiny', href: url, target: '_blank', rel: 'noopener' }, 'Open');
  row.append(el('span', { className: 'link-label' }, label), input, copy, open);
  return row;
}

// ---- bulk copy (spreadsheet) ----
function roomLinks(r) {
  const o = location.origin;
  return {
    code: r.code,
    name: r.name || '',
    player: `${o}/r/${r.code}`,
    reader: r.readerToken ? `${o}/r/${r.code}?role=reader&token=${r.readerToken}` : '',
    coreader: r.coReaderToken ? `${o}/r/${r.code}?role=co-reader&token=${r.coReaderToken}` : ''
  };
}
const TSV_COLS = [['code', 'Room'], ['name', 'Name'], ['player', 'Player link'], ['reader', 'Reader link'], ['coreader', 'Co-reader link']];
function tsvTable() {
  const rooms = loadRooms().map(roomLinks);
  const head = $('#tsv-header').checked ? TSV_COLS.map((c) => c[1]).join('\t') + '\n' : '';
  return head + rooms.map((r) => TSV_COLS.map((c) => r[c[0]]).join('\t')).join('\n');
}
const tsvColumn = (field) => loadRooms().map(roomLinks).map((r) => r[field]).join('\n');

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = $('#tsv-preview'); ta.value = text; ta.select(); document.execCommand('copy'); }
  const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = o; }, 1200);
}
$('#copy-table').onclick = (e) => copyText(tsvTable(), e.currentTarget);
$('#copy-players').onclick = (e) => copyText(tsvColumn('player'), e.currentTarget);
$('#copy-readers').onclick = (e) => copyText(tsvColumn('reader'), e.currentTarget);
$('#copy-coreaders').onclick = (e) => copyText(tsvColumn('coreader'), e.currentTarget);
$('#tsv-header').onchange = renderBulk;
function renderBulk() {
  const has = loadRooms().length > 0;
  $('#bulk-panel').classList.toggle('hidden', !has);
  if (has) $('#tsv-preview').value = tsvTable();
}

function render() {
  renderBulk();
  const rooms = loadRooms();
  $('#room-count').textContent = rooms.length ? `(${rooms.length})` : '';
  $('#rooms-empty').classList.toggle('hidden', rooms.length > 0);
  const wrap = $('#rooms-list');
  wrap.innerHTML = '';
  const origin = location.origin;
  rooms.forEach((r) => {
    const card = el('div', { className: 'room-item' });
    card.append(el('div', { className: 'room-item-head' },
      el('span', { className: 'room-code' }, r.code),
      el('span', { className: 'room-name' }, r.name || '')));
    card.append(linkRow('Players', `${origin}/r/${r.code}`));
    if (r.readerToken) card.append(linkRow('Reader', `${origin}/r/${r.code}?role=reader&token=${r.readerToken}`));
    if (r.coReaderToken) card.append(linkRow('Co-reader', `${origin}/r/${r.code}?role=co-reader&token=${r.coReaderToken}`));
    wrap.append(card);
  });
}

init();
