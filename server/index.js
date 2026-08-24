import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';

import { PORT, DEFAULTS } from './config.js';
import * as store from './store.js';
import * as artifacts from './artifacts.js';
import { computeStats, liveGameRows, protestRows } from './stats.js';
import { renderReport, PAGES } from './yellowfruit.js';
import { buildZip } from './zip.js';
import * as accounts from './accounts.js';
import { parseYellowFruit, planImport } from './yfimport.js';
import { parseQbjRoster } from './qbjroster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Buzz payloads are tiny, but MODAQ-mode artifacts (round packets, exported
// match QBJ) can be a few hundred KB, so allow a larger JSON body.
app.use(express.json({ limit: '4mb' }));

// Canonical host. Every other hostname the app is reachable on (the fly.dev
// name, legacy domains) gets a permanent redirect so shared links, which are
// built from location.origin in the browser, always use the canonical domain.
// Health checks are exempt so Fly's probes (which hit the internal address)
// keep passing. Unset KLAXON_CANONICAL_HOST (e.g. local dev) disables this.
const CANONICAL_HOST = (process.env.KLAXON_CANONICAL_HOST || '').trim().toLowerCase();
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    if (!host || host === CANONICAL_HOST) return next();
    res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  });
}

// Wrap an async route handler so a rejected promise becomes a 500 instead of an
// unhandled rejection.
const ah = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!res.headersSent) res.status(e?.status || 500).json({ error: e?.message || 'error' });
});

// A room-scoped MODAQ artifact call is authorized by any staff token for that
// room (reader or co-reader), or — if the room is in a tournament — that
// tournament's director token. Token comes from the query (GET) or body.
function roomStaffOk(room, token) {
  if (!token) return false;
  if (token === room.readerToken || token === room.coReaderToken) return true;
  if (room.tournamentCode) {
    const t = store.getTournament(room.tournamentCode);
    if (t && token === t.directorToken) return true;
  }
  return false;
}

// A logged-in account that a director approved for the room's tournament is a
// moderator credential in its own right — no reader-token link required.
// Returns true, or why not: 'no_tournament' | 'not_logged_in' | 'not_approved'.
async function accountModeratorOk(room, sessionToken) {
  if (!room.tournamentCode) return 'no_tournament';
  const account = accounts.accountForSession(sessionToken);
  if (!account) return 'not_logged_in';
  const status = await artifacts.memberStatus({ kind: 't', code: room.tournamentCode }, account.id);
  return status === 'approved' ? true : 'not_approved';
}

// Room-scoped MODAQ artifact calls take either credential.
async function roomModOk(room, token, sessionToken) {
  if (roomStaffOk(room, token)) return true;
  return (await accountModeratorOk(room, sessionToken)) === true;
}

const publicDir = path.join(__dirname, '..', 'public');

// The MODAQ moderator bundle (built from the MODAQ repo into public/modaq/).
// Serve its entry HTML at the clean /modaq URL. This must run BEFORE the static
// middleware, which would otherwise 301-redirect /modaq to /modaq/ (a directory
// with no index.html) and 404. Its assets under /modaq/out/ are plain static
// files handled below.
app.get(['/modaq', '/modaq/'], (_req, res) =>
  res.sendFile(path.join(publicDir, 'modaq', 'moderator.html')));

app.use(express.static(publicDir));

// --- REST: create rooms/tournaments (the "really easy to create" path) -----
// Creation returns the secret reader/director token ONCE. The client stores it
// locally and presents it over the socket to perform privileged actions.

app.post('/api/rooms', (req, res) => {
  const { name, tournamentCode, settings } = req.body || {};
  const room = store.createRoom({ name, tournamentCode, settings });
  res.json({
    code: room.code,
    name: room.name,
    readerToken: room.readerToken,
    coReaderToken: room.coReaderToken
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'not_found' });
  res.json({
    code: room.code, name: room.name, tournamentCode: room.tournamentCode,
    // The join gate needs this before joining, to ask for a team up front.
    requireTeam: !!room.settings.requireTeam
  });
});

app.post('/api/tournaments', (req, res) => {
  const { name, schedule, defaults, format, requireReaderAccounts, date, listed } = req.body || {};
  const t = store.createTournament({ name, schedule, defaults, format, requireReaderAccounts, date, listed });
  res.json({ code: t.code, directorToken: t.directorToken, name: t.name, defaults: t.roomDefaults, format: t.format });
});

// Public directory of listed tournaments (browse + request to moderate).
app.get('/api/tournaments', (_req, res) => {
  res.json({ tournaments: store.listTournaments() });
});

app.get('/api/tournaments/:code', (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({
    code: t.code, name: t.name, date: t.date || '', schedule: t.schedule, rooms: [...t.roomCodes],
    defaults: t.roomDefaults, format: t.format, requireReaderAccounts: !!t.requireReaderAccounts,
    links: t.links || { schedule: '', discord: '' },
    autoRelease: t.autoRelease === true
  });
});

// --- reader accounts (optional) --------------------------------------------
app.post('/api/accounts/register', (req, res) => {
  const r = accounts.register(req.body?.username, req.body?.password, req.body?.displayName, req.body?.email);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ sessionToken: r.sessionToken, account: accounts.publicAccount(r.account) });
});

app.post('/api/accounts/login', (req, res) => {
  const r = accounts.login(req.body?.username, req.body?.password);
  if (r.error) return res.status(401).json({ error: r.error });
  res.json({ sessionToken: r.sessionToken, account: accounts.publicAccount(r.account) });
});

app.get('/api/accounts/me', (req, res) => {
  const account = accounts.accountForSession(req.query.sessionToken);
  if (!account) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ account: accounts.publicAccount(account) });
});

