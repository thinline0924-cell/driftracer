// Prepare a car model whose wheels are baked into shared meshes: find the four wheels from a
// named tyre material, cut every part that sits inside a wheel out into its own group, and write
// a model in the game's convention (metres, +Y up, +Z forward) with groups BODY, FL, FR, RL, RR.
//
// usage: node prep_car.mjs <in.glb> <out.glb> <config.json>
//   config: { "scale": 0.01, "tyre": "tire" }   scale = model units per metre; tyre = the tyre material's name
// Run from a folder where @gltf-transform/core and /extensions are installed.
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [src, out, cfgPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const root = doc.getRoot(), scene = root.listScenes()[0];

const leaves = [];
const walk = n => { if (n.getMesh()) leaves.push(n); n.listChildren().forEach(walk); };
scene.listChildren().forEach(walk);

// world positions and connected parts of every primitive
const prims = [];
let gmn = [1e9, 1e9, 1e9], gmx = [-1e9, -1e9, -1e9];
for (const node of leaves) {
  const m = node.getWorldMatrix();
  for (const p of node.getMesh().listPrimitives()) {
    const a = p.getAttribute('POSITION').getArray(), n = a.length / 3, w = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      w[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; w[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; w[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      for (let k = 0; k < 3; k++) { gmn[k] = Math.min(gmn[k], w[i * 3 + k]); gmx[k] = Math.max(gmx[k], w[i * 3 + k]); }
    }
    let idx = p.getIndices() ? Array.from(p.getIndices().getArray()) : Array.from({ length: n }, (_, i) => i);
    const par = new Int32Array(n).map((_, i) => i);
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const join = (x, y) => { x = find(x); y = find(y); if (x !== y) par[x] = y; };
    const seen = new Map();
    for (let i = 0; i < n; i++) { const k = w[i * 3].toFixed(7) + ',' + w[i * 3 + 1].toFixed(7) + ',' + w[i * 3 + 2].toFixed(7); if (seen.has(k)) join(i, seen.get(k)); else seen.set(k, i); }
    for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
    const comps = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i); let c = comps.get(r);
      if (!c) { c = { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9], target: 'BODY' }; comps.set(r, c); }
      for (let k = 0; k < 3; k++) { c.mn[k] = Math.min(c.mn[k], w[i * 3 + k]); c.mx[k] = Math.max(c.mx[k], w[i * 3 + k]); }
    }
    prims.push({ node, p, idx, find, comps, mat: p.getMaterial() ? p.getMaterial().getName() : '' });
  }
}
const H = gmx[1] - gmn[1];

// wheels: the tallest tyre-material part in each corner
const wheels = {};
for (const { comps, mat } of prims) {
  if (mat !== cfg.tyre) continue;
  for (const c of comps.values()) {
    if (c.mn[1] > gmn[1] + 0.2 * H) continue;
    // a tyre is round seen from the side and sits out at the car's flank
    const h0 = c.mx[1] - c.mn[1], l0 = c.mx[2] - c.mn[2];
    if (Math.abs(l0 - h0) > 0.2 * h0 || Math.abs(c.mn[0] + c.mx[0]) / 2 < 0.25 * (gmx[0] - gmn[0])) continue;
    const name = ((c.mn[2] + c.mx[2]) > 0 ? 'F' : 'R') + ((c.mn[0] + c.mx[0]) > 0 ? 'L' : 'R');
    const h = c.mx[1] - c.mn[1];
    if (!wheels[name] || h > wheels[name].h) wheels[name] = { h, c };
  }
}
for (const k of ['FL', 'FR', 'RL', 'RR']) if (!wheels[k]) throw new Error('no tyre found at ' + k);
for (const w of Object.values(wheels)) {
  const c = w.c; w.cx = (c.mn[0] + c.mx[0]) / 2; w.cy = (c.mn[1] + c.mx[1]) / 2; w.cz = (c.mn[2] + c.mx[2]) / 2;
  w.r = w.h / 2; w.hw = (c.mx[0] - c.mn[0]) / 2;
}
// every part lying inside a wheel's cylinder (with room inboard for discs and calipers) joins that wheel
for (const { comps } of prims) for (const c of comps.values()) {
  for (const [name, w] of Object.entries(wheels)) {
    const r = w.r * 1.06, inboard = Math.sign(w.cx) * -1;
    const xlo = Math.min(w.cx - w.hw, w.cx - w.hw + inboard * w.r * 0.55), xhi = Math.max(w.cx + w.hw, w.cx + w.hw + inboard * w.r * 0.55);
    if (c.mn[1] >= w.cy - r && c.mx[1] <= w.cy + r && c.mn[2] >= w.cz - r && c.mx[2] <= w.cz + r && c.mn[0] >= xlo - w.r * 0.04 && c.mx[0] <= xhi + w.r * 0.04) { c.target = name; break; }
  }
}

