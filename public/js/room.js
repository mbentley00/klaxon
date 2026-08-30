import { ClockSync } from './clocksync.js';
import { playerId, remember, recall, forget, api, readFileText, $, el } from './util.js';

const code = location.pathname.split('/').pop().toUpperCase();
const params = new URLSearchParams(location.search);
const urlRole = params.get('role');     // 'reader' | 'co-reader' | null
const urlToken = params.get('token');   // staff invite token (optional)

const STAFF = new Set(['reader', 'co-reader']);
const isStaffRole = (r) => STAFF.has(r);

// A staff invite link carries role (+ token, for joining from another device).
// Capture it, then scrub the token from the address bar.
if (isStaffRole(urlRole)) {
  remember('staffRole:' + code, urlRole);
  if (urlToken) {
    remember('staffToken:' + code, urlToken);
    history.replaceState(null, '', `/r/${code}`);
  }
}

const state = { me: null, role: null, snapshot: null, tournament: null, offlineIds: null, soundedCycle: null };

// ---- connect ----
const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
const clock = new ClockSync(socket);

const connPill = $('#conn');
const latPill = $('#latency');
$('#room-code').textContent = code;

socket.on('connect', () => {
  setConn('sync', 'syncing…');
  // Decide what to show IMMEDIATELY — don't block on clock sync. (Awaiting the
  // sync first is what caused the join screen to flash before the reader view.)
  maybeAutoJoin();
  // Measure clock offset / RTT in the background (needed for fair buzzing).
  clock.sync(9)
    .then(() => { latPill.textContent = `~${Math.round(clock.rtt)}ms`; setConn('online', 'connected'); })
    .catch(() => setConn('online', 'connected'));
});

socket.on('disconnect', () => setConn('offline', 'reconnecting…'));
socket.io.on('reconnect_attempt', () => setConn('offline', 'reconnecting…'));

// Server RTT probes — answer immediately so the server can measure us. Two
// channels (a routine probe and one the server fires right after a buzz) let it
// cross-check for clients that stall latency packets to cheat the buzz clamp.
const ackNow = (_p, ack) => { if (typeof ack === 'function') ack(); };
socket.on('srv_ping', ackNow);
socket.on('rtt_echo', ackNow);

// Removed by the reader: drop our identity and return home.
socket.on('kicked', () => {
  forget('joined:' + code); forget('role:' + code);
  state.role = null; state.me = null;
  alert('You were removed from this room by the reader.');
  location.href = '/';
});

function setConn(cls, text) {
  connPill.className = 'pill ' + cls;
  connPill.textContent = text;
}

// Auto-join returning users / staff with a token; otherwise show the name gate.
function maybeAutoJoin() {
  if (state.role) return doJoin(state.role, state.me?.name, state.me?.team);
  const staffRole = recall('staffRole:' + code);
  if (staffRole && recall('staffToken:' + code)) {
    const name = recall('name');
    if (name) return doJoin(staffRole, name);  // never default the name to "Reader"
    return showGate('staff', staffRole);       // ask the reader for their name first
  }
  if (recall('joined:' + code)) return doJoin(recall('role:' + code) || 'player', recall('name'), recall('team'));
  showGate('player');
}

// Room settings the JOIN GATE needs before anyone has joined (currently just
// "require team name"). Fetched once, best-effort: if it fails the server still
// enforces the rule on join.
let roomInfo = null;
async function loadRoomInfo() {
  if (!roomInfo) {
    try { roomInfo = await api('GET', `/api/rooms/${code}`); } catch { roomInfo = {}; }
  }
  return roomInfo;
}
function applyTeamRequirement(required) {
  const team = $('#gate-team');
  team.placeholder = required ? 'Team name (required)' : 'Team (optional)';
  team.required = !!required;
}

// ---- roster join ----
// When the room hands out a roster, players identify themselves from it rather
// than typing: their buzzes then carry the roster name from the first press,
// with nothing for the moderator to link up by hand. "Not on the roster" is
// always offered — subs exist — and tells the director someone new turned up.
const NOT_ON_ROSTER = '\u0000other';

function renderRosterGate(info) {
  const wrap = $('#gate-roster');
  const roster = info?.roster;
  const on = !!info?.rosterJoin && !!roster?.teams?.length;
  wrap.classList.toggle('hidden', !on);
  if (!on) return false;

  const teamSel = $('#gate-roster-team');
  teamSel.replaceChildren(
    el('option', { value: '', textContent: 'Choose your team…' }),
    ...roster.teams.map((t) => el('option', { value: t.name, textContent: t.name })),
    el('option', { value: NOT_ON_ROSTER, textContent: "My team isn't listed" })
  );
  const remembered = recall('team');
  if (remembered && roster.teams.some((t) => t.name === remembered)) teamSel.value = remembered;

  const fillPlayers = () => {
    const team = roster.teams.find((t) => t.name === teamSel.value);
    const playerSel = $('#gate-roster-player');
    playerSel.replaceChildren(
      el('option', { value: '', textContent: team ? 'Choose your name…' : 'Pick a team first' }),
      ...(team?.players || []).map((p) => el('option', {
        value: p.name,
        textContent: p.taken ? `${p.name} (already buzzing)` : p.name
      })),
      el('option', { value: NOT_ON_ROSTER, textContent: "I'm not on the roster" })
    );
    const mine = recall('name');
    if (mine && team?.players.some((p) => p.name === mine)) playerSel.value = mine;
    updateRosterGate();
  };
  teamSel.onchange = fillPlayers;
  $('#gate-roster-player').onchange = updateRosterGate;
  fillPlayers();
  return true;
}

// Typing a name is only for people who said they aren't on the roster.
function updateRosterGate() {
  const usingRoster = !$('#gate-roster').classList.contains('hidden');
  if (!usingRoster) return;
  const teamSel = $('#gate-roster-team');
  const playerSel = $('#gate-roster-player');
  const custom = teamSel.value === NOT_ON_ROSTER || playerSel.value === NOT_ON_ROSTER;
  $('#gate-name').classList.toggle('hidden', !custom);
  $('#gate-team').classList.toggle('hidden', teamSel.value !== NOT_ON_ROSTER);
  $('#gate-name').placeholder = 'Your name';
  $('#gate-msg').textContent = custom
    ? "You'll join as a guest and the tournament director will be told you're not on the roster."
    : '';
}

// What the gate should send: either a roster identity or a typed name.
function rosterGateChoice() {
  if ($('#gate-roster').classList.contains('hidden')) return null;
  const team = $('#gate-roster-team').value;
  const player = $('#gate-roster-player').value;
  if (team === '' || player === '') return { error: 'incomplete' };
  if (team === NOT_ON_ROSTER || player === NOT_ON_ROSTER) {
    return { offRoster: true, team: team === NOT_ON_ROSTER ? $('#gate-team').value.trim() : team };
  }
  return { rosterTeam: team, rosterPlayer: player };
}