// Update the display name (the name players see, distinct from the username)
// and/or the email a director can add the reader to a tournament by.
app.patch('/api/accounts/me', (req, res) => {
  const account = accounts.accountForSession(req.body?.sessionToken);
  if (!account) return res.status(401).json({ error: 'not_logged_in' });
  if (req.body?.displayName !== undefined) accounts.setDisplayName(account, req.body.displayName);
  if (req.body?.email !== undefined) {
    const r = accounts.setEmail(account, req.body.email);
    if (r.error) return res.status(400).json({ error: r.error });
  }
  res.json({ account: accounts.publicAccount(account) });
});

// A logged-in reader requests access to a tournament; the director approves.
app.post('/api/tournaments/:code/access', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  const account = accounts.accountForSession(req.body?.sessionToken);
  if (!account) return res.status(401).json({ error: 'not_logged_in' });
  const m = await artifacts.requestMembership({ kind: 't', code: t.code }, account.id, account.username);
  res.json({ status: m.status });
}));

// A reader checks their own access status for a tournament. `status` answers
// "may I read the packets?" (auto-approved when the tournament doesn't gate
// readers); `memberStatus` is the actual membership, which is what account-
// based moderation (joining a room without a reader link) requires.
app.get('/api/tournaments/:code/access', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  const account = accounts.accountForSession(req.query.sessionToken);
  const memberStatus = account
    ? await artifacts.memberStatus({ kind: 't', code: t.code }, account.id)
    : null;
  if (!t.requireReaderAccounts) return res.json({ required: false, status: 'approved', memberStatus });
  res.json({ required: true, status: account ? memberStatus : null, memberStatus });
}));

// Director lists / approves / denies reader accounts.
app.get('/api/tournaments/:code/members', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ members: await artifacts.getMembers({ kind: 't', code: t.code }) });
}));

// Director adds a moderator directly by the email (or username) of a
// registered account — pre-approved, no request/approve round-trip.
app.post('/api/tournaments/:code/members', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const account = accounts.findByIdentifier(req.body?.identifier);
  if (!account) return res.status(404).json({ error: 'account_not_found' });
  const bucket = { kind: 't', code: t.code };
  await artifacts.requestMembership(bucket, account.id, account.username);
  const member = await artifacts.setMemberStatus(bucket, account.id, 'approved');
  res.json({ member });
}));

app.put('/api/tournaments/:code/members/:accountId', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const m = await artifacts.setMemberStatus({ kind: 't', code: t.code }, req.params.accountId, req.body?.status);
  if (!m) return res.status(404).json({ error: 'not_found' });
  res.json({ member: m });
}));

app.put('/api/tournaments/:code/schedule', (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if ((req.body?.directorToken || '') !== t.directorToken) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const schedule = store.setSchedule(t, req.body?.schedule || []);
  res.json({ schedule });
});

// Player-facing links (schedule page, Discord server), shown in every room.
app.put('/api/tournaments/:code/links', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ links: store.setLinks(t, req.body?.links || {}) });
});

// The director fetches (and thereby mints) the player landing-page link — a
// secret URL players can be given without making the tournament public.
app.get('/api/tournaments/:code/player-link', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ url: `/tp/${t.code}?key=${store.ensurePlayerKey(t)}` });
});

// Everything the player landing page shows, gated by the secret key.
app.get('/api/tournaments/:code/player-view', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!t.playerKey || String(req.query.key || '') !== t.playerKey) {
    return res.status(403).json({ error: 'bad_key' });
  }
  const rooms = [...t.roomCodes]
    .map((rc) => store.getRoom(rc))
    .filter(Boolean)
    .map((r) => ({ code: r.code, name: r.name }));
  res.json({
    code: t.code,
    name: t.name,
    date: t.date || '',
    links: t.links || { schedule: '', discord: '' },
    schedule: t.schedule,
    rooms,
    statsPath: `/t/${t.code}/stats/standings`,
  });
});

// Director sends a message to the readers of one room (or every room). It
// reaches STAFF sockets only — players never see it — and the last few are
// kept on each room so a moderator who connects later still gets them.
app.post('/api/tournaments/:code/message', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const text = String(req.body?.text ?? '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'empty_message' });
  const target = String(req.body?.room ?? 'ALL').toUpperCase();
  const targets = target === 'ALL' ? [...t.roomCodes] : [target];
  const message = { text, at: Date.now() };
  let rooms = 0;
  let delivered = 0;
  for (const rc of targets) {
    const room = store.getRoom(rc);
    if (!room || room.tournamentCode !== t.code) continue;
    rooms++;
    room.directorMessages = [...(room.directorMessages || []), message].slice(-5);
    delivered += emitToStaff(room.code, 'director_message', message);
  }
  if (rooms === 0) return res.status(404).json({ error: 'no_matching_rooms' });
  res.json({ ok: true, rooms, delivered });
});

// Toggle automatic packet release (see maybeAutoRelease).
app.put('/api/tournaments/:code/auto-release', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ autoRelease: store.setAutoRelease(t, req.body?.enabled === true) });
});

// --- MODAQ artifacts: tournament-scoped (director console) ------------------
// The tournament director uploads the default roster, manages round packets
// centrally, and retrieves every room's exported QBJ + errata. All gated by the
// director token.

function tournamentOr(res, code) {
  const t = store.getTournament(code);
  if (!t) { res.status(404).json({ error: 'not_found' }); return null; }
  return t;
}
function directorOk(t, token) { return token && token === t.directorToken; }

app.put('/api/tournaments/:code/roster', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  if (typeof req.body?.roster !== 'string') return res.status(400).json({ error: 'missing_roster' });
  await artifacts.saveRoster({ kind: 't', code: t.code }, req.body.roster);
  res.json({ ok: true });
}));

app.get('/api/tournaments/:code/roster', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const roster = await artifacts.getRoster({ kind: 't', code: t.code });
  res.json({ roster });
}));

