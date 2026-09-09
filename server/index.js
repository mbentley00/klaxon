import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';

import { PORT, DEFAULTS } from './config.js';
import { uuid, secretToken } from './ids.js';
import * as store from './store.js';
import * as artifacts from './artifacts.js';
import { computeStats, liveGameRows, protestRows } from './stats.js';
import * as protests from './protests.js';
import * as answers from './answers.js';
import * as playtest from './playtest.js';
import { renderReport, PAGES } from './yellowfruit.js';
import { computeBuzzpoints, renderBuzzpointsCsv, renderBuzzpointsHtml } from './buzzpoints.js';
import { sendEmail, emailEnabled, feedbackBody, FEEDBACK_TO } from './email.js';
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

// A few rooms at once, for the home page's "rooms you've joined" list. Only
// rooms that still exist come back; a code is already the thing you need to
// join, so the name and how many players are in there is no new exposure.
app.get('/api/rooms-summary', (req, res) => {
  const codes = String(req.query.codes || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean).slice(0, 12);
  const rooms = [];
  for (const code of codes) {
    const room = store.getRoom(code);
    if (!room) continue;
    const members = [...room.members.values()];
    rooms.push({
      code: room.code,
      name: room.name,
      players: members.filter((m) => m.role === 'player' && m.connected).length
    });
  }
  res.json({ rooms });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'not_found' });
  res.json({
    code: room.code, name: room.name, tournamentCode: room.tournamentCode,
    // The join gate needs these before joining: whether a team is required,
    // and (when the room asks players to identify from the roster) the teams
    // and players to choose from.
    requireTeam: !!room.settings.requireTeam,
    rosterJoin: !!room.settings.rosterJoin,
    roster: store.joinRoster(room)
  });
});

app.post('/api/tournaments', (req, res) => {
  const { name, schedule, defaults, format, requireReaderAccounts, date, listed } = req.body || {};
  const t = store.createTournament({
    name, schedule, defaults, format, requireReaderAccounts, date, listed,
    playerScoresheet: req.body?.playerScoresheet !== false,
    scoresheetCategories: req.body?.scoresheetCategories === true,
    buzzPoints: req.body?.buzzPoints === true,
    playtest: req.body?.playtest === true
  });
  res.json({ code: t.code, directorToken: t.directorToken, name: t.name, defaults: t.roomDefaults, format: t.format });
});

// --- feedback / bug reports -------------------------------------------------
// Mailed straight through; nothing is stored. Rate-limited per IP so the form
// can't be used to send mail in bulk.
const FEEDBACK_MAX = 4000;
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_PER_WINDOW = 5;
const recentFeedback = new Map();   // ip -> [timestamps]

// Sliding-window count of one caller's recent hits. Returns true once they're
// over the limit. The map is swept when it grows so a long-running process
// doesn't accumulate an entry per IP that ever called.
function throttled(seen, ip, windowMs, perWindow) {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 500) {
    for (const [k, v] of seen) if (!v.some((t) => now - t < windowMs)) seen.delete(k);
  }
  return hits.length > perWindow;
}

const feedbackThrottled = (ip) => throttled(recentFeedback, ip, FEEDBACK_WINDOW_MS, FEEDBACK_PER_WINDOW);

// The caller's own address, as far behind Fly's proxy as we can see.
const callerIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';

app.post('/api/feedback', ah(async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) return res.status(400).json({ error: 'Write a message first.' });
  if (message.length > FEEDBACK_MAX) return res.status(400).json({ error: `Please keep it under ${FEEDBACK_MAX} characters.` });

  // An address is required so the report can be answered.
  const replyTo = String(req.body?.email ?? '').trim().slice(0, 200);
  if (!replyTo) return res.status(400).json({ error: 'Add your email so Michael can reply.' });
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(replyTo)) return res.status(400).json({ error: "That email address doesn't look right." });

  const kind = req.body?.kind === 'bug' ? 'bug' : 'feedback';
  const page = String(req.body?.page ?? '').trim().slice(0, 300);
  if (feedbackThrottled(callerIp(req))) return res.status(429).json({ error: "That's a lot of messages at once — try again in a few minutes." });

  if (!emailEnabled()) return res.status(503).json({ error: "This form isn't set up to send mail yet." });
  const sent = await sendEmail({
    to: FEEDBACK_TO,
    subject: kind === 'bug' ? `Klaxon bug report from ${replyTo}` : `Klaxon feedback from ${replyTo}`,
    html: feedbackBody({ from: replyTo, kind, page, message }),
    text: `From: ${replyTo}\nPage: ${page || '-'}\n\n${message}`,
    replyTo
  });
  if (!sent) return res.status(502).json({ error: "Couldn't send that just now." });
  res.json({ ok: true });
}));

