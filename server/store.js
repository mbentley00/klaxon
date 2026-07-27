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

// --- persistence -----------------------------------------------------------
// Tournament records and room IDENTITIES (codes, tokens, settings — not live
// buzz state) must survive restarts/deploys, or every director console link
// and reader link dies with the process. index.js injects the actual disk
// writers (artifacts.js) at boot; this module stays fs-free.
let persistence = null; // { tournament(record), rooms(records) }

export function setPersistence(p) {
  persistence = p;
}

const serializeTournament = (t) => ({ ...t, roomCodes: [...t.roomCodes] });
const serializeRoom = (r) => ({
  code: r.code,
  name: r.name,
  tournamentCode: r.tournamentCode,
  createdAt: r.createdAt,
  readerToken: r.readerToken,
  coReaderToken: r.coReaderToken,
  settings: r.settings
});

const persistTournament = (t) => persistence?.tournament(serializeTournament(t));
const persistRooms = () => persistence?.rooms([...rooms.values()].map(serializeRoom));

// Reload persisted records at boot (before setPersistence, so hydration never
// triggers writes). Rooms come back with fresh runtime state: an interrupted
// buzz cycle doesn't survive a restart, but the links and settings do.
export function hydrate({ tournaments: tournamentRecords = [], rooms: roomRecords = [] } = {}) {
  for (const t of tournamentRecords) {
    if (!t?.code || !t.directorToken) continue;
    tournaments.set(t.code, {
      ...t,
      roomCodes: new Set(Array.isArray(t.roomCodes) ? t.roomCodes : []),
      roomDefaults: normalizeRoomDefaults(t.roomDefaults),
      format: normalizeFormat(t.format),
      schedule: normalizeSchedule(t.schedule),
      links: normalizeLinks(t.links),
      autoRelease: t.autoRelease === true
    });
  }
  for (const r of roomRecords) {
    if (!r?.code || !r.readerToken) continue;
    rooms.set(r.code, {
      ...r,
      coReaderToken: r.coReaderToken || secretToken(),
      // playerAlerts defaults ON, so rooms persisted before it existed get it.
      settings: { ...(r.settings || {}), playerAlerts: r.settings?.playerAlerts !== false },
      phase: 'open',
      cycleNo: 1,
      cycle: freshCycle(1),
      lastBuzzAt: null,
      queue: [],
      members: new Map(),
      log: []
    });
  }
}

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
      autoClear: !!eff.autoClear,         // auto-reset the buzzer a few seconds after a buzz
      requireTeam: !!eff.requireTeam,     // players must supply a team name to join
      playerAlerts: eff.playerAlerts !== false, // players may flag a stuck buzzer (on by default)
      modaqMode: !!eff.modaqMode,         // reader gets the embedded MODAQ reader + buzz panel
      modaqLite: !!eff.modaqLite          // lightweight MODAQ: reader + buzzer only, no tournament artifacts
    },
    phase: 'open',          // open | locked  — buzzers are live by default
    cycleNo: 1,
    cycle: freshCycle(1),
    lastBuzzAt: null,        // server time the current queue's first buzz resolved
    queue: [],               // [{ playerId, name, marginMs }] in buzz order
    members: new Map(),      // playerId -> member
    log: []                 // recent events for late joiners / audit
  };
  rooms.set(code, room);

  if (tournamentCode && tournaments.has(tournamentCode)) {
    tournaments.get(tournamentCode).roomCodes.add(code);
    persistTournament(tournaments.get(tournamentCode));
  }
  persistRooms();
  return room;
}

export function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

// Which artifact bucket a room's MODAQ files live in: the tournament's, if the
// room belongs to one (so a whole tournament shares rosters/packets/exports),
// otherwise the room's own bucket (a standalone MODAQ room still works).
export function bucketForRoom(room) {
  if (room?.tournamentCode && tournaments.has(room.tournamentCode)) {
    return { kind: 't', code: room.tournamentCode };
  }
  return { kind: 'r', code: room.code };
}

export function createTournament({ name, schedule = [], defaults = {}, format = {}, requireReaderAccounts = false, date = '', listed = false }) {
  let code;
  do { code = roomCode(5); } while (tournaments.has(code));
  const t = {
    code,
    name: (name || `Tournament ${code}`).slice(0, 80),
    createdAt: Date.now(),
    // Tournament date (YYYY-MM-DD, as supplied by the client).
    date: String(date || '').slice(0, 10),
    // If true, appears in the public tournament directory so moderators can find
    // it and request to join.
    listed: !!listed,
    directorToken: secretToken(),
    roomCodes: new Set(),
    // Settings every room created in this tournament starts with (see createRoom).
    roomDefaults: normalizeRoomDefaults(defaults),
    // Scoring format the moderators read with (tossup point scheme + bonuses).
    format: normalizeFormat(format),
    // If true, readers must have a director-approved account to access the
    // tournament's centralized packets.
    requireReaderAccounts: !!requireReaderAccounts,
    schedule: normalizeSchedule(schedule),
    // Player-facing links the director can set (shown in every room's
    // tournament strip): the tournament schedule and its Discord server.
    links: normalizeLinks(),
    // When true, the next hidden packet is released automatically as soon as
    // every expected room's game in the current round goes final.
    autoRelease: false
  };
  tournaments.set(code, t);
  persistTournament(t);
  return t;
}

// The three supported tossup point schemes.
export const TOSSUP_SCHEMES = ['15/10/-5', '20/15/10/-5', '20/10/0'];
function normalizeFormat(f = {}) {
  return {
    hasBonuses: f.hasBonuses !== false, // default: bonuses on
    tossupScheme: TOSSUP_SCHEMES.includes(f.tossupScheme) ? f.tossupScheme : '15/10/-5'
  };
}

