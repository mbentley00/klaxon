// The server watching itself, and emailing the operator when it is in trouble.
//
// Two kinds of trouble, both learned the hard way on 2026-10-09:
// - STALLS. Fly runs this on a shared CPU that is throttled hard once its burst
//   credit is spent. A stalled event loop misses Fly's 3-second health check,
//   and while it is failing the proxy turns new connections away: players see
//   "the site won't load" on every device while the room carries on. Measured
//   here as event-loop delay, alongside the cgroup's own throttle counters.
// - CRASHES. A process that dies can't send anything, so it leaves a note on
//   the volume; the next start finds the note (or finds it never shut down
//   cleanly) and sends the report then.
//
// Each report says what the server was doing: rooms, sockets, memory, and the
// socket traffic by event, which is what found the 2026-10-09 cause (an idle
// MODAQ reader re-sending its whole game twice a second).
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const WINDOW_MS = 30_000;
const STALL_MS = 1500;           // a window with a tick this late is a stall...
const STALL_WINDOWS = 2;          // ...and this many of the last 4 is worth an email (a stall delays the
                                  // check itself, so stalled and clean windows alternate: never 'in a row')
const EMAIL_GAP_MS = 60 * 60_000; // at most one stall email an hour

const fmtMB = (b) => `${Math.round(b / 1e6)} MB`;
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// cgroup v2 CPU accounting: nr_throttled / throttled_usec climb while the host
// is holding this machine back. Absent outside a container.
function readCpuStat() {
  try {
    const out = {};
    for (const line of fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').split('\n')) {
      const [k, v] = line.trim().split(/\s+/);
      if (k) out[k] = Number(v);
    }
    return out;
  } catch { return null; }
}

