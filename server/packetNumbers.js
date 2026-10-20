// --- A game's question numbers, as places in the full packet ---------------
// MODAQ numbers questions by their place in the packet it was GIVEN. A
// MASSINGER game is given the packet less its banned questions (see
// applyMassinger in MODAQ's moderator.tsx), with the banned ones after them
// as tiebreakers, so its "question 5" can be the full packet's question 7 and
// its "question 21" the first question banned. Anything that looks a game's questions up in the
// stored, full packet (the buzzpoints zip, the per-game download, the
// buzzpoint report) has to renumber it first, or every buzz after the first
// ban silently lands on the wrong question.
//
// Two sources, checked against each other:
// - the room's saved pick/ban board for that round, which says exactly what
//   was removed (the same rule applyMassinger uses);
// - question_hash, MODAQ's fingerprint of the text as read, which finds the
//   question in the packet when there's no board or the board disagrees.
// Stored games are never rewritten: protests, corrections and the scoresheet
// all keep MODAQ's own numbering. This only runs on the way out.

/**
 * MODAQ's questionHash (src/qbj/QBJ.ts), byte for byte: markup stripped,
 * whitespace collapsed, fields joined with NUL, FNV-1a folded twice.
 */
export function questionHash(...parts) {
  const cleaned = parts.map((p) => String(p ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
  if (cleaned.every((p) => p === '')) return '';
  const text = cleaned.join('\u0000');
  const fnv = (seed) => {
    let h = seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x9e3779b9);
}

const tossupHash = (t) => questionHash(t?.question, t?.answer);
const bonusHash = (b) => questionHash(
  b?.leadin,
  ...(b?.parts || []).map((p) => p?.question),
  ...(b?.parts || []).map((p) => p?.answer)
);

/**
 * The 0-based packet indexes a finished pick/ban removed: in each subcategory,
 * its last `banned` questions. null when there is no finished board.
 */
export function bannedIndexes(board) {
  if (!board || board.status !== 'done' || !Array.isArray(board.subcats)) return null;
  const removed = new Set();
  for (const sc of board.subcats) {
    const idx = Array.isArray(sc?.indexes) ? sc.indexes : [];
    const n = Math.min(Number(sc?.banned) || 0, idx.length);
    for (let i = 0; i < n; i++) removed.add(idx[idx.length - 1 - i]);
  }
  return removed;
}

// question number as read (1-based) -> number in the full packet. MODAQ is
// given the kept tossups and then the banned ones, in packet order, as
// tiebreakers (`withBanned`; bonuses don't get them back). Numbers past all
// of that were questions added mid-game: they stay past the end of the full
// packet too, so nothing mistakes them for a real one.
function numberMap(total, removed, withBanned) {
  const order = [];
  for (let i = 0; i < total; i++) if (!removed.has(i)) order.push(i);
  if (withBanned) for (let i = 0; i < total; i++) if (removed.has(i)) order.push(i);
  return (n) => (n >= 1 && n <= order.length ? order[n - 1] + 1 : n > order.length ? n - order.length + total : n);
}

// Put one question reference (a tossup_question or a bonus's question) at its
// number in the full packet. Hash first: if the text as read is in the packet
// exactly once, that's where it is. Otherwise the board's mapping.
function place(ref, list, hashOf, hashIndex, mapNumber, report) {
  if (!ref || typeof ref !== 'object' || !Number.isFinite(Number(ref.question_number))) return ref;
  const read = Number(ref.question_number);
  let number = mapNumber ? mapNumber(read) : read;
  const hash = typeof ref.question_hash === 'string' ? ref.question_hash : '';
  if (hash && Array.isArray(list)) {
    const atNumber = list[number - 1];
    if (!atNumber || hashOf(atNumber) !== hash) {
      const found = hashIndex().get(hash);
      if (found != null) number = found + 1;
      // The text as read isn't in the packet at all: edited since (errata), or
      // a tiebreaker. Only worth flagging if it claims to be a packet question.
      else if (number <= list.length) report.unmatched++;
    }
  }
  if (number !== read) report.moved++;
  return number === read ? ref : { ...ref, question_number: number };
}

/**
 * The game with every tossup and bonus numbered by its place in `packet`.
 * `board` is the room's saved MASSINGER board for the round (or null).
 * Returns { qbj, moved, unmatched }; qbj is the same object when nothing moved.
 */
export function toPacketNumbers(qbj, packet, board) {
  const report = { moved: 0, unmatched: 0 };
  if (!qbj || !Array.isArray(qbj.match_questions) || !packet) return { qbj, ...report };
  const tossups = Array.isArray(packet.tossups) ? packet.tossups : [];
  const bonuses = Array.isArray(packet.bonuses) ? packet.bonuses : [];
  const removed = bannedIndexes(board);
  const tossupMap = removed && removed.size ? numberMap(tossups.length, removed, true) : null;
  // applyMassinger only takes bonuses out alongside their tossups when the two
  // line up one-to-one; otherwise MODAQ was given every bonus.
  const bonusMap = tossupMap && bonuses.length === tossups.length ? numberMap(bonuses.length, removed, false) : null;

  // Hash -> index, for hashes that occur once (a duplicated question can't say
  // which copy was read).
  const indexOf = (list, hashOf) => {
    let cache = null;
    return () => {
      if (cache) return cache;
      const seen = new Map();
      list.forEach((q, i) => {
        const h = hashOf(q);
        if (!h) return;
        seen.set(h, seen.has(h) ? null : i);
      });
      cache = new Map([...seen].filter(([, i]) => i != null));
      return cache;
    };
  };
  const tossupIndex = indexOf(tossups, tossupHash);
  const bonusIndex = indexOf(bonuses, bonusHash);

  const before = report.moved;
  const match_questions = qbj.match_questions.map((q) => {
    if (!q || typeof q !== 'object') return q;
    const out = { ...q };
    if (q.tossup_question) out.tossup_question = place(q.tossup_question, tossups, tossupHash, tossupIndex, tossupMap, report);
    if (q.replacement_tossup_question) {
      out.replacement_tossup_question = place(q.replacement_tossup_question, tossups, tossupHash, tossupIndex, tossupMap, report);
    }
    if (q.bonus?.question) {
      out.bonus = { ...q.bonus, question: place(q.bonus.question, bonuses, bonusHash, bonusIndex, bonusMap, report) };
    }
    return out;
  });
  if (report.moved === before) return { qbj, ...report };
  return { qbj: { ...qbj, match_questions }, ...report };
}