// Whitelist + coerce the per-room defaults a tournament director can set.
function normalizeRoomDefaults(d = {}) {
  const out = {};
  if (typeof d.queueMode === 'boolean') out.queueMode = d.queueMode;
  if (typeof d.allowWithdraw === 'boolean') out.allowWithdraw = d.allowWithdraw;
  if (typeof d.autoClear === 'boolean') out.autoClear = d.autoClear;
  if (typeof d.requireTeam === 'boolean') out.requireTeam = d.requireTeam;
  if (typeof d.playerAlerts === 'boolean') out.playerAlerts = d.playerAlerts;
  if (typeof d.modaqMode === 'boolean') out.modaqMode = d.modaqMode;
  if (typeof d.modaqLite === 'boolean') out.modaqLite = d.modaqLite;
  return out;
}

export function getTournament(code) {
  return tournaments.get((code || '').toUpperCase());
}

// Public directory of tournaments the director opted to list. Sorted by date
// (soonest first), then name.
export function listTournaments() {
  return [...tournaments.values()]
    .filter((t) => t.listed)
    .map((t) => ({
      code: t.code, name: t.name, date: t.date || '',
      requireReaderAccounts: !!t.requireReaderAccounts
    }))
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.name.localeCompare(b.name));
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
  persistTournament(tournament);
  return tournament.schedule;
}

// Only http(s) URLs make it through — these render as links for players.
function normalizeLinks(l = {}) {
  const clean = (u) => {
    const s = String(u || '').trim().slice(0, 400);
    return /^https?:\/\//i.test(s) ? s : '';
  };
  return { schedule: clean(l.schedule), discord: clean(l.discord) };
}

export function setLinks(tournament, links) {
  tournament.links = normalizeLinks(links);
  persistTournament(tournament);
  return tournament.links;
}

export function setAutoRelease(tournament, enabled) {
  tournament.autoRelease = enabled === true;
  persistTournament(tournament);
  return tournament.autoRelease;
}

// Secret key for the player landing page (/tp/CODE?key=...): shareable by the
// director, not guessable from the tournament code. Minted on first use so
// tournaments created before this feature get one too.
export function ensurePlayerKey(tournament) {
  if (!tournament.playerKey) {
    tournament.playerKey = roomCode(12);
    persistTournament(tournament);
  }
  return tournament.playerKey;
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
  room.lastBuzzAt = null;
  room.phase = 'open';
  pushLog(room, { type: 'reset_buzzer', cycleNo: room.cycleNo });
}

// Queue mode: drop the current head so the next buzzer is "on the buzz".
export function nextBuzz(room) {
  room.queue.shift();
  if (!room.queue.length) room.lastBuzzAt = null;
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
  // Stamped once per unresolved queue: the "is the buzzer stuck?" clock that
  // gates player alerts runs from the FIRST buzz still waiting on the reader.
  if (room.lastBuzzAt == null && room.queue.length) room.lastBuzzAt = Date.now();
  if (!room.settings.queueMode) room.phase = 'locked';
  pushLog(room, { type: 'buzz', cycleNo: room.cycleNo, head: room.queue[0]?.playerId, size: room.queue.length });
  return room.queue;
}

// Live-update room options (staff only; validated in index.js).
export function setOptions(room, opts = {}) {
  if (typeof opts.queueMode === 'boolean') room.settings.queueMode = opts.queueMode;
  if (typeof opts.allowWithdraw === 'boolean') room.settings.allowWithdraw = opts.allowWithdraw;
  if (typeof opts.autoClear === 'boolean') room.settings.autoClear = opts.autoClear;
  if (typeof opts.requireTeam === 'boolean') room.settings.requireTeam = opts.requireTeam;
  if (typeof opts.playerAlerts === 'boolean') room.settings.playerAlerts = opts.playerAlerts;
  if (typeof opts.modaqMode === 'boolean') room.settings.modaqMode = opts.modaqMode;
  if (typeof opts.modaqLite === 'boolean') room.settings.modaqLite = opts.modaqLite;
  // Leaving queue mode collapses any queue back to the standard locked state.
  if (!room.settings.queueMode && room.queue.length) room.phase = 'locked';
  pushLog(room, { type: 'set_options', settings: room.settings });
  persistRooms();
}

// --- "the buzzer isn't clear" alerts --------------------------------------
// A player whose buzz has sat unjudged can ping the moderator. Deliberately
// gated: only while a buzz is actually outstanding, only after the buzzer has
// been stuck for a while, and at most once per player per cooldown — so it
// can't be turned into a way to spam the reader mid-question.
export const STUCK_ALERT_DELAY_MS = 10000;
export const STUCK_ALERT_COOLDOWN_MS = 20000;

export function stuckAlertReady(room, now = Date.now()) {
  if (!room.settings.playerAlerts) return false;
  if (!room.queue.length || room.lastBuzzAt == null) return false;
  return now - room.lastBuzzAt >= STUCK_ALERT_DELAY_MS;
}

export function raiseStuckAlert(room, playerId) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return { ok: false, reason: 'not_player' };
  if (!room.settings.playerAlerts) return { ok: false, reason: 'disabled' };
  const now = Date.now();
  if (!stuckAlertReady(room, now)) return { ok: false, reason: 'too_soon' };
  if (now - (member.lastAlertAt || 0) < STUCK_ALERT_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
  member.lastAlertAt = now;
  pushLog(room, { type: 'stuck_alert', playerId });
  return { ok: true, member };
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
    // Server time of the buzz the room is waiting on (null when clear) — the
    // player's "buzzer isn't clear" button counts down from it.
    lastBuzzAt: room.lastBuzzAt ?? null,
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
