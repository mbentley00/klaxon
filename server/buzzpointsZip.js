// --- A tournament's buzz points for quizbowlbuzzpoints.com ------------------
// The site is built by JemCasey's buzzpoint-migrator, which reads one `data/`
// folder: the question set (its packets, as JSON) and the tournament (its
// games, as MODAQ QBJ files), each with an index.json describing it.
//
//   data/question_sets/<set>/index.json
//   data/question_sets/<set>/editions/<date>/index.json
//   data/question_sets/<set>/editions/<date>/packet_files/Packet-01 - <round>.json
//   data/tournaments/<tournament>/index.json
//   data/tournaments/<tournament>/game_files/Round_1_<room>_<team>_<team>.qbj
//
// The importer's rules, which every name here is shaped around:
// - a game's ROUND is the number after the first `_` of its file name (or
//   before it, if the tournament's name contains "pace");
// - a game's PACKET is its QBJ `packets` field, which must equal a packet's
//   file name without `.json` (both go through the same cleanup first);
// - the tournament finds its set and edition by their `name`s.
// Rounds are numbered by the director's round order, since a label like "TB1"
// isn't a number.

const SCHEME_FORMAT = { '15/10/-5': 'powers', '20/15/10/-5': 'superpowers', '20/10/0': 'pace', '10/-5': 'acf' };

// Safe as a file or folder name on every OS, and left alone by the importer's
// cleanup (it strips "copy", ".json" and "(N)", which would split a game from
// its packet if only one side lost them).
function fileSafe(text, max = 60) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\.json/gi, ' ')
    .replace(/copy/gi, 'Copy')
    .replace(/\((\d+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, max);
}

const underscored = (text) => fileSafe(text, 40).replace(/[\s_]+/g, '-') || 'x';

/**
 * The export's files, as [{ name, data }] for zip.buildZip.
 * `rounds` is the tournament's rounds in the director's order:
 * [{ round, tiebreaker, packet }] (packet = the stored packet JSON, or null).
 * `matches` are the stored games ({ qbj }), removed ones already left out.
 * Games still in progress, and rounds with no packet or no game, are left out.
 */
export function tournamentBuzzpointsExport(t, rounds, matches) {
  const setName = fileSafe(t.name, 80) || `Klaxon ${t.code}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : new Date(t.createdAt || Date.now()).toISOString().slice(0, 10);
  const tournamentName = `${setName} (Klaxon ${t.code})`;
  const paceName = tournamentName.toLowerCase().includes('pace');
  const set = `data/question_sets/${fileSafe(setName)}`;
  const edition = `${set}/editions/${date}`;
  const tournament = `data/tournaments/${fileSafe(tournamentName)}`;

  const files = [];
  const excluded = [];
  const pad = rounds.length >= 100 ? 3 : 2;
  let games = 0;
  let packets = 0;
  rounds.forEach((r, i) => {
    const number = i + 1;
    const roundGames = matches
      .map((m) => m.qbj)
      .filter((q) => q && String(q._round ?? '') === String(r.round) && q._inProgress !== true
        && Array.isArray(q.match_teams) && q.match_teams.length >= 2);
    if (!r.packet || roundGames.length === 0) return;

    const packetName = `Packet-${String(number).padStart(pad, '0')} - ${fileSafe(r.round) || 'Round'}`;
    files.push({ name: `${edition}/packet_files/${packetName}.json`, data: JSON.stringify(r.packet, null, 2) });
    packets++;
    // Only some teams play a tiebreaker, so it would skew players' per-game stats.
    if (r.tiebreaker) excluded.push(number);

    const used = new Set();
    for (const game of roundGames) {
      const qbj = {};
      for (const [key, value] of Object.entries(game)) {
        if (!key.startsWith('_')) qbj[key] = value;   // Klaxon's own bookkeeping stays home
      }
      qbj.packets = packetName;
      const teams = game.match_teams.map((mt) => underscored(mt?.team?.name)).join('_');
      const lead = paceName ? `${number}_Round_${number}` : `Round_${number}`;
      let name = `${lead}_${teams}`;
      for (let n = 1; used.has(name); n++) name = `${lead}_${teams}-${n}`;
      used.add(name);
      files.push({ name: `${tournament}/game_files/${name}.qbj`, data: JSON.stringify(qbj, null, 2) });
      games++;
    }
  });
  if (games === 0) return { files: [], games, packets };

  const hasBonuses = t.format?.hasBonuses !== false;
  files.unshift(
    { name: `${set}/index.json`, data: JSON.stringify({
      name: setName,
      difficulty: '',
      metadataStyle: 1,
      format: SCHEME_FORMAT[t.format?.tossupScheme] || 'powers',
      bonuses: hasBonuses
    }, null, 4) },
    { name: `${edition}/index.json`, data: JSON.stringify({ name: date, date }, null, 4) },
    { name: `${tournament}/index.json`, data: JSON.stringify({
      name: tournamentName,
      set: setName,
      edition: date,
      location: 'Online (Klaxon)',
      level: '',
      start_date: date,
      end_date: date,
      ...(excluded.length ? { rounds_to_exclude_from_individual_stats: excluded } : {})
    }, null, 4) }
  );
  return { files, games, packets };
}
