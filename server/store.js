import { DEFAULTS } from './config.js';
import { roomCode, secretToken, uuid } from './ids.js';

// ---------------------------------------------------------------------------
// In-memory authoritative store.
//
// EVERYTHING that decides scores, buzz order and lockouts lives here on the
// server. Clients are never trusted to assert "I buzzed first" or "I scored":
// they send raw intents (a press, a judgment request) and the server alone
// mutates state. That is the foundation of the anti-cheat model.
//
// The store is intentionally pure data + small methods, with no socket
// knowledge, so the buzz logic can be unit-reasoned about independently.
// ---------------------------------------------------------------------------

const rooms = new Map();        // code -> room
const tournaments = new Map();  // code -> tournament

function freshCycle(cycleNo) {
  return {
    cycleNo,
    collected: [],        // buzz records currently being reconciled
    order: [],            // resolved buzz order (first to buzz, in order)
    windowOpenedAt: null  // server time the reconcile window started
  };
}

export function createRoom({ name, tournamentCode = null, settings = {} }) {
  let code;
  do { code = roomCode(); } while (rooms.has(code));

  // A room created inside a tournament inherits that tournament's defaults;
  // anything passed explicitly to createRoom still wins over them.
  const tournament = tournamentCode ? tournaments.get(tournamentCode) : null;
  const eff = { ...(tournament?.roomDefaults || {}), ...settings };

  const room = {
    code,
    name: (name || `Room ${code}`).slice(0, 60),
    tournamentCode,
    createdAt: Date.now(),
    readerToken: secretToken(),     // full control
    coReaderToken: secretToken(),   // co-reader / statkeeper (buzzer + scores)
    settings: {
      reconcileWindowMs: clampNum(eff.reconcileWindowMs, 50, 1000, DEFAULTS.reconcileWindowMs),
      queueMode: !!eff.queueMode,        // accumulate a buzz queue vs lock to first
      allowWithdraw: !!eff.allowWithdraw, // (queue mode) players may remove themselves
      autoClear: !!eff.autoClear          // auto-reset the buzzer a few seconds after a buzz
    },
    phase: 'open',          // open | locked  — buzzers are live by default
    cycleNo: 1,
    cycle: freshCycle(1),
    queue: [],               // [{ playerId, name, marginMs }] in buzz order
    members: new Map(),      // playerId -> member
    log: []                 // recent events for late joiners / audit
  };
  rooms.set(code, room);

  if (tournamentCode && tournaments.has(tournamentCode)) {
    tournaments.get(tournamentCode).roomCodes.add(code);
  }
  return room;
}

export function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

export function createTournament({ name, schedule = [], defaults = {} }) {
  let code;
  do { code = roomCode(5); } while (tournaments.has(code));
  const t = {
    code,
    name: (name || `Tournament ${code}`).slice(0, 80),
    createdAt: Date.now(),
    directorToken: secretToken(),
    roomCodes: new Set(),
    // Settings every room created in this tournament starts with (see createRoom).
    roomDefaults: normalizeRoomDefaults(defaults),
    schedule: normalizeSchedule(schedule)
  };
  tournaments.set(code, t);
  return t;
}

// Whitelist + coerce the per-room defaults a tournament director can set.
function normalizeRoomDefaults(d = {}) {
  const out = {};
  if (typeof d.queueMode === 'boolean') out.queueMode = d.queueMode;
  if (typeof d.allowWithdraw === 'boolean') out.allowWithdraw = d.allowWithdraw;
  if (typeof d.autoClear === 'boolean') out.autoClear = d.autoClear;
  return out;
}

export function getTournament(code) {
  return tournaments.get((code || '').toUpperCase());
}

// schedule: [{ round, room, teams:[..] }] -> we keep it loose on purpose so a
// TD can paste in whatever their bracket software exports.
function normalizeSchedule(schedule) {
  if (!Array.isArray(schedule)) return [];
  return schedule
    .filter((s) => s && (s.round != null))
    .map((s) => ({
      round: String(s.round),
      room: String(s.room || '').toUpperCase(),
      teams: Array.isArray(s.teams) ? s.teams.map(String) : []
    }));
}

export function setSchedule(tournament, schedule) {
  tournament.schedule = normalizeSchedule(schedule);
  return tournament.schedule;
}

// --- membership -----------------------------------------------------------

const ROLES = new Set(['reader', 'co-reader', 'spectator', 'player']);

// `role` here is already validated/authorized by the server (see index.js).
export function joinRoom(room, { playerId, name, role, team }) {
  const id = playerId || uuid();
  const normRole = ROLES.has(role) ? role : 'player';
  const existing = room.members.get(id);
  const member = existing || {
    id,
    name: (name || 'Player').slice(0, 40),
    role: normRole,
    team: team ? String(team).slice(0, 40) : null,
    connected: true,
    joinedAt: Date.now()
  };
  if (existing) {
    if (name) member.name = name.slice(0, 40);
    if (team !== undefined) member.team = team ? String(team).slice(0, 40) : null;
    member.role = normRole; // reflect (re)authorized role on reconnect
    member.connected = true;
  }
  room.members.set(id, member);
  return member;
}

export function setConnected(room, playerId, connected) {
  const m = room.members.get(playerId);
  if (m) m.connected = connected;
}

