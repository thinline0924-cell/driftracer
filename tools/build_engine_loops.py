"""Cut constant-pitch engine loops out of a field recording.

usage: python build_engine_loops.py <config.json> <recording.wav> <out dir>
The config names stretches of the recording where the engine is clearly audible. For each one
the engine's pitch is tracked, the stretch is resampled so that pitch becomes constant, the
level is evened out, and the ends are cross-faded into a seamless loop. The config's "play"
block (how the loops map onto rpm) is copied into loops.json for the game.

Entries under "derive" build a loop at a higher firing rate from an existing one, for recordings
that never rev up: one engine cycle at a time is cut from the source loop and laid down again at
the new spacing (pitch-synchronous overlap-add), so the rate rises while the tone of the exhaust
stays that of the recording, instead of everything being sped up.
Needs numpy and scipy.
"""
import sys, os, json, numpy as np
from scipy.io import wavfile
from scipy import signal

cfg = json.load(open(sys.argv[1])); src, out = sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
OUT_SR = 32000
# name, start s, end s, pitch search range Hz, pitch the loop is flattened to Hz
LOOPS = [(l['name'], l['from'], l['to'], l['search'][0], l['search'][1], l['hz']) for l in cfg['loops']]
sr, x = wavfile.read(src)
x = x.astype(np.float64)
if x.ndim > 1: x = x.mean(axis=1)
x /= np.abs(x).max()
hp = signal.butter(2, 35, btype='high', fs=sr, output='sos')
bp = signal.butter(4, [40, 1200], btype='band', fs=sr, output='sos')
meta = []
made = {}
for name, t0, t1, flo, fhi, ft in LOOPS:
    pad = min(0.15, t0)
    a = int((t0 - pad) * sr); b = int((t1 + pad) * sr)
    seg = signal.sosfiltfilt(hp, x[a:b]); y = signal.sosfiltfilt(bp, seg)
    # firing frequency every 10 ms by autocorrelation
    hop = int(sr * 0.01); win = int(sr * 0.1); f0 = []; ts = []
    for i in range(0, len(y) - win, hop):
        w = y[i:i + win] * np.hanning(win)
        ac = np.correlate(w, w, mode='full')[win - 1:]; ac /= ac[0] + 1e-12
        lo, hi = int(sr / fhi), int(sr / flo); k = lo + int(np.argmax(ac[lo:hi]))
        # parabolic refinement of the peak
        if 0 < k < len(ac) - 1:
            d = (ac[k - 1] - ac[k + 1]) / (2 * (ac[k - 1] - 2 * ac[k] + ac[k + 1]) + 1e-12); k = k + np.clip(d, -1, 1)
        f0.append(sr / k); ts.append(i + win / 2)
    f0 = signal.medfilt(np.array(f0), 9)
    f0 = np.convolve(np.pad(f0, 6, mode='edge'), np.ones(13) / 13, mode='valid')
    fcurve = np.interp(np.arange(len(seg)), ts, f0)
    # read the input at speed ft / f0 so that the pitch comes out constant
    speed = ft / fcurve
    pos = [float(pad * sr)]; end = len(seg) - pad * sr
    while pos[-1] < end: pos.append(pos[-1] + speed[min(len(speed) - 1, int(pos[-1]))])
    pos = np.array(pos[:-1])
    flat = np.interp(pos, np.arange(len(seg)), seg)
    # even out the level (the car moves relative to the microphone)
    env = np.sqrt(signal.sosfiltfilt(signal.butter(2, 6, fs=sr, output='sos'), flat ** 2).clip(1e-8))
    flat = flat / env
    # loop length: a whole number of engine cycles (6 firings), ends cross-faded
    cyc = 6 * sr / ft; fade = int(sr * 0.07)
    n = int(np.floor((len(flat) - fade) / cyc) * cyc)
    loop = flat[:n].copy(); tail = flat[n:n + fade]
    w = np.linspace(0, 1, fade)
    loop[:fade] = loop[:fade] * np.sin(w * np.pi / 2) + tail * np.cos(w * np.pi / 2)
    # resample three copies end to end and keep the middle one, so the filter sees the loop as continuous
    r = signal.resample_poly(np.tile(loop, 3), OUT_SR, sr); m = len(r) // 3; loop = r[m:2 * m]
    loop = loop / (np.sqrt((loop ** 2).mean()) * 4.5)            # same loudness for every loop, with headroom
    loop = np.tanh(loop / 0.7) * 0.7                             # soft limit: a stray pop would repeat every loop
    wavfile.write(os.path.join(out, f'{name}.wav'), OUT_SR, (loop * 32767).astype(np.int16))
    meta.append({'name': name, 'file': f'{name}.wav', 'hz': ft})
    made[name] = (loop, ft)
    print(f'{name:8s} source {t0:.2f}-{t1:.2f}s  f0 {f0.min():.0f}-{f0.max():.0f} Hz -> {ft} Hz  loop {len(loop) / OUT_SR:.2f}s  peak {np.abs(loop).max():.2f}')


def psola(src, hz_src, hz_out, seconds=1.0):
    """Overlap-add one-cycle grains of a constant-pitch loop at a new cycle spacing; the result loops."""
    Ls = len(src); Ts = OUT_SR / hz_src
    # where in each cycle the firing pulse sits: fold the loop over one cycle and take the loudest point
    ph = np.arange(Ls) % Ts
    bins = np.zeros(int(np.ceil(Ts))); np.add.at(bins, ph.astype(int), np.abs(src))
    bins = np.convolve(np.pad(bins, 3, mode='wrap'), np.ones(7) / 7, mode='valid')
    phi = float(np.argmax(bins))
    m = max(1, int(round(seconds * hz_out))); Lo = int(round(m * OUT_SR / hz_out)); Tn = Lo / m
    half = int(np.ceil(Ts)); offs = np.arange(-half, half + 1); win = 0.5 + 0.5 * np.cos(np.pi * offs / half)
    out = np.zeros(Lo); grid = np.arange(Ls + 1)
    for j in range(m):
        to = j * Tn; ts = to * Ls / Lo
        k = round((ts - phi) / Ts); cs = (phi + k * Ts) % Ls
        g = np.interp((cs + offs) % Ls, grid, np.append(src, src[0])) * win
        np.add.at(out, (int(round(to)) + offs) % Lo, g)
    return out, OUT_SR * m / Lo

for d in cfg.get('derive', []):
    base, hz0 = made[d['from']]
    loop, hz = psola(base, hz0, d['hz'])
    loop = signal.sosfiltfilt(signal.butter(2, 30, btype='high', fs=OUT_SR, output='sos'), np.tile(loop, 3))[len(loop):2 * len(loop)]
    loop = loop / (np.sqrt((loop ** 2).mean()) * 4.5); loop = np.tanh(loop / 0.7) * 0.7
    wavfile.write(os.path.join(out, f"{d['name']}.wav"), OUT_SR, (loop * 32767).astype(np.int16))
    meta.append({'name': d['name'], 'file': f"{d['name']}.wav", 'hz': round(hz, 3)})
    print(f"{d['name']:8s} derived from {d['from']} at {hz:.1f} Hz  loop {len(loop) / OUT_SR:.2f}s")

json.dump(dict(cfg['play'], loops=meta), open(os.path.join(out, 'loops.json'), 'w'))