export function startWatchdog({ io, dataDir, send, to, describe = () => ({}), windowMs = WINDOW_MS }) {
  const marker = path.join(dataDir, 'watchdog-running.json');
  const crashNote = path.join(dataDir, 'watchdog-crash.json');
  const startedAt = Date.now();

  // ---- traffic by socket event, per window ----
  // Counted at the engine.io packet (a string already in hand), so it costs a
  // regex on the first few characters, not a JSON round trip.
  let traffic = new Map();
  const count = (key, bytes) => {
    const t = traffic.get(key) || { n: 0, bytes: 0 };
    t.n++; t.bytes += bytes; traffic.set(key, t);
  };
  io.on('connection', (socket) => {
    socket.conn.on('packet', (p) => {
      if (p.type !== 'message' || typeof p.data !== 'string') return;
      const m = p.data.slice(0, 80).match(/^\d+\["([^"]+)"(?:,\{"action":"([^"]+)")?/);
      count(m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]) : 'other', p.data.length);
    });
  });

  // ---- event-loop delay ----
  // A tick every 100 ms, and how late each one ran. (perf_hooks' histogram
  // samples on its own timer, which a long block starves: it under-reports
  // exactly the stalls this is for.)
  const TICK_MS = 100;
  let maxLag = 0, stalledMs = 0, lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - TICK_MS;
    if (lag > maxLag) maxLag = lag;
    if (lag > 200) stalledMs += lag;
    lastTick = now;
  }, TICK_MS).unref();
  let cpuBefore = readCpuStat();
  let recent = [];                // stalled? for the last 4 windows
  let lastEmailAt = 0;
  let lastWindow = null;

  function snapshot() {
    const cpu = readCpuStat();
    const throttle = cpu && cpuBefore ? {
      periods: (cpu.nr_throttled ?? 0) - (cpuBefore.nr_throttled ?? 0),
      seconds: ((cpu.throttled_usec ?? 0) - (cpuBefore.throttled_usec ?? 0)) / 1e6,
      usageSeconds: ((cpu.usage_usec ?? 0) - (cpuBefore.usage_usec ?? 0)) / 1e6
    } : null;
    cpuBefore = cpu;
    const top = [...traffic.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
      .map(([k, v]) => ({ event: k, perSec: +(v.n / (windowMs / 1000)).toFixed(2), kbPerSec: +(v.bytes / windowMs).toFixed(1) }));
    traffic = new Map();
    const w = {
      at: new Date().toISOString(),
      loopDelayMs: { worst: Math.round(maxLag), totalStalled: Math.round(stalledMs) },
      throttle,
      sockets: io.engine.clientsCount,
      memory: { rss: fmtMB(process.memoryUsage().rss), heap: fmtMB(process.memoryUsage().heapUsed) },
      uptimeMin: Math.round((Date.now() - startedAt) / 60000),
      topTraffic: top,
      ...describe()
    };
    maxLag = 0;
    stalledMs = 0;
    return w;
  }

  setInterval(() => {
    const w = snapshot();
    lastWindow = w;
    const stalled = w.loopDelayMs.worst > STALL_MS;
    recent = [...recent, stalled].slice(-4);
    const stalledWindows = recent.filter(Boolean).length;
    if (stalled) console.warn('[watchdog] event loop stalled', JSON.stringify(w));
    if (stalled && stalledWindows >= STALL_WINDOWS && Date.now() - lastEmailAt > EMAIL_GAP_MS) {
      lastEmailAt = Date.now();
      report('Klaxon is stalling', [
        `The server's event loop has stalled in ${stalledWindows} of the last ${recent.length} ${windowMs / 1000}-second checks ` +
        `(worst ${w.loopDelayMs.worst} ms frozen, ${w.loopDelayMs.totalStalled} ms frozen in all). Fly's health check allows 3 s, ` +
        'so new connections are probably being refused right now.',
        w.throttle && w.throttle.seconds > 1
          ? `The CPU is being throttled (${w.throttle.seconds.toFixed(1)} s throttled in the last 30 s): the shared-CPU burst credit is likely spent. ` +
            'Look at what is using it below; a bigger or performance CPU (fly scale vm) buys time.'
          : 'The CPU is not being throttled, so something in the server itself is blocking — see the traffic below.',
      ], w).catch(() => {});
    }
  }, windowMs).unref();

  // ---- crashes ----
  const writeCrash = (kind, err) => {
    try {
      fs.writeFileSync(crashNote, JSON.stringify({
        kind, at: new Date().toISOString(), message: String(err?.message ?? err), stack: String(err?.stack ?? ''), lastWindow
      }));
    } catch { /* the volume may be the problem */ }
  };
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException', err);
    writeCrash('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    // Logged and kept: one stray promise shouldn't take every room down.
    console.error('unhandledRejection', err);
  });

  // A start that finds the marker means the last run never shut down cleanly
  // (crash, out of memory, the machine killed).
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* clean start */ }
  let crash = null;
  try { crash = JSON.parse(fs.readFileSync(crashNote, 'utf8')); fs.rmSync(crashNote); } catch { /* none */ }
  if (previous || crash) {
    report('Klaxon restarted after a crash', [
      crash
        ? `The server died with ${crash.kind}: ${crash.message}`
        : 'The server did not shut down cleanly (no crash was recorded — likely killed for memory, or the machine was stopped).',
      previous ? `That run started at ${previous.startedAt}.` : '',
      crash?.stack ? `<pre style="white-space:pre-wrap;font-size:12px">${esc(crash.stack)}</pre>` : '',
    ], crash?.lastWindow || null).catch(() => {});
  }
  try { fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date(startedAt).toISOString(), pid: process.pid })); } catch { /* ignore */ }
  const cleanExit = () => { try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ } };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { cleanExit(); process.exit(0); });
  }

  function report(subject, paragraphs, window) {
    const body = paragraphs.filter(Boolean).map((p) => (p.startsWith('<pre') ? p : `<p>${esc(p)}</p>`)).join('') +
      (window ? `<p><strong>What the server was doing</strong> (last 30 s):</p>` +
        `<pre style="white-space:pre-wrap;font-size:12px;background:#f6f3ec;padding:10px">${esc(JSON.stringify(window, null, 2))}</pre>` : '') +
      '<p style="font-size:12px;color:#888">Fly: <code>fly logs -a klaxon-buzz</code> · metrics at fly.io/apps/klaxon-buzz/monitoring</p>';
    const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#17130d;line-height:1.5;max-width:640px">${body}</div>`;
    console.warn('[watchdog] report:', subject);
    return send({ to, subject: `[Klaxon] ${subject}`, html, text: paragraphs.filter((p) => !p.startsWith('<pre')).join('\n\n') });
  }

  return { snapshot: () => lastWindow };
}