function showGate(mode, staffRole) {
  $('#loading').classList.add('hidden');
  const gate = $('#gate');
  gate.classList.remove('hidden');
  gate.dataset.mode = mode;
  if (staffRole) gate.dataset.staffRole = staffRole;
  $('#gate-name').value = recall('name') || '';
  $('#gate-team').value = recall('team') || '';
  const staff = mode === 'staff';
  $('#gate-title').textContent = staff ? `Read room ${code}` : `Join ${code}`;
  // Readers don't need a name — it's never shown in the player list. Players do.
  $('#gate-name').placeholder = staff ? 'Your name (optional)' : 'Your name';
  $('#gate-team').classList.toggle('hidden', staff);
  $('#gate-spectate').classList.toggle('hidden', staff);
  $('#gate-join').textContent = staff ? 'Start reading' : 'Join as player';
  // Approved tournament moderators can read via their account, no link needed.
  $('#gate-mod').classList.toggle('hidden', staff);
  $('#gate-mod').textContent = localStorage.getItem('bz_sessionToken')
    ? 'Moderator? Start reading'
    : 'Moderator? Sign in to read';
  $('#gate-request').classList.add('hidden'); // only offered after an unapproved join attempt
  $('#gate-name').focus();
  if (!staff) {
    loadRoomInfo().then((info) => {
      applyTeamRequirement(info.requireTeam);
      renderRosterGate(info);
    });
  } else {
    $('#gate-roster').classList.add('hidden');
  }
}

// ---- join flow ----
function doJoin(role, name, team, roster) {
  socket.emit('join', {
    roomCode: code, playerId: playerId(), name, team, role,
    // A player who picked themselves out of the roster is linked on join.
    rosterTeam: roster?.rosterTeam,
    rosterPlayer: roster?.rosterPlayer,
    staffToken: isStaffRole(role) ? recall('staffToken:' + code) : undefined,
    // A logged-in account a director approved for this tournament is a
    // moderator credential too — no reader link needed.
    sessionToken: isStaffRole(role) ? localStorage.getItem('bz_sessionToken') || undefined : undefined
  }, (resp) => {
    if (!resp?.ok) {
      // The reader may have switched "require team name" on since we last
      // looked (or since this browser last joined) — trust the refusal.
      if (resp?.error === 'team_required') roomInfo = { ...(roomInfo || {}), requireTeam: true };
      showGate('player');
      $('#gate-msg').textContent = resp?.error === 'no_room'
        ? `Room ${code} doesn't exist — it may have expired. Check the code or ask for a new link.`
        : resp?.error === 'team_required'
          ? 'This room requires a team name — enter yours to join.'
          : 'Could not join — try again.';
      if (resp?.error === 'team_required') $('#gate-team').focus();
      return;
    }
    state.me = { id: resp.playerId, name, team };
    state.role = resp.role;
    remember('joined:' + code, '1');
    remember('role:' + code, resp.role);
    if (name) remember('name', name);
    if (team) remember('team', team);
    if (resp.coReaderToken) remember('coReaderToken:' + code, resp.coReaderToken);
    if (resp.staffDenied) {
      // Don't drop them into the room as a silent spectator: explain what's
      // missing and reopen the gate so they can sign in or join as a player.
      forget('staffRole:' + code);
      forget('joined:' + code);
      forget('role:' + code);
      state.role = null;
      showGate('player');
      $('#gate-msg').textContent = {
        not_logged_in: 'Moderators: sign in with your reader account below, then try again.',
        not_approved: "Your account isn't approved for this tournament yet — request access below, or ask the director to add you (they can use your email).",
        no_tournament: "This room isn't part of a tournament, so only its reader link grants control.",
      }[resp.denyReason] || 'Staff credentials invalid — open the room from your reader link.';
      // Not approved (but logged in): offer the access request right here.
      const tcode = resp.state?.tournamentCode;
      if (resp.denyReason === 'not_approved' && tcode) {
        const btn = $('#gate-request');
        btn.dataset.tcode = tcode;
        btn.classList.remove('hidden');
      }
      return;
    }
    enterStage(resp.state);
  });
}

$('#gate-join').onclick = () => {
  const gate = $('#gate');
  const name = $('#gate-name').value.trim();
  if (gate.dataset.mode === 'staff') {
    // Name is optional for readers; join straight away if they left it blank.
    if (name) remember('name', name);
    doJoin(gate.dataset.staffRole, name || undefined);
  } else {
    const choice = rosterGateChoice();
    if (choice?.error === 'incomplete') {
      $('#gate-msg').textContent = 'Pick your team and your name to join.';
      return;
    }
    if (choice?.rosterPlayer) {
      remember('name', choice.rosterPlayer);
      remember('team', choice.rosterTeam);
      pushPref(['team']);
      doJoin('player', choice.rosterPlayer, choice.rosterTeam, choice);
      return;
    }
    // Typed their own name: either the room has no roster, or they said they
    // aren't on it (which the server reports to the director).
    const team = choice?.offRoster ? choice.team : $('#gate-team').value.trim();
    if (!name && choice?.offRoster) {
      $('#gate-msg').textContent = 'Enter the name you want on your buzzer.';
      $('#gate-name').focus();
      return;
    }
    if (!team && roomInfo?.requireTeam) {
      $('#gate-msg').textContent = 'This room requires a team name.';
      $('#gate-team').focus();
      return;
    }
    const finalName = name || 'Player';
    remember('name', finalName); if (team) remember('team', team);
    doJoin('player', finalName, team);
  }
};
$('#gate-spectate').onclick = () => doJoin('spectator', $('#gate-name').value.trim() || 'Spectator');

// Request tournament access from the gate itself (shown after an unapproved
// moderator join attempt). If the director already approved meanwhile, join.
$('#gate-request').onclick = async () => {
  const tcode = $('#gate-request').dataset.tcode;
  const sessionToken = localStorage.getItem('bz_sessionToken');
  if (!tcode || !sessionToken) return;
  try {
    const { status } = await api('POST', `/api/tournaments/${tcode}/access`, { sessionToken });
    if (status === 'approved') {
      $('#gate-msg').textContent = "You're approved — joining…";
      doJoin('reader', $('#gate-name').value.trim() || recall('name') || undefined);
    } else {
      $('#gate-msg').textContent =
        'Request sent — pending the director\'s approval. Once approved, click "Moderator? Start reading" again.';
    }
  } catch (e) {
    $('#gate-msg').textContent = 'Could not request access: ' + e.message;
  }
};

// Moderator path without a reader link: sign in (round-trips back here), then
// join as reader on the strength of the approved account.
$('#gate-mod').onclick = () => {
  if (!localStorage.getItem('bz_sessionToken')) {
    location.href = '/account?return=' + encodeURIComponent(location.pathname + location.search);
    return;
  }
  const name = $('#gate-name').value.trim();
  if (name) remember('name', name);
  doJoin('reader', name || recall('name') || undefined);
};

function enterStage(snapshot) {
  // MODAQ rooms send staff to the embedded MODAQ reader + buzz panel instead of
  // the plain reader view. Players/spectators stay on the normal buzzer here.
  // `?plain=1` bypasses the redirect so a MODAQ moderator can still reach the
  // normal reader controls (buzzer options, invite links) from the MODAQ view.
  const plain = params.get('plain') === '1';
  if (!plain && isStaffRole(state.role) && snapshot?.settings?.modaqMode) {
    location.replace(`/modaq?room=${code}`);
    return;
  }
  $('#loading').classList.add('hidden');
  $('#gate').classList.add('hidden');
  $('#stage').classList.remove('hidden');
  const staff = isStaffRole(state.role);
  $('#options-panel').classList.toggle('hidden', !staff);
  // A plain room's reader gets the MODAQ switch up top (a MODAQ room's reader
  // is already redirected to /modaq unless they asked for ?plain=1).
  $('#modaq-offer').classList.toggle('hidden', !staff || !!snapshot?.settings?.modaqMode);
  // The roster is a reader's tool: load it, then label the buzzers below.
  $('#roster-panel').classList.toggle('hidden', !staff);
  // Everyone sees who's in the room; only staff get the moderation controls.
  $('#players-panel').classList.remove('hidden');
  $('#share-panel').classList.toggle('hidden', !staff);
  if (staff) buildShareLinks();
  // Compact view is staff-only: a reader squeezing the window beside Zoom + the
  // question doc wants just the buzzer and the buzz order. Restore their choice.
  $('#compact-toggle').classList.toggle('hidden', !staff);
  if (staff) applyCompact(recall('compactView') === '1');
  applySoundPrefs();
  ensureAudio();          // try to unlock sound on join; shows a warning if blocked
  applyState(snapshot);
}

