import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './config.js';
import { DATA_DIR } from './artifacts.js';
import { roomCode, secretToken, uuid } from './ids.js';
import * as protests from './protests.js';
import * as answers from './answers.js';
import * as playtest from './playtest.js';
import * as shootout from './shootout.js';

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
  // The player-facing scoresheet of the game being read (already sanitized),
  // and — in a shootout — which packet that game is.
  scoresheet: r.scoresheet || null,
  scoresheetPacket: r.scoresheetPacket || null,
  // Which game-archive entry the game on screen is filed under, so a restart
  // mid-game keeps filing into the same one.
  archive: r.archive || null,
  // Every buzz attempt, for the full-buzz export (buzz-point tracking).
  buzzLog: r.buzzLog || [],
  // What the room DID: clears, withdrawals, who joined, options changed. The
  // companion to buzzLog, and the thing you read when a buzz went missing.
  log: r.log || [],
  // The host said the game was over (see endGame). Persisted, or a restart
  // would quietly reopen a room the host had closed.
  ended: r.ended || null,
  // What an upheld protest left to be played here (see createReplayRoom).
  replay: r.replay || null,
  // Protests the teams lodged (see protests.js). Durable: a protest outlives
  // the game it was raised in — the director rules on it afterwards.
  protests: r.protests || [],
  // What the room thought of the questions (see playtest.js). The reason the
  // playtest happened, so it had better survive a restart.
  playtestFeedback: r.playtestFeedback || [],
  // A shootout's running leaderboard and its chat (see shootout.js). Both last
  // the evening, so both outlive a restart.
  shootout: r.shootout || null,
  // ...and what the host set up for it: packets, notes, withdraw rule.
  shootoutSession: r.shootoutSession || null,
  chat: r.chat || []
});

const persistTournament = (t) => persistence?.tournament(serializeTournament(t));

// Rooms are persisted as one file holding every room, and the record now
// carries the live scoresheet and the full buzz log. Serializing that on every
// change (a scoresheet update lands ~once a second while scoring, and every
// buzz resolves one) would block the event loop right where the room is
// waiting for its state broadcast. So writes are coalesced: mark dirty, flush
// shortly after. Anything whose loss would be unrecoverable — a freshly minted
// room and its tokens — asks for an immediate flush.
const ROOM_PERSIST_MS = 1500;
let roomsDirty = false;
let roomsTimer = null;

function flushRooms() {
  if (roomsTimer) { clearTimeout(roomsTimer); roomsTimer = null; }
  if (!roomsDirty || !persistence) return;
  roomsDirty = false;
  persistence.rooms([...rooms.values()].map(serializeRoom));
}

function persistRooms(immediate = false) {
  if (!persistence) return;
  roomsDirty = true;
  if (immediate) return flushRooms();
  if (roomsTimer) return;
  roomsTimer = setTimeout(flushRooms, ROOM_PERSIST_MS);
  roomsTimer.unref?.();   // never hold the process open for a pending write
}

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
      playerScoresheet: t.playerScoresheet !== false,
      scoresheetCategories: t.scoresheetCategories === true,
      buzzPoints: t.buzzPoints === true,
      playtest: t.playtest === true,
      showQuestions: t.showQuestions === true,
      questionLag: clampNum(t.questionLag, 0, 20, DEFAULT_QUESTION_LAG)
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
      log: Array.isArray(r.log) ? r.log : []
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
  // Never a code with files on disk: a room that aged out leaves its shared
  // MODAQ game (the packet) and its filed games under r/CODE, and a new room
  // dealt the same code would read them as its own.
  let code;
  do { code = roomCode(); } while (rooms.has(code) || existsSync(path.join(DATA_DIR, 'r', code)));

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
      // Questions a free withdrawal costs you before the next one is free too
      // (the shootout's rationed mode). 0 = every withdrawal is free.
      withdrawCooldown: clampNum(eff.withdrawCooldown, 0, 40, 0),
      autoClear: !!eff.autoClear,         // auto-reset the buzzer a few seconds after a buzz
      // Players must supply a team name to join — never in a shootout, where
      // a competitor is their own team and the roster is built from who is in
      // the room (see shootout.js). Asking would be asking the wrong question.
      requireTeam: !!eff.requireTeam && eff.shootout !== true,
      // Players pick their team (and name) from the roster instead of typing.
      rosterJoin: eff.rosterJoin === true,
      playerAlerts: eff.playerAlerts !== false, // players may flag a stuck buzzer (on by default)
      modaqMode: !!eff.modaqMode,         // reader gets the embedded MODAQ reader + buzz panel
      modaqLite: !!eff.modaqLite,         // lightweight MODAQ: reader + buzzer only, no tournament artifacts
      // --- typed answers (see answers.js), all off unless asked for -------
      // The player with the floor types their answer instead of saying it.
      typedAnswers: eff.typedAnswers === true,
      // ...and everyone else in the queue commits one in secret first.
      lockedAnswers: eff.lockedAnswers === true,
      answerSeconds: clampNum(eff.answerSeconds, 1, 60, DEFAULTS.answerSeconds),
      answerGraceSeconds: clampNum(eff.answerGraceSeconds, 0, 10, DEFAULTS.answerGraceSeconds),
      // Every connected buzzer is its own scored individual rather than part of
      // a team — a Discord shootout, where usernames are the players.
      shootout: eff.shootout === true,
      // Anyone may find this game from the home page and join it (see
      // listPublicRooms). Off unless the host asks for it: a room's code is
      // the only thing keeping strangers out of it.
      listed: eff.listed === true
    },
    // Roster loaded from a QBJ registration file, so buzzers can be labelled
    // with the real player who is sitting behind them (see setRoster).
    roster: null,           // { name, teams: [{ name, players: [..] }] }
    rosterTeams: [],        // team names actually playing in this room
    phase: 'open',          // open | locked  — buzzers are live by default
    cycleNo: 1,
    cycle: freshCycle(1),
    lastBuzzAt: null,        // server time the current queue's first buzz resolved
    queue: [],               // [{ playerId, name, t, marginMs }] in buzz order
    members: new Map(),      // playerId -> member
    log: []                 // recent events for late joiners / audit
  };
  rooms.set(code, room);

  if (tournamentCode && tournaments.has(tournamentCode)) {
    tournaments.get(tournamentCode).roomCodes.add(code);
    persistTournament(tournaments.get(tournamentCode));
  }
  persistRooms(true);
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