// rebuild: one node per (original node, group), positions baked through the original world matrix
const car = doc.createNode('car').setScale([1 / cfg.scale, 1 / cfg.scale, 1 / cfg.scale]);
const groups = {};
for (const g of ['BODY', 'FL', 'FR', 'RL', 'RR']) { groups[g] = doc.createNode(g); car.addChild(groups[g]); }
const buffer = root.listBuffers()[0];
const counts = { BODY: 0, FL: 0, FR: 0, RL: 0, RR: 0 };
const made = new Map();
for (const { node, p, idx, find, comps } of prims) {
  const lists = {};
  for (let t = 0; t < idx.length; t += 3) { const g = comps.get(find(idx[t])).target; (lists[g] ||= []).push(idx[t], idx[t + 1], idx[t + 2]); }
  for (const [g, list] of Object.entries(lists)) {
    // each part gets only its own vertices, so its bounds are its own
    const q = p.clone(), remap = new Map(), used = [];
    const ind = new Uint32Array(list.length);
    for (let k = 0; k < list.length; k++) { let r = remap.get(list[k]); if (r === undefined) { r = used.length; remap.set(list[k], r); used.push(list[k]); } ind[k] = r; }
    for (const sem of q.listSemantics()) {
      const acc = q.getAttribute(sem), arr = acc.getArray(), size = acc.getElementSize();
      const sub = new arr.constructor(used.length * size);
      for (let k = 0; k < used.length; k++) for (let e = 0; e < size; e++) sub[k * size + e] = arr[used[k] * size + e];
      q.setAttribute(sem, doc.createAccessor().setType(acc.getType()).setArray(sub).setNormalized(acc.getNormalized()).setBuffer(buffer));
    }
    q.setIndices(doc.createAccessor().setType('SCALAR').setArray(ind).setBuffer(buffer));
    const key = node.getName() + '|' + g;
    if (!made.has(key)) {
      const nn = doc.createNode(node.getName() + '_' + g).setMatrix(node.getWorldMatrix()).setMesh(doc.createMesh(node.getName() + '_' + g));
      groups[g].addChild(nn); made.set(key, nn);
    }
    made.get(key).getMesh().addPrimitive(q);
    counts[g] += list.length / 3;
  }
}
for (const n of scene.listChildren()) scene.removeChild(n);
scene.addChild(car);
for (const n of leaves) { const m = n.getMesh(); n.setMesh(null); if (m && !m.listParents().some(x => x.propertyType === 'Node')) m.dispose(); }
await io.write(out, doc);
const s = 1 / cfg.scale;
console.log('triangles per group', JSON.stringify(counts));
for (const [k, w] of Object.entries(wheels)) console.log(k, 'centre', [w.cx * s, w.cy * s, w.cz * s].map(v => v.toFixed(3)).join(','), 'radius', (w.r * s).toFixed(3));
console.log('ground', (gmn[1] * s).toFixed(3), 'length', ((gmx[2] - gmn[2]) * s).toFixed(3), 'width', ((gmx[0] - gmn[0]) * s).toFixed(3), 'height', (H * s).toFixed(3));