// ---- compact view (staff) ----
function applyCompact(on) {
  document.body.classList.toggle('compact', on);
  const btn = $('#compact-toggle');
  btn.textContent = on ? 'Full view' : 'Compact';
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
$('#compact-toggle').onclick = () => {
  const on = !document.body.classList.contains('compact');
  if (on) remember('compactView', '1'); else forget('compactView');
  applyCompact(on);
};

// ---- copy player join link (everyone) ----
$('#copy-link').onclick = async (e) => {
  const url = `${location.origin}/r/${code}`;
  try { await navigator.clipboard.writeText(url); }
  catch { prompt('Copy this player link:', url); }
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = 'Copied!';
  btn.blur(); // don't let the button keep focus and intercept Space-to-buzz/reset
  setTimeout(() => { btn.textContent = old; }, 1200);
};

// ---- realtime state ----
socket.on('state', applyState);
socket.on('buzzer_reset', () => {
  $('#buzz-feedback').textContent = '';
  state.stuckSentFor = null;
  $('#stuck-banner').classList.add('hidden');   // the complaint is resolved
});
// The instant a buzz lands, everyone hears it (the state update renders order;
// no name is shown until the server resolves the reconcile window).
socket.on('buzz_pending', (p) => soundCycle(p?.cycleNo));

// Someone joined a roster room who isn't on the roster: tell the staff in the
// room (the director sees the same thing in their console).
socket.on('roster_alert', (alert) => {
  if (!isStaffRole(state.role) || !alert) return;
  const banner = $('#stuck-banner');
  banner.classList.remove('hidden');
  banner.textContent = `${alert.name}${alert.team ? ` (${alert.team})` : ''} joined but isn't on the roster.`;
});

function applyState(s) {
  if (!s) return;
  state.snapshot = s;
  $('#room-name').textContent = s.name || '';
  renderPhase(s);
  renderBuzzer(s);
  renderQueue(s);
  renderOptions(s);
  renderStuck(s);
  renderRoster(s);
  renderPlayers(s);
  renderMassinger(s);
  renderScoresheet(s);
  announceBuzz(s);
  if (roomInfo) roomInfo.requireTeam = !!s.settings?.requireTeam;
  if (s.tournamentCode) loadTournament(s.tournamentCode);
}

// ---- Live scoresheet (read-only) ----
// The server sends only what it deems safe for players (store.buildPlayerScoresheet):
// team/player names and the scoring events up to the question being read. This
// draws them exactly as MODAQ's own Events panel does for the reader.
let ssLastKey = '';
function renderScoresheet(s) {
  const sheet = s.scoresheet;
  const view = $('#scoresheet-view');
  const on = !!sheet && Array.isArray(sheet.teams) && sheet.teams.length === 2;
  view.classList.toggle('hidden', !on);
  document.body.classList.toggle('has-sheet', on);
  if (!on) { ssLastKey = ''; return; }
  // State broadcasts arrive on every buzz; only redraw when the sheet changed.
  const key = JSON.stringify([sheet.teams, sheet.rows, sheet.scores, sheet.current, sheet.total]);
  if (key === ssLastKey) return;
  ssLastKey = key;

  const [a, b] = sheet.teams;
  $('#ss-status').textContent = `${a.name}: ${sheet.scores[0]}, ${b.name}: ${sheet.scores[1]}`;

  const table = $('#ss-table');
  table.replaceChildren();
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', { className: 'ss-num' }, '#'), el('th', { className: 'ss-ev' }, 'Events'));
  thead.append(hr);

  const byN = new Map(sheet.rows.map((r) => [r.n, r]));
  const total = Math.max(sheet.total || 0, sheet.rows.length);
  const tbody = el('tbody');
  let carried = [0, 0];
  let currentRow = null;
  for (let n = 1; n <= total; n++) {
    const row = byN.get(n);
    const tr = el('tr', { className: n === sheet.current ? 'ss-current' : '' });
    const num = el('td', { className: 'ss-num' });
    num.append(n === sheet.current ? el('u', {}, String(n)) : String(n));
    const ev = el('td', { className: 'ss-ev' });
    if (row) {
      // Same order and wording as MODAQ's cycle items.
      if (row.thrownOut) ev.append(el('div', { className: 'ss-item' }, `Threw out tossup #${row.thrownOut}`));
      for (const z of row.buzzes) {
        const team = sheet.teams[z.team]?.name ?? '';
        const desc = z.points > 0 ? `for ${z.points} ✓` : `for ${z.points} ✗`;
        ev.append(el('div', { className: 'ss-item' }, `${z.player} (${team}) ${desc}`));
      }
      if (row.bonus) {
        const team = sheet.teams[row.bonus.team]?.name ?? '';
        const icons = row.bonus.parts.map((p) => (p > 0 ? '✓' : '✗')).join('');
        let text = `${team} ${row.bonus.total} on bonus (${icons})`;
        if (row.bonus.bounceback) text += ` (stolen for ${row.bonus.bounceback} points)`;
        ev.append(el('div', { className: 'ss-item' }, text));
      }
      carried = row.scores;
    }
    ev.append(el('div', { className: 'ss-score-line' }, `(${carried[0]} - ${carried[1]})`));
    tr.append(num, ev);
    tbody.append(tr);
    if (n === sheet.current) currentRow = tr;
  }
  table.append(thead, tbody);
  // Keep the question being read in view, as MODAQ does for the reader.
  if (currentRow) currentRow.scrollIntoView({ block: 'nearest' });
}

// ---- MASSINGER pick/ban board (read-only mirror) ----
// The moderator drives the pick/ban from the MODAQ page; every client in the
// room watches the same server-authoritative board here. The countdown runs on
// synced server time so both teams see the same clock.
let msTimer = null;

function msCountdownText(m) {
  if (!m.deadline) return '';
  const left = Math.max(0, Math.ceil((m.deadline - clock.now()) / 1000));
  return left > 0 ? ` — ${left}s` : ' — TIME’S UP';
}

// The team this browser counts as being on: the roster player the moderator
// (or auto-linking) tied us to wins over whatever we typed on the join gate.
function myTeam(s) {
  const me = (s.members || []).find((x) => x.id === state.me?.id);
  return me?.effectiveTeam || me?.rosterTeam || me?.assignedTeam || me?.team || '';
}

const sameTeam = (a, b) => {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) !== '' && norm(a) === norm(b);
};

