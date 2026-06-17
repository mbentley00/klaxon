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

export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k);
  return node;
};
