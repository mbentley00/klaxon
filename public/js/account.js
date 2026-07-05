import { api, $, remember } from './util.js';

// The account session is shared with the moderator page under this key.
const SESSION_KEY = 'bz_sessionToken';
const session = () => localStorage.getItem(SESSION_KEY);
const setSession = (t) => localStorage.setItem(SESSION_KEY, t);
const clearSession = () => localStorage.removeItem(SESSION_KEY);

const msg = $('#msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

let mode = 'login'; // 'login' | 'register'

function showSignedIn(account) {
  $('#who').textContent = account.username;
  $('#acct-display').value = account.displayName || '';
  $('#acct-email').value = account.email || '';
  $('#signed-in').classList.remove('hidden');
  $('#signed-out').classList.add('hidden');
}

// Logging in makes the account's name the default for "Your name" fields
// (the join gate reads the same key). The name is separate from the username.
const syncName = (account) => { if (account.displayName) remember('name', account.displayName); };
function showSignedOut() {
  $('#signed-out').classList.remove('hidden');
  $('#signed-in').classList.add('hidden');
}

function setMode(next) {
  mode = next;
  $('#tab-login').classList.toggle('ghost', mode !== 'login');
  $('#tab-register').classList.toggle('ghost', mode !== 'register');
  $('#acct-submit').textContent = mode === 'register' ? 'Create account' : 'Log in';
  $('#acct-password').setAttribute('autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  $('#acct-display-reg').classList.toggle('hidden', mode !== 'register');
  $('#acct-email-reg').classList.toggle('hidden', mode !== 'register');
  say('');
}

const friendly = (e) => ({
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
      return showSignedIn(account);
    } catch { clearSession(); }
  }
  showSignedOut();
  setMode('login');
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

$('#logout').onclick = () => { clearSession(); showSignedOut(); setMode('login'); say('Signed out.'); };

init();