function renderMassinger(s) {
  const m = s.massinger;
  const view = $('#massinger-view');
  if (!m) {
    view.classList.add('hidden');
    if (msTimer) { clearInterval(msTimer); msTimer = null; }
    return;
  }
  view.classList.remove('hidden');
  $('#ms-round').textContent = m.round ? `Round ${m.round}` : '';

  // My turn? Then the board becomes interactive for me: the team on the clock
  // makes its own protect/ban here, and the server re-checks that it's really
  // my turn before applying it.
  const me = (s.members || []).find((x) => x.id === state.me?.id);
  // Mirror the server's rules (massingerCanPick) so the buttons only appear
  // when a pick would actually be accepted: the room has to know which team
  // this buzzer is on, and the board's control mode decides who may pick.
  const vouched = !!me?.rosterPlayer || !!me?.assignedTeam;
  const myTurn = state.role === 'player' && m.status === 'active' && sameTeam(myTeam(s), m.teams[m.turn]);
  const captainMode = m.control === 'captain';
  const mine = myTurn && vouched && m.control !== 'moderator' && (!captainMode || me?.isCaptain === true);
  // Who picks for my team, when I'm not the one who does.
  const ourCaptain = (s.members || []).find((x) => x.isCaptain && sameTeam(x.effectiveTeam, myTeam(s)));

  const remaining = m.subcats.reduce((sum, sc) => sum + (sc.indexes.length - sc.banned), 0);
  const status = $('#ms-status');
  if (m.status === 'done') {
    status.className = 'ms-status done';
    status.textContent = `Pick/ban complete — ${remaining} questions remain.`;
  } else {
    const expired = m.deadline && clock.now() > m.deadline;
    status.className = 'ms-status' + (expired ? ' expired' : '') + (mine ? ' mine' : '');
    const who = mine ? 'Your pick' : `${m.teams[m.turn]} is picking`;
    status.textContent = `${who} (protect or ban)${msCountdownText(m)} · ` +
      `${remaining} questions remain, playing to ${m.target}.`;
  }

  const hint = $('#ms-hint');
  if (m.status === 'done') {
    hint.textContent = '';
  } else if (mine) {
    hint.textContent = m.timerSec > 0
      ? `Pick a subcategory to protect or ban. If the timer runs out, a random ban is made for you.`
      : 'Pick a subcategory to protect or ban.';
  } else if (m.control === 'moderator') {
    hint.textContent = 'The moderator is making every pick — call yours out to them.';
  } else if (myTurn && !vouched) {
    hint.textContent = "It's your team's pick, but the room doesn't know which team this buzzer is on — " +
      'ask the moderator to put you on your team (or to make the pick for you).';
  } else if (myTurn && captainMode && !me?.isCaptain) {
    hint.textContent = ourCaptain
      ? `Your team's picks are made by your captain, ${ourCaptain.rosterPlayer || ourCaptain.name}.`
      : "Your team's picks are made by its captain — ask the moderator to name one.";
  } else if (state.role === 'player' && myTeam(s)) {
    hint.textContent = `Waiting for ${m.teams[m.turn]} to pick.`;
  } else {
    hint.textContent = '';
  }

  const board = $('#ms-board');
  board.replaceChildren(...m.subcats.map((sc) => {
    const left = sc.indexes.length - sc.banned;
    const li = el('li', { className: left === 0 ? 'banned' : sc.protectedBy != null ? 'protected' : '' });
    li.append(el('span', { className: 'ms-label', textContent: sc.label }));
    const mark =
      left === 0 ? '✕ banned' :
      sc.protectedBy != null ? `🛡 ${m.teams[sc.protectedBy]}` :
      sc.banned > 0 ? `${sc.banned} of ${sc.indexes.length} banned` :
      sc.indexes.length > 1 ? `×${sc.indexes.length}` : '';
    li.append(el('span', { className: 'ms-mark', textContent: mark }));
    if (mine && left > 0 && sc.protectedBy == null) {
      const actions = el('span', { className: 'ms-pick' });
      actions.append(
        el('button', { className: 'tiny', textContent: 'Protect',
          onclick: () => sendMassingerPick('protect', sc.label) }),
        el('button', { className: 'tiny', textContent: 'Ban',
          onclick: () => sendMassingerPick('ban', sc.label) })
      );
      li.append(actions);
    }
    return li;
  }));

  // Tick the countdown between state broadcasts.
  if (m.status === 'active' && m.deadline && !msTimer) {
    msTimer = setInterval(() => {
      if (state.snapshot?.massinger) renderMassinger(state.snapshot);
    }, 500);
  } else if ((m.status !== 'active' || !m.deadline) && msTimer) {
    clearInterval(msTimer); msTimer = null;
  }
}

const MASSINGER_PICK_ERRORS = {
  not_your_turn: "It isn't your team's pick right now.",
  not_linked: "The room doesn't know which team this buzzer is on — ask the moderator to put you on your team.",
  moderator_only: 'The moderator is making every pick for this game.',
  not_captain: "Your team's picks are made by its captain.",
  not_a_player: 'Only players can pick.',
  protected: 'That subcategory is protected — it can\u2019t be banned.',
  exhausted: 'That subcategory has no questions left to ban.',
  not_active: 'The pick/ban has already finished.'
};

function sendMassingerPick(type, label) {
  const hint = $('#ms-hint');
  hint.textContent = 'Sending\u2026';
  socket.emit('massinger_pick', { type, label }, (resp) => {
    if (resp?.error) hint.textContent = MASSINGER_PICK_ERRORS[resp.error] || `Couldn\u2019t pick: ${resp.error}`;
  });
}

// ---- roster (staff) ----
// A QBJ registration file tells us the real names behind the buzzers. Staff
// load one, pick the teams playing in this room, then attach a player to each
// buzzer in the list below — after which the server labels the buzz queue (and
// the MODAQ buzz panel, which reads the same state) with the roster name.
const ROSTER_ERRORS = {
  bad_json: "That file isn't valid JSON.",
  no_registrations: "That doesn't look like a QBJ roster file — no registrations in it.",
  no_teams: 'No teams with players in that file.',
  no_tournament_roster: "This tournament doesn't have a roster uploaded yet.",
  forbidden: 'Only the reader can load a roster.'
};

function rosterMsg(text, cls = '') {
  const msg = $('#roster-msg');
  msg.className = 'msg ' + cls;
  msg.textContent = text;
}

async function loadRoster(body) {
  rosterMsg('Loading…');
  try {
    const { roster } = await api('PUT', `/api/rooms/${code}/buzzer-roster`, {
      token: recall('staffToken:' + code) || undefined,
      sessionToken: localStorage.getItem('bz_sessionToken') || undefined,
      ...body
    });
    const teams = roster?.teamNames?.length || 0;
    rosterMsg(`Loaded ${teams} team${teams === 1 ? '' : 's'}.` +
      (roster?.teams?.length ? '' : ' Add the teams playing in this room.'), 'good');
  } catch (e) {
    rosterMsg(ROSTER_ERRORS[e.message] || `Could not load the roster: ${e.message}`, 'bad');
  }
}

const setRosterTeams = (teams) => socket.emit('reader_action', { action: 'set_roster_teams', teams });

function renderRoster(s) {
  if (!isStaffRole(state.role)) return;
  const roster = s.roster;
  const all = roster?.teamNames || [];
  const active = (roster?.teams || []).map((t) => t.name);

  $('#roster-count').textContent = roster
    ? `(${all.length} team${all.length === 1 ? '' : 's'}${roster.name ? ' · ' + roster.name : ''})`
    : '';
  $('#roster-clear').classList.toggle('hidden', !roster);
  // Pulling the central roster only means something inside a tournament.
  $('#roster-tournament').classList.toggle('hidden', !s.tournamentCode);
  $('#roster-teams').classList.toggle('hidden', !roster);
  if (!roster) return;

  const opts = $('#roster-team-options');
  opts.innerHTML = '';
  for (const name of all) if (!active.includes(name)) opts.append(el('option', { value: name }));

  const chips = $('#roster-team-chips');
  chips.innerHTML = '';
  if (!active.length) {
    chips.append(el('span', { className: 'hint' }, 'No teams yet — add the ones playing here.'));
  }
  for (const name of active) {
    const chip = el('span', { className: 'chip team-chip' }, name);
    const x = el('button', { className: 'chip-x', title: `Remove ${name}` }, '×');
    x.onclick = () => setRosterTeams(active.filter((n) => n !== name));
    chip.append(x);
    chips.append(chip);
  }
}