// --- YAPP packet parser -----------------------------------------------------
// YAPP (Yet Another Packet Parser) turns a Word packet into the JSON a reader
// loads. It's a .NET service deployed as its own Fly app, so Klaxon proxies to
// it rather than sending browsers to a second origin: the /yapp page and the
// MODAQ moderator view both call this route, which keeps the parser's address a
// deployment detail and means no CORS in either.
//
// KLAXON_YAPP_URL points at our own instance; the default is the public one the
// MODAQ project runs, so a Klaxon that hasn't deployed a parser still works.
const YAPP_URL = (process.env.KLAXON_YAPP_URL || 'https://www.quizbowlreader.com/yapp/api/parse').trim();
const YAPP_MAX_BYTES = 3 * 1024 * 1024;   // the parser's own ceiling
// Generous: a 30-packet zip takes a while, and the parser's Fly machine may be
// stopped (auto_stop_machines) and need to boot for the first request.
const YAPP_TIMEOUT_MS = 90 * 1000;
const YAPP_WINDOW_MS = 10 * 60 * 1000;
const YAPP_PER_WINDOW = 20;
const recentYapp = new Map();   // ip -> [timestamps]

// Only the parser's own options travel upstream — never an arbitrary query
// string a caller appended to our URL.
const YAPP_PARAMS = ['format', 'prettyPrint', 'mergeMultiple', 'version', 'modaq'];

// `type: () => true` rather than '*/*': MODAQ posts the .docx as a bare
// ArrayBuffer, which the browser sends with NO Content-Type at all, and the
// usual matcher treats a missing type as "doesn't match" and hands us no body.
app.post('/api/yapp/parse', express.raw({ type: () => true, limit: YAPP_MAX_BYTES }), ah(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ errorMessages: ['Send the packet file as the request body.'] });
  }
  const ip = callerIp(req);
  if (throttled(recentYapp, ip, YAPP_WINDOW_MS, YAPP_PER_WINDOW)) {
    return res.status(429).json({ errorMessages: ["That's a lot of packets at once — try again in a few minutes."] });
  }

  const upstream = new URL(YAPP_URL);
  for (const key of YAPP_PARAMS) {
    const v = req.query[key];
    if (typeof v === 'string') upstream.searchParams.set(key, v);
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), YAPP_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(upstream, {
      method: 'POST',
      // The parser reads the raw body; it isn't a multipart upload.
      headers: {
        'content-type': 'application/octet-stream',
        // The parser rate-limits per IP and reads this header for it. Without
        // it every request looks like it came from this one machine, and the
        // whole site would share one caller's budget.
        'x-real-ip': ip
      },
      body: req.body,
      signal: abort.signal
    });
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    return res.status(504).json({
      errorMessages: [timedOut ? 'The parser took too long to answer.' : 'Could not reach the parser.']
    });
  } finally {
    clearTimeout(timer);
  }

  // Pass the answer through as-is: JSON for results and errors alike, and raw
  // bytes when the parser streams back a zip of a whole set.
  const body = Buffer.from(await r.arrayBuffer());
  res.status(r.status);
  res.type(r.headers.get('content-type') || 'application/octet-stream');
  res.send(body);
}));

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
    autoRelease: t.autoRelease === true,
    playerScoresheet: t.playerScoresheet !== false,
    scoresheetCategories: t.scoresheetCategories === true,
    buzzPoints: t.buzzPoints === true,
    playtest: t.playtest === true
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
  if (req.body?.prefs !== undefined) accounts.setPrefs(account, req.body.prefs);
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

// Toggle the live scoresheet players see in MODAQ-mode rooms.
app.put('/api/tournaments/:code/player-scoresheet', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const on = store.setPlayerScoresheet(t, req.body?.enabled !== false);
  // Rooms show or hide the sheet straight away.
  for (const code of t.roomCodes) { const room = store.getRoom(code); if (room) emitState(room); }
  res.json({ playerScoresheet: on });
});

// Name each tossup's category on that scoresheet. Off by default; the server
// still only releases a category once the room is past the cycle (store's
// category gate), so turning this on mid-round can't reveal anything ahead.
app.put('/api/tournaments/:code/scoresheet-categories', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const on = store.setScoresheetCategories(t, req.body?.enabled === true);
  // Categories only appear (or disappear) on the reader's next game update, so
  // clear them from the sheet the rooms are showing right now.
  for (const code of t.roomCodes) {
    const room = store.getRoom(code);
    if (!room) continue;
    if (!on && room.scoresheet) {
      for (const row of room.scoresheet.rows || []) row.category = null;
    }
    emitState(room);
  }
  res.json({ scoresheetCategories: on });
});

// Collect every room's buzz log for the whole tournament (see store.buzzPoints).
app.put('/api/tournaments/:code/buzz-points', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const on = store.setBuzzPoints(t, req.body?.enabled === true);
  // Turning it on mid-tournament shouldn't lose what the running rooms have
  // already collected — they keep the whole log in memory, so flush it now.
  if (on) {
    for (const code of t.roomCodes) {
      const room = store.getRoom(code);
      if (room) await flushBuzzPoints(room).catch(() => {});
    }
  }
  res.json({ buzzPoints: on });
}));

