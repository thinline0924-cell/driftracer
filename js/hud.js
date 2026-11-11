// DOM bindings for the driving HUD and the two menu screens.
// The desktop and phone layouts share keys, so every key may map to several elements.
import { fmtLap, fmtSec, fmtDelta } from './timing.js';

const SVG = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Hud {
  constructor() {
    this.text = {}; this.cache = {};
    for (const el of document.querySelectorAll('[data-b]')) (this.text[el.dataset.b] ||= []).push(el);
    this.bars = {}; for (const el of document.querySelectorAll('[data-bar]')) (this.bars[el.dataset.bar] ||= []).push(el);
    this.vbars = {}; for (const el of document.querySelectorAll('[data-v]')) (this.vbars[el.dataset.v] ||= []).push(el);
    this.gdot = document.querySelector('[data-dot="g"]');
    this.revs = [...document.querySelectorAll('.rev')];
    this.bannerT = 0;
  }

  set(key, value, cls) {
    const k = value + '|' + (cls || '');
    if (this.cache[key] === k) return;
    this.cache[key] = k;
    for (const el of this.text[key] || []) {
      el.textContent = value;
      if (cls !== undefined) { el.classList.toggle('gainc', cls === 'gain'); el.classList.toggle('lossc', cls === 'loss'); }
    }
  }

  // bar growing from the centre mark; v in -1..1, positive to the right
  centre(key, v) {
    v = clamp(v, -1, 1); const w = Math.abs(v) * 50;
    for (const el of this.bars[key] || []) { el.style.left = (v >= 0 ? 50 : 50 - w).toFixed(1) + '%'; el.style.width = w.toFixed(1) + '%'; }
  }
  fill(key, v) { for (const el of this.bars[key] || []) el.style.width = (clamp(v, 0, 1) * 100).toFixed(1) + '%'; }
  vfill(key, v, hot) {
    for (const el of this.vbars[key] || []) { el.style.height = (clamp(v, 0, 1) * 100).toFixed(1) + '%'; if (hot !== undefined) el.classList.toggle('acc', hot); }
  }

  // map: world (x, z) fitted into a 200x130 box, north up as in the scan
  buildMap(track) {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < track.n; i++) { x0 = Math.min(x0, track.px[i]); x1 = Math.max(x1, track.px[i]); z0 = Math.min(z0, track.pz[i]); z1 = Math.max(z1, track.pz[i]); }
    const s = Math.min(184 / (x1 - x0), 114 / (z1 - z0));
    const ox = 100 - (x0 + x1) / 2 * s, oz = 65 - (z0 + z1) / 2 * s;
    this.mapXY = (x, z) => [x * s + ox, z * s + oz];
    let d = '';
    for (let i = 0; i < track.n; i += 3) { const [x, y] = this.mapXY(track.px[i], track.pz[i]); d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }
    d += 'Z';
    const tick = (idx, len) => {
      const [x, y] = this.mapXY(track.px[idx], track.pz[idx]), nx = track.tz[idx], ny = -track.tx[idx];
      return `M${(x + nx * len).toFixed(1)} ${(y + ny * len).toFixed(1)}L${(x - nx * len).toFixed(1)} ${(y - ny * len).toFixed(1)}`;
    };
    const abs = r => (r + track.startIdx) % track.n;
    const draw = (svg, stroke, withDot) => {
      svg.replaceChildren();
      const add = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
      add('path', { d, fill: 'none', stroke: '#ECEAE4', 'stroke-width': stroke, 'stroke-linejoin': 'round' });
      for (const r of track.sectorIdx) add('path', { d: tick(abs(r), 5), stroke: '#9A9DA1', 'stroke-width': stroke * 0.7 });
      add('path', { d: tick(track.startIdx, 6), stroke: '#FF5B1F', 'stroke-width': stroke * 1.2 });
      return withDot ? add('circle', { r: 4.5, fill: '#FF5B1F' }) : null;
    };
    this.dot = draw(document.getElementById('minimap'), 2, true);
    draw(document.getElementById('selmap'), 1.2, false);
  }

  banner(text, cls) {
    for (const el of this.text.banner) { el.textContent = text; el.classList.toggle('gainc', cls === 'gain'); el.classList.toggle('lossc', cls === 'loss'); el.classList.add('on'); }
    this.bannerT = 4.5;
  }

  drive(dt, car, timing, track, input) {
    const kmh = car.speed * 3.6;
    this.set('lap', timing.running ? fmtLap(timing.t) : '0:00.000');
    this.set('lapNo', 'LAP ' + String(Math.max(1, timing.lapNo)).padStart(2, '0'));
    this.set('best', fmtLap(timing.best && timing.best.time));
    const st = timing.sectorTimes(), bs = timing.best && timing.best.sectors;
    for (let i = 0; i < 3; i++) {
      this.set('s' + (i + 1), fmtSec(st[i]));
      const d = st[i] != null && bs ? st[i] - bs[i] : null;
      this.set('d' + (i + 1), fmtDelta(d), d == null ? '' : d < 0 ? 'gain' : 'loss');
    }
    this.set('sector', String(timing.sector + 1));
    this.set('course', track.meta.name);
    const dl = timing.delta;
    this.set('delta', fmtDelta(dl), dl == null ? '' : dl < 0 ? 'gain' : 'loss');
    this.centre('delta', dl == null ? 0 : dl);
    for (const el of this.bars.delta || []) el.style.background = dl != null && dl < 0 ? 'var(--gain)' : 'var(--acc)';

    const ang = car.beta * 57.2958, a = Math.abs(ang);
    this.set('drift', String(Math.round(a)));
    this.set('driftDir', a < 3 ? '–' : ang > 0 ? 'L' : 'R');
    this.centre('drift', -ang / 60);
    const sd = car.steer * 57.2958;
    this.set('steer', (sd > 0.5 ? 'L ' : sd < -0.5 ? 'R ' : '') + Math.abs(sd).toFixed(0) + '°');
    this.centre('steer', -car.steer / car.p.maxSteer);
    const gl = -car.ayF / 9.81, gn = car.axF / 9.81;     // + lateral = pushed to the right
    this.set('gLat', (gl < 0 ? '−' : '+') + Math.abs(gl).toFixed(2) + ' G');
    this.set('gLon', (gn < 0 ? '−' : '+') + Math.abs(gn).toFixed(2) + ' G');
    if (this.gdot) { const r = this.gdot.parentElement.clientWidth / 2; this.gdot.style.transform = `translate(${(clamp(gl, -1.4, 1.4) / 1.4 * r).toFixed(1)}px, ${(clamp(-gn, -1.4, 1.4) / 1.4 * r).toFixed(1)}px)`; }

    this.set('speed', String(Math.round(kmh)));
    this.set('gear', car.gear < 0 ? 'R' : String(car.gear));
    this.set('rpm', String(Math.round(car.rpm / 10) * 10));
    this.fill('rev', car.rpm / 8000);
    const lim = car.rpm > car.p.redline - 150;
    for (const el of this.revs) el.classList.toggle('lim', lim);

    const fzMax = car.p.mass * 9.81 * 0.5;
    for (let i = 0; i < 4; i++) {
      const hot = car.slip[i] > 1.15;
      this.vfill('l' + i, car.load[i] / fzMax, hot);
      this.set('t' + i, Math.min(9.99, car.slip[i]).toFixed(2), hot ? 'loss' : '');
    }
    this.vfill('thr', car.throttle); this.vfill('brk', car.brake); this.vfill('hb', car.handbrake);

    if (this.dot) { const [x, y] = this.mapXY(car.x, car.z); this.dot.setAttribute('cx', x.toFixed(1)); this.dot.setAttribute('cy', y.toFixed(1)); }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) for (const el of this.text.banner) el.classList.remove('on'); }
  }

  select(tracks, sel, best, credit, onPick) {
    const track = tracks[sel];
    const list = document.getElementById('course-list');
    list.innerHTML = '';
    tracks.forEach((t, i) => {
      const b = document.createElement('button'); b.className = 'course' + (i === sel ? ' sel' : '');
      const no = String(i + 1).padStart(2, '0');
      b.innerHTML = i === sel ? `<span class="no">${no}</span><span class="nm"><b>${t.meta.name}</b><small>${t.meta.subtitle}</small></span>`
        : `<span class="no">${no}</span><span class="nm">${t.meta.name}</span>`;
      b.addEventListener('click', () => onPick(i));
      list.appendChild(b);
    });
    this.set('selLength', (track.length / 1000).toFixed(2) + ' km');
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < track.n; i += 4) { const h = track.heightAt(track.px[i], track.pz[i]); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    this.set('selElev', Math.round(hi - lo) + ' m');
    this.set('selBest', fmtLap(best && best.time));
    for (let i = 0; i < 3; i++) this.set('selS' + (i + 1), fmtSec(best && best.sectors[i]));
    document.getElementById('credit').textContent = credit;
  }

  result(track, last, lapNo) {
    this.set('resHead', `${track.meta.name} · GR SUPRA DRIFT` + (last ? ` · LAP ${String(last.lapNo).padStart(2, '0')}` : ''));
    const flag = this.text.resFlag[0];
    if (!last) {
      flag.className = 'flag'; flag.textContent = 'ラップ未完了 — スタートラインを通過して1周すると記録されます';
      this.set('resLap', '-:--.---'); this.set('resDelta', ''); this.set('resPrev', '');
      for (let i = 1; i <= 3; i++) { this.set('rs' + i, '--.---'); this.set('rp' + i, '--.---'); this.set('rd' + i, '-.---', ''); }
      for (const k of ['stSpeed', 'stMaxAng', 'stAvgAng', 'stDist', 'stG', 'stWall']) this.set(k, '—');
      document.getElementById('trace').replaceChildren();
      return;
    }
    const prev = last.prev;
    flag.className = 'flag' + (last.isBest ? ' best' : '');
    flag.textContent = last.isBest ? (prev ? '自己ベスト更新' : '初回の記録') : '直前のラップ';
    this.set('resLap', fmtLap(last.time));
    const d = prev ? last.time - prev.time : null;
    this.set('resDelta', prev ? fmtDelta(d) : '', d == null ? '' : d < 0 ? 'gain' : 'loss');
    this.set('resPrev', prev ? (last.isBest ? 'これまでのベスト ' : '自己ベスト ') + fmtLap(prev.time) : '');
    for (let i = 0; i < 3; i++) {
      this.set('rs' + (i + 1), fmtSec(last.sectors[i]));
      this.set('rp' + (i + 1), fmtSec(prev && prev.sectors[i]));
      const sd = prev ? last.sectors[i] - prev.sectors[i] : null;
      this.set('rd' + (i + 1), fmtDelta(sd), sd == null ? '' : sd < 0 ? 'gain' : 'loss');
    }
    const s = last.stats;
    this.set('stSpeed', String(Math.round(s.maxSpeed)));
    this.set('stMaxAng', String(Math.round(s.maxAngle)));
    this.set('stAvgAng', s.angleTime > 0.2 ? String(Math.round(s.angleSum / s.angleTime)) : '0');
    this.set('stDist', String(Math.round(s.driftDist)));
    this.set('stG', s.maxG.toFixed(2));
    this.set('stWall', String(s.walls));

    // speed trace: this lap and the previous best over distance
    const svg = document.getElementById('trace'); svg.replaceChildren();
    const add = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); };
    const top = Math.max(60, ...last.speeds, ...(prev ? prev.speeds : [])) * 1.08;
    const pts = arr => arr.map((v, i) => `${(i / (arr.length - 1) * 640).toFixed(1)},${(168 - v / top * 166).toFixed(1)}`).join(' ');
    add('path', { d: 'M0 169.5H640', stroke: '#3A3E42', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    const cuts = track.sectorIdx.map(r => r / track.n);
    for (const c of cuts) add('path', { d: `M${(c * 640).toFixed(1)} 0V170`, stroke: '#3A3E42', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    if (prev) add('polyline', { points: pts(prev.speeds), fill: 'none', stroke: '#9A9DA1', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    add('polyline', { points: pts(last.speeds), fill: 'none', stroke: '#ECEAE4', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' });
    document.getElementById('tsec').style.gridTemplateColumns = `${(cuts[0] * 100).toFixed(1)}% ${((cuts[1] - cuts[0]) * 100).toFixed(1)}% 1fr`;
  }
}
