// What a game's listing says about it beyond the teams and score: who played
// for each side, and how the tossups went (powers, gets, negs). Read off the
// match QBJ when there is one, or off MODAQ's own saved game for games filed
// before the archive kept QBJs. Names and numbers only: nothing here comes
// from the packet.

const arr = (v) => (Array.isArray(v) ? v : []);
const clip = (s) => String(s ?? '').slice(0, 60);

// A power is a tossup worth more than a plain get; a get is 10, or less if
// the game scored a smaller positive (a format with cheaper tossups).
function tallyValues(values) {
  let get = 10;
  for (const v of values) if (v > 0 && v < get) get = v;
  const t = { powers: 0, gets: 0, negs: 0 };
  for (const v of values) {
    if (v > get) t.powers++;
    else if (v > 0) t.gets++;
    else if (v < 0) t.negs++;
  }
  return t;
}

export function summarizeQbj(qbj) {
  if (!qbj || typeof qbj !== 'object') return null;
  const roster = arr(qbj.match_teams).slice(0, 12).map((mt) => ({
    team: clip(mt?.team?.name),
    players: arr(mt?.match_players).slice(0, 20).map((mp) => clip(mp?.player?.name)).filter(Boolean)
  }));
  const values = [];
  for (const q of arr(qbj.match_questions)) for (const b of arr(q?.buzzes)) values.push(Number(b?.result?.value) || 0);
  return { roster, tally: tallyValues(values) };
}

// MODAQ's saved game (mobx-sync's copy of its app state): game.players carry
// their team; each cycle holds the correct buzz, the wrong ones and the bonus.
export function summarizeModaq(json) {
  let state;
  try { state = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  const game = state?.game;
  if (!game || typeof game !== 'object') return null;
  const byTeam = new Map();
  for (const p of arr(game.players)) {
    const team = clip(p?.teamName);
    if (!team) continue;
    if (!byTeam.has(team)) byTeam.set(team, []);
    if (p?.name) byTeam.get(team).push(clip(p.name));
  }
  if (!byTeam.size) return null;
  const scores = new Map([...byTeam.keys()].map((t) => [t, 0]));
  const add = (team, pts) => { if (scores.has(team)) scores.set(team, scores.get(team) + pts); };
  const values = [];
  let heard = 0;
  for (const c of arr(game.cycles)) {
    const buzzes = [c?.correctBuzz, ...arr(c?.wrongBuzzes)].filter(Boolean);
    if (buzzes.length || c?.bonusAnswer) heard++;
    for (const b of buzzes) {
      const v = Number(b?.marker?.points) || 0;
      values.push(v);
      add(clip(b?.marker?.player?.teamName), v);
    }
    const bonus = c?.bonusAnswer;
    for (const part of arr(bonus?.parts)) add(clip(part?.teamName ?? bonus?.receivingTeamName), Number(part?.points) || 0);
  }
  const roster = [...byTeam].slice(0, 12).map(([team, players]) => ({ team, players: players.slice(0, 20) }));
  return {
    roster,
    tally: tallyValues(values),
    teams: roster.map((r) => r.team),
    scores: roster.map((r) => scores.get(r.team) || 0),
    heard
  };
}
