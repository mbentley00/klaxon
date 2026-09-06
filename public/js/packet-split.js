// Splitting a packet into tiebreakers: one tossup per file.
//
// Klaxon's tiebreaker pool is fed by whole packets marked as tiebreakers, and
// visibility is per-file — so a twenty-question tiebreaker packet is released
// all at once or not at all. A director usually wants the opposite: hold the
// whole pool back and release the one question the room needs. One tossup per
// file gives exactly that, and costs nothing else — the pool already tracks
// usage per question, and getTiebreakerTossups only ever walks tossups, so the
// bonuses a tiebreaker packet came with were never going to be read.
//
// Pure and dependency-free: the /yapp page splits a packet it just parsed, and
// the server splits one a director already uploaded.

// The tossup keeps every field it arrived with — its `number` above all, which
// is what says WHICH question of the original packet this was, both to a reader
// and to a director looking at the file months later.
const TOSSUP_FIELDS = ['number', 'question', 'answer', 'metadata', 'question_sanitized', 'answer_sanitized', 'anchored'];

/**
 * Splits a packet into one single-tossup packet per tossup.
 *
 * `label` names the source (a round, or the file it came from); each result is
 * named "<label> TB 07", or just "TB 07" without one. Numbers are padded to a
 * fixed width so the files sort the way they were read.
 *
 * Returns [{ name, packet }] — empty if there is nothing to split.
 */
export function splitIntoTiebreakers(packet, { label = '' } = {}) {
  const tossups = Array.isArray(packet?.tossups) ? packet.tossups.filter((t) => t && typeof t === 'object') : [];
  if (!tossups.length) return [];

  const width = Math.max(2, String(tossups.length).length);
  const stem = String(label ?? '').trim();

  return tossups.map((tossup, i) => {
    const kept = {};
    for (const field of TOSSUP_FIELDS) {
      if (tossup[field] !== undefined) kept[field] = tossup[field];
    }
    // Fall back to the position in the packet when the parser gave no number,
    // so a hand-written packet still splits into something identifiable.
    if (kept.number === undefined) kept.number = i + 1;

    const suffix = `TB ${String(i + 1).padStart(width, '0')}`;
    const name = stem ? `${stem} ${suffix}` : suffix;
    // No `bonuses` key at all rather than an empty one: this is a pool of
    // tossups, and an empty bonus list would only invite a reader to look for
    // a bonus that was never there.
    return { name, packet: { name, tossups: [kept] } };
  });
}
