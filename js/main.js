import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Track } from './track.js';
import { Car, SUPRA, RX7, P996, VANQUISH } from './car.js';
import { Input } from './input.js';
import { Timing, fmtLap, fmtDelta } from './timing.js';
import { Hud } from './hud.js';
import { Smoke, Skid } from './fx.js';
import { Sound } from './audio.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const COURSES = ['assets/ahvenisto', 'assets/lider', 'assets/driftpark'];
// lamp: brake-lamp position in metres (left, up, forward); lens / cutout: material name patterns
const CARS = [
  { id: 'supra', name: 'GR SUPRA DRIFT', layout: 'FR', spec: SUPRA, file: 'assets/car_supra.glb', engine: 'assets/engine/supra',
    scale: 1, yaw: 0, lift: 0, wheels: ['FL', 'FR', 'RL', 'RR'], body: 'BODY', lens: /lighglass/i, lamp: [0.525, 0.71, -2.06], lean: 0.32,
    credit: '"2019 Toyota GR Supra Drift by HKS" by SIU Car Garage, CC BY-NC 4.0 / Engine: "6 cyl vintage racecar" by ears68 (Freesound 185151)' },
  { id: 'rx7', name: 'RX-7 GT300', layout: 'FR', spec: RX7, file: 'assets/car_rx7.glb', engine: 'assets/engine/rx7',
    scale: 0.2675, yaw: Math.PI / 2, lift: 0.022, wheels: ['rx7_fl_1', 'rx7_fr_2', 'rx7_rl_4', 'rx7_rr_3'], body: 'rx7_body_0', cutout: /^Rim/, caliper: /^Brembo/, lampTexture: true, lamp: [0.5, 0.74, -2.12], lean: 0.22,
    credit: '"2006 Mazda RX-7 GT300 RE Amemiya" by Dave Bored SketchFab, CC BY 4.0 / Engine: "rotary engine" by fuser10 (Freesound 100791)' },
  { id: 'p996', name: '911 CARRERA', layout: 'RR', spec: P996, file: 'assets/car_p996.glb', engine: 'assets/engine/p996',
    scale: 1, yaw: 0, lift: 0.003, wheels: ['FL', 'FR', 'RL', 'RR'], body: 'BODY', lampTexture: true, lamp: [0.6, 0.85, -2.18], lean: 0.35,
    credit: '"2000 Porsche 911 Carrera (996)" by Ddiaz Design, CC BY-NC-SA 4.0 / Engine: "porsche" by mmplisskin (Freesound 90404)' },
  { id: 'vanquish', name: 'VANQUISH', layout: 'FR', spec: VANQUISH, file: 'assets/car_vanquish.glb', engine: 'assets/engine/vanquish',
    scale: 1, yaw: 0, lift: 0.133, wheels: ['FL', 'FR', 'RL', 'RR'], body: 'BODY', lens: /^red_glass/, caliper: /^Calipers/, lamp: [0.56, 0.86, -2.32], glowSize: [0.46, 0.22], lean: 0.35,
    credit: '"2012 Aston Martin Vanquish Coupe" by Ddiaz Design, CC BY-NC-SA 4.0 / Engine: "Aston Martin V8 Vantage start up" by lmartins (Freesound 547057)' },
];
const ASSISTS = [['弱', 0.92, 1], ['強', 1.0, 1], ['オフ', 0, 0]];   // label, countersteer follow, wheelspin aid
const PHYS_DT = 1 / 120;
const WALL_MARGIN = 0.95;   // half the car's width: the limits are measured to the barrier face

const coarse = matchMedia('(pointer: coarse)').matches;
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' });
// drawing resolution: capped below the screen's own on high-density displays, and lowered further
// at run time whenever the frame rate cannot be held (see quality())
const PR_MAX = Math.min(devicePixelRatio, coarse ? 1.25 : 1.5), PR_MIN = coarse ? 0.55 : 0.7;
let pixelRatio = PR_MAX;
try { const q = +localStorage.getItem('slipangle.pr'); if (q >= PR_MIN && q <= PR_MAX) pixelRatio = q; } catch { /* storage unavailable */ }
renderer.setPixelRatio(pixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 4000);