// Every buzz attempt in every room of the tournament, including the ones that
// lost to the lock — which exist nowhere else, since MODAQ only ever sees the
// buzz that got the floor. Rooms still in memory are read live so the download
// is current; rooms that have since gone come off disk.
app.get('/api/tournaments/:code/buzz-points', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const live = new Map();
  for (const code of t.roomCodes) {
    const room = store.getRoom(code);
    if (room) live.set(code, store.fullBuzzExport(room));
  }
  for (const saved of await artifacts.readAllBuzzPoints({ kind: 't', code: t.code })) {
    if (!live.has(saved.room)) live.set(saved.room, saved);
  }
  const buzzes = [];
  for (const rec of live.values()) {
    for (const b of rec.buzzes) buzzes.push({ room: rec.room, roomName: rec.name, ...b });
  }
  buzzes.sort((a, b) => a.at - b.at);
  res.setHeader('Content-Disposition', `attachment; filename="klaxon_${t.code}_buzz_points.json"`);
  res.json({
    format: 'klaxon-tournament-buzzpoints-1',
    tournament: t.code,
    name: t.name,
    rooms: [...live.keys()],
    exportedAt: Date.now(),
    buzzes
  });
}));

// Turn a tournament into a playtest, or back.
app.put('/api/tournaments/:code/playtest', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const on = store.setPlaytest(t, req.body?.enabled === true);
  // Answer lines appear (or stop appearing) on the next game update, so clear
  // what the rooms are showing right now.
  for (const code of t.roomCodes) {
    const room = store.getRoom(code);
    if (!room) continue;
    if (!on && room.scoresheet) for (const row of room.scoresheet.rows || []) row.answer = null;
    emitState(room);
  }
  res.json({ playtest: on });
}));

