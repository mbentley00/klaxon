// ---------------------------------------------------------------------------
// Typed answers.
//
// Two related things live here, both off unless a room asks for them:
//
//   typedAnswers   the player who has the floor types their answer instead of
//                  saying it, and the moderator reads it off the screen.
//
//   lockedAnswers  everyone ELSE waiting in the buzz queue must commit an
//                  answer of their own, in secret, before the player with the
//                  floor gives theirs. This is the shootout mechanic: a
//                  reaction buzz costs you nothing, but a buzz you can't back
//                  up does.
//
// The whole thing turns on answers being committed BEFORE anyone learns
// anything. Two rules protect that:
//
//   * The window has a tail (`answerGraceSeconds`) in which an answer may still
//     GROW but never shrink. Without it, everyone would sit on a full answer
//     and delete it the instant they heard the player with the floor say the
//     same thing — the commitment would be worthless. Growing is allowed
//     because cutting someone off mid-word is a typing penalty, not a
//     knowledge one.
//
//   * A withdrawal is free while nothing has been said out loud, because a
//     reaction buzz — pressing because someone else did — deserves a way out.
//     Once an answer has been spoken it isn't free any more, EXCEPT when your
//     own committed answer is the one that was just said: you would only be
//     repeating it, and the rules should not punish someone for being second
//     to the same wrong idea.
// ---------------------------------------------------------------------------

import { DEFAULTS } from './config.js';

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Answers are compared the way a moderator would hear them, not byte for byte:
// case, punctuation, articles and surrounding noise don't make two answers
// different. Deliberately loose — this only ever decides whether a withdrawal
// is free, and being generous there errs toward not penalising someone.
export function sameAnswer(a, b) {
  const norm = (v) => String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|of|de|la|le)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const x = norm(a);
  const y = norm(b);
  return x !== '' && x === y;
}

const secs = (room, key, fallback) => clamp(room.settings?.[key], 1, 60, fallback) * 1000;

/**
 * Open the answer window for this cycle. Called once the buzz order is settled,
 * because until then nobody knows who has the floor and who is behind them.
 *
 * A cycle gets ONE window. Buzzing late doesn't restart it and doesn't extend
 * it: someone who joins the queue with two seconds left has two seconds to
 * commit an answer, which is the cost of buzzing late. Anything else would let
 * a player buy themselves more thinking time by waiting, and would reopen a
 * window that has already put the floor's answer on the record.
 *
 * Returns { window, started } — `started` false when a window was already
 * running, so the caller knows not to arm a second close timer.
 */
export function open(room, activePlayerId) {
  const live = state(room);
  if (live) {
    // Whoever got the floor keeps it; a late buzz only joins the queue behind.
    if (!live.activePlayerId && activePlayerId) live.activePlayerId = activePlayerId;
    return { window: live, started: false };
  }
  const now = Date.now();
  const window = secs(room, 'answerSeconds', DEFAULTS.answerSeconds);
  const grace = secs(room, 'answerGraceSeconds', DEFAULTS.answerGraceSeconds);
  room.answers = {
    cycleNo: room.cycleNo,
    activePlayerId: activePlayerId || null,
    openedAt: now,
    // Free typing until `deadline`; from there to `closesAt` an answer may only
    // grow. After that nothing changes.
    deadline: now + window,
    closesAt: now + window + grace,
    locked: new Map(),
    spoken: [],
    endedAt: null
  };
  return { window: room.answers, started: true };
}

export function state(room) {
  const a = room.answers;
  return a && a.cycleNo === room.cycleNo ? a : null;
}

/**
 * The window is over. The player with the floor now has their answer on the
 * record — which is the point of waiting: everyone else's was committed before
 * this became knowable, so from here a withdrawal is no longer free unless it
 * would only repeat what was just given (see `withdrawal`).
 *
 * Done on a timer rather than by the moderator so the rule doesn't depend on
 * how fast somebody clicks.
 */