const input = new Input(), hud = new Hud(), sound = new Sound(), car = new Car();
let tracks = [], timings = [], sel = 0, loaded = -1, courseGroup = null, plain = null, busy = false;
let track, timing, smoke, skids, carRoot, vis = null, carIdx = 0, lampLevel = 0;
let state = 'loading', camMode = 0, camYaw = 0, hint = -1, acc = 0, last = 0, wallFlash = 0;
let assistIdx = +(localStorage.getItem('slipangle.assist') || 0) % ASSISTS.length;
const loc = {}, pose = { y: 0, pitch: 0, roll: 0, ready: false }, spinShown = [0, 0];
const prev = { x: 0, z: 0, psi: 0 };
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
  plain = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshBasicMaterial({ color: 0x5c5a45 }));
  plain.rotation.x = -Math.PI / 2; scene.add(plain);

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
    // surfaces modelled exactly level with the road (open ground) are pushed back so they do not flicker through it
    if (track.meta.sink && track.meta.sink.includes(o.material.name)) { o.material.polygonOffset = true; o.material.polygonOffsetFactor = 2; o.material.polygonOffsetUnits = 4; }
  });
  root.updateMatrixWorld(true);
  courseGroup.add(root);
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
  inst.instanceMatrix.needsUpdate = true; inst.frustumCulled = false; if (spots.length) courseGroup.add(inst);

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
  line.frustumCulled = false; courseGroup.add(line);
}

// Red, rear-facing faces of a body whose lamps are painted into its texture. Returns a geometry
// (in the body's space) made of copies of those faces, and the centre of each side's lamps.
function lampFaces(body) {
  body.updateMatrixWorld(true);
  const all = new THREE.Box3().setFromObject(body), rearLimit = all.min.z + (all.max.z - all.min.z) * 0.1;
  const pixels = new Map(), pos = [], spots = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  body.traverse(o => {
    if (!o.isMesh || !o.material.map || !o.material.map.image) return;
    const img = o.material.map.image;
    if (!pixels.has(img)) {
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      pixels.set(img, { d: g.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height });
    }
    const px = pixels.get(img), g = o.geometry, P = g.attributes.position, UV = g.attributes.uv;
    if (!UV) return;
    const count = g.index ? g.index.count : P.count, at = k => (g.index ? g.index.getX(k) : k);
    for (let t = 0; t < count; t += 3) {
      const i0 = at(t), i1 = at(t + 1), i2 = at(t + 2);
      a.fromBufferAttribute(P, i0).applyMatrix4(o.matrixWorld); b.fromBufferAttribute(P, i1).applyMatrix4(o.matrixWorld); c.fromBufferAttribute(P, i2).applyMatrix4(o.matrixWorld);
      if ((a.z + b.z + c.z) / 3 > rearLimit) continue;
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      if (Math.abs(n.z) < 0.3) continue;
      const u = (UV.getX(i0) + UV.getX(i1) + UV.getX(i2)) / 3, v = (UV.getY(i0) + UV.getY(i1) + UV.getY(i2)) / 3;
      const x = Math.min(px.w - 1, Math.floor((((u % 1) + 1) % 1) * px.w)), y = Math.min(px.h - 1, Math.floor((((v % 1) + 1) % 1) * px.h));
      const k = (y * px.w + x) * 4, r = px.d[k], gg = px.d[k + 1], bl = px.d[k + 2];
      if (r < 35 || gg > r * 0.5 || bl > r * 0.25) continue;      // red only: the amber indicators stay dark
      for (const p of [a, b, c]) { p.applyMatrix4(inv); pos.push(p.x, p.y, p.z); }
      const sp = spots[(a.x + b.x + c.x) > 0 ? 0 : 1];
      sp[0] += (a.x + b.x + c.x) / 3; sp[1] += (a.y + b.y + c.y) / 3; sp[2] += (a.z + b.z + c.z) / 3; sp[3]++;
    }
  });
  if (pos.length < 9 * 4) return null;
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return { geometry, spots: spots.filter(s => s[3]).map(s => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]) };
}

