// Klaxon's scoresheet (/r/CODE/score): a moderator or scorekeeper scores the
// game here instead of in MODAQ. The game is kept on the server as it is
// entered (sheet_state, so a reload or a second device picks it up) and sent
// as the same QBJ MODAQ sends (modaq_game live, save_game at the end), so the
// players' scoresheet, the room board, stats and standings work unchanged.
import { staffPlayerId, recall, remember, api, $, el } from './util.js';
import * as M from './scoresheet-model.js';

const code = (location.pathname.split('/')[2] || '').toUpperCase();
const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
const session = () => localStorage.getItem('bz_sessionToken') || '';
const staffToken = () => recall('staffToken:' + code) || '';

let setup = null;        // GET /sheet-setup
let sheet = null;        // the game being scored (null: setting one up)
let view = 'loading';    // setup | game | review
let joined = false;      // the socket is in the room as staff
let dirty = false;       // a change made while not joined, still to send
let roomState = null;    // the room as the server last sent it (who is here)
let saving = false;

$('#use-modaq').href = `/modaq?room=${code}`;
$('#crumb-room').href = `/r/${code}?plain=1`;
$('#crumb-room').textContent = code;
$('#denied-link').href = `/r/${code}`;

// ---- connection ----------------------------------------------------------
function pill(text, cls = '') {
  const p = $('#save-pill');
  p.textContent = text;
  p.className = `pill save-pill ${cls}`;
}

function join() {
  socket.emit('join', {
    roomCode: code, playerId: staffPlayerId(), role: recall('staffRole:' + code) || 'reader',
    name: recall('name') || undefined, staffToken: staffToken() || undefined, sessionToken: session() || undefined,
  }, async (resp) => {
    if (!resp?.ok) return deny(resp?.error === 'no_room' ? `There's no room ${code}.` : 'Could not open the room. Try again.');
    if (resp.staffDenied || !['reader', 'co-reader'].includes(resp.role)) {
      return deny({
        not_logged_in: 'Sign in as a moderator for this tournament, or open the reader link you were given.',
        not_approved: "Your account isn't approved to moderate this tournament yet.",
        not_assigned: "You aren't assigned to a round in this room.",
        not_your_round: "This room is reading a round you aren't assigned to.",
      }[resp.denyReason] || "The scoresheet is for this room's moderator. Open your reader link first.");
    }
    remember('staffRole:' + code, resp.role);
    roomState = resp.state || null;
    joined = true;
    if (!setup) await loadSetup();
    else if (dirty) { dirty = false; pushAll(); }
    else pill(sheet ? 'Saved' : 'Connected', 'ok');
  });
}
socket.on('connect', join);
socket.on('disconnect', () => { joined = false; pill('Offline · reconnecting', 'bad'); });
socket.on('state', (s) => {
  roomState = s;
  if (view === 'setup') markHere();
  if (view === 'game' && sheet) renderProtests();
});
socket.on('staff_revoked', () => deny('You are no longer staff in this room.'));
// The other scorekeeper's device changed the game.
socket.on('sheet_state', ({ sheet: next }) => {
  // Mid-way through typing in a cell: apply it once that's done.
  if (cellEditing && next) { pendingRemote = next; return; }
  sheet = next || null;
  if (!sheet) return showSetup();
  if (sheet.final) return showReview(true);
  if (view === 'review' && M.status(sheet).over) return renderReview();
  showGame();
});

function deny(msg) {
  view = 'denied';
  for (const id of ['#loading', '#setup', '#game', '#review']) $(id).classList.add('hidden');
  $('#denied-msg').textContent = msg;
  $('#denied').classList.remove('hidden');
  pill('Not staff', 'bad');
}

async function loadSetup() {
  try {
    setup = await api('GET', `/api/rooms/${code}/sheet-setup?token=${encodeURIComponent(staffToken())}&sessionToken=${encodeURIComponent(session())}`);
  } catch (e) {
    return deny(e.message === 'forbidden' ? "The scoresheet is for this room's moderator." : `Could not load the room: ${e.message}`);
  }
  $('#loading').classList.add('hidden');
  if (setup.tournament) {
    const c = $('#crumb-tournament');
    c.textContent = setup.tournament.name;
    c.href = `/tp/${setup.tournament.code}?room=${code}`;
    c.classList.remove('hidden');
    $('#crumb-tournament-sep').classList.remove('hidden');
  }
  $('#crumb-room').textContent = setup.room.name || code;
  document.title = `Scoresheet · ${setup.room.name || code}`;
  sheet = setup.sheet || null;
  pill(sheet ? 'Saved' : 'Connected', 'ok');
  if (!sheet) showSetup();
  else if (sheet.final) showReview(true);
  else showGame();
}

