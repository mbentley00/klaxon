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
 * The GUARANTEED window is over.
 *
 * It is a promise to the players waiting behind the buzzer, not a shutter: for
 * as long as it runs, a withdrawal costs nothing, so anyone who buzzed on
 * reflex has a stated number of seconds to get an answer down or take the buzz
 * back. After it they may still type and still withdraw — the moderator often
 * gives the player with the floor longer — but the free pass has expired.
 *
 * Nothing is revealed here. The floor's answer goes on the record when THEY
 * send it (Enter) or when the moderator asks for it, never because a timer
 * went off: a player still typing when the clock runs out has not answered.
 *
 * On a timer rather than a click so the promise doesn't depend on how fast
 * somebody reacts.
 */
export function close(room) {
  const a = state(room);
  if (!a || a.endedAt) return a;
  a.endedAt = Date.now();
  return a;
}

/**
 * The floor's answer, put on the record by the moderator rather than by the
 * player — the force-show. The moderator can already read every committed
 * answer; this is how they make the room's one public.
 */
export function reveal(room, playerId) {
  const a = state(room);
  if (!a) return { error: 'not_open' };
  const who = playerId || a.activePlayerId;
  if (!who) return { error: 'no_player' };
  const committed = a.locked.get(who)?.text;
  if (!committed) return { error: 'nothing_typed' };
  if (a.spoken.some((sp) => sp.playerId === who && sameAnswer(sp.text, committed))) {
    return { ok: true, text: committed, already: true };
  }
  a.spoken.push({ playerId: who, text: committed, at: Date.now() });
  return { ok: true, text: committed };
}

/**
 * A player types (or retypes) their answer.
 *
 * Past the deadline the new text must still START WITH the old one — the
 * append-only tail. That is checked here rather than in the browser because it
 * is the entire security of the mechanic: a page that lies about its own input
 * box must not be able to walk an answer back.
 *
 * Two things the clock does NOT do. It doesn't shut the box: the moderator
 * routinely gives the player with the floor more time, and everyone else is
 * entitled to keep working on an answer for as long as that takes — they just
 * do it without the free withdrawal. And it doesn't bind the player with the
 * FLOOR at all: they are the one being asked the question, their answer is
 * theirs to revise until they send it, and there is nobody behind them for the
 * append-only rule to protect.
 */
export function type(room, playerId, textIn) {
  const a = state(room);
  if (!a) return { error: 'not_open' };
  const now = Date.now();

  const text = String(textIn ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prev = a.locked.get(playerId);
  const isFloor = a.activePlayerId != null && playerId === a.activePlayerId;

  if (now > a.deadline && !isFloor) {
    const before = prev?.text ?? '';
    // Same text is fine (a keystroke that changed nothing); shorter or
    // divergent is the deletion this window exists to prevent.
    if (!text.startsWith(before)) return { error: 'no_deleting', text: before };
  }

  a.locked.set(playerId, { text, at: now });
  return { ok: true, text, appendOnly: now > a.deadline && !isFloor };
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
  // Enter twice is one answer, not two. A player pressing it again — because
  // nothing visible happened, or because they hit it while thinking — was
  // putting the same line on the record and into the chat a second time. Only
  // a CHANGED answer is a new one; giving the same answer again says nothing
  // that isn't already there.
  const mine = [...a.spoken].reverse().find((sp) => sp.playerId === (playerId || null));
  if (mine && sameAnswer(mine.text, text)) return { ok: true, spoken: a.spoken.length, already: true };
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
  // Inside the guaranteed window it is free, full stop — that is the promise
  // the countdown on everyone's screen makes.
  if (Date.now() <= a.closesAt) return { free: true, reason: 'guaranteed' };
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
    // The window is open for as long as the cycle is: only the moderator ends
    // it, by judging the buzz or clearing the buzzer.
    open: true,
    deadline: a.deadline,
    closesAt: a.closesAt,
    // The promise, and whether it has run out: until closesAt a withdrawal is
    // free for everyone waiting behind the buzzer.
    guaranteed: now <= a.closesAt,
    // Past the deadline a box may only grow; the page greys out its own
    // deletion rather than silently having keystrokes rejected.
    appendOnly: now > a.deadline,
    committed: a.locked.size,
    activePlayerId: a.activePlayerId,
    spoken: a.spoken.map((s) => s.text),
    // The same answers with who gave them, for the moderator's reader to show
    // under the question as each one arrives. Not news to anyone: the room
    // already sees "Answer · name · text" in the chat.
    said: a.spoken.map((s) => ({ playerId: s.playerId, text: s.text, at: s.at }))
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
