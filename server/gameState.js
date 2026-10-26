// ---------------------------------------------------------------------------
// One game, everything about it, in one JSON document: the score, each team's
// and player's line, every tossup with its text, who buzzed where in it (buzz
// points), the bonus with its parts, and the room's own buzz log. Built from
// the stored game (the QBJ MODAQ or the scoresheet files, numbered by the full
// packet) joined with the round's packet. Contains the questions, so it is for
// the room's staff and the tournament's director only (see GET
// /api/rooms/:code/game in index.js).
// ---------------------------------------------------------------------------

// MODAQ counts a buzz's position in words of the question as written, split on
// whitespace (see buzzpoints.js); its markup is kept out of the plain text.
const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean);
const plain = (text) => String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// A bonus part as a packet stores it: MODAQ's parallel arrays, or {question, answer, value}.
function bonusParts(b) {
  if (!b) return [];
  if (Array.isArray(b.parts) && typeof b.parts[0] === 'object') {
    return b.parts.map((p) => ({ question: p?.question ?? p?.text ?? '', answer: p?.answer ?? '', value: num(p?.value) ?? 10 }));
  }
  const parts = Array.isArray(b.parts) ? b.parts : [];
  return parts.map((q, i) => ({ question: q ?? '', answer: b.answers?.[i] ?? '', value: num(b.values?.[i]) ?? 10 }));
}

// questions: 'live' (everything read so far), or 'after': the question the
// room is on now, and its bonus, are left out until the room has moved past it
// (for a key handed to a stream overlay or a public page).
export function buildGameState({ qbj, packet = null, buzzLog = [], room = {}, status = null, questions: mode = 'live' }) {
  const live = qbj._inProgress === true;
  const onNow = num(qbj._currentQuestion);
  const hidden = (n) => mode === 'after' && live && onNow != null && n >= onNow;
  const teams = (qbj.match_teams || []).map((mt) => mt?.team?.name ?? '?');
  const tIndex = (name) => teams.indexOf(name);
  const tally = teams.map(() => ({ tossup: 0, bonus: 0, heard: 0 }));
  const players = teams.map(() => new Map());
  const line = (ti, name) => {
    if (!players[ti].has(name)) players[ti].set(name, { name, tuh: 0, answers: {}, points: 0 });
    return players[ti].get(name);
  };
  (qbj.match_teams || []).forEach((mt, ti) => {
    for (const mp of mt.match_players || []) line(ti, mp?.player?.name ?? '?').tuh = num(mp?.tossups_heard) ?? 0;
  });

  const running = teams.map(() => 0);
  const questions = (qbj.match_questions || []).map((q, i) => {
    const tuNum = num(q?.replacement_tossup_question?.question_number ?? q?.tossup_question?.question_number);
    const tu = tuNum != null ? packet?.tossups?.[tuNum - 1] : null;
    const tuWords = tu ? words(tu.question) : null;
    const scoresheet = qbj._scoresheet === true;
    const buzzes = (q.buzzes || []).map((b) => {
      const ti = tIndex(b?.team?.name);
      const value = num(b?.result?.value) ?? 0;
      if (ti >= 0) {
        running[ti] += value;
        tally[ti].tossup += value;
        const l = line(ti, b?.player?.name ?? '?');
        l.answers[value] = (l.answers[value] || 0) + 1;
        l.points += value;
      }
      // A scoresheet game has no positions: say so rather than claim word 0.
      const at = scoresheet ? null : num(b?.buzz_position?.word_index);
      return {
        player: b?.player?.name ?? '', team: b?.team?.name ?? '', value,
        wordIndex: at,
        word: at != null && tuWords ? plain(tuWords[at] ?? '') || null : null,
        // How much of the question was left: 1 at the first word, 0 at the end.
        celerity: at != null && tuWords?.length ? Math.max(0, Math.round((1 - at / tuWords.length) * 1000) / 1000) : null,
      };
    });
    let bonus = null;
    const qb = q.replacement_bonus?.parts?.length ? q.replacement_bonus : q.bonus;
    if (qb) {
      const bNum = num(qb.question?.question_number);
      const pb = bNum != null ? packet?.bonuses?.[bNum - 1] : null;
      const text = bonusParts(pb);
      const winner = buzzes.find((b) => b.value > 0)?.team ?? null;
      const wi = tIndex(winner);
      let points = 0;
      const parts = (qb.parts || []).map((p, k) => {
        const got = num(p?.controlled_points) ?? 0;
        const bounce = num(p?.bounceback_points) ?? 0;
        points += got;
        if (bounce && wi >= 0) { const other = teams.findIndex((_, x) => x !== wi); if (other >= 0) { running[other] += bounce; tally[other].bonus += bounce; } }
        return { part: k + 1, points: got, bounceback: bounce || undefined, text: text[k] ? plain(text[k].question) : null,
          answer: text[k] ? plain(text[k].answer) : null, value: text[k]?.value ?? null };
      });
      if (wi >= 0) { running[wi] += points; tally[wi].bonus += points; tally[wi].heard++; }
      bonus = { number: bNum, team: winner, points, leadin: pb ? plain(pb.leadin) : null, parts };
    }
    if (hidden(i + 1)) {
      for (const b of buzzes) b.word = null;
      if (bonus) { bonus.leadin = null; for (const p of bonus.parts) { p.text = null; p.answer = null; } }
    }
    const show = !hidden(i + 1);
    return {
      number: i + 1,
      tossup: { number: tuNum, question: tu && show ? plain(tu.question) : null, answer: tu && show ? plain(tu.answer) : null,
        words: tuWords?.length ?? null, withheld: !show || undefined },
      buzzes,
      bonus,
      score: [...running],
    };
  });

  const scores = tally.map((t) => t.tossup + t.bonus);
  return {
    room: { code: room.code ?? null, name: room.name ?? null, tournament: room.tournamentCode ?? null },
    round: String(qbj._round ?? ''),
    source: qbj._scoresheet === true ? 'scoresheet' : 'modaq',
    inProgress: qbj._inProgress === true,
    currentQuestion: num(qbj._currentQuestion),
    regulation: num(qbj._regulationTossupCount) ?? 20,
    tossupsRead: num(qbj.tossups_read) ?? questions.length,
    overtimeTossupsRead: num(qbj.overtime_tossups_read) ?? 0,
    startedAt: num(qbj._startedAt),
    status,
    packet: packet ? { tossups: packet.tossups?.length ?? 0, bonuses: packet.bonuses?.length ?? 0 } : null,
    teams: teams.map((name, ti) => ({
      name,
      score: scores[ti],
      tossupPoints: tally[ti].tossup,
      bonusPoints: tally[ti].bonus,
      bonusesHeard: tally[ti].heard,
      ppb: tally[ti].heard ? Math.round((tally[ti].bonus / tally[ti].heard) * 100) / 100 : null,
      players: [...players[ti].values()],
    })),
    questions,
    // Every buzzer press the room saw in this round, including the ones that
    // lost the race (MODAQ only hears about the winner): when, in what order,
    // and how far behind the first.
    buzzLog: buzzLog.map((b) => ({
      at: b.at, player: b.name, team: b.team, question: b.question ?? null, accepted: !!b.accepted,
      order: b.order ?? null, msAfterFirst: b.msAfterFirst ?? null, reason: b.reason ?? null,
    })),
  };
}