// Every change: kept on the server for the next device, and sent on as the
// live game (debounced: a burst of taps is one update).
function changed(next) {
  sheet = next;
  if (view === 'game') renderGame();
  pushAll();
}
let gameTimer = null;
function pushAll() {
  if (!joined) { dirty = true; pill('Offline · kept here, sends on reconnect', 'bad'); return; }
  pill('Saving…');
  socket.emit('reader_action', { action: 'sheet_state', sheet }, (ack) => {
    if (ack?.ok) pill('Saved', 'ok');
    else pill(`Not saved: ${ack?.error || 'error'}`, 'bad');
  });
  clearTimeout(gameTimer);
  gameTimer = setTimeout(sendGame, 300);
}
function sendGame() {
  if (!sheet || sheet.final || !joined) return;
  const st = M.status(sheet);
  socket.emit('reader_action', {
    action: 'modaq_game',
    qbj: M.toQBJ(sheet),
    currentQuestion: st.over ? st.n : st.n + 1,
    hasBonuses: sheet.hasBonuses,
    regulation: sheet.regulation,
    protests: M.gameProtests(sheet),
    lastUpdate: Date.now(),
    export: { round: sheet.round, inProgress: true, regulation: sheet.regulation, atEnd: st.over },
  });
}

// ---- setup ---------------------------------------------------------------
const OTHER = '\u0000other';
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const teamPicks = [null, null];   // per side: { name, players, lineup:Set, typed }

function showSetup() {
  view = 'setup';
  sheet = null;
  for (const id of ['#loading', '#game', '#review', '#denied']) $(id).classList.add('hidden');
  $('#setup').classList.remove('hidden');
  const sel = $('#setup-round');
  const rounds = setup.rounds || [];
  sel.replaceChildren(
    ...rounds.map((r) => el('option', { value: r, textContent: /^\d+$/.test(r) ? `Round ${r}` : r })),
    ...(setup.anyRound || !rounds.length ? [el('option', { value: OTHER, textContent: rounds.length ? 'Another round…' : 'Type the round…' })] : []),
  );
  // The round after the one this room last scored, else the first.
  const last = recall('sheetLastRound:' + code);
  const at = rounds.indexOf(last);
  sel.value = at >= 0 && rounds[at + 1] ? rounds[at + 1] : (rounds[0] ?? OTHER);
  onRound();
}
$('#setup-round').onchange = onRound;

function onRound() {
  const round = $('#setup-round').value;
  $('#setup-round-other').classList.toggle('hidden', round !== OTHER);
  const s = (setup.schedule || []).find((x) => x.round === round && x.teams?.length >= 2);
  const note = $('#setup-schedule');
  note.classList.toggle('hidden', !s);
  const known = (name) => (setup.teams || []).find((t) => t.name === name);
  if (s) {
    note.replaceChildren('The schedule puts ', el('strong', { textContent: s.teams[0] }), ' against ',
      el('strong', { textContent: s.teams[1] }), ' in this room. Check the starting players, then start.');
  }
  for (const side of [0, 1]) {
    const name = s?.teams[side];
    teamPicks[side] = name && known(name) ? pickTeam(known(name)) : (teamPicks[side] || null);
  }
  renderSetupTeams();
}

const pickTeam = (t) => ({ name: t.name, players: [...t.players], lineup: new Set(t.players.slice(0, 4)), typed: false });

function renderSetupTeams() {
  const box = $('#setup-teams');
  box.replaceChildren(...[0, 1].map((side) => {
    const pick = teamPicks[side];
    const teams = setup.teams || [];
    const card = el('section', { className: 'setup-team' });
    card.setAttribute('aria-label', `Team ${side + 1}`);
    const sel = el('select', { id: `setup-team-${side}` },
      el('option', { value: '', textContent: 'Choose a team…' }),
      ...[...teams].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
        .map((t) => el('option', { value: t.name, textContent: t.name })),
      el('option', { value: OTHER, textContent: teams.length ? 'A team not on the roster…' : 'Type the team…' }));
    sel.value = pick ? (pick.typed ? OTHER : pick.name) : '';
    sel.onchange = () => {
      const t = teams.find((x) => x.name === sel.value);
      teamPicks[side] = t ? pickTeam(t) : sel.value === OTHER ? { name: '', players: [], lineup: new Set(), typed: true } : null;
      renderSetupTeams();
    };
    card.append(el('label', { className: 'field' }, 'Team', sel));
    if (!pick) return card;
    if (pick.typed) {
      const name = el('input', { type: 'text', value: pick.name, placeholder: 'Team name', maxLength: 100 });
      name.oninput = () => { pick.name = name.value.trim(); };
      card.append(el('label', { className: 'field' }, 'Team name', name));
    }
    card.append(el('div', { className: 'lineup-head' },
      el('span', { textContent: 'Starting lineup' }), el('span', { textContent: `${pick.lineup.size} playing` })));
    for (const p of pick.players) {
      const box2 = el('input', { type: 'checkbox', checked: pick.lineup.has(p) });
      const row = el('label', { className: 'lineup-row' + (pick.lineup.has(p) ? ' on' : '') },
        box2, el('span', { className: 'who', textContent: p }), el('span', { className: 'note' }));
      row.dataset.player = p;
      box2.onchange = () => { box2.checked ? pick.lineup.add(p) : pick.lineup.delete(p); renderSetupTeams(); };
      card.append(row);
    }
    const add = el('input', { type: 'text', placeholder: 'Add a player', maxLength: 60 });
    add.setAttribute('aria-label', `Add a player to ${pick.name || 'this team'}`);
    const addBtn = el('button', { type: 'button', textContent: 'Add' });
    const doAdd = () => {
      const v = add.value.trim().replace(/\s+/g, ' ');
      if (!v || pick.players.includes(v)) return;
      pick.players.push(v);
      if (pick.lineup.size < 4) pick.lineup.add(v);
      renderSetupTeams();
    };
    addBtn.onclick = doAdd;
    add.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } };
    card.append(el('div', { className: 'row' }, add, addBtn));
    return card;
  }));
  markHere();
}

