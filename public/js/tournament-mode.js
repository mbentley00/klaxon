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
// opened via a link (recorded by the tournament page), and, signed in, every
// tournament the account directs or moderates in (or has asked to), wherever
// it was set up.
(async () => {
  const session = localStorage.getItem('bz_sessionToken');
  let viaAccount = [];
  if (session) {
    try {
      ({ tournaments: viaAccount } = await api('GET', `/api/accounts/me/tournaments?sessionToken=${encodeURIComponent(session)}`));
      // A director's token comes with it, so the console just opens here.
      for (const t of viaAccount) {
        if (t.directorToken) localStorage.setItem('bz_directorToken:' + t.code, t.directorToken);
      }
    } catch { viaAccount = []; }
  }
  const roleOf = new Map(viaAccount.map((t) => [t.code, t.role]));
  let recents = [];
  try { recents = JSON.parse(recall('recentTournaments') || '[]').filter((e) => e && e.code); }
  catch { /* ignore */ }
  const seen = new Set(recents.map((e) => e.code));
  // The account's come first: they're the ones this person is working at.
  const fromAccount = viaAccount.filter((t) => !seen.has(t.code));
  for (const t of fromAccount) seen.add(t.code);
  // Tournaments created before visit-tracking existed still have a director
  // token; show them by code until they're next opened (which fills the name).
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('bz_directorToken:')) {
      const code = k.slice('bz_directorToken:'.length);
      if (!seen.has(code)) { recents.push({ code, name: code, date: '' }); seen.add(code); }
    }
  }
  recents = [...fromAccount, ...recents].map((e) => {
    const a = viaAccount.find((t) => t.code === e.code);
    return a ? { ...e, name: a.name || e.name, date: a.date || e.date } : e;
  });
  if (!recents.length) return;
  $('#my-tournaments').classList.remove('hidden');
  const ul = $('#my-tournaments-list');
  for (const t of recents.slice(0, 8)) {
    const li = el('li', {});
    const col = el('span', { className: 'pcol' });
    col.append(el('span', { className: 'pname' }, t.name || t.code));
    col.append(el('span', { className: 'pjoined' }, `${t.date || ''}${t.date ? ' · ' : ''}code ${t.code}`));
    li.append(col);
    // Director: the console. Moderator: the moderator page, which lists the
    // rooms to read in. Asked and waiting: that page too, where it says so.
    const role = recall('directorToken:' + t.code) ? 'director' : roleOf.get(t.code);
    li.append(role === 'director'
      ? el('a', { className: 'btnlink tiny', href: '/t/' + t.code }, 'Director console')
      : role === 'moderator' || role === 'pending'
        ? el('a', { className: 'btnlink tiny', href: `/t/${t.code}/join` }, role === 'moderator' ? 'Moderate' : 'Requested')
        : el('a', { className: 'btnlink tiny', href: '/t/' + t.code }, 'Open'));
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
  } catch (e) { if (e.message === 'not_logged_in') localStorage.removeItem('bz_sessionToken'); }
})();
