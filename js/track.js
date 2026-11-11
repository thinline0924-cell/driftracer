// Track data: a hand-traced centre line with left/right limits, a height map and a
// surface map derived from the scanned model. All queries are in world metres (x, z).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Track {
  static async load(dir) {
    const meta = await (await fetch(`${dir}/track.json`)).json();
    const [hb, sb] = await Promise.all([
      fetch(`${dir}/height.bin`).then(r => r.arrayBuffer()),
      fetch(`${dir}/surface.bin`).then(r => r.arrayBuffer()),
    ]);
    return new Track(meta, dir, new Uint16Array(hb), new Uint8Array(sb));
  }

  constructor(meta, dir, height, surface) {
    this.meta = meta; this.dir = dir;
    const m = meta.model;
    [this.x0, this.z0, this.x1, this.z1] = m.bounds;
    this.cell = m.cell;
    this.w = Math.round((this.x1 - this.x0) / m.cell);
    this.h = Math.round((this.z1 - this.z0) / m.cell);
    this.height = height; this.surface = surface;
    this.hLo = m.heightLo; this.hScale = (m.heightHi - m.heightLo) / 65534;
    this._spline(meta.line);
    this.startIdx = this.nearest(meta.start[0], meta.start[1]);
    this.sectorIdx = meta.sectors.map(p => this.rel(this.nearest(p[0], p[1])));
  }

  // closed centripetal Catmull-Rom through the control points, resampled every metre
  _spline(line) {
    const n = line.length, dense = [];
    const P = i => line[(i + n) % n];
    for (let i = 0; i < n; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const d = (a, b) => Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
      const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
      for (let k = 0; k < 24; k++) {
        const t = t1 + (t2 - t1) * k / 24, f = k / 24, o = [];
        for (let c = 0; c < 2; c++) {
          const a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
          const a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
          const a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
          const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
          const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
          o.push((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2);
        }
        // limits blend smoothly between control points; a barrier flag belongs to the nearer one
        const s = f * f * (3 - 2 * f);
        o.push(p1[2] + (p2[2] - p1[2]) * s, p1[3] + (p2[3] - p1[3]) * s, f < 0.5 ? p1[4] : p2[4]);
        dense.push(o);
      }
    }
    let total = 0; const acc = [0];
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i], b = dense[(i + 1) % dense.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]); acc.push(total);
    }
    const N = Math.round(total);
    this.n = N; this.length = total; this.step = total / N;
    this.px = new Float32Array(N); this.pz = new Float32Array(N);
    this.tx = new Float32Array(N); this.tz = new Float32Array(N);
    this.limL = new Float32Array(N); this.limR = new Float32Array(N); this.flags = new Uint8Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = i * this.step;
      while (acc[j + 1] < s) j++;
      const a = dense[j], b = dense[(j + 1) % dense.length], f = (s - acc[j]) / (acc[j + 1] - acc[j]);
      this.px[i] = a[0] + (b[0] - a[0]) * f; this.pz[i] = a[1] + (b[1] - a[1]) * f;
      this.limL[i] = a[2] + (b[2] - a[2]) * f; this.limR[i] = a[3] + (b[3] - a[3]) * f; this.flags[i] = a[4];
    }
    for (let i = 0; i < N; i++) {
      const a = (i + N - 1) % N, b = (i + 1) % N;
      const dx = this.px[b] - this.px[a], dz = this.pz[b] - this.pz[a], l = Math.hypot(dx, dz);
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
  }

  nearest(x, z, hint = -1, back = 25, ahead = 50) {
    const N = this.n; let best = 0, bd = 1e18;
    const from = hint < 0 ? 0 : hint - back, to = hint < 0 ? N - 1 : hint + ahead;
    for (let k = from; k <= to; k++) {
      const i = ((k % N) + N) % N, dx = x - this.px[i], dz = z - this.pz[i], d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // samples past the start line, 0..n-1
  rel(i) { return (i - this.startIdx + this.n) % this.n; }

  // position relative to the centre line: sample index, metres along past it, metres to the left of it
  locate(x, z, hint, out) {
    const i = this.nearest(x, z, hint);
    const dx = x - this.px[i], dz = z - this.pz[i];
    out.i = i;
    out.along = dx * this.tx[i] + dz * this.tz[i];
    out.side = dx * this.tz[i] - dz * this.tx[i];
    out.limL = this.limL[i]; out.limR = this.limR[i];
    return out;
  }

  _bilinear(arr, x, z) {
    const fx = clamp((x - this.x0) / this.cell, 0, this.w - 1.001), fz = clamp((z - this.z0) / this.cell, 0, this.h - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * this.w + i;
    const a = arr[k], b = arr[k + 1], c = arr[k + this.w], d = arr[k + this.w + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  // ground height in metres
  heightAt(x, z) { return this.hLo + (this._bilinear(this.height, x, z) - 1) * this.hScale; }

  // 1 on asphalt, 0 on grass / gravel
  gripAt(x, z) { return this._bilinear(this.surface, x, z) / 255; }

  // start position and heading: `back` metres before the line, on the centre line
  gridPose(back = this.meta.grid) {
    const i = (this.startIdx - Math.round(back / this.step) + this.n) % this.n;
    return { x: this.px[i], z: this.pz[i], psi: Math.atan2(this.tx[i], this.tz[i]), i };
  }
}
