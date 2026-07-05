// ---------------------------------------------------------------------------
// YellowFruit-style HTML stat report generator. Renders the stats from
// stats.js into the same report set YellowFruit produces (Standings,
// Individuals, Scoreboard, Team Detail, Player Detail, Round Report), matching
// its layout, columns, tooltips, styling, and inter-page links.
//
// Klaxon has no phase/division structure, so all games are shown as one phase.
// ---------------------------------------------------------------------------

const PAGES = [
  { key: 'standings', label: 'Standings' },
  { key: 'individuals', label: 'Individuals' },
  { key: 'games', label: 'Scoreboard' },
  { key: 'teamdetail', label: 'Team Detail' },
  { key: 'playerdetail', label: 'Player Detail' },
  { key: 'rounds', label: 'Round Report' },
];

// YellowFruit's exact stylesheet (from its generated reports).
const STYLE = `<style>
HTML{
font-family: Roboto, sans-serif;
}
table{
font-size: 11pt;
border-spacing: 0;
border-collapse: collapse;
}
td{
padding: 5px;
}
tr:nth-child(even){
background-color: #f2f2f2;
}
.headerAndDivider{
display: flex;
flex-direction: row;
margin: 18px 0;
}
.scoreboardRoundHeader{
width: 71%;
position: sticky;
top: 0;
background-color: white;
padding-bottom: 10px;
margin-bottom: -10px;
}
.boxScoreAnchor{
padding-top: 30px;
}
.boxScoreTitle{
width: 71%;
}
.inlineDivider{
flex-grow: 1;
height: 1px;
background-color: #9f9f9f;
align-self: center;
}
ul{
margin: 0;
}
.smallText{
font-size: 10pt;
}
.headerAndDivider h2{
margin: 0;
}
.boxScoreTable{
display: flex;
gap: 15px;
align-items: flex-start;
}
.pseudoTFoot{
border-top: 1px solid #909090;
background-color: #ffffff !important;
}
.floatingTOC{
top: 150px;
right: 35px;
position: fixed;
padding-right: 5px;
background-color: #cccccc;
box-shadow: 4px 4px 7px #999999;
line-height: 1.5;
z-index: 99;
}
.floatingTOC ul{
list-style-type: none;
padding-inline-start: 20px;
}
@media screen and (min-width: 800px) {
.fwBelow800px{
width: 60%;
}
}
@media screen and (min-width: 1000px) {
.fwBelow1000px{
width: 80%;
}
}
</style>`;

const FOOTER = `<div class="html-rpt-hide-in-yft-app" style="font-size:x-small; margin-top: 10px">Made with <a HREF=https://github.com/ANadig/YellowFruit/releases target="_blank">YellowFruit</a> 4.0.18&nbsp;&#x1F34C;</div>`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const anchor = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');
const teamAnchor = (team) => anchor(team);
const playerAnchor = (team, name) => `${anchor(team)}-${anchor(name)}`;
const truncTeam = (name, n = 35) => (name.length > n ? name.slice(0, n) + '...' : name);

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '0.0');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '0.00');
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '0.000');
const pct = (v) => `${Math.round((Number.isFinite(v) ? v : 0) * 100)}%`;

const th = (label, { align, width, abbr } = {}) => {
  const a = align ? ' align="right"' : '';
  const w = width ? ` width="${width}"` : '';
  const inner = abbr ? `<abbr title="${esc(abbr)}">\n${label}\n</abbr>` : label;
  return `<td${a}${w}><b>\n${inner}\n</b></td>`;
};
const td = (content, { align, width } = {}) => {
  const a = align ? ' align="right"' : '';
  const w = width ? ` width="${width}"` : '';
  return `<td${a}${w}>${content}</td>`;
};

// `link(page, anchor)` differs between the served pages (route paths) and the
// downloadable zip (YellowFruit-style filenames); the caller supplies it.
function navBar(link, title) {
  const cells = PAGES.map((p) => `<td    ><a HREF=${link(p.key)}>${p.label}</a></td>`).join('\n');
  return `<table border=0  width=100%>
<tr>
${cells}
</tr>
</table>
<h1 id=#top>
${title}
</h1>`;
}

