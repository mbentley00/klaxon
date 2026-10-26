// The "Game data API" panel: make a read-only key, copy the links that use it,
// choose when question text is included, make a new key, or switch it off.
// The director console uses it for a tournament; a room's options use it for
// a room outside a tournament.
import { el } from './util.js';

// container: the element to fill. api: { enabled, key, questions }.
// links(key): [{ label, url }]. act(action, questions): Promise<api>.
export function renderApiAccess(container, { api, links, act, what = 'this room' }) {
  const msg = el('p', { className: 'msg' });
  const say = (t, ok = true) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'good' : 'bad'); };
  const run = async (action, questions, done) => {
    try {
      const next = await act(action, questions);
      renderApiAccess(container, { api: next, links, act, what });
      if (done) container.querySelector('.msg').textContent = done;
    } catch (e) { say(`Could not do that: ${e.message}`, false); }
  };
  const modeSel = el('select', { className: 'api-mode' },
    el('option', { value: 'after', textContent: 'After each question is finished (safe for a stream or a public page)' }),
    el('option', { value: 'live', textContent: 'As each question is read (staff tools only)' }));
  modeSel.value = api?.questions || 'after';
  const modeLabel = el('label', { className: 'select-label' }, 'Question text', modeSel);
  const docs = el('a', { href: '/game-api', target: '_blank', rel: 'noopener', textContent: 'What the data contains' });

  if (!api?.enabled) {
    container.replaceChildren(
      el('p', { className: 'hint' }, `A read-only key lets a stream overlay, a stats page or a script read ${what}'s games: the score, each player's line, buzzes, bonuses and question text. It can't change anything. `, docs, '.'),
      modeLabel,
      el('div', { className: 'row' }, el('button', { type: 'button', className: 'primary', textContent: 'Create a read-only key',
        onclick: () => run('enable', modeSel.value, 'Key created.') })),
      msg,
    );
    return;
  }
  modeSel.onchange = () => run('set', modeSel.value, 'Saved.');
  const copyRow = (label, value) => {
    const input = el('input', { type: 'text', value, readOnly: true, className: 'api-url' });
    input.setAttribute('aria-label', label);
    input.onfocus = () => input.select();
    const btn = el('button', { type: 'button', textContent: 'Copy' });
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(value); btn.textContent = 'Copied'; }
      catch { input.select(); btn.textContent = 'Press Ctrl+C'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    };
    return el('div', { className: 'api-row' }, el('span', { className: 'api-label', textContent: label }), el('div', { className: 'row field-row' }, input, btn));
  };
  container.replaceChildren(
    el('p', { className: 'hint' }, 'Read-only: anyone with these links can read the games, never change them. ', docs, '.'),
    copyRow('Key', api.key),
    ...links(api.key).map((l) => copyRow(l.label, l.url)),
    modeLabel,
    el('div', { className: 'row' },
      el('button', { type: 'button', textContent: 'Make a new key', onclick: () => {
        if (confirm('Make a new key? The current key and its links stop working.')) run('rotate', null, 'New key made. The old one no longer works.');
      } }),
      el('button', { type: 'button', className: 'ghost', textContent: 'Turn off', onclick: () => {
        if (confirm('Turn off the API? The key and its links stop working.')) run('disable', null, 'Turned off.');
      } })),
    msg,
  );
}
