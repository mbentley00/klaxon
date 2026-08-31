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
  rosterTeams: r.rosterTeams,
  // The player-facing scoresheet of the game being read (already sanitized).
  scoresheet: r.scoresheet || null,
  // Every buzz attempt, for the full-buzz export (buzz-point tracking).
  buzzLog: r.buzzLog || []
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
      autoRelease: t.autoRelease === true,
      playerScoresheet: t.playerScoresheet !== false
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
      // Players pick their team (and name) from the roster instead of typing.
      rosterJoin: eff.rosterJoin === true,
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

export function createTournament({ name, schedule = [], defaults = {}, format = {}, requireReaderAccounts = false, date = '', listed = false, playerScoresheet = true }) {
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
    autoRelease: false,
    // Players in MODAQ-mode rooms see a live scoresheet of the game (built
    // server-side from the reader's game, see playerScoresheet). Default on.
    playerScoresheet: playerScoresheet !== false
  };
  tournaments.set(code, t);
  persistTournament(t);
  return t;
}

// The three supported tossup point schemes.
export const TOSSUP_SCHEMES = ['15/10/-5', '20/15/10/-5', '20/10/0'];

// Who may make a MASSINGER pick (see massingerCanPick).
export const MASSINGER_CONTROLS = ['moderator', 'captain', 'anyone'];
function normalizeFormat(f = {}) {
  return {
    hasBonuses: f.hasBonuses !== false, // default: bonuses on
    tossupScheme: TOSSUP_SCHEMES.includes(f.tossupScheme) ? f.tossupScheme : '15/10/-5',
    // MASSINGER pick/ban: before each game, teams alternate protecting and
    // banning subcategories until `massingerTarget` tossups remain.
    massinger: f.massinger === true,
    massingerTimerSec: clampNum(f.massingerTimerSec, 0, 300, 30),
    // Who makes the picks by default: 'moderator' | 'captain' | 'anyone'.
    massingerControl: MASSINGER_CONTROLS.includes(f.massingerControl) ? f.massingerControl : 'captain'
  };
}