export function close(room) {
  const a = state(room);
  if (!a || a.endedAt) return a;
  a.endedAt = Date.now();
  const active = a.activePlayerId && a.locked.get(a.activePlayerId);
  if (active?.text && !a.spoken.some((sp) => sp.playerId === a.activePlayerId)) {
    a.spoken.push({ playerId: a.activePlayerId, text: active.text, at: a.endedAt });
  }
  return a;
}

/**
 * A player types (or retypes) their answer.
 *
 * Past the deadline the new text must still START WITH the old one — the
 * append-only tail. That is checked here rather than in the browser because it
 * is the entire security of the mechanic: a page that lies about its own input
 * box must not be able to walk an answer back.
 */
export function type(room, playerId, textIn) {
  const a = state(room);
  if (!a) return { error: 'not_open' };
  const now = Date.now();
  if (now > a.closesAt) return { error: 'closed' };

  const text = String(textIn ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prev = a.locked.get(playerId);

  if (now > a.deadline) {
    const before = prev?.text ?? '';
    // Same text is fine (a keystroke that changed nothing); shorter or
    // divergent is the deletion this window exists to prevent.
    if (!text.startsWith(before)) return { error: 'no_deleting', text: before };
  }

  a.locked.set(playerId, { text, at: now });
  return { ok: true, text, appendOnly: now > a.deadline };
}

/**
 * An answer was given out loud (the player with the floor answered, or the
 * moderator recorded what they said). It goes on the record so the duplicate
 * rule below has something to consult.
 */
export function speak(room, playerId, textIn) {
  const a = state(room);
  if (!a) return { error: 'not_open' };
  const text = String(textIn ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text) return { error: 'empty' };
  a.spoken.push({ playerId: playerId || null, text, at: Date.now() });
  return { ok: true, spoken: a.spoken.length };
}

/**
 * Would withdrawing cost this player a penalty, and why?
 *
 * Free while nothing has been said out loud — that is the reaction-buzz
 * escape hatch. Free too when the player's own committed answer is one that
 * has already been given, because they would only be repeating it.
 *
 * Returns { free, reason }. The server does not itself apply a penalty: what
 * a neg is worth is MODAQ's business. This tells the moderator which kind of
 * withdrawal they just saw.
 */
export function withdrawal(room, playerId) {
  const a = state(room);
  if (!a) return { free: true, reason: 'no_window' };
  if (a.spoken.length === 0) return { free: true, reason: 'nothing_said' };
  const mine = a.locked.get(playerId)?.text;
  if (mine && a.spoken.some((s) => sameAnswer(s.text, mine))) {
    return { free: true, reason: 'duplicate' };
  }
  return { free: false, reason: mine ? 'committed' : 'no_answer' };
}

/**
 * The window as the ROOM may see it — the same for everybody, because none of
 * it is anyone's answer.
 *
 * What is deliberately absent is any committed answer but your own, and your
 * own does not need to come from here: your page typed it. A count of who has
 * committed is safe (a number is not an answer) and is what tells the room
 * whether it is still waiting on someone. What was said OUT LOUD is public —
 * the room heard it.
 */
export function publicWindow(room) {
  const a = state(room);
  if (!a) return null;
  const now = Date.now();
  return {
    open: now <= a.closesAt,
    deadline: a.deadline,
    closesAt: a.closesAt,
    // Past the deadline a box may only grow; the page greys out its own
    // deletion rather than silently having keystrokes rejected.
    appendOnly: now > a.deadline,
    committed: a.locked.size,
    activePlayerId: a.activePlayerId,
    spoken: a.spoken.map((s) => s.text)
  };
}

/**
 * The window as the MODERATOR sees it: everyone's committed answer, because
 * they are the one who has to judge them, plus who is still typing.
 */
export function forStaff(room, memberName) {
  const a = state(room);
  if (!a) return null;
  return {
    open: Date.now() <= a.closesAt,
    deadline: a.deadline,
    closesAt: a.closesAt,
    activePlayerId: a.activePlayerId,
    spoken: a.spoken.map((s) => ({ playerId: s.playerId, text: s.text })),
    answers: [...a.locked.entries()].map(([playerId, v]) => ({
      playerId,
      name: memberName ? memberName(playerId) : null,
      text: v.text,
      at: v.at
    }))
  };
}
