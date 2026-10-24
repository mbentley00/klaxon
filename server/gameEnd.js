// When a game that has reached its end counts as finished without the
// moderator pressing Save & next game.
//
// The moderator's save is what finishes a game. But not every room presses it,
// and a game left "in progress" holds up the standings and the live view. So a
// game that MODAQ says is on its last question (regulation over, no tie to
// break) is finished here when either
//   (a) that question has a correct answer and its cycle is over, or
//   (b) the game has sat on that question for END_IDLE_MS.
// MODAQ's game file can't tell a bonus part read and missed from one not read
// yet, so "the cycle is over" is a correct answer plus BONUS_GRACE_MS to read
// the bonus (at once in a tossups-only game). Only for a game played to the
// end: a buzz on one of its last three questions (tossup 18 or later of 20),
// so a run-through nobody buzzed in is never finished for them.

export const BONUS_GRACE_MS = 90 * 1000;
export const END_IDLE_MS = 5 * 60 * 1000;

// Called with every live update. Keeps room.gameEnd while the game is on its
// last question, and clears it when it isn't (a tie going to overtime, another
// game).
export function noteUpdate(room, { round, qbj, currentQuestion, atEnd, hasBonuses }, now = Date.now()) {
  const q = Number(currentQuestion) || 0;
  const mqs = Array.isArray(qbj?.match_questions) ? qbj.match_questions : [];
  const playedToEnd = mqs.some((m) => (Number(m?.question_number) || 0) >= q - 2 && (m?.buzzes?.length ?? 0) > 0);
  if (atEnd !== true || q < 1 || !playedToEnd) {
    room.gameEnd = null;
    return;
  }
  const prev = room.gameEnd && room.gameEnd.round === String(round) && room.gameEnd.question === q ? room.gameEnd : null;
  const cur = mqs.find((m) => Number(m?.question_number) === q);
  const correct = (cur?.buzzes ?? []).some((b) => Number(b?.result?.value) > 0);
  room.gameEnd = {
    round: String(round),
    question: q,
    qbj,
    since: prev?.since ?? now,
    correctSince: correct ? (prev?.correctSince ?? now) : null,
    hasBonuses: hasBonuses !== false,
    done: prev?.done ?? false,
  };
}

export function isDue(w, now = Date.now()) {
  if (!w || w.done) return false;
  if (now - w.since >= END_IDLE_MS) return true;
  return w.correctSince != null && (!w.hasBonuses || now - w.correctSince >= BONUS_GRACE_MS);
}