// Reader removes a single player (staff can't be removed this way).
export function removePlayer(room, playerId) {
  const m = room.members.get(playerId);
  if (!m || m.role !== 'player') return false;
  room.members.delete(playerId);
  room.queue = room.queue.filter((q) => q.playerId !== playerId);
  pushLog(room, { type: 'remove_player', playerId });
  return true;
}

// Reader clears every player out of the room. Returns the removed ids.
export function removeAllPlayers(room) {
  const ids = [...room.members.values()].filter((m) => m.role === 'player').map((m) => m.id);
  for (const id of ids) room.members.delete(id);
  room.queue = [];
  if (ids.length) pushLog(room, { type: 'remove_all_players', count: ids.length });
  return ids;
}

// --- buzz cycle state machine --------------------------------------------
// A room holds an ordered `queue` of who has buzzed.
//  - Default mode: the first wave of buzzes fills the queue, then phase locks
//    ('open' -> 'locked') so no one else can buzz until a staff reset.
//  - Queue mode: phase stays 'open' so buzzes keep accumulating; staff pop the
//    head ("next") or clear the whole queue, and players may withdraw.

// Manual "reset the buzzer" / "clear queue": empty it and reopen buzzers.
export function resetBuzzer(room) {
  room.cycleNo += 1;
  room.cycle = freshCycle(room.cycleNo);
  room.queue = [];
  room.phase = 'open';
  pushLog(room, { type: 'reset_buzzer', cycleNo: room.cycleNo });
}

// Queue mode: drop the current head so the next buzzer is "on the buzz".
export function nextBuzz(room) {
  room.queue.shift();
  if (!room.settings.queueMode) room.phase = room.queue.length ? 'locked' : 'open';
  pushLog(room, { type: 'next_buzz', head: room.queue[0]?.playerId || null });
}

// Queue mode: a player removes themselves (only if the room allows it).
export function withdraw(room, playerId) {
  if (!room.settings.allowWithdraw) return false;
  const before = room.queue.length;
  room.queue = room.queue.filter((q) => q.playerId !== playerId);
  if (room.queue.length !== before) pushLog(room, { type: 'withdraw', playerId });
  return room.queue.length !== before;
}

// Record an incoming buzz intent. Returns { accepted, reason, firstOfWindow }.
// `clampedTime` is the server-time the buzz is CREDITED at (see index.js for
// how it is computed and clamped). Ordering later uses this value.
export function recordBuzz(room, { playerId, clampedTime, arrival }) {
  if (room.phase !== 'open') return { accepted: false, reason: 'not_open' };
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return { accepted: false, reason: 'not_player' };
  if (room.queue.some((q) => q.playerId === playerId)) return { accepted: false, reason: 'queued' };

  const already = room.cycle.collected.filter((b) => b.playerId === playerId).length;
  if (already >= DEFAULTS.maxBuzzAttemptsPerCycle) return { accepted: false, reason: 'duplicate' };

  const firstOfWindow = room.cycle.collected.length === 0;
  if (firstOfWindow) room.cycle.windowOpenedAt = arrival;
  room.cycle.collected.push({ playerId, clampedTime, arrival });
  return { accepted: true, firstOfWindow };
}

// Close the reconcile window: rank this wave fairly and append to the queue.
// In default mode that also locks the room. Returns the full current queue.
export function resolveWindow(room) {
  const buzzes = [...room.cycle.collected].sort((a, b) => a.clampedTime - b.clampedTime);
  const base = buzzes.length ? buzzes[0].clampedTime : 0;
  for (const b of buzzes) {
    if (room.queue.some((q) => q.playerId === b.playerId)) continue; // already queued
    room.queue.push({
      playerId: b.playerId,
      name: room.members.get(b.playerId)?.name || '?',
      marginMs: Math.round(b.clampedTime - base)
    });
  }
  room.cycle = freshCycle(room.cycleNo); // ready to collect the next wave
  if (!room.settings.queueMode) room.phase = 'locked';
  pushLog(room, { type: 'buzz', cycleNo: room.cycleNo, head: room.queue[0]?.playerId, size: room.queue.length });
  return room.queue;
}

// Live-update room options (staff only; validated in index.js).
export function setOptions(room, opts = {}) {
  if (typeof opts.queueMode === 'boolean') room.settings.queueMode = opts.queueMode;
  if (typeof opts.allowWithdraw === 'boolean') room.settings.allowWithdraw = opts.allowWithdraw;
  if (typeof opts.autoClear === 'boolean') room.settings.autoClear = opts.autoClear;
  // Leaving queue mode collapses any queue back to the standard locked state.
  if (!room.settings.queueMode && room.queue.length) room.phase = 'locked';
  pushLog(room, { type: 'set_options', settings: room.settings });
}

function pushLog(room, entry) {
  room.log.push({ ...entry, at: Date.now() });
  if (room.log.length > 200) room.log.shift();
}

// Serializable snapshot sent to clients. Never includes secret tokens.
export function publicState(room) {
  return {
    code: room.code,
    name: room.name,
    tournamentCode: room.tournamentCode,
    phase: room.phase,
    cycleNo: room.cycleNo,
    settings: room.settings,
    queue: room.queue,
    members: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name, role: m.role, team: m.team, connected: m.connected, joinedAt: m.joinedAt
    }))
  };
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export const _internal = { rooms, tournaments };
