# Klaxon — an online quizbowl buzzing system

A fast, fair, reliable online buzzer for quizbowl, in the spirit of buzzin.live.
Created by Michael Bentley ([doc-ent.com](https://www.doc-ent.com) ·
[hsquizbowl.org](https://www.hsquizbowl.org)).
Create or join a room in seconds, optionally group rooms into a tournament with a
schedule, and buzz with **latency compensation** that is fair to high-ping
players but resistant to spoofing.

```
npm install
npm start          # http://localhost:3000
```

Open the page, click **Create room & read** (you become the reader), and share
the 4‑letter room code. Players go to the home page, type the code + their name,
and they're in.

---

## What it does

- **One-tap create / join.** Rooms are 4‑char codes (no ambiguous `0/O`, `1/I`).
  A deep link `/r/CODE` joins directly; readers get `/r/CODE?role=reader`.
- **Roles:** reader (moderator), player, spectator. Reader powers are gated by a
  secret token issued at room creation — not by a checkbox the client can flip.
- **Latency‑fair buzzing** (see below).
- **Full tossup loop:** start tossup → buzz → reader judges Power/Correct/Neg/Wrong
  → wrong answers lock that player out and **reopen** buzzers for everyone else.
- **Live scoreboard** with per‑player manual adjustments and reset.
- **Reconnect‑safe:** identity lives in `localStorage`; a refresh or dropped
  connection rejoins the same room and restores full state.
- **Tournaments (optional):** group rooms under a tournament code and attach a
  schedule (`round → room → teams`) so a team sees a **"go to your next room"**
  button each round.
- **Mobile + desktop:** big circular thumb buzzer, `Space` to buzz on desktop,
  haptic feedback, safe‑area aware, no zoom jank.

---

## How latency is handled (the important part)

The problem: if player A has 30 ms ping and player B has 150 ms ping and they
press at the *same real instant*, naive "first packet to arrive wins" always
robs B. We fix this without trusting clients:

1. **Clock sync.** On join each client runs an NTP‑style handshake (9 samples,
   keep the lowest‑RTT estimate) to learn its offset from the server clock.
   See `public/js/clocksync.js`.
2. **Press timestamps, not arrival.** A buzz carries the client's estimate of
   the *server‑time of the press*, not when the packet lands.
3. **Reconciliation window.** The first buzz immediately pauses the read for
   everyone, but the server then waits a short window (default **250 ms**) and
   ranks **every** buzz that lands inside it by press time. Latency no longer
   decides ties — reaction time does. See `server/index.js` / `store.resolveWindow`.

### Why this can't be cheated
A press timestamp is only trusted **within physical limits**. The server
measures each socket's round‑trip time *itself* (it can't be inflated by the
client) and clamps every claimed press time to:

```
arrival - RTT/2 - slack   ≤   credited press   ≤   arrival
```

A buzz is a one‑way trip (~RTT/2), so the earliest you could *physically* have
pressed is `arrival - RTT/2`. That backdating credit **exactly equals an honest
high‑latency player's disadvantage and no more** — so spoofing your timestamp
1 second early gains you nothing beyond compensating your real latency. (Verified
in testing: a forged 1 s‑early buzz loses to an honest one.)

Other hardening: server is the sole authority for order/lockout/score; reader
actions require the secret token; one buzz per player per cycle; locked‑out
players can't re‑buzz; payload size limits; WebSocket with polling fallback.

---

## Tournaments & schedules

1. **Create tournament** on the home page → get a 5‑char code + director token.
2. Create rooms with that tournament code (field on the create‑room form), or
   `POST /api/rooms {tournamentCode}`.
3. Upload a schedule:
   ```
   PUT /api/tournaments/CODE/schedule
   { "directorToken": "…", "schedule": [
       { "round": "1", "room": "AB2C", "teams": ["Lions", "Tigers"] },
       { "round": "2", "room": "QX7K", "teams": ["Lions", "Bears"] }
   ]}
   ```
   Players who entered a team name see a one‑click jump to their next room, plus
   a strip of all rooms in the tournament. The format is intentionally loose so
   you can map most bracket‑software exports onto it.

---

## MODAQ reader mode (optional)

A room can run in **MODAQ mode**, which replaces the moderator's plain reader
view with the embedded [MODAQ](https://github.com/alopezlago/MODAQ) reader
(read‑question view + full scorekeeping) shown **side by side with the Klaxon
buzz panel**. Players still use the normal latency‑fair buzzer; only staff get
the MODAQ view.

There are two flavors, chosen when creating a room (dropdown on the home page),
as a tournament default, or live from a room's Game options. Staff are then
routed to `/modaq?room=CODE`.

- **MODAQ — lite:** the fastest path. Straight to the MODAQ reader + buzz panel,
  with **no tournament infrastructure** — the moderator loads a packet and sets
  teams with MODAQ's own New Game, and exports with MODAQ's own download. Klaxon
  only adds the live buzz panel. Nothing is stored on the server.
- **MODAQ — with roster / packets / exports:** the full tournament workflow
  below (server rosters, round packets, server‑saved exports, and errata).
- **Rosters:** upload a registration `.qbj` when creating a tournament (or from
  the director console). MODAQ rooms in that tournament default to those teams
  and players; the two teams for a room are prefilled from the schedule when set.
- **Round packets:** a moderator adds the round's packet JSON in the MODAQ setup
  screen (it's saved to the server so the whole round shares it); the director
  can also manage packets centrally.
- **Export:** MODAQ's "Save match to Klaxon" export (and a periodic autosave)
  writes the match **QBJ to the server**, where the tournament director and
  other moderators retrieve it from the director console.
- **Errata:** the MODAQ reader has an **Errata** button to flag a packet
  question (throw it out and/or add a correction). Errata are saved with the
  tournament and shown to the director.

These artifacts persist to disk under `KLAXON_DATA_DIR` (a Fly volume in
production — see `fly.toml`), so they survive restarts. The realtime buzzer core
stays in‑memory as before.

### Building the MODAQ bundle

The moderator page is a React bundle built from the MODAQ repo directly into
`public/modaq/` (served statically — no build step in Klaxon's Docker image).
After changing MODAQ source, rebuild it from the MODAQ repo:

```bash
cd ../modaq/MODAQ
npm run buildModerator      # outputs to ../../klaxon/public/modaq
```

The committed `public/modaq/` output (~1 MB) is what ships. MODAQ's optional
in‑browser speech engines (Whisper/Vosk, ~29 MB of wasm) are stubbed out of this
build via aliases in `vite.moderator.config.ts`, since the moderator page
doesn't need them.

## Deploy: Vercel or dedicated host?

**Short answer: the realtime buzzer core needs a persistent‑process host (Fly.io,
Railway, Render, a VPS…), not Vercel's serverless functions.** Here's the honest
reasoning, since reliability was a hard requirement:

- A buzzer needs a **long‑lived WebSocket connection** holding **authoritative,
  in‑memory room state** (who's buzzed, lockouts, the reconciliation window
  timer). Vercel Functions are short‑lived and stateless by design and don't
  hold a socket server with shared memory across clients. The server‑measured
  RTT and the in‑process reconcile timer are exactly the things serverless can't
  keep.
- **What does run great on Vercel:** the static frontend (`/public`). You *can*
  split it: host the UI on Vercel and point the socket client at a dedicated
  realtime backend. But there's little benefit — this app already serves its own
  static files, so one process is simpler and more reliable (one thing to keep
  alive, no cross‑origin socket setup, lowest latency).
- **A fully Vercel‑native variant is possible** but is a different architecture:
  move authoritative state to a managed store (Upstash Redis, on the Vercel
  Marketplace) and fan out via a managed realtime provider (Ably/Pusher/Supabase
  Realtime) instead of an in‑process Socket.IO server. More moving parts and
  per‑message cost; only worth it if you specifically want everything on Vercel.

**Recommendation:** deploy this as the single Node process it is.

```bash
# Fly.io (config included)
fly launch --copy-config --now      # uses Dockerfile + fly.toml

# or Docker anywhere
docker build -t buzz-online . && docker run -p 3000:3000 buzz-online
```

`fly.toml` keeps `min_machines_running = 1` and disables auto‑stop so live room
state is never evicted mid‑match, with a `/healthz` check.

### Scaling note
State is in‑process, so it's single‑instance today (plenty for one tournament —
many rooms, hundreds of players). To run multiple instances, add sticky sessions
+ a Redis Socket.IO adapter and move room state to Redis. Hooks for this are
isolated in `server/store.js`.

---

## Project layout

```
server/
  index.js     HTTP routes + Socket.IO wiring + buzz clamp/reconcile + MODAQ artifact APIs
  store.js     authoritative state: rooms, tournaments, scoring, cycle machine
  artifacts.js disk-backed store for MODAQ rosters/packets/exports/errata (KLAXON_DATA_DIR)
  config.js    all fairness/reliability tunables in one place
  ids.js       room codes + secret tokens
public/
  index.html   landing (create/join)
  room.html    the room (role-aware: reader controls vs player buzzer)
  tournament.html  director console (rooms, roster, packets, exports, errata)
  modaq/       built MODAQ moderator bundle (from the MODAQ repo; served at /modaq)
  js/          clocksync, room logic, landing, tournament, util  (vanilla ESM, no build)
  css/styles.css
Dockerfile, fly.toml
data/          MODAQ artifacts at runtime (gitignored; a Fly volume in prod)
```