// Director uploads a round packet. Defaults to hidden from moderators (they get
// it once the director makes the round visible).
app.post('/api/tournaments/:code/packets', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const packet = typeof req.body?.packet === 'string' ? req.body.packet : JSON.stringify(req.body?.packet);
  const visible = typeof req.body?.visible === 'boolean' ? req.body.visible : false;
  const tiebreaker = typeof req.body?.tiebreaker === 'boolean' ? req.body.tiebreaker : false;
  const saved = await artifacts.savePacket({ kind: 't', code: t.code }, req.body?.round, packet, { visible, tiebreaker });
  res.json(saved);
}));

app.get('/api/tournaments/:code/packets', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ packets: await artifacts.listPackets({ kind: 't', code: t.code }) });
}));

// Director releases (or re-hides) a round to moderators.
app.put('/api/tournaments/:code/packets/:round/visibility', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const saved = await artifacts.setPacketVisibility({ kind: 't', code: t.code }, req.params.round, !!req.body?.visible);
  res.json(saved);
}));

// Director marks (or unmarks) a round as a tiebreaker-question pool.
app.put('/api/tournaments/:code/packets/:round/tiebreaker', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const saved = await artifacts.setPacketTiebreaker({ kind: 't', code: t.code }, req.params.round, !!req.body?.tiebreaker);
  res.json(saved);
}));

// TD view of tiebreaker packets + which questions have been used, by whom.
app.get('/api/tournaments/:code/tiebreakers', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const bucket = { kind: 't', code: t.code };
  const [tossups, usage] = await Promise.all([artifacts.getTiebreakerTossups(bucket), artifacts.getTiebreakerUsage(bucket)]);
  res.json({ tossups, usage });
}));

app.get('/api/tournaments/:code/exports', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ exports: await artifacts.listExports({ kind: 't', code: t.code }) });
}));

app.get('/api/tournaments/:code/exports/:filename', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const text = await artifacts.getExport({ kind: 't', code: t.code }, req.params.filename);
  if (text == null) return res.status(404).json({ error: 'not_found' });
  res.type('application/json').send(text);
}));

app.get('/api/tournaments/:code/errata', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ errata: await artifacts.getErrata({ kind: 't', code: t.code }) });
}));

// Import a YellowFruit file: games the director fixed locally in YF override
// the matching synced exports (same round + same teams); games we've never
// seen are added under a synthetic "YF" room.
app.post('/api/tournaments/:code/yf-import', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  let fileObj = req.body?.yft;
  if (typeof fileObj === 'string') {
    try { fileObj = JSON.parse(fileObj); } catch { return res.status(400).json({ error: 'not_json' }); }
  }
  let games;
  try { games = parseYellowFruit(fileObj); }
  catch { return res.status(400).json({ error: 'bad_yf_file' }); }
  if (games.length === 0) return res.status(400).json({ error: 'no_games_in_file' });

  const bucket = { kind: 't', code: t.code };
  const existing = await artifacts.readAllExports(bucket);
  const plan = planImport(games, existing);
  let updated = 0, added = 0;
  for (const step of plan) {
    await artifacts.saveExport(bucket, {
      room: step.room, round: step.round,
      qbj: { ...step.match, _yfImported: true },
      inProgress: false, at: Date.now()
    });
    if (step.action === 'update') updated++; else added++;
  }
  res.json({ updated, added });
}));

// Protests lodged in MODAQ, with whether each can still change its game's
// result (pending while live, then matters/moot once the game is final,
// or the director's upheld/denied ruling).
app.get('/api/tournaments/:code/protests', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const matches = await artifacts.readAllExports({ kind: 't', code: t.code });
  res.json({ protests: protestRows(matches) });
}));

// The director rules on a protest: upheld (with per-team point adjustments
// that correct the game score in stats), denied, or cleared (status null).
app.put('/api/tournaments/:code/protests/ruling', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const { room, round, type, question, part, team, status, note, adjustments } = req.body || {};
  const ruling = await artifacts.setProtestRuling({ kind: 't', code: t.code },
    { room, round, type, question, part, team, status, note, adjustments });
  if (ruling == null) return res.status(404).json({ error: 'match_not_found' });
  res.json({ ruling });
}));

// One-click "download all stats": every match's QBJ plus errata, bundled into a
// single JSON file the director can save.
app.get('/api/tournaments/:code/stats', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const bucket = { kind: 't', code: t.code };
  const [matches, errata] = await Promise.all([
    artifacts.readAllExports(bucket),
    artifacts.getErrata(bucket)
  ]);
  const body = JSON.stringify(
    { tournament: t.code, name: t.name, generatedAt: Date.now(), matches, errata },
    null, 2
  );
  res.setHeader('Content-Disposition', `attachment; filename="${t.code}-stats.json"`);
  res.type('application/json').send(body);
}));

// --- MODAQ artifacts: room-scoped (the moderator's reader page) -------------
// Everything the embedded MODAQ reader needs, keyed to the room's bucket (its
// tournament's, or its own). Gated by the room's staff token (or director
// token). Reads are token-gated too, so players can't fetch the packet answers.

function roomOr(res, code) {
  const room = store.getRoom(code);
  if (!room) { res.status(404).json({ error: 'not_found' }); return null; }
  return room;
}
const reqToken = (req) => req.body?.token || req.query.token;
const reqSession = (req) => req.body?.sessionToken || req.query.sessionToken;

// When a room's tournament requires reader accounts, accessing its centralized
// packets additionally needs a director-approved account session.
async function readerAccessOk(room, sessionToken) {
  const t = room.tournamentCode ? store.getTournament(room.tournamentCode) : null;
  if (!t || !t.requireReaderAccounts) return true;
  const account = accounts.accountForSession(sessionToken);
  if (!account) return false;
  const status = await artifacts.memberStatus({ kind: 't', code: t.code }, account.id);
  return status === 'approved';
}
const ACCESS_DENIED = { error: 'account_not_approved' };

app.get('/api/rooms/:code/roster', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  res.json({ roster: await artifacts.getRoster(store.bucketForRoom(room)) });
}));

