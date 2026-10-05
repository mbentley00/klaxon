// ---------------------------------------------------------------------------
// Discord shootout: everyone plays for themselves.
//
// A shootout is not a team game with one player a side. The difference that
// matters is who the room is FOR: people drop in and out mid-session, the
// scoreboard is a leaderboard rather than a match score, and it runs over
// several packets in one sitting. Three things follow from that, and they are
// what this file is:
//
//   * The roster is the room. Nobody types a team name; whoever is connected IS
//     a competitor, named by the name they joined under, and someone arriving
//     at question 9 joins the game rather than waiting for the next one.
//
//   * The score is cumulative across packets. Finishing a packet and loading
//     another is the normal case, not the end of the session, so each game's
//     final score is banked and the leaderboard is banked + whatever the
//     current game has so far.
//
//   * There is a chat, and it has nothing to do with answering. In a room where
//     everyone is on their own, the talking is the reason people are there;
//     without somewhere to put it, it ends up in the answer box.
// ---------------------------------------------------------------------------

// What a room KEEPS, and what it SENDS, are different numbers. Every state
// broadcast used to carry the whole log, so the log had to stay small — which
// also meant an evening's conversation was gone by the end of it. The room now
// keeps the evening and sends the tail of it; the rest is for the export.
const MAX_CHAT = 4000;             // messages kept per room
const CHAT_IN_STATE = 120;         // how many of them ride in a state broadcast
const MAX_CHAT_TEXT = 400;
const CHAT_COOLDOWN_MS = 350;      // per player, so one person can't flood it
// 350ms stops a script without getting in the way of a person: two short
// lines in quick succession is ordinary conversation, and a chat that
// refuses them is worse than one that occasionally carries a duplicate.

const clean = (v, cap) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

// A first and a last name, two letters or more each — what a new player must
// join a shootout with (see index.js). Letters in any script count; "O'Brien"
// and "Smith-Jones" are fine; an initial ("A.") is not a last name.
const LETTER = /\p{L}/gu;
export function fullName(name) {
  const parts = clean(name, 40).split(' ');
  if (parts.length < 2) return false;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return (first.match(LETTER) || []).length >= 2 && (last.match(LETTER) || []).length >= 2;
}

/**
 * The competitors, from whoever is in the room: one one-player team each,
 * named for the player. Rebuilt on every join and departure, so a late arrival
 * is simply in the next game the moderator starts.
 *
 * Disconnected players are kept. Someone whose laptop slept mid-round is still
 * a competitor with a score, and dropping them would take their score out of
 * the game MODAQ is scoring.
 */
