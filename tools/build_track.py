"""Build the physics data of a modelled track (height map, surface map, centre line with limits).

usage: python build_track.py <track.glb from usd_to_glb.py> <config.json> <out dir> [overlay.json]

The config names which materials are ground, which of those are paved, and gives a rough
list of waypoints for the lap. The centre line is then snapped to the middle of the paved
surface, and the left/right limits are measured out to the first barrier (or a margin of
grass). Everything written is in game metres: (raw - center) * scale.
Needs numpy.
"""
import sys, json, struct, math, os
import numpy as np

glb_path, cfg_path, out_dir = sys.argv[1:4]
cfg = json.load(open(cfg_path))
SC = cfg['scale']; CX, CZ = cfg['center']; X0, Z0, X1, Z1 = cfg['bounds']; CELL = cfg['cell']
W = round((X1 - X0) / CELL); H = round((Z1 - Z0) / CELL)


def read_glb(path):
    data = open(path, 'rb').read()
    jl = struct.unpack_from('<I', data, 12)[0]
    js = json.loads(data[20:20 + jl]); bin0 = 20 + jl + 8
    out = {}
    for prim in js['meshes'][0]['primitives']:
        acc = js['accessors'][prim['attributes']['POSITION']]; bv = js['bufferViews'][acc['bufferView']]
        arr = np.frombuffer(data, dtype='<f4', count=acc['count'] * 3, offset=bin0 + bv['byteOffset']).reshape(-1, 3).astype(np.float64)
        out[js['materials'][prim['material']]['name']] = arr
    return out


def to_game(p):
    return np.stack([(p[:, 0] - CX) * SC, p[:, 1] * SC, (p[:, 2] - CZ) * SC], axis=1)


def raster(tris, grid, mode='max'):
    """tris: (n,3,3) game coords. Writes interpolated height (max) into grid; returns coverage mask."""
    cover = np.zeros(grid.shape, dtype=bool)
    gx = (tris[:, :, 0] - X0) / CELL; gz = (tris[:, :, 2] - Z0) / CELL; gy = tris[:, :, 1]
    for t in range(len(tris)):
        ax, bx, cx = gx[t]; az, bz, cz = gz[t]
        i0 = max(0, int(math.floor(min(ax, bx, cx)))); i1 = min(W - 1, int(math.ceil(max(ax, bx, cx))))
        j0 = max(0, int(math.floor(min(az, bz, cz)))); j1 = min(H - 1, int(math.ceil(max(az, bz, cz))))
        if i1 < i0 or j1 < j0: continue
        det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        if abs(det) < 1e-12: continue
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        l1 = ((bz - cz) * (ii - cx) + (cx - bx) * (jj - cz)) / det
        l2 = ((cz - az) * (ii - cx) + (ax - cx) * (jj - cz)) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        if not inside.any(): continue
        y = l1 * gy[t, 0] + l2 * gy[t, 1] + l3 * gy[t, 2]
        sub = grid[j0:j1 + 1, i0:i1 + 1]
        np.maximum(sub, np.where(inside, y, -1e9), out=sub)
        cover[j0:j1 + 1, i0:i1 + 1] |= inside
    return cover


mats = read_glb(glb_path)
ground = np.full((H, W), -1e9)
paved = np.zeros((H, W), dtype=bool)
grip = np.zeros((H, W), dtype=np.float32)
for name in cfg['ground']:
    if name not in mats: print('missing ground material', name); continue
    tris = to_game(mats[name]).reshape(-1, 3, 3)
    # only near-horizontal faces are ground (kerb sides and wall faces are not)
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]); ln = np.linalg.norm(n, axis=1); ln[ln == 0] = 1
    tris = tris[np.abs(n[:, 1]) / ln > 0.5]
    cov = raster(tris, ground)
    g = cfg['paved'].get(name)
    if g: paved |= cov; grip = np.where(cov, np.maximum(grip, g), grip)
valid = ground > -1e8
lo, hi = ground[valid].min(), ground[valid].max()
print('ground height range', round(lo, 2), round(hi, 2), 'paved cells', int(paved.sum()), 'coverage', round(valid.mean(), 3))

