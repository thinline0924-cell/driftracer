import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Track } from './track.js';
import { Car } from './car.js';
import { Input } from './input.js';
import { Timing, fmtLap, fmtDelta } from './timing.js';
import { Hud } from './hud.js';
import { Smoke, Skid } from './fx.js';
import { Sound } from './audio.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const CAR_CREDIT = '"2019 Toyota GR Supra Drift by HKS" by SIU Car Garage, CC BY-NC 4.0';
const ASSISTS = [['弱', 0.92, 1], ['強', 1.0, 1], ['オフ', 0, 0]];   // label, countersteer follow, wheelspin aid
const PHYS_DT = 1 / 120;
const WALL_MARGIN = 0.95;   // half the car's width: the limits are measured to the barrier face

const coarse = matchMedia('(pointer: coarse)').matches;
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);

const input = new Input(), hud = new Hud(), sound = new Sound(), car = new Car();
let track, timing, smoke, skids, carRoot, bodyNode, wheels = [], shadow, lampMat, lampGlow = [], lampLevel = 0;
let state = 'loading', camMode = 0, camYaw = 0, hint = -1, acc = 0, last = 0, wallFlash = 0;
let assistIdx = +(localStorage.getItem('slipangle.assist') || 0) % ASSISTS.length;
const loc = {}, pose = { y: 0, pitch: 0, roll: 0, ready: false };
const wheelWorld = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const SKY_TOP = 0x6d8fb3, SKY_HORIZON = 0xc8d3da;

function setLoad(frac, msg) { $('load-bar').style.width = Math.round(frac * 100) + '%'; if (msg) $('load-msg').textContent = msg; }

function loadGLB(loader, url, onFrac) {
  return new Promise((res, rej) => loader.load(url, res, e => onFrac(e.total ? e.loaded / e.total : 0), rej));
}

function gradientTexture(stops, w = 4, h = 256) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, h);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function buildWorld() {
  // sky dome, haze and a plain below the scan so its edges fall away into distance
  const skyTex = gradientTexture([[0, '#5f84ab'], [0.42, '#9db7cc'], [0.5, '#c8d3da'], [0.52, '#8b8a78'], [1, '#55543f']]);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 24, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10; scene.add(sky);
  scene.fog = new THREE.Fog(SKY_HORIZON, 260, 1500);
  const plain = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshBasicMaterial({ color: 0x5c5a45 }));
  plain.rotation.x = -Math.PI / 2; plain.position.y = track.hLo - 3; scene.add(plain);

  // light for the car only (the scan carries its own baked light); sun low in the south-east as in the scan
  scene.add(new THREE.HemisphereLight(0xe3ecf5, 0x57523f, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4); sun.position.set(0.7, 0.55, 0.8); scene.add(sun);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide })));
  const disc = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  disc.position.set(28, 22, 32); envScene.add(disc);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02).texture; scene.environmentIntensity = 0.9;
  pm.dispose();
}

function placeTrackModel(gltf) {
  const m = track.meta.model, root = gltf.scene;
  root.scale.setScalar(m.scale);
  root.position.set(-m.center[0] * m.scale, 0, -m.center[1] * m.scale);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.matrixAutoUpdate = false; o.frustumCulled = false;
    if (o.material.map) { o.material.map.anisotropy = aniso; o.material.map.needsUpdate = true; }
  });
  root.updateMatrixWorld(true);
  scene.add(root);
}

