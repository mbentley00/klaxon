// ---------------------------------------------------------------------------
// Resolving a protest, per the ACF gameplay rules (section H).
//
// The director already had a place to record "upheld" or "denied" and type in
// a point adjustment by hand. Typing the adjustment is the part that goes
// wrong: undoing a cycle correctly means finding every buzz on it, the neg the
// protesting team took, the points the other team got for answering after
// them, and the bonus that followed — from a match record, after the round,
// under time pressure. That arithmetic is what this file does.
//
// What it deliberately does NOT do is decide the protest. H.11 gives the
// director ultimate authority, so the director chooses the resolution and can
// override the award; the engine works out its consequences.
//
// The rules it implements:
//
//   H.12     A denied protest changes nothing. "All original scoring on the
//            affected question(s) remains unchanged."
//
//   H.12.1   Resolution A — the answer given was correct and was wrongly
//            rejected. All score changes due to the affected tossup or bonus
//            part are undone and the team is given the points it should have
//            had. If a TOSSUP was affected, both teams are reseated and a
//            replacement bonus is read to that team, to complete a new cycle:
//            that is gameplay, and it cannot be settled on paper.
//
//   H.12.2   Resolution B — the question has no single correct answer. It is
//            thrown out, every score change from it undone, and a replacement
//            question of the same kind read to the same team or teams that
//            were eligible. Also gameplay.
//
//   H.10     A protest is resolved if and only if resolving it could change
//            the win-loss outcome; otherwise it is moot. (Computed already by
//            stats.protestRows, which this reports alongside.)
//
//   H.10.2   If the match was tied after regulation and upholding a regulation
//            protest unties it, the tiebreakers are undone FIRST. Flagged for
//            the director rather than done silently — see below.
// ---------------------------------------------------------------------------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const teamName = (v) => String(v ?? '').trim();

// What a director may decide. `gameplay` says whether the resolution can be
// settled on paper at all.
export const RESOLUTIONS = [
  {
    id: 'denied',
    rule: 'H.12',
    label: 'Denied — the original ruling stands',
    detail: 'Nothing changes. All original scoring on the affected question remains.'
  },
  {
    id: 'answer-accepted',
    rule: 'H.12.1',
    label: 'Upheld — the answer should have been accepted',
    detail: 'The cycle is undone and the points awarded. On a tossup this needs a replacement bonus read to that team.'
  },
  {
    id: 'thrown-out',
    rule: 'H.12.2',
    label: 'Upheld — the question has no single correct answer',
    detail: 'The question is thrown out and a replacement of the same kind is read to the teams that were eligible.'
  }
];
const RESOLUTION_IDS = new Set(RESOLUTIONS.map((r) => r.id));

// The cycle a protest is about. A protest names the PACKET position of the
// question; a thrown-out tossup shifts that, so the replacement is checked too.
function findCycle(qbj, { type, question }) {
  const questions = Array.isArray(qbj?.match_questions) ? qbj.match_questions : [];
  const n = num(question);
  for (const q of questions) {
    if (type === 'bonus') {
      if (num(q?.bonus?.question?.question_number) === n) return q;
    } else if (num(q?.tossup_question?.question_number) === n ||
      num(q?.replacement_tossup_question?.question_number) === n) {
      return q;
    }
  }
  return null;
}

// Every point the tossup part of a cycle moved, by team. This is the piece a
// director gets wrong by hand: it is not just the protesting team's neg, it is
// also whatever the other team scored answering after them.
function tossupSwing(cycle) {
  const swing = new Map();
  for (const b of Array.isArray(cycle?.buzzes) ? cycle.buzzes : []) {
    const name = teamName(b?.team?.name);
    if (!name) continue;
    swing.set(name, (swing.get(name) || 0) + num(b?.result?.value));
  }
  return swing;
}