// The room's BUZZER roster: staff upload a QBJ registration file (or, with no
// `qbj` body, pull the tournament's central roster) so each connected buzzer can
// be labelled with the real player behind it. Parsed here rather than in the
// browser so both paths share one parser and every client sees the same teams.
app.put('/api/rooms/:code/buzzer-roster', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  let source = req.body?.qbj;
  if (source == null) {
    if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
    source = await artifacts.getRoster(store.bucketForRoom(room));
    if (source == null) return res.status(404).json({ error: 'no_tournament_roster' });
  }
  let roster;
  try { roster = parseQbjRoster(source); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  store.setRoster(room, roster);
  emitState(room);
  res.json({ roster: store.publicState(room).roster });
}));

// Moderators only see rounds the director has made visible.
app.get('/api/rooms/:code/packets', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  const list = await artifacts.listPackets(store.bucketForRoom(room));
  res.json({ packets: list.filter((p) => p.visible).map((p) => p.round) });
}));

app.post('/api/rooms/:code/packets', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  const packet = typeof req.body?.packet === 'string' ? req.body.packet : JSON.stringify(req.body?.packet);
  // A moderator uploading their own round makes it usable (visible) right away.
  const saved = await artifacts.savePacket(store.bucketForRoom(room), req.body?.round, packet, { visible: true });
  res.json(saved);
}));

app.get('/api/rooms/:code/packets/:round', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  const bucket = store.bucketForRoom(room);
  // Enforce visibility: a moderator can only fetch a round the director released.
  if (!(await artifacts.isPacketVisible(bucket, req.params.round))) return res.status(404).json({ error: 'not_found' });
  const text = await artifacts.getPacket(bucket, req.params.round);
  if (text == null) return res.status(404).json({ error: 'not_found' });
  res.type('application/json').send(text);
}));

// The persisted MASSINGER pick/ban board for a round (null body if none).
// The moderator page uses it on reload to re-apply the ban filter to the
// packet before handing it to MODAQ.
app.get('/api/rooms/:code/massinger/:round', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  res.json({ massinger: await artifacts.getMassinger(room.code, req.params.round) });
}));

// Released tiebreaker questions the moderator can sub in.
app.get('/api/rooms/:code/tiebreakers', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  res.json({ tiebreakers: await artifacts.getTiebreakerTossups(store.bucketForRoom(room)) });
}));

// Moderator reports that a tiebreaker question was read (and to which teams).
app.post('/api/rooms/:code/tiebreaker-used', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  await artifacts.addTiebreakerUsage(store.bucketForRoom(room), {
    tbRound: req.body?.tbRound, questionNumber: req.body?.questionNumber,
    room: room.code, gameRound: req.body?.gameRound, teams: req.body?.teams,
  });
  res.json({ ok: true });
}));

app.post('/api/rooms/:code/export', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  if (req.body?.qbj == null) return res.status(400).json({ error: 'missing_qbj' });
  const saved = await artifacts.saveExport(store.bucketForRoom(room), {
    room: room.code, round: req.body?.round, qbj: req.body.qbj,
    inProgress: req.body?.inProgress === true,
    currentQuestion: Number(req.body?.currentQuestion) || undefined,
    at: Date.now()
  });
  // Anyone the moderator added mid-game joins the shared roster (best-effort).
  try {
    const match = typeof req.body.qbj === 'string' ? JSON.parse(req.body.qbj) : req.body.qbj;
    await artifacts.addMatchPlayersToRoster(store.bucketForRoom(room), match);
  } catch { /* roster sync must never fail the export */ }
  // A final sync may complete its round; auto-release the next packet if the
  // director opted in (best-effort).
  if (req.body?.inProgress !== true) {
    try { await maybeAutoRelease(room, String(req.body?.round ?? '')); } catch { /* ignore */ }
  }
  res.json(saved);
}));

// If every expected room's game in `round` is final, make the next hidden
// (non-tiebreaker) packet visible to moderators. "Expected" comes from the
// schedule when it lists rooms for the round, otherwise every room that has
// synced any match so far.
async function maybeAutoRelease(room, round) {
  const t = room.tournamentCode ? store.getTournament(room.tournamentCode) : null;
  if (!t || t.autoRelease !== true) return;
  const bucket = { kind: 't', code: t.code };
  const matches = await artifacts.readAllExports(bucket);
  const roundMatches = matches.filter((m) => String(m.qbj?._round ?? '') === round);
  if (roundMatches.length === 0 || roundMatches.some((m) => m.qbj?._inProgress === true)) return;
  const played = new Set(roundMatches.map((m) => String(m.qbj?._room || '').toUpperCase()));
  let expected = t.schedule
    .filter((s) => String(s.round) === round && s.room)
    .map((s) => s.room.toUpperCase());
  if (expected.length === 0) {
    expected = [...new Set(matches.map((m) => String(m.qbj?._room || '').toUpperCase()))].filter(Boolean);
  }
  if (!expected.every((rc) => played.has(rc))) return;

  const packets = await artifacts.listPackets(bucket);
  const next = packets
    .filter((p) => !p.visible && !p.tiebreaker)
    .sort((a, b) => {
      const na = Number(a.round), nb = Number(b.round);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.round).localeCompare(String(b.round));
    })[0];
  if (!next) return;
  await artifacts.setPacketVisibility(bucket, next.round, true);
  console.log(`auto-released packet "${next.round}" for tournament ${t.code} (round ${round} complete)`);
}

app.get('/api/rooms/:code/exports', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  res.json({ exports: await artifacts.listExports(store.bucketForRoom(room)) });
}));

app.get('/api/rooms/:code/exports/:filename', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  const text = await artifacts.getExport(store.bucketForRoom(room), req.params.filename);
  if (text == null) return res.status(404).json({ error: 'not_found' });
  res.type('application/json').send(text);
}));

app.get('/api/rooms/:code/errata', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  res.json({ errata: await artifacts.getErrata(store.bucketForRoom(room)) });
}));