// Which of these players have a buzzer in the room right now.
function markHere() {
  const here = new Set();
  for (const m of roomState?.members || []) {
    if (m.role !== 'player' || m.connected === false) continue;
    for (const n of [m.rosterPlayer, m.displayName, m.name]) if (n) here.add(norm(n));
  }
  for (const row of document.querySelectorAll('#setup-teams .lineup-row')) {
    const note = row.querySelector('.note');
    const on = here.has(norm(row.dataset.player));
    note.textContent = on ? 'in the room' : '';
    note.classList.toggle('here', on);
  }
}

$('#setup-start').onclick = () => {
  const msg = $('#setup-msg');
  let round = $('#setup-round').value;
  if (round === OTHER) round = $('#setup-round-other').value.trim();
  if (!round) return void (msg.textContent = 'Choose the round.');
  const [a, b] = teamPicks;
  if (!a?.name || !b?.name) return void (msg.textContent = 'Choose both teams.');
  if (norm(a.name) === norm(b.name)) return void (msg.textContent = 'Choose two different teams.');
  if (!a.lineup.size || !b.lineup.size) return void (msg.textContent = 'Each team needs at least one player in its lineup.');
  msg.textContent = '';
  const teams = [a, b].map((t) => ({ name: t.name, players: t.players, lineup: t.players.filter((p) => t.lineup.has(p)) }));
  remember('sheetLastRound:' + code, round);
  const next = M.newSheet({
    round, scheme: setup.format?.tossupScheme, hasBonuses: setup.format?.hasBonuses, regulation: setup.regulation, teams,
  });
  // A new game for the room: the players' scoresheet starts over, and the
  // teams go up so each buzzer is linked to its player.
  socket.emit('reader_action', { action: 'modaq_game', qbj: null });
  socket.emit('reader_action', { action: 'set_modaq_teams', teams: teams.map((t) => ({ name: t.name, players: t.players })) });
  sheet = next;
  showGame();
  pushAll();
};

// ---- the game ------------------------------------------------------------
function showGame() {
  view = 'game';
  for (const id of ['#loading', '#setup', '#review', '#denied']) $(id).classList.add('hidden');
  $('#game').classList.remove('hidden');
  renderGame();
}

const vClass = (v) => (v < 0 ? 'vneg' : v >= 15 ? `v${v === 15 ? 15 : 20}` : '');
const label = (s, i) => (i < s.regulation ? String(i + 1) : `OT${i - s.regulation + 1}`);

