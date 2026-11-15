// ---------------------------------------------------------------------------
// Disk-backed store for MODAQ-mode tournament artifacts.
//
// The realtime buzzer core is deliberately in-memory and single-instance (see
// store.js). But the MODAQ integration produces DURABLE records a tournament
// director and other moderators need to retrieve later, possibly after a server
// restart or redeploy:
//   * roster.qbj   — the registration/roster QBJ a MODAQ room defaults to
//   * packets/*    — round packet JSON a moderator loads into the reader
//   * exports/*    — the QBJ of a completed match, pushed on export
//   * errata.json  — question errata flagged by moderators
//
// These live on disk under DATA_DIR (a Fly volume in production) so they
// survive restarts. Everything is scoped to a "bucket": a tournament code when
// the room belongs to one, otherwise the room's own code, so a standalone
// MODAQ room still works.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
// The same split the /yapp page does, so a packet broken up here and one broken
// up in the browser produce identical files. It lives under public/ because the
// browser has to be able to fetch it; nothing in it is browser-specific.
import { splitIntoTiebreakers } from '../public/js/packet-split.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default to a repo-local ./data dir in dev; override with KLAXON_DATA_DIR
// (the Fly volume mount) in production.
export const DATA_DIR = process.env.KLAXON_DATA_DIR || path.join(__dirname, '..', 'data');

// Codes are our own room/tournament codes (see ids.js CODE_ALPHABET): uppercase
// letters + digits. Anything else is rejected before it can touch the fs.
const CODE_RE = /^[A-Z0-9]{3,8}$/;

// A bucket is { kind: 't' | 'r', code }. Tournament artifacts live under t/CODE,
// standalone-room artifacts under r/CODE.
function bucketDir(bucket) {
  const kind = bucket?.kind === 't' ? 't' : 'r';
  const code = String(bucket?.code || '').toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('bad_bucket_code');
  return path.join(DATA_DIR, kind, code);
}

// Sanitize a caller-supplied name (round label, export label) into a safe,
// bounded filename component. Never allow separators or dots that could escape.
function safeName(name, fallback = 'item') {
  const s = String(name ?? '').trim().replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/\.+/g, '.');
  const trimmed = s.replace(/^[._]+|[._]+$/g, '').slice(0, 60);
  return trimmed || fallback;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Write atomically: to a temp file in the same dir, then rename over the target
// so a crash mid-write can't leave a half-written artifact.
// A counter, not just the clock: two writes to the same file inside one
// millisecond would otherwise share a temp path, and one would rename the file
// the other is still writing.
let tmpSeq = 0;
async function writeAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function readTextOrNull(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function parseJsonOrThrow(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('bad_json'); }
}

// --- roster (registration QBJ) --------------------------------------------
// Stored as raw text so we hand the exact uploaded file back to MODAQ's
// parseQbjRegistration. We validate it's JSON on the way in, nothing more.

export async function saveRoster(bucket, jsonText) {
  parseJsonOrThrow(jsonText);
  const file = path.join(bucketDir(bucket), 'roster.qbj');
  await writeAtomic(file, jsonText);
  return { ok: true };
}

export async function getRoster(bucket) {
  return readTextOrNull(path.join(bucketDir(bucket), 'roster.qbj'));
}

// When a moderator plays someone who isn't on the roster (MODAQ's add-player),
// fold them into the stored registration QBJ so every other room's player pool
// picks them up. Players are only added to teams the roster already knows —
// an ad-hoc team a moderator typed in doesn't invent roster entries.
export async function addMatchPlayersToRoster(bucket, match) {
  const text = await getRoster(bucket);
  if (!text) return 0;
  let roster;
  try { roster = JSON.parse(text); } catch { return 0; }
  const registrations = Array.isArray(roster?.registrations) ? roster.registrations : [];
  const teamPlayers = new Map(); // team name -> live reference to its players array
  for (const reg of registrations) {
    for (const team of reg?.teams || []) {
      if (team?.name == null) continue;
      if (!Array.isArray(team.players)) team.players = [];
      teamPlayers.set(String(team.name), team.players);
    }
  }
  let added = 0;
  for (const mt of match?.match_teams || []) {
    const players = teamPlayers.get(String(mt?.team?.name ?? ''));
    if (!players) continue;
    const have = new Set(players.map((p) => String(p?.name ?? '').trim().toLowerCase()));
    for (const mp of mt?.match_players || []) {
      const name = String(mp?.player?.name ?? '').trim();
      if (!name || have.has(name.toLowerCase())) continue;
      players.push({ name });
      have.add(name.toLowerCase());
      added++;
    }
  }
  if (added > 0) await saveRoster(bucket, JSON.stringify(roster, null, 2));
  return added;
}

// --- round packets ---------------------------------------------------------
// A moderator uploads the JSON packet for a round; it's keyed by a round label
// so the whole tournament can share round packets and every room in that round
// reads the same questions.

// Per-round metadata (chiefly visibility to moderators), kept alongside the
// packet files in packets/_meta.json.
async function getPacketMeta(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'packets', '_meta.json'));
  if (!text) return {};
  try { const m = JSON.parse(text); return m && typeof m === 'object' ? m : {}; }
  catch { return {}; }
}
async function setPacketMeta(bucket, meta) {
  await writeAtomic(path.join(bucketDir(bucket), 'packets', '_meta.json'), JSON.stringify(meta, null, 2));
}

// opts.visible controls whether moderators can see/load the round. Director
// uploads default to hidden; a moderator uploading their own round marks it
// visible. opts.tiebreaker marks the packet as a pool of tiebreaker questions.
// Existing flags are kept unless a value is given.
export async function savePacket(bucket, round, jsonText, opts = {}) {
  const packet = parseJsonOrThrow(jsonText);
  if (!packet || !Array.isArray(packet.tossups)) throw new Error('bad_packet');
  const name = safeName(round, 'round');
  const file = path.join(bucketDir(bucket), 'packets', `${name}.json`);
  await writeAtomic(file, jsonText);
  const meta = await getPacketMeta(bucket);
  const prev = meta[name] || {};
  meta[name] = {
    visible: typeof opts.visible === 'boolean' ? opts.visible : (prev.visible ?? false),
    tiebreaker: typeof opts.tiebreaker === 'boolean' ? opts.tiebreaker : (prev.tiebreaker ?? false),
    // Counted here because the packet is already parsed; the console uses it to
    // know a round has more than one question in it, and so is worth splitting.
    // Rounds uploaded before this was recorded simply don't have it.
    tossups: packet.tossups.length,
    uploadedAt: Date.now(),
    // The room whose moderator uploaded it, or null for the director's. A
    // moderator may replace only their own room's upload (see packetOwner).
    uploadedBy: opts.uploadedBy !== undefined ? opts.uploadedBy : (prev.uploadedBy ?? null),
    // A new version of a round keeps its place in the director's order.
    ...(Number.isFinite(prev.order) ? { order: prev.order } : {}),
  };
  await setPacketMeta(bucket, meta);
  return { round: name, visible: meta[name].visible, tiebreaker: meta[name].tiebreaker, tossups: meta[name].tossups };
}

