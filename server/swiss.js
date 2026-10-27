// ---------------------------------------------------------------------------
// Swiss pairing and the playoff bracket that follows it. Pure functions: the
// games come in as stored QBJ, the pairings go out as plain objects, and
// index.js does the reading, saving and publishing.
//
// Pairing rules (see the plan doc):
// - Rank: wins (a tie is half), then points per 20 tossups heard, then the
//   opponents' wins, then the roster seed.
// - Round 1: seeded, 1 v n/2+1 (or a repeatable shuffle).
// - Later rounds: neighbours in the ranking (1 v 2, 3 v 4), so teams with the
//   same record meet; no rematches and no same-school games while any other
//   pairing exists. Every rule is a cost and the cheapest pairing wins, so a
//   pairing always comes out; the notes say which rules had to bend.
// - Odd field: the lowest-ranked team with the fewest byes sits out. A bye
//   counts for nothing: not a win, not a game.
// - Playoffs: the top 4, 8 or 16 seeded 1 v 8, 4 v 5, 2 v 7, 3 v 6; winners
//   meet in bracket order, never re-seeded.
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// One stored game's result: each team's points, the tossups heard, the winner.
export function matchResult(qbj) {
  const mts = Array.isArray(qbj?.match_teams) ? qbj.match_teams : [];
  const names = mts.map((mt) => String(mt?.team?.name ?? ''));
  const points = names.map(() => 0);
  const ti = (name) => names.indexOf(String(name ?? ''));
  for (const q of Array.isArray(qbj?.match_questions) ? qbj.match_questions : []) {
    let winner = -1;
    for (const b of Array.isArray(q?.buzzes) ? q.buzzes : []) {
      const i = ti(b?.team?.name);
      const v = num(b?.result?.value);
      if (i >= 0) points[i] += v;
      if (v > 0 && i >= 0) winner = i;
    }
    const bonus = q?.replacement_bonus?.parts?.length ? q.replacement_bonus : q?.bonus;
    for (const p of Array.isArray(bonus?.parts) ? bonus.parts : []) {
      if (winner >= 0) points[winner] += num(p?.controlled_points);
      const other = names.length === 2 && winner >= 0 ? 1 - winner : -1;
      if (other >= 0) points[other] += num(p?.bounceback_points);
    }
  }
  const forfeit = mts.findIndex((mt) => mt?.forfeit_loss === true);
  let winner = null;
  if (names.length === 2) {
    if (forfeit >= 0) winner = names[1 - forfeit];
    else if (points[0] !== points[1]) winner = points[0] > points[1] ? names[0] : names[1];
  }
  return {
    round: String(qbj?._round ?? ''), room: String(qbj?._room ?? '').toUpperCase(),
    teams: names, points, tuh: num(qbj?.tossups_read), winner, forfeit: forfeit >= 0,
    final: qbj?._inProgress !== true,
  };
}

// Standings over the given rounds. teams: [{ name, seed, school }]; games:
// matchResult()s already limited to final games of those rounds; byes: { name: n }.
export function standings(teams, games, byes = {}) {
  const rows = new Map(teams.map((t) => [t.name, {
    name: t.name, seed: t.seed ?? 999, school: t.school || t.name,
    wins: 0, losses: 0, ties: 0, games: 0, points: 0, tuh: 0, opponents: [], byes: byes[t.name] || 0,
  }]));
  for (const g of games) {
    if (g.teams.length !== 2) continue;
    g.teams.forEach((name, i) => {
      const r = rows.get(name);
      if (!r) return;
      r.games++;
      r.points += g.points[i];
      r.tuh += g.tuh;
      r.opponents.push(g.teams[1 - i]);
      if (g.winner == null) r.ties++;
      else if (g.winner === name) r.wins++;
      else r.losses++;
    });
  }
  const score = (r) => r.wins + r.ties / 2;
  for (const r of rows.values()) {
    r.score = score(r);
    r.pp20 = r.tuh ? Math.round((r.points * 20 / r.tuh) * 100) / 100 : 0;
  }
  for (const r of rows.values()) {
    r.oppWins = r.opponents.reduce((s, o) => s + (rows.get(o)?.score || 0), 0);
  }
  return [...rows.values()];
}