// Whitelist + coerce the per-room defaults a tournament director can set.
function normalizeRoomDefaults(d = {}) {
  const out = {};
  if (typeof d.queueMode === 'boolean') out.queueMode = d.queueMode;
  if (typeof d.allowWithdraw === 'boolean') out.allowWithdraw = d.allowWithdraw;
  if (typeof d.autoClear === 'boolean') out.autoClear = d.autoClear;
  if (typeof d.requireTeam === 'boolean') out.requireTeam = d.requireTeam;
  if (typeof d.rosterJoin === 'boolean') out.rosterJoin = d.rosterJoin;
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

// Every tournament (for share-token resolution) and an explicit persist hook
// for records the routes mutate in place (share links).
export function allTournaments() {
  return tournaments.values();
}
export function persistTournamentRecord(tournament) {
  persistTournament(tournament);
}

export function setAutoRelease(tournament, enabled) {
  tournament.autoRelease = enabled === true;
  persistTournament(tournament);
  return tournament.autoRelease;
}

export function setPlayerScoresheet(tournament, enabled) {
  tournament.playerScoresheet = enabled !== false;
  persistTournament(tournament);
  return tournament.playerScoresheet;
}

// Do this room's players get the live scoresheet? A tournament-level choice
// (default on); a room outside any tournament (MODAQ lite) always shows it.
export function playerScoresheetOn(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  return !t || t.playerScoresheet !== false;
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
export function joinRoom(room, { playerId, name, role, team, rosterTeam, rosterPlayer }) {
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
    // A team the MODERATOR put this buzzer on (see setMemberTeam). Distinct
    // from `team`, which is whatever the player typed on the join gate and
    // which nobody has vouched for.
    assignedTeam: null,
    // Their team's captain, when the pick/ban is captain-controlled.
    isCaptain: false,
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

  // A player who picked themselves out of the roster is linked right away, and
  // their buzzes carry the roster name. An unknown name in a room that HAS a
  // roster is flagged so the director hears about it (see index.js).
  member.offRoster = false;
  if (role === 'player' && room.roster) {
    const wanted = String(rosterPlayer ?? '').trim();
    const wantedTeam = String(rosterTeam ?? '').trim();
    if (wanted && wantedTeam) {
      if (!assignRosterPlayer(room, id, wantedTeam, wanted)) {
        member.offRoster = true;      // asked for someone who isn't there
      }
    } else if (!member.rosterPlayer) {
      member.offRoster = true;
    }
  }
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

// Build the room's roster straight from the teams a moderator entered in
// MODAQ's New Game dialog, then link the buzzers to those players by name.
// This is what ties a buzz to a real MODAQ player in every mode: the reader no
// longer has to load a roster file for the names to line up.
export function setRosterFromGameTeams(room, teams) {
  const clean = [];
  for (const team of Array.isArray(teams) ? teams : []) {
    const name = String(team?.name ?? '').trim().slice(0, 60);
    const players = (Array.isArray(team?.players) ? team.players : [])
      .map((p) => String(p ?? '').trim().slice(0, 60))
      .filter(Boolean);
    if (name && players.length && !clean.some((t) => t.name === name)) {
      clean.push({ name, players });
    }
  }
  if (clean.length === 0) return { error: 'no_teams' };
  setRoster(room, { name: 'MODAQ game', teams: clean });
  setRosterTeams(room, clean.map((t) => t.name));
  const linked = autoLinkRosterPlayers(room);
  return { ok: true, teams: clean.length, linked };
}

// Attach every unassigned buzzer to the roster player whose name matches what
// that person typed on the join gate (case- and punctuation-insensitive, and
// also matching on first name when that's unambiguous). Names nobody matches
// are left for the moderator to assign by hand — a guess that pins the wrong
// name to a buzzer would be worse than leaving it blank.
export function autoLinkRosterPlayers(room) {
  if (!room.roster) return 0;
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const taken = new Set();
  for (const m of room.members.values()) {
    if (m.rosterTeam && m.rosterPlayer) taken.add(`${m.rosterTeam}\u0000${m.rosterPlayer}`);
  }

  // Candidate pool: every player on a team playing in this room.
  const pool = [];
  for (const team of room.roster.teams) {
    if (!room.rosterTeams.includes(team.name)) continue;
    for (const player of team.players) {
      if (!taken.has(`${team.name}\u0000${player}`)) pool.push({ team: team.name, player });
    }
  }

  let linked = 0;
  for (const member of room.members.values()) {
    if (member.role !== 'player' || member.rosterPlayer) continue;
    const typed = norm(member.name);
    if (!typed) continue;
    const memberTeam = norm(member.team);
    // Prefer an exact full-name match, and prefer one on the team they typed.
    let matches = pool.filter((c) => norm(c.player) === typed);
    if (matches.length === 0) {
      const first = typed.split(' ')[0];
      matches = pool.filter((c) => norm(c.player).split(' ')[0] === first);
    }
    if (matches.length > 1 && memberTeam) {
      const onTeam = matches.filter((c) => norm(c.team) === memberTeam);
      if (onTeam.length) matches = onTeam;
    }
    if (matches.length !== 1) continue;   // ambiguous: leave it to the moderator
    const match = matches[0];
    if (assignRosterPlayer(room, member.id, match.team, match.player)) {
      pool.splice(pool.indexOf(match), 1);
      linked++;
    }
  }
  if (linked) persistRooms();
  return linked;
}

// The team a buzzer counts as being on, most-vouched-for first: the roster
// player they're linked to, then a team the moderator put them on, and only
// then whatever they typed on the join gate.
export const effectiveTeam = (member) =>
  member?.rosterTeam || member?.assignedTeam || member?.team || '';

// The moderator puts a connected buzzer on a team by hand — for a player whose
// name didn't match the roster, a sub, or anyone who typed the wrong thing.
// Passing an empty team clears it (back to whatever they typed).
export function setMemberTeam(room, playerId, team) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return { error: 'no_member' };
  const name = String(team ?? '').trim().slice(0, 60);
  if (name === '') {
    member.assignedTeam = null;
    member.isCaptain = false;         // a captain has to be on a team
  } else {
    const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Compare against the team they COUNT as being on, not just a previous
    // assignment: confirming what they already were keeps them captain.
    if (norm(effectiveTeam(member)) !== norm(name)) member.isCaptain = false;
    member.assignedTeam = name;
  }
  refreshQueueNames(room);
  pushLog(room, { type: 'set_member_team', playerId, team: member.assignedTeam });
  persistRooms();
  return { ok: true };
}

// One captain per team: naming a new one stands the old one down.
export function setCaptain(room, playerId, isCaptain) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return { error: 'no_member' };
  if (!isCaptain) {
    member.isCaptain = false;
    persistRooms();
    return { ok: true };
  }
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const team = norm(effectiveTeam(member));
  if (team === '') return { error: 'no_team' };
  for (const other of room.members.values()) {
    if (other !== member && norm(effectiveTeam(other)) === team) other.isCaptain = false;
  }
  member.isCaptain = true;
  pushLog(room, { type: 'set_captain', playerId, team: effectiveTeam(member) });
  persistRooms();
  return { ok: true };
}

// Is there a captain for this team? (The pick/ban warns when there isn't.)
export function captainFor(room, teamName) {
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(teamName);
  for (const member of room.members.values()) {
    if (member.isCaptain && norm(effectiveTeam(member)) === want) return member;
  }
  return null;
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
// Every buzz ATTEMPT — including ones that lost to the lock or arrived after
// the window — goes into the room's full buzz log, stamped with the MODAQ
// question being read. Exported later for buzz-point tracking, so a player who
// buzzed second still shows up even without queue mode.
const FULL_BUZZ_CAP = 5000;
function logBuzzAttempt(room, member, { clampedTime, arrival, accepted, reason }) {
  if (!room.buzzLog) room.buzzLog = [];
  room.buzzLog.push({
    at: arrival,
    t: clampedTime,
    cycleNo: room.cycleNo,
    playerId: member.id,
    name: displayName(member),
    team: effectiveTeam(member) || null,
    modaqPlayer: member.rosterPlayer || null,
    round: room.modaqState?.round ?? null,
    question: room.scoresheet?.current ?? null,
    accepted,
    reason: reason || null
  });
  if (room.buzzLog.length > FULL_BUZZ_CAP) room.buzzLog.splice(0, room.buzzLog.length - FULL_BUZZ_CAP);
}

export function recordBuzz(room, { playerId, clampedTime, arrival }) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return { accepted: false, reason: 'not_player' };
  if (room.phase !== 'open') {
    // Locked to an earlier buzz: still worth remembering that they tried.
    logBuzzAttempt(room, member, { clampedTime, arrival, accepted: false, reason: 'locked' });
    return { accepted: false, reason: 'not_open' };
  }
  if (room.queue.some((q) => q.playerId === playerId)) return { accepted: false, reason: 'queued' };

  const already = room.cycle.collected.filter((b) => b.playerId === playerId).length;
  if (already >= DEFAULTS.maxBuzzAttemptsPerCycle) return { accepted: false, reason: 'duplicate' };

  const firstOfWindow = room.cycle.collected.length === 0;
  if (firstOfWindow) room.cycle.windowOpenedAt = arrival;
  room.cycle.collected.push({ playerId, clampedTime, arrival });
  logBuzzAttempt(room, member, { clampedTime, arrival, accepted: true });
  return { accepted: true, firstOfWindow };
}

// The room's buzz attempts with per-cycle ordering, ready to download.
export function fullBuzzExport(room) {
  const byCycle = new Map();
  for (const b of room.buzzLog || []) {
    if (!byCycle.has(b.cycleNo)) byCycle.set(b.cycleNo, []);
    byCycle.get(b.cycleNo).push(b);
  }
  const buzzes = [];
  for (const list of byCycle.values()) {
    const accepted = list.filter((b) => b.accepted).sort((a, b) => a.t - b.t);
    const first = accepted[0];
    for (const b of list) {
      const order = b.accepted ? accepted.indexOf(b) + 1 : null;
      buzzes.push({ ...b, order, msAfterFirst: first ? Math.max(0, Math.round(b.t - first.t)) : null });
    }
  }
  buzzes.sort((a, b) => a.at - b.at);
  return {
    format: 'klaxon-fullbuzz-1',
    room: room.code,
    name: room.name,
    exportedAt: Date.now(),
    buzzes
  };
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
  persistRooms();                        // the full buzz log survives a restart
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
// What the join gate needs before anyone has joined: the teams playing here
// and their players, so a player can pick themselves rather than type a name
// nobody can match. Only offered when the room asks players to join this way.
export function joinRoster(room) {
  if (!room.settings.rosterJoin || !room.roster) return null;
  const active = room.rosterTeams.length ? room.rosterTeams : teamNames(room);
  const taken = new Set();
  for (const m of room.members.values()) {
    if (m.rosterTeam && m.rosterPlayer) taken.add(`${m.rosterTeam}\u0000${m.rosterPlayer}`);
  }
  return {
    teams: room.roster.teams
      .filter((t) => active.includes(t.name))
      .map((t) => ({
        name: t.name,
        // Mark who is already on a buzzer so two people don't pick the same
        // player (the server would unseat the first one).
        players: t.players.map((name) => ({ name, taken: taken.has(`${t.name}\u0000${name}`) }))
      }))
  };
}

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
    // Live scoresheet of the MODAQ game (null when there's no game, or the
    // tournament turned it off). Built by buildPlayerScoresheet(): only what the
    // players in the room have already heard.
    scoresheet: playerScoresheetOn(room) ? room.scoresheet || null : null,
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
      assignedTeam: m.assignedTeam || null, isCaptain: m.isCaptain === true,
      offRoster: m.offRoster === true,
      effectiveTeam: effectiveTeam(m) || null,
      displayName: displayName(m)
    }))
  };
}

