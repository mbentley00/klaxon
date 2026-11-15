// The server watching itself, and emailing the operator when it is in trouble.
//
// Two kinds of trouble, both learned the hard way on 2026-10-09:
// - STALLS. Fly runs this on a shared CPU that is throttled hard once its burst
//   credit is spent. A stalled event loop misses Fly's 3-second health check,
//   and while it is failing the proxy turns new connections away: players see
//   "the site won't load" on every device while the room carries on. Measured
//   here as event-loop delay, alongside CPU steal (see readProcStat).
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

// How the host is treating this machine's CPU. A Fly machine is a Firecracker
// VM, not a container: there is no cgroup cpu.stat to read, and the host
// holding it back shows up as STEAL in /proc/stat (time the VM wanted a CPU
// and didn't get one). On 2026-11-14 the old cgroup-only reading came back
// empty and the email said "CPU not throttled" while steal was at 92%.
// Returns jiffy counters summed over every CPU, or null where there is no
// /proc/stat (a laptop).
export function readProcStat(text) {
  try {
    const line = (text ?? fs.readFileSync('/proc/stat', 'utf8')).split('\n').find((l) => /^cpu\s/.test(l));
    if (!line) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
    return { busy: user + nice + system + irq + softirq, idle: idle + iowait, steal };
  } catch { return null; }
}

// Shares of the window between two readings: busy (this VM working), steal
// (the host holding it back), as fractions of all its CPUs.
export function cpuShares(before, after) {
  if (!before || !after) return null;
  const busy = after.busy - before.busy, idle = after.idle - before.idle, steal = after.steal - before.steal;
  const total = busy + idle + steal;
  if (total <= 0) return null;
  return { busy: busy / total, steal: steal / total };
}

// What a shared Fly vCPU may use without spending burst credit: 1/16 of each
// core. Above it the credit drains, and when it reaches zero the host
// throttles the machine to exactly that, which is what froze the server on
// 2026-11-14 after two hours of slow drain. KLAXON_CPU_BASELINE overrides
// (0 turns the warning off, e.g. on a performance CPU).
const BASELINE = (() => {
  const v = Number(process.env.KLAXON_CPU_BASELINE);
  return Number.isFinite(v) && v >= 0 ? v : 1 / 16;
})();
const DRAIN_WINDOWS = 20;             // warn when the last 10 minutes averaged above it...
const DRAIN_EMAIL_GAP_MS = 6 * 3600_000; // ...at most every 6 hours
const STEAL_THROTTLED = 0.2;          // a window this much stolen is the host throttling us

