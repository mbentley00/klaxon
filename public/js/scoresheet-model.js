// The Klaxon scoresheet's game: what the scorekeeper entered, and everything
// worked out from it (scores, player lines, the QBJ the stats are built from).
// Pure functions over a plain object, so the same code runs in the page and in
// tests, and the object can be stored on the server as it is (store.setSheet).
//
// A sheet:
// {
//   v: 1, round: '5', scheme: '15/10/-5', hasBonuses: true, regulation: 20,
//   bonusParts: 3, partValue: 10,
//   teams: [{ name, players: [name…], lineups: [{ from: 0, players: [name…] }] }],
//   cycles: [{ buzzes: [{ t: 0, p: 'Name', v: 15 }], bonus: 20 | null, parts: [true, true, false] }],
//   cur: { buzzes: [], phase: 'tossup' | 'bonus', parts: [false, false, false] },  // the tossup being scored
//   protests: [{ cycle: 3, type: 'tossup' | 'bonus', team: 'Name', part: 2, reason: '...' }],
//   editing: null | index,   // a past tossup being re-entered
//   checks: { '10': true },  // score checks both teams agreed to
//   final: false             // saved as the final result
// }
// Overtime tossups have no bonus, and one is played at a time while the score
// is tied after regulation.

export const SCHEMES = {
  '15/10/-5': { correct: [15, 10], neg: -5 },
  '20/15/10/-5': { correct: [20, 15, 10], neg: -5 },
  '20/10/0': { correct: [20, 10], neg: 0 },
  '10/-5': { correct: [10], neg: -5 },
};
export const scheme = (sheet) => SCHEMES[sheet.scheme] || SCHEMES['15/10/-5'];

export function newSheet({ round, scheme: sch = '15/10/-5', hasBonuses = true, regulation = 20, teams }) {
  return {
    v: 1,
    round: String(round ?? ''),
    scheme: SCHEMES[sch] ? sch : '15/10/-5',
    hasBonuses: hasBonuses !== false,
    regulation: Number(regulation) > 0 ? Number(regulation) : 20,
    bonusParts: 3,
    partValue: 10,
    teams: teams.map((t) => ({
      name: t.name,
      players: [...new Set([...(t.lineup || []), ...(t.players || [])])],
      lineups: [{ from: 0, players: [...(t.lineup || t.players || [])] }],
    })),
    cycles: [],
    cur: { buzzes: [], phase: 'tossup' },
    editing: null,
    checks: {},
    protests: [],
    final: false,
    startedAt: Date.now(),
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));

// The tossup being scored: the next one, or a past one being re-entered.
export const curIndex = (s) => (s.editing != null ? s.editing : s.cycles.length);
export const isOvertime = (s, i) => i >= s.regulation;
export const bonusFor = (s, i) => s.hasBonuses && !isOvertime(s, i);

export function winnerOf(cycle) {
  const right = (cycle?.buzzes || []).find((b) => b.v > 0);
  return right ? right.t : null;
}

export function lineupAt(team, i) {
  let cur = team.lineups[0]?.players || [];
  for (const l of team.lineups) if (l.from <= i) cur = l.players;
  return cur;
}

// Everything worked out from the entries.
export function tally(s) {
  const scores = s.teams.map(() => 0);
  const running = [];
  const players = s.teams.map((t) => Object.fromEntries(t.players.map((p) => [p, { tuh: 0, counts: {}, pts: 0 }])));
  const bonus = s.teams.map(() => ({ heard: 0, pts: 0 }));
  s.cycles.forEach((c, i) => {
    s.teams.forEach((team, t) => {
      for (const p of lineupAt(team, i)) if (players[t][p]) players[t][p].tuh++;
    });
    for (const b of c.buzzes) {
      scores[b.t] += b.v;
      const line = players[b.t][b.p] || (players[b.t][b.p] = { tuh: 0, counts: {}, pts: 0 });
      line.counts[b.v] = (line.counts[b.v] || 0) + 1;
      line.pts += b.v;
    }
    const w = winnerOf(c);
    if (w != null && c.bonus != null) {
      scores[w] += c.bonus;
      bonus[w].heard++;
      bonus[w].pts += c.bonus;
    }
    running.push([...scores]);
  });
  return { scores, running, players, bonus };
}

export function status(s) {
  const n = s.cycles.length;
  const { scores } = tally(s);
  const tied = scores.length === 2 && scores[0] === scores[1];
  const over = n >= s.regulation && !tied;
  return { n, scores, tied, over, overtime: n >= s.regulation && !over };
}

// Where the teams confirm the score: halfway, and two tossups from the end.
export const checkpoints = (s) => [Math.floor(s.regulation / 2), s.regulation - 2].filter((x) => x > 0);
export function pendingCheck(s) {
  const n = s.cycles.length;
  return s.editing == null && s.cur.buzzes.length === 0 && s.cur.phase === 'tossup'
    && checkpoints(s).includes(n) && !s.checks[n];
}

