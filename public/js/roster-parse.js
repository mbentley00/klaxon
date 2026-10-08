// Rosters typed by people: a spreadsheet pasted in, the roster file the
// tournament already has, and the two files that come out of the editor (the
// roster Klaxon keeps, and one YellowFruit can import). No page code here, so
// it can be tested on its own.

const NAME_MAX = 60;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// One spreadsheet row per line, cells split by tabs -- what Google Sheets and
// Excel put on the clipboard. Without a tab anywhere it is read as CSV
// (quoted cells may hold commas), for a sheet saved out as a file.
export function splitCells(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const tabbed = lines.some((l) => l.includes('\t'));
  return lines.map((line) => (tabbed ? line.split('\t') : splitCsvLine(line)));
}

function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// What a header cell says the column holds.
const TEAM_HEADER = /^(team|team name|team names|name of team)$/i;
const TEAM_LIKE = /\bteam\b/i;
const SCHOOL_HEADER = /\b(school|institution|organization|organisation|club|university|college)\b/i;
const PLAYER_HEADER = /\b(player|member|competitor|roster|student)s?\b|^name$|^p\s?\d+$/i;
const NOT_A_NAME = /e-?mail|phone|contact|registered|paid|coach|division|notes?|year|grade|captain\?|pronoun|timestamp|fee/i;

// A cell that can't be somebody's name: an address, a yes/no, a number, a date.
function nameLike(cell) {
  const c = clean(cell);
  if (!c) return false;
  if (c.includes('@')) return false;
  if (/^(yes|no|y|n|true|false|x|tbd|n\/a|-+)$/i.test(c)) return false;
  if (/^[\d\s.,/:-]+$/.test(c)) return false;
  return true;
}

/**
 * Teams from pasted spreadsheet rows.
 *
 * With a header row ("Team Name", "Player 1", "Player 2", ...) the columns say
 * what they are, and the rest -- emails, "Registered?", notes -- are left out.
 * Without one, the first cell of a row is the team and the name-like cells
 * after it are its players. A row with no players is not a team ("Field Cap",
 * a blank line). A team with no name gets a placeholder from the row's number
 * ("Team 3"), flagged so the editor asks for a real one.
 *
 * Returns { teams: [{ name, players, placeholder }], skipped, header }.
 */
export function parseSpreadsheet(text) {
  const rows = splitCells(text).filter((r) => r.some((c) => clean(c)));
  if (!rows.length) return { teams: [], skipped: 0, header: false };

  const headerAt = rows.findIndex((r) => r.some((c) => TEAM_LIKE.test(c) || PLAYER_HEADER.test(clean(c))));
  let teamCol = -1;
  let playerCols = [];
  let numberCol = -1;
  let body = rows;
  const header = headerAt >= 0 && headerAt < 3;
  if (header) {
    const head = rows[headerAt].map(clean);
    teamCol = head.findIndex((h) => TEAM_HEADER.test(h));
    if (teamCol < 0) teamCol = head.findIndex((h) => TEAM_LIKE.test(h) && !PLAYER_HEADER.test(h) && !NOT_A_NAME.test(h));
    if (teamCol < 0) teamCol = head.findIndex((h) => SCHOOL_HEADER.test(h) && !NOT_A_NAME.test(h));
    playerCols = head
      .map((h, i) => (i !== teamCol && PLAYER_HEADER.test(h) && !NOT_A_NAME.test(h) && !TEAM_LIKE.test(h) ? i : -1))
      .filter((i) => i >= 0);
    // An unlabelled first column of 1, 2, 3 is the row number a sheet keeps.
    if (!clean(head[0]) && teamCol !== 0) numberCol = 0;
    body = rows.slice(headerAt + 1);
  }

  const teams = [];
  let skipped = 0;
  let unnamed = 0;
  for (const row of body) {
    let name;
    let players;
    if (header && playerCols.length) {
      name = teamCol >= 0 ? clean(row[teamCol]) : '';
      players = playerCols.map((i) => row[i]).filter(nameLike).map(clean);
    } else {
      // No header to go on: team first, then whoever follows.
      const cells = row.map(clean);
      const first = cells.findIndex((c) => c && !/^\d+$/.test(c));
      name = first >= 0 ? cells[first] : '';
      players = cells.slice(first + 1).filter(nameLike);
    }
    players = [...new Map(players.map((p) => [p.toLowerCase(), p])).values()];
    if (!players.length) { skipped++; continue; }
    let placeholder = false;
    if (!name) {
      unnamed++;
      const n = numberCol >= 0 ? clean(row[numberCol]) : '';
      name = `Team ${/^\d+$/.test(n) ? n : unnamed}`;
      placeholder = true;
    }
    teams.push({ name, players, placeholder });
  }
  return { teams, skipped, header };
}