export function createTournament({ name, schedule = [], defaults = {}, format = {}, requireReaderAccounts = false, date = '', listed = false, playerScoresheet = true, scoresheetCategories = false, buzzPoints = false, playtest = false,
  showQuestions = false, questionLag = DEFAULT_QUESTION_LAG }) {
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
    playerScoresheet: playerScoresheet !== false,
    // Put each tossup's category on that scoresheet, once the room is safely
    // past the cycle (see the category gate below). Default OFF: a category is
    // a hint, so a director opts into it.
    scoresheetCategories: scoresheetCategories === true,
    // Collect every room's full buzz log centrally, so the director can pull
    // the whole tournament's buzz points including the buzzes that never got
    // the floor. Default OFF: it's a decision a director makes before the
    // tournament, and it records the timing of every player in every room.
    buzzPoints: buzzPoints === true,
    // A playtest, not a tournament: the room is reading these questions to
    // find out what is wrong with them. Players get the answer line once a
    // cycle is over and can say what they thought of the question. Off by
    // default, because in a real tournament showing the answer line to the
    // room mid-match would be a disaster.
    playtest: playtest === true,
    // Show players the full text of a question once the room is done with it.
    // Off by default, and held back further by questionLag below.
    showQuestions: showQuestions === true,
    // How many questions BEHIND the room the text runs. The reveal gate
    // already refuses to release a cycle the room hasn't finished; the lag is
    // a second margin on top, for the room where someone is a question behind
    // — a phone that lagged, a player who stepped out. Two costs nothing and
    // removes the whole class of problem, so that is the default.
    questionLag: clampNum(questionLag, 0, 20, DEFAULT_QUESTION_LAG)
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
  if (typeof d.typedAnswers === 'boolean') out.typedAnswers = d.typedAnswers;
  if (typeof d.lockedAnswers === 'boolean') out.lockedAnswers = d.lockedAnswers;
  if (typeof d.shootout === 'boolean') out.shootout = d.shootout;
  if (d.answerSeconds != null) out.answerSeconds = clampNum(d.answerSeconds, 1, 60, DEFAULTS.answerSeconds);
  if (d.answerGraceSeconds != null) out.answerGraceSeconds = clampNum(d.answerGraceSeconds, 0, 10, DEFAULTS.answerGraceSeconds);
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

/**
 * Games the host has put on the home page — mostly Discord readings, where the
 * point is that anybody can wander in.
 *
 * Listing is a claim that the game is happening NOW, so an empty room is not
 * listed however its checkbox is set: a host who closed the laptop without
 * unticking it would otherwise leave a dead room on the front page all week.
 * Somebody has to be connected — the host counts, since a room waiting for its
 * first player is exactly the one worth advertising.
 */
export function listPublicRooms(limit = 12) {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.settings?.listed || room.ended) continue;
    const members = [...room.members.values()];
    const players = members.filter((m) => m.role === 'player' && m.connected).length;
    const host = members.some((m) => m.role !== 'player' && m.role !== 'spectator' && m.connected);
    if (!host && !players) continue;
    const session = room.shootoutSession;
    const packets = session?.packets ?? [];
    const at = packets.findIndex((p) => p.id === session?.current);
    out.push({
      code: room.code,
      name: session?.name || room.name || 'Klaxon room',
      shootout: !!room.settings.shootout,
      players,
      host,
      // Where the reading has got to, when there is one.
      packet: at >= 0 ? { at: at + 1, of: packets.length, name: packets[at].name } : null,
      startedAt: room.createdAt || null
    });
  }
  // The busiest first, then the ones with a host waiting, then the newest: a
  // player scanning this list wants a game in progress.
  out.sort((a, b) => b.players - a.players || Number(b.host) - Number(a.host) || (b.startedAt || 0) - (a.startedAt || 0));
  return out.slice(0, limit);
}

/**
 * The host says the game is over.
 *
 * Not a deletion: the scoresheet, the chat and the log are the record of what
 * happened, and they are wanted most right after the end. It closes the room to
 * players — they are sent home, and nobody new gets in — takes it off the home
 * page, and can be undone, because "End the game" is one click next to several
 * others and a host who hits it by mistake should not lose the room.
 */
