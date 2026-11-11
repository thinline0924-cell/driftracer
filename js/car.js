// Vehicle dynamics: planar rigid body, four tyres with combined slip, load transfer,
// a driven rear axle with its own rotational state, and a simple engine/gearbox.
// No rendering here, so it can be run headless for tuning.
//
// Frame: heading psi, forward = (sin psi, cos psi) in world (x, z), left = (cos psi, -sin psi).
// Positive yaw rate and positive steer angle both mean "to the left".

const G = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const SUPRA = {
  mass: 1450,
  yawInertia: 2500,
  a: 1.215,            // CG to front axle (m)
  b: 1.235,            // CG to rear axle (m)
  trackF: 1.82,
  trackR: 1.72,
  cgHeight: 0.46,
  wheelRadius: 0.333,
  rollFront: 0.6,     // share of lateral load transfer carried by the front axle
  muFront: 1.27,
  muRear: 1.3,
  muOffroad: 0.62,
  loadSens: 0.14,      // grip falls as a tyre is loaded beyond its static load
  peakSlipAngleF: 0.13, // tan(alpha) at peak lateral force
  peakSlipAngleR: 0.15,
  peakSlipRatio: 0.11,
  tyreB: 3.08,         // tyre curve: peak 1.0 at normalised slip 1, ~0.92 when fully sliding
  tyreC: 1.25,
  absLateral: 0.8,     // share of front tyre capacity kept for cornering while braking
  v0: 3.0,             // slip denominators are floored at this speed (m/s)
  cdA: 0.72,
  rollRes: 0.014,
  offroadDrag: 0.09,
  maxSteer: 0.94,      // 54 deg lock (angle kit)
  steerRate: 6.0,      // rad/s at the wheels
  brakeForceF: 7800,   // N per front wheel at full pedal
  brakeTorqueR: 1150,  // Nm on the rear axle at full pedal
  handbrakeTorque: 5200,
  wheelInertia: 2.6,   // rear axle + both wheels
  engineInertia: 0.13,
  gears: [3.32, 2.08, 1.48, 1.14, 0.92, 0.76],
  reverse: 3.4,
  final: 3.73,
  efficiency: 0.9,
  idle: 950,
  redline: 7400,
  shiftUp: 7050,
  shiftDown: 3300,
  shiftTime: 0.13,
  // engine torque (Nm) at full throttle, by rpm
  torque: [[900, 310], [2000, 430], [3000, 540], [4200, 585], [5600, 575], [6600, 540], [7400, 470], [7800, 380]],
  engineBrake: 70,     // Nm at redline, closed throttle
};

