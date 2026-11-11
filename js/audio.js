// Engine and tyre sound. Each car's engine is built from loops cut out of a recording of a
// real engine (assets/engine/<car>): every loop holds one constant pitch, and they are
// pitch-shifted and cross-faded by rpm, with a separate loop for a closed throttle. loops.json
// says how the loops map onto the rev range. Until the loops have loaded (or if they fail to),
// a simple synthesised engine stands in.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ramp = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

export class Sound {
  constructor() { this.ctx = null; this.muted = false; this.loops = null; this.load = 0; this.dir = null; this.token = 0; }

  // choose which car's engine to play; takes effect at once if the sound is already running
  setEngine(dir) {
    if (dir === this.dir) return;
    this.dir = dir;
    if (this.ctx) this._loadLoops();
  }

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
    const token = ++this.token, c = this.ctx, dir = this.dir;
    // stop the previous car's loops
    if (this.loops) for (const l of Object.values(this.loops.byName)) { l.gain.gain.setTargetAtTime(0, c.currentTime, 0.02); l.src.stop(c.currentTime + 0.2); }
    this.loops = null;
    if (!dir) return;
    try {
      const play = await (await fetch(dir + '/loops.json')).json(), byName = {};
      await Promise.all(play.loops.map(async l => {
        const data = await (await fetch(dir + '/' + l.file)).arrayBuffer();
        const buffer = await new Promise((res, rej) => c.decodeAudioData(data, res, rej));
        byName[l.name] = { buffer, hz: l.hz, minRate: (play.minRate && play.minRate[l.name]) || 0.5 };
      }));
      if (token !== this.token) return;          // another car was chosen while this one was loading
      for (const l of Object.values(byName)) {
        l.src = c.createBufferSource(); l.src.buffer = l.buffer; l.src.loop = true;
        l.gain = c.createGain(); l.gain.gain.value = 0;
        l.src.connect(l.gain); l.gain.connect(this.engLp); l.src.start();
      }
      this.loops = { play, byName, on: play.on.map(n => byName[n]), off: byName[play.off] };
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
      const { play, on, off } = this.loops, f = rpm * play.hzPerRpm;
      const set = (l, g) => {
        l.gain.gain.setTargetAtTime(g, t, 0.03);
        l.src.playbackRate.setTargetAtTime(clamp(f / l.hz, l.minRate, 2.4), t, 0.03);
      };
      // equal-power cross-fades from each loop to the next along the rev range
      const onGain = 0.3 + 0.7 * L;
      let carry = 1;
      for (let i = 0; i < on.length; i++) {
        const k = i < on.length - 1 ? ramp(rpm, play.fades[i][0], play.fades[i][1]) : 0;
        const w = carry * Math.cos(k * Math.PI / 2);
        set(on[i], w * (i === 0 && play.idleFirst ? 0.75 + 0.25 * L : onGain));
        carry *= Math.sin(k * Math.PI / 2);
      }
      if (off) set(off, (1 - L) * ramp(rpm, play.offFrom[0], play.offFrom[1]) * 0.8);
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
