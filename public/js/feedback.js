import { api, $, recall, remember } from './util.js';

const msg = $('#feedback-form') && $('#fb-msg');
const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };

// Where they came from, so a bug report carries the page it happened on. Only
// our own pages — a referrer from anywhere else isn't ours to send on.
const params = new URLSearchParams(location.search);
const fromParam = params.get('from');
let page = '';
try {
  const ref = fromParam || document.referrer;
  if (ref && new URL(ref, location.origin).origin === location.origin) page = new URL(ref, location.origin).href;
} catch { /* no usable referrer */ }
$('#fb-context').textContent = page ? `Reporting about ${page.replace(location.origin, '') || '/'}` : '';

// An address we already know beats making them type it: the account they're
// signed in with, then whatever they used here last.
$('#fb-email').value = recall('feedbackEmail') || '';
const session = localStorage.getItem('bz_sessionToken');
if (session) {
  api('GET', `/api/accounts/me?sessionToken=${encodeURIComponent(session)}`)
    .then(({ account }) => { if (account.email && !$('#fb-email').value) $('#fb-email').value = account.email; })
    .catch(() => { /* not signed in after all */ });
}

$('#feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#fb-email').value.trim();
  const message = $('#fb-message').value.trim();
  const kind = document.querySelector('input[name="kind"]:checked')?.value || 'feedback';
  if (!message) return say('Write a message first.', false);
  const btn = $('#fb-send');
  btn.disabled = true;
  say('Sending…');
  try {
    await api('POST', '/api/feedback', { email, message, kind, page });
    remember('feedbackEmail', email);
    $('#feedback-form').reset();
    $('#fb-context').textContent = '';
    say('Thanks — that went straight to Michael. He reads all of it.');
  } catch (err) {
    // If mail isn't wired up (or is failing), the message shouldn't just die:
    // hand them the same content as an email they can send themselves.
    const body = encodeURIComponent(`${message}\n\n---\nPage: ${page || '(not given)'}\nFrom: ${email}`);
    const subject = encodeURIComponent(kind === 'bug' ? 'Klaxon bug report' : 'Klaxon feedback');
    say('');
    msg.className = 'msg bad';
    msg.textContent = err.message + ' ';
    const link = document.createElement('a');
    link.href = `mailto:bentley.michael.j@gmail.com?subject=${subject}&body=${body}`;
    link.textContent = 'Send it as an email instead';
    msg.append(link);
  } finally {
    btn.disabled = false;
  }
});
