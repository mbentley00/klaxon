// ---------------------------------------------------------------------------
// Optional reader accounts. Global (not per-tournament): a reader registers
// once, then requests access to a tournament that requires approved accounts
// (see artifacts.js memberships + the gate in index.js).
//
// Accounts persist to disk (they matter across restarts); sessions are
// in-memory (readers just log in again after a restart).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './artifacts.js';

const accountsFile = path.join(DATA_DIR, 'accounts.json');

const accounts = new Map();       // id -> { id, username, usernameLower, salt, hash, createdAt }
const byUsername = new Map();     // usernameLower -> id
const sessions = new Map();       // sessionToken -> accountId

function loadFromDisk() {
  try {
    const arr = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    if (Array.isArray(arr)) {
      for (const a of arr) {
        if (!a?.id || !a?.username) continue;
        accounts.set(a.id, a);
        byUsername.set(a.username.toLowerCase(), a.id);
      }
    }
  } catch { /* no accounts yet */ }
}
loadFromDisk();

function saveToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${accountsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify([...accounts.values()], null, 2));
    fs.renameSync(tmp, accountsFile);
  } catch (e) { console.error('[accounts] save failed', e.message); }
}

const id = () => crypto.randomBytes(9).toString('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const hash = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');

function verify(password, account) {
  const computed = hash(password, account.salt);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(account.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;

// The person's name as shown to players/directors — free-form, unlike the
// username. Empty means "fall back to the username".
const cleanDisplayName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

export function register(username, password, displayName) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) return { error: 'bad_username' };
  if (String(password || '').length < 6) return { error: 'bad_password' };
  if (byUsername.has(name.toLowerCase())) return { error: 'username_taken' };
  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    id: id(), username: name, usernameLower: name.toLowerCase(),
    displayName: cleanDisplayName(displayName),
    salt, hash: hash(password, salt), createdAt: Date.now()
  };
  accounts.set(account.id, account);
  byUsername.set(account.usernameLower, account.id);
  saveToDisk();
  return { account, sessionToken: startSession(account.id) };
}

export function setDisplayName(account, displayName) {
  account.displayName = cleanDisplayName(displayName);
  saveToDisk();
  return account;
}

export function login(username, password) {
  const accountId = byUsername.get(String(username || '').trim().toLowerCase());
  const account = accountId && accounts.get(accountId);
  if (!account || !verify(password, account)) return { error: 'bad_credentials' };
  return { account, sessionToken: startSession(account.id) };
}

function startSession(accountId) {
  const t = token();
  sessions.set(t, accountId);
  return t;
}

export function accountForSession(sessionToken) {
  const accountId = sessionToken && sessions.get(sessionToken);
  return accountId ? accounts.get(accountId) || null : null;
}

export function getAccount(accountId) {
  return accounts.get(accountId) || null;
}

// Never leak the hash/salt. displayName is '' until the reader sets one;
// clients fall back to the username where a name must be shown.
export function publicAccount(account) {
  return account
    ? { id: account.id, username: account.username, displayName: account.displayName || '' }
    : null;
}

export const _internal = { accounts, sessions };