// barrier blocks along the limits that have no real barrier in the scan, and the start line
function buildTrackProps() {
  const spots = [];
  for (let i = 0; i < track.n; i += 2) {
    for (const side of [1, 2]) {
      if (!(track.flags[i] & side)) continue;
      const s = side === 1 ? 1 : -1, lim = (side === 1 ? track.limL[i] : track.limR[i]) + 0.35;
      spots.push([track.px[i] + s * track.tz[i] * lim, track.pz[i] - s * track.tx[i] * lim, Math.atan2(track.tx[i], track.tz[i]), i >> 1]);
    }
  }
  const geo = new THREE.BoxGeometry(0.42, 0.56, 1.9);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), spots.length);
  const d = new THREE.Object3D(), white = new THREE.Color(0xe6e3dc), red = new THREE.Color(0xc4391c);
  spots.forEach(([x, z, yaw, k], n) => {
    d.position.set(x, track.heightAt(x, z) + 0.3, z); d.rotation.set(0, yaw, 0); d.updateMatrix();
    inst.setMatrixAt(n, d.matrix); inst.setColorAt(n, k % 2 ? white : red);
  });
  inst.instanceMatrix.needsUpdate = true; inst.frustumCulled = false; scene.add(inst);

  const i = track.startIdx, seg = 14, pos = [], idx = [];
  for (let k = 0; k <= seg; k++) {
    const off = -track.limR[i] + (track.limL[i] + track.limR[i]) * k / seg;
    for (const a of [-0.3, 0.3]) {
      const x = track.px[i] + track.tz[i] * off + track.tx[i] * a, z = track.pz[i] - track.tx[i] * off + track.tz[i] * a;
      pos.push(x, track.heightAt(x, z) + 0.05, z);
    }
    if (k < seg) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 2, k * 2 + 1, k * 2 + 3);
  }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setIndex(idx);
  const line = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: 0xf2f0ea, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  line.frustumCulled = false; scene.add(line);
}

function buildCar(gltf) {
  carRoot = new THREE.Group(); carRoot.rotation.order = 'YXZ';
  carRoot.add(gltf.scene); scene.add(carRoot);
  const by = n => gltf.scene.getObjectByName(n);
  bodyNode = by('BODY');
  const baseL = new THREE.Matrix4().extractRotation(by('RL').matrix), baseR = new THREE.Matrix4().extractRotation(by('RR').matrix);
  wheels = ['FL', 'FR', 'RL', 'RR'].map((n, i) => {
    const node = by(n); node.matrixAutoUpdate = false;
    return { node, c: new THREE.Vector3().setFromMatrixPosition(node.matrix), base: i % 2 ? baseR : baseL };
  });
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const m = o.material;
    if (/glass/i.test(m.name)) {
      // the model's glass uses transmission, which costs a second scene pass; plain blending reads the same here
      m.transmission = 0; m.transparent = true; m.depthWrite = false; m.roughness = 0.08; m.metalness = 0;
      m.opacity = /ligh/i.test(m.name) ? 0.3 : 0.62; m.color.set(0x0c0f12);
    }
  });
  // brake lamps: the rear half of the lamp-lens mesh gets its own material so it can light up,
  // plus a soft glow in front of each lens so it reads from the chase camera in daylight
  let lens = null;
  gltf.scene.traverse(o => { if (o.isMesh && /lighglass/i.test(o.material.name)) lens = o; });
  if (lens && lens.geometry.index) {
    const g = lens.geometry, pos = g.attributes.position, idx = g.index.array, front = [], rear = [];
    for (let t = 0; t < idx.length; t += 3) {
      const z = pos.getZ(idx[t]) + pos.getZ(idx[t + 1]) + pos.getZ(idx[t + 2]);
      (z < 0 ? rear : front).push(idx[t], idx[t + 1], idx[t + 2]);
    }
    const fg = g.clone(); fg.setIndex(front); const rg = g.clone(); rg.setIndex(rear);
    lens.geometry = fg;
    lampMat = lens.material.clone(); lampMat.emissive.set(0xff1806); lampMat.emissiveIntensity = 0; lampMat.color.set(0x2a0503);
    const rm = new THREE.Mesh(rg, lampMat); rm.frustumCulled = false;
    rm.position.copy(lens.position); rm.quaternion.copy(lens.quaternion); rm.scale.copy(lens.scale);
    lens.parent.add(rm);
    const gc = document.createElement('canvas'); gc.width = 128; gc.height = 64;
    const gg = gc.getContext('2d'), rad = gg.createRadialGradient(64, 32, 2, 64, 32, 64);
    rad.addColorStop(0, 'rgba(255,120,90,1)'); rad.addColorStop(0.25, 'rgba(255,30,10,0.75)'); rad.addColorStop(1, 'rgba(255,0,0,0)');
    gg.setTransform(1, 0, 0, 0.5, 0, 16); gg.fillStyle = rad; gg.fillRect(0, -32, 128, 128);
    const gt = new THREE.CanvasTexture(gc); gt.colorSpace = THREE.SRGBColorSpace;
    lampGlow = [0.525, -0.525].map(x => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
      sp.position.set(x, 0.71, -2.06); sp.scale.set(0.78, 0.34, 1); sp.renderOrder = 6; carRoot.add(sp); return sp;
    });
  }
  // soft contact shadow
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 5.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.04; shadow.renderOrder = 1; carRoot.add(shadow);
}

