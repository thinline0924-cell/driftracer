// Engine and tyre sound. The engine is built from loops cut out of a recording of a real
// six-cylinder race car (assets/engine): each loop holds one constant firing frequency, and
// they are pitch-shifted and cross-faded by rpm, with a separate loop for a closed throttle.
// Until the loops have loaded (or if they fail to), a simple synthesised engine stands in.

const DIR = 'assets/engine/';
// firing frequency heard at a given rpm. The recording's top loop (140 Hz) is placed at 4300 rpm.
const HZ_PER_RPM = 140 / 4300;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ramp = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

export class Sound {
  constructor() { this.ctx = null; this.muted = false; this.loops = null; this.load = 0; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.0; this.master.connect(c.destination);

    // engine bus: loops -> low-pass that opens with load -> gain (rev limiter chops it)
    this.engLp = c.createBiquadFilter(); this.engLp.type = 'lowpass'; this.engLp.frequency.value = 1200; this.engLp.Q.value = 0.6;
    this.engBus = c.createGain(); this.engBus.gain.value = 0;
    this.engLp.connect(this.engBus); this.engBus.connect(this.master);
    this._loadLoops();

    // stand-in synthesised engine
    this.synGain = c.createGain(); this.synGain.gain.value = 0;
    this.synLp = c.createBiquadFilter(); this.synLp.type = 'lowpass'; this.synLp.frequency.value = 600; this.synLp.Q.value = 1.2;
    this.osc = [['sawtooth', 0.5, 0.5], ['sawtooth', 1, 0.34], ['triangle', 0.25, 0.4]].map(([type, mul, gain]) => {
      const o = c.createOscillator(); o.type = type; const g = c.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(this.synLp); o.start(); return { o, mul };
    });
    this.synLp.connect(this.synGain); this.synGain.connect(this.master);

    // noise source shared by tyre squeal and surface rumble
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.sqBp = c.createBiquadFilter(); this.sqBp.type = 'bandpass'; this.sqBp.frequency.value = 900; this.sqBp.Q.value = 5;
    this.sqGain = c.createGain(); this.sqGain.gain.value = 0;
    noise.connect(this.sqBp); this.sqBp.connect(this.sqGain); this.sqGain.connect(this.master);
    const rLp = c.createBiquadFilter(); rLp.type = 'lowpass'; rLp.frequency.value = 220;
    this.rumGain = c.createGain(); this.rumGain.gain.value = 0;
    noise.connect(rLp); rLp.connect(this.rumGain); this.rumGain.connect(this.master);
    this.setMuted(this.muted);
  }

  async _loadLoops() {
    try {
      const c = this.ctx, list = await (await fetch(DIR + 'loops.json')).json(), loops = {};
      await Promise.all(list.map(async l => {
        const data = await (await fetch(DIR + l.file)).arrayBuffer();
        const buffer = await new Promise((res, rej) => c.decodeAudioData(data, res, rej));
        const src = c.createBufferSource(); src.buffer = buffer; src.loop = true;
        const gain = c.createGain(); gain.gain.value = 0;
        src.connect(gain); gain.connect(this.engLp); src.start();
        loops[l.name] = { src, gain, hz: l.hz };
      }));
      this.loops = loops;
    } catch (e) { console.warn('engine loops unavailable, using the synthesised engine', e); }
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  // rpm, throttle 0..1, slide 0..1 (tyres past the peak), offroad 0..1, speed m/s,
  // active (driving), cut (gear change in progress), limiter (on the rev limiter)
  update(rpm, throttle, slide, offroad, speed, active, cut = false, limiter = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // engine load follows the throttle with a short lag; a gear change drops it for a moment
    const want = cut ? 0 : throttle;
    this.load += (want - this.load) * (want > this.load ? 0.35 : 0.22);
    const L = this.load;

    if (this.loops) {
      const f = rpm * HZ_PER_RPM, lp = this.loops;
      const set = (l, g, minRate = 0.5) => {
        l.gain.gain.setTargetAtTime(g, t, 0.03);
        l.src.playbackRate.setTargetAtTime(clamp(f / l.hz, minRate, 2.4), t, 0.03);
      };
      // equal-power cross-fades between the loops along the rev range
      const a = ramp(rpm, 1500, 2600), b = ramp(rpm, 3500, 4300);
      const wIdle = Math.cos(a * Math.PI / 2), wLow = Math.sin(a * Math.PI / 2) * Math.cos(b * Math.PI / 2), wHigh = Math.sin(b * Math.PI / 2);
      const on = 0.3 + 0.7 * L;
      set(lp.idle, wIdle * (0.75 + 0.25 * L), 0.78);
      set(lp.on_low, wLow * on);
      set(lp.on_high, wHigh * on);
      set(lp.off, (1 - L) * a * 0.8);
      this.engLp.frequency.setTargetAtTime(700 + rpm * 0.45 + L * 5200, t, 0.05);
      const chop = limiter && (performance.now() / 30 | 0) % 2 ? 0.35 : 1;
      this.engBus.gain.setTargetAtTime(active ? 0.95 * chop * (0.8 + 0.2 * L) : 0, t, limiter ? 0.004 : 0.05);
      this.synGain.gain.setTargetAtTime(0, t, 0.05);
    } else {
      const f = rpm / 60 * 3;
      for (const { o, mul } of this.osc) o.frequency.setTargetAtTime(f * mul, t, 0.02);
      this.synLp.frequency.setTargetAtTime(350 + rpm * 0.16 + L * 2200, t, 0.04);
      this.synGain.gain.setTargetAtTime(active ? 0.1 + L * 0.16 : 0, t, 0.05);
    }

    const sq = active ? Math.min(1, slide) * Math.min(1, speed / 8) * (1 - offroad) : 0;
    this.sqGain.gain.setTargetAtTime(sq * 0.26, t, 0.06);
    this.sqBp.frequency.setTargetAtTime(760 + Math.min(1, speed / 40) * 520, t, 0.1);
    this.rumGain.gain.setTargetAtTime(active ? (0.04 + offroad * 0.5) * Math.min(1, speed / 25) : 0, t, 0.08);
  }
}
