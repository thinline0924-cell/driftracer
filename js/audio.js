// Synthesised engine and tyre sound. Started from a user gesture.

export class Sound {
  constructor() { this.ctx = null; this.muted = false; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.0; this.master.connect(c.destination);

    // engine: three oscillators at harmonics of the firing frequency, through a low-pass that opens with load
    this.engGain = c.createGain(); this.engGain.gain.value = 0.2;
    this.engLp = c.createBiquadFilter(); this.engLp.type = 'lowpass'; this.engLp.frequency.value = 600; this.engLp.Q.value = 1.2;
    const shaper = c.createWaveShaper(); const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(2.4 * x); }
    shaper.curve = curve;
    this.osc = [['sawtooth', 0.5, 0.5], ['sawtooth', 1, 0.34], ['square', 1.5, 0.1], ['triangle', 0.25, 0.4]].map(([type, mul, gain]) => {
      const o = c.createOscillator(); o.type = type; const g = c.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(shaper); o.start(); return { o, mul };
    });
    shaper.connect(this.engLp); this.engLp.connect(this.engGain); this.engGain.connect(this.master);

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

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  // rpm, throttle 0..1, slide 0..1 (tyres past the peak), offroad 0..1, speed m/s
  update(rpm, throttle, slide, offroad, speed, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = rpm / 60 * 3;      // inline six: three firings per revolution
    for (const { o, mul } of this.osc) o.frequency.setTargetAtTime(f * mul, t, 0.02);
    this.engLp.frequency.setTargetAtTime(350 + rpm * 0.16 + throttle * 2200, t, 0.04);
    this.engGain.gain.setTargetAtTime(active ? 0.1 + throttle * 0.16 : 0, t, 0.05);
    const sq = active ? Math.min(1, slide) * Math.min(1, speed / 8) * (1 - offroad) : 0;
    this.sqGain.gain.setTargetAtTime(sq * 0.3, t, 0.06);
    this.sqBp.frequency.setTargetAtTime(760 + Math.min(1, speed / 40) * 520, t, 0.1);
    this.rumGain.gain.setTargetAtTime(active ? (0.05 + offroad * 0.5) * Math.min(1, speed / 25) : 0, t, 0.08);
  }
}