function renderGame() {
  const s = sheet;
  const st = M.status(s);
  const t = M.tally(s);
  const ci = M.curIndex(s);

  // Scores.
  const lead = st.scores[0] === st.scores[1] ? -1 : st.scores[0] > st.scores[1] ? 0 : 1;
  $('#sheet-scores').replaceChildren(
    ...s.teams.map((team, i) => el('div', { className: 'score-card' + (lead === i ? ' lead' : '') },
      el('span', { className: 'name', textContent: team.name }), el('span', { className: 'pts', textContent: String(st.scores[i]) }))),
    el('div', { className: 'score-where' },
      el('span', { className: 'k', textContent: /^\d+$/.test(s.round) ? `Round ${s.round}` : s.round }),
      el('span', { className: 'v', textContent: st.over ? 'Final' : st.n < s.regulation ? `Tossup ${st.n + 1} of ${s.regulation}` : `Overtime · tossup ${st.n + 1}` })),
  );

  // The grid.
  const [A, B] = s.teams;
  const cols = `repeat(${A.players.length}, minmax(48px, 1fr)) 52px 58px 56px repeat(${B.players.length}, minmax(48px, 1fr)) 52px 58px`;
  const minW = (A.players.length + B.players.length) * 48 + 52 * 2 + 58 * 2 + 56;
  const grid = $('#sheet-grid');
  grid.style.minWidth = `${minW}px`;
  const row = (cls, ...kids) => { const r = el('div', { className: `g-row ${cls}` }, ...kids); r.style.gridTemplateColumns = cols; return r; };
  const lineupBtn = (ti) => el('button', { type: 'button', textContent: 'Change lineup', onclick: () => openLineup(ti) });
  const teamHead = (ti, right) => {
    const d = el('div', { className: 'g-team' + (right ? ' right' : '') }, el('span', { textContent: s.teams[ti].name }), lineupBtn(ti));
    d.style.gridColumn = `span ${s.teams[ti].players.length + 2}`;
    return d;
  };
  const rows = [row('g-teams', teamHead(0), el('div', { className: 'g-gap' }), teamHead(1, true))];
  const heads = (team) => team.players.map((p) => el('div', {
    className: 'g-c h' + (M.lineupAt(team, ci).includes(p) ? '' : ' out'), textContent: M.shortName(p), title: p,
  }));
  rows.push(row('g-head', ...heads(A), el('div', { className: 'g-c h', textContent: 'Bonus' }), el('div', { className: 'g-c h sep', textContent: 'Total' }),
    el('div', { className: 'g-c h', textContent: 'TU' }),
    ...heads(B), el('div', { className: 'g-c h', textContent: 'Bonus' }), el('div', { className: 'g-c h last', textContent: 'Total' })));
  const shown = Math.max(s.regulation, st.over ? st.n : st.n + 1);
  for (let i = 0; i < shown; i++) {
    const done = i < st.n;
    const isCur = i === ci && !(st.over && s.editing == null);
    const rec = isCur ? { buzzes: s.cur.buzzes, bonus: null } : done ? s.cycles[i] : null;
    const w = rec && !isCur ? M.winnerOf(rec) : null;
    // A finished tossup's cells can be changed by hand: double-click one.
    const editable = done && !isCur;
    const cells = (ti) => s.teams[ti].players.map((p) => {
      const hit = rec?.buzzes.find((b) => b.t === ti && b.p === p);
      const bench = (done || isCur) && !M.lineupAt(s.teams[ti], i).includes(p);
      const cell = el('div', { className: `g-c ${hit ? vClass(hit.v) : ''}${bench && !hit ? ' bench' : ''}${editable ? ' can-edit' : ''}`, textContent: hit ? M.fmt(hit.v) : '' });
      if (editable) cell.ondblclick = () => editCell(cell, { i, t: ti, p, kind: 'player' });
      return cell;
    });
    const bon = (ti) => {
      const mine = editable && w === ti && rec.bonus != null;
      const cell = el('div', { className: `g-c bon${mine ? ' can-edit' : ''}`, textContent: mine ? String(rec.bonus) : '' });
      if (mine) {
        cell.title = `Parts: ${(M.cycleParts(s, rec) || []).map((g, k) => `${k + 1} ${g ? '✓' : '✗'}`).join('  ')} · double-click to change`;
        cell.ondblclick = () => editCell(cell, { i, t: ti, kind: 'bonus' });
      }
      return cell;
    };
    const tot = (ti, last) => el('div', { className: `g-c tot${last ? ' last' : ' sep'}`, textContent: done ? String(t.running[i][ti]) : '' });
    const num = el('button', { type: 'button', className: 'g-num', disabled: !done || isCur || s.cur.buzzes.length > 0 || s.cur.phase !== 'tossup' },
      label(s, i));
    num.setAttribute('aria-label', done ? `Re-enter tossup ${label(s, i)}` : `Tossup ${label(s, i)}`);
    if (done && !isCur && w == null) num.append(el('span', { className: 'dead', textContent: 'dead' }));
    const protested = (s.protests || []).filter((p) => p.cycle === i + 1);
    if (protested.length) {
      num.append(el('span', { className: 'flag', textContent: 'protest' }));
      num.title = protested.map((p) => `${p.team}: ${p.type === 'bonus' ? `bonus part ${p.part}, ` : ''}${p.reason}`).join('\n');
    }
    num.onclick = () => changed(M.edit(sheet, i));
    const numCell = el('div', { className: 'g-c' }, num);
    const cls = [i % 2 ? 'alt' : '', isCur ? (s.editing != null ? 'g-editing' : 'g-cur') : '', i === s.regulation - 1 ? 'g-reg-end' : ''].join(' ');
    rows.push(row(cls, ...cells(0), bon(0), tot(0), numCell, ...cells(1), bon(1), tot(1, true)));
    if (done && s.checks[i + 1]) {
      rows.push(el('div', { className: 'g-check' },
        `Score check after tossup ${i + 1}: ${A.name} ${t.running[i][0]}, ${B.name} ${t.running[i][1]}. Both teams agreed.`));
    }
  }
  const ppb = (ti) => (t.bonus[ti].heard ? `PPB ${(t.bonus[ti].pts / t.bonus[ti].heard).toFixed(1)}` : '');
  const foot = (ti) => s.teams[ti].players.map((p) => el('div', { className: 'g-c tot', textContent: String(t.players[ti][p]?.pts ?? 0) }));
  rows.push(row('g-foot', ...foot(0), el('div', { className: 'g-c h', textContent: ppb(0) }), el('div', { className: 'g-c tot sep', textContent: String(st.scores[0]) }),
    el('div', { className: 'g-c h', textContent: 'Pts' }),
    ...foot(1), el('div', { className: 'g-c h', textContent: ppb(1) }), el('div', { className: 'g-c tot last', textContent: String(st.scores[1]) })));
  grid.replaceChildren(...rows);

  renderPad(st);
  renderProtests();

  // The last few tossups, newest first.
  $('#recent').replaceChildren(...s.cycles.map((c, i) => {
    const parts = c.buzzes.map((b) => `${M.shortName(b.p)} ${M.fmt(b.v)}`);
    const w = M.winnerOf(c);
    const text = (parts.length ? parts.join(', ') : 'Dead') + (w != null && c.bonus != null ? ` · bonus ${c.bonus}` : '');
    return el('li', {}, el('span', { className: 'n', textContent: label(s, i) }), text);
  }).slice(-3).reverse());
}