// Is there already a packet under this round label, and who put it there?
// { exists, uploadedBy } — uploadedBy is a room code, or null for the director
// (and for rounds stored before uploads were attributed, which were nearly
// all the director's).
export async function packetOwner(bucket, round) {
  const name = safeName(round, 'round');
  const meta = await getPacketMeta(bucket);
  const exists = !!meta[name] || (await readTextOrNull(path.join(bucketDir(bucket), 'packets', `${name}.json`))) != null;
  return { exists, uploadedBy: meta[name]?.uploadedBy ?? null };
}

// Rounds the director has placed come first, in that order; the rest follow by
// name, with numbers compared as numbers so "2" sorts before "10".
const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
function packetOrderCompare(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : Infinity;
  const ob = Number.isFinite(b.order) ? b.order : Infinity;
  return oa !== ob ? oa - ob : naturalCompare(a.round, b.round);
}

// Returns [{ round, visible, tiebreaker, tossups, order }] for every stored
// round, in the order the director set (see setPacketOrder).
export async function listPackets(bucket) {
  const dir = path.join(bucketDir(bucket), 'packets');
  try {
    const files = await fs.readdir(dir);
    const meta = await getPacketMeta(bucket);
    return files
      .filter((f) => f.endsWith('.json') && f !== '_meta.json')
      .map((f) => f.replace(/\.json$/, ''))
      .map((round) => ({
        round,
        visible: !!meta[round]?.visible,
        tiebreaker: !!meta[round]?.tiebreaker,
        // undefined for a round saved before the count was recorded
        tossups: meta[round]?.tossups,
        order: meta[round]?.order
      }))
      .sort(packetOrderCompare);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function setPacketFlag(bucket, round, flag, value) {
  const name = safeName(round, 'round');
  const meta = await getPacketMeta(bucket);
  meta[name] = { ...(meta[name] || {}), [flag]: !!value };
  await setPacketMeta(bucket, meta);
  return { round: name, [flag]: !!value };
}
export const setPacketVisibility = (bucket, round, visible) => setPacketFlag(bucket, round, 'visible', visible);
export const setPacketTiebreaker = (bucket, round, tiebreaker) => setPacketFlag(bucket, round, 'tiebreaker', tiebreaker);

// The director's drag-to-reorder: `rounds` is the whole list, top to bottom.
// Names that aren't stored rounds are ignored; stored rounds missing from it
// lose their place and fall to the end, sorted by name.
export async function setPacketOrder(bucket, rounds) {
  const meta = await getPacketMeta(bucket);
  const stored = new Set((await listPackets(bucket)).map((p) => p.round));
  for (const name of Object.keys(meta)) delete meta[name].order;
  let i = 0;
  for (const r of rounds) {
    const name = safeName(r, 'round');
    if (!stored.has(name) || Number.isFinite(meta[name]?.order)) continue;
    meta[name] = { ...(meta[name] || {}), order: i++ };
  }
  await setPacketMeta(bucket, meta);
  return listPackets(bucket);
}

export async function deletePacket(bucket, round) {
  const name = safeName(round, 'round');
  await fs.rm(path.join(bucketDir(bucket), 'packets', `${name}.json`), { force: true });
  const meta = await getPacketMeta(bucket);
  delete meta[name];
  await setPacketMeta(bucket, meta);
}

export async function isPacketVisible(bucket, round) {
  const meta = await getPacketMeta(bucket);
  return !!meta[safeName(round, 'round')]?.visible;
}

// Flat pool of tossups from every released (visible) tiebreaker packet, each
// tagged with its source round + question number so usage can be tracked.
export async function getTiebreakerTossups(bucket) {
  const list = await listPackets(bucket);
  const out = [];
  for (const p of list) {
    if (!p.tiebreaker || !p.visible) continue;
    const text = await getPacket(bucket, p.round);
    if (!text) continue;
    let packet;
    try { packet = JSON.parse(text); } catch { continue; }
    (packet.tossups || []).forEach((tu, i) => {
      out.push({ round: p.round, questionNumber: i + 1, question: String(tu.question ?? ''), answer: String(tu.answer ?? '') });
    });
  }
  return out;
}

// --- tiebreaker usage ------------------------------------------------------
// Records which tiebreaker question was read, in which room/round, and which
// teams heard it — so the director doesn't reuse a tiebreaker on teams that
// already saw it.
export async function getTiebreakerUsage(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'tiebreakers-usage.json'));
  if (!text) return [];
  try { const a = JSON.parse(text); return Array.isArray(a) ? a : []; } catch { return []; }
}

export async function addTiebreakerUsage(bucket, entry) {
  const file = path.join(bucketDir(bucket), 'tiebreakers-usage.json');
  const list = await getTiebreakerUsage(bucket);
  const normalized = {
    tbRound: String(entry?.tbRound ?? ''),
    questionNumber: Number(entry?.questionNumber) || 0,
    room: String(entry?.room ?? '').toUpperCase(),
    gameRound: String(entry?.gameRound ?? ''),
    teams: Array.isArray(entry?.teams) ? entry.teams.map(String) : [],
    at: Date.now(),
  };
  // De-dupe: the same TB question read to the same teams in the same game
  // shouldn't pile up (MODAQ may fire the add more than once).
  const key = (e) => `${e.tbRound}|${e.questionNumber}|${e.room}|${e.gameRound}`;
  const kept = list.filter((e) => key(e) !== key(normalized));
  kept.push(normalized);
  await writeAtomic(file, JSON.stringify(kept, null, 2));
  return kept;
}

export async function getPacket(bucket, round) {
  const name = safeName(round, 'round');
  return readTextOrNull(path.join(bucketDir(bucket), 'packets', `${name}.json`));
}

// Breaks a stored packet into one round per tossup, each marked as a tiebreaker
// and hidden. Tiebreaker visibility is per-round, so a twenty-question pool in
// one file is released all at once or not at all; split up, a director can hold
// the whole pool back and release the single question a room needs.
//
// The source round is then deleted: left behind, it is a second copy of every
// question in the list, and a director has to work out which one is real.
// Usage already recorded against it stays in tiebreakers-usage.json.
export async function splitPacketIntoTiebreakers(bucket, round) {
  const text = await getPacket(bucket, round);
  if (text == null) throw new Error('no_packet');
  const packet = parseJsonOrThrow(text);
  const label = safeName(round, 'round');
  const parts = splitIntoTiebreakers(packet, { label });
  if (!parts.length) throw new Error('no_tossups');
  // Splitting a single question just renames it, and leaves a round behind that
  // offers to split itself again.
  if (parts.length < 2) throw new Error('already_single');

  const created = [];
  for (const part of parts) {
    const saved = await savePacket(bucket, part.name, JSON.stringify(part.packet, null, 2),
      { visible: false, tiebreaker: true });
    created.push(saved.round);
  }
  // Only once every new round is safely on disk: if a write had failed halfway,
  // the source is still the pool it was.
  // The new rounds take the source's place in the director's order.
  const order = (await listPackets(bucket)).map((p) => p.round)
    .filter((r) => !created.includes(r))
    .flatMap((r) => (r === label ? created : [r]));
  await deletePacket(bucket, round);
  await setPacketOrder(bucket, order);
  return { round: label, created };
}