const mT = new THREE.Matrix4(), mR = new THREE.Matrix4(), mS = new THREE.Matrix4();
function poseCar(dt) {
  // ground under each wheel gives the car's height and attitude
  const sp = Math.sin(car.psi), cp = Math.cos(car.psi);
  let h = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const [lx, lz] = car.wheelPos[i];
    const x = car.x + sp * lz + cp * lx, z = car.z + cp * lz - sp * lx;
    h[i] = track.heightAt(x, z);
    wheelWorld[i][0] = x; wheelWorld[i][1] = h[i]; wheelWorld[i][2] = z;
  }
  const y = (h[0] + h[1] + h[2] + h[3]) / 4;
  const pitch = Math.atan2((h[0] + h[1] - h[2] - h[3]) / 2, car.p.a + car.p.b);
  const roll = Math.atan2((h[0] + h[2] - h[1] - h[3]) / 2, (car.p.trackF + car.p.trackR) / 2);
  const k = pose.ready ? 1 - Math.exp(-dt / 0.06) : 1; pose.ready = true;
  pose.y += (y - pose.y) * k; pose.pitch += (pitch - pose.pitch) * k; pose.roll += (roll - pose.roll) * k;
  carRoot.position.set(car.x, pose.y, car.z);
  carRoot.rotation.set(-pose.pitch, car.psi, pose.roll);
  // body leans on its springs
  bodyNode.rotation.set(clamp(-car.axF * 0.0045, -0.05, 0.05), 0, clamp(car.ayF * 0.006, -0.075, 0.075));
  if (lampMat) {
    lampLevel += ((car.brake > 0.04 ? 1 : 0) - lampLevel) * Math.min(1, dt * 30 + (dt === 0 ? 1 : 0));
    lampMat.emissiveIntensity = lampLevel * 5; lampMat.opacity = 0.3 + 0.65 * lampLevel;
    for (const sp of lampGlow) sp.material.opacity = lampLevel * 0.6;
  }
  for (let i = 0; i < 4; i++) {
    const w = wheels[i];
    mT.makeTranslation(w.c.x, w.c.y, w.c.z);
    mR.makeRotationY(i < 2 ? car.steer : 0); mS.makeRotationX(car.spin[i < 2 ? 0 : 1]);
    w.node.matrix.copy(mT).multiply(mR).multiply(mS).multiply(w.base);
    w.node.matrixWorldNeedsUpdate = true;
  }
}

function sampleGround() {
  const sp = Math.sin(car.psi), cp = Math.cos(car.psi);
  let hf = 0, hr = 0, hl = 0, hrt = 0;
  for (let i = 0; i < 4; i++) {
    const [lx, lz] = car.wheelPos[i];
    const x = car.x + sp * lz + cp * lx, z = car.z + cp * lz - sp * lx, h = track.heightAt(x, z);
    car.surface[i] = track.gripAt(x, z);
    if (i < 2) hf += h / 2; else hr += h / 2;
    if (i % 2 === 0) hl += h / 2; else hrt += h / 2;
  }
  car.slopeF = clamp((hf - hr) / (car.p.a + car.p.b), -0.3, 0.3);
  car.slopeL = clamp((hl - hrt) / ((car.p.trackF + car.p.trackR) / 2), -0.3, 0.3);
}

// keep the car between the limits; returns true on a contact hard enough to count
function walls() {
  track.locate(car.x, car.z, hint, loc); hint = loc.i;
  const i = loc.i;
  let pen = 0, nx = 0, nz = 0;
  if (loc.side > loc.limL - WALL_MARGIN) { pen = loc.side - (loc.limL - WALL_MARGIN); nx = track.tz[i]; nz = -track.tx[i]; }
  else if (-loc.side > loc.limR - WALL_MARGIN) { pen = -loc.side - (loc.limR - WALL_MARGIN); nx = -track.tz[i]; nz = track.tx[i]; }
  if (pen <= 0) return false;
  car.x -= nx * pen; car.z -= nz * pen;
  const vn = car.vx * nx + car.vz * nz;
  if (vn <= 0) return false;
  // lose the speed into the barrier, scrub some along it, and kill most of the rotation
  car.vx -= nx * vn * 1.2; car.vz -= nz * vn * 1.2;
  const scrub = 1 - Math.min(0.3, vn * 0.035);
  car.vx *= scrub; car.vz *= scrub; car.r *= 0.55;
  if (vn > 1.5) { wallFlash = Math.min(1, vn / 8); return true; }
  return false;
}