export function roster(members, displayName) {
  const seen = new Set();
  const teams = [];
  for (const m of members) {
    if (m.role !== 'player') continue;
    const name = clean(displayName(m), 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    teams.push({ name, players: [name] });
  }
  return teams.length ? { name: 'Shootout', teams } : null;
}

// --- cumulative scoring ------------------------------------------------------
// `banked` is every finished packet; the leaderboard adds whatever the game in
// progress has so far. Kept by NAME rather than by player id: a shootout runs
// over an evening and people reconnect, and the name is what they and everyone
// else recognise on the board.

export function state(room) {
  if (!room.shootout) room.shootout = { banked: {}, since: Date.now() };
  return room.shootout;
}

/**
 * Bank the game that just finished. Called when the room moves to a new game
 * (see store.setScoresheet), which is exactly when a packet is done and the
 * next one is going in.
 *
 * Adding rather than replacing is the point: the leaderboard is the evening,
 * not the packet.
 */
export function bank(room, scores) {
  const s = state(room);
  for (const [name, points] of Object.entries(scores || {})) {
    const key = clean(name, 40);
    if (!key) continue;
    s.banked[key] = (s.banked[key] || 0) + (Number(points) || 0);
  }
  s.bankedAt = Date.now();
  return s.banked;
}

export function reset(room) {
  room.shootout = { banked: {}, byPacket: {}, since: Date.now() };
  return room.shootout;
}

/**
 * What a packet finished with, kept under that packet's own id.
 *
 * Filed per packet rather than added to a running total because the reader can
 * go back: reopening packet 2 to fix a score has to REPLACE what packet 2
 * contributed, and a flat total can't be taken apart again.
 */
export function bankPacket(room, packetId, scores) {
  const s = state(room);
  if (!s.byPacket) s.byPacket = {};
  const kept = {};
  for (const [name, points] of Object.entries(scores || {})) {
    const key = clean(name, 40);
    if (key) kept[key] = Number(points) || 0;
  }
  s.byPacket[packetId] = kept;
  s.bankedAt = Date.now();
  return s.byPacket;
}

/**
 * The leaderboard: every packet that has been read, plus the game in progress,
 * highest first. `current` comes from the live scoresheet, so it moves as the
 * game does; `currentPacket` is the packet that game is, and is left out of the
 * banked half so it isn't counted twice.
 */
/**
 * `people` is everyone in the room: a competitor is on the board from the
 * moment they join, on nothing, rather than when the reader's MODAQ next
 * pushes a game that happens to know about them. That push is debounced and
 * only fires when the game changes, so a player who arrived between questions
 * could sit unlisted for a whole tossup — on a board whose entire job is to
 * say who is playing.
 */
export function board(room, current = {}, currentPacket = null, people = []) {
  const s = state(room);
  const past = {};
  let packets = 0;
  for (const [id, scores] of Object.entries(s.byPacket || {})) {
    if (id === currentPacket) continue;
    packets++;
    for (const [name, points] of Object.entries(scores)) {
      past[name] = (past[name] || 0) + (Number(points) || 0);
    }
  }
  // A room that was reading before the score was kept per packet keeps its
  // running total (and its count) as it was.
  for (const [name, points] of Object.entries(s.banked || {})) {
    past[name] = (past[name] || 0) + (Number(points) || 0);
  }
  packets += s.packets || 0;
  const names = new Set([...Object.keys(past), ...Object.keys(current)]);
  for (const name of people) {
    const clean_ = clean(name, 40);
    if (clean_) names.add(clean_);
  }
  const rows = [...names].map((name) => ({
    name,
    banked: past[name] || 0,
    current: Number(current[name]) || 0,
    total: (past[name] || 0) + (Number(current[name]) || 0)
  }));
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { rows, since: s.since, packets };
}

// Per-competitor scores of one MODAQ game, read off the player scoresheet the
// server already built. A shootout's teams are one player each, so a team's
// score IS that person's score.
export function currentScores(scoresheet) {
  const out = {};
  const teams = scoresheet?.teams || [];
  teams.forEach((team, i) => {
    const name = clean(team?.name, 40);
    if (name) out[name] = Number(scoresheet?.scores?.[i]) || 0;
  });
  return out;
}

// --- chat --------------------------------------------------------------------

const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who a message is addressed to. Resolved HERE, against the people actually in
 * the room, rather than taken from the client: a mention is a claim that
 * someone was addressed, and a page that made them up could ping anybody.
 *
 * Longest name first, so "@ann" doesn't swallow the mention of "@annabel".
 * The name may contain spaces (a display name often does), so the boundary is
 * "not more name" rather than a word boundary.
 */
export function mentionsIn(text, people) {
  const body = String(text ?? '');
  const found = [];
  const seen = new Set();
  const byLength = [...people].sort((a, b) => String(b.name).length - String(a.name).length);
  for (const person of byLength) {
    const name = String(person.name ?? '').trim();
    if (!name || seen.has(person.id)) continue;
    const re = new RegExp('@' + escapeRe(name) + '(?![\\w-])', 'i');
    if (re.test(body)) {
      seen.add(person.id);
      found.push({ id: person.id, name });
    }
  }
  return found;
}


/**
 * Somebody says something. Deliberately separate from everything else in the
 * room: it is never an answer, never a protest, and is not gated on any of the
 * game's state. In a room where everyone is on their own it is why people came.
 */
// A chat line keeps the line breaks someone typed (shift-Enter in the box) —
// runs of spaces still collapse, and a wall of blank lines is capped at one, so
// nobody can push the log off the screen with the return key.
const cleanLines = (v, cap) => String(v ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[^\S\n]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .split('\n')
  .map((line) => line.trim())
  .join('\n')
  .trim()
  .slice(0, cap);

export function say(room, actor, text, people = []) {
  if (!room.chat) room.chat = [];
  const body = cleanLines(text, MAX_CHAT_TEXT);
  if (!body) return { error: 'empty' };

  const now = Date.now();
  if (!room.chatCooldown) room.chatCooldown = new Map();
  if (now - (room.chatCooldown.get(actor.id) || 0) < CHAT_COOLDOWN_MS) return { error: 'too_fast' };
  room.chatCooldown.set(actor.id, now);

  const message = { id: `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    playerId: actor.id, name: actor.name, staff: actor.staff === true, text: body, at: now,
    // Who was addressed, worked out from who is in the room (see mentionsIn).
    mentions: mentionsIn(body, people) };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  return { ok: true, message };
}

/**
 * Something the ROOM did, written into the chat: an answer that was given.
 *
 * The answer panel only ever showed these to the players queued behind the
 * buzzer, so anyone who hadn't buzzed — most of the room, most of the time —
 * never learned what was actually said. The chat is where the room is already
 * looking, it is already in front of everyone, and it already keeps a history
 * for whoever joins late.
 *
 * Not a player's message: no cooldown (the room is not typing it), no
 * mentions, and marked so the page can draw it as an event rather than as
 * somebody talking.
 */
export function announce(room, kind, { name, text }) {
  if (!room.chat) room.chat = [];
  const body = clean(text, MAX_CHAT_TEXT);
  if (!body) return { error: 'empty' };
  const now = Date.now();
  const message = {
    id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    playerId: null,
    name: clean(name, 40),
    system: String(kind || 'event').slice(0, 20),
    text: body,
    at: now,
    mentions: []
  };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  return { ok: true, message };
}

// The tail, for the room's own screens. `all` is for the moderator's export,
// which is the only place the whole evening is wanted.
export const messages = (room, limit = CHAT_IN_STATE) => {
  const log = room.chat || [];
  const from = limit > 0 ? Math.max(0, log.length - limit) : 0;
  return log.slice(from).map((m) => ({ ...m }));
};

export const allMessages = (room) => (room.chat || []).map((m) => ({ ...m }));

/**
 * The chat as something to read afterwards: one line per message, the room's
 * own events among them, in the order they happened. Plain text because that is
 * what a moderator wants of a conversation — to read it, paste it, or send it
 * to somebody.
 */
export function transcript(room, { name, code } = {}) {
  const when = (at) => new Date(at).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const log = room.chat || [];
  const head = [
    `${name || room.name || 'Klaxon room'} — chat`,
    `Room ${code || room.code}`,
    log.length ? `${log.length} line${log.length === 1 ? '' : 's'}, ${when(log[0].at)} to ${when(log[log.length - 1].at)}` : 'Nothing was said.',
    ''
  ];
  const body = log.map((m) => {
    const stamp = new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (m.system === 'cycle') return `\n--- ${m.text} ---`;
    if (m.system === 'answer') return `[${stamp}] ** ANSWER — ${m.name}: ${m.text}`;
    // A line someone typed may have line breaks in it; keep them, indented so
    // the log still reads as one line per person.
    const text = String(m.text).split('\n').join('\n' + ' '.repeat(stamp.length + 3));
    return `[${stamp}] ${m.name}${m.staff ? ' (moderator)' : ''}: ${text}`;
  });
  return head.concat(body).join('\n') + '\n';
}

// --- the session -------------------------------------------------------------
// What the host set up before anyone joined: what's being played, notes for the
// players (what kind of questions, what's being playtested), how a withdrawn
// buzz is handled, and the packets, in the order they'll be read. The packets
// themselves are stored like any room's packets (staff-only, see
// /api/rooms/:code/packets); the session only names them.
//
// Kept apart from the leaderboard (room.shootout) on purpose: "reset the
// leaderboard" starts the scoring over, not the evening's plan.

// 'rationed' is 'free', with a wait: taking a buzz back costs nothing, but not
// twice in a row. After a free withdrawal you are on your own for the next few
// questions — buzz in and you answer, or it costs you.
export const WITHDRAW_MODES = ['free', 'none', 'typed', 'rationed'];
export const DEFAULT_WITHDRAW_COOLDOWN = 5;
const MAX_WITHDRAW_COOLDOWN = 40;
export const SCHEMES = ['15/10/-5', '20/15/10/-5', '20/10/0'];
const MAX_PACKETS = 40;
const MAX_NOTES = 2000;
const PACKET_ID = /^p[0-9a-z]{1,16}$/;

const count = (v) => Math.max(0, Math.min(1000, Math.floor(Number(v) || 0)));

/**
 * A session as the host sent it, cleaned. `prev` is the session being
 * replaced: which packet is being read survives an edit (by id, so reordering
 * the rest doesn't move the room to a different packet).
 */
export function normalizeSession(input, prev = null) {
  const seen = new Set();
  const packets = [];
  for (const p of Array.isArray(input?.packets) ? input.packets : []) {
    const id = String(p?.id ?? '');
    if (!PACKET_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    packets.push({ id, name: clean(p?.name, 80) || `Packet ${packets.length + 1}`, tossups: count(p?.tossups), bonuses: count(p?.bonuses) });
    if (packets.length >= MAX_PACKETS) break;
  }
  const current = typeof input?.current === 'string' ? input.current : prev?.current ?? null;
  return {
    name: clean(input?.name, 80) || 'Shootout',
    // Line breaks are the host's formatting; only trailing space and length are policed.
    notes: String(input?.notes ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().slice(0, MAX_NOTES),
    withdraw: WITHDRAW_MODES.includes(input?.withdraw) ? input.withdraw : 'free',
    // How many questions a free withdrawal costs you, in 'rationed'.
    withdrawCooldown: Math.max(1, Math.min(MAX_WITHDRAW_COOLDOWN,
      Math.floor(Number(input?.withdrawCooldown)) || DEFAULT_WITHDRAW_COOLDOWN)),
    scoring: {
      scheme: SCHEMES.includes(input?.scoring?.scheme) ? input.scoring.scheme : '15/10/-5',
      bonuses: input?.scoring?.bonuses === true
    },
    packets,
    current: packets.some((p) => p.id === current) ? current : null,
    createdAt: prev?.createdAt || Date.now()
  };
}

// The room settings each way of handling a withdrawn buzz comes down to (see
// answers.js for what the typed-answer window does).
export function withdrawSettings(mode, cooldown = 0) {
  if (mode === 'none') return { allowWithdraw: false, lockedAnswers: false, withdrawCooldown: 0 };
  if (mode === 'typed') return { allowWithdraw: true, lockedAnswers: true, withdrawCooldown: 0 };
  if (mode === 'rationed') {
    return {
      allowWithdraw: true,
      lockedAnswers: false,
      withdrawCooldown: Math.max(1, Math.min(MAX_WITHDRAW_COOLDOWN,
        Math.floor(Number(cooldown)) || DEFAULT_WITHDRAW_COOLDOWN))
    };
  }
  return { allowWithdraw: true, lockedAnswers: false, withdrawCooldown: 0 };
}

/**
 * The session as the room sees it — players and moderators alike: nothing in
 * it is secret. It names the packets but never carries one; their contents
 * stay behind the staff token.
 */
export function publicSession(session) {
  if (!session) return null;
  return {
    name: session.name,
    notes: session.notes,
    withdraw: session.withdraw,
    withdrawCooldown: session.withdrawCooldown,
    scoring: { ...session.scoring },
    packets: session.packets.map((p) => ({ ...p })),
    current: session.current,
    // Which of them is being read, for "Packet 2 of 4" (-1 before the first).
    currentIndex: session.packets.findIndex((p) => p.id === session.current)
  };
}

// --- export for buzzpoints ---------------------------------------------------
// One download at the end of the evening, laid out the way JemCasey's
// quizbowlbuzzpoints.com takes the packets that were read and the games played
// on them: a packet JSON and a QBJ per round, side by side in one flat folder.
//
// A game is tied to its packet by NAME — the QBJ's `packets` field equals the
// packet file's name — and to its round by the number after `Round_` in the
// game's file name. Both are set here rather than trusted from what the
// reader's screen sent, so a packet renamed mid-evening still lines up.

// Safe as a file name on every OS. (The importer cleans a packet's file name
// and a game's `packets` field the same way before comparing them, so nothing
// else needs changing for the two to match.)
function fileSafe(text) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
}

/**
 * The files of the export, as [{ name, data }] for zip.buildZip: for each
 * packet that was read, the packet itself (`Packet-01 - Name.json`) and the
 * game played on it with every buzz (`Round_1_Klaxon_CODE.qbj`). Nothing
 * else, and no folders. `games` is { packetId -> QBJ object }, `packets` is
 * { packetId -> packet object }. A packet nobody heard isn't part of the
 * evening, so it is left out.
 */
export function buzzpointsExport({ session, packets, games, code }) {
  const read = session.packets
    .map((p, i) => ({ ...p, round: i + 1, packet: packets[p.id], game: games[p.id] }))
    .filter((p) => p.packet && p.game);

  const files = [];
  const pad = read.length >= 100 ? 3 : 2;
  for (const p of read) {
    const packetName = `Packet-${String(p.round).padStart(pad, '0')} - ${fileSafe(p.name) || 'Packet'}`;
    files.push({ name: `${packetName}.json`, data: JSON.stringify(p.packet, null, 2) });

    const qbj = {};
    for (const [key, value] of Object.entries(p.game)) {
      if (!key.startsWith('_')) qbj[key] = value;   // Klaxon's own bookkeeping stays home
    }
    qbj.packets = packetName;
    files.push({ name: `Round_${p.round}_Klaxon_${code}.qbj`, data: JSON.stringify(qbj, null, 2) });
  }
  return { files, rounds: read.length };
}