export function rank(rows) {
  return [...rows].sort((a, b) => (b.score - a.score) || (b.pp20 - a.pp20) || (b.oppWins - a.oppWins)
    || (a.seed - b.seed) || a.name.localeCompare(b.name));
}

export const record = (r) => `${r.wins}–${r.losses}${r.ties ? `–${r.ties}` : ''}`;

// A repeatable shuffle (same input, same order), for a random round 1.
function shuffled(list, seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const rand = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const REMATCH = 1e6, SCHOOL = 1e4, GAP = 100;

/**
 * Pair one Swiss round.
 * ranked: standings rows in rank order (only teams still in the event).
 * played: Set of pairKey()s already played (or published) in earlier rounds.
 * options: { firstRound, round1: 'seeded'|'random', avoidSchool, seedText }.
 * → { pairs: [[a, b]], bye, notes: [] } with pairs top board first.
 */
export function pairRound(ranked, played, options = {}) {
  let pool = [...ranked];
  let bye = null;
  const notes = [];
  if (pool.length % 2 === 1) {
    // The lowest-ranked team among those with the fewest byes.
    const fewest = Math.min(...pool.map((r) => r.byes || 0));
    for (let i = pool.length - 1; i >= 0; i--) {
      if ((pool[i].byes || 0) === fewest) { bye = pool[i].name; pool.splice(i, 1); break; }
    }
  }
  if (options.firstRound) {
    const order = options.round1 === 'random'
      ? shuffled([...pool].sort((a, b) => a.seed - b.seed), options.seedText || 'r1')
      : [...pool].sort((a, b) => (a.seed - b.seed) || a.name.localeCompare(b.name));
    const half = order.length / 2;
    const pairs = [];
    for (let i = 0; i < half; i++) pairs.push([order[i].name, order[i + half].name]);
    return { pairs, bye, notes };
  }

  const n = pool.length;
  const avoidSchool = options.avoidSchool !== false;
  const cost = (i, j) => {
    const a = pool[i], b = pool[j];
    let c = Math.abs(j - i) - 1;
    if (played.has(pairKey(a.name, b.name))) c += REMATCH;
    if (avoidSchool && a.school && a.school === b.school) c += SCHOOL;
    const gap = a.score - b.score;
    c += gap * gap * GAP;
    return c;
  };
  // Branch and bound over the ranking: the top unpaired team takes each
  // possible opponent, cheapest first. The first answer found is the plain
  // neighbour pairing; the search then looks for a cheaper one (fewer
  // rematches, same-school games or record gaps) within a fixed budget.
  let best = Infinity, bestPairs = null, budget = 300000;
  const used = new Array(n).fill(false);
  const pairs = [];
  const dfs = (acc) => {
    if (budget-- <= 0 || acc >= best) return;
    let i = 0;
    while (i < n && used[i]) i++;
    if (i === n) { best = acc; bestPairs = pairs.slice(); return; }
    used[i] = true;
    const cands = [];
    for (let j = i + 1; j < n; j++) if (!used[j]) cands.push([cost(i, j), j]);
    cands.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [c, j] of cands) {
      if (acc + c >= best) break;
      used[j] = true; pairs.push([i, j]);
      dfs(acc + c);
      pairs.pop(); used[j] = false;
    }
    used[i] = false;
  };
  dfs(0);
  const out = (bestPairs || []).map(([i, j]) => [pool[i].name, pool[j].name]);
  for (const [i, j] of bestPairs || []) {
    const a = pool[i], b = pool[j];
    if (played.has(pairKey(a.name, b.name))) notes.push(`Rematch: ${a.name} and ${b.name} have played; no other pairing was left.`);
    if (avoidSchool && a.school === b.school) notes.push(`Same school: ${a.name} and ${b.name}.`);
    if (a.score !== b.score) notes.push(`${a.name} (${record(a)}) plays ${b.name} (${record(b)}) from the next record group.`);
  }
  return { pairs: out, bye, notes };
}

// How many Swiss rounds a field wants: enough to separate it, never so many
// that a rematch is forced.
export function suggestRounds(teams) {
  if (teams < 2) return 1;
  return Math.max(1, Math.min(teams - 1, Math.ceil(Math.log2(teams))));
}

