// Central tunables. Everything that affects fairness/reliability lives here so
// it can be reasoned about (and audited) in one place.

export const PORT = process.env.PORT || 3000;

export const DEFAULTS = {
  // How long, after the FIRST buzz of a tossup arrives, the server keeps
  // collecting buzzes before deciding the order. This is the heart of
  // latency fairness: every buzz that lands inside this window is ranked by
  // its (clamped) press time, not its arrival time. ~250ms comfortably
  // covers the spread of human + network latency without feeling laggy.
  reconcileWindowMs: 250,

  // Hard ceiling on how far back a client is allowed to claim it pressed,
  // relative to its server-measured round-trip time. A buzz can never be
  // credited as earlier than (arrival - minRtt - slack). This is what stops
  // a cheater from spoofing an impossibly early timestamp.
  clampSlackMs: 40,

  // --- RTT / latency-clamp hardening (anti-cheat) ------------------------
  // The latency correction subtracted from a buzz is min(measuredRtt/2, this).
  // Capping it means a client that artificially inflates its measured RTT (by
  // stalling latency probes) gains nothing beyond this bound — the single most
  // important defense against the "inflate RTT to backdate every buzz" exploit.
  maxHalfRttMs: 125,

  // Probe RTT samples larger than this are discarded outright, so a stalled or
  // timed-out probe ack can never poison the (minimum-based) RTT estimate.
  maxRttSampleMs: 600,

  // How long we wait for a probe ack before giving up. Kept well under the old
  // 5s so a maximally-delayed ack can't register a multi-second "RTT".
  rttProbeTimeoutMs: 1500,

  // A single player may not register more than this many buzz attempts per
  // buzz-cycle (anti-spam / anti-DoS).
  maxBuzzAttemptsPerCycle: 1,

  // When the optional "auto-clear" room setting is on, the buzzer resets itself
  // this long after a buzz resolves (so the reader doesn't have to). Opt-in.
  autoClearMs: 5000,

  // Number of clock-sync samples a client takes on join.
  clockSyncSamples: 9
};

// Room/tournament codes: unambiguous uppercase alphabet (no O/0, I/1).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 4;