// --- Player scoresheet -------------------------------------------------------
// The moderator's MODAQ game, as the players in the room may see it. This is a
// WHITELIST, not a copy: the raw QBJ match is never sent to players. It carries
// protest reasons and thrown-out notes in `notes`, the packet name, and buzz
// word positions — none of which belong on a player's screen — and, more to
// the point, whatever the reader has clicked on questions nobody has heard yet.
//
// So the sheet holds only: team + player names, and per question (a) which
// players buzzed and what it was worth, (b) the bonus parts' points, and (c)
// running totals — and ONLY up to the question the reader is on (the events
// on that one are what the room is hearing judged live, exactly as MODAQ's
// own Events panel shows them). A reader who jumps ahead by mistake (Next
// twice, the question chooser, a stray click that scores a later tossup)
// reveals nothing: rows past the current question are never sent, and the
// sheet is rebuilt from scratch on every update rather than accumulated, so
// it retracts the moment they navigate back.
const SCORESHEET_MAX_ROWS = 100;
const SCORESHEET_MAX_PLAYERS = 12;
const label = (v) => String(v ?? '').slice(0, 80);
const pts = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function buildPlayerScoresheet(match, currentQuestion, hasBonuses = true, protests = []) {
  // Protests, whitelisted field by field. Everything here was said out loud in
  // the room (who protested, on what, the answer they gave) — the moderator's
  // free-text reasoning stays out.
  const protestsByCycle = new Map();
  for (const p of Array.isArray(protests) ? protests : []) {
    const cycle = Number(p?.cycle);
    if (!Number.isFinite(cycle) || cycle < 1) continue;
    if (!protestsByCycle.has(cycle)) protestsByCycle.set(cycle, []);
    if (protestsByCycle.get(cycle).length >= 8) continue;
    protestsByCycle.get(cycle).push({
      type: p.type === 'bonus' ? 'bonus' : 'tossup',
      team: label(p.team),
      question: pts(p.question) || null,
      part: p.part == null ? null : pts(p.part),
      position: p.position == null ? null : pts(p.position),
      givenAnswer: label(p.givenAnswer)
    });
  }
  if (!match || typeof match !== 'object' || !Array.isArray(match.match_teams)) return null;
  const teams = match.match_teams.slice(0, 2).map((mt) => ({
    name: label(mt?.team?.name),
    players: (Array.isArray(mt?.match_players) ? mt.match_players : [])
      .slice(0, SCORESHEET_MAX_PLAYERS)
      .map((mp) => label(mp?.player?.name))
      .filter(Boolean)
  }));
  if (teams.length < 2 || teams.some((t) => !t.name)) return null;
  const teamIndex = (name) => teams.findIndex((t) => t.name === label(name));

  const cur = Number(currentQuestion);
  const through = Number.isFinite(cur) && cur >= 1 ? Math.floor(cur) : 0;
  // How many tossup rows the game has (MODAQ lists them all, later ones with
  // the score carried forward). Never fewer than the rows we send.
  const total = Math.max(through, Math.min(SCORESHEET_MAX_ROWS, Math.floor(Number(match.tossups_read)) || 0));

  const questions = Array.isArray(match.match_questions) ? match.match_questions : [];
  const totals = [0, 0];
  const rows = [];
  for (const q of questions) {
    const n = Number(q?.question_number);
    if (!Number.isFinite(n) || n < 1 || n > through) continue;
    if (rows.length >= SCORESHEET_MAX_ROWS) break;
    const buzzes = [];
    for (const b of Array.isArray(q.buzzes) ? q.buzzes : []) {
      const ti = teamIndex(b?.team?.name);
      if (ti < 0) continue;
      const points = pts(b?.result?.value);
      buzzes.push({ team: ti, player: label(b?.player?.name), points });
      totals[ti] += points;
    }
    let bonus = null;
    // A game without bonuses (tossup-only packet or format) shows no bonus
    // lines at all — MODAQ still emits empty ones, so the reader's page says
    // which kind of game this is.
    if (hasBonuses && q.bonus && Array.isArray(q.bonus.parts)) {
      // The bonus goes to whoever answered the tossup; the other team gets any bouncebacks.
      const winner = buzzes.find((b) => b.points > 0);
      if (winner) {
        const parts = q.bonus.parts.map((p) => pts(p?.controlled_points));
        const bounce = q.bonus.parts.map((p) => pts(p?.bounceback_points));
        const got = parts.reduce((a, b) => a + b, 0);
        const bounced = bounce.reduce((a, b) => a + b, 0);
        totals[winner.team] += got;
        totals[1 - winner.team] += bounced;
        bonus = { team: winner.team, parts, total: got, bounceback: bounced || 0 };
      }
    }
    // A thrown-out tossup is something the room witnessed; nothing about the
    // replacement itself is carried. (In the QBJ the replacement's number is
    // the row's tossup number, so the thrown-out one is the number before.)
    const replaced = q.replacement_tossup_question != null;
    const thrownOut = replaced ? Math.max(1, pts(q.tossup_question?.question_number) - 1) : null;
    rows.push({
      n,
      buzzes,
      bonus,
      replaced,
      thrownOut,
      protests: protestsByCycle.get(n) || [],
      scores: [totals[0], totals[1]]
    });
  }
  rows.sort((a, b) => a.n - b.n);
  return { teams, rows, through, current: through, total, scores: [totals[0], totals[1]], at: Date.now() };
}

