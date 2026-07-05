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
import path from 'node:path';
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
async function writeAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
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
    uploadedAt: Date.now(),
  };
  await setPacketMeta(bucket, meta);
  return { round: name, visible: meta[name].visible, tiebreaker: meta[name].tiebreaker };
}

// Returns [{ round, visible, tiebreaker }] for every stored round.
export async function listPackets(bucket) {
  const dir = path.join(bucketDir(bucket), 'packets');
  try {
    const files = await fs.readdir(dir);
    const meta = await getPacketMeta(bucket);
    return files
      .filter((f) => f.endsWith('.json') && f !== '_meta.json')
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
      .map((round) => ({ round, visible: !!meta[round]?.visible, tiebreaker: !!meta[round]?.tiebreaker }));
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

// --- exported match QBJ ----------------------------------------------------
// On export, MODAQ hands us the match QBJ; we archive it under the tournament
// so the TD and other moderators can retrieve it. Timestamp is supplied by the
// caller (server clock) to keep this module free of ambient Date usage in the
// name only — here we just use it as given.

// The filename is STABLE per (room, round) — a re-export (including the live
// per-change sync) overwrites the same file, so the tournament ends up with one
// current QBJ per match instead of hundreds of timestamped duplicates. The file
// mtime records when it was last synced.
export async function saveExport(bucket, { room, round, qbj, inProgress = false }) {
  const roomPart = safeName(room, 'room');
  const roundPart = safeName(round, 'r');
  const filename = `${roomPart}-${roundPart}.qbj`;
  // Stamp the round/room onto the match so the stats engine can group by round
  // regardless of the filename (round labels may contain characters we sanitize).
  let obj = typeof qbj === 'string' ? parseJsonOrThrow(qbj) : qbj;
  const file = path.join(bucketDir(bucket), 'exports', filename);
  if (obj && typeof obj === 'object') {
    obj = { ...obj, _round: String(round ?? ''), _room: String(room ?? '') };
    // A live sync marks the match in progress so stats don't count a half-played
    // game as a W/L yet. Final is sticky per matchup: once this room+round has
    // been saved as final for the same teams, post-game review edits (which sync
    // from an earlier question index) must not flip it back to "live".
    if (inProgress && !(await wasFinalizedForSameTeams(file, obj))) {
      obj._inProgress = true;
    }
  }
  const text = JSON.stringify(obj, null, 2);
  await writeAtomic(file, text);
  return { filename };
}

const matchTeamNames = (m) =>
  (Array.isArray(m?.match_teams) ? m.match_teams : []).map((mt) => mt?.team?.name || '?').sort().join(' ');

async function wasFinalizedForSameTeams(file, incoming) {
  const text = await readTextOrNull(file);
  if (text == null) return false;
  try {
    const prev = JSON.parse(text);
    // Different teams = a new game reusing the slot; its status starts fresh.
    return prev._inProgress !== true && matchTeamNames(prev) === matchTeamNames(incoming);
  } catch { return false; }
}

// Read and parse every exported match in a bucket — used to hand the TD all the
// stats in one download.
export async function readAllExports(bucket) {
  const dir = path.join(bucketDir(bucket), 'exports');
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files.sort()) {
      if (!f.endsWith('.qbj')) continue;
      const text = await readTextOrNull(path.join(dir, f));
      if (text == null) continue;
      let qbj;
      try { qbj = JSON.parse(text); } catch { continue; }
      const stat = await fs.stat(path.join(dir, f));
      out.push({ filename: f, savedAt: stat.mtimeMs, qbj });
    }
    return out;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function listExports(bucket) {
  const dir = path.join(bucketDir(bucket), 'exports');
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.qbj')) continue;
      const stat = await fs.stat(path.join(dir, f));
      out.push({ filename: f, size: stat.size, savedAt: stat.mtimeMs });
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
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
export async function requestMembership(bucket, accountId, username) {
  const members = await getMembers(bucket);
  let m = members.find((x) => x.accountId === accountId);
  if (!m) {
    m = { accountId, username: String(username || ''), status: 'pending', requestedAt: Date.now(), approvedAt: null };
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

export async function memberStatus(bucket, accountId) {
  const members = await getMembers(bucket);
  return members.find((x) => x.accountId === accountId)?.status || null;
}

export const _internal = { bucketDir, safeName };