function renderPad(st) {
  const s = sheet;
  const pad = $('#pad');
  const btn = (text, onclick, cls = '') => el('button', { type: 'button', className: cls, textContent: text, onclick });
  const undoBtn = (text = 'Undo') => btn(text, () => changed(M.undo(sheet)), 'ghost');
  pad.className = 'pad';

  if (M.pendingCheck(s)) {
    pad.classList.add('check');
    pad.replaceChildren(
      el('span', { className: 'pad-kicker', textContent: `Score check · after tossup ${st.n}` }),
      el('span', { className: 'pad-big', textContent: `${s.teams[0].name} ${st.scores[0]}, ${s.teams[1].name} ${st.scores[1]}` }),
      el('span', { textContent: 'Read the score to the room. Both teams agree?' }),
      el('div', { className: 'row' }, btn('Both agree', () => changed(M.agree(sheet)), 'primary'), btn('Fix a tossup', () => changed(M.undo(sheet)))),
    );
    return;
  }
  if (st.over && s.editing == null && s.cur.phase === 'tossup' && !s.cur.buzzes.length) {
    pad.classList.add('end');
    pad.replaceChildren(
      el('span', { className: 'pad-kicker', textContent: 'Game over' }),
      el('span', { className: 'pad-big', textContent: `${s.teams[0].name} ${st.scores[0]}, ${s.teams[1].name} ${st.scores[1]}` }),
      el('div', { className: 'row' }, btn('Review and save', () => showReview(false), 'primary'), undoBtn('Undo the last tossup')),
    );
    return;
  }
  const ci = M.curIndex(s);
  const editing = s.editing != null;
  if (editing) pad.classList.add('editing');
  const title = editing ? `Re-entering tossup ${label(s, ci)}` : ci < s.regulation ? `Tossup ${ci + 1}` : `Overtime tossup ${ci - s.regulation + 1}`;

  if (s.cur.phase === 'bonus') {
    const right = s.cur.buzzes.find((b) => b.v > 0);
    const parts = s.cur.parts || Array(s.bonusParts).fill(false);
    const total = M.partsTotal(s, parts);
    const ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
    pad.replaceChildren(
      el('div', { className: 'pad-head' }, el('h2', { textContent: `Bonus · ${s.teams[right.t].name}` })),
      el('span', { className: 'hint', textContent: `${right.p} got tossup ${label(s, ci)} for ${M.fmt(right.v)}. Mark each part they got.` }),
      el('div', { className: 'bonus-parts' }, ...parts.map((got, k) => {
        const b = el('button', { type: 'button', className: 'bonus-part' + (got ? ' got' : ''), onclick: () => changed(M.togglePart(sheet, k)) },
          el('kbd', { textContent: String(k + 1) }),
          el('span', { className: 'bp-name', textContent: `${ord[k] || `Part ${k + 1}`} part` }),
          el('span', { className: 'bp-mark', textContent: got ? `✓ ${s.partValue}` : '✗ 0' }));
        b.setAttribute('aria-pressed', String(got));
        return b;
      })),
      el('div', { className: 'pad-actions' },
        btn(`Save bonus · ${total}`, () => changed(M.setBonus(sheet)), 'primary bonus-save'),
        undoBtn('Undo the tossup')),
      el('span', { className: 'hint', textContent: `Keys: ${parts.map((_, k) => k + 1).join(', ')} mark a part · Enter saves · 0 clears` }),
    );
    return;
  }

  const sch = M.scheme(s);
  const locked = M.lockedTeams(s);
  const negOk = M.negAllowed(s);
  const negged = s.cur.buzzes.filter((b) => b.v < 0);
  const kids = [el('div', { className: 'pad-head' }, el('h2', { textContent: title }), el('span', { className: 'hint', textContent: 'Who buzzed?' }))];
  if (editing) kids.push(el('span', { className: 'hint', textContent: 'Enter it again from the start. Undo keeps it as it was.' }));
  if (negged.length) {
    const others = s.teams.map((x, i) => i).filter((i) => !locked.has(i)).map((i) => s.teams[i].name);
    kids.push(el('p', { className: 'pad-note', textContent:
      `${negged.map((b) => `${b.p} (${s.teams[b.t].name}) ${M.fmt(b.v)}`).join(', ')}.${others.length ? ` ${others.join(', ')} can still answer.` : ''}` }));
  }
  s.teams.forEach((team, ti) => {
    const off = locked.has(ti);
    const values = [...sch.correct, ...(sch.neg < 0 ? [sch.neg] : [])];
    kids.push(el('div', { className: 'pad-team' },
      el('h3', { textContent: team.name + (off ? ' · locked out' : '') }),
      ...M.lineupAt(team, ci).map((p) => el('div', { className: 'pad-player' },
        el('span', { className: 'who', textContent: p }),
        ...values.map((v) => {
          const b = btn(M.fmt(v), () => changed(M.buzz(sheet, ti, p, v)), vClass(v));
          b.disabled = off || (v < 0 && !negOk);
          b.setAttribute('aria-label', `${p} ${M.fmt(v)}`);
          return b;
        })))));
  });
  kids.push(el('div', { className: 'pad-actions' },
    btn('No one got it', () => changed(M.dead(sheet))),
    undoBtn(editing && !s.cur.buzzes.length ? 'Cancel' : 'Undo'),
    el('span', { className: 'grow' }),
    btn('Protest…', () => openProtest(), 'ghost protest-btn')));
  pad.replaceChildren(...kids);
}