function pageShell(title, link, body) {
  return `<HTML>
<HEAD>
<title>
${title}
</title>
</HEAD>
<BODY>
${navBar(link, title)}
${STYLE}
<div style="font-size: 11pt; text-size-adjust: none;">
${body}
${FOOTER}
</div>
</BODY>
</HTML>`;
}

function sectionHeader(text) {
  return `<div class="headerAndDivider">
<h2>
${esc(text)}&nbsp;
</h2>
<div class="inlineDivider">

</div>
</div>`;
}

// Assign ranks with "=" for ties, given rows pre-sorted by `keyOf` (descending).
function withRanks(rows, keyOf) {
  const ranks = [];
  let lastKey = null;
  let lastRank = 0;
  rows.forEach((row, i) => {
    const key = keyOf(row);
    let rank;
    if (i > 0 && key === lastKey) rank = lastRank;
    else { rank = i + 1; lastRank = rank; lastKey = key; }
    ranks.push(rank);
  });
  // Mark ties (a rank shared by >1 row) with a trailing "=".
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  return ranks.map((r) => (counts.get(r) > 1 ? `${r}=` : `${r}`));
}

const pp20 = (points, tuh) => (tuh > 0 ? (points / tuh) * 20 : 0);
const ppb = (bonusPoints, bonuses) => (bonuses > 0 ? bonusPoints / bonuses : 0);
const winPct = (t) => {
  const g = t.wins + t.losses + t.ties;
  return g > 0 ? (t.wins + 0.5 * t.ties) / g : 0;
};

// --- Standings -------------------------------------------------------------
function standingsTable(teams, stats, link) {
  const valueCols = stats.answerValues;
  const sorted = [...teams].sort((a, b) => winPct(b) - winPct(a) || pp20(b.totalPoints, b.tuh) - pp20(a.totalPoints, a.tuh));
  const ranks = withRanks(sorted, (t) => `${winPct(t).toFixed(6)}`);
  const header = `<tr>
${th('Rank', { width: '3%' })}
${th('Team', { width: '25%' })}
${th('W', { align: true, width: '4%' })}
${th('L', { align: true, width: '3%' })}
${stats.anyTies ? th('T', { align: true, width: '3%' }) : ''}
${th('Pct', { align: true, width: '7%', abbr: 'Win percentage' })}
${th('PP20TUH', { align: true, width: '8%', abbr: 'Points scored in regulation per 20 regulation tossups heard' })}
${valueCols.map((v) => th(String(v), { align: true, width: '5%' })).join('\n')}
${th('TUH', { align: true, width: '6%', abbr: 'Tossups heard in regulation' })}
${th('PPB', { align: true, width: '7%', abbr: 'Points per bonus' })}
</tr>`;
  const rows = sorted.map((t, i) => `<tr>
${td(ranks[i])}
${td(`<a HREF=${link('teamdetail', teamAnchor(t.name))}>${esc(t.name)}</a>`)}
${td(String(t.wins), { align: true })}
${td(String(t.losses), { align: true })}
${stats.anyTies ? td(String(t.ties), { align: true }) : ''}
${td(f3(winPct(t)), { align: true })}
${td(f1(pp20(t.totalPoints, t.tuh)), { align: true })}
${valueCols.map((v) => td(String(t.ac.get(v) || 0), { align: true })).join('\n')}
${td(String(t.tuh), { align: true })}
${td(f2(ppb(t.bonusPoints, t.bonusesHeard)), { align: true })}
</tr>`).join('\n');
  return `<table  class=fwBelow1000px >
${header}
${rows}
</table>`;
}

export function renderStandings(stats, link) {
  const body = stats.phases.map((phase) => {
    const groups = phase.groups.map((g) => {
      const divHeader = g.division ? `<h3>\n${esc(g.division)}\n</h3>` : '';
      return `${divHeader}
${standingsTable(g.teams, stats, link)}`;
    }).join('\n');
    return `${sectionHeader(phase.name)}
${groups}`;
  }).join('\n');
  return pageShell('Standings', link, body);
}

