import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';

import { PORT, DEFAULTS } from './config.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));

const publicDir = path.join(__dirname, '..', 'public');
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
  res.json({ code: room.code, name: room.name, tournamentCode: room.tournamentCode });
});

app.post('/api/tournaments', (req, res) => {
  const { name, schedule, defaults } = req.body || {};
  const t = store.createTournament({ name, schedule, defaults });
  res.json({ code: t.code, directorToken: t.directorToken, name: t.name, defaults: t.roomDefaults });
});

app.get('/api/tournaments/:code', (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({
    code: t.code, name: t.name, schedule: t.schedule, rooms: [...t.roomCodes], defaults: t.roomDefaults
  });
});

app.put('/api/tournaments/:code/schedule', (req, res) => {
  const t = store.getTournament(req.params.code);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if ((req.body?.directorToken || '') !== t.directorToken) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const schedule = store.setSchedule(t, req.body?.schedule || []);
  res.json({ schedule });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.get('/about', (_req, res) => res.sendFile(path.join(publicDir, 'about.html')));

// tournament director console
app.get('/t/:code', (_req, res) => res.sendFile(path.join(publicDir, 'tournament.html')));

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

function emitState(room) {
  io.to(room.code).emit('state', store.publicState(room));
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
  socket.on('join', (payload, ack) => {
    const room = store.getRoom(payload?.roomCode);
    if (!room) return ack?.({ error: 'no_room' });

    // The presented token determines the ACTUAL authority, not the requested
    // role — so a co-reader link can never grant full-reader powers, and a bad
    // token silently downgrades to spectator.
    const requested = payload?.role;
    const token = payload?.staffToken;
    let role = 'player';
    let staffRole = null;
    let staffDenied = false;
    if (requested === 'spectator') {
      role = 'spectator';
    } else if (requested === 'reader' || requested === 'co-reader') {
      if (token && token === room.readerToken) role = staffRole = 'reader';
      else if (token && token === room.coReaderToken) role = staffRole = 'co-reader';
      else { role = 'spectator'; staffDenied = true; }
    }

    const member = store.joinRoom(room, {
      playerId: payload?.playerId,
      name: payload?.name,
      role,
      team: payload?.team
    });

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
      // Only a full reader is trusted to mint co-reader invite links.
      coReaderToken: staffRole === 'reader' ? room.coReaderToken : undefined,
      state: store.publicState(room),
      serverTime: Date.now()
    });
    emitState(room);
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
  socket.on('reader_action', (payload, ack) => {
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
      case 'remove_player':
        if (store.removePlayer(room, payload.playerId)) kickPlayer(room, payload.playerId, 'removed');
        break;
      case 'remove_all_players':
        for (const id of store.removeAllPlayers(room)) kickPlayer(room, id, 'removed');
        break;
      default:
        return ack?.({ error: 'unknown_action' });
    }
    emitState(room);
    ack?.({ ok: true });
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

httpServer.listen(PORT, () => {
  console.log(`buzz-online listening on http://localhost:${PORT}`);
});
