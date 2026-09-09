// ---------------------------------------------------------------------------
// Playtest feedback: what the room thought of a question.
//
// A playtest is a tournament run to find out what is wrong with the questions,
// so the room is the instrument. The cost of getting that feedback is normally
// that somebody has to remember, after the round, which question it was and
// what bothered them about it — by which point the specific complaint ("the
// second clue gives it away") has flattened into "that packet was rough".
//
// So it is collected in the moment, from the scoresheet, one tap: the four
// things people actually say about a question, plus room to write. The tags
// are deliberately few. A long list would be a form, and nobody fills in a
// form mid-round.
//
// It rides the same gate as the answer line (see store.revealCeiling): you can
// only comment on a cycle the room has finished. Before that, the question is
// still being played and an opinion about it would be a spoiler.
// ---------------------------------------------------------------------------

// The four verdicts, and what each is FOR — a tag nobody can interpret later is
// worse than no tag. "error" is factual (something in it is wrong); the other
// three are judgements a writer can act on without further explanation.
export const FEEDBACK_TAGS = [
  { id: 'error', label: 'Question error', hint: 'Something in it is factually wrong' },
  { id: 'early', label: 'Clue too early', hint: 'A giveaway clue came before it should have' },
  { id: 'hard', label: 'Too hard', hint: 'Nobody in the room could get it' },
  { id: 'great', label: 'Great question', hint: 'Worth keeping as it is' }
];
const TAG_IDS = new Set(FEEDBACK_TAGS.map((t) => t.id));

const MAX_PER_ROOM = 500;
const MAX_TEXT = 1000;
const clean = (v, cap = MAX_TEXT) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

/**
 * Record (or replace) one person's verdict on one question.
 *
 * One entry per player per question, rewritten rather than appended: a
 * playtester who taps "too hard" and then adds a sentence has one opinion, not
 * two. Clearing every tag and the text removes it, so a mis-tap is undoable.
 *
 * `cycle` is checked against what the room has actually finished — the caller
 * passes the scoresheet's released ceiling — so this can't be used to fish for
 * an answer line by commenting on a question nobody has heard.
 */
export function record(room, actor, { cycle, tags, text, released, round, answer }) {
  if (!room.playtestFeedback) room.playtestFeedback = [];
  const n = Number(cycle);
  if (!Number.isFinite(n) || n < 1) return { error: 'no_question' };
  if (n > released) return { error: 'not_finished' };

  const picked = (Array.isArray(tags) ? tags : []).map(String).filter((t) => TAG_IDS.has(t));
  const note = clean(text);
  const key = (f) => f.playerId === actor.id && f.cycle === n && f.room === room.code;
  const existing = room.playtestFeedback.find(key);

  // Nothing said at all: withdraw whatever was there.
  if (!picked.length && !note) {
    if (existing) room.playtestFeedback = room.playtestFeedback.filter((f) => !key(f));
    return { ok: true, removed: true };
  }

  const entry = existing || {
    room: room.code,
    playerId: actor.id,
    cycle: n,
    at: Date.now()
  };
  entry.name = actor.name;
  entry.team = actor.team || null;
  entry.round = round == null ? entry.round ?? null : String(round).slice(0, 40);
  // The answer line as the room saw it, so the writer reading this later knows
  // which question it was without matching round and number against a packet.
  if (answer) entry.answer = clean(answer, 300);
  entry.tags = picked;
  entry.text = note;
  entry.at = Date.now();

  if (!existing) {
    if (room.playtestFeedback.length >= MAX_PER_ROOM) return { error: 'too_many' };
    room.playtestFeedback.push(entry);
  }
  return { ok: true, entry };
}

/**
 * What one player may see: their own verdicts, keyed by question.
 *
 * Only their own, and deliberately. A playtester who can see that three people
 * already said "too hard" is no longer an independent opinion, and the whole
 * value of a playtest room is that its opinions are independent.
 */
export function mine(room, playerId) {
  const out = {};
  for (const f of room.playtestFeedback || []) {
    if (f.playerId !== playerId) continue;
    out[f.cycle] = { tags: f.tags, text: f.text };
  }
  return out;
}

// Everything the room has said, for the director. Names included: in a
// playtest, knowing who thought a question was too hard is most of the signal.
export function all(room) {
  return (room.playtestFeedback || []).map((f) => ({ ...f }));
}