$('#roster-file').onchange = async (e) => {
  try {
    const qbj = await readFileText(e.target);
    if (qbj) await loadRoster({ qbj });
  } catch (err) {
    rosterMsg(err.message, 'bad');
  }
  e.target.value = ''; // let the same file be picked again after a fix
};
$('#roster-tournament').onclick = () => loadRoster({});
$('#roster-clear').onclick = () => {
  if (confirm('Clear the roster and every buzzer assignment?')) {
    socket.emit('reader_action', { action: 'clear_roster' });
    rosterMsg('');
  }
};

function addRosterTeam() {
  const input = $('#roster-team-add');
  const wanted = input.value.trim();
  if (!wanted) return;
  const s = state.snapshot;
  const all = s?.roster?.teamNames || [];
  const active = (s?.roster?.teams || []).map((t) => t.name);
  // Accept a case-insensitive typo of a real team name, not an invented one.
  const name = all.find((n) => n.toLowerCase() === wanted.toLowerCase());
  if (!name) return rosterMsg(`No team called “${wanted}” in this roster.`, 'bad');
  if (active.includes(name)) return rosterMsg(`${name} is already in this room.`, 'bad');
  input.value = '';
  rosterMsg('');
  setRosterTeams([...active, name]);
}
$('#roster-team-add-btn').onclick = addRosterTeam;
$('#roster-team-add').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addRosterTeam(); }
});

// The per-buzzer picker: every player on a team playing in this room, grouped
// by team. Choosing a name that's already on another buzzer moves it here.
function seatPicker(p, s) {
  const teams = s.roster?.teams || [];
  const sel = el('select', { className: 'seat-pick', title: 'Who is on this buzzer' });
  sel.append(el('option', { value: '' }, '— who is this? —'));
  teams.forEach((t, ti) => {
    const group = el('optgroup', { label: t.name });
    t.players.forEach((name, pi) => group.append(el('option', { value: `${ti}:${pi}` }, name)));
    sel.append(group);
  });
  const ti = teams.findIndex((t) => t.name === p.rosterTeam);
  const pi = ti < 0 ? -1 : teams[ti].players.indexOf(p.rosterPlayer);
  sel.value = ti >= 0 && pi >= 0 ? `${ti}:${pi}` : '';
  sel.onchange = () => {
    // No value means "— who is this? —", i.e. take the name off this buzzer.
    const picked = sel.value ? sel.value.split(':').map(Number) : null;
    const team = picked ? teams[picked[0]] : null;
    socket.emit('reader_action', {
      action: 'assign_roster_player',
      playerId: p.id,
      team: team?.name ?? null,
      player: team?.players[picked[1]] ?? null
    });
    sel.blur(); // don't let the select swallow Space-to-reset
  };
  return sel;
}

// ---- players panel ----
// Everyone sees who's here and the head count; staff additionally get the
// disconnect alert, the join times and the remove buttons.
function renderPlayers(s) {
  const staff = isStaffRole(state.role);
  const players = (s.members || []).filter((m) => m.role === 'player');
  const offline = players.filter((p) => !p.connected).length;
  // Alert sound on any player that flipped connected -> disconnected since the
  // last render. First render only seeds the baseline (no sound for players who
  // were already offline when the reader opened the room).
  const nowOffline = new Set(players.filter((p) => !p.connected).map((p) => p.id));
  if (state.offlineIds === null) {
    state.offlineIds = nowOffline;
  } else {
    if (staff && disconnectSoundOn()) {
      for (const id of nowOffline) if (!state.offlineIds.has(id)) { playDisconnect(); break; }
    }
    state.offlineIds = nowOffline;
  }
  $('#player-count').textContent = `(${players.length})`;
  // A loud, separate badge so the reader can't miss that someone dropped.
  const alert = $('#offline-alert');
  if (staff && offline) {
    alert.textContent = `⚠ ${offline} disconnected`;
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }
  $('#remove-all').classList.toggle('hidden', !staff || players.length === 0);
  const ul = $('#players-list');
  // Don't rebuild the list under an open seat picker — a buzz (or the "x min
  // ago" tick) would otherwise close the dropdown mid-choice. The next state
  // update redraws it once the reader has moved on.
  const active = document.activeElement;
  if (active?.classList.contains('seat-pick') && ul.contains(active)) return;
  ul.innerHTML = '';
  if (!players.length) { ul.append(el('li', { className: 'empty' }, 'No players yet')); return; }
  // Show disconnected players first so they're the first thing the reader sees.
  const sorted = [...players].sort((a, b) => Number(a.connected) - Number(b.connected));
  for (const p of sorted) {
    const li = el('li', { className: p.connected ? '' : 'gone' });
    const col = el('span', { className: 'pcol' });
    const nameRow = el('span', { className: 'pname-wrap' });
    const mine = p.id === state.me?.id;
    // Once the reader has labelled this buzzer, the roster player IS the player.
    const shown = p.displayName || p.name;
    const under = p.rosterPlayer ? p.rosterTeam : p.team;
    nameRow.append(el('span', { className: 'pname' },
      `${shown}${under ? ` · ${under}` : ''}${mine ? ' (you)' : ''}`));
    if (!p.connected) nameRow.append(el('span', { className: 'offline-badge' }, 'OFFLINE'));
    col.append(nameRow);
    if (staff && p.joinedAt) {
      const j = el('span', { className: 'pjoined', title: new Date(p.joinedAt).toLocaleString() });
      // Keep the name they typed visible, so the reader can tell whose device
      // they just relabelled.
      const typed = p.rosterPlayer && p.name !== p.rosterPlayer ? ` · joined as ${p.name}` : '';
      j.textContent = `Joined ${clockTime(p.joinedAt)} · ${agoText(p.joinedAt)}${typed}`;
      col.append(j);
    }
    li.append(col);
    if (staff && (s.roster?.teams || []).length) li.append(seatPicker(p, s));
    if (staff) {
      const x = el('button', { className: 'tiny ghost' }, 'Remove');
      x.onclick = () => socket.emit('reader_action', { action: 'remove_player', playerId: p.id });
      li.append(x);
    }
    ul.append(li);
  }
}

