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

const MAX_CHAT = 120;              // messages kept per room
const MAX_CHAT_TEXT = 400;
const CHAT_COOLDOWN_MS = 700;      // per player, so one person can't flood it

const clean = (v, cap) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

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
  room.shootout = { banked: {}, since: Date.now() };
  return room.shootout;
}

/**
 * The leaderboard: what is banked from finished packets, plus the game in
 * progress, highest first. `current` comes from the live scoresheet, so it
 * moves as the game does.
 */
export function board(room, current = {}) {
  const s = state(room);
  const names = new Set([...Object.keys(s.banked), ...Object.keys(current)]);
  const rows = [...names].map((name) => ({
    name,
    banked: s.banked[name] || 0,
    current: Number(current[name]) || 0,
    total: (s.banked[name] || 0) + (Number(current[name]) || 0)
  }));
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { rows, since: s.since, packets: s.packets || 0 };
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

/**
 * Somebody says something. Deliberately separate from everything else in the
 * room: it is never an answer, never a protest, and is not gated on any of the
 * game's state. In a room where everyone is on their own it is why people came.
 */
export function say(room, actor, text) {
  if (!room.chat) room.chat = [];
  const body = clean(text, MAX_CHAT_TEXT);
  if (!body) return { error: 'empty' };

  const now = Date.now();
  if (!room.chatCooldown) room.chatCooldown = new Map();
  if (now - (room.chatCooldown.get(actor.id) || 0) < CHAT_COOLDOWN_MS) return { error: 'too_fast' };
  room.chatCooldown.set(actor.id, now);

  const message = { id: `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    playerId: actor.id, name: actor.name, staff: actor.staff === true, text: body, at: now };
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
  return { ok: true, message };
}

export const messages = (room) => (room.chat || []).map((m) => ({ ...m }));
