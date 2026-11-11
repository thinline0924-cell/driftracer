// Lap and sector timing against the track centre line, personal bests in localStorage,
// and per-lap statistics for the result screen.

const KEY = id => `slipangle.v1.${id}`;
const TRACE_STEP = 4;   // metres between samples of the time / speed traces

export function fmtLap(t) {
  if (t == null || !isFinite(t)) return '-:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}
export const fmtSec = t => (t == null || !isFinite(t) ? '--.---' : t.toFixed(3));
export const fmtDelta = d => (d == null || !isFinite(d) ? '-.---' : (d < 0 ? '−' : '+') + Math.abs(d).toFixed(3));

export class Timing {
  constructor(track) {
    this.track = track;
    this.slots = Math.ceil(track.n / TRACE_STEP);
    try { this.best = JSON.parse(localStorage.getItem(KEY(track.meta.id))); } catch { this.best = null; }
    if (this.best && (!this.best.times || this.best.times.length !== this.slots)) this.best = null;
    this.last = null;
    this.onLap = () => {};
    this.reset();
  }

  reset() {
    this.running = false;      // becomes true the first time the start line is crossed
    this.lapNo = 0; this.t = 0; this.sector = 0; this.splits = [];
    this.prevRel = null; this.valid = false; this.delta = null;
    this._newLap();
  }

  _newLap() {
    this.times = new Array(this.slots).fill(null);
    this.speeds = new Array(this.slots).fill(0);
    this.stats = { maxSpeed: 0, maxAngle: 0, angleSum: 0, angleTime: 0, driftDist: 0, maxG: 0, walls: 0 };
  }

  // rel: fractional samples past the start line; called once per physics frame
  update(dt, rel, car, wallHit) {
    const n = this.track.n, prev = this.prevRel;
    this.prevRel = rel;
    if (prev == null) return;
    const jump = rel - prev;
    const fwdCross = jump < -n / 2, backCross = jump > n / 2;
    if (this.running) this.t += dt;

    if (fwdCross) {
      // time of the crossing itself, from how far past the line the car already is
      const frac = Math.min(1, (rel * this.track.step) / Math.max(0.5, car.speed * dt));
      if (this.running && this.valid && this.sector === 2) this._finish(this.t - frac * dt);
      this.running = true; this.valid = true; this.lapNo++; this.t = frac * dt; this.sector = 0; this.splits = [];
      this._newLap();
    } else if (backCross) {
      this.valid = false;       // reversed over the line: this lap no longer counts
    }
    if (!this.running) return;

    // sector lines must be passed in order
    const next = this.track.sectorIdx[this.sector];
    if (this.sector < 2 && prev < next && rel >= next && jump < 40) {
      const frac = Math.min(1, ((rel - next) * this.track.step) / Math.max(0.5, car.speed * dt));
      this.splits.push(this.t - frac * dt); this.sector++;
    }

    const slot = Math.min(this.slots - 1, Math.floor(rel / TRACE_STEP));
    if (this.times[slot] == null) { this.times[slot] = this.t; this.speeds[slot] = car.speed * 3.6; }
    this.delta = this.best && this.valid && this.best.times[slot] != null ? this.t - this.best.times[slot] : null;

    const st = this.stats, ang = Math.abs(car.beta) * 57.2958, kmh = car.speed * 3.6;
    if (kmh > st.maxSpeed) st.maxSpeed = kmh;
    if (kmh > 25) {
      if (ang > st.maxAngle) st.maxAngle = ang;
      if (ang > 10) { st.angleSum += ang * dt; st.angleTime += dt; st.driftDist += car.speed * dt; }
    }
    const g = Math.abs(car.ayF) / 9.81; if (g > st.maxG) st.maxG = g;
    if (wallHit) st.walls++;
  }

  _finish(time) {
    const s = this.splits, sectors = [s[0], s[1] - s[0], time - s[1]];
    const prevBest = this.best;
    for (let i = 1; i < this.speeds.length; i++) if (this.times[i] == null) this.speeds[i] = this.speeds[i - 1];
    const isBest = !prevBest || time < prevBest.time;
    this.last = { time, sectors, stats: this.stats, speeds: this.speeds, lapNo: this.lapNo, isBest, prev: prevBest };
    if (isBest) {
      // fill gaps in the time trace so the live delta never drops out
      const times = this.times.slice(); let lastT = 0;
      for (let i = 0; i < times.length; i++) { if (times[i] == null) times[i] = lastT; lastT = times[i]; }
      this.best = { time, sectors, times: times.map(v => +v.toFixed(3)), speeds: this.speeds.map(v => Math.round(v)) };
      try { localStorage.setItem(KEY(this.track.meta.id), JSON.stringify(this.best)); } catch { /* storage unavailable */ }
    }
    this.onLap(this.last);
  }

  // live sector readout: finished sectors of this lap plus their delta to the best lap's sectors
  sectorTimes() {
    const s = this.splits, out = [null, null, null];
    if (s.length > 0) out[0] = s[0];
    if (s.length > 1) out[1] = s[1] - s[0];
    return out;
  }
}