// --- Individuals -----------------------------------------------------------
export function renderIndividuals(stats, link) {
  const valueCols = stats.answerValues;
  const header = `<tr>
${th('Rank')}
${th('Player')}
${th('Team')}
${th('GP', { align: true, abbr: 'Games played' })}
${valueCols.map((v) => th(String(v), { align: true, width: '5%' })).join('\n')}
${th('TUH', { align: true, abbr: 'Tossups heard' })}
${th('PP20TUH', { align: true, abbr: 'Points per 20 tossups heard' })}
</tr>`;
  const body = stats.phases.map((phase) => {
    const players = [...phase.players].sort((a, b) => pp20(b.points, b.tuh) - pp20(a.points, a.tuh));
    const ranks = withRanks(players, (p) => pp20(p.points, p.tuh).toFixed(6));
    const rows = players.map((p, i) => `<tr>
${td(ranks[i])}
${td(`<a HREF=${link('playerdetail', playerAnchor(p.team, p.name))}>${esc(p.name)}</a>`)}
${td(`<a HREF=${link('teamdetail', teamAnchor(p.team))}>${esc(truncTeam(p.team))}</a>`)}
${td(f1(p.gp), { align: true })}
${valueCols.map((v) => td(String(p.ac.get(v) || 0), { align: true })).join('\n')}
${td(String(p.tuh), { align: true })}
${td(f2(pp20(p.points, p.tuh)), { align: true })}
</tr>`).join('\n');
    return `${sectionHeader(phase.name)}
<table  class=fwBelow1000px >
${header}
${rows}
</table>`;
  }).join('\n');
  return pageShell('Individuals', link, body);
}

// --- Round Report ----------------------------------------------------------
export function renderRounds(stats, link) {
  const rounds = stats.rounds;
  const hasPhases = stats.phases.length > 1 || (stats.phases[0] && stats.phases[0].name !== 'All Games');
  const header = `<tr>
${th('Round', { width: '10%' })}
${hasPhases ? th('Stage', { width: '15%' }) : ''}
${th('Games', { align: true, width: '10%' })}
${th('Pts/Tm/20TUH', { align: true, width: '9%', abbr: 'Points per team per 20 tossups heard' })}
${th('TU Powered', { align: true, width: '9%', abbr: 'Percentage of tossups powered by either team' })}
${th('TU Converted', { align: true, width: '9%', abbr: 'Percentage of tossups answered correctly by either team' })}
${th('Negs/Tm/20TUH', { align: true, width: '9%', abbr: 'Incorrect tossup interrupts per team per 20 tossups heard' })}
${th('PPB', { align: true, width: '9%', abbr: 'Points per bonus' })}
</tr>`;

  let tGames = 0, tTeamPoints = 0, tTeamTuh = 0, tPowers = 0, tPositives = 0, tNegs = 0, tTossups = 0, tBonusPts = 0, tBonuses = 0;
  const rows = rounds.map((r) => {
    tGames += r.games; tTeamPoints += r.teamPoints; tTeamTuh += r.teamTuh;
    tPowers += r.powers; tPositives += r.positives; tNegs += r.negs; tTossups += r.tossups;
    tBonusPts += r.bonusPoints; tBonuses += r.bonuses;
    const stageCell = hasPhases
      ? (r.color ? `<td style="background-color:${r.color}30">\n${esc(r.phase)}\n</td>` : td(esc(r.phase)))
      : '';
    return `<tr>
${td(`<a HREF=${link('games', 'Round-' + anchor(r.round))}>${esc(r.round)}</a>`)}
${stageCell}
${td(String(r.games), { align: true })}
${td(f1(pp20(r.teamPoints, r.teamTuh)), { align: true })}
${td(pct(r.tossups > 0 ? r.powers / r.tossups : 0), { align: true })}
${td(pct(r.tossups > 0 ? r.positives / r.tossups : 0), { align: true })}
${td(f1(pp20(r.negs, r.teamTuh)), { align: true })}
${td(f2(ppb(r.bonusPoints, r.bonuses)), { align: true })}
</tr>`;
  }).join('\n');

  const total = `<tr class=pseudoTFoot>
${td('<b>\nTotal\n</b>')}
${hasPhases ? td('<b>\n\n</b>') : ''}
${td(`<b>\n${tGames}\n</b>`, { align: true })}
${td(`<b>\n${f1(pp20(tTeamPoints, tTeamTuh))}\n</b>`, { align: true })}
${td(`<b>\n${pct(tTossups > 0 ? tPowers / tTossups : 0)}\n</b>`, { align: true })}
${td(`<b>\n${pct(tTossups > 0 ? tPositives / tTossups : 0)}\n</b>`, { align: true })}
${td(`<b>\n${f1(pp20(tNegs, tTeamTuh))}\n</b>`, { align: true })}
${td(`<b>\n${f2(ppb(tBonusPts, tBonuses))}\n</b>`, { align: true })}
</tr>`;

  const body = `<table   >
${header}
${rows}
${total}
</table>`;
  return pageShell('Round Report', link, body);
}