// Bonus keys: 1-3 mark a part, Enter saves, 0 clears. Only while a bonus is
// being entered and nothing else (a text box, a dialog) has the keyboard.
document.addEventListener('keydown', (e) => {
  if (view !== 'game' || !sheet || sheet.cur.phase !== 'bonus') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, dialog')) return;
  const k = Number(e.key);
  if (e.key >= '1' && e.key <= '9' && k <= sheet.bonusParts) { e.preventDefault(); changed(M.togglePart(sheet, k - 1)); }
  else if (e.key === '0') { e.preventDefault(); changed({ ...sheet, cur: { ...sheet.cur, parts: Array(sheet.bonusParts).fill(false) } }); }
  else if (e.key === 'Enter') { e.preventDefault(); changed(M.setBonus(sheet)); }
});

// ---- editing a cell by hand (double-click) -------------------------------
let cellEditing = false;
let pendingRemote = null;
function editCell(cell, { i, t, p, kind }) {
  if (cellEditing) return;
  cellEditing = true;
  const s = sheet;
  const c = s.cycles[i];
  const cur = kind === 'bonus'
    ? (M.cycleParts(s, c) || []).map((g) => (g ? '1' : '0')).join('')
    : (() => { const b = c.buzzes.find((x) => x.t === t && x.p === p); return b ? String(b.v) : ''; })();
  const input = el('input', { type: 'text', value: cur, className: 'cell-input', maxLength: 6 });
  input.setAttribute('aria-label', kind === 'bonus' ? `Bonus on tossup ${label(s, i)}` : `${p} on tossup ${label(s, i)}`);
  input.title = kind === 'bonus'
    ? `Parts as 1s and 0s (101 = first and third), or a total (20). Empty for 0.`
    : `${[...M.scheme(s).correct, ...(M.scheme(s).neg < 0 ? [M.scheme(s).neg] : [])].join(', ')}, or empty`;
  cell.replaceChildren(input);
  cell.classList.add('editing-cell');
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    cellEditing = false;
    if (save) {
      const raw = input.value.trim().replace(/−/g, '-');
      let next = null;
      if (kind === 'bonus') {
        const n = s.bonusParts;
        if (raw === '') next = M.setBonusCell(sheet, i, 0);
        // As many 1s and 0s as there are parts (never a valid total): parts.
        else if (n > 2 && new RegExp(`^[01]{${n}}$`).test(raw)) next = M.setBonusCell(sheet, i, [...raw].map((d) => d === '1'));
        else if (/^\d+$/.test(raw) && Number(raw) % s.partValue === 0 && Number(raw) <= n * s.partValue) next = M.setBonusCell(sheet, i, Number(raw));
      } else {
        const allowed = [...M.scheme(s).correct, ...(M.scheme(s).neg < 0 ? [M.scheme(s).neg] : [])];
        if (raw === '') next = M.setCell(sheet, i, t, p, null);
        else if (/^-?\d+$/.test(raw) && allowed.includes(Number(raw))) next = M.setCell(sheet, i, t, p, Number(raw));
      }
      if (!next) {
        pill(`Not a valid entry: "${input.value}"`, 'bad');
        done = false; cellEditing = true;
        input.classList.add('invalid');
        input.focus();
        return;
      }
      pendingRemote = null;
      return changed(next);
    }
    if (pendingRemote) { const n = pendingRemote; pendingRemote = null; sheet = n; }
    renderGame();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
}

// ---- protests ------------------------------------------------------------
const REASONS = { wrong_answer: 'Answer ruled wrong', wrong_ruling: 'Ruling', misread: 'Misread', prompt: 'Should have been prompted', other: 'Other' };
function openProtest(prefill = {}) {
  const s = sheet;
  const n = s.cycles.length;
  const tossups = Array.from({ length: Math.max(1, n + (s.cur.buzzes.length || s.cur.phase === 'bonus' ? 1 : 0)) }, (_, i) => i);
  const sel = $('#protest-cycle');
  sel.replaceChildren(...tossups.map((i) => el('option', { value: String(i + 1), textContent: `Tossup ${label(s, i)}` })));
  sel.value = String(prefill.cycle ?? Math.max(1, s.cur.buzzes.length || s.cur.phase === 'bonus' ? n + 1 : n));
  $('#protest-team').replaceChildren(...s.teams.map((t) => el('option', { value: t.name, textContent: t.name })));
  if (prefill.team) $('#protest-team').value = prefill.team;
  $('#protest-part').replaceChildren(...Array.from({ length: s.bonusParts }, (_, k) => el('option', { value: String(k + 1), textContent: `Part ${k + 1}` })));
  if (prefill.part) $('#protest-part').value = String(prefill.part);
  const type = prefill.type === 'bonus' ? 'bonus' : 'tossup';
  for (const r of document.querySelectorAll('input[name=protest-type]')) r.checked = r.value === type;
  $('#protest-reason').value = prefill.reason || '';
  $('#protest-msg').textContent = '';
  syncProtestType();
  $('#protest-dlg').showModal();
}
function syncProtestType() {
  const bonus = document.querySelector('input[name=protest-type]:checked')?.value === 'bonus';
  $('#protest-part-row').classList.toggle('hidden', !bonus);
}
for (const r of document.querySelectorAll('input[name=protest-type]')) r.onchange = syncProtestType;
$('#protest-ok').onclick = (e) => {
  if (!$('#protest-reason').value.trim()) { e.preventDefault(); $('#protest-msg').textContent = 'Say what the protest is about.'; }
};
$('#protest-dlg').addEventListener('close', () => {
  if ($('#protest-dlg').returnValue !== 'ok' || !sheet) return;
  const type = document.querySelector('input[name=protest-type]:checked')?.value === 'bonus' ? 'bonus' : 'tossup';
  changed(M.addProtest(sheet, {
    cycle: Number($('#protest-cycle').value), type, team: $('#protest-team').value,
    part: Number($('#protest-part').value), reason: $('#protest-reason').value,
  }));
});

