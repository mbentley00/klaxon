// ---------------------------------------------------------------------------
// A whole tournament as a YellowFruit file (.yft) that File > Open takes as it
// is: the teams and players, the phases and rounds, and every final game.
//
// The shape is YellowFruit 4's own save format, read from its source (v4.0.18)
// and checked against its parser: `{ version: '2.1.1', objects: [Tournament] }`
// with everything nested inline, QBJ keys in snake_case and YellowFruit's own
// settings under `YfData` on each object. What it is strict about, and why the
// code below does what it does:
//
//   * `YfData.YfVersion` is required, and a file newer than the running app is
//     refused, so it claims 4.0.12 (the oldest version whose loader is the same).
//   * A team's id must be exactly "Team_" + its name (seeds and standings look
//     teams up that way); player ids must be unique across the whole file.
//   * Every team needs a player; every phase needs a round; a round needs
//     `YfData.number` (without it a name like "Round 1" parses as NaN and its
//     games are silently dropped); a match needs `carryover_phases` and every
//     match player `answer_counts`, even empty.
//   * Bonuses are on exactly when `maximum_bonus_score` is present, and then
//     points per part x parts must equal it.
//   * Standings only count teams that sit in a pool of the phase.
//   * A game whose regulation tossups exceed the format's maximum is an error
//     (left out of the standings), so regulation is the usual game length and
//     anything past it is recorded as overtime.
// ---------------------------------------------------------------------------

const TOSSUP_VALUES = {
  '15/10/-5': [15, 10, -5],
  '20/15/10/-5': [20, 15, 10, -5],
  '20/10/0': [20, 10, 0]
};
const YF_VERSION = '4.0.12';
const MAX_ANSWER_TYPES = 6;

const teamId = (name) => 'Team_' + name;
const yfPlayer = { yearString: '', isUG: false, isD2: false };

/**
 * @param t         the tournament (name, date, format)
 * @param stats     computeStats() output: phases with rounds, the scoreboard
 * @param roster    the stored roster ({ registrations: [{ teams: [{ name, players: [{ name }] }] }] }) or null
 */
