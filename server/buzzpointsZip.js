import { massingerPicksCsv } from './massingerRecord.js';

// --- A tournament's buzz points for quizbowlbuzzpoints.com ------------------
// The site is built by JemCasey's buzzpoint-migrator, which reads one `data/`
// folder: the question set (its packets, as JSON) and the tournament (its
// games, as MODAQ QBJ files), each with an index.json describing it.
//
//   data/question_sets/<set>/index.json
//   data/question_sets/<set>/editions/<date>/index.json
//   data/question_sets/<set>/editions/<date>/packet_files/Packet-01 - <round>.json
//   data/tournaments/<tournament>/index.json
//   data/tournaments/<tournament>/game_files/Round_1_<team>_<team>.qbj
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
// A team's name in a game's file name, as stock MODAQ writes it (spaces kept),
// less any `_`: the importer splits the name on them to find the round.
const teamPart = (text) => fileSafe(text, 40).replace(/_+/g, '-') || 'x';

/**
 * Every round's number: its place in the director's round order, which is
 * how a packet is assigned to Round N. Labels like "UW Fall 3" or "TB1"
 * aren't numbers, and the importer needs one. Map of round label -> number.
 */
export function roundNumbers(rounds) {
  return new Map(rounds.map((r, i) => [String(r.round), i + 1]));
}

/**
 * A game's file name the way stock MODAQ names it and the importer reads it:
 * Round_<N>_<team>_<team>, no extension. A "pace" tournament leads with the
 * number as well (see the importer's rules above).
 */
export function gameFileName(qbj, number, { pace = false } = {}) {
  const teams = (qbj?.match_teams || []).map((mt) => teamPart(mt?.team?.name)).join('_');
  return `${pace ? `${number}_` : ''}Round_${number}_${teams}`;
}

/**
 * A stored game as its own buzzpoints-ready QBJ: Klaxon's bookkeeping (the
 * `_` fields) left home and `packets` naming the packet it was read on.
 */
export function buzzpointsGame(game, packetName) {
  const qbj = {};
  for (const [key, value] of Object.entries(game || {})) {
    if (!key.startsWith('_')) qbj[key] = value;
  }
  if (packetName) qbj.packets = packetName;
  return qbj;
}

/**
 * The export's files, as [{ name, data }] for zip.buildZip.
 * `rounds` is the tournament's rounds in the director's order:
 * [{ round, tiebreaker, packet }] (packet = the stored packet JSON, or null).
 * `matches` are the stored games ({ qbj }), removed ones already left out.
 * Games still in progress, and rounds with no packet or no game, are left out.
 */
export function tournamentBuzzpointsExport(t, rounds, matches, { gamesOnly = false } = {}) {
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
  const picked = [];   // MASSINGER games, for the pick/ban CSV
  rounds.forEach((r, i) => {
    const number = i + 1;
    const roundGames = matches
      .map((m) => m.qbj)
      .filter((q) => q && String(q._round ?? '') === String(r.round) && q._inProgress !== true
        && Array.isArray(q.match_teams) && q.match_teams.length >= 2);
    if (roundGames.length === 0 || (!r.packet && !gamesOnly)) return;

    // Games only (for a set already on the site): `packets` is the round's own
    // name, which is the name of the packet file it was uploaded from.
    const packetName = gamesOnly ? String(r.round)
      : `Packet-${String(number).padStart(pad, '0')} - ${fileSafe(r.round) || 'Round'}`;
    if (!gamesOnly) {
      files.push({ name: `${edition}/packet_files/${packetName}.json`, data: JSON.stringify(r.packet, null, 2) });
      packets++;
    }
    // Only some teams play a tiebreaker, so it would skew players' per-game stats.
    if (r.tiebreaker) excluded.push(number);

    const used = new Set();
    for (const game of roundGames) {
      const qbj = buzzpointsGame(game, packetName);
      // The same two teams twice in a round (a replay): the room tells them apart.
      const base = gameFileName(game, number, { pace: paceName });
      let name = base;
      if (used.has(name)) name = `${base}_${underscored(game._room || 'Room')}`;
      for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
      used.add(name);
      if (qbj.massinger) picked.push({ round: r.round, number, file: `${name}.qbj`, qbj });
      files.push({ name: `${gamesOnly ? '' : `${tournament}/`}game_files/${name}.qbj`, data: JSON.stringify(qbj, null, 2) });
      games++;
    }
  });
  if (games === 0) return { files: [], games, packets };
  // Who banned and protected what, one row per pick (each game file also has
  // it as `massinger`). Beside data/, so the importer never reads it.
  const picks = massingerPicksCsv(picked);
  if (picks) files.push({ name: 'klaxon_massinger_picks.csv', data: picks });
  if (gamesOnly) return { files, games, packets };

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
