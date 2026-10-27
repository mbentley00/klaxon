// The director console's Schedule tab, for a tournament paired Swiss: pair the
// next round from the standings, swap teams or rooms, publish it into the
// schedule, follow each round's games, withdraw a round that hasn't started,
// and run the playoff bracket after the last Swiss round. The server decides
// the pairings (server/swiss.js); this page shows them and sends them back.
import { api, el } from './util.js';

export function mountSwiss(root, { code, directorToken }) {
  const q = encodeURIComponent;
  let data = null;      // GET /swiss
  let preview = null;   // a proposed round, being adjusted
  let force = false;    // pair before the last round's games are all saved
  let busy = false;
  const msg = el('p', { className: 'msg', role: 'status' });
  const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };
  const ERR = {
    previous_not_published: 'Publish the round before it first.',
    not_enough_rooms: 'Not enough rooms for this round. Add rooms on the Rooms tab.',
    too_few_teams: 'Not enough teams left for the playoff bracket.',
    bracket_waiting: 'Every game of the previous playoff round has to be saved first.',
    started: 'A game in this round has started, so it can no longer be withdrawn.',
    later_round_published: 'Withdraw the later round first.',
    already_published: 'That round is already published.',
    no_teams: 'Upload a roster first (Packets & roster tab).',
    playoffs_unfinished: 'Every round-robin game has to be saved before the final.',
    no_final_needed: 'No final is needed.',
  };
  const fail = (e) => say(ERR[e.message] || `Could not do that: ${e.message}`, false);

  async function load() {
    try {
      data = await api('GET', `/api/tournaments/${code}/swiss?directorToken=${q(directorToken)}`);
      render();
    } catch (e) { root.replaceChildren(el('p', { className: 'msg bad', textContent: `Could not load the schedule: ${e.message}` })); }
  }

  const byName = () => Object.fromEntries((data?.standings || []).map((s) => [s.name, s]));
  const roomName = (c) => data.rooms.find((r) => r.code === c)?.name || c;

  async function pair() {
    if (busy) return;
    busy = true;
    try {
      preview = await api('POST', `/api/tournaments/${code}/swiss/preview`, { directorToken, round: data.next });
      say('');
    } catch (e) { fail(e); }
    busy = false;
    render();
  }

  async function publish() {
    if (busy || !preview) return;
    busy = true;
    try {
      await api('POST', `/api/tournaments/${code}/swiss/publish`, {
        directorToken, round: preview.round, bye: preview.bye, notes: preview.notes, seeds: preview.seeds,
        pairings: preview.pairings.map((p) => ({ room: p.room, teams: p.teams })),
      });
      say(`${preview.label} published. Rooms and players see it now.`);
      preview = null;
      force = false;
    } catch (e) { fail(e); }
    busy = false;
    load();
  }

  async function withdraw(round, label) {
    if (!confirm(`Withdraw ${label}? Its pairings leave the schedule and you can pair it again.`)) return;
    try {
      await api('POST', `/api/tournaments/${code}/swiss/withdraw`, { directorToken, round });
      say(`${label} withdrawn.`);
    } catch (e) { fail(e); }
    load();
  }

  async function setDropped(name, out) {
    const dropped = new Set(data.dropped);
    if (out) dropped.add(name); else dropped.delete(name);
    try {
      await api('PUT', `/api/tournaments/${code}/swiss/dropped`, { directorToken, teams: [...dropped] });
      say(out ? `${name} is out of later rounds.` : `${name} is back in.`);
    } catch (e) { fail(e); }
    load();
  }

  // Changing one slot swaps: the team (or room) chosen leaves its old slot,
  // which takes the one it replaced. Nobody ends up twice or nowhere.
  function swapTeam(i, side, name) {
    const old = preview.pairings[i].teams[side];
    if (old === name) return;
    let moved = false;
    preview.pairings.forEach((p, j) => p.teams.forEach((n, s) => {
      if (!moved && n === name && !(j === i && s === side)) { p.teams[s] = old; moved = true; }
    }));
    if (!moved && preview.bye === name) { preview.bye = old; moved = true; }
    preview.pairings[i].teams[side] = name;
    const rec = byName();
    for (const p of preview.pairings) p.records = p.teams.map((n) => rec[n]?.record || '');
    preview.edited = true;
    render();
  }
  function swapRoom(i, room) {
    const other = preview.pairings.find((p) => p.room === room);
    if (other) { other.room = preview.pairings[i].room; other.roomName = roomName(other.room); }
    preview.pairings[i].room = room;
    preview.pairings[i].roomName = roomName(room);
    preview.edited = true;
    render();
  }

  function render() {
    const d = data;
    const kids = [];
    const settings = el('a', { href: `/new-tournament?edit=${code}`, textContent: 'Change in settings' });
    const playoffs = d.playoffFormat === 'roundrobin'
      ? `, then round-robin tiers of ${d.playoffTier}${d.playoffCarryover ? ' with carryover' : ''}${d.championship === 'advantaged' ? ' and an advantaged final' : d.championship === 'single' ? ' and a final' : ''}`
      : d.playoffFormat === 'single' ? `, then a ${d.playoffSize}-team single-elimination bracket` : ', no playoffs';
    kids.push(el('p', {},
      `${d.rounds} Swiss round${d.rounds === 1 ? '' : 's'}${playoffs}. `,
      `${d.teams} teams${d.dropped.length ? ` (${d.dropped.length} out)` : ''}; ${d.suggestedRounds} rounds suggested for this field. `, settings, '.'));
    if (d.rooms.length < d.roomsNeeded) {
      kids.push(el('p', { className: 'warn-box', textContent: `This field needs ${d.roomsNeeded} rooms and the tournament has ${d.rooms.length}. Add rooms on the Rooms tab.` }));
    }
    if (!d.teams) kids.push(el('p', { className: 'warn-box', textContent: 'Upload a roster first (Packets & roster tab): its teams, in their listed order, are the seeds.' }));

    // The next round.
    const nextRound = d.schedule.find((r) => r.round === d.next);
    if (nextRound) {
      const box = el('section', { className: 'swiss-next' }, el('h4', { textContent: `Next: ${nextRound.label}` }));
      if (!preview) {
        const prev = d.schedule.find((r) => r.round === String(Number(d.next) - 1));
        const unsaved = (prev?.pairings || []).filter((p) => p.status.state !== 'saved');
        if (!d.nextReady && unsaved.length) {
          box.append(el('p', { className: 'hint', textContent: `Waiting for ${unsaved.length} game${unsaved.length === 1 ? '' : 's'} of ${prev.label}: ${unsaved.map((p) => `${p.roomName} (${p.teams.join(' v ')})`).join(', ')}.` }));
          const cb = el('input', { type: 'checkbox', checked: force });
          cb.onchange = () => { force = cb.checked; render(); };
          box.append(el('label', { className: 'toggle' }, cb, ' Pair now anyway (unsaved games count as not played)'));
        }
        const go = el('button', { type: 'button', className: 'primary', textContent: `Pair ${nextRound.label}`, disabled: !(d.nextReady || force) || !d.teams, onclick: pair });
        box.append(el('div', { className: 'row' }, go));
      } else {
        const teams = (preview.kind === 'playoff' ? d.standings : d.standings.filter((s) => !s.dropped)).map((s) => s.name);
        const teamSel = (i, side) => {
          const s = el('select', { className: 'swiss-team' }, ...teams.map((n) => el('option', { value: n, textContent: n })));
          s.value = preview.pairings[i].teams[side];
          s.setAttribute('aria-label', `${preview.pairings[i].roomName}, team ${side + 1}`);
          s.onchange = () => swapTeam(i, side, s.value);
          return s;
        };
        const roomSel = (i) => {
          const s = el('select', {}, ...d.rooms.map((r) => el('option', { value: r.code, textContent: r.name })));
          s.value = preview.pairings[i].room;
          s.setAttribute('aria-label', `Room for game ${i + 1}`);
          s.onchange = () => swapRoom(i, s.value);
          return s;
        };
        const seedTxt = (p, side) => (p.seeds?.[side] ? `#${p.seeds[side]} ` : '');
        const tiered = preview.pairings.some((p) => p.tier);
        box.append(el('div', { className: 'swiss-scroll' }, el('table', { className: 'swiss-table' },
          el('thead', {}, el('tr', {}, ...(tiered ? [el('th', { textContent: 'Tier' })] : []), el('th', { textContent: 'Room' }), el('th', { textContent: 'Team' }), el('th', { textContent: '' }), el('th', { textContent: 'Team' }))),
          el('tbody', {}, ...preview.pairings.map((p, i) => el('tr', {},
            ...(tiered ? [el('td', { className: 'swiss-rec', textContent: p.tier || '' })] : []),
            el('td', {}, roomSel(i)),
            el('td', {}, teamSel(i, 0), el('span', { className: 'swiss-rec', textContent: ` ${seedTxt(p, 0)}${p.records?.[0] || ''}` })),
            el('td', { className: 'swiss-v', textContent: 'v' }),
            el('td', {}, teamSel(i, 1), el('span', { className: 'swiss-rec', textContent: ` ${seedTxt(p, 1)}${p.records?.[1] || ''}` }))))))));
        if (preview.bye) box.append(el('p', {}, el('strong', { textContent: 'Bye: ' }), preview.bye, el('span', { className: 'hint', textContent: ' (counts as nothing: not a win, not a game)' })));
        if (preview.unsaved?.length) box.append(el('p', { className: 'warn-box', textContent: `Paired without ${preview.unsaved.length} unsaved game${preview.unsaved.length === 1 ? '' : 's'}: ${preview.unsaved.map((u) => u.teams.join(' v ')).join(', ')}.` }));
        if (preview.notes?.length && !preview.edited) box.append(el('ul', { className: 'swiss-notes' }, ...preview.notes.map((n) => el('li', { textContent: n }))));
        if (preview.edited) box.append(el('p', { className: 'hint', textContent: 'Changed by hand. Klaxon’s notes no longer apply.' }));
        box.append(el('div', { className: 'row' },
          el('button', { type: 'button', className: 'primary', textContent: `Publish ${preview.label}`, onclick: publish }),
          el('button', { type: 'button', className: 'ghost', textContent: 'Discard', onclick: () => { preview = null; render(); } })));
      }
      kids.push(box);
    } else if (d.schedule.length) {
      kids.push(el('p', { className: 'good', textContent: d.champion ? `${d.champion} is champion. Every round is done.` : 'Every round is published.' }));
    }
    if (d.champion && nextRound) kids.push(el('p', { className: 'good', textContent: `${d.champion} is champion.` }));
    kids.push(msg);

    // Published rounds, newest first.
    const published = d.schedule.filter((r) => r.published).reverse();
    const latest = published[0]?.round;
    for (const r of published) {
      const card = el('section', { className: 'swiss-round' },
        el('div', { className: 'swiss-round-head' },
          el('h4', { textContent: r.label }),
          el('span', { className: 'hint', textContent: `${r.progress.saved} of ${r.progress.total} games saved` })));
      card.append(el('ul', { className: 'swiss-games' }, ...r.pairings.map((p) => {
        const st = p.status;
        const what = st.state === 'saved'
          ? `${st.score?.join('–') ?? ''}${st.winner ? `, ${st.winner} won` : ', tie'}`
          : st.state === 'live' ? 'playing' : 'not started';
        return el('li', { className: `swiss-${st.state}` },
          el('a', { href: `/r/${p.room}`, target: '_blank', rel: 'noopener', textContent: p.roomName }),
          ` ${p.tier ? `${p.tier}: ` : ''}${p.teams.join(' v ')} · `, el('span', { className: 'swiss-state', textContent: what }));
      })));
      if (r.bye) card.append(el('p', { className: 'hint', textContent: `Bye: ${r.bye}` }));
      if (r.round === latest && !r.progress.started) {
        card.append(el('button', { type: 'button', className: 'ghost tiny', textContent: 'Withdraw this round', onclick: () => withdraw(r.round, r.label) }));
      }
      kids.push(card);
    }

    // The round robin's tiers, each with its own standings (carryover games in).
    for (const tier of d.tiers || []) {
      kids.push(el('h4', { textContent: `${tier.name} standings` }));
      kids.push(el('div', { className: 'swiss-scroll' }, el('table', { className: 'swiss-table' },
        el('thead', {}, el('tr', {}, ...['#', 'Team', 'Record', 'PP20TUH'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...tier.standings.map((s) => el('tr', {},
          el('td', { textContent: String(s.rank) }), el('td', { textContent: s.name }), el('td', { textContent: s.record }),
          el('td', { textContent: s.pp20.toFixed(1) })))))));
    }

    // Standings.
    if (d.standings.length) {
      kids.push(el('h4', { textContent: 'Swiss standings' }));
      kids.push(el('div', { className: 'swiss-scroll' }, el('table', { className: 'swiss-table' },
        el('thead', {}, el('tr', {}, ...['#', 'Team', 'Record', 'PP20TUH', 'Opp. wins', 'Byes', ''].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...d.standings.map((s) => el('tr', { className: s.dropped ? 'swiss-out' : '' },
          el('td', { textContent: String(s.rank) }), el('td', { textContent: s.name }), el('td', { textContent: s.record }),
          el('td', { textContent: s.pp20.toFixed(1) }), el('td', { textContent: String(s.oppWins) }), el('td', { textContent: String(s.byes) }),
          el('td', {}, el('button', { type: 'button', className: 'ghost tiny', textContent: s.dropped ? 'Back in' : 'Drop out',
            onclick: () => setDropped(s.name, !s.dropped) }))))))));
    }
    root.replaceChildren(...kids);
  }

  load();
  return { reload: load };
}
