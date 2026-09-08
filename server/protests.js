// ---------------------------------------------------------------------------
// Protests lodged by the teams in a MODAQ room.
//
// MODAQ already lets a MODERATOR record a protest while scoring, and the
// director already rules on those from the console. What was missing is the
// half the ACF rules actually describe: the teams themselves raising one, and
// saying why.
//
// The rules this follows (ACF gameplay rules, section H):
//   H.2   A player may indicate interest in protesting at any pause, "quickly
//         and unobtrusively", and the moderator notes it. That is `lodged` —
//         a flag, not yet an argument.
//   H.3   Formally lodging the substance happens at halftime or at the end of
//         regulation (immediately, for a tiebreaker). That is `open`: the
//         moderator opens the protest and the teams write their statements.
//   H.5.f The OPPOSING team may protest that the other team was wrongly given
//         points — so a protest is not always raised by the team that lost out,
//         and both teams have something to say about any of them. Which side a
//         statement argues is therefore decided by who is writing it against
//         who lodged it, never by asking them.
//   H.5   Only certain errors are protestable at all; the reasons offered here
//         are those, so a team picks one rather than inventing a category.
//
// A question can carry several protests at once — each team may protest the
// same tossup for different reasons, and H.5.f protests routinely coexist with
// H.5.a ones — so protests are a list keyed by nothing but their own id, and
// every one of them collects its own for-and-against statements.
// ---------------------------------------------------------------------------

// The protestable errors, ACF H.5. A team picks one; "other" is not offered,
// because H.6 is explicit that everything else (a judgment call, timing, an
// accidental-buzz ruling, what the moderator heard) is not protestable.
export const PROTEST_REASONS = [
  { id: 'rejected', rule: 'H.5.a', label: 'A correct answer was rejected' },
  { id: 'ambiguous', rule: 'H.5.b', label: 'The question is ambiguous — our answer is also correct' },
  { id: 'too-specific', rule: 'H.5.c', label: 'The listed answer is too specific for the clues' },
  { id: 'no-answer', rule: 'H.5.d', label: 'The question has no single correct answer' },
  { id: 'prompt', rule: 'H.5.e', label: 'We should have been prompted' },
  { id: 'opponent', rule: 'H.5.f', label: 'The other team was given points for an incorrect answer' }
];
const REASON_IDS = new Set(PROTEST_REASONS.map((r) => r.id));

// 'lodged'  the moderator has been told a protest is coming (H.2)
// 'open'    the moderator is taking it; both teams may write (H.3)
// 'filed'   the moderator has entered it in MODAQ and confirmed it
// 'dismissed' withdrawn by the team, or dropped by the moderator
export const PROTEST_STATUSES = ['lodged', 'open', 'filed', 'dismissed'];

const MAX_PROTESTS = 40;              // per room, across the whole game
const MAX_STATEMENTS = 12;            // per protest — a squad plus its coach
const MAX_TEXT = 1500;
const LODGE_COOLDOWN_MS = 20 * 1000;  // per player, so the button can't be spammed

const text = (v, cap = MAX_TEXT) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
const newId = () => 'p' + Math.random().toString(36).slice(2, 9);

// Which side of a protest a person is on. Decided here rather than asked,
// because it is not a matter of opinion: you argue for the protest your team
// lodged and against the one lodged by the team across the table (H.5.f makes
// that second case a real one). Anyone on neither team has no standing.
export function sideFor(protest, team) {
  const mine = String(team ?? '').trim();
  if (!mine) return null;
  if (mine === protest.byTeam) return 'for';
  return protest.againstTeam && mine === protest.againstTeam ? 'against' : null;
}

/**
 * A team indicates it wants to protest (H.2). Cheap and immediate on purpose:
 * the rules have a player say the word at a pause and the moderator note it,
 * not stop the match to take an argument.
 *
 * `againstTeam` is the other team in the room, so the opposing side has
 * standing to answer. Both come from the buzzer's vouched-for team, never from
 * anything the protesting player typed.
 */