// And the bonus that followed it: what the controlling team got, plus anything
// the other team took on a bounceback.
function bonusSwing(cycle) {
  const swing = new Map();
  const parts = Array.isArray(cycle?.bonus?.parts) ? cycle.bonus.parts : [];
  if (!parts.length) return swing;
  // Whoever answered the tossup controls the bonus.
  const winner = (Array.isArray(cycle.buzzes) ? cycle.buzzes : [])
    .find((b) => num(b?.result?.value) > 0);
  const controller = teamName(winner?.team?.name);
  let controlled = 0;
  let bounced = 0;
  for (const p of parts) {
    controlled += num(p?.controlled_points);
    bounced += num(p?.bounceback_points);
  }
  if (controller && controlled) swing.set(controller, controlled);
  if (bounced) {
    // The bounceback went to the other side; with exactly two teams that is
    // unambiguous, and a bonus does not bounce in any format that has more.
    const other = (Array.isArray(cycle.buzzes) ? cycle.buzzes : [])
      .map((b) => teamName(b?.team?.name))
      .find((t) => t && t !== controller);
    if (other) swing.set(other, (swing.get(other) || 0) + bounced);
  }
  return swing;
}

// One part of a bonus, for a protest about that part alone.
function bonusPartSwing(cycle, partIndex) {
  const swing = new Map();
  const part = (Array.isArray(cycle?.bonus?.parts) ? cycle.bonus.parts : [])[partIndex];
  if (!part) return swing;
  const winner = (Array.isArray(cycle.buzzes) ? cycle.buzzes : [])
    .find((b) => num(b?.result?.value) > 0);
  const controller = teamName(winner?.team?.name);
  if (controller && num(part.controlled_points)) swing.set(controller, num(part.controlled_points));
  return swing;
}

// The tossup values in play in this match, so a proposed award isn't invented.
// Read off what teams actually scored rather than assumed from a format.
export function tossupValues(qbj) {
  const values = new Set();
  for (const mt of Array.isArray(qbj?.match_teams) ? qbj.match_teams : []) {
    for (const mp of Array.isArray(mt?.match_players) ? mt.match_players : []) {
      for (const ac of Array.isArray(mp?.answer_counts) ? mp.answer_counts : []) {
        const v = num(ac?.answer?.value);
        if (v > 0) values.add(v);
      }
    }
  }
  if (!values.size) values.add(10);
  return [...values].sort((a, b) => a - b);
}

// Did this match go to tiebreakers? Only matters for H.10.2, and only as
// something to tell the director: undoing tiebreakers is a decision about the
// match, not arithmetic, and doing it silently would be worse than saying so.
function wentToTiebreakers(qbj) {
  const regulation = num(qbj?._regulationTossupCount) || 20;
  const played = (Array.isArray(qbj?.match_questions) ? qbj.match_questions : [])
    .filter((q) => (Array.isArray(q?.buzzes) ? q.buzzes : []).length > 0).length;
  return played > regulation;
}

/**
 * What follows from a director's decision.
 *
 * Returns the point adjustments to apply, what still has to be played, and a
 * plain reading of both so the director can see the arithmetic rather than
 * trust it. `award` overrides the proposed value of a correct answer — the
 * engine cannot tell a power from a get without the packet, so it proposes and
 * the director confirms.
 */