// --- round-robin playoffs -----------------------------------------------------
// The usual quizbowl playoff: teams split into tiers by their Swiss standing
// (the top N, the next N, …), and each tier plays a round robin. A remainder
// too small for a tier of its own (under 3) joins the bottom tier. With
// carryover, Swiss games between tiermates count and aren't played again.

export function tiersOf(rankedNames, tierSize) {
  const tiers = [];
  for (let i = 0; i < rankedNames.length; i += tierSize) tiers.push(rankedNames.slice(i, i + tierSize));
  if (tiers.length > 1 && tiers.at(-1).length < 3) tiers.at(-2).push(...tiers.pop());
  return tiers.map((teams, i) => ({ name: `Tier ${i + 1}`, teams }));
}

// Every pairing of a tier, in circle-method order (each team once a round).
function circleRounds(teams) {
  const list = [...teams];
  if (list.length % 2) list.push(null);
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) games.push([a, b]);
    }
    rounds.push(games);
    list.splice(1, 0, list.pop());   // rotate all but the first
  }
  return rounds;
}

/**
 * The whole round-robin playoff, tier by tier, packed into as few rounds as
 * possible. played: Set of pairKey()s of Swiss games already final (used only
 * with carryover). → { tiers, rounds: [[{ tier, teams }]], carried: [{ tier, teams }] }
 */
export function planRoundRobin(rankedNames, tierSize, { carryover = false, played = new Set() } = {}) {
  const tiers = tiersOf(rankedNames, tierSize);
  const rounds = [];
  const carried = [];
  for (const tier of tiers) {
    for (const games of circleRounds(tier.teams)) {
      for (const teams of games) {
        if (carryover && played.has(pairKey(teams[0], teams[1]))) { carried.push({ tier: tier.name, teams }); continue; }
        // The earliest round, from this tier's circle position on, where both
        // teams are free (carried games leave gaps a later game can fill).
        let r = 0;
        while (rounds[r] && rounds[r].some((g) => g.teams.includes(teams[0]) || g.teams.includes(teams[1]))) r++;
        (rounds[r] ||= []).push({ tier: tier.name, teams });
      }
    }
  }
  return { tiers, rounds: rounds.filter((r) => r && r.length), carried };
}

// Whether the top tier needs a final, and of what kind (ACF): tied at the top
// → one game; the leader a game ahead → an advantaged final (the challenger
// has to win twice); two or more ahead → champion, no final. 'single' always
// plays one final between the top two.
export function finalDecision(rankedTopTier, kind) {
  if (!kind || kind === 'none' || rankedTopTier.length < 2) return { needed: false, champion: rankedTopTier[0]?.name || null };
  const [a, b] = rankedTopTier;
  if (kind === 'single') return { needed: true, teams: [a.name, b.name], advantaged: false };
  const lead = a.score - b.score;
  if (lead >= 2) return { needed: false, champion: a.name, lead };
  if (lead >= 1) return { needed: true, teams: [a.name, b.name], advantaged: true, leader: a.name, challenger: b.name };
  return { needed: true, teams: [a.name, b.name], advantaged: false };
}

// --- single-elimination playoffs ---------------------------------------------
export const BRACKETS = {
  2: [[1, 2]],
  4: [[1, 4], [2, 3]],
  8: [[1, 8], [4, 5], [2, 7], [3, 6]],
  16: [[1, 16], [8, 9], [4, 13], [5, 12], [2, 15], [7, 10], [3, 14], [6, 11]],
};
export const playoffRoundCount = (size) => (size >= 2 ? Math.round(Math.log2(size)) : 0);

// The bracket's next round. seeds: team names in seed order. prev: the
// previous playoff round's published games [{ teams: [a, b] }] with their
// results (winner or null). → { pairs, missing: [games without a result] }.
export function playoffPairs(seeds, size, prev, winnerOf) {
  if (!prev) {
    return { pairs: BRACKETS[size].map(([a, b]) => [seeds[a - 1], seeds[b - 1]]), missing: [] };
  }
  const winners = prev.map((g) => winnerOf(g.teams));
  const missing = prev.filter((_, i) => !winners[i]).map((g) => g.teams);
  const pairs = [];
  for (let i = 0; i + 1 < winners.length; i += 2) pairs.push([winners[i], winners[i + 1]]);
  return { pairs: missing.length ? [] : pairs, missing };
}