# obstacles: anything that is not ground and rises out of it near car height
obst = np.zeros((H, W), dtype=bool)
skip = set(cfg['ground']) | set(cfg.get('ignore', []))
for name, p in mats.items():
    if name in skip: continue
    tris = to_game(p).reshape(-1, 3, 3)
    # sample each triangle densely enough for the cell size
    edge = np.maximum.reduce([np.linalg.norm(tris[:, 0] - tris[:, 1], axis=1), np.linalg.norm(tris[:, 1] - tris[:, 2], axis=1), np.linalg.norm(tris[:, 2] - tris[:, 0], axis=1)])
    k = np.clip(np.ceil(edge / (CELL * 0.7)).astype(int), 1, 60)
    for kk in np.unique(k):
        sel = tris[k == kk]
        u, v = np.meshgrid(np.arange(kk + 1) / kk, np.arange(kk + 1) / kk); keep = u + v <= 1.0001
        u = u[keep]; v = v[keep]; w = 1 - u - v
        pts = sel[:, None, 0] * w[None, :, None] + sel[:, None, 1] * u[None, :, None] + sel[:, None, 2] * v[None, :, None]
        pts = pts.reshape(-1, 3)
        i = np.floor((pts[:, 0] - X0) / CELL).astype(int); j = np.floor((pts[:, 2] - Z0) / CELL).astype(int)
        ok = (i >= 0) & (i < W) & (j >= 0) & (j < H)
        i, j, y = i[ok], j[ok], pts[ok, 1]
        g = ground[j, i]
        hit = (g > -1e8) & (y > g + 0.2) & (y < g + 1.6)
        obst[j[hit], i[hit]] = True
print('obstacle cells', int(obst.sum()))

# ---- centre line ----
def catmull(points, per=24):
    n = len(points); out = []
    for i in range(n):
        p0, p1, p2, p3 = (np.array(points[(i + k) % n], dtype=float) for k in (-1, 0, 1, 2))
        d = lambda a, b: max(1e-3, math.sqrt(np.linalg.norm(b - a)))
        t0 = 0; t1 = t0 + d(p0, p1); t2 = t1 + d(p1, p2); t3 = t2 + d(p2, p3)
        for k in range(per):
            t = t1 + (t2 - t1) * k / per
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)

def resample(pts, step):
    nxt = np.roll(pts, -1, axis=0); seg = np.linalg.norm(nxt - pts, axis=1); acc = np.concatenate([[0], np.cumsum(seg)])
    n = int(round(acc[-1] / step)); s = np.arange(n) * acc[-1] / n
    j = np.searchsorted(acc, s, side='right') - 1; f = (s - acc[j]) / seg[j]
    return pts[j] + (nxt[j] - pts[j]) * f[:, None]

def tangents(pts):
    t = np.roll(pts, -1, axis=0) - np.roll(pts, 1, axis=0); return t / np.linalg.norm(t, axis=1, keepdims=True)

def cell(x, z):
    i = int((x - X0) / CELL); j = int((z - Z0) / CELL)
    return (i, j) if 0 <= i < W and 0 <= j < H else None

def walk(x, z, nx, nz, limit, stop_at_obstacle=True):
    """distance from (x,z) along (nx,nz) to the edge of the paved surface, and to the first obstacle"""
    edge = None; d = 0.0
    while d < limit:
        d += CELL * 0.5
        c = cell(x + nx * d, z + nz * d)
        if c is None: return (edge if edge is not None else d), d, 'out'
        if obst[c[1], c[0]]: return (edge if edge is not None else d), d, 'obstacle'
        if not paved[c[1], c[0]]:
            if edge is None: edge = d
        elif edge is not None and d - edge < 1.0:
            edge = None            # a seam or a painted gap, not the real edge
    return (edge if edge is not None else limit), limit, 'far'

way = [((p[0] - CX) * SC, (p[1] - CZ) * SC) for p in cfg['waypoints']]
line = resample(catmull(way), 1.0)
for it in range(4):
    t = tangents(line); new = line.copy()
    for i in range(len(line)):
        lx, lz = t[i, 1], -t[i, 0]                       # left of travel
        el, _, _ = walk(line[i, 0], line[i, 1], lx, lz, 16)
        er, _, _ = walk(line[i, 0], line[i, 1], -lx, -lz, 16)
        if el < 15.5 and er < 15.5:
            s = (el - er) / 2; new[i] = line[i] + np.array([lx, lz]) * np.clip(s, -3, 3)
    # smooth around the loop
    k = np.exp(-0.5 * (np.arange(-12, 13) / 4.0) ** 2); k /= k.sum()
    sm = np.zeros_like(new)
    for o, wgt in zip(range(-12, 13), k): sm += np.roll(new, o, axis=0) * wgt
    line = resample(sm, 1.0)