export function startWatchdog({ io, dataDir, send, to, describe = () => ({}), windowMs = WINDOW_MS, readStat = readProcStat }) {
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
  let cpuBefore = readStat();
  let procBefore = process.cpuUsage();
  let recent = [];                // stalled? for the last 4 windows
  let busyHistory = [];           // this VM's busy share, last DRAIN_WINDOWS windows
  let lastEmailAt = 0;
  let lastDrainEmailAt = 0;
  let lastWindow = null;

  function snapshot() {
    const cpuNow = readStat();
    const shares = cpuShares(cpuBefore, cpuNow);
    cpuBefore = cpuNow;
    const proc = process.cpuUsage(procBefore);
    procBefore = process.cpuUsage();
    const cpu = {
      // This process's own CPU time, in cores (0.1 = a tenth of one core).
      server: +((proc.user + proc.system) / 1e3 / windowMs).toFixed(3),
      ...(shares ? { busyPct: +(shares.busy * 100).toFixed(1), stealPct: +(shares.steal * 100).toFixed(1) } : { unknown: true })
    };
    const top = [...traffic.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
      .map(([k, v]) => ({ event: k, perSec: +(v.n / (windowMs / 1000)).toFixed(2), kbPerSec: +(v.bytes / windowMs).toFixed(1) }));
    traffic = new Map();
    const w = {
      at: new Date().toISOString(),
      loopDelayMs: { worst: Math.round(maxLag), totalStalled: Math.round(stalledMs) },
      cpu,
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
        `Event loop stalled in ${stalledWindows} of the last ${recent.length} ${windowMs / 1000}-second checks ` +
        `(worst ${w.loopDelayMs.worst} ms, ${w.loopDelayMs.totalStalled} ms in all). New connections are probably being refused.`,
        throttleVerdict(w.cpu),
      ], w).catch(() => {});
    }

    // Burst credit draining: the warning that would have come two hours early
    // on 2026-11-14. Fly can't be asked for the balance from in here, but a
    // VM busier than its baseline is spending it.
    if (w.cpu.busyPct != null) busyHistory = [...busyHistory, w.cpu.busyPct / 100].slice(-DRAIN_WINDOWS);
    const avg = busyHistory.reduce((a, b) => a + b, 0) / (busyHistory.length || 1);
    if (BASELINE > 0 && busyHistory.length >= DRAIN_WINDOWS && avg > BASELINE &&
        Date.now() - lastDrainEmailAt > DRAIN_EMAIL_GAP_MS) {
      lastDrainEmailAt = Date.now();
      report('Klaxon is using more CPU than it can sustain', [
        `The CPU has averaged ${(avg * 100).toFixed(1)}% busy over the last ${Math.round(DRAIN_WINDOWS * windowMs / 60000)} minutes. ` +
        `A shared Fly CPU sustains ${(BASELINE * 100).toFixed(2)}%; above that it spends burst credit, and when the credit ` +
        'runs out the machine is throttled and the server stalls.',
        'Check the balance (fly_instance_cpu_balance in Fly metrics). If it is falling, scale up before it reaches zero ' +
        '(fly scale vm shared-cpu-2x), ideally between rounds: it restarts the machine.',
      ], w).catch(() => {});
    }
  }, windowMs).unref();

  function throttleVerdict(cpu) {
    if (cpu.unknown) return 'Could not read CPU accounting (/proc/stat), so throttling is unknown. Check Fly metrics for CPU steal.';
    if (cpu.stealPct / 100 >= STEAL_THROTTLED) {
      return `The host is throttling this machine: ${cpu.stealPct}% of CPU time stolen in the last 30 s. ` +
        'Burst credit is likely spent. A bigger CPU (fly scale vm) fixes it; then find what used the credit.';
    }
    return `CPU not throttled (${cpu.stealPct}% steal, ${cpu.busyPct}% busy; the server process used ${cpu.server} cores). ` +
      'Something in the server is blocking.';
  }

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
        : 'The server did not shut down cleanly. No crash was recorded, so it was likely killed for memory or stopped.',
      previous ? `That run started at ${previous.startedAt}.` : '',
      crash?.stack ? `<pre style="white-space:pre-wrap;font-size:12px">${esc(crash.stack)}</pre>` : '',
    ], crash?.lastWindow || null).catch(() => {});
  }
  try { fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date(startedAt).toISOString(), pid: process.pid })); } catch { /* ignore */ }
  // Called by index.js's shutdown handler once records are saved.
  const cleanExit = () => { try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ } };

  function report(subject, paragraphs, window) {
    const body = paragraphs.filter(Boolean).map((p) => (p.startsWith('<pre') ? p : `<p>${esc(p)}</p>`)).join('') +
      (window ? `<p><strong>What the server was doing</strong> (last 30 s):</p>` +
        `<pre style="white-space:pre-wrap;font-size:12px;background:#f6f3ec;padding:10px">${esc(JSON.stringify(window, null, 2))}</pre>` : '') +
      '<p style="font-size:12px;color:#888">Fly: <code>fly logs -a klaxon-buzz</code> · metrics at fly.io/apps/klaxon-buzz/monitoring</p>';
    const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#17130d;line-height:1.5;max-width:640px">${body}</div>`;
    console.warn('[watchdog] report:', subject);
    return send({ to, subject: `[Klaxon] ${subject}`, html, text: paragraphs.filter((p) => !p.startsWith('<pre')).join('\n\n') });
  }

  return { snapshot: () => lastWindow, cleanExit };
}
