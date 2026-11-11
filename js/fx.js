// Tyre smoke (point sprites) and skid marks (ground ribbons).
import * as THREE from 'three';

const MAX_SMOKE = 260;

export class Smoke {
  constructor(scene) {
    this.pos = new Float32Array(MAX_SMOKE * 3);
    this.aux = new Float32Array(MAX_SMOKE * 2);        // size (m), alpha
    this.vel = new Float32Array(MAX_SMOKE * 3);
    this.life = new Float32Array(MAX_SMOKE);            // remaining, seconds
    this.span = new Float32Array(MAX_SMOKE);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aux', new THREE.BufferAttribute(this.aux, 2).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: 600 }, tint: { value: new THREE.Color(0xd9d6cf) } },
      vertexShader: `attribute vec2 aux; varying float vA; uniform float scale;
        void main(){ vA = aux.y; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aux.x * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; uniform vec3 tint;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c) * 4.0; if (d > 1.0) discard;
          float a = (1.0 - d); gl_FragColor = vec4(tint, a * a * vA); }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false; this.points.renderOrder = 5;
    scene.add(this.points);
  }

  setViewport(h, fovDeg) { this.points.material.uniforms.scale.value = h / (2 * Math.tan(fovDeg * Math.PI / 360)); }

  emit(x, y, z, vx, vy, vz, strength) {
    const i = this.next; this.next = (i + 1) % MAX_SMOKE;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.span[i] = this.life[i] = 0.9 + Math.random() * 0.9;
    this.aux[i * 2] = 0.6; this.aux[i * 2 + 1] = 0.34 * strength;
  }

  update(dt) {
    for (let i = 0; i < MAX_SMOKE; i++) {
      if (this.life[i] <= 0) { this.aux[i * 2 + 1] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.exp(-2.2 * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k; this.vel[i * 3 + 1] += (0.9 - this.vel[i * 3 + 1]) * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.aux[i * 2] += 3.4 * dt;
      this.aux[i * 2 + 1] *= Math.exp(-(1.6 + 2.5 * (1 - this.life[i] / this.span[i])) * dt);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aux.needsUpdate = true;
  }
}

const MAX_SEG = 700;

// one ribbon per wheel; segments are appended into a ring buffer
export class Skid {
  constructor(scene, width = 0.26) {
    this.w = width / 2;
    this.pos = new Float32Array(MAX_SEG * 4 * 3);
    this.alpha = new Float32Array(MAX_SEG * 4);
    const idx = new Uint16Array(MAX_SEG * 6);
    for (let i = 0; i < MAX_SEG; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.03, 0.03, 0.035, vA); }`,
    });
    this.mesh = new THREE.Mesh(g, m); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.next = 0; this.has = false; this.px = 0; this.py = 0; this.pz = 0; this.pa = 0;
  }

  // call every frame with the contact point; strength 0 breaks the ribbon
  add(x, y, z, strength) {
    if (strength <= 0.02) { this.has = false; return; }
    if (this.has) {
      const dx = x - this.px, dz = z - this.pz, l = Math.hypot(dx, dz);
      if (l < 0.25) return;
      if (l < 6) {
        const nx = -dz / l * this.w, nz = dx / l * this.w, o = this.next * 12, a = this.next * 4;
        this.pos.set([this.px + nx, this.py, this.pz + nz, this.px - nx, this.py, this.pz - nz, x + nx, y, z + nz, x - nx, y, z - nz], o);
        this.alpha.set([this.pa, this.pa, strength, strength], a);
        this.next = (this.next + 1) % MAX_SEG;
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.alpha.needsUpdate = true;
      }
    }
    this.has = true; this.px = x; this.py = y; this.pz = z; this.pa = strength;
  }

  clear() { this.alpha.fill(0); this.has = false; this.mesh.geometry.attributes.alpha.needsUpdate = true; }
}