// --- buzz points ------------------------------------------------------------
// The full buzz log of every room in the tournament, kept per room so two rooms
// syncing at once can't clobber each other. A room's file is REPLACED on each
// sync rather than appended to: the room already holds the whole log, so the
// latest copy is the complete one, and a re-sync of the same game can't
// duplicate its buzzes.
function buzzPointsDir(bucket) {
  return path.join(bucketDir(bucket), 'buzzpoints');
}

export async function saveRoomBuzzPoints(bucket, roomCode, payload) {
  const dir = buzzPointsDir(bucket);
  await ensureDir(dir);
  await writeAtomic(path.join(dir, `${safeName(roomCode, 'room')}.json`), JSON.stringify(payload));
  return { ok: true };
}

// Every room's buzzes, flattened. Rooms still in memory are better read live
// (see the route) — this is what's left of the ones that have gone.
export async function readAllBuzzPoints(bucket) {
  const dir = buzzPointsDir(bucket);
  let files;
  try { files = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    const text = await readTextOrNull(path.join(dir, f));
    if (text == null) continue;
    try {
      const rec = JSON.parse(text);
      if (rec && Array.isArray(rec.buzzes)) out.push(rec);
    } catch { /* a half-written file is skipped, not fatal */ }
  }
  return out;
}

// --- off-roster joins -------------------------------------------------------
// Players who joined a roster room under a name the roster doesn't have. Kept
// with the tournament so a director who was away still sees them; capped so a
// misbehaving room can't grow the file without bound.
const ROSTER_ALERT_LIMIT = 200;

function rosterAlertsFile(bucket) {
  return path.join(bucketDir(bucket), 'roster-alerts.json');
}

