// ---------------------------------------------------------------------------
// Optional reader accounts. Global (not per-tournament): a reader registers
// once, then requests access to a tournament that requires approved accounts
// (see artifacts.js memberships + the gate in index.js).
//
// Accounts and sessions both persist to disk: a deploy restarts the server,
// and it mustn't sign everyone out. Sessions are stored by the hash of their
// token (a copied sessions.json can't be replayed) and lapse after
// SESSION_IDLE_MS without use.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './artifacts.js';

const accountsFile = path.join(DATA_DIR, 'accounts.json');

const accounts = new Map();       // id -> { id, username, usernameLower, email, salt, hash, createdAt }
const byUsername = new Map();     // usernameLower -> id
const byEmail = new Map();        // email (lowercased) -> id
const sessions = new Map();       // sha256(sessionToken) -> { accountId, createdAt, lastSeen }
const sessionsFile = path.join(DATA_DIR, 'sessions.json');
const SESSION_IDLE_MS = 180 * 24 * 60 * 60 * 1000;
// lastSeen is only rewritten once a day per session, so ordinary use
// doesn't turn into a disk write per request.
const SEEN_GRANULARITY_MS = 24 * 60 * 60 * 1000;
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function loadFromDisk() {
  try {
    const arr = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    if (Array.isArray(arr)) {
      for (const a of arr) {
        if (!a?.id || !a?.username) continue;
        accounts.set(a.id, a);
        byUsername.set(a.username.toLowerCase(), a.id);
        if (a.email) byEmail.set(a.email, a.id);
      }
    }
  } catch { /* no accounts yet */ }
}
loadFromDisk();

function loadSessions() {
  try {
    const obj = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(obj || {})) {
      if (v?.accountId && now - (v.lastSeen || 0) < SESSION_IDLE_MS) sessions.set(k, v);
    }
  } catch { /* none yet */ }
}
loadSessions();

let sessionsTimer = null;
function saveSessionsSoon() {
  if (sessionsTimer) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${sessionsFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)));
      fs.renameSync(tmp, sessionsFile);
    } catch (e) { console.error('[accounts] session save failed', e.message); }
  }, 1000);
}

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

// Emails are optional and stored lowercased; a director can add a moderator to
// a tournament directly by email (see findByIdentifier). '' clears the email;
// null means "invalid input".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanEmail(v) {
  const s = String(v ?? '').trim().toLowerCase().slice(0, 80);
  if (s === '') return '';
  return EMAIL_RE.test(s) ? s : null;
}

export function register(username, password, displayName, email) {
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) return { error: 'bad_username' };
  if (String(password || '').length < 6) return { error: 'bad_password' };
  if (byUsername.has(name.toLowerCase())) return { error: 'username_taken' };
  const cleanedEmail = cleanEmail(email);
  if (cleanedEmail == null) return { error: 'bad_email' };
  if (cleanedEmail && byEmail.has(cleanedEmail)) return { error: 'email_taken' };
  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    id: id(), username: name, usernameLower: name.toLowerCase(),
    displayName: cleanDisplayName(displayName),
    email: cleanedEmail,
    salt, hash: hash(password, salt), createdAt: Date.now()
  };
  accounts.set(account.id, account);
  byUsername.set(account.usernameLower, account.id);
  if (account.email) byEmail.set(account.email, account.id);
  saveToDisk();
  return { account, sessionToken: startSession(account.id) };
}

export function setDisplayName(account, displayName) {
  account.displayName = cleanDisplayName(displayName);
  saveToDisk();
  return account;
}

// Player-facing preferences that follow the account between devices: the
// buzz sound, volume, mute, spoken names, and the team prefilled on join.
// Whitelisted keys, short string values; '' deletes a key.
const PREF_KEYS = new Set(['team', 'sound', 'volume', 'muted', 'disconnectSound', 'speakBuzz']);
export function setPrefs(account, prefs) {
  const out = { ...(account.prefs || {}) };
  for (const [k, v] of Object.entries(prefs && typeof prefs === 'object' ? prefs : {})) {
    if (!PREF_KEYS.has(k)) continue;
    const val = String(v ?? '').slice(0, 40);
    if (val === '') delete out[k]; else out[k] = val;
  }
  account.prefs = out;
  saveToDisk();
  return account;
}

export function setEmail(account, email) {
  const cleaned = cleanEmail(email);
  if (cleaned == null) return { error: 'bad_email' };
  if (cleaned && byEmail.get(cleaned) && byEmail.get(cleaned) !== account.id) return { error: 'email_taken' };
  if (account.email) byEmail.delete(account.email);
  account.email = cleaned;
  if (cleaned) byEmail.set(cleaned, account.id);
  saveToDisk();
  return { account };
}

// Admin, granted by another admin (see the admin list in index.js; the
// operator's own admins come from KLAXON_ADMINS and aren't stored here).
export function setAdmin(account, on) {
  if (on) account.admin = true; else delete account.admin;
  saveToDisk();
  return account;
}
export function storedAdmins() {
  return [...accounts.values()].filter((a) => a.admin === true);
}

// Look an account up the way a director types it: an email address (anything
// with an @) or a username.
export function findByIdentifier(identifier) {
  const s = String(identifier || '').trim().toLowerCase();
  if (!s) return null;
  const accountId = s.includes('@') ? byEmail.get(s) : byUsername.get(s);
  return accountId ? accounts.get(accountId) || null : null;
}

export function login(username, password) {
  const accountId = byUsername.get(String(username || '').trim().toLowerCase());
  const account = accountId && accounts.get(accountId);
  if (!account || !verify(password, account)) return { error: 'bad_credentials' };
  return { account, sessionToken: startSession(account.id) };
}

function startSession(accountId) {
  const t = token();
  const now = Date.now();
  sessions.set(tokenKey(t), { accountId, createdAt: now, lastSeen: now });
  saveSessionsSoon();
  return t;
}

export function accountForSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const key = tokenKey(sessionToken);
  const s = sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeen > SESSION_IDLE_MS) { sessions.delete(key); saveSessionsSoon(); return null; }
  if (now - s.lastSeen > SEEN_GRANULARITY_MS) { s.lastSeen = now; saveSessionsSoon(); }
  return accounts.get(s.accountId) || null;
}

// Signing out ends the session on the server too, not just in the browser.
export function endSession(sessionToken) {
  if (sessions.delete(tokenKey(sessionToken))) saveSessionsSoon();
}

export function getAccount(accountId) {
  return accounts.get(accountId) || null;
}

// Never leak the hash/salt. displayName is '' until the reader sets one;
// clients fall back to the username where a name must be shown.
export function publicAccount(account) {
  return account
    ? {
        id: account.id, username: account.username, displayName: account.displayName || '',
        email: account.email || '', prefs: account.prefs || {}
      }
    : null;
}

export const _internal = { accounts, sessions };