// one visual per car: the model wrapped so that it faces +Z at real size, with a pivot at each
// wheel centre (steer + spin) and one under the body (lean on the springs)
function buildCar(cfg, gltf) {
  const root = new THREE.Group();
  const holder = new THREE.Group(); holder.add(gltf.scene);
  holder.scale.setScalar(cfg.scale); holder.rotation.y = cfg.yaw; holder.position.y = cfg.lift;
  root.add(holder); root.updateMatrixWorld(true);
  const by = n => gltf.scene.getObjectByName(n);
  const box = new THREE.Box3();
  const wheels = cfg.wheels.map(n => {
    const node = by(n);
    // the tyre is the largest mesh of the wheel and its thinnest dimension is the axle. The wheel must
    // spin about that axle: the front wheels carry camber, and spinning them about the car's own
    // sideways axis makes them wobble
    let tyre = null, best = -1;
    node.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const d = o.geometry.boundingBox.getSize(new THREE.Vector3()).length() * o.matrixWorld.getMaxScaleOnAxis();
      if (d > best) { best = d; tyre = o; }
    });
    const bb = tyre.geometry.boundingBox, size = bb.getSize(new THREE.Vector3());
    const centre = bb.getCenter(new THREE.Vector3()).applyMatrix4(tyre.matrixWorld);
    const axle = size.x <= size.y && size.x <= size.z ? new THREE.Vector3(1, 0, 0) : size.y <= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    axle.transformDirection(tyre.matrixWorld);
    if (axle.x < 0) axle.negate();
    const steer = new THREE.Group(); steer.position.copy(centre); root.add(steer);
    const spin = new THREE.Group(); steer.add(spin); spin.attach(node);
    const still = [];
    if (cfg.caliper) node.traverse(o => { if (o.isMesh && cfg.caliper.test(o.material.name)) still.push(o); });
    for (const o of still) steer.attach(o);
    return { steer, spin, axle };
  });
  const body = new THREE.Group(); root.add(body); body.attach(by(cfg.body));
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const m = o.material;
    if (/glass/i.test(m.name) && !(cfg.lens && cfg.lens.test(m.name)) && !/red|orange|amber/i.test(m.name)) {
      // the model's glass uses transmission, which costs a second scene pass; plain blending reads the same here
      m.transmission = 0; m.transparent = true; m.depthWrite = false; m.roughness = 0.08; m.metalness = 0;
      m.opacity = /ligh/i.test(m.name) ? 0.3 : 0.62; m.color.set(0x0c0f12);
    } else if (cfg.cutout && cfg.cutout.test(m.name)) {
      // spoked rims drawn with an alpha texture: cut out instead of blended, so they sort correctly
      m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true;
    }
  });
  // brake lamps: where the model has a lamp-lens mesh, its rear half gets its own material so it can
  // light up; every car also gets a soft glow at each lamp so it reads from the chase camera in daylight
  let lampMat = null, lens = null;
  if (cfg.lens) body.traverse(o => { if (o.isMesh && cfg.lens.test(o.material.name)) lens = o; });
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
  }
  // models without a lens mesh: find the red, rear-facing faces of the body texture (the lamp lenses)
  // and lay a copy of them over the body that lights up
  let lampOverlay = null, lampSpots = null;
  if (cfg.lampTexture) {
    const found = lampFaces(body);
    if (found) {
      lampOverlay = new THREE.MeshBasicMaterial({ color: 0xff2410, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
      const m = new THREE.Mesh(found.geometry, lampOverlay); m.frustumCulled = false; m.renderOrder = 5; body.add(m);
      lampSpots = found.spots;
    }
  }
  const gc = document.createElement('canvas'); gc.width = 128; gc.height = 64;
  const gg = gc.getContext('2d'), rad = gg.createRadialGradient(64, 32, 2, 64, 32, 64);
  rad.addColorStop(0, 'rgba(255,120,90,1)'); rad.addColorStop(0.25, 'rgba(255,30,10,0.75)'); rad.addColorStop(1, 'rgba(255,0,0,0)');
  gg.setTransform(1, 0, 0, 0.5, 0, 16); gg.fillStyle = rad; gg.fillRect(0, -32, 128, 128);
  const gt = new THREE.CanvasTexture(gc); gt.colorSpace = THREE.SRGBColorSpace;
  const [gx, gy, gz] = cfg.lamp;
  const spots = lampSpots || [[gx, gy, gz], [-gx, gy, gz]];
  const glow = spots.map(([x, y, z]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
    sp.position.set(x, y, z - 0.04);
    if (cfg.glowSize) sp.scale.set(cfg.glowSize[0], cfg.glowSize[1], 1); else if (lampSpots) sp.scale.set(0.42, 0.24, 1); else sp.scale.set(0.78, 0.34, 1);
    sp.renderOrder = 6; body.add(sp); return sp;
  });
  // soft contact shadow
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const size = box.setFromObject(holder).getSize(new THREE.Vector3());
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(size.x + 0.85, size.z + 1.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.04; shadow.renderOrder = 1; root.add(shadow);
  root.visible = false; carRoot.add(root);
  return { root, wheels, body, lampMat, lampOverlay, glow, lean: cfg.lean };
}

// switch to a car: physics, visual, engine sound, records and the HUD's rev counter
async function setCar(i) {
  if (busy) return;
  busy = true;
  carIdx = (i + CARS.length) % CARS.length; const cfg = CARS[carIdx];
  try {
    if (!cfg.vis) {
      $('loading').hidden = false; setLoad(0.1, 'LOADING ' + cfg.name);
      cfg.vis = buildCar(cfg, await loadGLB(gltfLoader, cfg.file, f => setLoad(0.1 + 0.85 * f)));
      $('loading').hidden = true;
    }
    for (const c of CARS) if (c.vis) c.vis.root.visible = c === cfg;
    vis = cfg.vis;
    if (carRoot.parent === studio) toStudio();
    hud.setPlate(carIdx, CARS.length, cfg);
    car.setSpec(cfg.spec); sound.setEngine(cfg.engine); hud.setCar(cfg.name, cfg.spec);
    localStorage.setItem('slipangle.car', cfg.id);
    if (tracks.length) {
      timings = tracks.map(t => {
        const tm = new Timing(t, cfg.id);
        tm.onLap = lap => {
          const d = lap.prev ? lap.time - lap.prev.time : null;
          hud.banner(fmtLap(lap.time) + (d == null ? '' : '  ' + fmtDelta(d)), d == null ? 'gain' : d < 0 ? 'gain' : 'loss');
        };
        return tm;
      });
      timing = timings[sel];
      if (state === 'select') pick(sel);
    }
  } catch (e) { console.error(e); $('load-msg').textContent = '読み込みに失敗しました: ' + e.message; }
  busy = false;
}

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
  // height follows the ground closely; attitude is smoothed more so scan noise in the ground does not rock the car
  const k = pose.ready ? 1 - Math.exp(-dt / 0.05) : 1, ka = pose.ready ? 1 - Math.exp(-dt / 0.14) : 1; pose.ready = true;
  pose.y += (y - pose.y) * k; pose.pitch += (pitch - pose.pitch) * ka; pose.roll += (roll - pose.roll) * ka;
  carRoot.position.set(car.x, pose.y, car.z);
  carRoot.rotation.set(-pose.pitch, car.psi, pose.roll);
  // body leans on its springs
  const lean = vis.lean;
  vis.body.rotation.set(clamp(-car.axF * 0.0045 * lean, -0.05 * lean, 0.05 * lean), 0, clamp(car.ayF * 0.006 * lean, -0.075 * lean, 0.075 * lean));
  lampLevel += ((car.brake > 0.04 ? 1 : 0) - lampLevel) * Math.min(1, dt * 30 + (dt === 0 ? 1 : 0));
  if (vis.lampMat) { vis.lampMat.emissiveIntensity = lampLevel * 5; vis.lampMat.opacity = 0.3 + 0.65 * lampLevel; }
  if (vis.lampOverlay) vis.lampOverlay.opacity = lampLevel * 0.95;
  for (const sp of vis.glow) sp.material.opacity = lampLevel * (vis.lampMat ? 0.6 : vis.lampOverlay ? 0.32 : 0.95);
  // the shown spin follows wheel speed frame by frame (smooth whatever the physics step count), and is
  // capped per frame so fast spokes roll forward instead of strobing
  if (dt > 0) {
    const rate = [car.u / car.p.wheelRadius, car.omega];
    for (let k = 0; k < 2; k++) spinShown[k] += clamp(rate[k] * dt, -0.42, 0.42);
  }
  for (let i = 0; i < 4; i++) {
    const w = vis.wheels[i];
    w.steer.rotation.y = i < 2 ? car.steer : 0;
    w.spin.quaternion.setFromAxisAngle(w.axle, spinShown[i < 2 ? 0 : 1]);
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
  if (vn > 1.5) { wallFlash = Math.max(wallFlash, Math.min(1, vn / 8)); return true; }
  return false;
}

function relPos() {
  const r = track.rel(loc.i) + loc.along / track.step;
  return ((r % track.n) + track.n) % track.n;
}

function toGrid() {
  const g = track.gridPose();
  car.reset(g.x, g.z, g.psi); hint = g.i; camYaw = g.psi; pose.ready = false; cam.ready = false;
  prev.x = car.x; prev.z = car.z; prev.psi = car.psi;
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
const cam = { ready: false, dist: 5.3, h: 0, lx: 0, ly: 0, lz: 0 };
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
  // the camera sits between where the car points and where it is going, so the slide angle reads on
  // screen. It follows on soft springs: it swings round after the car, drops back a little under
  // acceleration and closes in under braking, and rises and falls more slowly than the car
  const velYaw = car.speed > 3 ? Math.atan2(car.vx, car.vz) : car.psi;
  const lead = car.u > -1 ? wrap(velYaw - car.psi) : 0;
  const target = car.psi + clamp(lead, -1.2, 1.2) * 0.58;
  const ease = tau => (cam.ready ? 1 - Math.exp(-dt / tau) : 1);
  camYaw += wrap(target - camYaw) * ease(0.24);
  const distWant = 5.3 + Math.min(1.4, car.speed * 0.025) + clamp(car.axF * 0.07, -0.55, 0.7);
  cam.dist += (distWant - cam.dist) * ease(0.35);
  cam.h += (pose.y + 1.75 - cam.h) * ease(0.16);
  const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
  camPos.set(car.x - sy * cam.dist, cam.h, car.z - cy * cam.dist);
  camPos.y = Math.max(camPos.y, track.heightAt(camPos.x, camPos.z) + 0.7);
  const shake = wallFlash * 0.12;
  camera.position.set(camPos.x + (Math.random() - 0.5) * shake, camPos.y + (Math.random() - 0.5) * shake, camPos.z);
  // the point looked at trails the car slightly too, so quick flicks do not snap the view
  const lx = car.x + sy * 2.2, ly = pose.y + 0.95, lz = car.z + cy * 2.2;
  const kl = ease(0.07);
  cam.lx += (lx - cam.lx) * kl; cam.ly += (ly - cam.ly) * kl; cam.lz += (lz - cam.lz) * kl;
  cam.ready = true;
  camLook.set(cam.lx, cam.ly, cam.lz);
  camera.lookAt(camLook);
  const fov = 58 + Math.min(15, car.speed * 0.3);
  if (Math.abs(fov - camera.fov) > 0.05) { camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt / 0.3)); camera.updateProjectionMatrix(); }
  wallFlash = clamp(wallFlash - dt * 3, 0, 1);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (smoke) smoke.setViewport(h * renderer.getPixelRatio(), camera.fov);
  if (carRoot && state === 'select') showroom(0);
  else if (carRoot && state !== 'loading') renderer.render(scene, camera);
}