export function endGame(room, ended, by = null) {
  room.ended = ended ? { at: Date.now(), by } : null;
  if (ended) room.settings.listed = false;
  pushLog(room, { type: ended ? 'end_game' : 'reopen_game', by });
  persistRooms(true);
  return room.ended;
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

export function setBuzzPoints(tournament, enabled) {
  tournament.buzzPoints = enabled === true;
  persistTournament(tournament);
  return tournament.buzzPoints;
}

// Is this room's buzz log collected for its tournament? A room outside any
// tournament keeps its log for the moderator's own download, but has nowhere
// central to send it.
export function buzzPointsOn(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  return t?.buzzPoints === true;
}

export function setShowQuestions(tournament, enabled, lag) {
  tournament.showQuestions = enabled === true;
  if (lag != null) tournament.questionLag = clampNum(lag, 0, 20, DEFAULT_QUESTION_LAG);
  persistTournament(tournament);
  return { showQuestions: tournament.showQuestions, questionLag: tournament.questionLag };
}

// Does this room show the questions it has finished, and how far behind?
export function questionRevealFor(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  if (t?.showQuestions !== true) return null;
  return { lag: clampNum(t.questionLag, 0, 20, DEFAULT_QUESTION_LAG) };
}

export function setPlaytest(tournament, enabled) {
  tournament.playtest = enabled === true;
  persistTournament(tournament);
  return tournament.playtest;
}

// Is this room part of a playtest? Answer lines and question feedback hang off
// this. A room outside any tournament is never one.
export function playtestOn(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  return t?.playtest === true;
}

export function setScoresheetCategories(tournament, enabled) {
  tournament.scoresheetCategories = enabled === true;
  persistTournament(tournament);
  return tournament.scoresheetCategories;
}

// Do this room's players get the live scoresheet? A tournament-level choice
// (default on); a room outside any tournament (MODAQ lite) always shows it.
export function playerScoresheetOn(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  return !t || t.playerScoresheet !== false;
}

// Does that scoresheet name each tossup's category? Off unless the director
// turned it on, so a room outside any tournament (MODAQ lite) never shows one.
export function scoresheetCategoriesOn(room) {
  const t = room?.tournamentCode ? tournaments.get(room.tournamentCode) : null;
  return t?.scoresheetCategories === true;
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
  const wasConnected = existing?.connected === true;
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
  // Coming and going is half of what the activity log is for: a buzz that
  // never arrived and a player who was reconnecting at the time are the same
  // story. A reconnect is only worth a line when they had actually dropped.
  if (!existing) {
    pushLog(room, { type: 'join', playerId: id, name: member.name, role: normRole });
  } else if (!wasConnected) {
    pushLog(room, { type: 'rejoin', playerId: id, name: member.name, role: normRole });
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

/**
 * Who is actually here, counted by live sockets rather than by the last event
 * that happened to arrive.
 *
 * A member is one person across every tab and every reconnect (the id is
 * theirs, not the socket's), so "disconnected" has to mean "no socket left" —
 * not "a socket closed". A reload opens the new connection BEFORE the old one's
 * close reaches us, and a second tab closing is not a departure at all; either
 * one, handled as a bare flag, marked a player who was sitting right there,
 * buzzing, as OFFLINE, with nothing to set it back.
 */
export function attachSocket(room, playerId, socketId) {
  const m = room.members.get(playerId);
  if (!m) return;
  if (!m.sockets) m.sockets = new Set();   // runtime only; members aren't persisted
  m.sockets.add(socketId);
  m.connected = true;
}

// Returns whether this actually took them offline (their last socket went).
export function detachSocket(room, playerId, socketId) {
  const m = room.members.get(playerId);
  if (!m) return false;
  m.sockets?.delete(socketId);
  const wasConnected = m.connected;
  m.connected = (m.sockets?.size ?? 0) > 0;
  const left = wasConnected && !m.connected;
  if (left) pushLog(room, { type: 'offline', playerId, name: m.name });
  return left;
}

export function setConnected(room, playerId, connected) {
  const m = room.members.get(playerId);
  if (!m) return;
  m.connected = connected;
  if (!connected) m.sockets?.clear();
}

// Reader removes a single player (staff can't be removed this way).
export function removePlayer(room, playerId) {
  const m = room.members.get(playerId);
  if (!m || m.role !== 'player') return false;
  room.members.delete(playerId);
  room.queue = room.queue.filter((q) => q.playerId !== playerId);
  pushLog(room, { type: 'remove_player', playerId, name: m.name });
  return true;
}

// Reader clears out players who joined before the cutoff — leftovers from an
// earlier game who never left. Returns the removed ids.
export function removeStalePlayers(room, minutes) {
  const mins = clampNum(minutes, 1, 24 * 60, 15);
  const cutoff = Date.now() - mins * 60000;
  const ids = [...room.members.values()]
    .filter((m) => m.role === 'player' && (m.joinedAt || 0) < cutoff)
    .map((m) => m.id);
  for (const id of ids) removePlayer(room, id);
  return ids;
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
// Except in a shootout, where every competitor is a one-player team: there a
// cap of 8 left everyone after the eighth unlinked — their buzzes still named
// them, but the panel showed them as not in MODAQ.
const activeTeamCap = (room) => (room.settings?.shootout ? Infinity : MAX_ACTIVE_TEAMS);

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
  room.rosterTeams = room.roster && room.roster.teams.length <= activeTeamCap(room)
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
    if (picked.length >= activeTeamCap(room)) break;
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

// A room as the stats pages name it: its friendly name and the people reading
// in it (connected ones first; if nobody is connected, whoever last was).
export function describeRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return null;
  const staff = [...room.members.values()].filter((m) => m.role === 'reader' || m.role === 'co-reader');
  const live = staff.filter((m) => m.connected);
  const readers = [...new Set((live.length ? live : staff).map((m) => m.name).filter(Boolean))];
  return { name: room.name || '', readers };
}

// --- buzz cycle state machine --------------------------------------------
// A room holds an ordered `queue` of who has buzzed.
//  - Default mode: the first wave of buzzes fills the queue, then phase locks
//    ('open' -> 'locked') so no one else can buzz until a staff reset.
//  - Queue mode: phase stays 'open' so buzzes keep accumulating; staff pop the
//    head ("next") or clear the whole queue, and players may withdraw.

// Manual "reset the buzzer" / "clear queue": empty it and reopen buzzers.
//
// `by` and `judged` are recorded because this is the one action that destroys
// evidence: the queue it emptied is gone afterwards, and the difference between
// "the moderator scored that buzz" and "the moderator cleared it" exists
// nowhere else. Whoever it was and whoever they dropped goes in the log, which
// is what the activity log is read for (see activityLog).
export function resetBuzzer(room, { by = null, judged = false } = {}) {
  const dropped = room.queue.map((q) => q.name);
  // The queue itself, not just the names, so a clear made by mistake can be
  // undone (see restoreCleared) — and the question it was on, because putting
  // a buzz back is only right while that question is still being read.
  const droppedQueue = room.queue.map((q) => ({ ...q }));
  const question = room.scoresheet?.current ?? null;
  room.cycleNo += 1;
  room.cycle = freshCycle(room.cycleNo);
  room.queue = [];
  room.lastBuzzAt = null;
  room.phase = 'open';
  pushLog(room, {
    type: 'reset_buzzer', id: nextLogId(), cycleNo: room.cycleNo, by, judged, dropped, droppedQueue, question
  });
  persistRooms();
}

// Names one clear, so an Undo pressed on a list that has since moved on can't
// undo a different one. Random rather than counted: the log outlives restarts.
const nextLogId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// The clear that can still be undone, if there is one: the latest clear, only
// if it dropped somebody, hasn't been undone already, and the room is still on
// the question it was made on. Anything older has been overtaken — later
// buzzes were ruled on against the queue as it stood after it.
function restorableClear(room) {
  for (let i = (room.log?.length || 0) - 1; i >= 0; i--) {
    const e = room.log[i];
    if (e.type !== 'reset_buzzer') continue;
    if (e.restored || !e.droppedQueue?.length) return null;
    if ((room.scoresheet?.current ?? null) !== (e.question ?? null)) return null;
    return e;
  }
  return null;
}

/**
 * Undo a clear: the buzzes it dropped go back in the queue, in the order they
 * were pressed — ahead of anybody who buzzed after the clear, since they
 * buzzed first. For the moderator who hit Accidental buzz or Clear queue on
 * the wrong buzz, or whose MODAQ ruling cleared a queue it shouldn't have.
 *
 * Players who have since left the room don't come back. A buzz the clear had
 * marked accidental is unmarked: the room has just said it wasn't.
 */
export function restoreCleared(room, id, { by = null } = {}) {
  const e = restorableClear(room);
  if (!e || (id != null && e.id !== id)) return { error: 'not_restorable' };
  const queued = new Set(room.queue.map((q) => q.playerId));
  const back = e.droppedQueue.filter((q) => !queued.has(q.playerId) && room.members.has(q.playerId));
  if (!back.length) return { error: 'nobody_to_restore' };

  room.queue = [...back, ...room.queue].sort((a, b) => a.t - b.t);
  const head = room.queue[0].t;
  for (const q of room.queue) q.marginMs = Math.round(q.t - head);
  if (!room.settings.queueMode) room.phase = 'locked';
  if (room.lastBuzzAt == null) room.lastBuzzAt = Date.now();

  // Typed answers belong to the cycle the clear ended. If nobody has opened a
  // window since, the old one comes back with them — what they had typed, and
  // what was already said — rather than leaving them to start again.
  if (room.answers?.cycleNo === e.cycleNo - 1) room.answers.cycleNo = room.cycleNo;

  const ids = new Set(back.map((q) => q.playerId));
  for (const b of room.buzzLog || []) {
    if (b.cycleNo === e.cycleNo - 1 && ids.has(b.playerId)) delete b.accidental;
  }
  e.restored = true;
  pushLog(room, { type: 'restore_buzzes', by, restored: back.map((q) => q.name), clearId: e.id });
  persistRooms();
  return { ok: true, restored: back.length };
}

// Queue mode: drop the current head so the next buzzer is "on the buzz".
export function nextBuzz(room, { by = null } = {}) {
  const done = room.queue[0]?.name || null;
  room.queue.shift();
  if (!room.queue.length) room.lastBuzzAt = null;
  if (!room.settings.queueMode) room.phase = room.queue.length ? 'locked' : 'open';
  pushLog(room, {
    type: 'next_buzz', by, done,
    head: room.queue[0]?.playerId || null, headName: room.queue[0]?.name || null
  });
}

// Queue mode: a player removes themselves (only if the room allows it).
// A player takes their buzz back. In a room with locked answers this also says
// whether it was free (see answers.withdrawal): a reaction buzz withdrawn
// before anything was said costs nothing, and neither does one whose committed
// answer has already been given by somebody else. The server does not apply a
// penalty — what a neg is worth is MODAQ's business — it reports which kind of
// withdrawal the moderator just saw.
/**
 * `byPlayer` is the player taking their own buzz back. The head of the queue
 * cannot: they have the floor. The room has stopped for them, the moderator is
 * listening to them, and at that point letting go of the buzz is a ruling — an
 * accidental buzz, or the reader moving on — not something the player decides
 * on their own while everyone waits. Free withdrawals are for the people
 * BEHIND the buzzer, who buzzed on reflex and have not been asked anything.
 *
 * The moderator can still take it off them (Accidental buzz / Next buzzer /
 * the buzz menu's Withdrew), which is the same action with the authority it
 * needs.
 */
/**
 * A free withdrawal, and then a wait.
 *
 * In the rationed mode a withdrawal costs nothing, but not twice in a row: the
 * next few questions are yours to answer. It is a ration rather than a
 * penalty, so the rule is about WHEN the last free one was taken, counted in
 * questions the room has read — not in seconds, and not in buzzes, both of
 * which would turn on how fast the reader is going.
 */
export function withdrawFreeAgainAt(room, playerId) {
  const wait = Number(room.settings.withdrawCooldown) || 0;
  if (wait <= 0) return null;
  const used = room.withdrawUsed?.[playerId];
  return used == null ? null : used + wait;
}

export function withdraw(room, playerId, { byPlayer = false, by = null } = {}) {
  if (!room.settings.allowWithdraw) return { ok: false };
  if (byPlayer && room.queue[0]?.playerId === playerId) return { ok: false, reason: 'has_floor' };
  const before = room.queue.length;

  const wait = Number(room.settings.withdrawCooldown) || 0;
  const question = Number(room.scoresheet?.current) || 0;
  let verdict;
  if (room.settings.lockedAnswers) {
    verdict = answers.withdrawal(room, playerId);
  } else if (wait > 0) {
    const freeAgainAt = withdrawFreeAgainAt(room, playerId);
    const free = freeAgainAt == null || question <= 0 || question >= freeAgainAt;
    verdict = free
      ? { free: true, reason: 'rationed' }
      : { free: false, reason: 'too_soon', freeAgainAt, questionsLeft: Math.max(0, freeAgainAt - question) };
  } else {
    verdict = { free: true, reason: 'no_answers' };
  }

  room.queue = room.queue.filter((q) => q.playerId !== playerId);
  if (room.queue.length === before) return { ok: false };

  // Only a FREE one starts the wait; one they were charged for doesn't buy
  // them another ration.
  if (wait > 0 && verdict.free && question > 0) {
    if (!room.withdrawUsed) room.withdrawUsed = {};
    room.withdrawUsed[playerId] = question;
  }
  pushLog(room, {
    type: 'withdraw', playerId, name: memberName(room, playerId),
    free: verdict.free, reason: verdict.reason, byPlayer, by
  });
  return { ok: true, ...verdict, freeAgainAt: withdrawFreeAgainAt(room, playerId) };
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
  // Every attempt below is logged, whatever became of it. A buzz that lost to
  // the lock is the one that matters most for buzz points — it's a player who
  // knew the answer and was beaten to it, and it exists nowhere else: MODAQ
  // only ever hears about the buzz that got the floor.
  const rejected = (reason) => {
    logBuzzAttempt(room, member, { clampedTime, arrival, accepted: false, reason });
    return { accepted: false, reason };
  };
  if (room.phase !== 'open') {
    // Locked to an earlier buzz: still worth remembering that they tried.
    logBuzzAttempt(room, member, { clampedTime, arrival, accepted: false, reason: 'locked' });
    return { accepted: false, reason: 'not_open' };
  }
  // Already waiting in the queue, or out of attempts for this cycle. Neither
  // reaches the floor, and both say something about how the room was buzzing.
  if (room.queue.some((q) => q.playerId === playerId)) return rejected('queued');

  const already = room.cycle.collected.filter((b) => b.playerId === playerId).length;
  if (already >= DEFAULTS.maxBuzzAttemptsPerCycle) return rejected('duplicate');

  const firstOfWindow = room.cycle.collected.length === 0;
  if (firstOfWindow) room.cycle.windowOpenedAt = arrival;
  room.cycle.collected.push({ playerId, clampedTime, arrival });
  logBuzzAttempt(room, member, { clampedTime, arrival, accepted: true });
  return { accepted: true, firstOfWindow };
}

// The buzz the room is currently held on was cleared. `judged` is true when
// the clear came from a MODAQ ruling (the moderator scored it) and false when
// the moderator simply cleared the buzzer — which is the room's way of saying
// the buzz was accidental: a knocked buzzer, a misfire, nobody answering.
//
// Marked on the buzz log rather than inferred later, because after the reset
// there is nothing left to tell the two apart. An accidental buzz is not a
// buzz point, and the ACF rules make it the one ruling that is never
// protestable (H.6), so it is worth knowing which ones they were.
export function markAccidentalBuzz(room, judged) {
  if (judged || !room.queue.length) return 0;
  const held = new Set(room.queue.map((q) => q.playerId));
  let marked = 0;
  // Only this cycle's accepted buzzes, and only the ones still unresolved.
  for (let i = room.buzzLog?.length ? room.buzzLog.length - 1 : 0; i >= 0; i--) {
    const b = room.buzzLog[i];
    if (b.cycleNo !== room.cycleNo) break;
    if (b.accepted && held.has(b.playerId) && !b.accidental) { b.accidental = true; marked++; }
  }
  return marked;
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
  // How far behind the buzz that WON it — the one at the head of the queue —
  // not behind whoever happened to be first in this wave.
  //
  // A wave is the handful of presses inside one reconcile window. Someone who
  // buzzes four seconds later, after that wave is already resolved, opens a
  // wave of their own, and measuring them against it made them "+0ms": a
  // player who buzzed last read as having tied for first. The margin means one
  // thing on every row, so it is measured from one place: the head of the
  // queue, whose own margin is zero by definition.
  const head = room.queue.length ? room.queue[0].t : undefined;
  const base = head ?? (buzzes.length ? buzzes[0].clampedTime : 0);
  for (const b of buzzes) {
    if (room.queue.some((q) => q.playerId === b.playerId)) continue; // already queued
    room.queue.push({
      playerId: b.playerId,
      name: displayName(room.members.get(b.playerId)),
      // Kept so a later wave has something to measure itself against.
      t: b.clampedTime,
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
  if (opts.withdrawCooldown != null) room.settings.withdrawCooldown = clampNum(opts.withdrawCooldown, 0, 40, 0);
  if (typeof opts.autoClear === 'boolean') room.settings.autoClear = opts.autoClear;
  if (typeof opts.requireTeam === 'boolean') room.settings.requireTeam = opts.requireTeam && !room.settings.shootout;
  if (typeof opts.playerAlerts === 'boolean') room.settings.playerAlerts = opts.playerAlerts;
  if (typeof opts.modaqMode === 'boolean') room.settings.modaqMode = opts.modaqMode;
  if (typeof opts.modaqLite === 'boolean') room.settings.modaqLite = opts.modaqLite;
  if (typeof opts.typedAnswers === 'boolean') room.settings.typedAnswers = opts.typedAnswers;
  if (typeof opts.lockedAnswers === 'boolean') room.settings.lockedAnswers = opts.lockedAnswers;
  if (typeof opts.listed === 'boolean') room.settings.listed = opts.listed;
  if (typeof opts.shootout === 'boolean') {
    room.settings.shootout = opts.shootout;
    if (opts.shootout) room.settings.requireTeam = false;
  }
  if (opts.answerSeconds != null) room.settings.answerSeconds = clampNum(opts.answerSeconds, 1, 60, DEFAULTS.answerSeconds);
  if (opts.answerGraceSeconds != null) {
    room.settings.answerGraceSeconds = clampNum(opts.answerGraceSeconds, 0, 10, DEFAULTS.answerGraceSeconds);
  }
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
  pushLog(room, { type: 'stuck_alert', playerId, name: member.name });
  return { ok: true, member };
}

// The room's activity log. Two hundred entries covered "what happened just
// now" and nothing else: by the end of an evening the clear you wanted to look
// at was long gone. It is a few hundred KB at worst, it is written to disk with
// the room, and it is the only record of a buzz that was cleared rather than
// scored — so it keeps the evening.
const LOG_CAP = 4000;

function pushLog(room, entry) {
  if (!room.log) room.log = [];
  room.log.push({ ...entry, at: Date.now() });
  if (room.log.length > LOG_CAP) room.log.splice(0, room.log.length - LOG_CAP);
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

// What the packet being read has scored so far. A sheet belonging to another
// packet contributes nothing: its score is filed under that packet instead.
function shootoutCurrentScores(room) {
  const session = room.shootoutSession;
  if (session && room.scoresheetPacket && room.scoresheetPacket !== session.current) {
    return {};
  }
  return shootout.currentScores(room.scoresheet);
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
    // When each player's next free withdrawal comes round, in the rationed
    // mode (see store.withdraw). Only people currently waiting are listed, and
    // a question number is not a secret — the room watched them withdraw.
    withdrawFreeAt: room.settings.withdrawCooldown > 0 ? { ...(room.withdrawUsed || {}) } : null,
    // A playtest room shows answer lines once a cycle is over and asks the
    // room what it thought (see playtest.js).
    playtest: playtestOn(room),
    // Why this room exists, when it exists to settle a protest.
    replay: room.replay || null,
    // A shootout's leaderboard across every packet of the session, and its
    // chat (see shootout.js). Null in a room that isn't one.
    // The host put this game on the home page, and/or called it over. Both are
    // the room's business, not a secret: the page says so on every screen.
    listed: room.settings.listed === true,
    ended: room.ended ? { at: room.ended.at, by: room.ended.by || null } : null,
    shootout: room.settings.shootout
      ? {
        // The game on screen counts as the current packet's only while it IS
        // that packet's: between moving to a packet and its first game update,
        // the sheet is still the packet just left — already filed under it.
        ...shootout.board(room, shootoutCurrentScores(room), room.shootoutSession?.current ?? null,
          // Everyone in the room, so a late joiner is on the board at once.
          [...room.members.values()].filter((m) => m.role === 'player').map((m) => displayName(m))),
        // What's being played and what the host wants the room to know.
        session: shootout.publicSession(room.shootoutSession)
      }
      : null,
    // The tail of it: the whole log would ride in every broadcast, and a buzz
    // causes one. The moderator's export reads the rest (see chatTranscript).
    chat: room.settings.shootout ? shootout.messages(room) : [],
    // The typed-answer window, when the room uses one (answers.js). Nobody's
    // committed answer is in here — a page knows its own because it typed it.
    answers: (room.settings.typedAnswers || room.settings.lockedAnswers)
      ? answers.publicWindow(room) : null,
    // Protests the teams lodged, as the whole room may see them (protests.js).
    // Which side a given viewer is on is worked out on their own page from the
    // team they're on — it isn't fanned out per socket.
    protests: protests.publicProtests(room),
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

// --- protests ----------------------------------------------------------------
// protests.js decides the rules; this settles WHO is asking. The team a person
// counts as being on is the vouched-for one (see effectiveTeam), never what
// they typed on the join gate — a protest is lodged by a team, so it has to be
// a team somebody stood behind.
export function protestActor(room, playerId) {
  const member = room.members.get(playerId);
  if (!member || member.role !== 'player') return null;
  return { id: member.id, name: displayName(member), team: effectiveTeam(member) || null };
}

// A shootout's roster IS the room: everyone connected is a competitor of their
// own, named for themselves. Rebuilt whenever the room changes, so someone
// arriving at question 9 is simply in the next game the moderator starts.
export function refreshShootoutRoster(room) {
  if (!room.settings.shootout) return false;
  const next = shootout.roster([...room.members.values()], displayName);
  const before = JSON.stringify(room.roster?.teams ?? null);
  // Same teams AND all of them playing. A room capped at 8 before shootouts
  // were exempt has the right teams but not all of them active.
  const allActive = (next?.teams.length ?? 0) === (room.rosterTeams?.length ?? 0);
  if (JSON.stringify(next?.teams ?? null) === before && allActive) return false;
  room.roster = next;
  room.rosterTeams = next ? next.teams.map((t) => t.name) : [];
  persistRooms();
  return true;
}

/**
 * A room to play out what an upheld protest left owing (ACF H.12.1, H.12.2).
 *
 * A fresh room rather than the original: the match it came from is finished
 * and exported, its moderator has gone home, and what has to happen now is a
 * couple of questions read to the same two teams — not a resumption of the
 * game. It carries the plan so the reader knows what they are reading and why,
 * and the teams' names so the buzzers are labelled without anyone typing.
 */
export function createReplayRoom({ tournamentCode, round, teams, gameplay, protest }) {
  const room = createRoom({
    name: `Protest replay — round ${round}`,
    tournamentCode,
    settings: { modaqMode: true, queueMode: false }
  });
  room.replay = {
    round: String(round ?? '').slice(0, 40),
    protest: {
      type: protest?.type ?? null,
      question: Number(protest?.question) || null,
      part: Number(protest?.part) || null,
      team: String(protest?.team ?? '').slice(0, 60)
    },
    // What has to be played, in the order it has to be played (see
    // resolution.js) — a replacement tossup before the bonus that may follow.
    gameplay: (Array.isArray(gameplay) ? gameplay : []).map((g) => ({
      kind: g.kind, forTeams: g.forTeams || [], rule: g.rule || null,
      why: String(g.why ?? '').slice(0, 400), conditional: g.conditional === true
    })),
    createdAt: Date.now()
  };
  // The two sides are known, so the room already has its roster: nobody
  // reassembling a match at the end of a long day should have to type them.
  const clean = (Array.isArray(teams) ? teams : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (clean.length) {
    room.roster = { name: 'Protest replay', teams: clean.map((t) => ({ name: t, players: [] })) };
    room.rosterTeams = clean;
  }
  persistRooms();
  return room;
}

// The host's plan for the evening (see shootout.normalizeSession). The way a
// withdrawn buzz is handled is a room setting, so it's applied here too.
export function setShootoutSession(room, input) {
  if (!room.settings.shootout) return { error: 'disabled' };
  const session = shootout.normalizeSession(input, room.shootoutSession);
  room.shootoutSession = session;
  Object.assign(room.settings, shootout.withdrawSettings(session.withdraw, session.withdrawCooldown));
  // A buzz can only be withdrawn from a queue.
  if (room.settings.allowWithdraw) room.settings.queueMode = true;
  persistRooms(true);
  return { ok: true, session: shootout.publicSession(session) };
}

// Which of the session's packets is being read. Moving off a packet files what
// it finished with under its own id, so the leaderboard keeps it while the
// room reads something else — and so going back to it later replaces that
// entry instead of counting the packet twice.
export function setShootoutCurrent(room, packetId) {
  const session = room.shootoutSession;
  if (!room.settings.shootout || !session) return { error: 'no_session' };
  if (!session.packets.some((p) => p.id === packetId)) return { error: 'no_packet' };
  // File the score on screen under the packet it was scored on. Reading that
  // off the sheet itself, rather than assuming it is the packet the session
  // last named, is what makes going BACK safe: a packet the room has only
  // opened, and never played, has no score to file.
  const scored = room.scoresheetPacket;
  if (scored && scored !== packetId) {
    shootout.bankPacket(room, scored, shootout.currentScores(room.scoresheet));
  }
  session.current = packetId;
  persistRooms();
  return { ok: true };
}

// The moderator wipes the leaderboard and starts the evening again.
export function resetShootout(room) {
  shootout.reset(room);
  persistRooms();
  return shootout.board(room, shootout.currentScores(room.scoresheet), room.shootoutSession?.current ?? null,
    [...room.members.values()].filter((m) => m.role === 'player').map((m) => displayName(m)));
}

export function chatSay(room, actor, text) {
  // Everyone who could be addressed: players by the name they are known by,
  // and staff, so the room can get the reader's attention.
  const people = [...room.members.values()].map((m) => ({ id: m.id, name: displayName(m) }));
  // "@moderator" reaches every member of staff: a player who wants the
  // reader's attention shouldn't have to know what name they joined under.
  for (const m of room.members.values()) {
    if (m.role === 'reader' || m.role === 'co-reader') people.push({ id: m.id, name: 'moderator' });
  }
  const res = shootout.say(room, actor, text, people);
  if (res.ok) persistRooms();
  return res;
}

/**
 * Has the room moved on to a question it has never been on before?
 *
 * The chat gets a line between questions so a conversation can be read back
 * against the game, but only for real progress. A moderator correcting a score
 * three questions back, or stepping to a question and returning, is not the
 * room moving on — and a divider for every one of those is worse than none,
 * because then the dividers mean nothing.
 *
 * So: a high-water mark, per GAME. Going back is silent, coming forward
 * again is silent until the room passes where it had already got to.
 *
 * A game is a packet, when the shootout has a list of them — and otherwise
 * there is no packet id at all, so a mark kept only per packet carried over
 * from one game into the next: the second game was silent until it passed
 * the question the first had ended on, which is to say all of it. A game on
 * its first question with nothing scored is a new game, and starts over.
 */
export function cycleDivider(room, match = null) {
  if (!room.settings.shootout) return null;
  const n = Number(room.scoresheet?.current);
  if (!Number.isFinite(n) || n < 1) return null;
  const packet = room.scoresheetPacket ?? null;
  const mark = room.chatCycleMark;
  const scored = (match?.match_questions ?? []).some((q) => (q?.buzzes?.length ?? 0) > 0);
  const freshGame = n === 1 && !scored;
  // A different packet or a new game starts its own count; the first question
  // of a game needs no divider, there is nothing above it to divide from.
  if (!mark || mark.packet !== packet || freshGame) {
    room.chatCycleMark = { packet, n };
    return null;
  }
  if (n <= mark.n) return null;
  room.chatCycleMark = { packet, n };
  return `Question ${n}`;
}

// The whole conversation, as something to read afterwards.
export const chatTranscript = (room) => shootout.transcript(room, {
  name: room.shootoutSession?.name, code: room.code
});

// --- the activity log ------------------------------------------------------
/**
 * Everything the room did, in one list, in the order it happened: every buzz
 * attempt (the ones that lost the race included), every clear and who did it,
 * withdrawals, players arriving and dropping out, options changed, and the
 * chat alongside it.
 *
 * This exists for the question "what happened to that buzz?". Each of those
 * records already lived somewhere — the buzz log, the room log, the chat — but
 * separately, none of them readable. Apart they answer nothing; interleaved
 * they answer it at a glance, which is why the export merges rather than dumps.
 *
 * Plain text on purpose: it gets read, pasted into a message, and sent to
 * whoever is arguing about the tossup.
 */
const CLOCK = { hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 };
const stampOf = (at) => {
  try {
    return new Date(at).toLocaleTimeString('en-US', CLOCK);
  } catch {
    // fractionalSecondDigits is recent; a runtime without it still gets a log.
    return new Date(at).toLocaleTimeString('en-US');
  }
};

// Why a buzz didn't make it. The stored reasons are the server's words for it
// (see recordBuzz); these are the moderator's.
const BUZZ_REASONS = {
  locked: 'the buzzer was already locked',
  queued: 'already in the queue',
  duplicate: 'too many tries on this question',
  not_player: 'not a player',
  not_open: 'the buzzer was not open'
};

const OPTION_LABELS = {
  queueMode: 'buzzer queue', allowWithdraw: 'withdrawals', autoClear: 'auto-clear',
  typedAnswers: 'typed answers', lockedAnswers: 'committed answers',
  requireTeam: 'team required', playerAlerts: 'player alerts',
  modaqMode: 'MODAQ', modaqLite: 'MODAQ lite', shootout: 'shootout'
};

function optionSummary(settings = {}) {
  const on = [];
  for (const [key, label] of Object.entries(OPTION_LABELS)) {
    if (settings[key]) on.push(label);
  }
  const extra = [];
  if (settings.withdrawCooldown) extra.push(`withdraw cooldown ${settings.withdrawCooldown}`);
  if (settings.answerSeconds) extra.push(`${settings.answerSeconds}s to answer`);
  return (on.length ? on.join(', ') : 'nothing') + (extra.length ? ` \u00b7 ${extra.join(', ')}` : '');
}

// The room log's entries, one line each. Anything unrecognized still prints: a
// log that silently drops the event you were looking for is worse than one that
// prints it roughly.
function logLine(e, room) {
  const who = e.by ? `${e.by}` : 'A moderator';
  switch (e.type) {
    case 'reset_buzzer': {
      const dropped = (e.dropped || []).filter(Boolean);
      const what = e.judged === true
        ? 'cleared the buzzer after scoring it'
        : 'CLEARED the buzzer without scoring it (counted as an accidental buzz)';
      const lost = dropped.length ? ` \u2014 dropped ${dropped.join(', ')}` : ' \u2014 nobody was on it';
      return ['CLEAR', `${who} ${what}${lost}`];
    }
    case 'restore_buzzes':
      return ['UNDO', `${who} undid the last clear — ${(e.restored || []).join(', ')} back in the queue`];
    case 'next_buzz':
      return ['NEXT', `${who} moved past ${e.done || 'the buzz'}${e.headName ? ` \u2014 now on ${e.headName}` : ' \u2014 queue empty'}`];
    case 'withdraw': {
      const by = e.byPlayer ? `${e.name || e.playerId} withdrew` : `${who} withdrew ${e.name || e.playerId}`;
      return ['WITHDRAW', `${by} (${e.free ? 'free' : 'not free'}: ${e.reason})`];
    }
    case 'buzz':
      return ['QUEUE', `buzz window resolved \u2014 ${e.size} waiting`];
    case 'join':
      return ['JOIN', `${e.name || e.playerId} joined as ${e.role || 'player'}`];
    case 'rejoin':
      return ['JOIN', `${e.name || e.playerId} reconnected`];
    case 'offline':
      return ['LEFT', `${e.name || e.playerId} went offline`];
    case 'remove_player':
      return ['PLAYERS', `${who} removed ${e.name || e.playerId}`];
    case 'remove_all_players':
      return ['PLAYERS', `${who} removed ${e.count} players`];
    case 'stuck_alert':
      return ['ALERT', `${e.name || e.playerId} says the buzzer is stuck`];
    case 'end_game':
      return ['END', `${who} ended the game — players sent home, room off the home page`];
    case 'reopen_game':
      return ['END', `${who} reopened the game`];
    case 'set_options':
      return ['OPTIONS', `settings changed \u2014 on: ${optionSummary(e.settings)}`];
    case 'set_roster':
      return ['ROSTER', `roster loaded (${e.teams} teams)`];
    case 'clear_roster':
      return ['ROSTER', 'roster cleared'];
    case 'set_member_team':
      return ['ROSTER', `${e.playerId} put on ${e.team || 'no team'}`];
    case 'set_captain':
      return ['ROSTER', `${e.playerId} made captain of ${e.team}`];
    case 'assign_roster_player':
      // In a shootout every player IS their own team, so this fires on every
      // join and says nothing: it would bury the events worth reading.
      if (room?.settings?.shootout) return null;
      return ['ROSTER', `${e.playerId} is ${e.player} (${e.team})`];
    default:
      return [String(e.type || 'event'), JSON.stringify({ ...e, type: undefined, at: undefined })];
  }
}

export function activityLog(room) {
  const rows = [];

  // Buzzes, with the margin measured the way the room measures it: behind the
  // buzz that won the question, not behind whoever this wave started with.
  const firstOf = new Map();
  for (const b of room.buzzLog || []) {
    if (!b.accepted) continue;
    const best = firstOf.get(b.cycleNo);
    if (best == null || b.t < best) firstOf.set(b.cycleNo, b.t);
  }
  for (const b of room.buzzLog || []) {
    const q = b.question ? ` [q${b.question}]` : '';
    if (b.accepted) {
      const base = firstOf.get(b.cycleNo);
      const ms = base == null ? 0 : Math.max(0, Math.round(b.t - base));
      const mark = b.accidental ? ', later cleared as accidental' : '';
      rows.push([b.at, 'BUZZ', `${b.name} buzzed${ms ? ` (+${ms}ms)` : ' (first)'}${mark}${q}`]);
    } else {
      rows.push([b.at, 'no buzz', `${b.name} pressed but did not get in \u2014 ${BUZZ_REASONS[b.reason] || b.reason || 'turned away'}${q}`]);
    }
  }

  for (const e of room.log || []) {
    const line = logLine(e, room);
    if (line) rows.push([e.at, line[0], line[1]]);
  }

  for (const m of room.chat || []) {
    if (m.system === 'cycle') rows.push([m.at, '', `--- ${m.text} ---`]);
    else if (m.system === 'answer') rows.push([m.at, 'ANSWER', `${m.name}: ${m.text}`]);
    else rows.push([m.at, 'CHAT', `${m.name}${m.staff ? ' (moderator)' : ''}: ${String(m.text).split('\n').join(' / ')}`]);
  }

  rows.sort((a, b) => a[0] - b[0]);

  const when = (at) => new Date(at).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const head = [
    `${room.shootoutSession?.name || room.name || 'Klaxon room'} \u2014 activity log`,
    `Room ${room.code} \u00b7 downloaded ${when(Date.now())}`,
    rows.length
      ? `${rows.length} events, ${when(rows[0][0])} to ${when(rows[rows.length - 1][0])}`
      : 'Nothing has happened here yet.',
    '',
    'Times are the server\u2019s own clock \u2014 the clock buzzes are ordered on. A buzz says',
    'how far behind the winning buzz it was. A CLEAR says whether the moderator had',
    'scored that buzz first; one that was not scored is the room calling it an',
    'accidental buzz.',
    ''
  ];
  const body = rows.map(([at, kind, text]) =>
    `[${stampOf(at)}]  ${String(kind).padEnd(8)} ${text}`);
  return head.concat(body).join('\n') + '\n';
}

/**
 * The last few things that happened to the buzzer, newest first, for the
 * moderator's screen: who buzzed and how far behind, who pressed and didn't get
 * in, every clear (and whether it was scored first, and whom it dropped), next
 * buzzer, withdrawals, undos, stuck alerts. The activity log, cut down to what
 * a moderator needs mid-tossup — chiefly "did I just clear the wrong buzz?",
 * which is why the one clear that can still be undone says so.
 *
 * Staff only (it names who cleared what). Worded here, once, so the MODAQ
 * panel and the plain reader page say the same thing.
 */
const RECENT_LIMIT = 40;
const RECENT_MISS = {
  locked: 'too late — the buzzer was locked',
  queued: 'already in the queue',
  duplicate: 'out of tries this question',
  not_open: 'the buzzer was not open'
};
export function recentActivity(room, limit = RECENT_LIMIT) {
  const items = [];
  const tail = (list) => (list || []).slice(-limit * 2);

  const buzzes = tail(room.buzzLog);
  // Margins against the buzz that won each question, as the activity log does.
  const firstOf = new Map();
  for (const b of room.buzzLog || []) {
    if (!b.accepted) continue;
    const best = firstOf.get(b.cycleNo);
    if (best == null || b.t < best) firstOf.set(b.cycleNo, b.t);
  }
  const pressed = new Set();
  for (const b of buzzes) {
    if (b.accepted) {
      const base = firstOf.get(b.cycleNo);
      const ms = base == null ? 0 : Math.max(0, Math.round(b.t - base));
      items.push({
        at: b.at, kind: 'buzz', question: b.question ?? null,
        text: `${b.name} buzzed${ms ? ` +${ms}ms` : ' first'}`,
        note: b.accidental ? 'cleared as accidental' : null
      });
    } else if (b.reason !== 'not_player') {
      // A locked buzzer gets hammered: one row per player per question says
      // they tried, without burying the clear the moderator is looking for.
      const key = `${b.cycleNo}:${b.playerId}`;
      if (pressed.has(key)) continue;
      pressed.add(key);
      items.push({
        at: b.at, kind: 'miss', question: b.question ?? null,
        text: `${b.name} pressed — ${RECENT_MISS[b.reason] || 'did not get in'}`
      });
    }
  }

  const undo = restorableClear(room);
  for (const e of tail(room.log)) {
    const who = e.by || 'A moderator';
    const names = (list) => (list || []).filter(Boolean).join(', ');
    switch (e.type) {
      case 'reset_buzzer': {
        const dropped = names(e.dropped);
        if (!dropped && e.by === 'Auto-clear') break; // nothing happened
        const how = e.judged === true ? 'cleared after scoring' : 'cleared without scoring';
        items.push({
          at: e.at, kind: e.judged === true ? 'clear' : 'clear-accidental', question: e.question ?? null,
          text: `${who} ${how}${dropped ? ` — dropped ${dropped}` : ' — nobody was on it'}`,
          note: e.restored ? 'undone' : null,
          undoId: undo && undo === e ? e.id : null
        });
        break;
      }
      case 'restore_buzzes':
        items.push({ at: e.at, kind: 'restore', text: `${who} undid the clear — ${names(e.restored)} back in` });
        break;
      case 'next_buzz':
        items.push({
          at: e.at, kind: 'next',
          text: `${who} moved past ${e.done || 'the buzz'}${e.headName ? ` — now ${e.headName}` : ''}`
        });
        break;
      case 'withdraw': {
        const name = e.name || e.playerId;
        items.push({
          at: e.at, kind: 'withdraw',
          text: e.byPlayer ? `${name} withdrew` : `${who} withdrew ${name}`,
          note: e.free === false ? 'not free' : null
        });
        break;
      }
      case 'stuck_alert':
        items.push({ at: e.at, kind: 'alert', text: `${e.name || e.playerId} says the buzzer is stuck` });
        break;
      case 'remove_player':
        items.push({ at: e.at, kind: 'room', text: `${who === 'A moderator' ? 'Removed' : `${who} removed`} ${e.name || e.playerId}` });
        break;
      case 'end_game':
        items.push({ at: e.at, kind: 'room', text: `${who} ended the game` });
        break;
      case 'reopen_game':
        items.push({ at: e.at, kind: 'room', text: `${who} reopened the game` });
        break;
      default:
        break;
    }
  }

  items.sort((a, b) => b.at - a.at);
  return items.slice(0, limit);
}

// An answer the room heard, written into the chat so everyone sees it — not
// only the players who happened to be in the buzz queue.
export function chatAnnounce(room, kind, payload) {
  if (!room.settings.shootout) return { error: 'disabled' };
  const res = shootout.announce(room, kind, payload);
  if (res.ok) persistRooms();
  return res;
}

// What to call a buzzer in a moderator-facing list.
export const memberName = (room, playerId) => {
  const m = room.members.get(playerId);
  return m ? displayName(m) : null;
};

// The two teams playing here, for working out who a protest is against.
export function activeTeams(room) {
  if (room.rosterTeams?.length) return [...room.rosterTeams];
  const seen = [];
  for (const m of room.members.values()) {
    const t = effectiveTeam(m);
    if (m.role === 'player' && t && !seen.includes(t)) seen.push(t);
  }
  return seen;
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
// How far behind the room a revealed question runs, unless the director says
// otherwise. See questionLag on the tournament.
const DEFAULT_QUESTION_LAG = 2;

const SCORESHEET_MAX_ROWS = 100;
const SCORESHEET_MAX_PLAYERS = 12;
// A match is nearly always two sides, but MODAQ now reads games with more —
// and a shootout is one per competitor, which is the whole point of it.
// A two-team match has two; a shootout has as many as turn up, and a Discord
// room of twenty-odd is the normal case rather than the extreme one. Sixteen
// silently dropped everyone after the sixteenth from the scoresheet AND from
// the leaderboard built out of it.
const SCORESHEET_MAX_TEAMS = 40;
const label = (v) => String(v ?? '').slice(0, 80);
const pts = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// --- Reveal gate -------------------------------------------------------------
// Two things on the players' scoresheet are safe AFTER a cycle and a disaster
// before it: the tossup's category, and — in a playtest — its answer line.
// Both are spoilers for a question nobody has heard, and readers do skip ahead
// in the packet (Next twice, the question chooser, a mis-click) to look at
// something later. So either is released only for a cycle the room has
// DEMONSTRABLY finished:
//
//   * never the question being read, nor any later one: the ceiling is clamped
//     to `current - 1` every time the sheet is built, so navigating back
//     re-hides whatever the reader had moved past;
//   * a cycle with a recorded buzz was played in front of the room, so
//     everything up to the last such cycle is released — this is what lets a
//     reconnecting or co-reading moderator pick up where the sheet left off;
//   * a dead tossup leaves no buzz behind, so it is released only when the
//     reader LEAVES it for the very next question after sitting on it for at
//     least CATEGORY_DWELL_MS. A jump forward isn't the next question, and a
//     fly-by isn't long enough, so neither releases anything.
//
// The gate lives on the room (`room.catGate`) and starts over with each game.
// It is runtime state, not persisted: after a restart it rebuilds itself from
// the buzzes on the record, which is the conservative half of the rule anyway.
const CATEGORY_DWELL_MS = 12000;
const CATEGORY_MAX = 240;          // packet tossups we'll keep categories for
const category = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
// An answer line is longer than a category and carries its own markup.
const answerLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
// A whole tossup, tags and all — MODAQ's own markup goes with it so the room
// reads the question as it was read to them.
const questionText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);

function revealCeiling(room, match, through, hasContent, now = Date.now()) {
  if (!room) return 0;
  const key = JSON.stringify((Array.isArray(match?.match_teams) ? match.match_teams : [])
    .slice(0, SCORESHEET_MAX_TEAMS).map((mt) => label(mt?.team?.name)));
  let g = room.catGate;
  // A different game (or a game restarted at question 1) releases nothing yet.
  if (!g || typeof g !== 'object' || g.key !== key || through <= 1) {
    g = room.catGate = { key, played: 0, question: 0, since: now };
  }
  if (g.question !== through) {
    // Credit the question just left only if the reader stepped forward by one
    // (so a jump into the rest of the packet credits nothing) and stayed long
    // enough to have actually read it.
    if (through === g.question + 1 && g.question >= 1 && now - g.since >= CATEGORY_DWELL_MS) {
      g.played = Math.max(g.played, g.question);
    }
    g.question = through;
    g.since = now;
  }
  // Cycles with a buzz on the record were heard by the room, full stop.
  for (const q of Array.isArray(match?.match_questions) ? match.match_questions : []) {
    const n = Number(q?.question_number);
    if (!Number.isFinite(n) || n < 1 || n >= through) continue;
    if ((Array.isArray(q.buzzes) ? q.buzzes.length : 0) > 0) g.played = Math.max(g.played, n);
  }
  return hasContent ? Math.max(0, Math.min(g.played, through - 1)) : 0;
}

export function buildPlayerScoresheet(match, currentQuestion, hasBonuses = true, protests = [], categories = [], ceiling = 0, answers = [], questionTexts = [], questionCeiling = 0) {
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
  const teams = match.match_teams.slice(0, SCORESHEET_MAX_TEAMS).map((mt) => ({
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
  // One running total per side, however many there are.
  const totals = teams.map(() => 0);
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
        // A bounceback only means anything with two sides — with more, there
        // is no single "other team" to give it to, and formats that read that
        // way don't bounce bonuses anyway.
        const other = teams.length === 2 ? 1 - winner.team : -1;
        if (other >= 0) totals[other] += bounced;
        bonus = { team: winner.team, parts, total: got, bounceback: (other >= 0 && bounced) || 0 };
      }
    }
    // A thrown-out tossup is something the room witnessed; nothing about the
    // replacement itself is carried. (In the QBJ the replacement's number is
    // the row's tossup number, so the thrown-out one is the number before.)
    const replaced = q.replacement_tossup_question != null;
    const thrownOut = replaced ? Math.max(1, pts(q.tossup_question?.question_number) - 1) : null;
    // The category of the tossup actually read here (its packet position, which
    // a throw-out shifts) — only for cycles the gate has released.
    const packetIndex = pts(q.tossup_question?.question_number) - 1;
    const cat = n <= ceiling ? category(categories[packetIndex]) : '';
    // In a playtest the answer line follows the same gate: the room may read
    // what the answer was once it has finished the cycle, and not before.
    const answer = n <= ceiling ? answerLine(answers[packetIndex]) : '';
    // The question itself runs further behind than everything else: its own
    // ceiling is the reveal gate minus the tournament's lag.
    const text = n <= questionCeiling ? questionText(questionTexts[packetIndex]) : '';
    rows.push({
      n,
      buzzes,
      bonus,
      replaced,
      thrownOut,
      category: cat || null,
      answer: answer || null,
      question: text || null,
      protests: protestsByCycle.get(n) || [],
      scores: [...totals]
    });
  }
  rows.sort((a, b) => a.n - b.n);
  return { teams, rows, through, current: through, total, scores: [...totals], at: Date.now() };
}

/**
 * Which question a player may protest.
 *
 * The client says which ROW of the scoresheet it means — a protest should name
 * the question out loud rather than meaning "whatever we're on", which is a
 * different question by the time the moderator reads it — and the server
 * checks the room actually got there. A number nobody has played is refused.
 *
 * The question being read counts only once something has happened on it. There
 * is nothing to protest about a tossup that hasn't been answered yet, and
 * before the first buzz of the game that is every question there is.
 */
export function protestableCycle(room, wanted) {
  const sheet = room.scoresheet;
  const current = Number(sheet?.current);
  if (!sheet || !Number.isFinite(current) || current < 1) return { error: 'no_question' };
  const n = wanted == null ? current : Math.floor(Number(wanted));
  if (!Number.isFinite(n) || n < 1 || n > current) return { error: 'no_question' };
  const row = (sheet.rows || []).find((r) => r.n === n);
  const played = (row?.buzzes?.length ?? 0) > 0 || !!row?.bonus || !!row?.thrownOut;
  if (!played) return { error: 'not_started' };
  return { cycle: n };
}

// The reader's page pushes its game on every change; keep the players' view.
// Clearing (a null match) hides the sheet, e.g. when the reader leaves a game.
export function setScoresheet(room, match, currentQuestion, hasBonuses = true, protests = [], categories = [], answers = [], questions = [], packetId = null) {
  // Which packet the sheet belongs to. A shootout reads several, and the score
  // on screen has to be filed under the one it was scored on — not under
  // whichever the room has moved to since.
  room.scoresheetPacket = packetId;
  if (match == null) {
    room.scoresheet = null;
    room.catGate = null;
    persistRooms();
    return { ok: true };
  }
  // The reader's page sends the WHOLE packet's categories; the gate decides how
  // far down them the room may see, and only when the director asked for them.
  const cats = scoresheetCategoriesOn(room) && Array.isArray(categories)
    ? categories.slice(0, CATEGORY_MAX).map(category)
    : [];
  // Answer lines only in a playtest, and only ever behind the same gate.
  const answerLines = playtestOn(room) && Array.isArray(answers)
    ? answers.slice(0, CATEGORY_MAX).map(answerLine)
    : [];
  const cur = Number(currentQuestion);
  const through = Number.isFinite(cur) && cur >= 1 ? Math.floor(cur) : 0;
  // A shootout runs over several packets in one sitting, so a new game is a
  // new PACKET rather than the end of the session: bank what the last one
  // finished with before the scoresheet is replaced by an empty game. A room
  // with a session banks per packet instead, when the reader moves between
  // them (see setShootoutCurrent) — which survives going back to an earlier
  // packet, as guessing from an empty game cannot.
  if (room.settings.shootout && !room.shootoutSession) bankIfNewGame(room, match);
  const reveal = questionRevealFor(room);
  const texts = reveal && Array.isArray(questions) ? questions.slice(0, CATEGORY_MAX).map(questionText) : [];
  const ceiling = revealCeiling(room, match, through,
    cats.length > 0 || answerLines.length > 0 || texts.length > 0);
  // The question text sits further back than the rest: the gate says the room
  // has finished the cycle, and the lag keeps it that many questions behind
  // besides.
  const questionCeiling = texts.length ? Math.max(0, ceiling - reveal.lag) : 0;
  room.scoresheet = buildPlayerScoresheet(match, currentQuestion, hasBonuses, protests, cats, ceiling,
    answerLines, texts, questionCeiling);
  persistRooms();
  return { ok: true };
}

// Did the room just start a different game? A game with no events at all,
// where the one on screen had some, is the next packet going in — the same
// test the moderator page uses to decide it is no longer editing the old game.
function bankIfNewGame(room, match) {
  const events = (Array.isArray(match?.match_questions) ? match.match_questions : [])
    .reduce((n, q) => n + (Array.isArray(q.buzzes) ? q.buzzes.length : 0), 0);
  const had = (room.scoresheet?.rows || []).some((r) => r.buzzes?.length || r.bonus);
  if (events === 0 && had) {
    shootout.bank(room, shootout.currentScores(room.scoresheet));
    const s = shootout.state(room);
    s.packets = (s.packets || 0) + 1;
  }
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