app.put('/api/rooms/:code/errata', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  const merged = await artifacts.replaceErrataForScope(
    store.bucketForRoom(room),
    { room: room.code, round: req.body?.round },
    req.body?.entries || []
  );
  res.json({ errata: merged });
}));

// --- Public live stats (YellowFruit-style report) --------------------------
// Stats are public at a tournament, so these need no token — only the packet
// answers stay gated. Built live from the synced match QBJs.

const REPORT_PAGES = new Set(PAGES.map((p) => p.key));

async function statsFor(code) {
  const t = store.getTournament(code);
  const upper = String(code || '').toUpperCase();
  const bucket = { kind: 't', code: t ? t.code : upper };
  // Read straight from the disk bucket so stats survive a server restart even
  // though the in-memory tournament object doesn't.
  let matches = [];
  try { matches = await artifacts.readAllExports(bucket); } catch { matches = []; }
  if (!t && matches.length === 0) return null;
  const structure = await artifacts.getStructure(bucket).catch(() => null);
  return { t: t || { code: upper, name: upper }, stats: computeStats(matches, structure), matchCount: matches.length };
}

// Director sets/gets the tournament structure (phases + divisions). The GET also
// returns the known rounds + team names to populate the editor.
app.get('/api/tournaments/:code/structure', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const bucket = { kind: 't', code: t.code };
  const [structure, matches] = await Promise.all([artifacts.getStructure(bucket), artifacts.readAllExports(bucket)]);
  const bare = computeStats(matches);
  res.json({
    structure: structure || { phases: [], divisions: [] },
    teams: bare.teamsGlobal.map((x) => x.name).sort(),
    rounds: bare.rounds.map((x) => x.round),
  });
}));

app.put('/api/tournaments/:code/structure', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const saved = await artifacts.saveStructure({ kind: 't', code: t.code }, req.body?.structure || {});
  res.json({ structure: saved });
}));

// Games currently being read: score so far, question progress, elapsed time.
// Public, like the rest of the live stats — no token needed.
app.get('/api/tournaments/:code/live', ah(async (req, res) => {
  const upper = String(req.params.code || '').toUpperCase();
  const t = store.getTournament(upper);
  const bucket = { kind: 't', code: t ? t.code : upper };
  let matches = [];
  try { matches = await artifacts.readAllExports(bucket); } catch { matches = []; }
  if (!t && matches.length === 0) return res.status(404).json({ error: 'not_found' });
  const live = matches.filter((m) => m?.qbj?._inProgress === true);
  res.json({ games: liveGameRows(live), now: Date.now() });
}));

// Links between the served report pages (relative to /t/CODE/stats/).
const servedLink = (page, hash) => `${page}${hash ? '#' + hash : ''}`;

app.get('/t/:code/stats', (req, res) => res.redirect(`/t/${req.params.code}/stats/standings`));

app.get('/t/:code/stats/:page', ah(async (req, res) => {
  const page = req.params.page.replace(/\.html$/, '');
  if (!REPORT_PAGES.has(page)) return res.status(404).send('Unknown report page.');
  const data = await statsFor(req.params.code);
  if (!data) return res.status(404).send('Tournament not found.');
  // Served pages are the live view: auto-refresh so a projected standings stays
  // current as moderators sync (the Live Games page refreshes faster). The
  // downloaded zip keeps the pristine YF format.
  const html = renderReport(page, data.stats, servedLink)
    .replace('<HEAD>', `<HEAD>\n<meta http-equiv="refresh" content="${page === 'live' ? 20 : 60}">`);
  res.type('html').send(html);
}));

// Download the whole report as a YellowFruit-style set of HTML files, zipped.
app.get('/t/:code/stats.zip', ah(async (req, res) => {
  const data = await statsFor(req.params.code);
  if (!data) return res.status(404).send('Tournament not found.');
  const base = (data.t.name || data.t.code).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || data.t.code;
  const zipLink = (page, hash) => `${base}_${page}.html${hash ? '#' + hash : ''}`;
  const zipPages = PAGES.filter((p) => !p.servedOnly);
  const files = zipPages.map((p) => ({ name: `${base}_${p.key}.html`, data: renderReport(p.key, data.stats, zipLink, zipPages) }));
  const zip = buildZip(files);
  res.setHeader('Content-Disposition', `attachment; filename="${base}_stats.zip"`);
  res.type('application/zip').send(zip);
}));

app.get('/healthz', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.get('/about', (_req, res) => res.sendFile(path.join(publicDir, 'about.html')));

// advanced room creation (the options the home page leaves out)
app.get('/advanced', (_req, res) => res.sendFile(path.join(publicDir, 'advanced.html')));

// tournament hub: create / open / browse, plus reader accounts
app.get('/tournament-mode', (_req, res) => res.sendFile(path.join(publicDir, 'tournament-mode.html')));

// create-tournament page
app.get('/new-tournament', (_req, res) => res.sendFile(path.join(publicDir, 'new-tournament.html')));

// reader account page
app.get('/account', (_req, res) => res.sendFile(path.join(publicDir, 'account.html')));

// public tournament directory (browse + request to moderate)
app.get('/tournaments', (_req, res) => res.sendFile(path.join(publicDir, 'directory.html')));

// tournament director console
app.get('/t/:code', (_req, res) => res.sendFile(path.join(publicDir, 'tournament.html')));

// Player landing page for a whole tournament (content is key-gated by the API).
app.get('/tp/:code', (_req, res) => res.sendFile(path.join(publicDir, 'player-tournament.html')));

// room.html serves any /r/CODE deep link
app.get('/r/:code', (_req, res) => res.sendFile(path.join(publicDir, 'room.html')));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // websocket-first with polling fallback => reliable behind hostile proxies
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 8000
});

// ---------------------------------------------------------------------------
// Per-socket runtime state: which room/player, and the AUTHORITATIVE round
// trip time the server measured itself (used to clamp buzz timestamps so a
// client cannot claim a physically impossible early press).
// ---------------------------------------------------------------------------
const sock = new Map(); // socket.id -> { roomCode, playerId, minRtt }