// --- Scoreboard (games) ----------------------------------------------------
export function renderScoreboard(stats, link) {
  const multiPhase = stats.scoreboard.length > 1 || (stats.scoreboard[0] && stats.scoreboard[0].name !== 'All Games');

  // TOC grouped by phase.
  const tocItems = stats.scoreboard.map((ph) => {
    const phaseLi = multiPhase ? `<li>\n${esc(ph.name)}\n</li>` : '';
    const roundLis = ph.rounds.map((r) => `<li>
&nbsp;&nbsp;<a HREF=#Round-${anchor(r.round)}>Round ${esc(r.round)}</a>
</li>`).join('\n');
    return `${phaseLi}\n${roundLis}`;
  }).join('\n');
  const toc = `<div class="floatingTOC">
<ul>
${tocItems}
</ul>
</div>`;

  const valueCols = stats.answerValues;
  const boxTeam = (team, tuh) => {
    const head = `<tr>
${th(truncTeam(team.name, 25))}
${th('TUH', { align: true })}
${valueCols.map((v) => th(String(v), { align: true, width: '5%' })).join('\n')}
${th('Tot', { align: true, width: '8%' })}
</tr>`;
    const rows = team.players.map((p) => `<tr>
${td(esc(p.name))}
${td(String(p.tuh), { align: true })}
${valueCols.map((v) => td(String(p.ac.get(v) || 0), { align: true })).join('\n')}
${td(String(p.points), { align: true })}
</tr>`).join('\n');
    const totAc = new Map();
    let totTuh = 0;
    for (const p of team.players) { totTuh += p.tuh; for (const [v, c] of p.ac) totAc.set(v, (totAc.get(v) || 0) + c); }
    const foot = `<tr class=pseudoTFoot>
${td('<b>Total</b>')}
${td(`<b>${tuh}</b>`, { align: true })}
${valueCols.map((v) => td(`<b>${totAc.get(v) || 0}</b>`, { align: true })).join('\n')}
${td(`<b>${team.total - team.bonusPoints}</b>`, { align: true })}
</tr>`;
    return `<table   width=35%>
${head}
${rows}
${foot}
</table>`;
  };

  const renderRound = (r, phaseName) => {
    const gamesHtml = r.games.map((g, gi) => {
      const sorted = [...g.teams].sort((a, b) => b.total - a.total);
      const title = sorted.map((t) => `${esc(t.name)} ${t.total}`).join(', ')
        + (g.live ? ' <span style="color:#c62828;font-size:.8em">&#9679; in progress</span>' : '');
      const anchorId = `Match_${anchor(r.round)}_${gi}`;
      return `<div id=${anchorId} class="boxScoreAnchor">

</div>
<h3 class="boxScoreTitle">
${title}
</h3>
<p>
Tossups read: ${g.tuh}
</p>
<div class="boxScoreTable">
${g.teams.map((t) => boxTeam(t, g.tuh)).join('\n')}
</div>`;
    }).join('\n');
    return `<div id=Round-${anchor(r.round)}>

</div>
<div class="headerAndDivider scoreboardRoundHeader">
<h2>
Round ${esc(r.round)}${phaseName ? ' - ' + esc(phaseName) : ''}&nbsp;
</h2>
<div class="inlineDivider">

</div>
</div>
${gamesHtml}`;
  };

  const sections = stats.scoreboard.map((ph) =>
    ph.rounds.map((r) => renderRound(r, multiPhase ? ph.name : '')).join('\n')
  ).join('\n');

  const body = `${toc}
<div>
${sections}
</div>`;
  return pageShell('Scoreboard', link, body);
}