// A team that has buzzed on this tossup is done with it.
export const lockedTeams = (s) => new Set(s.cur.buzzes.map((b) => b.t));
// A neg is only possible while the other team still has a chance: once one
// team has negged, a wrong answer from the other costs nothing.
export const negAllowed = (s) => scheme(s).neg < 0 && !s.cur.buzzes.some((b) => b.v < 0);

function commit(s, row) {
  const out = clone(s);
  if (out.editing != null) out.cycles[out.editing] = row;
  else out.cycles.push(row);
  out.editing = null;
  out.cur = { buzzes: [], phase: 'tossup' };
  return out;
}

export function buzz(s, t, p, v) {
  if (lockedTeams(s).has(t) || s.cur.phase !== 'tossup') return s;
  if (v < 0 && !negAllowed(s)) return s;
  const buzzes = [...s.cur.buzzes, { t, p, v }];
  if (v > 0) {
    if (!bonusFor(s, curIndex(s))) return commit(s, { buzzes, bonus: null });
    const out = clone(s);
    out.cur = { buzzes, phase: 'bonus', parts: Array(s.bonusParts).fill(false) };
    return out;
  }
  // Every team has had its go: the tossup is dead.
  if (new Set(buzzes.map((b) => b.t)).size >= s.teams.length) return commit(s, { buzzes, bonus: null });
  const out = clone(s);
  out.cur = { buzzes, phase: 'tossup' };
  return out;
}

// A bonus as the parts the team got: [true, false, true], or a total, which
// is taken as the first parts in order.
export function partsOf(s, value) {
  if (Array.isArray(value)) return Array.from({ length: s.bonusParts }, (_, k) => !!value[k]);
  const got = Math.max(0, Math.min(s.bonusParts, Math.round(Number(value) / s.partValue) || 0));
  return Array.from({ length: s.bonusParts }, (_, k) => k < got);
}
export const partsTotal = (s, parts) => parts.filter(Boolean).length * s.partValue;
// A cycle's parts (a game scored before parts were kept has a total only).
export const cycleParts = (s, c) => (Array.isArray(c.parts) ? c.parts : c.bonus != null ? partsOf(s, c.bonus) : null);

// The bonus being entered: flip one part (0-based) between right and wrong.
export function togglePart(s, k) {
  if (s.cur.phase !== 'bonus' || k < 0 || k >= s.bonusParts) return s;
  const out = clone(s);
  const parts = out.cur.parts || Array(s.bonusParts).fill(false);
  parts[k] = !parts[k];
  out.cur.parts = parts;
  return out;
}

export function setBonus(s, value = s.cur.parts) {
  if (s.cur.phase !== 'bonus') return s;
  const parts = partsOf(s, value ?? []);
  return commit(s, { buzzes: s.cur.buzzes, bonus: partsTotal(s, parts), parts });
}

export const dead = (s) => (s.cur.phase === 'tossup' ? commit(s, { buzzes: s.cur.buzzes, bonus: null }) : s);

export function undo(s) {
  const out = clone(s);
  if (out.cur.phase === 'bonus') {
    out.cur = { buzzes: out.cur.buzzes.filter((b) => b.v <= 0), phase: 'tossup' };
    return out;
  }
  if (out.cur.buzzes.length) { out.cur.buzzes.pop(); return out; }
  if (out.editing != null) { out.editing = null; return out; }
  const last = out.cycles.pop();
  if (!last) return s;
  delete out.checks[out.cycles.length + 1];
  out.cur = { buzzes: last.buzzes.filter((b) => b.v <= 0), phase: 'tossup' };
  return out;
}

// Re-enter a past tossup from scratch (the old entry stays until the new one
// is complete; Undo leaves it as it was).
export function edit(s, i) {
  if (i < 0 || i >= s.cycles.length || s.cur.buzzes.length || s.cur.phase !== 'tossup') return s;
  const out = clone(s);
  out.editing = i;
  return out;
}

export function agree(s) {
  const out = clone(s);
  out.checks[out.cycles.length] = true;
  return out;
}

// A new lineup from the tossup being scored on. Players not on the team yet
// (a sub not on the roster) are added to it.
export function setLineup(s, t, players) {
  const out = clone(s);
  const team = out.teams[t];
  const from = out.cycles.length;
  for (const p of players) if (!team.players.includes(p)) team.players.push(p);
  team.lineups = team.lineups.filter((l) => l.from < from);
  const before = lineupAt({ lineups: team.lineups }, from);
  if (JSON.stringify(before) !== JSON.stringify(players) || team.lineups.length === 0) {
    team.lineups.push({ from, players: [...players] });
  }
  return out;
}

