// Builds the physics heightmap for a scanned track from its source GLB.
// usage: node build_heightmap.mjs <source.glb> <track.json> <out.bin>
// Run from a folder where @gltf-transform/core is installed.
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [src, metaPath, out] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const { scale: SC, center: [CX, CZ], bounds: [X0, Z0, X1, Z1], cell: CELL } = meta.model;
const W = Math.round((X1 - X0) / CELL), H = Math.round((Z1 - Z0) / CELL);
const hm = new Float32Array(W * H).fill(-1e9);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices().getArray();
    const n = pos.length / 3;
    const wx = new Float32Array(n), wy = new Float32Array(n), wz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      wx[i] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) - CX) * SC;
      wy[i] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * SC;
      wz[i] = ((m[2] * x + m[6] * y + m[10] * z + m[14]) - CZ) * SC;
    }
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = (wx[a] - X0) / CELL, az = (wz[a] - Z0) / CELL;
      const bx = (wx[b] - X0) / CELL, bz = (wz[b] - Z0) / CELL;
      const cx = (wx[c] - X0) / CELL, cz = (wz[c] - Z0) / CELL;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const j0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), j1 = Math.min(H - 1, Math.ceil(Math.max(az, bz, cz)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const l1 = ((bz - cz) * (i - cx) + (cx - bx) * (j - cz)) / det;
        const l2 = ((cz - az) * (i - cx) + (ax - cx) * (j - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
        const y = l1 * wy[a] + l2 * wy[b] + l3 * wy[c];
        const k = j * W + i;
        if (y > hm[k]) hm[k] = y;
      }
    }
  }
}
// valid mask, then two passes of 3x3 blur over valid cells to remove scan noise
let lo = 1e9, hi = -1e9, valid = 0;
for (const v of hm) if (v > -1e8) { valid++; if (v < lo) lo = v; if (v > hi) hi = v; }
let cur = hm;
for (let pass = 0; pass < 2; pass++) {
  const nx = new Float32Array(cur);
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const k = j * W + i; if (cur[k] < -1e8) continue;
    let s = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v = cur[k + dj * W + di]; if (v > -1e8) { s += v; c++; } }
    nx[k] = s / c;
  }
  cur = nx;
}
// Uint16: 0 = no data, 1..65535 = lo..hi
const q = new Uint16Array(W * H);
for (let k = 0; k < q.length; k++) q[k] = cur[k] < -1e8 ? 0 : 1 + Math.round((cur[k] - lo) / (hi - lo) * 65534);
fs.writeFileSync(out, Buffer.from(q.buffer));
console.log(JSON.stringify({ w: W, h: H, lo: +lo.toFixed(3), hi: +hi.toFixed(3), coverage: +(valid / (W * H)).toFixed(3) }));