export function plan(qbj, protest, resolutionId, { award } = {}) {
  if (!RESOLUTION_IDS.has(resolutionId)) return { error: 'no_resolution' };
  const resolution = RESOLUTIONS.find((r) => r.id === resolutionId);
  const team = teamName(protest?.team);
  if (!team) return { error: 'no_team' };

  if (resolutionId === 'denied') {
    return {
      resolution,
      status: 'denied',
      adjustments: [],
      gameplay: [],
      explain: ['The original ruling stands; no score changes (H.12).'],
      warnings: []
    };
  }

  const cycle = findCycle(qbj, protest);
  if (!cycle) return { error: 'no_cycle' };

  const isBonus = protest?.type === 'bonus';
  const values = tossupValues(qbj);
  const explain = [];
  const warnings = [];
  const net = new Map();
  const add = (name, points, why) => {
    if (!name || !points) return;
    net.set(name, (net.get(name) || 0) + points);
    explain.push(`${points > 0 ? '+' : ''}${points} ${name} — ${why}`);
  };

  const gameplay = [];

  if (resolutionId === 'answer-accepted') {
    if (isBonus) {
      // A bonus part that should have been accepted: undo that part, award it.
      // Nothing to replay — the answer was simply right.
      const part = num(protest?.part);
      for (const [name, points] of bonusPartSwing(cycle, part - 1)) {
        add(name, -points, `undo part ${part} of bonus #${protest.question} (H.12.1)`);
      }
      const value = num(award) || 10;
      add(team, value, `part ${part} awarded to the protesting team (H.12.1)`);
    } else {
      // A tossup: the whole cycle comes apart, including whatever the other
      // team scored after the wrongly-rejected answer, and the bonus.
      for (const [name, points] of tossupSwing(cycle)) {
        add(name, -points, `undo the buzzes on tossup #${protest.question} (H.12.1)`);
      }
      for (const [name, points] of bonusSwing(cycle)) {
        add(name, -points, `undo the bonus that followed (H.12.1)`);
      }
      const value = num(award) || values[0];
      add(team, value, `tossup awarded to the protesting team (H.12.1)`);
      gameplay.push({
        kind: 'bonus',
        forTeams: [team],
        rule: 'H.12.1',
        why: `Both teams are reseated and a replacement bonus is read to ${team}, to complete a new cycle.`
      });
    }
  } else {
    // Thrown out (H.12.2): nothing about the question survives, and a
    // replacement of the same kind is read to whoever was eligible.
    if (isBonus) {
      for (const [name, points] of bonusSwing(cycle)) {
        add(name, -points, `throw out bonus #${protest.question} (H.12.2)`);
      }
      const controller = teamName((Array.isArray(cycle.buzzes) ? cycle.buzzes : [])
        .find((b) => num(b?.result?.value) > 0)?.team?.name) || team;
      gameplay.push({
        kind: 'bonus',
        forTeams: [controller],
        rule: 'H.12.2',
        why: `A replacement bonus is read to ${controller}, the team that was eligible for it.`
      });
    } else {
      for (const [name, points] of tossupSwing(cycle)) {
        add(name, -points, `throw out tossup #${protest.question} (H.12.2)`);
      }
      for (const [name, points] of bonusSwing(cycle)) {
        add(name, -points, `undo the bonus that followed (H.12.2)`);
      }
      // Everyone who had not already been locked out was eligible for it.
      const eligible = (Array.isArray(qbj.match_teams) ? qbj.match_teams : [])
        .map((mt) => teamName(mt?.team?.name)).filter(Boolean);
      gameplay.push({
        kind: 'tossup',
        forTeams: eligible,
        rule: 'H.12.2',
        why: `A replacement tossup is read to ${eligible.join(' and ')}.`
      });
      gameplay.push({
        kind: 'bonus',
        forTeams: [],
        rule: 'H.12.2',
        conditional: true,
        why: 'If the replacement tossup goes to the team that answered the original, the original bonus points '
          + 'stand and no bonus is read. Otherwise a replacement bonus is read to whoever wins it.'
      });
    }
  }

  if (wentToTiebreakers(qbj)) {
    warnings.push('This match went past regulation. If upholding this unties the game, H.10.2 says the '
      + 'tiebreaker questions and every score change from them are undone BEFORE this resolution is applied.');
  }

  return {
    resolution,
    status: 'upheld',
    adjustments: [...net].map(([t, points]) => ({ team: t, points })).filter((a) => a.points !== 0),
    gameplay,
    explain,
    warnings,
    // What the director may choose the award to be, when there is a choice.
    awardOptions: isBonus ? [10] : values
  };
}