// The game as MODAQ would file it (see MODAQ's QBJ.toQBJ), so the stats, the
// players' scoresheet and the live board treat it the same.
export function toQBJ(s) {
  const n = s.cycles.length;
  const teams = s.teams.map((t) => ({ name: t.name, players: t.players.map((name) => ({ name })) }));
  const { players, bonus } = tally(s);
  const matchTeams = s.teams.map((t, ti) => ({
    team: teams[ti],
    bonus_points: bonus[ti].pts,
    lineups: t.lineups.map((l) => ({ first_question: l.from + 1, players: l.players.map((name) => ({ name })) })),
    match_players: t.players.map((name) => ({
      player: { name },
      tossups_heard: players[ti][name]?.tuh || 0,
      answer_counts: Object.entries(players[ti][name]?.counts || {})
        .map(([value, number]) => ({ answer: { value: Number(value) }, number }))
        .sort((a, b) => b.answer.value - a.answer.value),
    })),
  }));
  let bonusNumber = 1;
  const bonusNumbers = [];
  const parts = (c) => cycleParts(s, c).map((got) => ({ controlled_points: got ? s.partValue : 0 }));
  const matchQuestions = s.cycles.map((c, i) => {
    const q = {
      question_number: i + 1,
      tossup_question: { parts: 1, type: 'tossup', question_number: i + 1 },
      buzzes: c.buzzes.map((b) => ({
        buzz_position: { word_index: 0 },
        player: { name: b.p },
        team: teams[b.t],
        result: { value: b.v },
      })),
    };
    if (winnerOf(c) != null && c.bonus != null) {
      bonusNumbers[i] = bonusNumber;
      q.bonus = { question: { parts: s.bonusParts, type: 'bonus', question_number: bonusNumber++ }, parts: parts(c) };
    }
    return q;
  });
  const ot = Math.max(0, n - s.regulation);
  // Protests go in the notes in MODAQ's words: the director's console reads
  // them from there (stats.js protestRows), as it does a MODAQ game's.
  const notes = (s.protests || []).filter((p) => p.cycle <= n).map((p) => (p.type === 'bonus'
    ? `Bonus protest on bonus #${bonusNumbers[p.cycle - 1] ?? p.cycle}. Team "${p.team}" protested part ${p.part || 1} because of this reason: "${p.reason}".`
    : `Tossup protest on tossup #${p.cycle}. Team "${p.team}" protested because of this reason: "${p.reason}".`));
  return {
    tossups_read: n,
    overtime_tossups_read: ot > 0 ? ot : undefined,
    match_teams: matchTeams,
    match_questions: matchQuestions,
    notes: notes.length ? notes.join('\n') : undefined,
    _round: s.round,
    // No buzz positions: kept out of buzz-point exports (see buzzpointsZip.js).
    _scoresheet: true,
  };
}

// ---- changing a finished tossup by hand (a double-click in the grid) ----

// Set what one player scored on tossup i: a value, or null to clear it. One
// right answer per tossup: a new one takes over from the old (and the bonus
// starts over if it moves to the other team).
export function setCell(s, i, t, p, v) {
  if (i < 0 || i >= s.cycles.length) return s;
  const out = clone(s);
  const c = out.cycles[i];
  const before = winnerOf(c);
  let buzzes = c.buzzes.filter((b) => !(b.t === t && b.p === p));
  if (v != null && v !== 0) {
    if (v > 0) buzzes = buzzes.filter((b) => b.v <= 0);
    buzzes.push({ t, p, v });
  }
  buzzes.sort((a, b) => (a.v > 0) - (b.v > 0));
  c.buzzes = buzzes;
  const after = winnerOf(c);
  if (after == null) { c.bonus = null; delete c.parts; }
  else if (after !== before || c.bonus == null) {
    if (bonusFor(out, i)) { c.parts = Array(out.bonusParts).fill(false); c.bonus = 0; }
    else { c.bonus = null; delete c.parts; }
  }
  return out;
}

// Set tossup i's bonus: parts, or a total.
export function setBonusCell(s, i, value) {
  const c = s.cycles[i];
  if (!c || winnerOf(c) == null || !bonusFor(s, i)) return s;
  const out = clone(s);
  const parts = partsOf(out, value);
  out.cycles[i].parts = parts;
  out.cycles[i].bonus = partsTotal(out, parts);
  return out;
}

// ---- protests ----
// A team's protest on a tossup or a bonus part, as the scorekeeper writes it
// down. Resolving it is the director's (or the moderator's, by ACF rule).
export function addProtest(s, { cycle, type, team, part, reason }) {
  const c = Number(cycle);
  if (!Number.isInteger(c) || c < 1 || c > Math.max(1, s.cycles.length + 1)) return s;
  if (!s.teams.some((t) => t.name === team)) return s;
  const out = clone(s);
  out.protests = [...(out.protests || []), {
    cycle: c, type: type === 'bonus' ? 'bonus' : 'tossup', team,
    part: type === 'bonus' ? Math.max(1, Math.min(out.bonusParts, Number(part) || 1)) : undefined,
    reason: String(reason ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300) || 'No reason given',
    at: Date.now(),
  }];
  return out;
}
export function removeProtest(s, index) {
  const out = clone(s);
  out.protests = (out.protests || []).filter((_, k) => k !== index);
  return out;
}
// The protests as MODAQ reports them on each update: the players' scoresheet
// marks them, and a protest a player lodged is filed (protests.fileFromModaq).
export const gameProtests = (s) => (s.protests || []).map((p) => ({
  cycle: p.cycle, type: p.type, team: p.team, question: p.cycle, part: p.part, givenAnswer: '',
}));

export const fmt = (v) => (v < 0 ? `−${-v}` : String(v));
export const shortName = (n) => {
  const p = String(n).trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : String(n);
};