/**
 * The teams in a stored roster (any of the layouts the server accepts: a
 * registrations array, a tournament with registrations, or a serialized
 * { version, objects } file). Order as stored.
 */
export function teamsFromRoster(text) {
  if (!text) return { name: '', teams: [] };
  let parsed;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { name: '', teams: [] }; }
  let registrations = null;
  let name = '';
  if (Array.isArray(parsed)) registrations = parsed;
  else if (Array.isArray(parsed?.registrations)) { registrations = parsed.registrations; name = clean(parsed.name); }
  else if (Array.isArray(parsed?.objects)) {
    const t = parsed.objects.find((o) => Array.isArray(o?.registrations));
    registrations = t?.registrations ?? parsed.objects.filter((o) => o?.type === 'Registration');
    name = clean(t?.name);
  }
  const teams = [];
  for (const reg of registrations || []) {
    for (const team of reg?.teams || []) {
      const tname = clean(team?.name);
      const players = (team?.players || []).map((p) => clean(typeof p === 'string' ? p : p?.name)).filter(Boolean);
      if (tname || players.length) teams.push({ name: tname, players, placeholder: false });
    }
  }
  return { name, teams };
}

/**
 * Merge pasted teams into the ones being edited: a team already there by name
 * takes the pasted players, a new one is added at the end.
 */
export function mergeTeams(existing, incoming) {
  const out = existing.map((t) => ({ ...t, players: [...t.players] }));
  for (const t of incoming) {
    const at = out.findIndex((o) => o.name.toLowerCase() === t.name.toLowerCase());
    if (at >= 0 && !t.placeholder) out[at] = { ...t, players: [...t.players] };
    else out.push({ ...t, players: [...t.players] });
  }
  return out;
}

// What stops the roster saving, and what is only worth a look.
export function checkTeams(teams) {
  const errors = [];
  const warnings = [];
  const seen = new Map();
  teams.forEach((t, i) => {
    const name = clean(t.name);
    if (!name) errors.push({ team: i, message: 'needs a name' });
    else if (seen.has(name.toLowerCase())) errors.push({ team: i, message: `has the same name as team ${seen.get(name.toLowerCase()) + 1}` });
    else seen.set(name.toLowerCase(), i);
    if (!t.players.some((p) => clean(p))) errors.push({ team: i, message: 'has no players' });
    if (t.placeholder) warnings.push({ team: i, message: 'was given a placeholder name' });
  });
  return { errors, warnings };
}

const tidy = (teams) => teams
  .map((t) => ({ name: clean(t.name), players: [...new Set(t.players.map(clean).filter(Boolean))] }))
  .filter((t) => t.name && t.players.length);

/** The roster Klaxon stores: a tournament object with one registration per team. */
export function toStoredRoster(tournamentName, teams) {
  return JSON.stringify({
    type: 'Tournament',
    name: clean(tournamentName),
    registrations: tidy(teams).map((t) => ({
      type: 'Registration',
      name: t.name,
      teams: [{ type: 'Team', name: t.name, players: t.players.map((p) => ({ type: 'Player', name: p })) }]
    }))
  }, null, 2);
}

/**
 * A file YellowFruit imports with File > QBJ Schema > "Import Teams and Rosters
 * Only": the tournament schema version it reads (2.1.1), a Tournament object
 * holding one Registration per team. YellowFruit itself files "Maggie Walker A"
 * and "Maggie Walker B" under one school, so nothing here guesses at schools.
 */
export function toYellowFruitQbj(tournamentName, teams) {
  const t = tidy(teams);
  return JSON.stringify({
    version: '2.1.1',
    objects: [{
      type: 'Tournament',
      name: clean(tournamentName) || 'Tournament',
      registrations: t.map((team, i) => ({
        type: 'Registration',
        id: `Registration_${i + 1}`,
        name: team.name,
        teams: [{
          type: 'Team',
          id: `Team_${i + 1}`,
          name: team.name,
          players: team.players.map((p, j) => ({ type: 'Player', id: `Player_${i + 1}_${j + 1}`, name: p }))
        }]
      }))
    }]
  }, null, 2);
}