export function buildYft(t, stats, roster) {
  // --- scoring: the tournament's scheme, plus any value a game actually used.
  const values = new Set(TOSSUP_VALUES[t.format?.tossupScheme] || TOSSUP_VALUES['15/10/-5']);
  for (const v of stats.answerValues || []) if (Number.isInteger(v) && v >= -1000 && v <= 1000) values.add(v);
  const answerValues = [...values].sort((a, b) => b - a).slice(0, MAX_ANSWER_TYPES);
  const answerRef = (v) => ({ $ref: 'AnswerType_' + v });
  const hasBonuses = t.format?.hasBonuses !== false;

  const games = [];
  for (const phase of stats.scoreboard || []) {
    for (const r of phase.rounds) {
      for (const g of r.games) if (g.teams.length === 2 && !g.live) games.push({ phase: phase.name, round: r.round, game: g });
    }
  }
  // Regulation is the length most games ran (20 when there are none); a game
  // that went longer is recorded with the extra tossups as overtime.
  const lengths = new Map();
  for (const { game } of games) {
    const n = Math.round(Number(game.tuh) || 0);
    if (n > 0) lengths.set(n, (lengths.get(n) || 0) + 1);
  }
  const usual = [...lengths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 20;
  const regulation = Math.min(100, Math.max(1, usual));

  // --- teams: the roster's, then anyone who played without being on it. A
  // player who subbed in is added to their team.
  const teams = new Map(); // name -> { name, players: Map(name -> id) }
  const addPlayer = (team, name) => {
    const clean = String(name || '').trim();
    if (!clean || team.players.has(clean)) return;
    let id = `Player_${team.name}_${clean}`;
    for (let n = 2; usedIds.has(id); n++) id = `Player_${team.name}_${clean}_${n}`;
    usedIds.add(id);
    team.players.set(clean, id);
  };
  const usedIds = new Set();
  const teamFor = (name) => {
    const clean = String(name || '').trim();
    if (!clean) return null;
    if (!teams.has(clean)) teams.set(clean, { name: clean, players: new Map() });
    return teams.get(clean);
  };
  for (const reg of roster?.registrations || []) {
    for (const team of reg?.teams || []) {
      const entry = teamFor(team?.name);
      if (!entry) continue;
      for (const p of team?.players || []) addPlayer(entry, p?.name);
    }
  }
  for (const { game } of games) {
    for (const side of game.teams) {
      const entry = teamFor(side.name);
      for (const p of side.players || []) addPlayer(entry, p.name);
    }
  }
  // A team needs a player to load; one with none (a roster entry nobody filled
  // in, that never played) is left out rather than invented a player.
  for (const [name, entry] of teams) if (entry.players.size === 0) teams.delete(name);

  // --- rounds: YellowFruit numbers them, in order across the phases. A round
  // already called by a number keeps it where it can; the label it had here
  // goes on as its packet name.
  const roundNumber = new Map();
  let next = 1;
  const taken = new Set();
  for (const phase of stats.phases || []) {
    for (const label of phase.rounds) {
      if (roundNumber.has(label)) continue;
      const m = String(label).match(/\d+/);
      let n = m ? Number(m[0]) : NaN;
      if (!Number.isFinite(n) || n < next || taken.has(n)) n = next;
      roundNumber.set(label, n);
      taken.add(n);
      next = n + 1;
    }
  }

  let matchId = 0;
  const phases = (stats.phases || []).filter((ph) => ph.rounds.length > 0).map((ph, i) => {
    const phaseGames = games.filter((x) => x.phase === ph.name);
    // Pools: the phase's divisions, or one pool of everyone who played in it.
    const played = new Set();
    for (const { game } of phaseGames) for (const side of game.teams) played.add(side.name);
    const groups = (ph.groups || []).filter((gr) => gr.division);
    const pools = (groups.length ? groups.map((gr) => ({ name: gr.division, teams: gr.teams.map((x) => x.name) }))
      : [{ name: i === 0 ? 'Pool A' : `${ph.name} pool`, teams: [...played] }])
      .map((pool) => ({ ...pool, teams: pool.teams.filter((name) => teams.has(name)) }))
      .filter((pool) => pool.teams.length > 0);
    const rounds = ph.rounds.map((label) => ({
      YfData: { number: roundNumber.get(label) },
      name: String(roundNumber.get(label)),
      packets: [{ name: String(label) }],
      matches: phaseGames.filter((x) => x.round === label && x.game.teams.every((s) => teams.has(s.name)))
        .map(({ game }) => yftMatch(game, ++matchId))
    }));
    return {
      YfData: { phaseType: i === 0 ? 'Prelim' : 'Playoff', code: String(i + 1), wildCardAdvancementRules: [], wildCardRankingMethod: 'RankThenPPB' },
      id: 'Phase_' + ph.name,
      name: ph.name === 'All Games' ? 'Prelims' : ph.name,
      pools: pools.map((pool) => ({
        YfData: { size: pool.teams.length, roundRobins: 1, seeds: [], hasCarryover: false, autoAdvanceRules: [] },
        name: pool.name,
        position: 1,
        pool_teams: pool.teams.map((name) => ({ YfData: {}, team: { $ref: teamId(name) } }))
      })),
      rounds
    };
  });

  function yftMatch(game, n) {
    const tuh = Math.max(1, Math.round(Number(game.tuh) || 0));
    return {
      YfData: { otherValidation: [] },
      id: `Match_${n}`,
      tossups_read: tuh,
      overtime_tossups_read: Math.max(0, tuh - regulation),
      tiebreaker: false,
      carryover_phases: [],
      notes: 'Exported from Klaxon',
      match_teams: game.teams.map((side) => {
        const team = teams.get(side.name);
        return {
          YfData: { overTimeBuzzes: [], validation: [] },
          team: { $ref: teamId(side.name) },
          forfeit_loss: false,
          points: Math.round(Number(side.total) || 0),
          match_players: (side.players || []).filter((p) => team.players.has(String(p.name).trim())).map((p) => ({
            player: { $ref: team.players.get(String(p.name).trim()) },
            tossups_heard: Math.min(tuh, Math.max(0, Math.round(Number(p.tuh) || 0))),
            answer_counts: answerValues.map((v) => ({ number: Math.max(0, Number(p.ac?.get?.(v)) || 0), answer_type: answerRef(v) }))
          }))
        };
      })
    };
  }

  const scoring = {
    YfData: { timed: false },
    name: '',
    answer_types: answerValues.map((v) => ({ id: 'AnswerType_' + v, value: v })),
    maximum_regulation_tossup_count: regulation,
    maximum_players_per_team: Math.min(30, Math.max(4, ...[...teams.values()].map((x) => x.players.size))),
    minimum_overtime_question_count: 1,
    overtime_includes_bonuses: false,
    lightning_count_per_team: 0,
    total_divisor: 5
  };
  if (hasBonuses) {
    Object.assign(scoring, {
      bonuses_bounce_back: false,
      maximum_bonus_score: 30,
      minimum_parts_per_bonus: 3,
      maximum_parts_per_bonus: 3,
      points_per_bonus_part: 10,
      bonus_divisor: 10
    });
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')) ? `${t.date}T00:00:00.000Z` : undefined;
  const tournament = {
    type: 'Tournament',
    name: t.name || t.code,
    ...(date ? { start_date: date } : {}),
    question_set: '',
    YfData: {
      YfVersion: YF_VERSION,
      seeds: [],
      trackPlayerYear: false,
      trackSmallSchool: false,
      trackJV: false,
      trackUG: false,
      trackDiv2: false,
      finalRankingsReady: false,
      usingScheduleTemplate: false
    },
    tournament_site: { name: 'Online (Klaxon)' },
    scoring_rules: scoring,
    registrations: [...teams.values()].map((team) => ({
      YfData: { isSmallSchool: false },
      name: team.name,
      teams: [{
        YfData: { letter: '', isJV: false, isUG: false, isD2: false },
        id: teamId(team.name),
        name: team.name,
        players: [...team.players].map(([name, id]) => ({ YfData: { ...yfPlayer }, id, name }))
      }]
    })),
    phases: phases.length ? phases : [{
      // No games yet: one empty prelim round, so the teams still open.
      YfData: { phaseType: 'Prelim', code: '1', wildCardAdvancementRules: [], wildCardRankingMethod: 'RankThenPPB' },
      id: 'Phase_Prelims', name: 'Prelims',
      pools: teams.size ? [{
        YfData: { size: teams.size, roundRobins: 1, seeds: [], hasCarryover: false, autoAdvanceRules: [] },
        name: 'Pool A', position: 1,
        pool_teams: [...teams.keys()].map((name) => ({ YfData: {}, team: { $ref: teamId(name) } }))
      }] : [],
      rounds: [{ YfData: { number: 1 }, name: '1', matches: [] }]
    }],
    rankings: [{ id: 'Ranking_Overall', name: 'Overall' }]
  };
  return { version: '2.1.1', objects: [tournament] };
}
