// NTP-style clock synchronization against the server.
//
// We need a shared time base so a buzz can be timestamped at the *moment of
// the press* rather than the moment it reaches the server. We take several
// round trips and keep the sample with the lowest RTT (least noisy estimate).
//
//   offset = serverTime - (t0 + t1) / 2     // add to client time => server time
//
// The result feeds buzz timestamps; the server independently re-clamps them,
// so a wrong/forged offset can only ever hurt you, never let you cheat.

export class ClockSync {
  constructor(socket) {
    this.socket = socket;
    this.offset = 0;     // ms to add to Date.now() to get server time
    this.rtt = 999;      // best round-trip seen
    this.ready = false;
  }

  async sync(samples = 9) {
    const results = [];
    for (let i = 0; i < samples; i++) {
      const sample = await this._one();
      if (sample) results.push(sample);
      await new Promise((r) => setTimeout(r, 60));
    }
    if (results.length) {
      results.sort((a, b) => a.rtt - b.rtt);
      // Average the offsets of the best third of samples for stability.
      const best = results.slice(0, Math.max(1, Math.ceil(results.length / 3)));
      this.offset = best.reduce((s, r) => s + r.offset, 0) / best.length;
      this.rtt = best[0].rtt;
      this.ready = true;
    }
    return { offset: this.offset, rtt: this.rtt };
  }

  _one() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const timer = setTimeout(() => { if (!done) resolve(null); }, 4000);
      this.socket.emit('clock_sync', null, (resp) => {
        done = true;
        clearTimeout(timer);
        const t1 = Date.now();
        if (!resp) return resolve(null);
        resolve({ offset: resp.serverTime - (t0 + t1) / 2, rtt: t1 - t0 });
      });
    });
  }

  // Current best estimate of the server clock.
  now() {
    return Date.now() + this.offset;
  }
}
