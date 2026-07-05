// ---------------------------------------------------------------------------
// Quizbowl stats engine. Aggregates the MODAQ match QBJs a tournament has
// synced (see artifacts.readAllExports) into team/player/round/game stats, in a
// shape the YellowFruit-style report generator (yellowfruit.js) can render.
//
// A tournament "structure" (optional, set by the director) groups rounds into
// phases (Prelims/Playoffs/…) and teams into divisions/tiers within a phase.
// Without one, everything is a single phase ("All Games").
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Auto-assigned phase colors (matches YellowFruit's stage tinting).
const PHASE_COLORS = ['#03a9f4', '#4caf50', '#ff9800', '#9c27b0', '#f44336', '#795548'];

function foldAnswerCounts(answerCounts, into) {
  let points = 0;
  let positives = 0;
  for (const ac of answerCounts || []) {
    const value = num(ac?.answer?.value);
    const count = num(ac?.number);
    if (count === 0) continue;
    points += value * count;
    if (value > 0) positives += count;
    into.set(value, (into.get(value) || 0) + count);
  }
  return { points, positives };
}

// Points a director's upheld protest rulings add to (or subtract from) a
// team's total in this match. Player-level stats stay as read — like a real
// TD's protest correction, only the game score moves.
function rulingAdjustment(qbj, teamName) {
  const rulings = qbj?._protestRulings;
  if (!rulings || typeof rulings !== 'object') return 0;
  let sum = 0;
  for (const r of Object.values(rulings)) {
    if (r?.status !== 'upheld') continue;
    for (const a of r.adjustments || []) {
      if (String(a?.team) === teamName) sum += num(a.points);
    }
  }
  return sum;
}

const blankTeam = (name) => ({
  name, games: 0, wins: 0, losses: 0, ties: 0,
  tuh: 0, tossupPoints: 0, totalPoints: 0, bonusPoints: 0, bonusesHeard: 0,
  ac: new Map(), gameLog: [],
});
const blankPlayer = (name, team) => ({ name, team, gp: 0, tuh: 0, points: 0, ac: new Map(), gameLog: [] });
const playerKey = (team, name) => `${team} ${name}`;

// Core aggregation over a list of matches. Returns Maps/arrays; callers convert.
function aggregate(matches) {
  const teams = new Map();
  const players = new Map();
  const rounds = new Map();
  const games = [];
  const answerValues = new Set();

  const getTeam = (n) => { let t = teams.get(n); if (!t) { t = blankTeam(n); teams.set(n, t); } return t; };
  const getPlayer = (tm, n) => { const k = playerKey(tm, n); let p = players.get(k); if (!p) { p = blankPlayer(n, tm); players.set(k, p); } return p; };
  const getRound = (r) => {
    let x = rounds.get(r);
    if (!x) { x = { round: r, games: 0, teamTuh: 0, teamPoints: 0, powers: 0, positives: 0, negs: 0, tossups: 0, bonusPoints: 0, bonuses: 0 }; rounds.set(r, x); }
    return x;
  };

  for (const match of matches) {
    const qbj = match?.qbj || match;
    if (!qbj || !Array.isArray(qbj.match_teams) || qbj.match_teams.length === 0) continue;
    const round = String(qbj._round ?? '');
    // Still being read (live sync): show it on the scoreboard, but don't record
    // a win/loss/tie until the game is over.
    const live = qbj._inProgress === true;
    const tuh = num(qbj.tossups_read) || (Array.isArray(qbj.match_questions) ? qbj.match_questions.length : 0);

    const perTeam = qbj.match_teams.map((mt) => {
      const teamName = mt?.team?.name || '?';
      const teamAc = new Map();
      let tossupPoints = 0, positives = 0;
      const playerRows = [];
      for (const mp of mt?.match_players || []) {
        const pName = mp?.player?.name || '?';
        const pTuh = num(mp?.tossups_heard);
        const pAc = new Map();
        const folded = foldAnswerCounts(mp?.answer_counts, pAc);
        tossupPoints += folded.points;
        positives += folded.positives;
        for (const [v, c] of pAc) teamAc.set(v, (teamAc.get(v) || 0) + c);
        playerRows.push({ name: pName, tuh: pTuh, ac: pAc, points: folded.points });
      }
      const bonusPoints = num(mt?.bonus_points);
      const total = tossupPoints + bonusPoints + rulingAdjustment(qbj, teamName);
      return { teamName, teamAc, tossupPoints, positives, bonusPoints, total, playerRows };
    });

    let winnerIndex = -1;
    if (perTeam.length === 2) {
      if (perTeam[0].total > perTeam[1].total) winnerIndex = 0;
      else if (perTeam[1].total > perTeam[0].total) winnerIndex = 1;
      else winnerIndex = -2;
    }

    perTeam.forEach((pt, i) => {
      const team = getTeam(pt.teamName);
      team.games += 1; team.tuh += tuh;
      team.tossupPoints += pt.tossupPoints; team.totalPoints += pt.total;
      team.bonusPoints += pt.bonusPoints; team.bonusesHeard += pt.positives;
      for (const [v, c] of pt.teamAc) { team.ac.set(v, (team.ac.get(v) || 0) + c); answerValues.add(v); }
      const opp = perTeam.length === 2 ? perTeam[1 - i] : undefined;
      let result = '';
      if (perTeam.length === 2 && !live) {
        if (winnerIndex === -2) { team.ties += 1; result = 'T'; }
        else if (winnerIndex === i) { team.wins += 1; result = 'W'; }
        else { team.losses += 1; result = 'L'; }
      }
      team.gameLog.push({ round, opponent: opp?.teamName || 'Bye', result, live, points: pt.total, oppPoints: opp?.total ?? 0, tuh, ac: pt.teamAc, bonusPoints: pt.bonusPoints, bonusesHeard: pt.positives });
      for (const pr of pt.playerRows) {
        const player = getPlayer(pt.teamName, pr.name);
        player.gp += tuh > 0 ? pr.tuh / tuh : 0;
        player.tuh += pr.tuh; player.points += pr.points;
        for (const [v, c] of pr.ac) player.ac.set(v, (player.ac.get(v) || 0) + c);
        player.gameLog.push({ round, opponent: opp?.teamName || 'Bye', tuh: pr.tuh, ac: pr.ac, points: pr.points });
      }
    });

    const r = getRound(round);
    r.games += 1;
    for (const pt of perTeam) {
      r.teamTuh += tuh; r.teamPoints += pt.total; r.bonusPoints += pt.bonusPoints; r.bonuses += pt.positives;
      for (const [v, c] of pt.teamAc) { if (v > 0) r.positives += c; if (v < 0) r.negs += c; }
    }
    r.tossups += tuh;

    games.push({ round, tuh, live, teams: perTeam.map((pt) => ({ name: pt.teamName, total: pt.total, bonusPoints: pt.bonusPoints, players: pt.playerRows })) });
  }

  return { teams, players, rounds, games, answerValues };
}

function sortRoundLabels(labels) {
  return [...labels].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

// Build the ordered list of phases (each with its round set + color) from the
// director's structure, plus a catch-all for any rounds it doesn't cover.
function buildPhaseList(structure, allRounds) {
  const configured = Array.isArray(structure?.phases) ? structure.phases : [];
  const phases = [];
  const assigned = new Set();
  configured.forEach((p, i) => {
    const roundSet = new Set((p.rounds || []).map(String));
    phases.push({ name: p.name || `Phase ${i + 1}`, color: p.color || PHASE_COLORS[i % PHASE_COLORS.length], roundSet });
    for (const r of roundSet) assigned.add(r);
  });
  const leftover = [...allRounds].filter((r) => !assigned.has(r));
  if (phases.length === 0) {
    phases.push({ name: 'All Games', color: null, roundSet: new Set(allRounds) });
  } else if (leftover.length > 0) {
    phases.push({ name: 'Other Rounds', color: PHASE_COLORS[phases.length % PHASE_COLORS.length], roundSet: new Set(leftover) });
  }
  return phases;
}

// Group a phase's teams into divisions/tiers per the structure.
function groupTeams(teamStats, phaseName, structure) {
  const divisions = (Array.isArray(structure?.divisions) ? structure.divisions : []).filter((d) => String(d.phase) === String(phaseName));
  if (divisions.length === 0) {
    return [{ division: null, teams: teamStats }];
  }
  const teamToDiv = new Map();
  for (const d of divisions) for (const t of d.teams || []) teamToDiv.set(t, d.name);
  const groups = divisions.map((d) => ({ division: d.name, teams: [] }));
  const byName = new Map(groups.map((g) => [g.division, g]));
  const unassigned = [];
  for (const t of teamStats) {
    const div = teamToDiv.get(t.name);
    if (div != undefined && byName.has(div)) byName.get(div).teams.push(t);
    else unassigned.push(t);
  }
  if (unassigned.length) groups.push({ division: 'Unassigned', teams: unassigned });
  return groups.filter((g) => g.teams.length > 0);
}

// Rows for the Live Games view: current score, question progress, elapsed time.
// Kept out of aggregate() so half-played games never touch the real stats.
export function liveGameRows(liveMatches) {
  return liveMatches.map((m) => {
    const qbj = m?.qbj || m;
    const teams = (Array.isArray(qbj.match_teams) ? qbj.match_teams : []).map((mt) => {
      let tossupPoints = 0;
      for (const mp of mt?.match_players || []) {
        for (const ac of mp?.answer_counts || []) tossupPoints += num(ac?.answer?.value) * num(ac?.number);
      }
      const name = mt?.team?.name || '?';
      return { name, total: tossupPoints + num(mt?.bonus_points) + rulingAdjustment(qbj, name) };
    });
    return {
      round: String(qbj._round ?? ''),
      room: String(qbj._room ?? ''),
      currentQuestion: num(qbj._currentQuestion) || 0,
      tuh: num(qbj.tossups_read),
      startedAt: num(qbj._startedAt) || 0,
      updatedAt: num(m?.savedAt) || 0,
      teams,
    };
  }).sort((a, b) => {
    const na = Number(a.round), nb = Number(b.round);
    const byRound = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.round.localeCompare(b.round);
    return byRound || a.room.localeCompare(b.room);
  });
}

// --- protests ----------------------------------------------------------------
// MODAQ records protests as structured sentences in the match notes:
//   Tossup protest on tossup #4. Team "X" protested because of this reason: "R".
//   Bonus protest on bonus #4. Team "X" protested part 2 because of this reason: "R".
// Parse them back out and judge each one: while the game is live it's pending;
// once final, a protest by the winner can't change the result (moot), and a
// protest by the loser matters only if a generous best-case swing could still
// tie or flip the game.
const TOSSUP_PROTEST_RE = /^Tossup protest on tossup #(\d+)\. Team "(.*)" protested because of this reason: "([\s\S]*)"\.$/;
const BONUS_PROTEST_RE = /^Bonus protest on bonus #(\d+)\. Team "(.*)" protested part (\d+) because of this reason: "([\s\S]*)"\.$/;

function matchTeamTotals(qbj) {
  return (Array.isArray(qbj.match_teams) ? qbj.match_teams : []).map((mt) => {
    let tossupPoints = 0;
    for (const mp of mt?.match_players || []) {
      for (const ac of mp?.answer_counts || []) tossupPoints += num(ac?.answer?.value) * num(ac?.number);
    }
    const name = mt?.team?.name || '?';
    return { name, total: tossupPoints + num(mt?.bonus_points) + rulingAdjustment(qbj, name) };
  });
}

// Best-case points a single protest could swing, erring toward "still matters":
// the protesting team gains the biggest tossup + a full bonus, AND the opponent
// loses the same if the ruling takes the question away from them.
function maxSwing(qbj, type) {
  let maxTossup = 10;
  let negRefund = 0;
  let hasBonuses = false;
  for (const mt of qbj.match_teams || []) {
    if (num(mt?.bonus_points) > 0) hasBonuses = true;
    for (const mp of mt?.match_players || []) {
      for (const ac of mp?.answer_counts || []) {
        const v = num(ac?.answer?.value);
        if (v > maxTossup) maxTossup = v;
        if (v < 0) negRefund = Math.max(negRefund, -v);
      }
    }
  }
  const bonus = hasBonuses ? 30 : 0;
  if (type === 'bonus') return bonus;
  return 2 * (maxTossup + bonus) + negRefund;
}

export function protestRows(allMatches) {
  const rows = [];
  for (const m of allMatches) {
    const qbj = m?.qbj || m;
    if (!qbj || typeof qbj.notes !== 'string') continue;
    const live = qbj._inProgress === true;
    const teams = matchTeamTotals(qbj);
    for (const line of qbj.notes.split('\n')) {
      const tossup = line.match(TOSSUP_PROTEST_RE);
      const bonusM = tossup ? null : line.match(BONUS_PROTEST_RE);
      if (!tossup && !bonusM) continue;
      const type = tossup ? 'tossup' : 'bonus';
      const [question, team, part, reason] = tossup
        ? [num(tossup[1]), tossup[2], null, tossup[3]]
        : [num(bonusM[1]), bonusM[2], num(bonusM[3]), bonusM[4]];

      // A director's ruling settles the protest; otherwise judge it from the
      // (adjustment-corrected) score.
      const rulings = qbj._protestRulings && typeof qbj._protestRulings === 'object' ? qbj._protestRulings : {};
      const ruling = rulings[`${type}|${question}|${part || 0}|${team}`] || null;
      let status = 'pending'; // game still live: everything is undecided
      if (ruling) {
        status = ruling.status; // upheld | denied
      } else if (!live && teams.length === 2) {
        const margin = Math.abs(teams[0].total - teams[1].total);
        const winner = teams[0].total > teams[1].total ? teams[0].name
          : teams[1].total > teams[0].total ? teams[1].name : null;
        if (winner === null) status = 'matters'; // tied game: any protest matters
        else if (team === winner) status = 'moot'; // winner's protest can't flip the result
        else status = margin <= maxSwing(qbj, type) ? 'matters' : 'moot';
      }

      rows.push({
        round: String(qbj._round ?? ''),
        room: String(qbj._room ?? ''),
        live,
        type,
        question,
        part,
        team,
        reason,
        teams,
        status,
        ruling,
      });
    }
  }
  return rows.sort((a, b) => {
    const order = { pending: 0, matters: 1, upheld: 2, denied: 3, moot: 4 };
    const na = Number(a.round), nb = Number(b.round);
    const byRound = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.round.localeCompare(b.round);
    return (order[a.status] - order[b.status]) || byRound || a.question - b.question;
  });
}

export function computeStats(allMatches, structure) {
  // Half-played games (live syncs) get their own view; every regular report —
  // the YellowFruit-style set — sees only final games.
  const matches = [];
  const liveMatches = [];
  for (const m of allMatches) {
    const qbj = m?.qbj || m;
    if (qbj?._inProgress === true) liveMatches.push(m);
    else matches.push(m);
  }

  const global = aggregate(matches);
  const answerValues = [...global.answerValues].sort((a, b) => b - a);
  const positiveValues = [...global.answerValues].filter((v) => v > 0).sort((a, b) => a - b);
  const getValue = positiveValues.length ? positiveValues[0] : 10;
  const isPower = (v) => v > getValue;
  const allRounds = sortRoundLabels(global.rounds.keys());

  const phaseDefs = buildPhaseList(structure, allRounds);
  const roundToPhase = new Map();
  for (const ph of phaseDefs) for (const r of ph.roundSet) roundToPhase.set(r, ph);

  // Per-phase aggregation (records within the phase).
  const phases = phaseDefs.map((ph) => {
    const phaseMatches = matches.filter((m) => ph.roundSet.has(String((m?.qbj || m)._round ?? '')));
    const agg = aggregate(phaseMatches);
    const teamStats = [...agg.teams.values()];
    const players = [...agg.players.values()].filter((p) => p.tuh > 0);
    return {
      name: ph.name, color: ph.color,
      rounds: sortRoundLabels(ph.roundSet),
      groups: groupTeams(teamStats, ph.name, structure),
      players,
    };
  });

  // Round report rows (with stage/phase + color) and scoreboard grouping.
  const rounds = sortRoundLabels(global.rounds.keys()).map((r) => {
    const agg = global.rounds.get(r);
    const ph = roundToPhase.get(r);
    let powers = 0;
    for (const g of global.games) if (g.round === r) for (const t of g.teams) for (const p of t.players) for (const [v, c] of p.ac) if (isPower(v)) powers += c;
    return { ...agg, powers, phase: ph?.name || '', color: ph?.color || null };
  });

  // Scoreboard: phases → rounds → games.
  const gamesByRound = new Map();
  for (const g of global.games) { if (!gamesByRound.has(g.round)) gamesByRound.set(g.round, []); gamesByRound.get(g.round).push(g); }
  const scoreboard = phaseDefs.map((ph) => ({
    name: ph.name, color: ph.color,
    rounds: sortRoundLabels(ph.roundSet).filter((r) => gamesByRound.has(r)).map((r) => ({ round: r, games: gamesByRound.get(r) })),
  })).filter((ph) => ph.rounds.length > 0);

  const anyTies = [...global.teams.values()].some((t) => t.ties > 0);

  return {
    answerValues, getValue, isPower, anyTies,
    phases, rounds, scoreboard,
    liveGames: liveGameRows(liveMatches),
    teamsGlobal: [...global.teams.values()],
    playersGlobal: [...global.players.values()],
    roundToPhase: (r) => roundToPhase.get(String(r)),
  };
}