// --- MASSINGER: server-side pick clock --------------------------------------
// The per-pick timer has to be enforced here, not in the moderator's browser:
// the teams are picking from their own pages, and a closed laptop must not
// stall the phase. When the deadline passes the server bans at random for the
// team on the clock, exactly as the rules require.
const massingerTimers = new Map();   // room code -> timeout handle

function clearMassingerTimer(code) {
  const handle = massingerTimers.get(code);
  if (handle) {
    clearTimeout(handle);
    massingerTimers.delete(code);
  }
}

function armMassingerTimer(room) {
  clearMassingerTimer(room.code);
  const m = room.massinger;
  if (!m || m.status !== 'active' || !m.deadline) return;
  const wait = Math.max(0, m.deadline - Date.now());
  massingerTimers.set(room.code, setTimeout(() => {
    massingerTimers.delete(room.code);
    const live = store.getRoom(room.code);
    if (!live || live.massinger !== m || m.status !== 'active') return;
    const result = store.massingerRandomBan(live, 'timeout');
    if (result.error) return;
    persistMassinger(live);
    emitState(live);
    armMassingerTimer(live);          // next team is now on the clock
  }, wait));
}

function persistMassinger(room) {
  const m = room.massinger;
  if (!m) return;
  artifacts.saveMassinger(room.code, m.round, m).catch((e) => console.error('persist massinger failed:', e));
}

// Everything that changes the board funnels through here: persist it, push it
// to every client, and re-arm the clock for whoever is now picking.
function afterMassingerChange(room) {
  persistMassinger(room);
  armMassingerTimer(room);
  emitState(room);
}

function emitState(room) {
  io.to(room.code).emit('state', store.publicState(room));
}

// Deliver an event to a room's staff sockets only (reader/co-reader) — used
// for director messages, which players must never receive.
function emitToStaff(roomCode, event, payload) {
  let delivered = 0;
  for (const [sid, ctx] of sock) {
    if (ctx.roomCode === roomCode && ctx.staffRole) {
      const sk = io.sockets.sockets.get(sid);
      if (sk) { sk.emit(event, payload); delivered++; }
    }
  }
  return delivered;
}

// Eject a player's live socket(s) from a room (after the reader removes them).
function kickPlayer(room, playerId, reason) {
  for (const [sid, ctx] of sock) {
    if (ctx.roomCode === room.code && ctx.playerId === playerId) {
      const sk = io.sockets.sockets.get(sid);
      if (sk) { sk.emit('kicked', { reason }); sk.leave(room.code); }
      ctx.roomCode = null;
      ctx.playerId = null;
    }
  }
}

// "Staff" = reader or co-reader. Both may control the buzzer and scores.
function isStaff(socket, room) {
  const ctx = sock.get(socket.id);
  return !!ctx?.staffRole && ctx?.roomCode === room.code;
}