function relPos() {
  const r = track.rel(loc.i) + loc.along / track.step;
  return ((r % track.n) + track.n) % track.n;
}

function toGrid() {
  const g = track.gridPose();
  car.reset(g.x, g.z, g.psi); hint = g.i; camYaw = g.psi; pose.ready = false;
  timing.reset(); acc = 0;
  for (const s of skids) s.has = false;
  track.locate(car.x, car.z, hint, loc);
}

function physics(dt, inp) {
  sampleGround();
  car.step(dt, inp);
  const hit = walls();
  timing.update(dt, relPos(), car, hit);
}

function effects(dt) {
  const kmh = car.speed * 3.6;
  for (let k = 0; k < 2; k++) {
    const i = k + 2, w = wheelWorld[i], s = car.slip[i], on = car.surface[i];
    const slide = clamp((s - 1.3) / 3, 0, 1) * clamp(kmh / 25, 0, 1);
    skids[k].add(w[0], w[1] + 0.03, w[2], slide * 0.55 * on);
    if (slide > 0.12 && Math.random() < slide * dt * 75) {
      smoke.emit(w[0] + (Math.random() - 0.5) * 0.3, w[1] + 0.12, w[2] + (Math.random() - 0.5) * 0.3,
        car.vx * 0.35 + (Math.random() - 0.5) * 1.6, 0.6 + Math.random() * 0.8, car.vz * 0.35 + (Math.random() - 0.5) * 1.6,
        (0.55 + slide * 0.45) * (0.35 + 0.65 * on));
    }
  }
  smoke.update(dt);
}

const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function moveCamera(dt) {
  const sp = Math.sin(car.psi), cp = Math.cos(car.psi);
  if (camMode === 1) {
    camera.position.set(car.x + sp * 0.35, pose.y + 1.08, car.z + cp * 0.35);
    camLook.set(car.x + sp * 20, pose.y + 1.0 + Math.sin(pose.pitch) * 20, car.z + cp * 20);
    camera.up.set(Math.sin(pose.roll) * cp, 1, -Math.sin(pose.roll) * sp);
    camera.lookAt(camLook);
    camera.fov = 72; camera.updateProjectionMatrix();
    return;
  }
  camera.up.set(0, 1, 0);
  // the camera sits between where the car points and where it is going, so the slide angle reads on screen
  const velYaw = car.speed > 3 ? Math.atan2(car.vx, car.vz) : car.psi;
  const lead = car.u > -1 ? wrap(velYaw - car.psi) : 0;
  const target = car.psi + clamp(lead, -1.2, 1.2) * 0.58;
  camYaw += wrap(target - camYaw) * (1 - Math.exp(-dt / 0.11));
  const dist = 5.3 + Math.min(1.4, car.speed * 0.025), sy = Math.sin(camYaw), cy = Math.cos(camYaw);
  camPos.set(car.x - sy * dist, pose.y + 1.75, car.z - cy * dist);
  camPos.y = Math.max(camPos.y, track.heightAt(camPos.x, camPos.z) + 0.7);
  const shake = wallFlash * 0.12;
  camera.position.set(camPos.x + (Math.random() - 0.5) * shake, camPos.y + (Math.random() - 0.5) * shake, camPos.z);
  camLook.set(car.x + sy * 2.2, pose.y + 0.95, car.z + cy * 2.2);
  camera.lookAt(camLook);
  const fov = 58 + Math.min(15, car.speed * 0.3);
  if (Math.abs(fov - camera.fov) > 0.05) { camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt / 0.3)); camera.updateProjectionMatrix(); }
  wallFlash = Math.max(0, wallFlash - dt * 3);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (smoke) smoke.setViewport(h * renderer.getPixelRatio(), camera.fov);
  if (carRoot && state !== 'loading') renderer.render(scene, camera);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000 || 0); last = now;
  if (state !== 'drive') { sound.update(car.rpm, 0, 0, 0, 0, false); return; }
  const inp = input.read();
  acc += dt;
  while (acc >= PHYS_DT) { physics(PHYS_DT, inp); acc -= PHYS_DT; }
  poseCar(dt); effects(dt); moveCamera(dt);
  smoke.setViewport(innerHeight * renderer.getPixelRatio(), camera.fov);
  hud.drive(dt, car, timing, track, inp);
  const rearSlide = clamp((Math.max(car.slip[2], car.slip[3]) - 1.2) / 3, 0, 1), frontSlide = clamp((Math.max(car.slip[0], car.slip[1]) - 1.2) / 2, 0, 1);
  const off = 1 - (car.surface[0] + car.surface[1] + car.surface[2] + car.surface[3]) / 4;
  sound.update(car.rpm, car.throttle, Math.max(rearSlide, frontSlide * 0.7), off, car.speed, true);
  renderer.render(scene, camera);
}

