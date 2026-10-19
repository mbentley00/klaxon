// Experimental: the room's half of a moderator's post-round scorecard (see
// MODAQ's src/scorecard). What only the server saw: how long buzzes waited for
// the buzzer to be cleared, the clears taken back, withdrawals, players asking
// whether the buzzer was stuck, protests, errata. Staff only, and nothing here
// is shown to players.
//
// "This round" is everything since `since` (when the moderator's screen
// started timing it) and, in a room that has moved on to another packet, since
// that happened. In a tournament room the buzzes are also matched on the
// round, which the buzz log stamps.

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function roundSummary(room, { since = 0, round = null, errata = [] } = {}) {
  const log = room.log || [];
  // A room's next packet starts a new game; nothing before it is this round
  let from = Number(since) || 0;
  for (const e of log) if (e.type === 'next_game' && e.at > from) from = e.at;

  const inRound = (b) => b.at >= from && (round == null || b.round == null || String(b.round) === String(round));
  const buzzes = (room.buzzLog || []).filter(inRound);
  const entries = log.filter((e) => e.at >= from);

  // Buzz to ruling: the first accepted buzz of each judged clear to the clear
  // itself. A reset's cycleNo is the cycle it opened; its buzzes carry the one
  // before.
  const waits = [];
  for (const e of entries) {
    if (e.type !== 'reset_buzzer' || e.judged !== true) continue;
    const first = buzzes
      .filter((b) => b.accepted && !b.accidental && b.cycleNo === e.cycleNo - 1 && b.at <= e.at)
      .sort((a, b) => a.at - b.at)[0];
    if (first) waits.push({ question: first.question ?? e.question ?? null, ms: e.at - first.at });
  }

  const protests = (room.protests || []).filter((p) => p.at >= from &&
    (round == null || p.round == null || String(p.round) === String(round)));
  const byStatus = {};
  for (const p of protests) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  const withdrawals = entries.filter((e) => e.type === 'withdraw');
  const roomErrata = (errata || []).filter((e) =>
    String(e?.room || '').toUpperCase() === room.code && (round == null || String(e?.round ?? '') === String(round)));

  return {
    since: from,
    buzzes: buzzes.length,
    acceptedBuzzes: buzzes.filter((b) => b.accepted).length,
    buzzToRuling: {
      count: waits.length,
      medianMs: median(waits.map((w) => w.ms)),
      slowest: [...waits].sort((a, b) => b.ms - a.ms).slice(0, 3)
    },
    // Clears without a ruling: a knocked buzzer, or a buzz nobody answered
    accidentalClears: entries.filter((e) => e.type === 'reset_buzzer' && e.judged === false && e.dropped?.length).length,
    undoneClears: entries.filter((e) => e.type === 'restore_buzzes').length,
    withdrawals: {
      count: withdrawals.length,
      byPlayer: withdrawals.filter((e) => e.byPlayer).length,
      free: withdrawals.filter((e) => e.free).length
    },
    stuckAlerts: entries.filter((e) => e.type === 'stuck_alert').length,
    protests: { count: protests.length, byStatus },
    errata: {
      count: roomErrata.length,
      thrownOut: roomErrata.filter((e) => e.thrownOut).length
    }
  };
}