io.on('connection', (socket) => {
  sock.set(socket.id, { minRtt: 120 }); // optimistic default until measured

  // --- clock sync (client-initiated, NTP-like) ---------------------------
  // Client sends t0; we reply with our serverTime. Client does the math over
  // several samples and keeps the lowest-RTT estimate.
  socket.on('clock_sync', (_payload, ack) => {
    if (typeof ack === 'function') ack({ serverTime: Date.now() });
  });

  // --- server-initiated RTT probe (anti-cheat) ---------------------------
  // We measure RTT ourselves so the clamp bound can't be inflated by a client.
  // A round-trip the SERVER times: it emits `event` and waits for the client's
  // ack. We keep the minimum (best) sample in ctx[targetKey]. Samples larger
  // than maxRttSampleMs are dropped so a stalled/timed-out ack can't poison the
  // estimate (a client can only ever make a probe look *slower*, never faster).
  function measureRtt(event, targetKey) {
    const sent = Date.now();
    socket.timeout(DEFAULTS.rttProbeTimeoutMs).emit(event, { sent }, (err) => {
      if (err) return;
      const rtt = Date.now() - sent;
      if (rtt > DEFAULTS.maxRttSampleMs) return;
      const ctx = sock.get(socket.id);
      if (ctx) ctx[targetKey] = Math.min(ctx[targetKey] ?? rtt, rtt);
    });
  }
  const probeRtt = () => measureRtt('srv_ping', 'minRtt');
  for (let i = 0; i < 5; i++) setTimeout(probeRtt, i * 400);
  const rttTimer = setInterval(probeRtt, 15000);

  // --- join --------------------------------------------------------------
  socket.on('join', async (payload, ack) => {
    const room = store.getRoom(payload?.roomCode);
    if (!room) return ack?.({ error: 'no_room' });

    // The presented credential determines the ACTUAL authority, not the
    // requested role — so a co-reader link can never grant full-reader powers,
    // and a bad token silently downgrades to spectator. Besides the room's
    // staff tokens, a logged-in account the director approved for the room's
    // tournament also authorizes as reader (denyReason says why when not).
    const requested = payload?.role;
    const token = payload?.staffToken;
    let role = 'player';
    let staffRole = null;
    let staffDenied = false;
    let denyReason = null;
    if (requested === 'spectator') {
      role = 'spectator';
    } else if (requested === 'reader' || requested === 'co-reader') {
      if (token && token === room.readerToken) role = staffRole = 'reader';
      else if (token && token === room.coReaderToken) role = staffRole = 'co-reader';
      else {
        let viaAccount = 'error';
        try { viaAccount = await accountModeratorOk(room, payload?.sessionToken); } catch { /* fall through */ }
        if (viaAccount === true) role = staffRole = 'reader';
        else { role = 'spectator'; staffDenied = true; denyReason = viaAccount; }
      }
    }

    // "Require team name": players must identify their team before the room
    // admits them. Staff and spectators are exempt, and a member who already
    // has a team on record keeps it across reconnects without resending it.
    if (role === 'player' && room.settings.requireTeam) {
      const known = room.members.get(payload?.playerId)?.team;
      if (!String(payload?.team ?? known ?? '').trim()) return ack?.({ error: 'team_required' });
    }

    const member = store.joinRoom(room, {
      playerId: payload?.playerId,
      name: payload?.name,
      role,
      team: payload?.team
    });

    // A player who joins after the teams were set still gets linked to their
    // MODAQ player, so their buzzes report the right name.
    if (role === 'player' && room.roster) {
      try { store.autoLinkRosterPlayers(room); } catch { /* linking is best-effort */ }
    }

    socket.join(room.code);
    sock.set(socket.id, {
      ...sock.get(socket.id),
      roomCode: room.code,
      playerId: member.id,
      staffRole
    });

    ack?.({
      ok: true,
      playerId: member.id,
      role: member.role,
      staffDenied,
      denyReason,
      // Only a full reader is trusted to mint co-reader invite links.
      coReaderToken: staffRole === 'reader' ? room.coReaderToken : undefined,
      state: store.publicState(room),
      serverTime: Date.now()
    });
    emitState(room);

    // Replay recent director messages to a (re)joining staff member, so a
    // moderator who connects after the director sent one still sees it.
    if (staffRole && Array.isArray(room.directorMessages)) {
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const m of room.directorMessages) {
        if (m.at >= cutoff) socket.emit('director_message', m);
      }
    }
  });

  // --- buzz (the latency-fair core) -------------------------------------
  socket.on('buzz', (payload) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return;

    const arrival = Date.now();
    // Client tells us, in *server time*, when it thinks the press happened
    // (Date.now()+offset). We trust it only within physical bounds. A buzz is a
    // ONE-WAY trip (client->server ~ RTT/2), so the earliest the press could
    // plausibly have happened is arrival - RTT/2 - jitter slack. Crediting the
    // full RTT would over-compensate and hand a spoofer a real edge; half RTT
    // exactly matches an honest player's latency disadvantage and no more.
    //   lower = arrival - halfRtt - slack    (can't be physically earlier)
    //   upper = arrival                       (can't be in the future)
    //
    // Two hardening steps against RTT inflation (stalling latency probes to
    // widen the backdating window and snipe every buzz):
    //   * effRtt takes the MIN of the standard probe RTT and an RTT measured on
    //     a separate, buzz-triggered round-trip (see below). An attacker who
    //     stalls only the obvious "latency packets" leaves the buzz-path RTT
    //     honest, so the min stays honest.
    //   * halfRtt is then hard-capped at maxHalfRttMs, so even if every channel
    //     is inflated the backdating edge is bounded to a small, fixed amount.
    const effRtt = Math.min(ctx.minRtt ?? 120, ctx.minBuzzRtt ?? Infinity);
    const halfRtt = Math.min(effRtt / 2, DEFAULTS.maxHalfRttMs);
    const lower = arrival - halfRtt - DEFAULTS.clampSlackMs;
    const claimed = Number(payload?.pressServerTime);
    const clampedTime = Number.isFinite(claimed)
      ? Math.min(arrival, Math.max(lower, claimed))
      : arrival;

    const result = store.recordBuzz(room, { playerId: ctx.playerId, clampedTime, arrival });
    if (!result.accepted) return;

    // Measure an RTT on a buzz-triggered round-trip (distinct from the routine
    // probe). Folds into future clamps via the min above. If the routine probe
    // RTT is wildly larger than this buzz-path RTT, the client is almost
    // certainly stalling the obvious probes — flag it for the log once.
    measureRtt('rtt_echo', 'minBuzzRtt');
    if (Number.isFinite(ctx.minBuzzRtt) && ctx.minRtt > ctx.minBuzzRtt * 1.8 + 50 && !ctx.rttSuspect) {
      ctx.rttSuspect = true;
      console.warn(`[anti-cheat] socket=${socket.id} player=${ctx.playerId} room=${room.code}: ` +
        `probe minRtt=${ctx.minRtt}ms >> buzz-path minRtt=${ctx.minBuzzRtt}ms — possible latency-probe stalling`);
    }

    if (result.firstOfWindow) {
      // First buzz pauses reading immediately for everyone (the human reader
      // stops), but we wait the reconcile window before declaring the order.
      io.to(room.code).emit('buzz_pending', { cycleNo: room.cycleNo });
      setTimeout(() => {
        if (room.phase !== 'open') return; // already reset/changed
        const queue = store.resolveWindow(room);
        io.to(room.code).emit('buzz_result', { cycleNo: room.cycleNo, queue });
        emitState(room);

        // Optional auto-clear: a few seconds after the buzz resolves, reset the
        // buzzer for the next tossup so the reader doesn't have to. Only in
        // lock-to-first mode (queue mode is meant to accumulate). The cycle guard
        // makes this a no-op if staff already reset or advanced in the meantime.
        if (room.settings.autoClear && !room.settings.queueMode) {
          const cycleAtBuzz = room.cycleNo;
          setTimeout(() => {
            if (room.cycleNo !== cycleAtBuzz || room.phase !== 'locked') return;
            store.resetBuzzer(room);
            io.to(room.code).emit('buzzer_reset', { cycleNo: room.cycleNo });
            emitState(room);
          }, DEFAULTS.autoClearMs);
        }
      }, room.settings.reconcileWindowMs);
    }
  });

  // --- staff controls (reader + co-reader, gated on a secret token) -----
  socket.on('reader_action', async (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room) return ack?.({ error: 'no_room' });
    if (!isStaff(socket, room)) return ack?.({ error: 'forbidden' });

    switch (payload?.action) {
      case 'reset_buzzer':
      case 'clear_queue':
        store.resetBuzzer(room);
        io.to(room.code).emit('buzzer_reset', { cycleNo: room.cycleNo });
        break;
      case 'next_buzz':
        store.nextBuzz(room);
        break;
      case 'set_options':
        store.setOptions(room, payload.options || {});
        break;
      case 'set_roster_teams':
        store.setRosterTeams(room, payload.teams || []);
        break;
      case 'assign_roster_player':
        store.assignRosterPlayer(room, payload.playerId, payload.team, payload.player);
        break;
      case 'clear_roster':
        store.clearRoster(room);
        break;
      case 'remove_player':
        if (store.removePlayer(room, payload.playerId)) kickPlayer(room, payload.playerId, 'removed');
        break;
      case 'remove_all_players':
        for (const id of store.removeAllPlayers(room)) kickPlayer(room, id, 'removed');
        break;
      // --- MASSINGER pick/ban (moderator-driven, see store.js) ----------
      case 'massinger_start': {
        // Unless explicitly starting fresh, a persisted board for this round
        // is resumed — a moderator reload (or server restart) mid-pick/ban
        // must not wipe the picks already made.
        let r = { error: 'no_saved' };
        if (payload.fresh !== true) {
          const saved = await artifacts.getMassinger(room.code, payload.round).catch(() => null);
          if (saved) r = store.massingerRestore(room, saved);
        }
        // resumeOnly probes for a saved board without starting a fresh one
        // (the pick/ban screen auto-resumes on load with it).
        if (r.error && payload.resumeOnly === true) return ack?.({ error: 'no_saved' });
        if (r.error) r = store.massingerStart(room, payload);
        if (r.error) return ack?.(r);
        armMassingerTimer(room);
        break;
      }
      case 'massinger_pick': {
        const r = store.massingerPick(room, payload);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_set_turn': {
        const r = store.massingerSetTurn(room, payload.team);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_set_teams': {
        const r = store.massingerSetTeams(room, payload.teams);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_undo': {
        const r = store.massingerUndo(room);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_random_ban': {
        const r = store.massingerRandomBan(room);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_reset_subcat': {
        const r = store.massingerResetSubcat(room, payload.label);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_cancel':
        store.massingerCancel(room);
        break;
      // The teams a moderator entered in MODAQ's New Game dialog become this
      // room's roster, so every buzz can be reported as a real MODAQ player.
      case 'set_modaq_teams': {
        const r = store.setRosterFromGameTeams(room, payload.teams);
        if (r.error) return ack?.(r);
        break;
      }
      default:
        return ack?.({ error: 'unknown_action' });
    }
    // Persist the board so reloads/restarts resume it (cancel deletes it).
    if (String(payload?.action).startsWith('massinger')) {
      if (payload.action === 'massinger_cancel') {
        clearMassingerTimer(room.code);
        artifacts.deleteMassinger(room.code, payload.round).catch(() => {});
      }
      afterMassingerChange(room);
      return ack?.({ ok: true });
    }
    emitState(room);
    ack?.({ ok: true });
  });

  // --- MASSINGER: a team makes its own pick ------------------------------
  // Players protect/ban for themselves. Authority is checked server-side: only
  // a player whose team is the one on the clock can move the board, so a
  // hand-rolled client can't pick for the opponent or out of turn.
  socket.on('massinger_pick', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const member = room.members.get(ctx.playerId);
    const allowed = store.massingerCanPick(room, member);
    if (allowed !== true) return ack?.({ error: allowed });
    const result = store.massingerPick(room, {
      type: payload?.type,
      label: payload?.label,
      by: store.displayName(member)
    });
    if (result.error) return ack?.(result);
    afterMassingerChange(room);
    ack?.({ ok: true });
  });

  // --- "the buzzer isn't clear" (players -> staff) ------------------------
  // A player pings the moderator when their buzz has gone unjudged. The server
  // re-checks every gate (room option, 10s since the buzz, per-player cooldown)
  // so a hand-rolled client can't bypass the client-side ones.
  socket.on('stuck_alert', (_payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const res = store.raiseStuckAlert(room, ctx.playerId);
    if (!res.ok) return ack?.({ error: res.reason });
    const delivered = emitToStaff(room.code, 'stuck_alert', {
      playerId: res.member.id,
      name: res.member.name,
      team: res.member.team || null,
      at: Date.now()
    });
    ack?.({ ok: true, delivered });
  });

  // --- player withdraw (queue mode, only if the room allows it) ----------
  socket.on('withdraw', (_payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const ok = store.withdraw(room, ctx.playerId);
    if (ok) emitState(room);
    ack?.({ ok });
  });

  socket.on('disconnect', () => {
    clearInterval(rttTimer);
    const ctx = sock.get(socket.id);
    if (ctx?.roomCode) {
      const room = store.getRoom(ctx.roomCode);
      if (room && ctx.playerId) {
        store.setConnected(room, ctx.playerId, false);
        emitState(room);
      }
    }
    sock.delete(socket.id);
  });
});