function renderProtests() {
  const s = sheet;
  const box = $('#protests');
  const mine = s.protests || [];
  // Protests players lodged from their own screens that the sheet doesn't have yet.
  const onSheet = (p) => mine.some((m) => m.cycle === p.cycle && m.type === (p.part || 'tossup') && m.team === p.byTeam);
  const lodged = (roomState?.protests || []).filter((p) => ['lodged', 'open'].includes(p.status) && !onSheet(p));
  box.classList.toggle('hidden', !mine.length && !lodged.length);
  $('#protest-list').replaceChildren(
    ...lodged.map((p) => el('li', { className: 'lodged' },
      el('span', { textContent: `${p.byTeam} protests ${p.part === 'bonus' ? 'the bonus on' : ''} tossup ${label(s, p.cycle - 1)}${p.reason ? ` (${REASONS[p.reason] || p.reason})` : ''} · from a player` }),
      el('button', { type: 'button', className: 'tiny', textContent: 'Add to sheet',
        onclick: () => openProtest({ cycle: p.cycle, team: p.byTeam, type: p.part === 'bonus' ? 'bonus' : 'tossup', reason: REASONS[p.reason] || '' }) }))),
    ...mine.map((p, k) => el('li', {},
      el('span', { textContent: `${p.team} · ${p.type === 'bonus' ? `bonus part ${p.part} on ` : ''}tossup ${label(s, p.cycle - 1)} · ${p.reason}` }),
      el('button', { type: 'button', className: 'ghost tiny', textContent: 'Remove', onclick: () => changed(M.removeProtest(sheet, k)) }))),
  );
}

// ---- lineups -------------------------------------------------------------
let lineupTeam = 0;
let lineupPick = null;
function openLineup(ti) {
  lineupTeam = ti;
  const team = sheet.teams[ti];
  lineupPick = { players: [...team.players], on: new Set(M.lineupAt(team, sheet.cycles.length)) };
  $('#lineup-title').textContent = `Change lineup · ${team.name}`;
  $('#lineup-from').textContent = `From tossup ${label(sheet, sheet.cycles.length)} on. Earlier tossups keep their lineup.`;
  $('#lineup-msg').textContent = '';
  renderLineup();
  $('#lineup-dlg').showModal();
}
function renderLineup() {
  $('#lineup-players').replaceChildren(...lineupPick.players.map((p) => {
    const box = el('input', { type: 'checkbox', checked: lineupPick.on.has(p) });
    box.onchange = () => { box.checked ? lineupPick.on.add(p) : lineupPick.on.delete(p); renderLineup(); };
    return el('label', { className: 'lineup-row' + (lineupPick.on.has(p) ? ' on' : '') }, box, el('span', { className: 'who', textContent: p }));
  }));
}
$('#lineup-add-btn').onclick = () => {
  const v = $('#lineup-add').value.trim().replace(/\s+/g, ' ');
  if (!v || lineupPick.players.includes(v)) return;
  lineupPick.players.push(v);
  lineupPick.on.add(v);
  $('#lineup-add').value = '';
  renderLineup();
};
$('#lineup-add').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#lineup-add-btn').click(); } };
$('#lineup-dlg').addEventListener('close', () => {
  if ($('#lineup-dlg').returnValue !== 'ok' || !sheet) return;
  const players = lineupPick.players.filter((p) => lineupPick.on.has(p));
  changed(M.setLineup(sheet, lineupTeam, players));
  // A player added here gets a buzzer link too.
  socket.emit('reader_action', { action: 'set_modaq_teams', teams: sheet.teams.map((t) => ({ name: t.name, players: t.players })) });
});
$('#lineup-ok').onclick = (e) => {
  if (!lineupPick.on.size) { e.preventDefault(); $('#lineup-msg').textContent = 'At least one player has to be in.'; }
};