// --- Team Detail -----------------------------------------------------------
export function renderTeamDetail(stats, link) {
  const teams = [...stats.teamsGlobal].sort((a, b) => a.name.localeCompare(b.name));
  const valueCols = stats.answerValues;

  const sections = teams.map((t) => {
    const header = `<tr>
${th('Round', { width: '8%' })}
${th('Opponent', { width: '25%' })}
${th('Result', { width: '8%' })}
${th('PF', { align: true, width: '6%', abbr: 'Points for' })}
${th('PA', { align: true, width: '6%', abbr: 'Points against' })}
${valueCols.map((v) => th(String(v), { align: true, width: '5%' })).join('\n')}
${th('TUH', { align: true, width: '6%' })}
${th('PPB', { align: true, width: '7%' })}
</tr>`;
    const rows = t.gameLog.map((g) => `<tr>
${td(esc(g.round))}
${td(esc(g.opponent))}
${td(g.live ? 'in progress' : (g.result || '—'))}
${td(String(g.points), { align: true })}
${td(String(g.oppPoints), { align: true })}
${valueCols.map((v) => td(String(g.ac.get(v) || 0), { align: true })).join('\n')}
${td(String(g.tuh), { align: true })}
${td(f2(ppb(g.bonusPoints, g.bonusesHeard)), { align: true })}
</tr>`).join('\n');
    const foot = `<tr class=pseudoTFoot>
${td(`<b>Total (${t.wins}-${t.losses}${stats.anyTies ? '-' + t.ties : ''})</b>`)}
${td('')}
${td('')}
${td(`<b>${t.totalPoints}</b>`, { align: true })}
${td('')}
${valueCols.map((v) => td(`<b>${t.ac.get(v) || 0}</b>`, { align: true })).join('\n')}
${td(`<b>${t.tuh}</b>`, { align: true })}
${td(`<b>${f2(ppb(t.bonusPoints, t.bonusesHeard))}</b>`, { align: true })}
</tr>`;
    return `<div id=${teamAnchor(t.name)} class="boxScoreAnchor"></div>
${sectionHeader(t.name)}
<table  class=fwBelow1000px >
${header}
${rows}
${foot}
</table>`;
  }).join('\n');

  return pageShell('Team Detail', link, sections);
}

// --- Player Detail ---------------------------------------------------------
export function renderPlayerDetail(stats, link) {
  const players = [...stats.playersGlobal].sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));
  const valueCols = stats.answerValues;

  const sections = players.map((p) => {
    const header = `<tr>
${th('Round', { width: '8%' })}
${th('Opponent', { width: '25%' })}
${th('TUH', { align: true, width: '6%' })}
${valueCols.map((v) => th(String(v), { align: true, width: '5%' })).join('\n')}
${th('Pts', { align: true, width: '7%' })}
</tr>`;
    const rows = p.gameLog.map((g) => `<tr>
${td(esc(g.round))}
${td(esc(g.opponent))}
${td(String(g.tuh), { align: true })}
${valueCols.map((v) => td(String(g.ac.get(v) || 0), { align: true })).join('\n')}
${td(String(g.points), { align: true })}
</tr>`).join('\n');
    const foot = `<tr class=pseudoTFoot>
${td('<b>Total</b>')}
${td('')}
${td(`<b>${p.tuh}</b>`, { align: true })}
${valueCols.map((v) => td(`<b>${p.ac.get(v) || 0}</b>`, { align: true })).join('\n')}
${td(`<b>${p.points}</b>`, { align: true })}
</tr>`;
    return `<div id=${playerAnchor(p.team, p.name)} class="boxScoreAnchor"></div>
${sectionHeader(`${p.name} (${p.team})`)}
<table  class=fwBelow1000px >
${header}
${rows}
${foot}
</table>`;
  }).join('\n');

  return pageShell('Player Detail', link, sections);
}

const RENDERERS = {
  standings: renderStandings,
  individuals: renderIndividuals,
  games: renderScoreboard,
  teamdetail: renderTeamDetail,
  playerdetail: renderPlayerDetail,
  rounds: renderRounds,
};

export function renderReport(page, stats, link) {
  const fn = RENDERERS[page];
  return fn ? fn(stats, link) : null;
}

export { PAGES };