// "Joined" helpers for the staff player list.
function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function agoText(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

// Keep the "x min ago" labels fresh even when no state update arrives.
setInterval(() => {
  if (state.snapshot && isStaffRole(state.role)) renderPlayers(state.snapshot);
}, 30000);
$('#remove-all').onclick = () => {
  if (confirm('Remove all players from this room?')) socket.emit('reader_action', { action: 'remove_all_players' });
};

// ---- buzzer (one big button, shared by all roles) ----
// Gray = "Ready to Buzz" (no one buzzed). Red = someone has buzzed.
// Players press it to buzz; staff press it (or Space) to reset.
const buzzer = $('#buzzer');

function renderPhase(s) {
  const q = s.queue || [];
  const label = $('#phase-label');
  if (!q.length) { label.textContent = 'Ready to Buzz'; label.className = 'phase ready'; }
  else {
    label.textContent = q[0].name + (q.length > 1 ? ` · ${q.length - 1} more queued` : '');
    label.className = 'phase buzzed';
  }
}

// The keyboard hint lives *inside* the button (second line) rather than as a
// line of prose under it — same information, no extra vertical space. CSS hides
// it on touch devices, where there's no Space bar to press.
function setBuzzer(label, sub = '') {
  $('#buzzer-label').textContent = label;
  $('#buzzer-sub').textContent = sub;
}

function renderBuzzer(s) {
  const q = s.queue || [];
  const has = q.length > 0;
  buzzer.classList.toggle('buzzed', has);
  buzzer.classList.toggle('ready', !has);

  if (isStaffRole(state.role)) {
    buzzer.disabled = !has;
    setBuzzer(has ? 'RESET' : 'READY', has ? 'or press Space' : '');
  } else if (state.role === 'player') {
    const pos = q.findIndex((x) => x.playerId === state.me?.id);
    const canBuzz = s.phase === 'open' && pos < 0;
    buzzer.disabled = !canBuzz;
    setBuzzer(pos === 0 ? 'BUZZED' : pos > 0 ? `#${pos + 1}` : (canBuzz ? 'BUZZ' : 'LOCKED'),
      canBuzz ? 'or press Space' : '');
  } else {
    buzzer.disabled = true;
    setBuzzer(has ? 'BUZZED' : '—');
  }
}

function buzzerAction() {
  if (buzzer.disabled) return;
  if (isStaffRole(state.role)) socket.emit('reader_action', { action: 'reset_buzzer' });
  else if (state.role === 'player') fireBuzz();
}
function fireBuzz() {
  $('#buzz-feedback').textContent = 'Buzzed!';
  navigator.vibrate?.(40);
  // Play the sound NOW, before the round trip: the press itself is certain.
  // Who WON the buzz stays unknown until the server resolves the window —
  // nothing here shows a name. The cycle guard keeps the buzz_pending
  // broadcast (or a race with another player's press) from double-playing.
  soundCycle(state.snapshot?.cycleNo);
  socket.emit('buzz', { pressServerTime: clock.now() }); // best estimate of server-time press
  buzzer.disabled = true; // optimistic; the next state update confirms
}

// One buzz sound per cycle, whether it comes from our own press or the room's
// buzz_pending broadcast — whichever happens first.
function soundCycle(cycleNo) {
  const key = cycleNo ?? state.snapshot?.cycleNo ?? -1;
  if (state.soundedCycle === key) return;
  state.soundedCycle = key;
  playBuzz();
}

buzzer.addEventListener('click', buzzerAction);
buzzer.addEventListener('touchstart', (e) => { e.preventDefault(); buzzerAction(); }, { passive: false });

// Space: players buzz, staff reset. Never while genuinely typing in a field.
// Note: a readonly/disabled input (e.g. the invite-link boxes) can't be typed
// into, so it must NOT swallow Space — otherwise clicking an invite link would
// leave the reader unable to reset with the spacebar.
const isTyping = (n) => {
  if (!n) return false;
  if (n.isContentEditable) return true;
  const tag = n.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !(n.readOnly || n.disabled);
  return false;
};
document.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && !e.repeat && !isTyping(document.activeElement)) {
    e.preventDefault();
    // Space is the universal buzz/reset key. Drop focus from any button first so
    // it can't be re-activated by the same keypress in browsers where
    // preventDefault doesn't suppress the focused-button click.
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    buzzer.classList.add('pressed');
    buzzerAction();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.key === ' ') buzzer.classList.remove('pressed');
});

// ---- "the buzzer isn't clear" ----
// Players: a buzz that sits unjudged usually means the reader forgot to reset.
// After the buzzer has been stuck for STUCK_DELAY_MS they can ping the
// moderator, who gets a sound + a browser notification + a banner. The server
// re-checks the same gates, so this UI is convenience, not enforcement.
const STUCK_DELAY_MS = 10000;
let stuckTick = null;

function renderStuck(s) {
  const btn = $('#stuck-alert');
  if (stuckTick) { clearInterval(stuckTick); stuckTick = null; }
  const live = state.role === 'player'
    && s.settings?.playerAlerts !== false
    && (s.queue || []).length > 0
    && s.lastBuzzAt != null;
  btn.classList.toggle('hidden', !live);
  if (!live) return;

  const paint = () => {
    if (state.stuckSentFor === s.lastBuzzAt) {   // already pinged for this buzz
      btn.disabled = true;
      btn.textContent = 'Moderator alerted';
    } else {
      const left = Math.ceil((s.lastBuzzAt + STUCK_DELAY_MS - clock.now()) / 1000);
      btn.disabled = left > 0;
      btn.textContent = left > 0
        ? `Buzzer isn't clear — in ${left}s`
        : "Buzzer isn't clear — alert the moderator";
    }
    if (!btn.disabled && stuckTick) { clearInterval(stuckTick); stuckTick = null; }
  };
  paint();
  if (btn.disabled) stuckTick = setInterval(paint, 500);
}

$('#stuck-alert').onclick = () => {
  const buzzAt = state.snapshot?.lastBuzzAt ?? null;
  const btn = $('#stuck-alert');
  btn.disabled = true;
  socket.emit('stuck_alert', {}, (resp) => {
    if (resp?.ok) {
      state.stuckSentFor = buzzAt;
      btn.textContent = resp.delivered ? 'Moderator alerted' : 'Alert sent — no moderator connected';
      return;
    }
    // Rejected (too soon / cooling down / disabled) — say so and re-render.
    $('#buzz-feedback').textContent = {
      too_soon: 'Give the moderator a moment first.',
      cooldown: 'You just alerted the moderator — hang tight.',
      disabled: 'This room has player alerts turned off.'
    }[resp?.error] || 'Could not alert the moderator.';
    if (state.snapshot) renderStuck(state.snapshot);
  });
};

// Staff: a player is telling us the buzzer never got cleared.
socket.on('stuck_alert', (a) => {
  if (!isStaffRole(state.role) || !a) return;
  const who = `${a.name || 'A player'}${a.team ? ` (${a.team})` : ''}`;
  const banner = $('#stuck-banner');
  banner.textContent = `⚠ ${who} says the buzzer isn't clear — ${clockTime(a.at || Date.now())}`;
  banner.classList.remove('hidden');
  clearTimeout(state.stuckBannerTimer);
  state.stuckBannerTimer = setTimeout(() => banner.classList.add('hidden'), 30000);
  playStuckAlert();
  notifyStuck(who);
});

// Browser notification, so a reader who has tabbed away to the packet still
// sees it. Permission is asked for once, from the staff view only.
let notifyAsked = false;
function askNotifyPermission() {
  if (notifyAsked || !('Notification' in window)) return;
  if (Notification.permission !== 'default') { notifyAsked = true; return; }
  notifyAsked = true;
  try { Notification.requestPermission().catch(() => {}); } catch { /* older API */ }
}
function notifyStuck(who) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`Room ${code}: buzzer isn't clear`, {
      body: `${who} is waiting to be recognized.`,
      tag: 'klaxon-stuck-' + code,   // collapse repeats instead of stacking
      renotify: true
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* notifications unavailable */ }
}

// ---- queue / buzz order ----
function renderQueue(s) {
  const q = s.queue || [];
  const staff = isStaffRole(state.role);
  const queueMode = !!s.settings?.queueMode;
  // The panel never hides: one appearing and disappearing with every buzz shoves
  // everything below it up and down. Empty state instead, and outside queue mode
  // there's only ever one name to show.
  $('#queue-title').textContent = queueMode ? 'Buzz queue' : 'Buzzed in player';
  const list = $('#queue-list');
  list.innerHTML = '';
  if (!q.length) list.append(el('li', { className: 'empty' }, 'No one has buzzed'));
  q.forEach((o, i) => list.append(
    el('li', { className: i === 0 ? 'head' : '' }, `${o.name}${i ? ` (+${o.marginMs}ms)` : ''}`)
  ));

  $('#queue-controls').classList.toggle('hidden', !staff);
  $('#ctl-next').classList.toggle('hidden', !queueMode); // "next" only meaningful in queue mode
  $('#ctl-next').disabled = !q.length;
  $('#ctl-clear').disabled = !q.length;
  $('#ctl-clear').textContent = queueMode ? 'Clear queue' : 'Clear buzz';

  const pos = q.findIndex((x) => x.playerId === state.me?.id);
  const canWithdraw = state.role === 'player' && s.settings?.allowWithdraw && pos >= 0;
  $('#ctl-withdraw').classList.toggle('hidden', !canWithdraw);
}
$('#ctl-next').onclick = () => socket.emit('reader_action', { action: 'next_buzz' });
$('#ctl-clear').onclick = () => socket.emit('reader_action', { action: 'clear_queue' });
$('#ctl-withdraw').onclick = () => socket.emit('withdraw');

