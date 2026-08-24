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
  settings: r.settings,
  // The loaded buzzer roster survives a restart; the per-buzzer assignments
  // don't, because members are runtime state (see hydrate).
  roster: r.roster,
  rosterTeams: r.rosterTeams
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
      roster: normalizeRoster(r.roster),
      rosterTeams: Array.isArray(r.rosterTeams) ? r.rosterTeams.map(String) : [],
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
    // Roster loaded from a QBJ registration file, so buzzers can be labelled
    // with the real player who is sitting behind them (see setRoster).
    roster: null,           // { name, teams: [{ name, players: [..] }] }
    rosterTeams: [],        // team names actually playing in this room
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
    tossupScheme: TOSSUP_SCHEMES.includes(f.tossupScheme) ? f.tossupScheme : '15/10/-5',
    // MASSINGER pick/ban: before each game, teams alternate protecting and
    // banning subcategories until `massingerTarget` tossups remain.
    massinger: f.massinger === true,
    massingerTimerSec: clampNum(f.massingerTimerSec, 0, 300, 30)
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
    // Set by the reader from the loaded roster (see assignRosterPlayer).
    rosterTeam: null,
    rosterPlayer: null,
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

// --- roster: which real player is behind each buzzer ----------------------
// A reader loads a QBJ registration file (parsed to { name, teams } by
// server/qbjroster.js), picks the teams playing in this room, then attaches a
// roster player to each connected buzzer. From then on that player's name is
// what the buzz queue reports — including to the MODAQ buzz panel, which reads
// the same public state.

// A room may only have a handful of teams at the buzzers; the cap keeps the
// per-buzzer picker (and the state we broadcast) small.
const MAX_ACTIVE_TEAMS = 8;

function normalizeRoster(roster) {
  const teams = (Array.isArray(roster?.teams) ? roster.teams : [])
    .map((t) => ({
      name: String(t?.name ?? '').slice(0, 60),
      players: (Array.isArray(t?.players) ? t.players : []).map((p) => String(p ?? '').slice(0, 60))
    }))
    .filter((t) => t.name && t.players.length);
  if (!teams.length) return null;
  return { name: String(roster?.name ?? '').slice(0, 80), teams };
}

const teamNames = (room) => (room.roster?.teams || []).map((t) => t.name);

// Drop any per-buzzer assignment the roster no longer backs (team removed from
// the room, roster replaced, player gone). Called after every roster change so
// a stale assignment can never keep announcing a name that isn't in play.
function pruneAssignments(room) {
  const active = new Map(
    (room.roster?.teams || [])
      .filter((t) => room.rosterTeams.includes(t.name))
      .map((t) => [t.name, new Set(t.players)])
  );
  for (const m of room.members.values()) {
    if (!m.rosterTeam) continue;
    if (!active.get(m.rosterTeam)?.has(m.rosterPlayer)) {
      m.rosterTeam = null;
      m.rosterPlayer = null;
    }
  }
  refreshQueueNames(room);
}

// An already-resolved queue carries the name it was resolved under; relabel it
// so a buzz that is still waiting on the reader picks up a just-made assignment.
function refreshQueueNames(room) {
  for (const q of room.queue) q.name = displayName(room.members.get(q.playerId));
}

// Load (or replace) the room's roster. Small rosters — a normal two-team room —
// start with every team active so the reader can assign buzzers immediately;
// for a whole-tournament roster file they pick the teams playing here first.
export function setRoster(room, roster) {
  room.roster = normalizeRoster(roster);
  room.rosterTeams = room.roster && room.roster.teams.length <= MAX_ACTIVE_TEAMS
    ? teamNames(room)
    : [];
  pruneAssignments(room);
  pushLog(room, { type: 'set_roster', teams: room.roster?.teams.length || 0 });
  persistRooms();
  return room.roster;
}

export function clearRoster(room) {
  room.roster = null;
  room.rosterTeams = [];
  pruneAssignments(room);
  pushLog(room, { type: 'clear_roster' });
  persistRooms();
}

