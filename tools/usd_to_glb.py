"""Convert a USD/USDZ scene to a GLB: world transforms baked in, one primitive per material.

usage: python usd_to_glb.py <scene.usdc> <out.glb> [--skip name1,name2] [--info]
Needs usd-core, numpy and pillow. Texture paths are resolved next to the scene file.
Only what a game track needs is carried over: positions, normals, one UV set, base colour
(texture or constant), cut-out alpha and double-sidedness.
"""
import sys, os, json, struct, io
import numpy as np
from pxr import Usd, UsdGeom, UsdShade, Gf
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
skip = set()
if '--skip' in sys.argv: skip = set(sys.argv[sys.argv.index('--skip') + 1].split(','))
base = os.path.dirname(os.path.abspath(src))
stage = Usd.Stage.Open(src)
xcache = UsdGeom.XformCache()


def shader_inputs(mat):
    """base colour factor, texture path, uv scale, whether alpha comes from the texture"""
    info = {'color': [0.6, 0.6, 0.6, 1.0], 'tex': None, 'scale': (1.0, 1.0), 'alpha': False, 'rough': 0.9, 'metal': 0.0}
    if not mat: return info
    surf = mat.ComputeSurfaceSource()[0]
    if not surf: return info
    def follow(inp):
        if inp and inp.HasConnectedSource():
            s = inp.GetConnectedSource()
            return UsdShade.Shader(s[0].GetPrim()), s[1]
        return None, None
    d = surf.GetInput('diffuseColor')
    sh, _ = follow(d)
    if sh:
        f = sh.GetInput('file')
        if f and f.Get(): info['tex'] = f.Get().path
        st, _ = follow(sh.GetInput('st'))
        if st and st.GetIdAttr().Get() == 'UsdTransform2d':
            sc = st.GetInput('scale').Get()
            if sc: info['scale'] = (float(sc[0]), float(sc[1]))
        info['color'] = [1, 1, 1, 1]
    elif d and d.Get() is not None:
        c = d.Get(); info['color'] = [float(c[0]), float(c[1]), float(c[2]), 1.0]
    o = surf.GetInput('opacity')
    osh, oname = follow(o)
    if osh: info['alpha'] = True
    elif o and o.Get() is not None and o.Get() < 0.999: info['color'][3] = float(o.Get())
    for key, name in (('rough', 'roughness'), ('metal', 'metallic')):
        i = surf.GetInput(name)
        if i and not i.HasConnectedSource() and i.Get() is not None: info[key] = float(i.Get())
    return info


groups = {}   # material name -> dict(pos, nrm, uv lists, info)
for prim in stage.Traverse():
    if not prim.IsA(UsdGeom.Mesh): continue
    mesh = UsdGeom.Mesh(prim)
    if UsdGeom.Imageable(prim).ComputeVisibility() == 'invisible': continue
    mat = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
    name = mat.GetPath().name if mat else 'default'
    if name in skip: continue
    pts = mesh.GetPointsAttr().Get(); counts = mesh.GetFaceVertexCountsAttr().Get(); idx = mesh.GetFaceVertexIndicesAttr().Get()
    if not pts or not counts: continue
    pts = np.asarray(pts, dtype=np.float64); counts = np.asarray(counts); idx = np.asarray(idx)
    M = np.array(xcache.GetLocalToWorldTransform(prim))          # row-vector convention
    world = pts @ M[:3, :3] + M[3, :3]
    flip = np.linalg.det(M[:3, :3]) < 0
    if mesh.GetOrientationAttr().Get() == 'leftHanded': flip = not flip

    # corner (face-vertex) indices of the fan triangulation
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    tri = []
    for s, c in zip(starts, counts):
        for k in range(1, c - 1): tri.append((s, s + k, s + k + 1))
    if not tri: continue
    tri = np.asarray(tri)
    if flip: tri = tri[:, ::-1]
    corner = tri.reshape(-1)
    P = world[idx[corner]]

    def primvar(names):
        api = UsdGeom.PrimvarsAPI(prim)
        for n in names:
            pv = api.GetPrimvar(n)
            if pv and pv.HasValue():
                vals = pv.ComputeFlattened()
                if vals is None: continue
                vals = np.asarray(vals, dtype=np.float64); interp = pv.GetInterpolation()
                if interp == 'faceVarying' and len(vals) == len(idx): return vals[corner]
                if interp in ('vertex', 'varying') and len(vals) == len(pts): return vals[idx[corner]]
        return None

    uv = primvar(['st', 'st0', 'UVMap', 'uv'])
    nrm = primvar(['normals'])
    if nrm is None:
        n = mesh.GetNormalsAttr().Get()
        if n is not None:
            n = np.asarray(n, dtype=np.float64); interp = mesh.GetNormalsInterpolation()
            if interp == 'faceVarying' and len(n) == len(idx): nrm = n[corner]
            elif interp in ('vertex', 'varying') and len(n) == len(pts): nrm = n[idx[corner]]
    if nrm is not None:
        nrm = nrm @ np.linalg.inv(M[:3, :3]).T
    else:
        a, b, c = P[0::3], P[1::3], P[2::3]
        fn = np.cross(b - a, c - a); nrm = np.repeat(fn, 3, axis=0)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True); ln[ln == 0] = 1; nrm = nrm / ln
    g = groups.setdefault(name, {'pos': [], 'nrm': [], 'uv': [], 'info': shader_inputs(mat), 'double': False})
    if uv is None: uv = np.zeros((len(P), 2))
    sx, sy = g['info']['scale']
    uv = np.stack([uv[:, 0] * sx, 1.0 - uv[:, 1] * sy], axis=1)
    g['pos'].append(P); g['nrm'].append(nrm); g['uv'].append(uv)
    if mesh.GetDoubleSidedAttr().Get(): g['double'] = True

