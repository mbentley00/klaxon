import { api, $, el, remember } from './util.js';

// The account session is shared with the moderator page under this key.
const SESSION_KEY = 'bz_sessionToken';
const session = () => localStorage.getItem(SESSION_KEY);
const setSession = (t) => localStorage.setItem(SESSION_KEY, t);
const clearSession = () => localStorage.removeItem(SESSION_KEY);

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// "?return=/r/CODE": sent here to sign in (e.g. a moderator joining a room by
// account); go straight back once a session exists. Same-origin paths only.
const returnParam = new URLSearchParams(location.search).get('return');
const returnTo = returnParam && returnParam.startsWith('/') && !returnParam.startsWith('//') ? returnParam : null;

let mode = 'login'; // 'login' | 'register'

function showSignedIn(account) {
  $('#who').textContent = account.username;
  $('#admin-section').classList.toggle('hidden', !account.isAdmin);
  if (account.isAdmin) loadAdmins(account);
  $('#acct-display').value = account.displayName || '';
  $('#acct-email').value = account.email || '';
  $('#signed-in').classList.remove('hidden');
  $('#signed-out').classList.add('hidden');
}

// Logging in makes the account's name the default for "Your name" fields
// (the join gate reads the same key), and brings back the player settings the
// account carries (buzz sound, volume, spoken names, team) on this device.
const syncName = (account) => { if (account.displayName) remember('name', account.displayName); };
function applyPrefs(account) {
  for (const [k, v] of Object.entries(account?.prefs || {})) remember(k, v);
}
function showSignedOut() {
  $('#signed-out').classList.remove('hidden');
  $('#signed-in').classList.add('hidden');
}

function setMode(next) {
  mode = next;
  for (const [id, m] of [['#tab-login', 'login'], ['#tab-register', 'register']]) {
    $(id).classList.toggle('on', mode === m);
    $(id).setAttribute('aria-selected', String(mode === m));
  }
  $('#acct-submit').textContent = mode === 'register' ? 'Create account' : 'Log in';
  $('#acct-password').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  $('#acct-display-reg').classList.toggle('hidden', mode !== 'register');
  $('#acct-email-reg').classList.toggle('hidden', mode !== 'register');
  say('');
}

// The admin list: everyone but a permanent (KLAXON_ADMINS) admin and yourself
// can be removed here.
function renderAdmins(admins, me) {
  $('#admin-list').replaceChildren(...admins.map((a) => {
    const li = el('li', { className: 'row admin-row' },
      el('span', { className: 'admin-name' }, a.displayName ? `${a.displayName} (${a.username})` : a.username));
    if (a.permanent) li.append(el('span', { className: 'hint' }, 'permanent'));
    else if (a.id === me.id) li.append(el('span', { className: 'hint' }, 'you'));
    else {
      const b = el('button', { className: 'tiny ghost', type: 'button' }, 'Remove');
      b.onclick = async () => {
        try {
          const r = await api('POST', `/api/admins/${encodeURIComponent(a.id)}/remove`, { sessionToken: session() });
          renderAdmins(r.admins, me);
          say(`${a.username} is no longer an admin.`);
        } catch (e) { say(friendly(e.message), false); }
      };
      li.append(b);
    }
    return li;
  }));
}
async function loadAdmins(me) {
  try {
    const r = await api('GET', `/api/admins?sessionToken=${encodeURIComponent(session())}`);
    renderAdmins(r.admins, me);
  } catch (e) { say(friendly(e.message), false); }
  $('#admin-add').onsubmit = async (e) => {
    e.preventDefault();
    const identifier = $('#admin-identifier').value.trim();
    if (!identifier) return;
    try {
      const r = await api('POST', '/api/admins', { sessionToken: session(), identifier });
      renderAdmins(r.admins, me);
      $('#admin-identifier').value = '';
      say(`${identifier} is now an admin.`);
    } catch (err) { say(friendly(err.message), false); }
  };
}

const friendly = (e) => ({
  no_such_account: 'No account with that username or email.',
  not_admin: 'Only admins can do that.',
  permanent_admin: 'That admin is set on the server and can\'t be removed here.',
  cannot_remove_self: 'You can\'t remove yourself.',
  username_taken: 'That username is taken.',
  bad_credentials: 'Wrong username or password.',
  bad_password: 'Password must be at least 6 characters.',
  bad_username: 'Username must be 3–30 letters, numbers, or _ . -',
  bad_email: "That doesn't look like an email address.",
  email_taken: 'That email is already on another account.',
  not_logged_in: 'Please log in.'
}[e] || e);

async function init() {
  if (session()) {
    try {
      const { account } = await api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(session())}`);
      syncName(account);
      applyPrefs(account);
      if (returnTo) return void location.assign(returnTo); // already signed in: head back
      return showSignedIn(account);
    } catch (e) { if (e.message === 'not_logged_in') clearSession(); }
  }
  showSignedOut();
  setMode('login');
  if (returnTo) say('Sign in and you\'ll be sent back to where you came from.');
}

$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#acct-username').value.trim();
  const password = $('#acct-password').value;
  if (!username || !password) return say('Enter a username and password.', false);
  try {
    const path = mode === 'register' ? '/api/accounts/register' : '/api/accounts/login';
    const body = { username, password };
    if (mode === 'register') {
      body.displayName = $('#acct-display-reg').value.trim() || undefined;
      body.email = $('#acct-email-reg').value.trim() || undefined;
    }
    const r = await api('POST', path, body);
    setSession(r.sessionToken);
    syncName(r.account);
    applyPrefs(r.account);
    if (returnTo) return void location.assign(returnTo);
    showSignedIn(r.account);
    say('');
  } catch (err) {
    say('Could not sign in: ' + friendly(err.message), false);
  }
});

$('#save-display').onclick = async () => {
  try {
    const { account } = await api('PATCH', '/api/accounts/me',
      { sessionToken: session(), displayName: $('#acct-display').value });
    $('#acct-display').value = account.displayName;
    syncName(account);
    say('Name saved.');
  } catch (err) {
    say('Could not save: ' + friendly(err.message), false);
  }
};

$('#save-email').onclick = async () => {
  try {
    const { account } = await api('PATCH', '/api/accounts/me',
      { sessionToken: session(), email: $('#acct-email').value.trim() });
    $('#acct-email').value = account.email;
    say(account.email ? 'Email saved — directors can add you as a moderator with it.' : 'Email removed.');
  } catch (err) {
    say('Could not save: ' + friendly(err.message), false);
  }
};

$('#logout').onclick = () => {
  const t = session();
  if (t) api('POST', '/api/accounts/logout', { sessionToken: t }).catch(() => {});
  clearSession(); showSignedOut(); setMode('login'); say('Signed out.');
};

init();