// ---------- screens ----------
function show(next) {
  state = next;
  $('select').hidden = next !== 'select';
  $('result').hidden = next !== 'result';
  $('hud').hidden = $('hudm').hidden = next !== 'drive';
}
function openSelect() { hud.select(track, timing.best, `${track.meta.credit} / ${CAR_CREDIT}`); show('select'); }
function startDrive() { sound.start(); toGrid(); show('drive'); last = performance.now(); }
function openResult() { hud.result(track, timing.last); show('result'); }
function resume() { show('drive'); last = performance.now(); }
function setAssist(i) {
  assistIdx = i; const [label, follow, tc] = ASSISTS[i];
  car.assist = follow; car.tcAid = tc; $('opt-assist').textContent = label;
  localStorage.setItem('slipangle.assist', String(i));
}

input.onAction = a => {
  if (a === 'mute') sound.setMuted(!sound.muted);
  else if (state === 'select' && a === 'confirm') startDrive();
  else if (state === 'drive') {
    if (a === 'reset') toGrid();
    else if (a === 'camera') camMode = (camMode + 1) % 2;
    else if (a === 'pause') openResult();
  } else if (state === 'result') {
    if (a === 'reset') startDrive(); else if (a === 'pause') resume();
  }
};
$('btn-start').addEventListener('click', startDrive);
$('btn-retry').addEventListener('click', startDrive);
$('btn-resume').addEventListener('click', resume);
$('btn-courses').addEventListener('click', openSelect);
$('btn-pause').addEventListener('click', openResult);
$('opt-assist').addEventListener('click', () => setAssist((assistIdx + 1) % ASSISTS.length));
addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'drive') openResult(); });

async function boot() {
  resize();
  setLoad(0.05, 'LOADING TRACK DATA');
  track = await Track.load('assets/ahvenisto');
  timing = new Timing(track);
  timing.onLap = lap => {
    const d = lap.prev ? lap.time - lap.prev.time : null;
    hud.banner(fmtLap(lap.time) + (d == null ? '' : '  ' + fmtDelta(d)), d == null ? 'gain' : d < 0 ? 'gain' : 'loss');
  };
  const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
  let f1 = 0, f2 = 0; const prog = () => setLoad(0.1 + 0.7 * f1 + 0.15 * f2, 'LOADING MODELS');
  const [trackG, carG] = await Promise.all([
    loadGLB(loader, `assets/ahvenisto/${track.meta.model.file}`, f => { f1 = f; prog(); }),
    loadGLB(loader, 'assets/car_supra.glb', f => { f2 = f; prog(); }),
  ]);
  setLoad(0.97, 'PREPARING');
  buildWorld(); placeTrackModel(trackG); buildTrackProps(); buildCar(carG);
  smoke = new Smoke(scene); skids = [new Skid(scene), new Skid(scene)];
  hud.buildMap(track);
  setAssist(assistIdx);
  toGrid(); poseCar(0); moveCamera(0); resize();
  renderer.render(scene, camera);     // compiles shaders and uploads textures before the first drive
  $('loading').hidden = true;
  openSelect();
  requestAnimationFrame(frame);
  window.__game = { car, track, timing, input, get state() { return state; } };
}

boot().catch(e => { console.error(e); $('load-msg').textContent = '読み込みに失敗しました: ' + e.message; });