function torqueAt(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
      return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

export class Car {
  constructor(spec = SUPRA) {
    this.p = spec;
    // body-frame wheel positions: [left, forward], order FL FR RL RR
    this.wheelPos = [
      [spec.trackF / 2, spec.a], [-spec.trackF / 2, spec.a],
      [spec.trackR / 2, -spec.b], [-spec.trackR / 2, -spec.b],
    ];
    this.assist = 0.92;
    this.tcAid = 1;      // 0 = off, 1 = full wheelspin trimming  // how strongly the front wheels self-align with the direction of travel
    this.reset(0, 0, 0);
  }

  reset(x, z, psi) {
    this.x = x; this.z = z; this.psi = psi;
    this.vx = 0; this.vz = 0; this.r = 0;
    this.steer = 0; this.throttle = 0; this.brake = 0; this.handbrake = 0;
    this.omega = 0;            // rear axle speed (rad/s)
    this.gear = 1;             // -1 reverse, 1..n
    this.shiftT = 0; this.shiftCool = 0;
    this.rpm = this.p.idle;
    this.axF = 0; this.ayF = 0; // low-passed body accelerations (m/s2)
    this.load = [0, 0, 0, 0];
    this.slip = [0, 0, 0, 0];   // normalised combined slip per tyre (1 = at the peak)
    this.slipRatioR = 0;
    this.surface = [1, 1, 1, 1]; // 1 asphalt .. 0 loose
    this.slopeF = 0; this.slopeL = 0;
    this.u = 0; this.v = 0; this.speed = 0; this.beta = 0;
    this.spin = [0, 0];         // wheel rotation angles for rendering: front, rear
  }

  // input: { steer -1..1 (left +), throttle 0..1, brake 0..1, handbrake 0..1 }
  step(dt, input) {
    const n = Math.max(1, Math.ceil(dt / (1 / 300)));
    const h = dt / n;
    this._driver(dt, input);
    for (let i = 0; i < n; i++) this._sub(h);
  }

  _driver(dt, input) {
    const p = this.p;
    let thr = input.throttle, brk = input.brake;
    // arcade convention: holding the brake at a standstill selects reverse
    if (this.gear > 0 && brk > 0.5 && thr < 0.1 && Math.abs(this.u) < 0.6) { this.gear = -1; this.shiftCool = 0.3; }
    else if (this.gear < 0 && thr > 0.5 && Math.abs(this.u) < 0.6) { this.gear = 1; this.shiftCool = 0.3; }
    if (this.gear < 0) { const t = thr; thr = brk; brk = t; }
    // pedals are smoothed so that keyboard taps are not step inputs
    const ease = (cur, tgt, up, down) => cur + clamp(tgt - cur, -down * dt, up * dt);
    this.throttle = ease(this.throttle, thr, 7, 12);
    this.brake = ease(this.brake, brk, 9, 14);
    this.handbrake = input.handbrake;

    // steering: the wheels self-align with the direction the front axle is travelling
    // (as a real steering wheel does when released), and the driver steers relative to that
    const speed = this.speed;
    const fade = clamp((speed - 2) / 6, 0, 1);
    const free = Math.atan2(this.v + this.r * p.a, Math.max(Math.abs(this.u), 2));
    const range = 0.15 + 0.46 * Math.exp(-speed / 13);
    // the part of the slide the wheels do not follow keeps a little front bite (it is what sustains a drift)
    const ab = Math.abs(this.beta);
    const deep = clamp(1 - (ab - 0.6) / 0.3, 0, 1);              // fades out past ~35-50 deg of slide
    const lag = clamp((1 - this.assist) * free, -0.055, 0.055) * deep;
    // steering further into a slide has less and less authority; steering out of it keeps all of it
    const into = input.steer * this.beta > 0 ? deep / (1 + ab / 0.16) : 1;
    const aligned = this.assist > 0 ? fade * (free - lag) : 0;
    const target = clamp(aligned + input.steer * range * (this.assist > 0 ? into : 1), -p.maxSteer, p.maxSteer);
    this.steer += clamp(target - this.steer, -p.steerRate * dt, p.steerRate * dt);

    // automatic gearbox
    this.shiftCool = Math.max(0, this.shiftCool - dt);
    if (this.gear > 0 && this.shiftT <= 0 && this.shiftCool <= 0) {
      const ratio = p.gears[this.gear - 1] * p.final;
      const wheelRpm = this.omega * ratio * 9.5493;
      // downshifts follow road speed, so a locked or spinning axle does not trigger them
      const roadRpm = this.speed / p.wheelRadius * ratio * 9.5493;
      if (wheelRpm > p.shiftUp && this.gear < p.gears.length && this.throttle > 0.2 && this.slipRatioR < 0.35) {
        this.gear++; this.shiftT = p.shiftTime; this.shiftCool = 0.45;
      } else if (roadRpm < p.shiftDown && this.gear > 1 && this.handbrake < 0.1) {
        const lower = roadRpm * p.gears[this.gear - 2] / p.gears[this.gear - 1];
        if (lower < p.shiftUp - 900) { this.gear--; this.shiftT = p.shiftTime; this.shiftCool = 0.45; }
      }
    }
  }

  _tyre(s) {
    return Math.sin(this.p.tyreC * Math.atan(this.p.tyreB * s));
  }

  // longitudinal + lateral force of one rear tyre for a given axle speed
  _rear(i, omega, vl, vs, fz, mu, out) {
    const p = this.p;
    const den = Math.max(Math.abs(vl), p.v0);
    const kx = (omega * p.wheelRadius - vl) / den, ky = vs / den;
    const nx = kx / p.peakSlipRatio, ny = ky / p.peakSlipAngleR;
    const s = Math.hypot(nx, ny);
    if (s < 1e-6) { out.fx = 0; out.fy = 0; out.s = 0; return; }
    const f = mu * fz * this._tyre(s);
    // below the peak the force follows the normalised slip; once sliding it opposes the
    // actual sliding velocity of the contact patch
    const sl = Math.hypot(kx, ky), w = clamp((s - 1) / 2, 0, 1);
    const dx = nx / s * (1 - w) + kx / sl * w, dy = ny / s * (1 - w) + ky / sl * w;
    const dn = Math.hypot(dx, dy);
    out.fx = f * dx / dn; out.fy = -f * dy / dn; out.s = s;
  }

  _sub(h) {
    const p = this.p;
    const sp = Math.sin(this.psi), cp = Math.cos(this.psi);
    const u = this.vx * sp + this.vz * cp;      // forward speed
    const v = this.vx * cp - this.vz * sp;      // leftward speed
    const r = this.r;
    const L = p.a + p.b;

    // wheel loads
    const w = p.mass * G;
    const dLong = p.mass * this.axF * p.cgHeight / L;
    const front = w * p.b / L - dLong, rear = w * p.a / L + dLong;
    const dLat = p.mass * this.ayF * p.cgHeight;
    const dF = dLat * p.rollFront / p.trackF, dR = dLat * (1 - p.rollFront) / p.trackR;
    const fz = this.load;
    fz[0] = Math.max(60, front / 2 - dF); fz[1] = Math.max(60, front / 2 + dF);
    fz[2] = Math.max(60, rear / 2 - dR); fz[3] = Math.max(60, rear / 2 + dR);
    const fz0F = w * p.b / L / 2, fz0R = w * p.a / L / 2;

    let Ff = 0, Fl = 0, Mz = 0;
    const cd = Math.cos(this.steer), sd = Math.sin(this.steer);

    // front tyres: free rolling, braked
    for (let i = 0; i < 2; i++) {
      const [lx, lz] = this.wheelPos[i];
      const vwf = u - r * lx, vwl = v + r * lz;
      const vl = vwf * cd + vwl * sd, vs = -vwf * sd + vwl * cd;
      const grip = this.surface[i];
      const mu = (p.muOffroad + (p.muFront - p.muOffroad) * grip) * (1 - p.loadSens * (fz[i] / fz0F - 1));
      const cap = mu * fz[i];
      const sy = vs / Math.max(Math.abs(vl), p.v0) / p.peakSlipAngleF;
      // ABS: cornering force is served first (up to a share of the tyre's capacity), and braking
      // takes what is left, so the car still turns with the pedal fully down
      const fy = -Math.sign(sy) * cap * Math.min(this._tyre(Math.abs(sy)), this.brake > 0.01 ? p.absLateral : 1);
      const room = Math.sqrt(Math.max(0, cap * cap - fy * fy));
      const fx = clamp(-p.brakeForceF * this.brake * clamp(vl / 0.5, -1, 1), -room, room);
      this.slip[i] = Math.hypot(sy, fx / cap);
      const bf = fx * cd - fy * sd, bl = fx * sd + fy * cd;
      Ff += bf; Fl += bl; Mz += lz * bl - lx * bf;
    }

    // drivetrain torque at the rear axle
    let ratio = 0, drive = 0, engaged = false;
    if (this.shiftT > 0) this.shiftT -= h;
    else {
      ratio = (this.gear > 0 ? p.gears[this.gear - 1] : -p.reverse) * p.final;
      engaged = true;
    }
    const wheelRpm = Math.abs(this.omega * ratio) * 9.5493;
    const launch = p.idle + this.throttle * 2600;                 // slipping clutch below this
    const rpm = engaged ? Math.max(wheelRpm, launch) : Math.max(p.idle, this.rpm - 4000 * h);
    this.rpm = rpm;
    if (engaged) {
      const cut = clamp((p.redline + 60 - rpm) / 120, 0, 1);       // rev limiter
      // wheelspin aid: trims torque as the rear slip ratio runs away, the way a driver feathers the throttle
      // and lifts when the slide gets deeper than the steering lock can catch
      const tc = this.tcAid > 0
        ? clamp(1 - this.tcAid * (this.slipRatioR - 0.35) / 0.6, 0.12, 1) * clamp(1 - this.tcAid * (Math.abs(this.beta) - 0.72) / 0.3, 0.2, 1)
        : 1;
      const te = this.throttle * torqueAt(p.torque, rpm) * cut * tc - (1 - this.throttle * cut) * p.engineBrake * rpm / p.redline;
      drive = te * ratio * p.efficiency;
      if (te < 0 && wheelRpm < launch) drive = 0;                   // no engine braking through a slipping clutch
    }

    // rear tyres, with the axle speed integrated implicitly (the tyre is very stiff in slip ratio)
    const o = this._o || (this._o = [{}, {}, {}, {}]);
    let sumFx = 0, sumK = 0;
    const eps = 0.5;
    for (let i = 2; i < 4; i++) {
      const [lx, lz] = this.wheelPos[i];
      const vl = u - r * lx, vs = v + r * lz;
      const grip = this.surface[i];
      const mu = (p.muOffroad + (p.muRear - p.muOffroad) * grip) * (1 - p.loadSens * (fz[i] / fz0R - 1));
      this._rear(i, this.omega, vl, vs, fz[i], mu, o[i]);
      this._rear(i, this.omega + eps, vl, vs, fz[i], mu, o[i - 2]);
      sumFx += o[i].fx; sumK += Math.max(0, (o[i - 2].fx - o[i].fx) / eps);
      o[i].vl = vl; o[i].vs = vs; o[i].mu = mu;
    }
    const inertia = p.wheelInertia + (engaged ? p.engineInertia * ratio * ratio : 0);
    let omega = this.omega + h * (drive - p.wheelRadius * sumFx) / (inertia + h * p.wheelRadius * sumK);
    const brakeT = p.brakeTorqueR * this.brake + p.handbrakeTorque * this.handbrake;
    if (brakeT > 0) {
      const d = h * brakeT / inertia;
      omega = Math.abs(omega) <= d ? 0 : omega - Math.sign(omega) * d;
    }
    this.omega = omega;
    let sr = 0;
    for (let i = 2; i < 4; i++) {
      const [lx, lz] = this.wheelPos[i];
      this._rear(i, omega, o[i].vl, o[i].vs, fz[i], o[i].mu, o[i]);
      this.slip[i] = o[i].s;
      sr += Math.abs(omega * p.wheelRadius - o[i].vl) / Math.max(Math.abs(o[i].vl), p.v0);
      Ff += o[i].fx; Fl += o[i].fy; Mz += lz * o[i].fy - lx * o[i].fx;
    }
    this.slipRatioR = sr / 2;

    // resistances and slope
    const speed = Math.hypot(u, v);
    if (speed > 0.05) {
      const off = 1 - (this.surface[0] + this.surface[1] + this.surface[2] + this.surface[3]) / 4;
      const res = 0.5 * 1.2 * p.cdA * speed * speed + (p.rollRes + p.offroadDrag * off) * w * clamp(speed / 1.5, 0, 1);
      Ff -= res * u / speed; Fl -= res * v / speed;
    }
    Ff -= w * this.slopeF; Fl -= w * this.slopeL;

    const ax = Ff / p.mass, ay = Fl / p.mass;
    this.vx += (ax * sp + ay * cp) * h;
    this.vz += (ax * cp - ay * sp) * h;
    this.r += Mz / p.yawInertia * h;
    this.psi += this.r * h;
    this.x += this.vx * h; this.z += this.vz * h;

    // tyre forces only; slope is felt as gravity, not as load transfer
    const k = h / (0.07 + h);
    this.axF += (ax + G * this.slopeF - this.axF) * k;
    this.ayF += (ay + G * this.slopeL - this.ayF) * k;

    this.u = u; this.v = v; this.speed = speed;
    this.beta = speed > 1.5 ? Math.atan2(-v, Math.abs(u)) : 0;   // drift angle, + in a left-hand slide
    this.spin[0] += (u / p.wheelRadius) * h;
    this.spin[1] += omega * h;
  }
}