// adaptive resolution: frame times are averaged over a second; a slow second lowers the drawing
// resolution one step, and a run of fast seconds raises it again (never above PR_MAX)
const qual = { t: 0, n: 0, sum: 0, fast: 0, hold: 0 };
function quality(interval) {
  if (interval <= 0 || interval > 1000) return;              // tab switches and loading stalls say nothing
  qual.sum += interval; qual.n++; qual.t += interval;
  if (qual.t < 1000) return;
  const avg = qual.sum / qual.n; qual.t = qual.sum = qual.n = 0;
  if (qual.hold > 0) { qual.hold--; return; }
  let next = pixelRatio;
  if (avg > 19.5) { next = Math.max(PR_MIN, pixelRatio * (avg > 30 ? 0.8 : 0.88)); qual.fast = 0; qual.hold = 1; }
  else if (avg < 17.6 && pixelRatio < PR_MAX && ++qual.fast >= 4) { next = Math.min(PR_MAX, pixelRatio * 1.1); qual.fast = 0; qual.hold = 2; }
  if (Math.abs(next - pixelRatio) > 0.01) {
    pixelRatio = next; renderer.setPixelRatio(pixelRatio); resize();
    try { localStorage.setItem('slipangle.pr', pixelRatio.toFixed(2)); } catch { /* storage unavailable */ }
  }
}