// ---- game options (staff) ----
function renderOptions(s) {
  if (!isStaffRole(state.role)) return;
  $('#opt-queue').checked = !!s.settings?.queueMode;
  $('#opt-withdraw').checked = !!s.settings?.allowWithdraw;
  $('#opt-autoclear').checked = !!s.settings?.autoClear;
  $('#opt-require-team').checked = !!s.settings?.requireTeam;
  $('#opt-player-alerts').checked = s.settings?.playerAlerts !== false;
  $('#opt-withdraw-row').classList.toggle('hidden', !s.settings?.queueMode);
  // Auto-clear only applies in lock-to-first mode (server ignores it otherwise).
  $('#opt-autoclear').closest('.toggle').classList.toggle('hidden', !!s.settings?.queueMode);
  const modaq = $('#opt-modaq-mode');
  if (modaq) modaq.value = s.settings?.modaqLite ? 'lite' : s.settings?.modaqMode ? 'full' : 'off';
}
$('#opt-queue').onchange = (e) =>
  socket.emit('reader_action', { action: 'set_options', options: { queueMode: e.target.checked } });
$('#opt-withdraw').onchange = (e) =>
  socket.emit('reader_action', { action: 'set_options', options: { allowWithdraw: e.target.checked } });
$('#opt-autoclear').onchange = (e) =>
  socket.emit('reader_action', { action: 'set_options', options: { autoClear: e.target.checked } });
$('#opt-require-team').onchange = (e) =>
  socket.emit('reader_action', { action: 'set_options', options: { requireTeam: e.target.checked } });
$('#opt-player-alerts').onchange = (e) =>
  socket.emit('reader_action', { action: 'set_options', options: { playerAlerts: e.target.checked } });
// Switching to a MODAQ mode moves this staff view over to the MODAQ reader.
// The switch is acknowledged before navigating so the MODAQ page never lands
// on a room that still says "standard buzzer" (it would bounce straight back).
function setModaqMode(v) { // off | lite | full
  const options = v === 'lite' ? { modaqMode: true, modaqLite: true }
    : v === 'full' ? { modaqMode: true, modaqLite: false }
      : { modaqMode: false, modaqLite: false };
  socket.emit('reader_action', { action: 'set_options', options }, () => {
    if (v !== 'off') location.replace(`/modaq?room=${code}`);
  });
}
$('#opt-modaq-mode')?.addEventListener('change', (e) => setModaqMode(e.target.value));
// One-off packet reading from a plain room: lite is the right fit (MODAQ's own
// packet file + New Game; a tournament room already comes in as MODAQ).
$('#modaq-switch').onclick = () => {
  $('#modaq-switch').disabled = true;
  $('#modaq-switch').textContent = 'Opening MODAQ…';
  setModaqMode(state.snapshot?.tournamentCode ? 'full' : 'lite');
};

// ---- share / invite links ----
function buildShareLinks() {
  $('#share-code').textContent = code;
  $('#share-player').value = `${location.origin}/r/${code}`;
  const coToken = recall('coReaderToken:' + code);
  const coRow = $('#share-coreader-row');
  if (coToken) {
    $('#share-coreader').value = `${location.origin}/r/${code}?role=co-reader&token=${coToken}`;
    coRow.classList.remove('hidden');
  } else {
    coRow.classList.add('hidden');
  }
}
document.querySelectorAll('.copy-btn').forEach((b) => {
  b.onclick = async () => {
    const input = document.getElementById(b.dataset.target);
    try { await navigator.clipboard.writeText(input.value); }
    catch { input.select(); document.execCommand('copy'); }
    const old = b.textContent; b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = old; }, 1200);
  };
});

// ---- sound ----
// Synthesized via Web Audio (no asset to load/fail). Several selectable
// presets; the default ("ding") is deliberately loud and attention-grabbing.
const SOUNDS = { ding: 'Ding (default)', buzzer: 'Game buzzer', bell: 'Bell', chime: 'Chime', beep: 'Beep' };
// A logged-in player's settings follow their account: any change made here is
// saved to it (best-effort), and logging in on another device brings them back.
function pushPref(keys) {
  const sessionToken = localStorage.getItem('bz_sessionToken');
  if (!sessionToken) return;
  const prefs = {};
  for (const k of keys) prefs[k] = recall(k) ?? '';
  api('PATCH', '/api/accounts/me', { sessionToken, prefs }).catch(() => {});
}

const soundName = () => recall('sound') || 'ding';
const volume = () => { const v = parseFloat(recall('volume')); return Number.isFinite(v) ? v : 0.9; };
const isMuted = () => recall('muted') === '1';
// Moderator-only preference (local to this device, like the other sound prefs).
const disconnectSoundOn = () => recall('disconnectSound') === '1';

let actx = null;
function ensureAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { actx = null; }
  updateSoundWarning();
  return actx;
}

function note(ctx, dest, t, type, freq, dur, peak) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function playBuzz() { playSound(soundName(), volume()); }

// Distinct descending two-tone "uh-oh" so the reader hears a *drop* as different
// from a buzz. Honors mute and master volume just like the buzz sound.
function playDisconnect() {
  if (isMuted()) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = volume();
  master.connect(ctx.destination);
  note(ctx, master, t, 'sine', 660, 0.22, 0.9);          // higher first...
  note(ctx, master, t + 0.18, 'sine', 415, 0.45, 0.9);   // ...then drop lower
}

// Insistent rising triple-beep, repeated: a reader who tuned out the buzz sound
// should still register THIS one. Honors mute and master volume.
function playStuckAlert() {
  if (isMuted()) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = volume();
  master.connect(ctx.destination);
  for (const start of [0, 0.55]) {
    [[784, 0], [988, 0.13], [1319, 0.26]].forEach(([f, dt]) =>
      note(ctx, master, t + start + dt, 'square', f, 0.16, 0.8));
  }
}

// ---- read the buzzing player's name aloud ----
// A moderator watching the question doc doesn't want to look away to see who
// buzzed. The browser's own speech synthesis says the name — the FIRST name,
// the way you'd actually call on someone, unless someone else in the room shares
// it, in which case the full name disambiguates. Off by default, per device.
const speakOn = () => recall('speakBuzz') === '1';
const canSpeak = () => typeof window.speechSynthesis !== 'undefined';
const firstNameOf = (full) => String(full || '').trim().split(/\s+/)[0] || '';

function spokenNameFor(s, id) {
  const players = (s.members || []).filter((m) => m.role === 'player');
  const me = players.find((m) => m.id === id);
  const full = String(me?.displayName || me?.name || '').trim();
  const first = firstNameOf(full);
  if (!first || first === full) return full;
  const shared = players.some((m) => m.id !== id &&
    firstNameOf(m.displayName || m.name).toLowerCase() === first.toLowerCase());
  return shared ? full : first;
}

function speak(text) {
  if (!text || !canSpeak()) return;
  try {
    // A second buzz shouldn't have to wait behind the first — the name that
    // matters is the one on the buzzer now.
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.volume = volume();
    u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* speech unavailable */ }
}

