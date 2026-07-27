import { ClockSync } from './clocksync.js';
import { playerId, remember, recall, forget, api, $, el } from './util.js';

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

const state = { me: null, role: null, snapshot: null, tournament: null, offlineIds: null };

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
  if (!staff) loadRoomInfo().then((info) => applyTeamRequirement(info.requireTeam));
}

// ---- join flow ----
function doJoin(role, name, team) {
  socket.emit('join', {
    roomCode: code, playerId: playerId(), name, team, role,
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
    const team = $('#gate-team').value.trim();
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
  $('#players-panel').classList.toggle('hidden', !staff);
  $('#share-panel').classList.toggle('hidden', !staff);
  $('#player-hint').classList.toggle('hidden', state.role !== 'player');
  $('#reader-hint').classList.toggle('hidden', !staff);
  $('#role-badge').textContent = staff ? (state.role === 'reader' ? 'Reader' : 'Co-reader')
    : state.role === 'spectator' ? 'Spectator' : 'Player';
  $('#role-footer').classList.remove('hidden');
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
// The instant a buzz lands, everyone hears it (the state update renders order).
socket.on('buzz_pending', () => playBuzz());

function applyState(s) {
  if (!s) return;
  state.snapshot = s;
  $('#room-name').textContent = s.name || '';
  renderPhase(s);
  renderBuzzer(s);
  renderQueue(s);
  renderOptions(s);
  renderStuck(s);
  renderPlayers(s);
  if (roomInfo) roomInfo.requireTeam = !!s.settings?.requireTeam;
  if (s.tournamentCode) loadTournament(s.tournamentCode);
}

// ---- players panel (staff): see and remove players ----
function renderPlayers(s) {
  if (!isStaffRole(state.role)) return;
  const players = (s.members || []).filter((m) => m.role === 'player');
  const offline = players.filter((p) => !p.connected).length;
  // Alert sound on any player that flipped connected -> disconnected since the
  // last render. First render only seeds the baseline (no sound for players who
  // were already offline when the reader opened the room).
  const nowOffline = new Set(players.filter((p) => !p.connected).map((p) => p.id));
  if (state.offlineIds === null) {
    state.offlineIds = nowOffline;
  } else {
    if (disconnectSoundOn()) {
      for (const id of nowOffline) if (!state.offlineIds.has(id)) { playDisconnect(); break; }
    }
    state.offlineIds = nowOffline;
  }
  const count = $('#player-count');
  count.textContent = players.length ? `(${players.length})` : '';
  // A loud, separate badge so the reader can't miss that someone dropped.
  const alert = $('#offline-alert');
  if (offline) {
    alert.textContent = `⚠ ${offline} disconnected`;
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }
  $('#remove-all').classList.toggle('hidden', players.length === 0);
  const ul = $('#players-list');
  ul.innerHTML = '';
  if (!players.length) { ul.append(el('li', { className: 'empty' }, 'No players yet')); return; }
  // Show disconnected players first so they're the first thing the reader sees.
  const sorted = [...players].sort((a, b) => Number(a.connected) - Number(b.connected));
  for (const p of sorted) {
    const li = el('li', { className: p.connected ? '' : 'gone' });
    const col = el('span', { className: 'pcol' });
    const nameRow = el('span', { className: 'pname-wrap' });
    nameRow.append(el('span', { className: 'pname' }, `${p.name}${p.team ? ` · ${p.team}` : ''}`));
    if (!p.connected) nameRow.append(el('span', { className: 'offline-badge' }, 'OFFLINE'));
    col.append(nameRow);
    if (p.joinedAt) {
      const j = el('span', { className: 'pjoined', title: new Date(p.joinedAt).toLocaleString() });
      j.textContent = `Joined ${clockTime(p.joinedAt)} · ${agoText(p.joinedAt)}`;
      col.append(j);
    }
    li.append(col);
    const x = el('button', { className: 'tiny ghost' }, 'Remove');
    x.onclick = () => socket.emit('reader_action', { action: 'remove_player', playerId: p.id });
    li.append(x);
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

function renderBuzzer(s) {
  const q = s.queue || [];
  const has = q.length > 0;
  buzzer.classList.toggle('buzzed', has);
  buzzer.classList.toggle('ready', !has);

  if (isStaffRole(state.role)) {
    buzzer.disabled = !has;
    buzzer.textContent = has ? 'RESET' : 'READY';
  } else if (state.role === 'player') {
    const pos = q.findIndex((x) => x.playerId === state.me?.id);
    const canBuzz = s.phase === 'open' && pos < 0;
    buzzer.disabled = !canBuzz;
    buzzer.textContent = pos === 0 ? 'BUZZED' : pos > 0 ? `#${pos + 1}` : (canBuzz ? 'BUZZ' : 'LOCKED');
  } else {
    buzzer.disabled = true;
    buzzer.textContent = has ? 'BUZZED' : '—';
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
  socket.emit('buzz', { pressServerTime: clock.now() }); // best estimate of server-time press
  buzzer.disabled = true; // optimistic; the next state update confirms
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
  $('#queue-view').classList.toggle('hidden', q.length === 0);
  const list = $('#queue-list');
  list.innerHTML = '';
  q.forEach((o, i) => list.append(
    el('li', { className: i === 0 ? 'head' : '' }, `${o.name}${i ? ` (+${o.marginMs}ms)` : ''}`)
  ));

  const staff = isStaffRole(state.role);
  const queueMode = !!s.settings?.queueMode;
  $('#queue-controls').classList.toggle('hidden', !(staff && q.length));
  $('#ctl-next').classList.toggle('hidden', !queueMode); // "next" only meaningful in queue mode

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
$('#opt-modaq-mode')?.addEventListener('change', (e) => {
  const v = e.target.value; // off | lite | full
  const options = v === 'lite' ? { modaqMode: true, modaqLite: true }
    : v === 'full' ? { modaqMode: true, modaqLite: false }
      : { modaqMode: false, modaqLite: false };
  socket.emit('reader_action', { action: 'set_options', options });
  if (v !== 'off') location.replace(`/modaq?room=${code}`);
});

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
$('#sound-pick')?.addEventListener('change', (e) => { remember('sound', e.target.value); playSound(soundName(), volume(), true); e.target.blur(); /* don't let the select keep focus and swallow Space-to-reset */ });
$('#sound-vol')?.addEventListener('input', (e) => remember('volume', e.target.value));
$('#sound-vol')?.addEventListener('change', () => playSound(soundName(), volume(), true));
$('#test-sound')?.addEventListener('click', () => playSound(soundName(), volume(), true));
$('#enable-sound')?.addEventListener('click', () => playSound(soundName(), volume(), true));
$('#opt-disconnect-sound')?.addEventListener('change', (e) => {
  if (e.target.checked) { remember('disconnectSound', '1'); playDisconnect(); } // preview
  else forget('disconnectSound');
});
$('#mute-btn')?.addEventListener('click', () => {
  if (isMuted()) forget('muted'); else remember('muted', '1');
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
  $('#t-code').textContent = t.code;
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