function frame() {
  requestAnimationFrame(frame);
  // one clock for everything: the frame callback's own timestamp can be older than a time taken
  // just before, and a negative step made the camera smoothing run backwards and shake the view
  const now = performance.now(), dt = clamp((now - last) / 1000, 0, 0.1);
  if (state === 'drive' || state === 'select') quality(now - last);
  last = now;
  if (state === 'select') { sound.update(car.rpm, 0, 0, 0, 0, false); showroom(dt); return; }
  if (state !== 'drive') { sound.update(car.rpm, 0, 0, 0, 0, false); return; }
  const inp = input.read();
  acc += dt;
  while (acc >= PHYS_DT) { prev.x = car.x; prev.z = car.z; prev.psi = car.psi; physics(PHYS_DT, inp); acc -= PHYS_DT; }
  // draw the car between the last two physics steps, so motion is even at any display rate
  const px = car.x, pz = car.z, pp = car.psi, f = acc / PHYS_DT;
  car.x = prev.x + (px - prev.x) * f; car.z = prev.z + (pz - prev.z) * f; car.psi = prev.psi + wrap(pp - prev.psi) * f;
  poseCar(dt); effects(dt); moveCamera(dt);
  car.x = px; car.z = pz; car.psi = pp;
  smoke.setViewport(innerHeight * renderer.getPixelRatio(), camera.fov);
  hud.drive(dt, car, timing, track, inp);
  const rearSlide = clamp((Math.max(car.slip[2], car.slip[3]) - 1.2) / 3, 0, 1), frontSlide = clamp((Math.max(car.slip[0], car.slip[1]) - 1.2) / 2, 0, 1);
  const off = 1 - (car.surface[0] + car.surface[1] + car.surface[2] + car.surface[3]) / 4;
  sound.update(car.rpm, car.throttle, Math.max(rearSlide, frontSlide * 0.7), off, car.speed, true, car.shiftT > 0, car.rpm > car.p.redline - 90 && car.throttle > 0.5);
  renderer.render(scene, camera);
}

