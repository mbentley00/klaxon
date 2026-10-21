// Small shared helpers. No framework, no build step => fewer things to break.

// A stable per-browser identity so reconnects restore who you are.
export function playerId() {
  let id = localStorage.getItem('bz_playerId');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now() + '-' + Math.random().toString(36).slice(2);
    localStorage.setItem('bz_playerId', id);
  }
  return id;
}

export const remember = (k, v) => localStorage.setItem('bz_' + k, v);
export const recall = (k) => localStorage.getItem('bz_' + k);
export const forget = (k) => localStorage.removeItem('bz_' + k);

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// Read the text of the file currently chosen in a <input type="file">, or null
// if nothing is selected. Shared by the roster/packet upload flows.
export function readFileText(input) {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('could not read file'));
    fr.readAsText(file);
  });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
};

// A "Your tournaments" list: newest date first (undated ones — usually just
// created — at the top), and anything more than a month past folded into a
// collapsed "Older" section at the bottom. `row(t)` builds each <li>.
export function renderTournamentList(ul, tournaments, row) {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sorted = [...tournaments].sort((a, b) =>
    (b.date || '9999').localeCompare(a.date || '9999') || (a.name || a.code).localeCompare(b.name || b.code));
  const isOld = (t) => /^\d{4}-\d{2}-\d{2}/.test(t.date || '') && t.date < cutoff;
  const recent = sorted.filter((t) => !isOld(t));
  const older = sorted.filter(isOld);
  ul.innerHTML = '';
  for (const t of recent) ul.append(row(t));
  if (!older.length) return;
  const inner = el('ul', { className: 'players' });
  for (const t of older) inner.append(row(t));
  const det = el('details', { className: 'older-tournaments' },
    el('summary', {}, `Older (${older.length})`), inner);
  ul.append(el('li', { className: 'older-wrap' }, det));
}