if '--info' in sys.argv:
    for n, g in sorted(groups.items(), key=lambda kv: -sum(len(p) for p in kv[1]['pos'])):
        print(f"{n:40s} tris {sum(len(p) for p in g['pos']) // 3:7d} tex {g['info']['tex']} alpha {g['info']['alpha']} color {[round(c, 2) for c in g['info']['color']]}")

# ---- write GLB ----
binary = bytearray()
gltf = {'asset': {'version': '2.0', 'generator': 'usd_to_glb.py'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': 'track'}],
        'meshes': [{'primitives': []}], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [{}], 'textures': [], 'images': [], 'samplers': [{'wrapS': 10497, 'wrapT': 10497}]}
images = {}

def view(data, target=None):
    while len(binary) % 4: binary.append(0)
    off = len(binary); binary.extend(data)
    v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
    if target: v['target'] = target
    gltf['bufferViews'].append(v); return len(gltf['bufferViews']) - 1

def accessor(arr, typ):
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    a = {'bufferView': view(arr.tobytes(), 34962), 'componentType': 5126, 'count': len(arr), 'type': typ}
    if typ == 'VEC3': a['min'] = arr.min(axis=0).tolist(); a['max'] = arr.max(axis=0).tolist()
    gltf['accessors'].append(a); return len(gltf['accessors']) - 1

def texture(path):
    if path in images: return images[path], images[path + '#alpha']
    full = os.path.join(base, path)
    im = Image.open(full); has_alpha = im.mode in ('RGBA', 'LA') and im.getchannel('A').getextrema()[0] < 250
    buf = io.BytesIO()
    if has_alpha: im.convert('RGBA').save(buf, 'PNG'); mime = 'image/png'
    else: im.convert('RGB').save(buf, 'JPEG', quality=88); mime = 'image/jpeg'
    gltf['images'].append({'bufferView': view(buf.getvalue()), 'mimeType': mime, 'name': os.path.basename(path)})
    gltf['textures'].append({'source': len(gltf['images']) - 1, 'sampler': 0})
    images[path] = len(gltf['textures']) - 1; images[path + '#alpha'] = has_alpha
    return images[path], has_alpha

for name, g in groups.items():
    info = g['info']
    m = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': info['color'], 'metallicFactor': info['metal'], 'roughnessFactor': max(0.35, info['rough'])}}
    if info['tex'] and os.path.exists(os.path.join(base, info['tex'])):
        t, has_alpha = texture(info['tex'])
        m['pbrMetallicRoughness']['baseColorTexture'] = {'index': t}
        if has_alpha: m['alphaMode'] = 'MASK'; m['alphaCutoff'] = 0.4; m['doubleSided'] = True
    if info['color'][3] < 0.999: m['alphaMode'] = 'BLEND'
    if g['double']: m['doubleSided'] = True
    gltf['materials'].append(m)
    gltf['meshes'][0]['primitives'].append({'attributes': {'POSITION': accessor(np.concatenate(g['pos']), 'VEC3'), 'NORMAL': accessor(np.concatenate(g['nrm']), 'VEC3'),
                                                           'TEXCOORD_0': accessor(np.concatenate(g['uv']), 'VEC2')}, 'material': len(gltf['materials']) - 1})
for k in ('textures', 'images'):
    if not gltf[k]: del gltf[k]
while len(binary) % 4: binary.append(0)
gltf['buffers'][0]['byteLength'] = len(binary)
js = json.dumps(gltf).encode()
while len(js) % 4: js += b' '
with open(out, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binary), 0x004E4942)); f.write(binary)
print('wrote', out, 'materials', len(gltf['materials']), 'triangles', sum(sum(len(p) for p in g['pos']) for g in groups.values()) // 3)