// ---------- showroom: the chosen car on a turntable behind the select screen ----------
const studio = new THREE.Scene(), studioCam = new THREE.PerspectiveCamera(30, 1, 0.5, 200);
let turn = 0.6, turnVel = 0, dragX = null, entering = false;
function buildStudio() {
  studio.background = new THREE.Color(0x0a0b0c);
  studio.environment = scene.environment; studio.environmentIntensity = 0.55;
  studio.add(new THREE.HemisphereLight(0xdfe6ee, 0x0a0b0c, 0.5));
  const key = new THREE.SpotLight(0xffffff, 120, 30, 0.55, 0.65, 1.6); key.position.set(2.5, 8.5, 4.5); studio.add(key); studio.add(key.target);
  const rim = new THREE.DirectionalLight(0xc9d6e6, 1.4); rim.position.set(-4, 3, -6); studio.add(rim);
  const fill = new THREE.DirectionalLight(0xffe8d6, 0.5); fill.position.set(5, 1.5, 2); studio.add(fill);
  // floor: unlit, so its rim is exactly the page colour and has no visible edge. The pool of light
  // under the car and the turntable's edge are painted into it, which keeps the ring smooth
  const R = 18, c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d'), px = 512 / R;
  const gr = g.createRadialGradient(512, 512, 0, 512, 512, 512);
  gr.addColorStop(0, 'rgb(31,33,36)'); gr.addColorStop(3.4 / R, 'rgb(24,26,29)'); gr.addColorStop(6 / R, 'rgb(14,15,17)'); gr.addColorStop(1, 'rgb(10,11,12)');
  g.fillStyle = gr; g.fillRect(0, 0, 1024, 1024);
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(512, 512, 3.25 * px, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(150,154,160,0.42)'; g.lineWidth = 2; g.beginPath(); g.arc(512, 512, 3.25 * px, 0, Math.PI * 2); g.stroke();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 128), new THREE.MeshBasicMaterial({ map: tex }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.005; studio.add(floor);
  const stage = $('stage');
  stage.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; dragX = e.clientX; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', e => { if (dragX === null) return; const d = (e.clientX - dragX) * 0.008; dragX = e.clientX; turn += d; turnVel = d * 30; });
  const up = () => { dragX = null; };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
}

// the car (its visual group) moves between the showroom and the course
function toStudio() {
  studio.add(carRoot);
  carRoot.position.set(0, 0, 0); carRoot.rotation.set(0, turn, 0);
  vis.body.rotation.set(0, 0, 0);
  for (const w of vis.wheels) w.steer.rotation.y = 0;
  lampLevel = 0;
  if (vis.lampMat) { vis.lampMat.emissiveIntensity = 0; vis.lampMat.opacity = 0.3; }
  if (vis.lampOverlay) vis.lampOverlay.opacity = 0;
  for (const sp of vis.glow) sp.material.opacity = 0;
}
function toCourse() { scene.add(carRoot); }

function showroom(dt) {
  if (!entering && carRoot.parent !== studio) toStudio();
  // slow turn, carried on by a flick and settling back to the idle speed
  turnVel += (0.22 - turnVel) * Math.min(1, dt * 1.5);
  if (dragX === null) turn += turnVel * dt;
  carRoot.rotation.set(0, turn, 0);
  // frame the car in the stage area: the projection centre is moved onto the stage, and the
  // distance is set so the car fills most of its width
  const W = innerWidth, H = innerHeight, r = $('stage').getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.46;
  studioCam.aspect = W / H;
  const hf = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(studioCam.fov) / 2) * studioCam.aspect);
  const span = Math.max(0.2, Math.min(r.width * 0.86, r.height * 1.9) / W);
  const dist = 5.0 / (2 * Math.tan(hf / 2) * span);
  studioCam.position.set(0, dist * 0.27, dist);
  studioCam.lookAt(0, 0.55, 0);
  studioCam.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
  studioCam.updateProjectionMatrix();
  renderer.render(studio, studioCam);
}