// The reader's page pushes its game on every change; keep the players' view.
// Clearing (a null match) hides the sheet, e.g. when the reader leaves a game.
export function setScoresheet(room, match, currentQuestion, hasBonuses = true, protests = []) {
  room.scoresheet = match == null ? null : buildPlayerScoresheet(match, currentQuestion, hasBonuses, protests);
  persistRooms();
  return { ok: true };
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

export function massingerStart(room, { round, subcats, teams, timerSec, target, control } = {}) {
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
    control: MASSINGER_CONTROLS.includes(control) ? control : 'captain',
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
  if (!MASSINGER_CONTROLS.includes(saved.control)) saved.control = 'captain';
  room.massinger = saved;
  // Never resume into a live countdown from the distant past.
  if (saved.status === 'active') massingerArm(saved);
  return { ok: true };
}

export function massingerPick(room, { type, label, by } = {}) {
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
  m.actions.push({ type, label, team: m.turn, at: Date.now(), by: by || 'moderator' });
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

// Moderator correction of a single row: drop its protect and/or its bans and
// forget the actions that produced them, without unwinding everything after.
export function massingerResetSubcat(room, label) {
  const m = room.massinger;
  if (!m) return { error: 'not_active' };
  const sc = m.subcats.find((x) => x.label === label);
  if (!sc) return { error: 'no_subcat' };
  if (sc.protectedBy == null && sc.banned === 0) return { error: 'nothing_to_reset' };
  sc.protectedBy = null;
  sc.banned = 0;
  m.actions = m.actions.filter((a) => a.label !== label);
  // Reopening a row can put the count back above target, so re-decide status.
  m.status = 'active';
  massingerArm(m);
  massingerFinishIfDone(m);
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
export function massingerRandomBan(room, by) {
  const m = room.massinger;
  if (!m || m.status !== 'active') return { error: 'not_active' };
  const bannable = m.subcats.filter((sc) => sc.protectedBy == null && sc.banned < sc.indexes.length);
  if (bannable.length === 0) return { error: 'exhausted' };
  const sc = bannable[Math.floor(Math.random() * bannable.length)];
  return massingerPick(room, { type: 'ban', label: sc.label, by: by || 'random' });
}

// Can this member make the pick that's on the clock? The server decides this
// rather than trusting the page that rendered the buttons. Once the room has a
// roster (which a MASSINGER game always does — the MODAQ teams are pushed to it
// before the pick/ban), the picker must be LINKED to one of its players: a
// pick rewrites the packet, so it shouldn't be enough to have typed the team's
// name on the join gate. Returns true or the reason it isn't allowed.
// Who may make the pick that's on the clock:
//   'moderator' — nobody but the moderator (they read every pick out loud)
//   'captain'   — only that team's captain
//   'anyone'    — any player the room knows to be on that team
// A pick rewrites the packet, so in the two player modes the buzzer must be
// vouched for: linked to a roster player, or put on the team by the moderator.
// Typing a team's name on the join gate is never enough.
export function massingerCanPick(room, member) {
  const m = room.massinger;
  if (!m || m.status !== 'active') return 'not_active';
  if (m.control === 'moderator') return 'moderator_only';
  if (!member || member.role !== 'player') return 'not_a_player';
  if (!member.rosterPlayer && !member.assignedTeam) return 'not_linked';
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const team = norm(effectiveTeam(member));
  if (team === '' || team !== norm(m.teams[m.turn])) return 'not_your_turn';
  if (m.control === 'captain' && !member.isCaptain) return 'not_captain';
  return true;
}

export function massingerSetControl(room, control) {
  const m = room.massinger;
  if (!m) return { error: 'not_active' };
  if (!MASSINGER_CONTROLS.includes(control)) return { error: 'bad_control' };
  m.control = control;
  return { ok: true };
}

export function massingerCancel(room) {
  room.massinger = null;
  return { ok: true };
}

export const _internal = { rooms, tournaments };
