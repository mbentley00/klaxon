// ---------------------------------------------------------------------------
// YellowFruit import. A director who fixes games locally in YellowFruit can
// upload their .yft file (a QB-schema tournament JSON) and have those games
// override the matching synced MODAQ exports.
//
// The file is a tournament object: phases[] -> rounds[] -> matches[], where any
// object may be replaced by a { $ref: id } pointer to an object defined
// elsewhere in the file (teams live under registrations, answer types under
// scoring_rules). YellowFruit writes snake_case per the schema, but we accept
// its internal camelCase too, since its own parser does.
// ---------------------------------------------------------------------------

// Property access tolerant of either naming convention.
const p = (obj, snake, camel) => (obj?.[snake] !== undefined ? obj[snake] : obj?.[camel]);

// Build an id -> object index of everything in the file, so $refs resolve.
function indexIds(root) {
  const byId = new Map();
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (typeof o.id === 'string') byId.set(o.id, o);
      for (const v of Object.values(o)) walk(v);
    }
  })(root);
  return byId;
}

// Parse the uploaded YF tournament into [{ round, teamKey, match }] where
// `match` is a MODAQ-style QBJ our stats engine already understands.
export function parseYellowFruit(fileObj) {
  if (!fileObj || typeof fileObj !== 'object') throw new Error('bad_yf_file');
  const byId = indexIds(fileObj);
  const deref = (o) => (o && typeof o === 'object' && typeof o.$ref === 'string' ? (byId.get(o.$ref) ?? o) : o);

  const games = [];
  for (const phase0 of fileObj.phases || []) {
    const phase = deref(phase0);
    for (const round0 of phase?.rounds || []) {
      const round = deref(round0);
      const label = String(round?.number ?? round?.name ?? '');
      for (const m0 of round?.matches || []) {
        const m = deref(m0);
        const matchTeams0 = p(m, 'match_teams', 'matchTeams');
        if (!m || !Array.isArray(matchTeams0) || matchTeams0.length === 0) continue;

        let forfeit = false;
        const match_teams = matchTeams0.map((mt0) => {
          const mt = deref(mt0);
          if (p(mt, 'forfeit_loss', 'forfeitLoss') === true) forfeit = true;
          const team = deref(mt?.team);
          const match_players = (p(mt, 'match_players', 'matchPlayers') || []).map((mp0) => {
            const mp = deref(mp0);
            const player = deref(mp?.player);
            const answer_counts = (p(mp, 'answer_counts', 'answerCounts') || []).map((ac0) => {
              const ac = deref(ac0);
              const answerType = deref(p(ac, 'answer_type', 'answerType') ?? ac?.answer);
              return { number: Number(ac?.number) || 0, answer: { value: Number(answerType?.value) || 0 } };
            });
            return {
              player: { name: String(player?.name ?? '?') },
              tossups_heard: Number(p(mp, 'tossups_heard', 'tossupsHeard')) || 0,
              answer_counts,
            };
          });
          return {
            team: { name: String(team?.name ?? '?') },
            bonus_points: Number(p(mt, 'bonus_points', 'bonusPoints')) || 0,
            match_players,
          };
        });
        if (forfeit) continue; // forfeits carry no stats

        games.push({
          round: label,
          teamKey: match_teams.map((mt) => mt.team.name).sort().join(' | '),
          match: {
            tossups_read: Number(p(m, 'tossups_read', 'tossupsRead')) || 0,
            match_teams,
            match_questions: [],
            notes: typeof m.notes === 'string' ? m.notes : undefined,
          },
        });
      }
    }
  }
  return games;
}

const exportTeamKey = (qbj) =>
  (Array.isArray(qbj?.match_teams) ? qbj.match_teams : []).map((mt) => mt?.team?.name || '?').sort().join(' | ');

// Match the YF games against the existing synced exports: same round label and
// same pair of teams -> that game is overridden in place (keeping its room, so
// the file it came from is replaced). Games the server has never seen are added
// under a synthetic "YF" room.
export function planImport(yfGames, existingExports) {
  const plan = [];
  let newIndex = 1;
  for (const g of yfGames) {
    const hit = existingExports.find((e) =>
      String(e.qbj?._round ?? '') === g.round && exportTeamKey(e.qbj) === g.teamKey);
    if (hit) {
      // YF files usually carry no notes; don't let the override erase the
      // protest/notes record — or the director's protest rulings — that the
      // original synced game accumulated.
      const match = { ...g.match };
      if (match.notes === undefined && typeof hit.qbj?.notes === 'string') match.notes = hit.qbj.notes;
      if (hit.qbj?._protestRulings && typeof hit.qbj._protestRulings === 'object') {
        match._protestRulings = hit.qbj._protestRulings;
      }
      plan.push({ action: 'update', room: String(hit.qbj._room || 'YF'), round: g.round, match });
    } else {
      plan.push({ action: 'add', room: `YF${newIndex++}`, round: g.round, match: g.match });
    }
  }
  return plan;
}