// ---------- screens ----------
function show(next) {
  state = next;
  $('select').hidden = next !== 'select';
  $('result').hidden = next !== 'result';
  $('hud').hidden = $('hudm').hidden = next !== 'drive';
}
function pick(i) {
  sel = (i + tracks.length) % tracks.length; localStorage.setItem('slipangle.course', String(sel)); track = tracks[sel]; timing = timings[sel];
  hud.buildMap(track);
  hud.select(tracks, sel, timing.best, `${track.meta.credit} / ${CARS[carIdx].credit}`, pick);
}
function openSelect() { pick(sel); show('select'); }

// the selected course's model is fetched the first time it is driven; the previous one is released
async function loadCourse() {
  if (loaded === sel) return;
  $('loading').hidden = false; setLoad(0.05, 'LOADING ' + track.meta.name);
  const gltf = await loadGLB(gltfLoader, `${track.dir}/${track.meta.model.file}`, f => setLoad(0.05 + 0.9 * f));
  if (courseGroup) {
    scene.remove(courseGroup);
    courseGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
    });
  }
  courseGroup = new THREE.Group(); scene.add(courseGroup);
  placeTrackModel(gltf); buildTrackProps();
  plain.position.y = track.hLo - 3;
  for (const s of skids) s.clear();
  loaded = sel;
  toGrid(); poseCar(0); moveCamera(0);
  renderer.render(scene, camera);     // compiles shaders and uploads textures before driving starts
  $('loading').hidden = true;
}
async function startDrive() {
  if (busy) return;
  busy = true; sound.start();
  // the showroom must not reclaim the car while the course loads: it keeps drawing during the wait
  entering = true;
  try { await loadCourse(); toCourse(); toGrid(); show('drive'); last = performance.now(); }
  catch (e) { console.error(e); $('load-msg').textContent = '読み込みに失敗しました: ' + e.message; }
  finally { entering = false; }
  busy = false;
}
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
  else if (state === 'select' && (a === 'up' || a === 'down')) pick(sel + (a === 'up' ? -1 : 1));
  else if (state === 'select' && (a === 'left' || a === 'right')) setCar(carIdx + (a === 'left' ? -1 : 1));
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
$('opt-car').addEventListener('click', () => setCar(carIdx + 1));
$('car-prev').addEventListener('click', () => setCar(carIdx - 1));
$('car-next').addEventListener('click', () => setCar(carIdx + 1));
addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'drive') openResult(); });

const gltfLoader = new GLTFLoader(); gltfLoader.setMeshoptDecoder(MeshoptDecoder);

async function boot() {
  resize();
  setLoad(0.05, 'LOADING');
  buildWorld();
  carRoot = new THREE.Group(); carRoot.rotation.order = 'YXZ'; scene.add(carRoot);
  buildStudio();
  smoke = new Smoke(scene); skids = [new Skid(scene), new Skid(scene)];
  tracks = await Promise.all(COURSES.map(d => Track.load(d)));
  sel = Math.min(tracks.length - 1, +(localStorage.getItem('slipangle.course') || 0));
  track = tracks[sel];
  await setCar(Math.max(0, CARS.findIndex(c => c.id === localStorage.getItem('slipangle.car'))));
  setAssist(assistIdx);
  $('loading').hidden = true;
  openSelect();
  requestAnimationFrame(frame);
  window.__game = { car, input, sound, camera, renderer, scene, hud, get carRoot() { return carRoot; }, get wallFlash() { return wallFlash; }, get vis() { return vis; }, get track() { return track; }, get timing() { return timing; }, get state() { return state; }, pick, setCar };
}

boot().catch(e => { console.error(e); $('load-msg').textContent = '読み込みに失敗しました: ' + e.message; });