// Say whoever is on the buzz now, once per (cycle, player). Joining a room that
// already has a buzz outstanding stays silent — only new buzzes are announced.
function announceBuzz(s) {
  const head = (s.queue || [])[0];
  const key = head ? `${s.cycleNo}:${head.playerId}` : null;
  const firstRender = state.announcedKey === undefined;
  if (key === state.announcedKey) return;
  state.announcedKey = key;
  if (!key || firstRender || !speakOn() || isMuted()) return;
  speak(spokenNameFor(s, head.playerId));
}

// `force` lets the Test/preview buttons play even while muted.
function playSound(name, vol, force = false) {
  if (isMuted() && !force) return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;     // blocked -> warning already shown
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = vol;
  master.connect(ctx.destination);

  switch (name) {
    case 'buzzer': { // harsh sustained game-show buzzer
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(150, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.01);
      g.gain.setValueAtTime(1, t + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(master); o.start(t); o.stop(t + 0.62);
      break;
    }
    case 'bell':
      note(ctx, master, t, 'triangle', 1568, 1.0, 1);
      note(ctx, master, t, 'sine', 3136, 0.7, 0.4);
      break;
    case 'chime':
      [[988, 0], [1319, 0.11], [1976, 0.22]].forEach(([f, dt]) => note(ctx, master, t + dt, 'sine', f, 0.35, 0.9));
      break;
    case 'beep':
      note(ctx, master, t, 'square', 1000, 0.16, 0.7);
      break;
    case 'ding':
    default: // prominent bright double-ding with an octave harmonic
      note(ctx, master, t, 'sine', 880, 0.18, 1);
      note(ctx, master, t, 'triangle', 1760, 0.18, 0.4);
      note(ctx, master, t + 0.09, 'sine', 1318.5, 0.5, 1);
      note(ctx, master, t + 0.09, 'triangle', 2637, 0.45, 0.35);
      break;
  }
}

function applySoundPrefs() {
  const pick = $('#sound-pick');
  if (pick && !pick.options.length) {
    for (const [k, v] of Object.entries(SOUNDS)) pick.append(el('option', { value: k }, v));
  }
  if (pick) pick.value = soundName();
  const vol = $('#sound-vol');
  if (vol) vol.value = volume();
  const dc = $('#opt-disconnect-sound');
  if (dc) dc.checked = disconnectSoundOn();
  const say = $('#opt-speak-buzz');
  if (say) {
    say.checked = speakOn() && canSpeak();
    say.disabled = !canSpeak();
  }
  $('#speak-warn')?.classList.toggle('hidden', canSpeak());
  applyMuteUI();
}
function applyMuteUI() {
  const b = $('#mute-btn');
  if (!b) return;
  const m = isMuted();
  b.textContent = m ? 'Unmute' : 'Mute';
  b.setAttribute('aria-pressed', m ? 'true' : 'false');
  b.classList.toggle('active', m);
  const vol = $('#sound-vol'); if (vol) vol.disabled = m;
}
$('#sound-pick')?.addEventListener('change', (e) => { remember('sound', e.target.value); pushPref(['sound']); playSound(soundName(), volume(), true); e.target.blur(); /* don't let the select keep focus and swallow Space-to-reset */ });
$('#sound-vol')?.addEventListener('input', (e) => remember('volume', e.target.value));
$('#sound-vol')?.addEventListener('change', () => { pushPref(['volume']); playSound(soundName(), volume(), true); });
$('#test-sound')?.addEventListener('click', () => playSound(soundName(), volume(), true));
$('#enable-sound')?.addEventListener('click', () => playSound(soundName(), volume(), true));
$('#opt-disconnect-sound')?.addEventListener('change', (e) => {
  if (e.target.checked) { remember('disconnectSound', '1'); playDisconnect(); } // preview
  else forget('disconnectSound');
  pushPref(['disconnectSound']);
});
$('#opt-speak-buzz')?.addEventListener('change', (e) => {
  if (!e.target.checked) { forget('speakBuzz'); pushPref(['speakBuzz']); return; }
  remember('speakBuzz', '1');
  pushPref(['speakBuzz']);
  // Preview with a real name from the room so the reader hears exactly what a
  // buzz will sound like (including the first-name-only rule).
  const someone = (state.snapshot?.members || []).find((m) => m.role === 'player');
  speak(someone ? spokenNameFor(state.snapshot, someone.id) : 'Names will be read aloud');
});
$('#mute-btn')?.addEventListener('click', () => {
  if (isMuted()) forget('muted'); else remember('muted', '1');
  pushPref(['muted']);
  applyMuteUI();
  if (!isMuted()) playSound(soundName(), volume(), true); // confirm on unmute
});

// We can reliably detect a blocked/suspended AudioContext (the #1 reason a
// browser plays nothing). OS/hardware mute isn't exposed to web pages.
function updateSoundWarning() {
  const warn = $('#sound-warn');
  if (!warn) return;
  warn.classList.toggle('hidden', !!(actx && actx.state === 'running'));
}
window.addEventListener('pointerdown', ensureAudio, { once: true });
window.addEventListener('keydown', ensureAudio, { once: true });
// Notification permission must be asked for from a user gesture (Safari
// requires it); askNotifyPermission() only ever prompts once.
const maybeAskNotify = () => { if (isStaffRole(state.role)) askNotifyPermission(); };
window.addEventListener('pointerdown', maybeAskNotify);
window.addEventListener('keydown', maybeAskNotify);

// ---- tournament strip ----
async function loadTournament(tcode) {
  if (state.tournament?.code === tcode) return renderTournament();
  try {
    state.tournament = await api('GET', `/api/tournaments/${tcode}`);
    renderTournament();
  } catch { /* tournament may not exist yet */ }
}
function renderTournament() {
  const t = state.tournament;
  if (!t) return;
  $('#tournament-strip').classList.remove('hidden');
  // The code reads as a link, so make it one: a director on this device lands
  // in their console, everyone else in the tournament's public stats.
  const tcodeEl = $('#t-code');
  tcodeEl.replaceChildren(el('a', {
    className: 'tlink',
    href: recall('directorToken:' + t.code) ? `/t/${t.code}` : `/t/${t.code}/stats`,
    title: recall('directorToken:' + t.code) ? 'Open the director console' : 'Open the tournament standings'
  }, t.code));
  // Director-set player links: the schedule and the tournament's Discord.
  const linksEl = $('#t-links');
  linksEl.innerHTML = '';
  if (t.links?.schedule) {
    linksEl.append(el('a', { className: 'chip', href: t.links.schedule, target: '_blank', rel: 'noopener noreferrer' }, 'Schedule ↗'));
  }
  if (t.links?.discord) {
    linksEl.append(el('a', { className: 'chip', href: t.links.discord, target: '_blank', rel: 'noopener noreferrer' }, 'Discord ↗'));
  }
  const myTeam = state.me?.team;
  const next = myTeam && t.schedule.find((row) =>
    row.room !== code && row.teams.some((tm) => tm.toLowerCase() === myTeam.toLowerCase()));
  const nextEl = $('#t-next');
  nextEl.innerHTML = '';
  if (next) {
    nextEl.append(el('a', { className: 'jump', href: `/r/${next.room}` },
      `Round ${next.round}: go to room ${next.room} →`));
  }
  const rooms = $('#t-rooms');
  rooms.innerHTML = '';
  for (const rc of t.rooms) {
    rooms.append(el('a', { className: 'chip' + (rc === code ? ' here' : ''), href: `/r/${rc}` }, rc));
  }
}
