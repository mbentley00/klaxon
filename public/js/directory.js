import { api, $, el } from './util.js';

const session = () => localStorage.getItem('bz_sessionToken');
const dmsg = (t, ok = true) => { const m = $('#dir-msg'); m.textContent = t; m.className = 'msg ' + (ok ? 'good' : 'bad'); };

let account = null;

async function init() {
  // Reflect signed-in state in the header.
  if (session()) {
    try {
      const r = await api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(session())}`);
      account = r.account;
      const pill = $('#account-pill');
      pill.textContent = account.username;
    } catch { localStorage.removeItem('bz_sessionToken'); }
  }
  await render();
}

// Tournaments created from this browser: we still hold their director tokens,
// so link straight to the console — even for unlisted tournaments, which the
// public directory below never shows.
function myCodes() {
  const codes = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('bz_directorToken:')) codes.push(k.slice('bz_directorToken:'.length));
  }
  return codes;
}

const byDateThenName = (a, b) =>
  (a.date || '9999').localeCompare(b.date || '9999') || a.name.localeCompare(b.name);

async function renderMine() {
  const mine = (await Promise.all(myCodes().map(async (code) => {
    try { return await api('GET', `/api/tournaments/${code}`); }
    catch { return null; } // gone from the server — keep the token, skip the row
  }))).filter(Boolean).sort(byDateThenName);

  $('#mine-panel').classList.toggle('hidden', !mine.length);
  const ul = $('#mine-list');
  ul.innerHTML = '';
  for (const t of mine) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    col.append(el('span', { className: 'pname' }, t.name));
    col.append(el('span', { className: 'pjoined' }, `${t.date || 'Date TBD'} · code ${t.code}`));
    li.append(col);
    li.append(el('a', { className: 'btnlink tiny', href: '/t/' + t.code }, 'Director console'));
    ul.append(li);
  }
  return new Set(mine.map((t) => t.code));
}

async function render() {
  const mine = await renderMine();

  let tournaments = [];
  try {
    ({ tournaments } = await api('GET', '/api/tournaments'));
  } catch { dmsg('Could not load tournaments.', false); }
  // Ours are already shown above with a console link — don't repeat them.
  tournaments = tournaments.filter((t) => !mine.has(t.code));

  $('#dir-empty').classList.toggle('hidden', tournaments.length > 0);
  const ul = $('#dir-list');
  ul.innerHTML = '';

  // If logged in, look up our status for each account-gated tournament.
  const statuses = {};
  if (account) {
    await Promise.all(tournaments.filter((t) => t.requireReaderAccounts).map(async (t) => {
      try { const a = await api('GET', `/api/tournaments/${t.code}/access?sessionToken=${encodeURIComponent(session())}`); statuses[t.code] = a.status; }
      catch { /* ignore */ }
    }));
  }

  for (const t of tournaments) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    const nameRow = el('span', { className: 'pname-wrap' });
    nameRow.append(el('span', { className: 'pname' }, t.name));
    if (t.requireReaderAccounts) nameRow.append(el('span', { className: 'offline-badge' }, 'ACCOUNT'));
    col.append(nameRow);
    col.append(el('span', { className: 'pjoined' }, `${t.date || 'Date TBD'} · code ${t.code}`));
    li.append(col);
    li.append(actionFor(t, statuses[t.code]));
    ul.append(li);
  }
}

function actionFor(t, status) {
  if (!t.requireReaderAccounts) {
    return el('span', { className: 'pjoined' }, 'Open — ask the director for a room link');
  }
  if (!account) {
    return el('a', { className: 'btnlink tiny', href: '/account' }, 'Log in to request');
  }
  if (status === 'approved') return el('span', { className: 'pjoined' }, 'Approved ✓');
  if (status === 'pending') return el('span', { className: 'pjoined' }, 'Requested — pending');
  if (status === 'denied') return el('span', { className: 'pjoined' }, 'Denied');
  const btn = el('button', { className: 'tiny primary' }, 'Request to join');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('POST', `/api/tournaments/${t.code}/access`, { sessionToken: session() });
      dmsg(`Requested to join ${t.name}. The director will approve you.`);
      render();
    } catch (e) { dmsg('Could not request: ' + e.message, false); btn.disabled = false; }
  };
  return btn;
}

init();