// The teams actually playing in this room — the pool the per-buzzer picker
// offers. Unknown names are ignored, so a client can't invent teams.
export function setRosterTeams(room, names) {
  const known = new Set(teamNames(room));
  const picked = [];
  for (const n of Array.isArray(names) ? names : []) {
    const name = String(n ?? '');
    if (known.has(name) && !picked.includes(name)) picked.push(name);
    if (picked.length >= MAX_ACTIVE_TEAMS) break;
  }
  room.rosterTeams = picked;
  pruneAssignments(room);
  persistRooms();
  return room.rosterTeams;
}

// Attach a roster player to one buzzer (or clear it with a null player). The
// pairing is exclusive: handing a name to a second device takes it off the
// first, so two buzzers can never both claim to be the same player.
export function assignRosterPlayer(room, playerId, team, player) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return false;
  if (!team || !player) {
    member.rosterTeam = null;
    member.rosterPlayer = null;
    refreshQueueNames(room);
    return true;
  }
  const t = (room.roster?.teams || []).find((x) => x.name === team);
  if (!t || !room.rosterTeams.includes(t.name) || !t.players.includes(player)) return false;
  for (const other of room.members.values()) {
    if (other !== member && other.rosterTeam === t.name && other.rosterPlayer === player) {
      other.rosterTeam = null;
      other.rosterPlayer = null;
    }
  }
  member.rosterTeam = t.name;
  member.rosterPlayer = player;
  refreshQueueNames(room);
  pushLog(room, { type: 'assign_roster_player', playerId, team: t.name, player });
  return true;
}

// What everyone should be shown (and told) when this buzzer goes off: the
// roster player once assigned, otherwise whatever they typed on the join gate.
export const displayName = (member) => member?.rosterPlayer || member?.name || '?';

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
      name: displayName(room.members.get(b.playerId)),
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
    // MASSINGER pick/ban board (null outside the pick/ban phase). Fully
    // public: players watch the same board the moderator drives.
    massinger: room.massinger || null,
    queue: room.queue,
    // Every team name (so the reader can pick who's playing here) but only the
    // active teams' player lists, which is all the per-buzzer picker needs and
    // keeps a whole-tournament roster out of every state broadcast.
    roster: room.roster && {
      name: room.roster.name,
      teamNames: teamNames(room),
      teams: room.roster.teams.filter((t) => room.rosterTeams.includes(t.name))
    },
    members: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name, role: m.role, team: m.team, connected: m.connected, joinedAt: m.joinedAt,
      rosterTeam: m.rosterTeam || null, rosterPlayer: m.rosterPlayer || null,
      displayName: displayName(m)
    }))
  };
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// --- MASSINGER pick/ban ----------------------------------------------------
// Server-authoritative pick/ban of subcategories before a game (see the
// MASSINGER format): the two teams alternate protecting and banning one
// subcategory at a time until `target` tossups remain. The MODERATOR is the
// only writer — players watch the board via publicState. A subcategory with
// two questions loses ONE per ban (the later one in packet order) and the
// other stays bannable later; a protected subcategory can't be banned at all.
//
// State is plain JSON so it broadcasts as-is and persists per room+round
// (index.js writes it through artifacts.saveMassinger on every change).

const massingerRemaining = (m) =>
  m.subcats.reduce((sum, sc) => sum + (sc.indexes.length - sc.banned), 0);

// (Re)arm the per-turn clock. timerSec 0 disables the timer.
function massingerArm(m, now = Date.now()) {
  m.turnStartedAt = now;
  m.deadline = m.timerSec > 0 ? now + m.timerSec * 1000 : null;
}

function massingerFinishIfDone(m) {
  if (massingerRemaining(m) <= m.target) {
    m.status = 'done';
    m.deadline = null;
  }
}