// Rehydrate tournaments and room identities from the data volume BEFORE
// accepting traffic, so director consoles and reader links survive restarts.
// Rooms older than the TTL are dropped at boot (they age out of rooms.json on
// its next rewrite); tournaments are kept indefinitely — their stats live on
// the same volume.
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
try {
  const [tournamentRecords, roomRecords] = await Promise.all([
    artifacts.loadTournamentRecords(),
    artifacts.loadRoomRecords()
  ]);
  const freshRooms = roomRecords.filter((r) => Date.now() - (r.createdAt || 0) < ROOM_TTL_MS);
  store.hydrate({ tournaments: tournamentRecords, rooms: freshRooms });
  if (tournamentRecords.length || freshRooms.length) {
    console.log(`rehydrated ${tournamentRecords.length} tournament(s), ${freshRooms.length} room(s)`);
  }
} catch (e) {
  console.error('rehydration failed (continuing with empty store):', e);
}
store.setPersistence({
  tournament: (record) => artifacts.saveTournamentRecord(record).catch((e) => console.error('persist tournament failed:', e)),
  rooms: (records) => artifacts.saveRoomRecords(records).catch((e) => console.error('persist rooms failed:', e))
});

httpServer.listen(PORT, () => {
  console.log(`buzz-online listening on http://localhost:${PORT}`);
});