export async function getRosterAlerts(bucket) {
  const text = await readTextOrNull(rosterAlertsFile(bucket));
  if (text == null) return [];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function addRosterAlert(bucket, alert) {
  const list = await getRosterAlerts(bucket);
  // One entry per player per room: a reconnect isn't news.
  const key = (a) => `${a.room}|${a.playerId}`;
  const kept = list.filter((a) => key(a) !== key(alert));
  kept.push(alert);
  const trimmed = kept.slice(-ROSTER_ALERT_LIMIT);
  await writeAtomic(rosterAlertsFile(bucket), JSON.stringify(trimmed, null, 2));
  return trimmed;
}

export async function clearRosterAlerts(bucket) {
  await writeAtomic(rosterAlertsFile(bucket), '[]');
}

// --- MASSINGER pick/ban boards ---------------------------------------------
// The finished (or in-progress) pick/ban board for one room+round. Always
// stored under the ROOM bucket — rooms in the same tournament round run
// independent pick/bans, so the shared tournament bucket is the wrong scope.
// Written on every action so a moderator reload or server restart resumes the
// board (and, once done, keeps determining the filtered packet all game).

function massingerFile(roomCode, round) {
  return path.join(bucketDir({ kind: 'r', code: roomCode }), 'massinger', `${safeName(round, 'round')}.json`);
}

export async function saveMassinger(roomCode, round, state) {
  await writeAtomic(massingerFile(roomCode, round), JSON.stringify(state, null, 2));
}

export async function getMassinger(roomCode, round) {
  const text = await readTextOrNull(massingerFile(roomCode, round));
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function deleteMassinger(roomCode, round) {
  await fs.rm(massingerFile(roomCode, round), { force: true });
}

// --- shared MODAQ game state -----------------------------------------------
// The reader's serialized MODAQ game (the same JSON MODAQ persists locally),
// kept per room so a moderator can reconnect from any device and a co-reader
// can score the same game. It contains the packet: never served to players.
function modaqStateFile(roomCode) {
  return path.join(bucketDir({ kind: 'r', code: roomCode }), 'modaq-state.json');
}

export async function saveModaqState(roomCode, state) {
  await writeAtomic(modaqStateFile(roomCode), JSON.stringify(state));
}

export async function getModaqState(roomCode) {
  const text = await readTextOrNull(modaqStateFile(roomCode));
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// --- previous games ----------------------------------------------------------
// Finished (or abandoned) MODAQ games of a room, one file each: the same
// serialized game as the shared state plus a summary for listing. A moderator
// outside a tournament reloads one to fix a score after the fact.
function gamesDir(roomCode) {
  return path.join(bucketDir({ kind: 'r', code: roomCode }), 'games');
}

export async function saveGame(roomCode, record) {
  await writeAtomic(path.join(gamesDir(roomCode), `${safeName(record.id, 'game')}.json`), JSON.stringify(record));
}

export async function getGame(roomCode, id) {
  const text = await readTextOrNull(path.join(gamesDir(roomCode), `${safeName(id, 'game')}.json`));
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Summaries only (no game JSON), newest first.
export async function listGames(roomCode) {
  const dir = gamesDir(roomCode);
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const text = await readTextOrNull(path.join(dir, f));
      if (text == null) continue;
      try {
        const { json, ...meta } = JSON.parse(text);
        out.push(meta);
      } catch { /* skip a bad file */ }
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// --- exported match QBJ ----------------------------------------------------
// On export, MODAQ hands us the match QBJ; we archive it under the tournament
// so the TD and other moderators can retrieve it. Timestamp is supplied by the
// caller (server clock) to keep this module free of ambient Date usage in the
// name only — here we just use it as given.

// The filename is STABLE per (room, round) — a re-export (including the live
// per-change sync) overwrites the same file, so the tournament ends up with one
// current QBJ per match instead of hundreds of timestamped duplicates. The file
// mtime records when it was last synced.
export async function saveExport(bucket, { room, round, qbj, inProgress = false, currentQuestion, regulation, at }) {
  const roomPart = safeName(room, 'room');
  const roundPart = safeName(round, 'r');
  const filename = `${roomPart}-${roundPart}.qbj`;
  // Stamp the round/room onto the match so the stats engine can group by round
  // regardless of the filename (round labels may contain characters we sanitize).
  let obj = typeof qbj === 'string' ? parseJsonOrThrow(qbj) : qbj;
  const file = path.join(bucketDir(bucket), 'exports', filename);
  if (obj && typeof obj === 'object') {
    obj = { ...obj, _round: String(round ?? ''), _room: String(room ?? '') };
    if (Number(regulation) > 0) obj._regulationTossupCount = Number(regulation);
    // A live sync marks the match in progress so stats don't count a half-played
    // game as a W/L yet. Final is sticky per matchup: once this room+round has
    // been saved as final for the same teams, post-game review edits (which sync
    // from an earlier question index) must not flip it back to "live".
    const prev = await previousExport(file);
    const same = prev && prev.teams === matchTeamNames(obj);
    if (inProgress && !(same && !prev.inProgress)) {
      obj._inProgress = true;
      // Which question the reader is on, plus when the game first went live, so
      // the live stats view can show progress and elapsed time.
      if (Number.isFinite(currentQuestion) && currentQuestion > 0) obj._currentQuestion = currentQuestion;
      obj._startedAt = (same && prev.inProgress && Number.isFinite(prev.startedAt) ? prev.startedAt : null) ?? at ?? Date.now();
    }
  }
  const text = JSON.stringify(obj, null, 2);
  await writeAtomic(file, text);
  noteExport(file, obj);
  exportWritten(file, text);
  return { filename };
}

// What the last save of each stats file said about its game, so a live
// re-sync doesn't read and parse the file twice to find out (see saveExport).
// Kept for files written this run; anything else is read once.
const exportNotes = new Map(); // file -> { teams, inProgress, startedAt } | null
function noteExport(file, obj) {
  exportNotes.set(file, obj && typeof obj === 'object'
    ? { teams: matchTeamNames(obj), inProgress: obj._inProgress === true, startedAt: obj._startedAt }
    : null);
}
async function previousExport(file) {
  if (exportNotes.has(file)) return exportNotes.get(file);
  const text = await readTextOrNull(file);
  let obj = null;
  if (text != null) { try { obj = JSON.parse(text); } catch { obj = null; } }
  noteExport(file, obj);
  return exportNotes.get(file);
}

const matchTeamNames = (m) =>
  (Array.isArray(m?.match_teams) ? m.match_teams : []).map((mt) => mt?.team?.name || '?').sort().join(' ');

// --- protest rulings ---------------------------------------------------------
// The director's ruling on a protest lives inside the match's stored QBJ under
// _protestRulings, keyed by the protest's identity, so it survives restarts and
// travels with the game. An upheld ruling carries per-team point adjustments
// the stats engine folds into that game's totals.

export const protestKey = ({ type, question, part, team }) =>
  `${type === 'bonus' ? 'bonus' : 'tossup'}|${Number(question) || 0}|${Number(part) || 0}|${String(team ?? '')}`;

// One match, parsed, by the room and round that played it — the same file
// setProtestRuling writes into. Null when there is no such match.
export async function getMatch(bucket, room, round) {
  const file = path.join(bucketDir(bucket), 'exports', `${safeName(room, 'room')}-${safeName(round, 'r')}.qbj`);
  const text = await readTextOrNull(file);
  if (text == null) return null;
  try {
    const obj = JSON.parse(text);
    // The export wraps the match; older ones are the match itself.
    return obj?.qbj ?? obj;
  } catch { return null; }
}

export async function setProtestRuling(bucket, { room, round, type, question, part, team, status, note, adjustments, resolution, gameplay }) {
  const file = path.join(bucketDir(bucket), 'exports', `${safeName(room, 'room')}-${safeName(round, 'r')}.qbj`);
  const text = await readTextOrNull(file);
  if (text == null) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const rulings = obj._protestRulings && typeof obj._protestRulings === 'object' ? obj._protestRulings : {};
  const key = protestKey({ type, question, part, team });
  const st = status === 'upheld' ? 'upheld' : status === 'denied' ? 'denied' : null;
  if (st == null) {
    delete rulings[key]; // clear the ruling: the protest is open again
  } else {
    rulings[key] = {
      status: st,
      note: String(note ?? '').slice(0, 500),
      adjustments: st === 'upheld'
        ? (Array.isArray(adjustments) ? adjustments : [])
          .map((a) => ({ team: String(a?.team ?? ''), points: Number(a?.points) || 0 }))
          .filter((a) => a.team && a.points !== 0)
        : [],
      // Which ACF resolution the director chose, and what it leaves to be
      // played (see resolution.js). A protest can be settled on the score and
      // still owe a replacement question, and the console has to show that.
      resolution: resolution ? String(resolution).slice(0, 40) : null,
      gameplay: Array.isArray(gameplay) ? gameplay : [],
      playedAt: null,
      at: Date.now(),
    };
  }
  obj._protestRulings = rulings;
  const written = JSON.stringify(obj, null, 2);
  await writeAtomic(file, written);
  exportWritten(file, written);
  return rulings[key] ?? { cleared: true };
}

// --- games the director took out of the stats ------------------------------
// exports/_removed.json: filename -> { teams, at }. Kept, not deleted, so it is
// reversible, and so a reader still syncing the game can't put it back. Keyed
// by the matchup too: a NEW game in the same room and round (other teams)
// isn't the one that was removed, and counts.
async function getRemoved(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'exports', '_removed.json'));
  if (!text) return {};
  try { const m = JSON.parse(text); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}
const isRemoved = (removed, filename, qbj) =>
  !!removed[filename] && removed[filename].teams === matchTeamNames(qbj);

export async function setExportRemoved(bucket, filename, remove) {
  const safe = safeName(String(filename || ''), '').replace(/\.qbj$/, '');
  if (!safe) throw new Error('no_export');
  const f = `${safe}.qbj`;
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'exports', f));
  if (text == null) throw new Error('no_export');
  const removed = await getRemoved(bucket);
  if (remove) removed[f] = { teams: matchTeamNames(parseJsonOrThrow(text)), at: Date.now() };
  else delete removed[f];
  await ensureDir(path.join(bucketDir(bucket), 'exports'));
  await writeAtomic(path.join(bucketDir(bucket), 'exports', '_removed.json'), JSON.stringify(removed, null, 2));
  removedWritten(bucket, removed);
  return { filename: f, removed: !!remove };
}

// --- the parsed games, cached ----------------------------------------------
// Every stats page, the live board, the director console's lists and the
// downloads all want every game in a tournament, parsed. They used to read
// and JSON.parse every file on every request: stats pages refresh themselves
// every 20-60 s, a console polls four of these every 15 s, so a few open tabs
// at a big event spent the machine's whole CPU budget re-parsing the same
// unchanged files. Now each tournament's games are read once and kept, and a
// save updates just its own entry.
//
// The objects handed out are SHARED and deep-frozen: a reader that tries to
// change one throws (modules are strict) instead of quietly changing every
// later reader's copy. Copy before editing (structuredClone).
//
// At most EXPORT_CACHE_MAX tournaments are kept, and one nobody has asked for
// in EXPORT_CACHE_IDLE_MS is dropped: parsed games are several times their
// size on disk.
const EXPORT_CACHE_MAX = 8;
const EXPORT_CACHE_IDLE_MS = 15 * 60_000;
const exportCaches = new Map(); // exports dir -> { entries: Map(filename -> entry), removed, usedAt }
const exportLoads = new Map();  // exports dir -> promise of a load in progress
const exportGen = new Map();    // exports dir -> writes so far (a load that raced one isn't kept)

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
const exportsDirOf = (bucket) => path.join(bucketDir(bucket), 'exports');

async function exportCache(bucket) {
  const dir = exportsDirOf(bucket);
  const hit = exportCaches.get(dir);
  if (hit) { hit.usedAt = Date.now(); return hit; }
  if (exportLoads.has(dir)) return exportLoads.get(dir);
  const gen = exportGen.get(dir) || 0;
  const load = (async () => {
    const entries = new Map();
    let files = [];
    try { files = await fs.readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const f of files) {
      if (!f.endsWith('.qbj')) continue;
      const text = await readTextOrNull(path.join(dir, f));
      if (text == null) continue;
      let qbj = null;
      try { qbj = deepFreeze(JSON.parse(text)); } catch { /* listed, but not a game */ }
      const stat = await fs.stat(path.join(dir, f)).catch(() => null);
      entries.set(f, { filename: f, size: stat?.size ?? text.length, savedAt: stat?.mtimeMs ?? Date.now(), qbj });
    }
    const cache = { entries, removed: await getRemoved(bucket), usedAt: Date.now() };
    // A save landed while this was reading: what it read may be older. Hand it
    // to whoever asked, but let the next reader load afresh.
    if ((exportGen.get(dir) || 0) === gen) {
      exportCaches.set(dir, cache);
      trimExportCaches();
    }
    return cache;
  })();
  exportLoads.set(dir, load);
  try { return await load; } finally { exportLoads.delete(dir); }
}

function trimExportCaches() {
  const now = Date.now();
  for (const [dir, c] of exportCaches) if (now - c.usedAt > EXPORT_CACHE_IDLE_MS) exportCaches.delete(dir);
  while (exportCaches.size > EXPORT_CACHE_MAX) {
    let oldest = null;
    for (const [dir, c] of exportCaches) if (!oldest || c.usedAt < oldest[1].usedAt) oldest = [dir, c];
    exportCaches.delete(oldest[0]);
  }
}
setInterval(trimExportCaches, 60_000).unref();

// A stats file was just written with `text`: its cache entry follows.
function exportWritten(file, text) {
  const dir = path.dirname(file);
  exportGen.set(dir, (exportGen.get(dir) || 0) + 1);
  const c = exportCaches.get(dir);
  if (!c) return;
  let qbj = null;
  try { qbj = deepFreeze(JSON.parse(text)); } catch { /* not a game */ }
  const f = path.basename(file);
  c.entries.set(f, { filename: f, size: Buffer.byteLength(text), savedAt: Date.now(), qbj });
}
function removedWritten(bucket, removed) {
  const dir = exportsDirOf(bucket);
  exportGen.set(dir, (exportGen.get(dir) || 0) + 1);
  const c = exportCaches.get(dir);
  if (c) c.removed = removed;
}

// Every exported match in a bucket, parsed — for stats, the live board,
// downloads. Games the director removed are left out unless asked for.
// The qbj objects are shared and frozen (see above).
export async function readAllExports(bucket, { includeRemoved = false } = {}) {
  const c = await exportCache(bucket);
  const out = [];
  for (const e of c.entries.values()) {
    if (!e.qbj) continue;
    if (!includeRemoved && isRemoved(c.removed, e.filename, e.qbj)) continue;
    out.push({ filename: e.filename, savedAt: e.savedAt, qbj: e.qbj });
  }
  return out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}

// Every match file, removed ones flagged (the director's list shows them, to
// restore), with the teams so a row can say which game it is.
export async function listExports(bucket) {
  const c = await exportCache(bucket);
  const out = [];
  for (const e of c.entries.values()) {
    const qbj = e.qbj;
    out.push({
      filename: e.filename, size: e.size, savedAt: e.savedAt,
      teams: qbj ? (qbj.match_teams || []).map((mt) => mt?.team?.name).filter(Boolean) : [],
      round: qbj?._round != null ? String(qbj._round) : null,
      removed: qbj ? isRemoved(c.removed, e.filename, qbj) : false
    });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

// How many saves this bucket's games have had (this run): a key for anything
// computed from them (see statsFor in index.js).
export function exportsVersion(bucket) {
  return exportGen.get(exportsDirOf(bucket)) || 0;
}

export async function getExport(bucket, filename) {
  const safe = safeName(filename, '').replace(/\.qbj$/, '');
  if (!safe) return null;
  return readTextOrNull(path.join(bucketDir(bucket), 'exports', `${safe}.qbj`));
}

// --- errata ----------------------------------------------------------------
// errata.json is a flat array of entries. Each moderator owns the errata for
// their (room, round) scope; a PUT replaces just that scope so two moderators
// don't clobber each other, while the TD's GET returns the whole list.

export async function getErrata(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'errata.json'));
  if (!text) return [];
  try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

const scopeKey = (e) => `${String(e?.room || '').toUpperCase()}|${String(e?.round ?? '')}`;

// Replace all errata for the (room, round) scope with `entries`, leaving other
// scopes untouched. Returns the merged full list.
export async function replaceErrataForScope(bucket, { room, round }, entries) {
  const file = path.join(bucketDir(bucket), 'errata.json');
  const current = await getErrata(bucket);
  const key = scopeKey({ room, round });
  const kept = current.filter((e) => scopeKey(e) !== key);
  const normalized = (Array.isArray(entries) ? entries : []).map((e) => ({
    room: String(room || '').toUpperCase(),
    round: String(round ?? ''),
    questionNumber: Number(e?.questionNumber) || 0,
    questionType: e?.questionType === 'bonus' ? 'bonus' : 'tossup',
    thrownOut: !!e?.thrownOut,
    text: String(e?.text ?? '').slice(0, 2000),
    at: Number(e?.at) || Date.now()
  }));
  const merged = [...kept, ...normalized];
  await writeAtomic(file, JSON.stringify(merged, null, 2));
  return merged;
}

// --- tournament structure (phases + divisions) -----------------------------
// The director's grouping of rounds into phases and teams into divisions/tiers.
// Persisted to disk so the (public, disk-backed) stats can group by it even
// after a restart.

export async function getStructure(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'structure.json'));
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function saveStructure(bucket, structure) {
  const phases = (Array.isArray(structure?.phases) ? structure.phases : []).map((p) => ({
    name: String(p?.name ?? '').slice(0, 60),
    rounds: Array.isArray(p?.rounds) ? p.rounds.map(String) : [],
    color: typeof p?.color === 'string' ? p.color : undefined,
  })).filter((p) => p.name);
  const divisions = (Array.isArray(structure?.divisions) ? structure.divisions : []).map((d) => ({
    phase: String(d?.phase ?? ''),
    name: String(d?.name ?? '').slice(0, 60),
    teams: Array.isArray(d?.teams) ? d.teams.map(String) : [],
  })).filter((d) => d.name);
  const obj = { phases, divisions };
  await writeAtomic(path.join(bucketDir(bucket), 'structure.json'), JSON.stringify(obj, null, 2));
  return obj;
}

// --- tournament + room records (restart survival) ---------------------------
// The in-memory store (store.js) is authoritative while running, but tournament
// records and room identities are written here so a restart/deploy doesn't
// orphan every director console and reader link. Live buzz state is NOT saved.

// Chained per tournament like room records below: two quick changes (a schedule
// save, then auto-release) must land in order, or the older record wins.
const tournamentWrites = new Map(); // code -> promise of its last write
export function saveTournamentRecord(record) {
  const file = path.join(bucketDir({ kind: 't', code: record.code }), 'tournament.json');
  const text = JSON.stringify(record, null, 2);
  const next = (tournamentWrites.get(record.code) || Promise.resolve())
    .catch(() => { /* a failed write must not stall later ones */ })
    .then(() => writeAtomic(file, text));
  tournamentWrites.set(record.code, next);
  next.finally(() => { if (tournamentWrites.get(record.code) === next) tournamentWrites.delete(record.code); }).catch(() => {});
  return next;
}

// Every tournament and room record write still in flight, for a clean
// shutdown: a deploy stops the process, and a half-done write is a lost change.
export function flushRecordWrites() {
  return Promise.allSettled([...roomWrites.values(), ...tournamentWrites.values()]);
}

export async function loadTournamentRecords() {
  const dir = path.join(DATA_DIR, 't');
  let codes;
  try { codes = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const code of codes) {
    if (!CODE_RE.test(code)) continue;
    const text = await readTextOrNull(path.join(dir, code, 'tournament.json'));
    if (!text) continue; // pre-persistence bucket (artifacts only); nothing to restore
    try { out.push(JSON.parse(text)); } catch { /* skip a corrupt record */ }
  }
  return out;
}

// Each room is its own record, r/CODE/room.json (see store.flushRooms). Writes
// to one room are chained so the last call is the last write — two in flight
// could otherwise finish out of order and leave the older record on disk.
const roomRecordFile = (code) => path.join(bucketDir({ kind: 'r', code }), 'room.json');
const roomWrites = new Map(); // code -> promise of its last write
export function saveRoomRecord(record) {
  const text = JSON.stringify(record);
  const next = (roomWrites.get(record.code) || Promise.resolve())
    .catch(() => { /* a failed write must not stall later ones */ })
    .then(() => writeAtomic(roomRecordFile(record.code), text));
  roomWrites.set(record.code, next);
  next.finally(() => { if (roomWrites.get(record.code) === next) roomWrites.delete(record.code); }).catch(() => {});
  return next;
}

// One room's record, read synchronously: store.getRoom loads a dormant room on
// first use and has to answer there and then. A single room is a few hundred
// KB at most.
export function loadRoomRecordSync(code) {
  try { return JSON.parse(fsSync.readFileSync(roomRecordFile(code), 'utf8')); }
  catch { return null; }
}

// Every room record, at boot. Rooms used to live in one rooms.json; the first
// boot after the change writes each of them out to its own file and leaves
// rooms.json where it is (frozen from then on), so a rollback to the old code
// still boots with every room. rooms.json.migrated marks it done.
//
// `activeSince`: skip, without reading it, any record last written before
// then. Everything in a record (its dates, its log) is older than the write
// that put it there, so a file untouched since `activeSince` can only hold a
// room idle since then: store.hydrate would leave it on disk anyway. Boot reads
// the handful of recent rooms instead of every room ever made (about 47 KB
// each on average, so 10,000 rooms would be ~470 MB of JSON).
export async function loadRoomRecords({ activeSince = 0 } = {}) {
  await migrateRoomsJson();
  const dir = path.join(DATA_DIR, 'r');
  let codes;
  try { codes = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  codes = codes.filter((c) => CODE_RE.test(c));
  const out = [];
  const one = async (code) => {
    const file = path.join(dir, code, 'room.json');
    if (activeSince) {
      let st;
      try { st = await fs.stat(file); } catch { return; } // no record: artifacts only
      if (st.mtimeMs < activeSince) return;
    }
    const text = await readTextOrNull(file);
    if (!text) return; // artifacts only (an old shared game, filed games): no record
    try { out.push(JSON.parse(text)); } catch { /* skip a corrupt record */ }
  };
  for (let i = 0; i < codes.length; i += 32) await Promise.all(codes.slice(i, i + 32).map(one));
  return out;
}

// --- clearing out old rooms ------------------------------------------------------
// Nothing used to delete a room's folder: a room past its TTL just stopped
// loading, and r/CODE (record, packets, filed games, shared MODAQ game) stayed
// on the volume for good. Every game scored in a room is in the game archive
// (games/), which this never touches, so the folder is dead weight once the
// room is.
//
// A folder goes when:
//   - keep(record) says no (the caller's rule: age, a tournament that still
//     exists), judged on the record's own dates, not room.json's mtime (the
//     2026-11-14 migration rewrote every room.json);
//   - nothing else in it was written since `cutoff`;
//   - inUse(code) is false (in memory, or a write pending).
// A folder with no record (rooms from before records, or a record lost) goes on
// the newest-file rule alone. Never before the pre-archive games were copied
// into the archive (importLegacyGames): until then r/CODE is their only copy.
// Every deletion is appended to purged-rooms.log on the volume.
export async function purgeOldRooms({ cutoff, keep, inUse = () => false, dryRun = false }) {
  const result = { removed: [], bytes: 0, skipped: 'none' };
  if (!fsSync.existsSync(LEGACY_IMPORT_DONE())) { result.skipped = 'legacy_import_pending'; return result; }
  const dir = path.join(DATA_DIR, 'r');
  let codes;
  try { codes = await fs.readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return result; throw e; }
  for (const code of codes) {
    if (!CODE_RE.test(code) || inUse(code) || roomWrites.has(code)) continue;
    const folder = path.join(dir, code);
    let files;
    try { files = await filesUnder(folder); } catch { continue; }
    let record = null;
    const recordFile = path.join(folder, 'room.json');
    if (files.some((f) => f.file === recordFile)) {
      try { record = JSON.parse(await fs.readFile(recordFile, 'utf8')); } catch { continue; } // unreadable: leave it be
      if (keep(record)) continue;
    }
    // Anything but the record written recently: the folder is still in use.
    if (files.some((f) => f.file !== recordFile && f.mtimeMs >= cutoff)) continue;
    const bytes = files.reduce((n, f) => n + f.size, 0);
    // Checked again right before deleting: the loop awaits, and a room can be
    // opened (or a write queued) in the meantime.
    if (inUse(code) || roomWrites.has(code)) continue;
    if (!dryRun) {
      await fs.rm(folder, { recursive: true, force: true });
      const line = JSON.stringify({ at: new Date().toISOString(), code, bytes, created: record?.createdAt ?? null,
        tournament: record?.tournamentCode ?? null }) + '\n';
      await fs.appendFile(path.join(DATA_DIR, 'purged-rooms.log'), line).catch(() => {});
    }
    result.removed.push(code);
    result.bytes += bytes;
  }
  return result;
}

async function filesUnder(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await filesUnder(p));
    else {
      const st = await fs.stat(p).catch(() => null);
      if (st) out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

async function migrateRoomsJson() {
  const legacy = path.join(DATA_DIR, 'rooms.json');
  // Half-written temp copies a killed process left behind.
  try {
    for (const f of await fs.readdir(DATA_DIR)) {
      if (f.startsWith('rooms.json.tmp-')) await fs.rm(path.join(DATA_DIR, f), { force: true });
    }
  } catch { /* no data dir yet */ }
  const done = `${legacy}.migrated`;
  if (await readTextOrNull(done) != null) return;
  const text = await readTextOrNull(legacy);
  if (text == null) return;
  let records = [];
  try { const a = JSON.parse(text); if (Array.isArray(a)) records = a; } catch { /* corrupt: set aside below */ }
  let moved = 0;
  const valid = records.filter((r) => r?.code && CODE_RE.test(r.code));
  // A few at a time: this runs before the server listens, and one at a time
  // a few hundred rooms is long enough to fail a deploy's health check.
  for (let i = 0; i < valid.length; i += 16) {
    await Promise.all(valid.slice(i, i + 16).map(async (r) => {
      // A per-room file already there is newer than anything in rooms.json.
      if (fsSync.existsSync(roomRecordFile(r.code))) return;
      await writeAtomic(roomRecordFile(r.code), JSON.stringify(r));
      moved++;
    }));
  }
  await writeAtomic(done, JSON.stringify({ at: new Date().toISOString(), rooms: records.length, moved }));
  console.log(`rooms.json: moved ${moved} of ${records.length} room(s) to r/CODE/room.json`);
}

// --- reader memberships (account approval per tournament) ------------------
// When a tournament requires reader accounts, readers request access and the
// director approves. Stored per-tournament so it lives with that tournament.

export async function getMembers(bucket) {
  const text = await readTextOrNull(path.join(bucketDir(bucket), 'members.json'));
  if (!text) return [];
  try { const a = JSON.parse(text); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function saveMembers(bucket, members) {
  await writeAtomic(path.join(bucketDir(bucket), 'members.json'), JSON.stringify(members, null, 2));
}

// Idempotent: a reader requesting access that already exists keeps their status.
// `scope: 'assigned'` (the bye-reader invite) starts them with no rounds at
// all, so approving them gives them nothing until the director assigns some.
export async function requestMembership(bucket, accountId, username, { scope } = {}) {
  const members = await getMembers(bucket);
  let m = members.find((x) => x.accountId === accountId);
  if (!m) {
    m = { accountId, username: String(username || ''), status: 'pending', requestedAt: Date.now(), approvedAt: null };
    if (scope === 'assigned') { m.scope = 'assigned'; m.assignments = []; }
    members.push(m);
    await saveMembers(bucket, members);
  }
  return m;
}

export async function setMemberStatus(bucket, accountId, status) {
  const allowed = new Set(['pending', 'approved', 'denied']);
  const s = allowed.has(status) ? status : 'pending';
  const members = await getMembers(bucket);
  const m = members.find((x) => x.accountId === accountId);
  if (!m) return null;
  m.status = s;
  m.approvedAt = s === 'approved' ? Date.now() : null;
  await saveMembers(bucket, members);
  return m;
}

// The director's own account, flagged so they hear about access requests.
export async function markDirector(bucket, accountId) {
  const members = await getMembers(bucket);
  const m = members.find((x) => x.accountId === accountId);
  if (!m || m.director) return;
  m.director = true;
  await saveMembers(bucket, members);
}

export async function memberStatus(bucket, accountId) {
  const members = await getMembers(bucket);
  return members.find((x) => x.accountId === accountId)?.status || null;
}

export async function getMember(bucket, accountId) {
  const members = await getMembers(bucket);
  return members.find((x) => x.accountId === accountId) || null;
}

/**
 * What an approved moderator may read. scope 'all' (the default, and what
 * every member had before this existed): any room, any round. scope
 * 'assigned': only the { round, room } pairs listed — someone who plays and
 * reads on their byes, who must never open a packet their team still plays.
 */
export async function setMemberAccess(bucket, accountId, { scope, assignments } = {}) {
  const members = await getMembers(bucket);
  const m = members.find((x) => x.accountId === accountId);
  if (!m) return null;
  m.scope = scope === 'assigned' ? 'assigned' : 'all';
  const seen = new Set();
  m.assignments = (Array.isArray(assignments) ? assignments : [])
    .map((a) => ({ round: String(a?.round ?? '').trim().slice(0, 80), room: String(a?.room ?? '').trim().toUpperCase().slice(0, 12) }))
    .filter((a) => a.round && a.room && !seen.has(`${a.room}|${a.round}`) && seen.add(`${a.room}|${a.round}`))
    .slice(0, 300);
  await saveMembers(bucket, members);
  return m;
}

/** A room's stored game for one round (the stats file), or null. */
export async function getRoomRoundExport(bucket, room, round) {
  const file = path.join(bucketDir(bucket), 'exports', `${safeName(room, 'room')}-${safeName(round, 'r')}.qbj`);
  const text = await readTextOrNull(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export const _internal = { bucketDir, safeName };

// --- the game archive ----------------------------------------------------------
// Every MODAQ game anyone scores, kept apart from its room so it outlives it:
// a room ages out after 30 days (and its code can be dealt again), a game's
// results shouldn't. Two files per game — a small meta for listing and the
// body (the match QBJ and MODAQ's own serialized game) — so a listing never
// reads the packets the bodies carry.
//
// Who may have one back is recorded on the meta as `owners`: hashes of the
// room's staff tokens (a browser that created or co-read the room still holds
// one) and the ids of accounts that scored in it. Admins see everything.
const ARCHIVE_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const archiveDir = () => path.join(DATA_DIR, 'games');

export async function saveArchivedGame(meta, body) {
  if (!ARCHIVE_ID_RE.test(meta?.id || '')) throw new Error('bad_game_id');
  // The body first: a meta that lists a game must always have one to hand out.
  await writeAtomic(path.join(archiveDir(), `${meta.id}.json`), JSON.stringify(body));
  const text = JSON.stringify(meta);
  await writeAtomic(path.join(archiveDir(), `${meta.id}.meta.json`), text);
  metaWritten(text);
}

// The meta alone: requests and grants change it without touching the body.
export async function saveArchivedMeta(meta) {
  if (!ARCHIVE_ID_RE.test(meta?.id || '')) throw new Error('bad_game_id');
  const text = JSON.stringify(meta);
  await writeAtomic(path.join(archiveDir(), `${meta.id}.meta.json`), text);
  metaWritten(text);
}

// Every meta, held in memory: the listing used to read one file per game on
// every call (the /games page, a director's correction, the boot sweeps),
// which at a few games per room is tens of thousands of reads once there are
// thousands of rooms. Read from disk once, then kept current by the two
// writers above (nothing deletes a meta). Entries are shared and frozen, like
// the parsed-games cache: a caller that wants to change one reads its own copy
// with getArchivedMeta, changes that and saves it.
let metaIndex = null;            // id -> frozen meta, once loaded
let metaIndexLoading = null;     // the first load, while it runs
const metasDuringLoad = new Map(); // written while the first load ran: these win
let metaSorted = null;           // newest first, every meta; rebuilt after a write

function metaWritten(text) {
  const meta = deepFreeze(JSON.parse(text));
  if (metaIndex) metaIndex.set(meta.id, meta);
  else if (metaIndexLoading) metasDuringLoad.set(meta.id, meta);
  metaSorted = null;
}

async function loadMetaIndex() {
  if (metaIndex) return metaIndex;
  if (!metaIndexLoading) {
    metaIndexLoading = (async () => {
      const index = new Map();
      let files = [];
      try { files = (await fs.readdir(archiveDir())).filter((f) => f.endsWith('.meta.json')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const one = async (f) => {
        const text = await readTextOrNull(path.join(archiveDir(), f));
        if (text == null) return;
        try { const m = JSON.parse(text); if (m?.id) index.set(m.id, deepFreeze(m)); } catch { /* skip a bad file */ }
      };
      for (let i = 0; i < files.length; i += 32) await Promise.all(files.slice(i, i + 32).map(one));
      for (const [id, m] of metasDuringLoad) index.set(id, m);
      metasDuringLoad.clear();
      metaIndex = index;
      metaSorted = null;
      return index;
    })().finally(() => { metaIndexLoading = null; });
  }
  return metaIndexLoading;
}

// For tests: forget the index so the next listing reads the disk again.
export function _resetMetaIndex() { metaIndex = null; metaSorted = null; metasDuringLoad.clear(); }

export async function getArchivedMeta(id) {
  if (!ARCHIVE_ID_RE.test(String(id || ''))) return null;
  const text = await readTextOrNull(path.join(archiveDir(), `${id}.meta.json`));
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function getArchivedBody(id) {
  if (!ARCHIVE_ID_RE.test(String(id || ''))) return null;
  const text = await readTextOrNull(path.join(archiveDir(), `${id}.json`));
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Every meta, newest first.
// Hidden games (see findArchiveDuplicates) are left out of listings unless
// asked for; they still open by id, so no link to one breaks.
// The metas are shared and frozen (see metaIndex); the array is the caller's.
export async function listArchivedGames({ includeHidden = false } = {}) {
  const index = await loadMetaIndex();
  if (!metaSorted) {
    // When the game was played, not when it was last touched: reopening an old
    // game to fix a score mustn't move it to the top.
    metaSorted = [...index.values()]
      .sort((a, b) => (b.startedAt || b.updatedAt || 0) - (a.startedAt || a.updatedAt || 0));
  }
  return includeHidden ? metaSorted.slice() : metaSorted.filter((m) => !m.hidden);
}

// Games from before the archive existed: each room's filed "previous games"
// and its last shared game, still on the volume under r/CODE but reachable
// only through a room that may be long gone. Copied in once (an id that's
// already archived is skipped), owned by the room's tokens when the room is
// still on record.
//
// Only games from BEFORE the archive: every game since was archived live (see
// trackArchive in index.js), so importing its r/CODE copy again made a second
// entry. Until 2026-11-14 this ran on every boot with no such limit and added
// one duplicate per game played since the last boot (103 at the restart that
// day). Done once, then a marker file stops it reading the volume again.
const LEGACY_IMPORT_DONE = () => path.join(archiveDir(), '_legacy-import-done.json');
const DUPLICATES_HIDDEN = () => path.join(archiveDir(), '_duplicates-hidden.json');
export const duplicatesHiddenDone = () => fsSync.existsSync(DUPLICATES_HIDDEN());
export const markDuplicatesHidden = (info) => writeAtomic(DUPLICATES_HIDDEN(), JSON.stringify(info));

// The copies that import made: a "legacy" entry from after the archive began
// whose game the archive already has — same room, same teams, same score,
// same question reached, within three days. Only exact copies: where the two
// disagree, the legacy one can be the more complete (the real entry stopped
// early), so it stays. Returns [{ id, of }].
export function findArchiveDuplicates(metas) {
  const real = metas.filter((m) => !m.legacy);
  const live = real.map((m) => m.startedAt || m.updatedAt || Infinity);
  const began = live.length ? Math.min(...live) : Infinity;
  const teams = (m) => [...(m.teams || [])].sort().join('|');
  const score = (m) => JSON.stringify(m.scores || []);
  const byRoom = new Map();
  for (const m of real) {
    if (!byRoom.has(m.room)) byRoom.set(m.room, []);
    byRoom.get(m.room).push(m);
  }
  const out = [];
  for (const m of metas) {
    if (!m.legacy || m.hidden || !(m.startedAt >= began) || !m.teams?.length) continue;
    const twin = (byRoom.get(m.room) || []).find((r) => teams(r) === teams(m) && score(r) === score(m) &&
      (r.current || 0) === (m.current || 0) && Math.abs((r.startedAt || 0) - m.startedAt) < 3 * 864e5);
    if (twin) out.push({ id: m.id, of: twin.id });
  }
  return out;
}

export async function importLegacyGames(tokenHashesFor) {
  if (fsSync.existsSync(LEGACY_IMPORT_DONE())) return 0;
  const rDir = path.join(DATA_DIR, 'r');
  let codes;
  try { codes = await fs.readdir(rDir); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let imported = 0;
  const archived = await listArchivedGames({ includeHidden: true });
  const have = new Set(archived.map((m) => m.id));
  // When the archive began: the first game it filed itself. Nothing archived
  // live yet means everything on the volume is from before.
  const live = archived.filter((m) => !m.legacy).map((m) => m.startedAt || m.updatedAt || Infinity);
  const archiveBegan = live.length ? Math.min(...live) : Infinity;
  for (const code of codes) {
    if (!CODE_RE.test(code)) continue;
    const candidates = [];
    for (const g of await listGames(code).catch(() => [])) {
      if ((g.at || 0) >= archiveBegan) continue;
      candidates.push({ id: `r-${code}-${safeName(g.id, 'game')}`, load: () => getGame(code, g.id) });
    }
    candidates.push({ id: `r-${code}-shared`, load: () => getModaqState(code) });
    for (const c of candidates) {
      if (have.has(c.id) || !ARCHIVE_ID_RE.test(c.id)) continue;
      const rec = await c.load().catch(() => null);
      if (!rec?.json) continue;
      // No date: can't tell it's from before, and since the archive began
      // everything is in it already.
      if (!rec.at || rec.at >= archiveBegan) continue;
      const at = rec.at;
      // The room holding this code now owns the game only if it was already
      // there when the game was saved: codes get dealt again.
      const owners = { tokens: tokenHashesFor(code, at), accounts: [] };
      await saveArchivedGame({
        id: c.id,
        room: code,
        roomName: null,
        tournament: null,
        round: rec.round ?? '',
        teams: Array.isArray(rec.teams) ? rec.teams : [],
        scores: Array.isArray(rec.scores) ? rec.scores : [],
        current: rec.current || 0,
        total: rec.total || 0,
        startedAt: at,
        updatedAt: at,
        legacy: true,
        hasQbj: false,
        owners
      }, { json: rec.json, qbj: null });
      imported++;
    }
  }
  await writeAtomic(LEGACY_IMPORT_DONE(), JSON.stringify({ at: new Date().toISOString(), imported, archiveBegan }));
  return imported;
}
