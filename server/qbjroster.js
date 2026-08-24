// Parse a QBJ registration file (the "roster file" tournaments hand out) into
// the compact shape the room's buzzer roster uses:
//
//   { name, teams: [{ name, players: ['Andrew Gao', ...] }] }
//
// Accepts the same three layouts MODAQ's QBJ.parseRegistration does, since
// directors paste in whatever their registration tool exported:
//   * a bare array of registrations
//   * a tournament object with a `registrations` field
//   * a serialized tournament: { version, objects: [ ...a tournament... ] }
//
// Unlike MODAQ's parser we're deliberately forgiving about individual entries —
// a team with no players is skipped rather than failing the whole file — because
// a roster that's 95% usable should still let a reader label buzzers.

const MAX_TEAMS = 500;
const MAX_PLAYERS_PER_TEAM = 40;
const NAME_MAX = 60;

const clean = (v) => String(v ?? '').trim().slice(0, NAME_MAX);

function registrationsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.registrations)) return parsed.registrations;
  if (Array.isArray(parsed?.objects)) {
    const tournament = parsed.objects.find((o) => Array.isArray(o?.registrations));
    if (tournament) return tournament.registrations;
  }
  return null;
}

function tournamentNameOf(parsed) {
  if (Array.isArray(parsed)) return '';
  if (Array.isArray(parsed?.registrations)) return clean(parsed.name);
  const tournament = Array.isArray(parsed?.objects)
    ? parsed.objects.find((o) => Array.isArray(o?.registrations))
    : null;
  return clean(tournament?.name);
}

// Throws Error('bad_json' | 'no_registrations' | 'no_teams'); otherwise returns
// { name, teams }. `input` is the file text or an already-parsed object.
export function parseQbjRoster(input) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); }
    catch { throw new Error('bad_json'); }
  }
  const registrations = registrationsOf(parsed);
  if (!registrations) throw new Error('no_registrations');

  const teams = [];
  const seen = new Set();
  for (const reg of registrations) {
    for (const team of Array.isArray(reg?.teams) ? reg.teams : []) {
      const name = clean(team?.name);
      // A registration whose teams are unnamed, empty or duplicated tells us
      // nothing about who is sitting at a buzzer — skip it.
      if (!name || seen.has(name.toLowerCase())) continue;
      const players = [];
      const seenPlayers = new Set();
      for (const player of Array.isArray(team?.players) ? team.players : []) {
        const pname = clean(typeof player === 'string' ? player : player?.name);
        if (!pname || seenPlayers.has(pname.toLowerCase())) continue;
        seenPlayers.add(pname.toLowerCase());
        players.push(pname);
        if (players.length >= MAX_PLAYERS_PER_TEAM) break;
      }
      if (!players.length) continue;
      seen.add(name.toLowerCase());
      teams.push({ name, players });
      if (teams.length >= MAX_TEAMS) break;
    }
    if (teams.length >= MAX_TEAMS) break;
  }
  if (!teams.length) throw new Error('no_teams');

  teams.sort((a, b) => a.name.localeCompare(b.name));
  return { name: tournamentNameOf(parsed), teams };
}
