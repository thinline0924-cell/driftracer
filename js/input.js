// Keyboard and touch input, merged into one state: steer -1..1 (left +), throttle, brake, handbrake 0..1.

export class Input {
  constructor() {
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };
    this.keys = new Set();
    this.touch = { steer: 0, throttle: 0, brake: 0, handbrake: 0, active: false };
    this.onAction = () => {};
    addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const act = { KeyR: 'reset', KeyC: 'camera', KeyM: 'mute', Escape: 'pause', Enter: 'confirm', ArrowUp: 'up', ArrowDown: 'down' }[e.code];
      if (act) this.onAction(act);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('contextmenu', e => e.preventDefault());
    this._touch();
  }

  _touch() {
    const pad = document.getElementById('pad-steer'), knob = document.getElementById('knob');
    if (!pad) return;
    let id = null, x0 = 0;
    const span = () => pad.clientWidth * 0.36;         // finger travel for full lock
    const set = v => { this.touch.steer = v; knob.style.transform = `translateX(${(-v * span()).toFixed(1)}px)`; };
    pad.addEventListener('pointerdown', e => {
      if (id !== null) return;
      id = e.pointerId; x0 = e.clientX; pad.setPointerCapture(id); this.touch.active = true; e.preventDefault();
    });
    pad.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      let v = (x0 - e.clientX) / span();
      // the origin follows the finger past full lock, so reversing responds at once
      if (v > 1) { x0 = e.clientX + span(); v = 1; } else if (v < -1) { x0 = e.clientX - span(); v = -1; }
      set(v);
    });
    const end = e => { if (e.pointerId === id) { id = null; set(0); } };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);

    const hold = (elId, key) => {
      const el = document.getElementById(elId);
      const on = e => { this.touch[key] = 1; this.touch.active = true; el.classList.add('down'); el.setPointerCapture(e.pointerId); e.preventDefault(); };
      const off = () => { this.touch[key] = 0; el.classList.remove('down'); };
      el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off);
    };
    hold('pad-gas', 'throttle'); hold('pad-brk', 'brake'); hold('pad-hb', 'handbrake');
  }

  read() {
    const k = c => this.keys.has(c), s = this.state, t = this.touch;
    const kSteer = (k('ArrowLeft') || k('KeyA') ? 1 : 0) - (k('ArrowRight') || k('KeyD') ? 1 : 0);
    // a light curve on the slider gives finer control around centre
    const tSteer = Math.sign(t.steer) * Math.pow(Math.abs(t.steer), 1.4);
    s.steer = kSteer !== 0 ? kSteer : tSteer;
    s.throttle = Math.max(k('ArrowUp') || k('KeyW') ? 1 : 0, t.throttle);
    s.brake = Math.max(k('ArrowDown') || k('KeyS') ? 1 : 0, t.brake);
    s.handbrake = Math.max(k('Space') ? 1 : 0, t.handbrake);
    return s;
  }
}
