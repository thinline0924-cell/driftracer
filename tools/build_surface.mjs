// Builds the surface map (asphalt vs. loose ground) from a top-down colour render of the track.
// usage: node build_surface.mjs <topdown.png> <outW> <outH> <out.bin> [preview.png]
// Run from a folder where sharp is installed.
import fs from 'node:fs';
import sharp from 'sharp';
const [src, w, h, out, preview] = process.argv.slice(2);
const W = +w, H = +h;
const { data } = await sharp(src).resize(W, H, { kernel: 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const raw = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) {
  const r = data[k * 3], g = data[k * 3 + 1], b = data[k * 3 + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx ? (mx - mn) / mx : 0;
  // asphalt: grey (cool or neutral), not very bright; warm tones are grass, gravel, sand
  const warm = r - b;
  raw[k] = (mx > 28 && mx < 215 && sat < 0.2 && warm < 10) ? 255 : 0;
}
// majority filter (radius 2) to drop speckle and painted lines, then box blur for soft edges
const maj = new Uint8Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  let s = 0, c = 0;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= W || y >= H) continue; s += raw[y * W + x]; c++;
  }
  maj[j * W + i] = s / c > 110 ? 255 : 0;
}
const outb = new Uint8Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  let s = 0, c = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= W || y >= H) continue; s += maj[y * W + x]; c++;
  }
  outb[j * W + i] = Math.round(s / c);
}
fs.writeFileSync(out, Buffer.from(outb.buffer));
if (preview) await sharp(Buffer.from(outb.buffer), { raw: { width: W, height: H, channels: 1 } }).png().toFile(preview);