export function massingerStart(room, { round, subcats, teams, timerSec, target } = {}) {
  const labels = new Set();
  const clean = [];
  for (const sc of Array.isArray(subcats) ? subcats : []) {
    const label = String(sc?.label || '').trim().slice(0, 80);
    const indexes = (Array.isArray(sc?.indexes) ? sc.indexes : [])
      .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 500);
    if (!label || labels.has(label) || indexes.length === 0) continue;
    labels.add(label);
    clean.push({ label, indexes, protectedBy: null, banned: 0 });
  }
  if (clean.length === 0) return { error: 'no_subcats' };
  const total = clean.reduce((sum, sc) => sum + sc.indexes.length, 0);
  const m = {
    round: String(round ?? '').slice(0, 60),
    status: 'active',
    teams: [0, 1].map((i) => String(teams?.[i] ?? '').trim().slice(0, 60) || `Team ${'AB'[i]}`),
    turn: 0,
    timerSec: clampNum(timerSec, 0, 300, 30),
    target: clampNum(target, 1, total, 20),
    subcats: clean,
    actions: []
  };
  massingerArm(m);
  massingerFinishIfDone(m);
  room.massinger = m;
  return { ok: true };
}

// Load a previously persisted board (moderator reload / server restart).
export function massingerRestore(room, saved) {
  if (!saved || !Array.isArray(saved.subcats)) return { error: 'bad_state' };
  room.massinger = saved;
  // Never resume into a live countdown from the distant past.
  if (saved.status === 'active') massingerArm(saved);
  return { ok: true };
}

export function massingerPick(room, { type, label } = {}) {
  const m = room.massinger;
  if (!m || m.status !== 'active') return { error: 'not_active' };
  const sc = m.subcats.find((x) => x.label === label);
  if (!sc) return { error: 'no_subcat' };
  if (sc.protectedBy != null) return { error: 'protected' };
  if (sc.banned >= sc.indexes.length) return { error: 'exhausted' };
  if (type === 'protect') {
    sc.protectedBy = m.turn;
  } else if (type === 'ban') {
    sc.banned += 1;
  } else {
    return { error: 'bad_type' };
  }
  m.actions.push({ type, label, team: m.turn, at: Date.now() });
  m.turn = 1 - m.turn;
  massingerArm(m);
  massingerFinishIfDone(m);
  return { ok: true };
}

// The moderator decides which team is picking; auto-alternation is only the default.
export function massingerSetTurn(room, team) {
  const m = room.massinger;
  if (!m || m.status !== 'active') return { error: 'not_active' };
  if (team !== 0 && team !== 1) return { error: 'bad_team' };
  m.turn = team;
  massingerArm(m);
  return { ok: true };
}

export function massingerSetTeams(room, teams) {
  const m = room.massinger;
  if (!m) return { error: 'not_active' };
  m.teams = [0, 1].map((i) => String(teams?.[i] ?? '').trim().slice(0, 60) || m.teams[i]);
  return { ok: true };
}

export function massingerUndo(room) {
  const m = room.massinger;
  if (!m) return { error: 'not_active' };
  const last = m.actions.pop();
  if (!last) return { error: 'nothing_to_undo' };
  const sc = m.subcats.find((x) => x.label === last.label);
  if (sc) {
    if (last.type === 'protect') sc.protectedBy = null;
    else sc.banned = Math.max(0, sc.banned - 1);
  }
  m.status = 'active';
  m.turn = last.team;   // it's that team's turn again
  massingerArm(m);
  return { ok: true };
}

// Timer enforcement: apply a random legal ban for the team on the clock.
export function massingerRandomBan(room) {
  const m = room.massinger;
  if (!m || m.status !== 'active') return { error: 'not_active' };
  const bannable = m.subcats.filter((sc) => sc.protectedBy == null && sc.banned < sc.indexes.length);
  if (bannable.length === 0) return { error: 'exhausted' };
  const sc = bannable[Math.floor(Math.random() * bannable.length)];
  return massingerPick(room, { type: 'ban', label: sc.label });
}

export function massingerCancel(room) {
  room.massinger = null;
  return { ok: true };
}

export const _internal = { rooms, tournaments };