export function lodge(room, actor, { cycle, round, reason, teams }) {
  if (!room.protests) room.protests = [];
  if (!room.protestCooldown) room.protestCooldown = new Map();
  const byTeam = String(actor.team ?? '').trim();
  if (!byTeam) return { error: 'no_team' };
  if (room.protests.length >= MAX_PROTESTS) return { error: 'too_many' };

  const now = Date.now();
  if (now - (room.protestCooldown.get(actor.id) || 0) < LODGE_COOLDOWN_MS) return { error: 'cooldown' };

  const cycleNo = Number(cycle);
  if (!Number.isFinite(cycleNo) || cycleNo < 1) return { error: 'no_question' };

  // One live protest per team per question per reason. A second player on the
  // same team pressing the same button is joining the protest their team
  // already has, not opening a rival one.
  const reasonId = REASON_IDS.has(reason) ? reason : null;
  const existing = room.protests.find((p) => p.cycle === cycleNo && p.byTeam === byTeam &&
    p.reason === reasonId && p.status !== 'dismissed');
  if (existing) return { ok: true, protest: existing, existed: true };

  const other = (Array.isArray(teams) ? teams : []).map((t) => String(t ?? '').trim())
    .filter((t) => t && t !== byTeam);
  const protest = {
    id: newId(),
    cycle: cycleNo,
    round: round == null ? null : String(round).slice(0, 40),
    at: now,
    byTeam,
    againstTeam: other[0] || null,
    byPlayerId: actor.id,
    byName: actor.name,
    reason: reasonId,
    status: 'lodged',
    questionShown: false,
    questionText: null,
    statements: []
  };
  room.protestCooldown.set(actor.id, now);
  room.protests.push(protest);
  return { ok: true, protest };
}

export const find = (room, id) => (room.protests || []).find((p) => p.id === id) || null;

// The moderator starts taking this protest (H.3). Until now it was only a
// note; from here both teams may write.
export function open(room, id) {
  const p = find(room, id);
  if (!p) return { error: 'no_protest' };
  if (p.status === 'dismissed') return { error: 'dismissed' };
  p.status = 'open';
  return { ok: true, protest: p };
}

// A player's reasoning. Which way it argues is worked out from who they are
// (see sideFor); they are only ever asked for the argument itself. One
// statement per person, rewritable until the protest is filed.
export function addStatement(room, id, actor, body) {
  const p = find(room, id);
  if (!p) return { error: 'no_protest' };
  if (p.status !== 'open') return { error: 'not_open' };
  const side = sideFor(p, actor.team);
  if (!side) return { error: 'not_involved' };
  const said = text(body);
  if (!said) return { error: 'empty' };

  const existing = p.statements.find((s) => s.playerId === actor.id);
  if (existing) {
    existing.text = said;
    existing.at = Date.now();
    existing.side = side;
    return { ok: true, protest: p, statement: existing };
  }
  if (p.statements.length >= MAX_STATEMENTS) return { error: 'too_many' };
  const statement = {
    playerId: actor.id,
    name: actor.name,
    team: actor.team || null,
    side,
    text: said,
    at: Date.now()
  };
  p.statements.push(statement);
  return { ok: true, protest: p, statement };
}

// The moderator has entered the protest in MODAQ and confirms it is filed.
// Statements close at this point: what the director rules on is what the teams
// said at the table, not an argument that kept growing afterwards.
export function file(room, id) {
  const p = find(room, id);
  if (!p) return { error: 'no_protest' };
  p.status = 'filed';
  return { ok: true, protest: p };
}

export function dismiss(room, id) {
  const p = find(room, id);
  if (!p) return { error: 'no_protest' };
  p.status = 'dismissed';
  return { ok: true, protest: p };
}

// Show the room the question that was protested. Only once the protest is
// filed: the text is a live packet question until the moderator says the
// protest is going in the book, and a room that has seen it cannot unsee it.
// The text comes from the moderator's MODAQ, which is the only side that has
// the packet.
export function showQuestion(room, id, questionText) {
  const p = find(room, id);
  if (!p) return { error: 'no_protest' };
  if (p.status !== 'filed') return { error: 'not_filed' };
  p.questionShown = true;
  p.questionText = text(questionText, 8000) || null;
  return { ok: true, protest: p };
}

/**
 * The protest board, as everyone in the room may see it.
 *
 * The same for all viewers on purpose. Under H.3 the arguments are made in
 * front of the room — a team that cannot see what was said against it cannot
 * answer it — and which side a given viewer is on is a thing their own page
 * works out from their team, not something the server has to fan out per
 * socket. Only the protested question text is conditional, and that is a
 * property of the protest (whether the moderator revealed it), not of who is
 * looking.
 */
export function publicProtests(room) {
  return (room.protests || []).filter((p) => p.status !== 'dismissed').map((p) => {
    const reason = PROTEST_REASONS.find((r) => r.id === p.reason);
    return {
      id: p.id,
      cycle: p.cycle,
      round: p.round,
      at: p.at,
      byTeam: p.byTeam,
      againstTeam: p.againstTeam,
      byName: p.byName,
      reason: p.reason,
      reasonLabel: reason?.label || null,
      rule: reason?.rule || null,
      status: p.status,
      questionShown: p.questionShown === true,
      questionText: p.questionShown ? p.questionText : null,
      statements: p.statements.map((st) => ({
        playerId: st.playerId, name: st.name, team: st.team, side: st.side, text: st.text, at: st.at
      }))
    };
  });
}
