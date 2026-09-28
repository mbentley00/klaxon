import { api, $, el, remember } from './util.js';

// The game archive, from this browser's side: whatever staff tokens it holds
// (every room it created or was handed a co-reader link to) plus the account
// session, if any. The server decides what those can see.
const session = localStorage.getItem('bz_sessionToken');
function heldTokens() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('bz_staffToken:') || k.startsWith('bz_coReaderToken:'))) {
      const v = localStorage.getItem(k);
      if (v) out.push(v);
    }
  }
  return out;
}
const creds = () => ({ sessionToken: session || undefined, tokens: heldTokens() });

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

function describe(g) {
  return g.teams?.length
    ? g.teams.map((name, i) => `${name} ${g.scores?.[i] ?? 0}`).join(' vs ')
    : 'Teams not recorded';
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Who played for each side, and how the tossups went. The server sends these
// only for games the viewer may see the scoresheet of.
function details(g) {
  const box = el('div', { className: 'archive-details' });
  for (const r of g.roster || []) {
    if (!r.team) continue;
    box.append(el('div', { className: 'archive-roster' },
      el('span', { className: 'archive-roster-team' }, r.team),
      el('span', {}, r.players?.length ? r.players.join(', ') : 'No players listed')));
  }
  const t = g.tally;
  if (t && (t.powers || t.gets || t.negs)) {
    const line = el('div', { className: 'archive-tally' });
    for (const [n, one, cls] of [[t.powers, 'power', 'ss-power'], [t.gets, 'get', 'ss-get'], [t.negs, 'neg', 'ss-neg']]) {
      if (n) line.append(el('span', { className: `archive-chip ${cls}` }, plural(n, one)));
    }
    box.append(line);
  }
  return box.childElementCount ? box : null;
}
// A game runs an hour or two; an edit later than this was a reopen.
const EDITED_AFTER_MS = 3 * 60 * 60 * 1000;
function when(ts) {
  return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
function fileSafe(s) {
  return String(s || 'game').replace(/[^A-Za-z0-9 _-]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 60) || 'game';
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fetchGame = (id) => api('POST', `/api/games/${encodeURIComponent(id)}`, creds());

// The scoresheet, read straight off the QBJ: who buzzed on each tossup and for
// how much, and what the bonus made. Names and numbers only.
function scoresheet(qbj) {
  const table = el('table', { className: 'ss-events archive-sheet' });
  table.append(el('thead', {}, el('tr', {}, el('th', { className: 'ss-num' }, '#'), el('th', {}, 'Events'))));
  const body = el('tbody');
  const questions = (qbj?.match_questions || []).filter((q) => q.buzzes?.length || q.bonus);
  for (const q of questions) {
    const cell = el('td');
    for (const b of q.buzzes || []) {
      const v = b.result?.value ?? 0;
      const kind = v > 10 ? 'ss-power' : v > 0 ? 'ss-get' : v < 0 ? 'ss-neg' : 'ss-zero';
      cell.append(el('div', { className: `ss-item ss-buzz ${kind}` }, `${b.player?.name ?? ''} (${b.team?.name ?? ''}) for ${v}`));
    }
    if (q.bonus) {
      const parts = q.bonus.parts || [];
      const got = parts.reduce((n, p) => n + (p.controlled_points || 0), 0);
      const line = el('div', { className: 'ss-item' }, `${got} on bonus (`);
      for (const p of parts) line.append(el('span', { className: p.controlled_points > 0 ? 'ss-part-got' : 'ss-part-miss' }, p.controlled_points > 0 ? '✓' : '✗'));
      line.append(')');
      cell.append(line);
    }
    body.append(el('tr', {}, el('td', { className: 'ss-num' }, String(q.question_number ?? '')), cell));
  }
  if (!questions.length) body.append(el('tr', {}, el('td', { colSpan: 2 }, 'Nothing was scored.')));
  table.append(body);
  return el('div', { className: 'scoresheet archive-sheet-wrap' }, el('div', { className: 'ss-scroll' }, table));
}

function sheetButton(g, li) {
  const b = el('button', { className: 'tiny' }, 'View scoresheet');
  let shown = null;
  b.onclick = async () => {
    if (shown) { shown.remove(); shown = null; b.textContent = 'View scoresheet'; return; }
    try {
      const r = await fetchGame(g.id);
      if (!r.qbj) return say('No scoresheet was saved for this game.', false);
      shown = scoresheet(r.qbj);
      li.append(shown);
      b.textContent = 'Hide scoresheet';
    } catch (e) { say('Could not fetch the game: ' + e.message, false); }
  };
  return b;
}

function qbjButton(g, base, label) {
  const b = el('button', { className: 'tiny' }, label);
  b.onclick = async () => {
    try {
      const r = await fetchGame(g.id);
      if (!r.qbj) return say('This game has no QBJ saved.', false);
      download(`${base}.qbj`, JSON.stringify(r.qbj, null, 2), 'application/json');
    } catch (e) { say('Could not fetch the game: ' + e.message, false); }
  };
  return b;
}

// Players' requests for this game's scoresheet, for its moderators to answer.
function requestsPanel(g) {
  const reqs = g.requests || [];
  if (!reqs.length) return null;
  const box = el('div', { className: 'archive-requests' });
  box.append(el('div', { className: 'hint' }, 'Players asking for the scoresheet:'));
  for (const r of reqs) {
    const line = el('div', { className: 'row archive-request' }, el('span', {}, r.name || 'A player'));
    if (r.status === 'pending') {
      for (const [label, decision] of [['Approve', 'approve'], ['Deny', 'deny']]) {
        const b = el('button', { className: decision === 'approve' ? 'tiny' : 'tiny ghost' }, label);
        b.onclick = async () => {
          try {
            await api('POST', `/api/games/${encodeURIComponent(g.id)}/requests/${encodeURIComponent(r.id)}`, { ...creds(), decision });
            load();
          } catch (e) { say('Could not answer the request: ' + e.message, false); }
        };
        line.append(b);
      }
    } else {
      line.append(el('span', { className: 'recent-meta' }, r.status === 'approved' ? 'approved' : 'denied'));
    }
    box.append(line);
  }
  return box;
}

function row(g) {
  const li = el('li', { className: 'archive-game' });
  const head = el('div', { className: 'archive-head' },
    el('span', { className: 'recent-code' }, g.room || ''),
    el('span', { className: 'archive-teams' }, describe(g)));
  const played = g.access === 'player' || g.access === 'granted';
  const bits = [
    g.tournament ? g.tournament.name || g.tournament.code : g.roomName,
    g.round && g.round !== 'lite' ? `Round ${g.round}` : '',
    g.total ? `Q${Math.min(g.current, g.total)}/${g.total}` : g.current ? plural(g.current, 'tossup') + ' scored' : '',
    played ? 'you played' : '',
    g.legacy ? 'saved before the archive' : ''
  ].filter(Boolean);
  // When: the game itself, then (if it was reopened and changed well after)
  // the last edit, and when its room was made. A reopen never moves "played".
  const started = g.startedAt || g.updatedAt;
  const dates = [
    `Played ${when(started)}`,
    g.updatedAt && started && g.updatedAt - started > EDITED_AFTER_MS ? `last edited ${when(g.updatedAt)}` : '',
    g.roomCreatedAt ? `room created ${when(g.roomCreatedAt)}` : ''
  ].filter(Boolean);
  const meta = el('div', { className: 'recent-meta archive-meta' },
    el('div', {}, bits.join(' · ')), el('div', {}, dates.join(' · ')));
  const actions = el('div', { className: 'row archive-actions' });
  const base = fileSafe(`${(g.teams || []).join(' vs ') || g.room}${g.round && g.round !== 'lite' ? ' R' + g.round : ''}`);
  const more = details(g);
  li.append(head, meta, ...(more ? [more] : []), actions);

  // A player in the game: ask its moderator, or see where the ask stands.
  if (g.access === 'player') {
    const status = g.myRequest?.status;
    if (status === 'pending') {
      actions.append(el('span', { className: 'hint' }, 'Scoresheet requested. Waiting for the moderator.'));
      return li;
    }
    if (status === 'denied') actions.append(el('span', { className: 'hint' }, 'The moderator declined your request.'));
    const ask = el('button', { className: 'tiny' }, status === 'denied' ? 'Ask again' : 'Request the scoresheet');
    ask.onclick = async () => {
      ask.disabled = true;
      try {
        await api('POST', `/api/games/${encodeURIComponent(g.id)}/request`, creds());
        say('Asked. The game\'s moderator will see your request on their games page.');
        load();
      } catch (e) { ask.disabled = false; say('Could not send the request: ' + e.message, false); }
    };
    actions.append(ask);
    return li;
  }

  // Results only: someone else's game seen as admin, or a player's approved
  // request. The server enforces it; this just doesn't offer what it'd refuse.
  if (g.access === 'admin' || g.access === 'granted') {
    if (g.hasQbj) {
      const b = qbjButton(g, base, 'Download results (QBJ)');
      b.title = 'Scores only: names, buzzes and points. Nothing from the questions.';
      actions.append(sheetButton(g, li), b);
    } else {
      actions.append(el('span', { className: 'hint' }, 'Only the summary above was saved for this game.'));
    }
    const p = g.access === 'admin' && requestsPanel(g);
    if (p) li.append(p);
    return li;
  }

  if (g.hasQbj) actions.append(sheetButton(g, li), qbjButton(g, base, 'Download QBJ'));
  const open = el('button', { className: 'tiny' }, 'Reopen in MODAQ');
  open.title = 'Opens the game in a new MODAQ room, to fix a score or export it again';
  open.onclick = async () => {
    open.disabled = true;
    try {
      const r = await api('POST', `/api/games/${encodeURIComponent(g.id)}/reopen`, creds());
      remember('staffToken:' + r.code, r.readerToken);
      remember('coReaderToken:' + r.code, r.coReaderToken);
      location.href = `/modaq?room=${r.code}`;
    } catch (e) {
      open.disabled = false;
      say(e.message === 'no_modaq_copy'
        ? 'MODAQ\'s copy of this game wasn\'t saved, so it can\'t be reopened. The QBJ still has the results.'
        : 'Could not reopen the game: ' + e.message, false);
    }
  };
  const raw = el('button', { className: 'tiny ghost' }, 'Backup file');
  raw.title = 'Everything saved for this game, as one JSON file';
  raw.onclick = async () => {
    try {
      const r = await fetchGame(g.id);
      download(`${base}.klaxon-game.json`, JSON.stringify(r), 'application/json');
    } catch (e) { say('Could not fetch the game: ' + e.message, false); }
  };
  actions.append(open, raw);
  const p = requestsPanel(g);
  if (p) li.append(p);
  return li;
}

async function load() {
  const all = $('#show-all').checked;
  try {
    const r = await api('POST', '/api/games/list', { ...creds(), all });
    $('#admin-row').classList.toggle('hidden', !r.admin);
    $('#games-list').replaceChildren(...r.games.map(row));
    $('#games-empty').classList.toggle('hidden', r.games.length > 0);
    if (!r.loggedIn) say('Log in (Account, below) to also see the games your account moderated or played in.', true);
  } catch (e) {
    say('Could not load games: ' + e.message, false);
  }
}
$('#show-all').addEventListener('change', load);
load();