// Everything the playtest rooms said about the questions, newest last.
app.get('/api/tournaments/:code/playtest-feedback', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const feedback = [];
  for (const code of t.roomCodes) {
    const room = store.getRoom(code);
    if (room) feedback.push(...playtest.all(room));
  }
  feedback.sort((a, b) => a.at - b.at);
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="klaxon_${t.code}_playtest_feedback.json"`);
  }
  res.json({ tournament: t.code, name: t.name, tags: playtest.FEEDBACK_TAGS, feedback });
}));

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

// Director breaks one round into a tiebreaker per tossup. The rounds it makes
// are hidden, so nothing reaches a moderator until the director releases the
// one question a room needs.
app.post('/api/tournaments/:code/packets/:round/split-tiebreakers', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = await artifacts.splitPacketIntoTiebreakers({ kind: 't', code: t.code }, req.params.round);
    res.json(out);
  } catch (e) {
    if (e.message === 'no_packet') return res.status(404).json({ error: 'No such round.' });
    if (e.message === 'no_tossups') return res.status(400).json({ error: 'That round has no tossups to split.' });
    if (e.message === 'already_single') return res.status(400).json({ error: 'That round is already a single question.' });
    throw e;
  }
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

// Players who joined without being on the roster, for the director console.
app.get('/api/tournaments/:code/roster-alerts', ah(async (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (req.query.directorToken !== t.directorToken) return res.status(403).json({ error: 'forbidden' });
  res.json({ alerts: await artifacts.getRosterAlerts({ kind: 't', code: t.code }) });
}));

app.delete('/api/tournaments/:code/roster-alerts', ah(async (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (req.body?.directorToken !== t.directorToken) return res.status(403).json({ error: 'forbidden' });
  await artifacts.clearRosterAlerts({ kind: 't', code: t.code });
  res.json({ ok: true });
}));

// Every buzz attempt in the room — including buzzes that lost to the lock —
// with per-cycle order and the MODAQ question read at the time. For buzz-point
// tracking tools; staff only.
app.get('/api/rooms/:code/fullbuzz', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Content-Disposition', `attachment; filename="klaxon_${room.code}_full_buzz.json"`);
  res.json(store.fullBuzzExport(room));
}));

// Previous games of this room (staff only): summaries, and one full record.
app.get('/api/rooms/:code/games', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  res.json({ games: await artifacts.listGames(room.code) });
}));

app.get('/api/rooms/:code/games/:id', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  // The archived game carries the packet: same account gate as packet reads.
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  const game = await artifacts.getGame(room.code, req.params.id);
  if (!game) return res.status(404).json({ error: 'not_found' });
  res.json({ game });
}));

// The shared MODAQ game for this room (staff only — it contains the packet).
app.get('/api/rooms/:code/modaq-state', ah(async (req, res) => {
  const room = roomOr(res, req.params.code); if (!room) return;
  if (!(await roomModOk(room, reqToken(req), reqSession(req)))) return res.status(403).json({ error: 'forbidden' });
  // The shared game carries the packet: same account gate as packet reads.
  if (!(await readerAccessOk(room, reqSession(req)))) return res.status(403).json(ACCESS_DENIED);
  res.json({ state: await modaqStateFor(room) });
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

// Copy a room's full buzz log up to its tournament, when the director asked for
// buzz points. A no-op otherwise: a room outside a tournament, or one whose
// director didn't opt in, keeps its log to itself.
async function flushBuzzPoints(room) {
  if (!room.tournamentCode || !store.buzzPointsOn(room)) return;
  await artifacts.saveRoomBuzzPoints({ kind: 't', code: room.tournamentCode },
    room.code, store.fullBuzzExport(room));
}

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
  // The room's buzz log goes up with the game, so a room that is closed or
  // restarted later doesn't take its buzz points with it.
  await flushBuzzPoints(room).catch(() => { /* never fail the export */ });
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

// --- Buzzpoints (director-only: answer lines are in it) ---------------------

async function buzzpointsFor(code) {
  const t = store.getTournament(code);
  if (!t) return null;
  const bucket = { kind: 't', code: t.code };
  let matches = [];
  try { matches = await artifacts.readAllExports(bucket); } catch { matches = []; }
  const packetsByRound = new Map();
  try {
    for (const p of await artifacts.listPackets(bucket)) {
      const text = await artifacts.getPacket(bucket, p.round);
      if (text == null) continue;
      try { packetsByRound.set(String(p.round), JSON.parse(text)); } catch { /* skip bad packet */ }
    }
  } catch { /* no packets: lengths/answers just come up empty */ }
  return { t, data: computeBuzzpoints(matches, packetsByRound) };
}

async function serveBuzzpoints(res, code, kind, csvHref) {
  const r = await buzzpointsFor(code);
  if (!r) return res.status(404).send('Tournament not found.');
  if (kind === 'csv') {
    const base = (r.t.name || r.t.code).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || r.t.code;
    res.setHeader('Content-Disposition', `attachment; filename="${base}_buzzpoints.csv"`);
    return res.type('text/csv').send(renderBuzzpointsCsv(r.data));
  }
  res.type('html').send(renderBuzzpointsHtml(r.t.name || r.t.code, r.data, csvHref));
}

app.get('/t/:code/buzzpoints', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).send('Director link required (or use a share link).');
  const q = `?directorToken=${encodeURIComponent(req.query.directorToken)}`;
  await serveBuzzpoints(res, t.code, 'html', `/t/${t.code}/buzzpoints.csv${q}`);
}));

app.get('/t/:code/buzzpoints.csv', ah(async (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).send('Director link required (or use a share link).');
  await serveBuzzpoints(res, t.code, 'csv');
}));

// --- Temporary share links ---------------------------------------------------
// The director mints an expiring link to the YellowFruit report or the
// buzzpoint report, hands it out, and can revoke it. Tokens live on the
// tournament record (persisted), so they survive a restart and die on expiry.
const SHARE_KINDS = new Set(['stats', 'buzzpoints']);
const SHARE_DEFAULT_HOURS = 7 * 24;

function pruneShareLinks(t) {
  const now = Date.now();
  const before = (t.shareLinks || []).length;
  t.shareLinks = (t.shareLinks || []).filter((l) => l.expiresAt > now);
  if (t.shareLinks.length !== before) store.persistTournamentRecord(t);
  return t.shareLinks;
}

app.get('/api/tournaments/:code/share-links', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.query.directorToken)) return res.status(403).json({ error: 'forbidden' });
  res.json({ links: pruneShareLinks(t) });
});

app.post('/api/tournaments/:code/share-links', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  const kind = String(req.body?.kind || '');
  if (!SHARE_KINDS.has(kind)) return res.status(400).json({ error: 'bad_kind' });
  const hours = Math.min(24 * 30, Math.max(1, Number(req.body?.hours) || SHARE_DEFAULT_HOURS));
  const link = { token: secretToken(), kind, createdAt: Date.now(), expiresAt: Date.now() + hours * 3600_000 };
  pruneShareLinks(t);
  t.shareLinks.push(link);
  store.persistTournamentRecord(t);
  res.json({ link });
});

app.delete('/api/tournaments/:code/share-links/:token', (req, res) => {
  const t = tournamentOr(res, req.params.code); if (!t) return;
  if (!directorOk(t, req.body?.directorToken)) return res.status(403).json({ error: 'forbidden' });
  t.shareLinks = (t.shareLinks || []).filter((l) => l.token !== req.params.token);
  store.persistTournamentRecord(t);
  res.json({ links: pruneShareLinks(t) });
});

// Resolve a share token to its tournament + kind (null if unknown/expired).
function shareFor(token) {
  for (const t of store.allTournaments()) {
    const link = (t.shareLinks || []).find((l) => l.token === token);
    if (link) return link.expiresAt > Date.now() ? { t, link } : null;
  }
  return null;
}

const SHARE_GONE = '<p style="font-family:sans-serif">This share link has expired or was revoked. Ask the tournament director for a fresh one.</p>';

app.get('/s/:token', (req, res) => {
  const hit = shareFor(req.params.token);
  if (!hit) return res.status(404).send(SHARE_GONE);
  res.redirect(hit.link.kind === 'buzzpoints' ? `/s/${req.params.token}/buzzpoints` : `/s/${req.params.token}/standings`);
});

app.get('/s/:token/buzzpoints', ah(async (req, res) => {
  const hit = shareFor(req.params.token);
  if (!hit || hit.link.kind !== 'buzzpoints') return res.status(404).send(SHARE_GONE);
  await serveBuzzpoints(res, hit.t.code, 'html', `/s/${req.params.token}/buzzpoints.csv`);
}));

app.get('/s/:token/buzzpoints.csv', ah(async (req, res) => {
  const hit = shareFor(req.params.token);
  if (!hit || hit.link.kind !== 'buzzpoints') return res.status(404).send(SHARE_GONE);
  await serveBuzzpoints(res, hit.t.code, 'csv');
}));

app.get('/s/:token/stats.zip', ah(async (req, res) => {
  const hit = shareFor(req.params.token);
  if (!hit || hit.link.kind !== 'stats') return res.status(404).send(SHARE_GONE);
  res.redirect(`/t/${hit.t.code}/stats.zip`);
}));

app.get('/s/:token/:page', ah(async (req, res) => {
  const hit = shareFor(req.params.token);
  if (!hit || hit.link.kind !== 'stats') return res.status(404).send(SHARE_GONE);
  const page = req.params.page.replace(/\.html$/, '');
  if (!REPORT_PAGES.has(page)) return res.status(404).send('Unknown report page.');
  const data = await statsFor(hit.t.code);
  if (!data) return res.status(404).send(SHARE_GONE);
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

// feedback / bug report form
app.get('/feedback', (_req, res) => res.sendFile(path.join(publicDir, 'feedback.html')));

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

// packet parser (.docx -> the JSON a reader loads); calls /api/yapp/parse
app.get('/yapp', (_req, res) => res.sendFile(path.join(publicDir, 'yapp.html')));

// tournament director console
app.get('/t/:code', (_req, res) => res.sendFile(path.join(publicDir, 'tournament.html')));

// Player landing page for a whole tournament (content is key-gated by the API).
app.get('/tp/:code', (_req, res) => res.sendFile(path.join(publicDir, 'player-tournament.html')));

// room.html serves any /r/CODE deep link
app.get('/r/:code', (_req, res) => res.sendFile(path.join(publicDir, 'room.html')));

// klaxonbuzz.com/CODE — the shortest possible link to hand a player. A room
// code (4 letters) lands on the room's join page; a tournament code (5) on the
// tournament's public stats. Anything unknown falls through to the usual 404.
app.get('/:code([A-Za-z0-9]{4,5})', (req, res, next) => {
  const code = req.params.code.toUpperCase();
  const qi = req.originalUrl.indexOf('?');
  const qs = qi >= 0 ? req.originalUrl.slice(qi) : '';
  if (store.getRoom(code)) return res.redirect(`/r/${code}${qs}`);
  if (store.getTournament(code)) return res.redirect(`/t/${code}/stats`);
  next();
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // websocket-first with polling fallback => reliable behind hostile proxies
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 8000,
  // The shared MODAQ game state (packet included) rides the socket; the
  // default 1 MB cap is too tight for a long packet.
  maxHttpBufferSize: 8 * 1024 * 1024
});

// ---------------------------------------------------------------------------
// Per-socket runtime state: which room/player, and the AUTHORITATIVE round
// trip time the server measured itself (used to clamp buzz timestamps so a
// client cannot claim a physically impossible early press).
// ---------------------------------------------------------------------------
const sock = new Map(); // socket.id -> { roomCode, playerId, minRtt }

// A player joined a roster room without picking themselves out of the roster.
// Kept with the tournament (so the director sees it whenever they look) and
// pushed live to anyone watching the console.
async function recordOffRosterJoin(room, member) {
  const alert = {
    room: room.code,
    playerId: member.id,
    name: member.name,
    team: member.team || member.assignedTeam || '',
    at: Date.now()
  };
  if (room.tournamentCode) {
    await artifacts.addRosterAlert({ kind: 't', code: room.tournamentCode }, alert);
  }
  io.to(room.code).emit('roster_alert', alert);
  emitToStaff(room.code, 'roster_alert', alert);
  console.log(`off-roster join: ${member.name} in room ${room.code}`);
}

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
// for director messages, which players must never receive. `except` skips one
// socket (the sender of a change that the others need to hear about).
function emitToStaff(roomCode, event, payload, except = null) {
  let delivered = 0;
  for (const [sid, ctx] of sock) {
    if (sid === except) continue;
    if (ctx.roomCode === roomCode && ctx.staffRole) {
      const sk = io.sockets.sockets.get(sid);
      if (sk) { sk.emit(event, payload); delivered++; }
    }
  }
  return delivered;
}

// --- Shared MODAQ game state ----------------------------------------------
// The moderator page pushes MODAQ's serialized game on every change; it's kept
// here (and on disk) so a reload on another device, or a second moderator,
// gets the same game at the same question. Loaded from disk on first use
// after a restart. STAFF ONLY — it contains the packet.
async function modaqStateFor(room) {
  if (room.modaqState === undefined) {
    room.modaqState = (await artifacts.getModaqState(room.code)) || null;
  }
  return room.modaqState;
}
const MODAQ_STATE_MAX = 6 * 1024 * 1024;

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
      team: payload?.team,
      rosterTeam: payload?.rosterTeam,
      rosterPlayer: payload?.rosterPlayer
    });

    // Someone joined a roster room under a name the roster doesn't have: the
    // director wants to know (a sub, a late addition, or a typo to fix).
    if (role === 'player' && member.offRoster && room.settings.rosterJoin) {
      recordOffRosterJoin(room, member).catch((e) => console.error('off-roster alert failed:', e));
    }

    // In a shootout the roster IS the room: whoever is connected is a
    // competitor of their own, so someone arriving mid-session is in the next
    // game the moderator starts without anybody typing anything.
    if (role === 'player' && room.settings.shootout) {
      try { store.refreshShootoutRoster(room); } catch { /* best-effort */ }
    }

    // A player who joins after the teams were set still gets linked to their
    // MODAQ player, so their buzzes report the right name.
    if (role === 'player' && room.roster) {
      try { store.autoLinkRosterPlayers(room); } catch { /* linking is best-effort */ }
    }

    // Whether this staff socket may receive packet-bearing payloads (the
    // shared MODAQ game): same account gate as the packet REST endpoints.
    let packetOk = false;
    if (staffRole) {
      try { packetOk = await readerAccessOk(room, payload?.sessionToken); } catch { packetOk = false; }
    }
    socket.join(room.code);
    sock.set(socket.id, {
      ...sock.get(socket.id),
      roomCode: room.code,
      playerId: member.id,
      staffRole,
      packetOk
    });

    // Staff learn whether a shared MODAQ game exists (and how current it is)
    // so a moderator page can catch up after a reconnect.
    let sharedGame = null;
    if (staffRole) {
      try { sharedGame = await modaqStateFor(room); } catch { sharedGame = null; }
    }
    ack?.({
      ok: true,
      playerId: member.id,
      role: member.role,
      staffDenied,
      denyReason,
      modaqState: staffRole ? (sharedGame ? { seq: sharedGame.seq, round: sharedGame.round, hasGame: !!sharedGame.json } : null) : undefined,
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
        // With typed answers the clock starts only now: until the order is
        // settled nobody knows who has the floor and who is behind them.
        if (room.settings.typedAnswers || room.settings.lockedAnswers) {
          const { window, started } = answers.open(room, queue[0]?.playerId);
          // Close it on the clock, not on a click: everyone committed before
          // the floor's answer was knowable, and the rule that makes a late
          // withdrawal cost something must not depend on the moderator's
          // reaction time. The cycle guard makes this a no-op if the room has
          // moved on.
          const cycleAtOpen = room.cycleNo;
          // Only the buzz that opened the window arms the clock. A later buzz
          // joins a window that is already ticking.
          if (started) setTimeout(() => {
            if (room.cycleNo !== cycleAtOpen) return;
            answers.close(room);
            emitToStaff(room.code, 'answers', answers.forStaff(room, (id) => store.memberName(room, id)));
            emitState(room);
          }, Math.max(0, window.closesAt - Date.now()) + 50);
        }
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
        // A moderator who clears the buzzer WITHOUT scoring the buzz has
        // declared it an accidental buzz — a knocked buzzer, a misfire — not a
        // wrong answer. MODAQ says so by passing `judged` when the clear is the
        // tail of a ruling; a bare clear from the buzz panel doesn't. The
        // difference matters to buzz points (an accidental buzz is not a real
        // buzz point) and it is the one thing the ACF rules single out as never
        // protestable (H.6).
        store.markAccidentalBuzz(room, payload?.judged === true);
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
        // Answer (and broadcast) immediately; persistence is coalesced.
        store.assignRosterPlayer(room, payload.playerId, payload.team, payload.player);
        emitState(room);
        return ack?.({ ok: true });
      // The moderator takes the protest: from here both teams may write (H.3).
      case 'protest_open': {
        const res = protests.open(room, payload?.id);
        if (res.error) return ack?.({ error: res.error });
        emitState(room);
        return ack?.({ ok: true });
      }
      // Entered in MODAQ and confirmed. Statements close: what the director
      // rules on is what was said at the table.
      case 'protest_file': {
        const res = protests.file(room, payload?.id);
        if (res.error) return ack?.({ error: res.error });
        emitState(room);
        return ack?.({ ok: true });
      }
      case 'protest_dismiss': {
        const res = protests.dismiss(room, payload?.id);
        if (res.error) return ack?.({ error: res.error });
        emitState(room);
        return ack?.({ ok: true });
      }
      // Show the room the question that was protested. The text comes from the
      // moderator's MODAQ, which is the only side holding the packet — and only
      // once the protest is filed, because a room that has seen a live question
      // cannot unsee it.
      case 'protest_show_question': {
        const res = protests.showQuestion(room, payload?.id, payload?.text);
        if (res.error) return ack?.({ error: res.error });
        emitState(room);
        return ack?.({ ok: true });
      }
      // The evening starts again: the leaderboard goes back to nothing.
      case 'shootout_reset': {
        if (!room.settings.shootout) return ack?.({ error: 'disabled' });
        store.resetShootout(room);
        emitState(room);
        return ack?.({ ok: true });
      }
      case 'clear_roster':
        store.clearRoster(room);
        break;
      case 'remove_player':
        if (store.removePlayer(room, payload.playerId)) kickPlayer(room, payload.playerId, 'removed');
        break;
      case 'remove_all_players':
        for (const id of store.removeAllPlayers(room)) kickPlayer(room, id, 'removed');
        break;
      // Clear out players who joined more than N minutes ago (leftovers from
      // an earlier game). Default 15.
      case 'remove_stale_players': {
        const removed = store.removeStalePlayers(room, payload.minutes);
        for (const id of removed) kickPlayer(room, id, 'removed');
        return ack?.({ ok: true, removed: removed.length });
      }
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
      // Put a connected buzzer on a team by hand, and name a team's captain.
      // Both are moderator calls: they decide who is allowed to pick.
      case 'set_member_team': {
        const r = store.setMemberTeam(room, payload.playerId, payload.team);
        if (r.error) return ack?.(r);
        break;
      }
      case 'set_captain': {
        const r = store.setCaptain(room, payload.playerId, payload.captain !== false);
        if (r.error) return ack?.(r);
        break;
      }
      case 'massinger_set_control': {
        const r = store.massingerSetControl(room, payload.control);
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
      // The reader's MODAQ game, on every change: the server cuts it down to
      // the player-safe scoresheet (see store.buildPlayerScoresheet) before
      // it goes anywhere near a player. `qbj: null` clears it.
      case 'modaq_game': {
        store.setScoresheet(room, payload.qbj ?? null, payload.currentQuestion, payload.hasBonuses !== false,
          payload.protests, payload.categories, payload.answers);
        break;
      }
      // MODAQ's serialized game from one moderator, fanned out to the others
      // and kept for whoever (re)opens the page next. `json: null` means the
      // moderator left the game (Change round). Sequence numbers are minted
      // here so every client can tell newer from older.
      // Archive the room's current shared game as a "previous game" (the
      // moderator ended it, changed round, or is loading another). An `id`
      // overwrites an earlier archive of the same game instead of duplicating.
      case 'modaq_archive': {
        const st = await modaqStateFor(room);
        if (!st?.json) return ack?.({ error: 'no_game' });
        const summary = room.scoresheet || null;
        const id = typeof payload.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(payload.id) ? payload.id : uuid();
        const record = {
          id,
          round: st.round,
          at: Date.now(),
          teams: summary ? summary.teams.map((t) => t.name) : [],
          scores: summary ? summary.scores : [0, 0],
          current: summary ? summary.current : 0,
          total: summary ? summary.total : 0,
          json: st.json
        };
        await artifacts.saveGame(room.code, record);
        return ack?.({ ok: true, id });
      }
      case 'modaq_state': {
        const json = typeof payload.json === 'string' ? payload.json : null;
        if (json && json.length > MODAQ_STATE_MAX) return ack?.({ error: 'too_large' });
        const prev = await modaqStateFor(room);
        const next = {
          seq: (prev?.seq || 0) + 1,
          round: String(payload.round ?? '').slice(0, 80),
          json,
          by: ctx.playerId,
          at: Date.now()
        };
        room.modaqState = next;
        artifacts.saveModaqState(room.code, next).catch((e) => console.error('modaq state save failed:', e));
        // Only staff sockets cleared for packets hear the game itself.
        for (const [sid, c] of sock) {
          if (sid === socket.id || c.roomCode !== room.code || !c.staffRole || !c.packetOk) continue;
          io.sockets.sockets.get(sid)?.emit('modaq_state', next);
        }
        return ack?.({ ok: true, seq: next.seq });
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

  // --- protests (see protests.js for the ACF rules this follows) --------
  // A team says it wants to protest (H.2). Deliberately one press: the rules
  // have a player say the word at a pause, not stop the match to argue.
  socket.on('protest_lodge', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const actor = store.protestActor(room, ctx.playerId);
    if (!actor) return ack?.({ error: 'not_player' });
    const res = protests.lodge(room, actor, {
      // The question is the one the room has actually reached, from the
      // scoresheet the server itself built — never a number a client sent.
      cycle: room.scoresheet?.current ?? null,
      round: room.modaqState?.round ?? null,
      reason: payload?.reason,
      teams: store.activeTeams(room)
    });
    if (res.error) return ack?.({ error: res.error });
    emitToStaff(room.code, 'protest_lodged', { id: res.protest.id, byTeam: res.protest.byTeam,
      cycle: res.protest.cycle, byName: res.protest.byName, reason: res.protest.reason });
    emitState(room);
    ack?.({ ok: true, id: res.protest.id, existed: res.existed === true });
  });

  // A player's reasoning. Which way it argues is settled by who they are
  // (protests.sideFor) — they are only ever asked for the argument.
  socket.on('protest_statement', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const actor = store.protestActor(room, ctx.playerId);
    if (!actor) return ack?.({ error: 'not_player' });
    const res = protests.addStatement(room, payload?.id, actor, payload?.text);
    if (res.error) return ack?.({ error: res.error });
    emitToStaff(room.code, 'protest_statement', { id: res.protest.id, side: res.statement.side,
      name: res.statement.name, team: res.statement.team });
    emitState(room);
    ack?.({ ok: true, side: res.statement.side });
  });

  // --- shootout chat (see shootout.js) -----------------------------------
  // Nothing to do with answering, and gated on nothing in the game. In a room
  // where everyone is on their own, the talking is why people are there — and
  // without somewhere to put it, it ends up in the answer box.
  socket.on('chat_say', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    if (!room.settings.shootout) return ack?.({ error: 'disabled' });
    const member = room.members.get(ctx.playerId);
    const actor = {
      id: ctx.playerId,
      name: store.memberName(room, ctx.playerId) || 'someone',
      staff: member ? member.role !== 'player' : false
    };
    const res = store.chatSay(room, actor, payload?.text);
    if (res.error) return ack?.({ error: res.error });
    io.to(room.code).emit('chat_message', res.message);
    emitToStaff(room.code, 'chat_message', res.message);
    ack?.({ ok: true });
  });

  // --- playtest feedback (see playtest.js) -------------------------------
  // What one player thought of one question. Only for a cycle the room has
  // finished — the same gate that releases the answer line — so this can't be
  // used to fish for an answer to a question still in play.
  socket.on('playtest_feedback', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    if (!store.playtestOn(room)) return ack?.({ error: 'disabled' });
    const actor = store.protestActor(room, ctx.playerId);
    if (!actor) return ack?.({ error: 'not_player' });
    const sheet = room.scoresheet;
    const row = (sheet?.rows || []).find((r) => r.n === Number(payload?.cycle));
    const res = playtest.record(room, actor, {
      cycle: payload?.cycle,
      tags: payload?.tags,
      text: payload?.text,
      // A row only carries an answer once the gate released it, so "has an
      // answer line" IS "the room has finished this cycle".
      released: (sheet?.rows || []).filter((r) => r.answer).reduce((max, r) => Math.max(max, r.n), 0),
      round: room.modaqState?.round ?? null,
      answer: row?.answer
    });
    if (res.error) return ack?.({ error: res.error });
    emitToStaff(room.code, 'playtest_feedback', { cycle: Number(payload?.cycle), name: actor.name });
    ack?.({ ok: true, mine: playtest.mine(room, ctx.playerId) });
  });

  // --- typed answers (see answers.js) ------------------------------------
  // A player commits (or extends) their answer. Past the deadline the server
  // only accepts text that still starts with what was already there — the
  // append-only tail. Checked here, not in the browser, because a page that
  // lies about its own input box must not be able to walk an answer back.
  socket.on('answer_type', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    if (!room.settings.typedAnswers && !room.settings.lockedAnswers) return ack?.({ error: 'disabled' });
    const res = answers.type(room, ctx.playerId, payload?.text);
    if (res.error) return ack?.({ error: res.error, text: res.text });
    // Only the moderator ever sees what was typed — an answer in flight is the
    // answer to the question, so it never goes near another player.
    emitToStaff(room.code, 'answers', answers.forStaff(room, (id) => store.memberName(room, id)));
    // The room only learns HOW MANY have committed, which is what tells it
    // whether it is still waiting on someone. Sent as its own small event
    // rather than a state broadcast: this fires on every keystroke.
    const window = answers.state(room);
    if (window) io.to(room.code).emit('answers_committed', { cycleNo: room.cycleNo, committed: window.locked.size });
    ack?.({ ok: true, text: res.text, appendOnly: res.appendOnly });
  });

  // The player with the floor says their answer out loud (or the moderator
  // records what they said). It goes on the record so a later withdrawal can
  // be judged against what the room has already heard.
  socket.on('answer_spoken', (payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room) return ack?.({ error: 'no_room' });
    const staff = isStaff(socket, room);
    const playerId = staff ? (payload?.playerId ?? null) : ctx.playerId;
    // A player may only speak for themselves, and only when they have the floor.
    if (!staff && room.queue[0]?.playerId !== ctx.playerId) return ack?.({ error: 'not_your_turn' });
    const res = answers.speak(room, playerId, payload?.text);
    if (res.error) return ack?.({ error: res.error });
    emitToStaff(room.code, 'answers', answers.forStaff(room, (id) => store.memberName(room, id)));
    emitState(room);
    ack?.({ ok: true });
  });

  // --- player withdraw (queue mode, only if the room allows it) ----------
  socket.on('withdraw', (_payload, ack) => {
    const ctx = sock.get(socket.id);
    const room = ctx && store.getRoom(ctx.roomCode);
    if (!room || !ctx.playerId) return ack?.({ error: 'no_room' });
    const res = store.withdraw(room, ctx.playerId);
    if (res.ok) {
      // The moderator needs to know which kind of withdrawal that was: a
      // reaction buzz taken back before anything was said costs nothing, and
      // neither does one that would only have repeated an answer already
      // given. Anything else is theirs to penalise.
      if (room.settings.lockedAnswers) {
        emitToStaff(room.code, 'withdraw_verdict', {
          playerId: ctx.playerId, free: res.free, reason: res.reason
        });
      }
      emitState(room);
    }
    ack?.({ ok: res.ok, free: res.free, reason: res.reason });
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
