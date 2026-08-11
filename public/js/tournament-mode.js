import { api, recall, $, el } from './util.js';

const msg = $('#msg');

// Open a tournament by code: the director console if this browser holds the
// director token, otherwise the player-facing page.
$('#open-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#open-code').value.trim().toUpperCase();
  if (!code) {
    msg.textContent = 'Enter a tournament code.';
    msg.className = 'msg bad';
    return;
  }
  location.href = (recall('directorToken:' + code) ? '/t/' : '/tp/') + code;
});

// "Your tournaments": everything this browser created (director tokens) or
// opened via a link (recorded by the tournament page). All local — no account.
(() => {
  let recents = [];
  try { recents = JSON.parse(recall('recentTournaments') || '[]').filter((e) => e && e.code); }
  catch { /* ignore */ }
  const seen = new Set(recents.map((e) => e.code));
  // Tournaments created before visit-tracking existed still have a director
  // token; show them by code until they're next opened (which fills the name).
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('bz_directorToken:')) {
      const code = k.slice('bz_directorToken:'.length);
      if (!seen.has(code)) recents.push({ code, name: code, date: '' });
    }
  }
  if (!recents.length) return;
  $('#my-tournaments').classList.remove('hidden');
  const ul = $('#my-tournaments-list');
  for (const t of recents.slice(0, 8)) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    col.append(el('span', { className: 'pname' }, t.name || t.code));
    col.append(el('span', { className: 'pjoined' }, `${t.date || ''}${t.date ? ' · ' : ''}code ${t.code}`));
    li.append(col);
    li.append(el('a', { className: 'btnlink tiny', href: '/t/' + t.code },
      recall('directorToken:' + t.code) ? 'Director console' : 'Open'));
    ul.append(li);
  }
})();

// Reflect signed-in state on the account link.
(async () => {
  const s = localStorage.getItem('bz_sessionToken');
  const link = $('#account-link');
  if (!s || !link) return;
  try {
    const { account } = await api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(s)}`);
    link.textContent = `Account · ${account.username}`;
  } catch { localStorage.removeItem('bz_sessionToken'); }
})();