// ---- review + save -------------------------------------------------------
function showReview(saved) {
  view = 'review';
  for (const id of ['#loading', '#setup', '#game', '#denied']) $(id).classList.add('hidden');
  $('#review').classList.remove('hidden');
  $('#review-saved').classList.toggle('hidden', !saved);
  $('#review-save').classList.toggle('hidden', !!saved);
  $('#review-back').classList.toggle('hidden', !!saved);
  $('#review-msg').textContent = '';
  renderReview();
}
function renderReview() {
  const s = sheet;
  const st = M.status(s);
  const t = M.tally(s);
  $('#review-kicker').textContent = `${/^\d+$/.test(s.round) ? `Round ${s.round}` : s.round} · ${s.final ? 'final' : 'not saved yet'}`;
  $('#review-title').textContent = `${s.teams[0].name} ${st.scores[0]}, ${s.teams[1].name} ${st.scores[1]}`;
  const lead = st.scores[0] === st.scores[1] ? -1 : st.scores[0] > st.scores[1] ? 0 : 1;
  const sch = M.scheme(s);
  const values = [...sch.correct, ...(sch.neg < 0 ? [sch.neg] : [])];
  $('#review-teams').replaceChildren(...s.teams.map((team, ti) => {
    const tuPts = Object.values(t.players[ti]).reduce((a, p) => a + p.pts, 0);
    const table = el('table', { className: 'rt-table' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Player' }), el('th', { textContent: 'TUH' }),
        ...values.map((v) => el('th', { textContent: M.fmt(v) })), el('th', { textContent: 'Pts' }))),
      el('tbody', {}, ...team.players.filter((p) => t.players[ti][p]?.tuh || t.players[ti][p]?.pts).map((p) => {
        const line = t.players[ti][p];
        return el('tr', {}, el('td', { textContent: p }), el('td', { textContent: String(line.tuh) }),
          ...values.map((v) => el('td', { className: v < 0 ? 'n' : v >= 15 ? 'p' : '', textContent: String(line.counts[v] || 0) })),
          el('td', { className: 't', textContent: String(line.pts) }));
      })));
    const foot = el('div', { className: 'rt-foot' },
      el('span', {}, 'Tossup points ', el('strong', { textContent: String(tuPts) })));
    if (s.hasBonuses) {
      foot.append(el('span', {}, 'Bonuses ', el('strong', { textContent: `${t.bonus[ti].pts} on ${t.bonus[ti].heard}` })),
        el('span', {}, 'PPB ', el('strong', { textContent: t.bonus[ti].heard ? (t.bonus[ti].pts / t.bonus[ti].heard).toFixed(1) : '–' })));
    }
    return el('section', { className: 'review-team' + (lead === ti ? ' lead' : '') },
      el('div', { className: 'rt-head' }, el('span', { className: 'name', textContent: team.name }), el('span', { className: 'pts', textContent: String(st.scores[ti]) })),
      el('div', { className: 'rt-scroll' }, table), foot);
  }));
  const deadCount = s.cycles.filter((c) => M.winnerOf(c) == null).length;
  const ot = Math.max(0, st.n - s.regulation);
  const checks = M.checkpoints(s).filter((c) => c <= st.n);
  const agreed = checks.filter((c) => s.checks[c]);
  $('#review-notes').replaceChildren(
    el('li', { textContent: `${st.n} tossups read, ${deadCount ? `${deadCount} dead` : 'none dead'}, ${ot ? `${ot} in overtime` : 'no overtime'}.` }),
    el('li', { textContent: checks.length
      ? `Score checks after tossup ${checks.join(' and ')}: ${agreed.length === checks.length ? 'both teams agreed' : `${agreed.length ? `agreed after ${agreed.join(' and ')} only` : 'not confirmed'}`}.`
      : 'No score checks.' }),
    ...(s.protests?.length
      ? s.protests.map((p) => el('li', { textContent: `Protest: ${p.team} on ${p.type === 'bonus' ? `bonus part ${p.part} of ` : ''}tossup ${label(s, p.cycle - 1)} · ${p.reason}. The director rules on it.` }))
      : [el('li', { textContent: 'No protests.' })]),
  );
}
$('#review-back').onclick = () => showGame();
$('#review-save').onclick = () => {
  if (saving) return;
  if (!joined) { $('#review-msg').textContent = 'Offline. It saves when the connection is back.'; $('#review-msg').className = 'msg bad'; return; }
  saving = true;
  $('#review-save').disabled = true;
  $('#review-msg').textContent = 'Saving…';
  $('#review-msg').className = 'msg';
  const st = M.status(sheet);
  socket.emit('reader_action', {
    action: 'save_game', round: sheet.round, qbj: M.toQBJ(sheet), inProgress: false, currentQuestion: st.n,
  }, (ack) => {
    saving = false;
    $('#review-save').disabled = false;
    if (!ack?.ok) {
      $('#review-msg').textContent = `Not saved: ${ack?.error || 'no answer from the server'}. Try again.`;
      $('#review-msg').className = 'msg bad';
      return;
    }
    sheet = { ...sheet, final: true };
    pushAll();
    showReview(true);
  });
};
$('#review-next').onclick = () => {
  sheet = null;
  socket.emit('reader_action', { action: 'sheet_state', sheet: null });
  socket.emit('reader_action', { action: 'modaq_game', qbj: null });
  showSetup();
};