t = tangents(line); n = len(line)
half = []
raw = []
for i in range(n):
    lx, lz = t[i, 1], -t[i, 0]
    res = []
    for sgn in (1, -1):
        edge, dist, why = walk(line[i, 0], line[i, 1], sgn * lx, sgn * lz, 30)
        res.append((edge, dist, why))
    raw.append(res); half.append(min(res[0][0], res[1][0]))
typ = float(np.median(half)); cap = typ * cfg.get('capFactor', 1.35)
print('lap length', round(n, 1), 'typical half width', round(typ, 2), 'cap', round(cap, 2))
margin = cfg.get('grassMargin', 4.0)
L = np.zeros(n); R = np.zeros(n); F = np.zeros(n, dtype=int)
for i in range(n):
    for side, (edge, dist, why) in enumerate(raw[i]):
        flag = 0
        if edge > cap:                       # still paved far out: a junction, close it with blocks
            lim = cap; flag = 1
            if why == 'obstacle' and dist < cap: lim = dist - 0.3; flag = 0
        else:
            lim = edge + margin
            if why == 'obstacle' and dist < lim: lim = dist - 0.3
        lim = max(2.2, lim)
        if side == 0: L[i] = lim; F[i] |= flag * 1
        else: R[i] = lim; F[i] |= flag * 2
# limits may only change gradually along the lap: take a running minimum then smooth
def tidy(a):
    m = np.min(np.stack([np.roll(a, o) for o in range(-2, 3)]), axis=0)
    return np.mean(np.stack([np.roll(m, o) for o in range(-2, 3)]), axis=0)
L = tidy(L); R = tidy(R)

step = cfg.get('lineStep', 3)
rows = [[round(float(line[i, 0]), 2), round(float(line[i, 1]), 2), round(float(L[i]), 2), round(float(R[i]), 2), int(F[i])] for i in range(0, n, step)]

def nearest_xy(p):
    return [round((p[0] - CX) * SC, 2), round((p[1] - CZ) * SC, 2)]

# ---- write ----
os.makedirs(out_dir, exist_ok=True)
# fill holes in the ground with the lowest height so sampling never falls off a cliff, then blur lightly
filled = np.where(valid, ground, lo)
q = np.where(valid, 1 + np.round((filled - lo) / max(1e-6, hi - lo) * 65534), 1).astype('<u2')
q.tofile(os.path.join(out_dir, 'height.bin'))
surf = np.round(grip * 255).astype(np.uint8)
# soften the paved edge by one cell
pad = np.pad(surf.astype(np.float32), 1, mode='edge')
soft = sum(pad[1 + dj:1 + dj + H, 1 + di:1 + di + W] for dj in (-1, 0, 1) for di in (-1, 0, 1)) / 9
np.round(soft).astype(np.uint8).tofile(os.path.join(out_dir, 'surface.bin'))
meta = dict(cfg['meta'])
meta['model'] = {'file': 'track.glb', 'scale': SC, 'center': [CX, CZ], 'bounds': [X0, Z0, X1, Z1], 'cell': CELL, 'heightLo': round(float(lo), 3), 'heightHi': round(float(hi), 3)}
meta['line'] = rows
meta['start'] = nearest_xy(cfg['start']); meta['sectors'] = [nearest_xy(p) for p in cfg['sectors']]
meta['grid'] = cfg.get('grid', 18)
json.dump(meta, open(os.path.join(out_dir, 'track.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('wrote', out_dir, 'line points', len(rows), 'flagged', int((F > 0).sum()))

if len(sys.argv) > 4:   # overlay in raw model units for checking against a top-down render
    back = lambda x, z: [x / SC + CX, z / SC + CZ]
    c = [back(*line[i]) for i in range(0, n, 2)]
    l = [back(line[i, 0] + t[i, 1] * L[i], line[i, 1] - t[i, 0] * L[i]) for i in range(0, n, 2)]
    r = [back(line[i, 0] - t[i, 1] * R[i], line[i, 1] + t[i, 0] * R[i]) for i in range(0, n, 2)]
    json.dump({'lines': [['c', 0xffff00, c, True], ['l', 0xff0000, l, True], ['r', 0x00ffff, r, True]]}, open(sys.argv[4], 'w'))
