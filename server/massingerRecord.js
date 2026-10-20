// --- A MASSINGER game's pick/ban, as it goes out with the game -------------
// Every export of a game read after a pick/ban (the per-game download, the
// buzzpoints zip, the buzzpoint report) carries a `massinger` field saying
// which categories each team banned and protected, so a buzzpoint report can
// later show, say, how teams do on categories they chose to keep.
//
// Built from the room's saved board for the round (r/<ROOM>/massinger/<round>.json),
// which is what the game was actually read on. Tossup numbers are places in
// the FULL packet, the same numbering exports use (see packetNumbers.js).
// The field has no leading `_`, so buzzpointsGame keeps it; the importer
// ignores fields it doesn't know.

const teamOf = (board, i) => (Number.isInteger(i) && board.teams?.[i] != null ? String(board.teams[i]) : null);

/**
 * The pick/ban record for a finished board, or null (no board, not finished,
 * or a board for different teams than the game's).
 */
export function massingerRecord(board, qbj) {
  if (!board || board.status !== 'done' || !Array.isArray(board.subcats)) return null;
  // The board is saved per room + round, and so is the game: they should be the
  // same game. If the teams disagree, say nothing rather than credit the wrong
  // teams with picks.
  const gameTeams = (qbj?.match_teams || []).map((mt) => String(mt?.team?.name ?? '').trim()).filter(Boolean);
  const boardTeams = (board.teams || []).map((n) => String(n ?? '').trim());
  if (gameTeams.length && boardTeams.some((n) => n && !gameTeams.includes(n))) return null;

  // Replay the picks in order: the k-th ban of a category takes its k-th
  // question from the END (the same rule MODAQ's applyMassinger uses); a
  // protect keeps whatever of the category is left.
  const state = new Map(board.subcats.map((sc) => [sc.label, {
    indexes: Array.isArray(sc.indexes) ? sc.indexes : [], banned: [], protectedBy: null
  }]));
  const picks = [];
  for (const a of Array.isArray(board.actions) ? board.actions : []) {
    const sc = state.get(a?.label);
    if (!sc || (a.type !== 'ban' && a.type !== 'protect')) continue;
    let tossups;
    if (a.type === 'ban') {
      const i = sc.indexes[sc.indexes.length - 1 - sc.banned.length];
      if (i == null) continue;
      sc.banned.push(i);
      tossups = [i + 1];
    } else {
      sc.protectedBy = a.team;
      tossups = sc.indexes.filter((i) => !sc.banned.includes(i)).map((i) => i + 1);
    }
    picks.push({
      pick: picks.length + 1,
      team: teamOf(board, a.team),
      action: a.type,
      category: String(a.label),
      tossups,
      // A player's name, "moderator", "timeout" (the clock ran out and a
      // pick was made at random), or "random" (a random-bans game).
      by: a.by == null ? null : String(a.by),
      ...(Number.isFinite(a.at) ? { at: new Date(a.at).toISOString() } : {})
    });
  }

  const categories = board.subcats.map((sc) => {
    const s = state.get(sc.label);
    return {
      category: String(sc.label),
      tossups: s.indexes.map((i) => i + 1),
      banned: s.banned.map((i) => i + 1).sort((x, y) => x - y),
      protected_by: teamOf(board, sc.protectedBy ?? s.protectedBy)
    };
  });
  const random = board.control === 'random';
  return {
    // Random bans: drawn by Klaxon, not picked (every pick's team is null).
    mode: random ? 'random_bans' : 'pick_ban',
    teams: boardTeams,                    // in pick order: [0] picked first
    first_pick: random ? null : { team: boardTeams[0] ?? null, coin_flip: board.coinFlip === true },
    picks,
    categories,
    banned_tossups: categories.flatMap((c) => c.banned).sort((x, y) => x - y),
    protected_categories: categories.filter((c) => c.protected_by).map((c) => ({ category: c.category, team: c.protected_by })),
    // The banned tossups were the game's tiebreakers, in packet order.
    note: 'Tossup numbers are places in the full packet. Banned tossups were read only as tiebreakers.'
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One CSV row per pick across games, for joining onto buzzpoints:
 * `games` are [{ round, number, file, qbj }] with qbj.massinger set.
 */
export function massingerPicksCsv(games) {
  const rows = [['round_number', 'round', 'game_file', 'team_1', 'team_2', 'mode', 'pick', 'team', 'action', 'category', 'tossups', 'by', 'coin_flip']];
  for (const g of games) {
    const m = g.qbj?.massinger;
    if (!m) continue;
    const teams = (g.qbj.match_teams || []).map((mt) => mt?.team?.name ?? '');
    for (const p of m.picks) {
      rows.push([g.number ?? '', g.round ?? '', g.file ?? '', teams[0] ?? '', teams[1] ?? '', m.mode,
        p.pick, p.team, p.action, p.category, p.tossups.join(' '), p.by, m.first_pick?.coin_flip ? 'yes' : 'no']);
    }
  }
  return rows.length > 1 ? rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' : '';
}
