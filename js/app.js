// Aorta Flow Lab — a ParaView-style viewer for two aorta CFD results.
import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { loadModel, sampleGrid, traceStreamlines, rng } from './data.js';
import { compile, ExprError } from './expr.js';
import { lutTable, cssGradient, PRESETS } from './colormaps.js';
import { initLesson } from './lesson.js';

const DATA = 'data';
const MODEL_NAMES = ['healthy', 'diseased'];
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

// Stream Tracer settings that students don't need to change. They are applied to every
// stream tracer and are not shown in the Properties panel.
const STREAM_FIXED = { vectors: 'velocity', direction: 'BOTH', maxSteps: 9000, maxLength: 100, terminalSpeed: 1e-12 };

const UNITS = { pressure: 'dyn/cm²', average_pressure: 'dyn/cm²', velocity: 'cm/s', average_speed: 'cm/s', vWSS: 'dyn/cm²' };

export function fmt(v) {
  if (v == null || Number.isNaN(v)) return 'nan';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  return (+v.toPrecision(4)).toString();
}

// ------------------------------------------------------------------ state
const S = {
  models: {}, loading: {}, progress: {}, views: {}, nodes: [], selected: null, activeView: 'healthy',
  counters: { Calculator: 0, Clip: 0, StreamTracer: 0 }, luts: new Map(),
  autoApply: false, link: true, probe: false, layout: 'split', pick: null, uid: 0,
};
const listeners = new Set();
function notify() { for (const f of listeners) { try { f(); } catch (e) { console.error(e); } } }

// ------------------------------------------------------------------ colour
const linCache = new Map();
function linTable(lut) {
  const key = lut.preset + (lut.invert ? '|i' : '');
  if (!linCache.has(key)) {
    const t = lutTable(lut.preset, lut.invert), out = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) { const c = t[i]; out[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    linCache.set(key, out);
  }
  return linCache.get(key);
}
function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const NAN_RGB = [0.5, 0.5, 0.5];

function getLut(name) {
  if (!S.luts.has(name)) S.luts.set(name, { name, preset: 'Cool to Warm', invert: false, range: [0, 1], comp: 'Magnitude', locked: false, legend: true, init: false });
  return S.luts.get(name);
}
const compIndex = (lut, ncomp) => (ncomp === 1 ? 0 : lut.comp === 'Magnitude' ? -1 : 'XYZ'.indexOf(lut.comp));
function scalarOf(v, comp) {
  if (typeof v === 'number') return v;
  return comp < 0 ? Math.hypot(v[0], v[1], v[2]) : v[comp];
}
/** Fill a Float32 RGB array (linear) from scalar values via the LUT. */
function mapColors(values, lut, out, tableOverride) {
  const T = tableOverride || linTable(lut), [lo, hi] = lut.range, span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { out[i * 3] = NAN_RGB[0]; out[i * 3 + 1] = NAN_RGB[1]; out[i * 3 + 2] = NAN_RGB[2]; continue; }
    let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const k = Math.round(t * 255) * 3;
    out[i * 3] = T[k]; out[i * 3 + 1] = T[k + 1]; out[i * 3 + 2] = T[k + 2];
  }
  return out;
}

// ------------------------------------------------------------------ fields
// A field: { name, ncomp, surface(): Float32Array, at(rec): number|[3], range(comp): [lo, hi] }
function sourceFields(model) {
  const A = model.surf.arrays, meta = model.meta;
  const metaRange = (name, comp) => {
    const a = meta.arrays.find((x) => x.name === name);
    if (!a) return [0, 1];
    return a.ncomp === 1 ? a.ranges[0] : a.ranges[comp < 0 ? a.ncomp : comp];
  };
  const defs = [
    ['pressure', 1, (r) => r.p], ['velocity', 3, (r) => [r.vx, r.vy, r.vz]],
    ['average_pressure', 1, (r) => r.ap], ['average_speed', 1, (r) => r.as], ['vWSS', 3, () => [0, 0, 0]],
  ];
  const m = new Map();
  for (const [name, ncomp, at] of defs) m.set(name, { name, ncomp, at, surface: () => A[name], range: (c) => metaRange(name, c), base: true });
  return m;
}

function makeSurfaceEnv(fields, positions) {
  const env = { i: 0, get(n) {
    const i = env.i;
    if (n === 'coords') return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const f = fields.get(n), s = f.surface();
    return f.ncomp === 1 ? s[i] : [s[i * 3], s[i * 3 + 1], s[i * 3 + 2]];
  } };
  return env;
}
function makeRecEnv(fields) {
  const env = { rec: null, get(n) { const r = env.rec; return n === 'coords' ? [r.x, r.y, r.z] : fields.get(n).at(r); } };
  return env;
}

/** Evaluate any field's range over the fluid voxels of the grid (used for Calculator results). */
function gridRange(model, at, comp) {
  const G = model.grid, rec = {};
  let lo = Infinity, hi = -Infinity;
  const nxy = G.nx * G.ny;
  for (let n = 0; n < G.sdf.length; n++) {
    if (G.sdf[n] <= 0) continue;
    const a = G.idx[n];
    rec.x = G.ox + (n % G.nx) * G.h; rec.y = G.oy + (Math.floor(n / G.nx) % G.ny) * G.h; rec.z = G.oz + Math.floor(n / nxy) * G.h;
    rec.vx = G.vx[a]; rec.vy = G.vy[a]; rec.vz = G.vz[a]; rec.p = G.p[a]; rec.ap = G.ap[a]; rec.as = G.as[a]; rec.sdf = 1;
    const v = scalarOf(at(rec), comp);
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

function nodeFields(node) {
  if (!node) return new Map();
  if (node.type === 'source') { const m = S.models[node.model]; return m ? (m._fields ||= sourceFields(m)) : new Map(); }
  if (node.type === 'calculator' && node.out && node.out.field) {
    const m = new Map(nodeFields(node.parent));
    m.set(node.out.field.name, node.out.field);
    return m;
  }
  return nodeFields(node.parent);
}

// ------------------------------------------------------------------ geometry helpers
function modelGeometry(model) {
  if (model._geom) return model._geom;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(model.surf.positions, 3));
  g.setIndex(new THREE.BufferAttribute(model.surf.index, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere(); g.computeBoundingBox();
  model._geom = g;
  return g;
}
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
function basisFor(n) {
  const N = v3(n).normalize();
  const a = Math.abs(N.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(N, a).normalize();
  const w = new THREE.Vector3().crossVectors(N, u).normalize();
  return { N, u, w };
}
function boundsCorners(b) {
  const out = [];
  for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(b[i & 1 ? 1 : 0], b[i & 2 ? 3 : 2], b[i & 4 ? 5 : 4]));
  return out;
}

/** A clip half-space as a THREE.Plane (keeps points with distance >= 0). */
function clipPlane(props) {
  const n = v3(props.normal).normalize(), o = v3(props.origin);
  return props.invert ? new THREE.Plane(n.clone().negate(), n.dot(o)) : new THREE.Plane(n, -n.dot(o));
}
function clipChain(node) {
  const chain = [];
  for (let n = node; n; n = n.parent) if (n.type === 'clip' && n.props) chain.unshift(n);
  return chain;
}

// ------------------------------------------------------------------ sample caches (cap texels, streamline vertices)
const CH = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'p', 'ap', 'as', 'sdf'];
function newCache(n) { const c = { n }; for (const k of CH) c[k] = new Float32Array(n); return c; }
function cacheStore(c, i, rec) { for (const k of CH) c[k][i] = rec[k]; }
function cacheValues(c, field, comp, mask) {
  const out = new Float32Array(c.n), rec = {};
  for (let i = 0; i < c.n; i++) {
    if (mask && !mask[i]) { out[i] = NaN; continue; }
    for (const k of CH) rec[k] = c[k][i];
    out[i] = scalarOf(field.at(rec), comp);
  }
  return out;
}

// ------------------------------------------------------------------ actors
class SurfaceActor {
  constructor(view, model, planes, caps) {
    this.view = view; this.model = model; this.planes = planes;
    this.group = new THREE.Group();
    const base = modelGeometry(model);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    g.setIndex(base.getIndex());
    g.boundingSphere = base.boundingSphere; g.boundingBox = base.boundingBox;
    this.colors = new Float32Array(model.surf.nverts * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geom = g;
    const mat = (side) => new THREE.MeshLambertMaterial({ vertexColors: true, side, clippingPlanes: planes });
    this.front = new THREE.Mesh(g, mat(THREE.DoubleSide));
    this.back = new THREE.Mesh(g, mat(THREE.BackSide));
    this.back.visible = false; this.back.renderOrder = 1; this.front.renderOrder = 2;
    this.group.add(this.back, this.front);
    this.caps = caps.map((c) => new CapActor(model, c.props, c.others));
    for (const c of this.caps) this.group.add(c.mesh);
    this.edges = null; this.points = null; this.outline = null;
  }
  setDisplay(d) {
    const transparent = d.opacity < 0.999;
    for (const m of [this.front.material, this.back.material]) {
      m.opacity = d.opacity; m.transparent = transparent; m.depthWrite = !transparent; m.wireframe = d.repr === 'Wireframe';
      m.needsUpdate = true;
    }
    this.front.material.side = transparent ? THREE.FrontSide : THREE.DoubleSide;
    this.back.visible = transparent && (d.repr === 'Surface' || d.repr === 'Surface With Edges');
    const showSurf = d.repr === 'Surface' || d.repr === 'Surface With Edges' || d.repr === 'Wireframe';
    this.front.visible = showSurf;
    for (const c of this.caps) c.setDisplay(d, d.repr === 'Surface' || d.repr === 'Surface With Edges');
    if (d.repr === 'Surface With Edges' && !this.edges) {
      this.edges = new THREE.LineSegments(new THREE.WireframeGeometry(this.geom), new THREE.LineBasicMaterial({ color: 0x00007f, clippingPlanes: this.planes, transparent: true, opacity: 0.55 }));
      this.edges.renderOrder = 3; this.group.add(this.edges);
    }
    if (this.edges) this.edges.visible = d.repr === 'Surface With Edges';
    if (d.repr === 'Points' && !this.points) {
      this.points = new THREE.Points(this.geom, new THREE.PointsMaterial({ vertexColors: true, size: d.pointSize, sizeAttenuation: false, clippingPlanes: this.planes }));
      this.group.add(this.points);
    }
    if (this.points) { this.points.visible = d.repr === 'Points'; this.points.material.size = d.pointSize; this.points.material.opacity = d.opacity; this.points.material.transparent = transparent; }
    if (d.repr === 'Outline' && !this.outline) {
      this.outline = new THREE.Box3Helper(this.geom.boundingBox, 0xffffff);
      this.group.add(this.outline);
    }
    if (this.outline) this.outline.visible = d.repr === 'Outline';
  }
  setScalars(values, lut) {
    mapColors(values, lut, this.colors);
    this.geom.getAttribute('color').needsUpdate = true;
  }
  setSolid(hex) {
    const c = new THREE.Color(hex); // THREE.Color converts sRGB hex to linear
    for (let i = 0; i < this.colors.length; i += 3) { this.colors[i] = c.r; this.colors[i + 1] = c.g; this.colors[i + 2] = c.b; }
    this.geom.getAttribute('color').needsUpdate = true;
  }
  pickables() { return [this.front, ...this.caps.map((c) => c.mesh)]; }
  dispose() {
    this.group.removeFromParent();
    this.front.material.dispose(); this.back.material.dispose(); this.geom.dispose();
    for (const c of this.caps) c.dispose();
    if (this.edges) { this.edges.geometry.dispose(); this.edges.material.dispose(); }
    if (this.points) this.points.material.dispose();
  }
}

/** The cut face of a clip: the volume solution sampled on the plane and drawn as a texture. */
class CapActor {
  constructor(model, props, others) {
    const G = model.grid, { N, u, w } = basisFor(props.normal), o = v3(props.origin);
    // project the bounds onto the plane to size the cap
    let umin = Infinity, umax = -Infinity, wmin = Infinity, wmax = -Infinity;
    for (const c of boundsCorners(model.meta.bounds)) {
      const d = c.clone().sub(o), a = d.dot(u), b = d.dot(w);
      umin = Math.min(umin, a); umax = Math.max(umax, a); wmin = Math.min(wmin, b); wmax = Math.max(wmax, b);
    }
    const texel = Math.max(G.h * 0.5, Math.max(umax - umin, wmax - wmin) / 720);
    const W = Math.max(2, Math.ceil((umax - umin) / texel)), H = Math.max(2, Math.ceil((wmax - wmin) / texel));
    umax = umin + W * texel; wmax = wmin + H * texel;
    const cache = newCache(W * H), alpha = new Uint8Array(W * H), rec = {}, P = new THREE.Vector3();
    let any = false;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        P.copy(o).addScaledVector(u, umin + (i + 0.5) * texel).addScaledVector(w, wmin + (j + 0.5) * texel);
        const sdf = sampleGrid(G, P.x, P.y, P.z, rec);
        if (sdf < -2 * texel) { rec.sdf = sdf; alpha[k] = 0; continue; }
        cacheStore(cache, k, rec);
        const a = 0.5 + sdf / texel * 0.5;
        alpha[k] = Math.round(255 * (a < 0 ? 0 : a > 1 ? 1 : a));
        if (alpha[k] > 127) any = true;
      }
    }
    this.cache = cache; this.alpha = alpha; this.W = W; this.H = H; this.any = any;
    this.pixels = new Uint8Array(W * H * 4);
    this.tex = new THREE.DataTexture(this.pixels, W, H, THREE.RGBAFormat);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.magFilter = THREE.LinearFilter; this.tex.minFilter = THREE.LinearFilter; this.tex.generateMipmaps = false;
    const corners = [[umin, wmin], [umax, wmin], [umax, wmax], [umin, wmax]].map(([a, b]) => o.clone().addScaledVector(u, a).addScaledVector(w, b));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => [c.x, c.y, c.z]), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 2, 3].flatMap(() => [N.x, N.y, N.z]), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.geom = g;
    this.mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: this.tex, alphaTest: 0.5, side: THREE.DoubleSide, clippingPlanes: others }));
    this.mesh.userData.cap = this;
    this.mesh.renderOrder = 2;
    this.basis = { o, u, w, umin, wmin, texel };
  }
  mask() { return this.alpha; }
  setValues(values, lut) {
    const T = lutTable(lut.preset, lut.invert), [lo, hi] = lut.range, span = hi - lo || 1, px = this.pixels;
    for (let k = 0; k < values.length; k++) {
      const v = values[k];
      if (Number.isNaN(v)) { px[k * 4] = px[k * 4 + 1] = px[k * 4 + 2] = 128; }
      else {
        let t = (v - lo) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const q = Math.round(t * 255) * 3;
        px[k * 4] = T[q] * 255; px[k * 4 + 1] = T[q + 1] * 255; px[k * 4 + 2] = T[q + 2] * 255;
      }
      px[k * 4 + 3] = this.alpha[k];
    }
    this.tex.needsUpdate = true;
  }
  setSolid(hex) {
    const c = new THREE.Color(hex).convertLinearToSRGB(), px = this.pixels;
    for (let k = 0; k < this.alpha.length; k++) { px[k * 4] = c.r * 255; px[k * 4 + 1] = c.g * 255; px[k * 4 + 2] = c.b * 255; px[k * 4 + 3] = this.alpha[k]; }
    this.tex.needsUpdate = true;
  }
  setDisplay(d, show) {
    const m = this.mesh.material, tr = d.opacity < 0.999;
    m.opacity = d.opacity; m.transparent = tr; m.depthWrite = !tr; m.needsUpdate = true;
    this.mesh.visible = show;
  }
  dispose() { this.mesh.removeFromParent(); this.geom.dispose(); this.mesh.material.dispose(); this.tex.dispose(); }
}

class StreamActor {
  constructor(view, model, lines) {
    this.view = view; this.lines = lines;
    let nseg = 0, nv = 0;
    for (const l of lines) { nseg += l.length / 3 - 1; nv += l.length / 3; }
    this.nseg = nseg; this.nverts = nv;
    // per-vertex sample cache for colouring
    const cache = newCache(nv), rec = {};
    let k = 0;
    for (const l of lines) for (let i = 0; i < l.length; i += 3) { sampleGrid(model.grid, l[i], l[i + 1], l[i + 2], rec); cacheStore(cache, k++, rec); }
    this.cache = cache;
    const pos = new Float32Array(nseg * 6);
    this.segIdx = new Uint32Array(nseg * 2);
    let s = 0; k = 0;
    for (const l of lines) {
      const m = l.length / 3;
      for (let i = 0; i < m - 1; i++, s++) {
        pos.set(l.subarray(i * 3, i * 3 + 6), s * 6);
        this.segIdx[s * 2] = k + i; this.segIdx[s * 2 + 1] = k + i + 1;
      }
      k += m;
    }
    this.geom = new LineSegmentsGeometry();
    if (nseg) this.geom.setPositions(pos);
    this.segColors = new Float32Array(nseg * 6).fill(1);
    if (nseg) this.geom.setColors(this.segColors);
    this.mat = new LineMaterial({ vertexColors: true, linewidth: 1.5, worldUnits: false });
    this.obj = new LineSegments2(this.geom, this.mat);
    this.obj.renderOrder = 0;
    this.obj.visible = nseg > 0;
    this.group = new THREE.Group(); this.group.add(this.obj);
    this.points = null;
  }
  setDisplay(d) {
    const tr = d.opacity < 0.999;
    this.mat.linewidth = (d.tubes ? 4 : 1.5) * d.lineWidth;
    this.mat.opacity = d.opacity; this.mat.transparent = tr; this.mat.needsUpdate = true;
    this.obj.visible = this.nseg > 0 && d.repr !== 'Points' && d.repr !== 'Outline';
    if (d.repr === 'Points' && !this.points && this.nverts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from({ length: this.nverts * 3 }, (_, i) => this.cache[CH[i % 3]][Math.floor(i / 3)]), 3));
      this.pcolors = new Float32Array(this.nverts * 3).fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(this.pcolors, 3));
      this.points = new THREE.Points(g, new THREE.PointsMaterial({ vertexColors: true, size: d.pointSize, sizeAttenuation: false }));
      this.group.add(this.points);
      if (this._lastVert) this._applyPoints(this._lastVert);
    }
    if (this.points) { this.points.visible = d.repr === 'Points'; this.points.material.size = d.pointSize; }
  }
  _applySegs(vert) {
    for (let s = 0; s < this.nseg; s++) {
      const a = this.segIdx[s * 2] * 3, b = this.segIdx[s * 2 + 1] * 3;
      this.segColors[s * 6] = vert[a]; this.segColors[s * 6 + 1] = vert[a + 1]; this.segColors[s * 6 + 2] = vert[a + 2];
      this.segColors[s * 6 + 3] = vert[b]; this.segColors[s * 6 + 4] = vert[b + 1]; this.segColors[s * 6 + 5] = vert[b + 2];
    }
    if (this.nseg) this.geom.setColors(this.segColors);
  }
  _applyPoints(vert) { if (this.points) { this.pcolors.set(vert); this.points.geometry.getAttribute('color').needsUpdate = true; } }
  setScalars(values, lut) {
    const vert = mapColors(values, lut, new Float32Array(this.nverts * 3));
    this._lastVert = vert; this._applySegs(vert); this._applyPoints(vert);
  }
  setSolid(hex) {
    const c = new THREE.Color(hex), vert = new Float32Array(this.nverts * 3);
    for (let i = 0; i < vert.length; i += 3) { vert[i] = c.r; vert[i + 1] = c.g; vert[i + 2] = c.b; }
    this._lastVert = vert; this._applySegs(vert); this._applyPoints(vert);
  }
  pickables() { return []; }
  dispose() { this.group.removeFromParent(); this.geom.dispose(); this.mat.dispose(); if (this.points) { this.points.geometry.dispose(); this.points.material.dispose(); } }
}

// ------------------------------------------------------------------ views
class View {
  constructor(name, host) {
    this.name = name; this.host = host; this.model = null; this.needs = true;
    this.canvas = document.createElement('canvas');
    host.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 500);
    this.scene.add(this.camera);
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(0.25, 0.35, 1); key.target.position.set(0, 0, -1);
    this.camera.add(key, key.target);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8088a0, 0.75));
    this.content = new THREE.Group(); this.widgets = new THREE.Group(); this.marks = new THREE.Group();
    this.scene.add(this.content, this.widgets, this.marks);
    this.camera.position.set(10, 0, 0); this.camera.up.set(0, 0, 1); // default: look along -X, Z up
    // widget dragging must see pointer events before the camera controls do
    this.canvas.addEventListener('pointerdown', (e) => onViewPointerDown(this, e));
    this.controls = new TrackballControls(this.camera, this.canvas);
    Object.assign(this.controls, { rotateSpeed: 3.2, zoomSpeed: 1.4, panSpeed: 0.9, staticMoving: true });
    this.controls.keys = [];
    this.controls.addEventListener('change', () => { this.needs = true; syncCameras(this); });
    this.canvas.addEventListener('pointermove', (e) => onViewPointerMove(this, e));
    this.canvas.addEventListener('pointerleave', () => hideTooltip());
    this.canvas.addEventListener('pointerdown', () => setActiveView(this.name));
    this.axes = makeAxesTriad();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }
  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
    this.controls.handleResize();
    this.w = r.width; this.h = r.height; this.needs = true;
  }
  setModel(model) {
    const dir = this.camera.position.clone().sub(this.controls.target);
    this.model = model;
    this.controls.target.set(...model.center);
    this.camera.position.copy(this.controls.target).add(dir);
    this.resetCamera();
  }
  resetCamera() {
    if (!this.model) return;
    const c = v3(this.model.center), r = this.model.diag * 0.36;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
    dir.normalize();
    const fit = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (this.camera.aspect < 1 ? 1 / this.camera.aspect : 1) * 0.92;
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, fit);
    this.camera.near = fit / 100; this.camera.far = fit * 10; this.camera.updateProjectionMatrix();
    this.camera.lookAt(c);
    this.needs = true;
  }
  render() {
    for (const m of this.lineMaterials()) m.resolution.set(this.w, this.h);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(dist / 200, 0.001); this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
    const R = this.renderer;
    R.autoClear = true;
    R.setViewport(0, 0, this.w, this.h);
    R.render(this.scene, this.camera);
    // orientation axes (lower left)
    R.autoClear = false; R.clearDepth();
    const s = 86;
    R.setViewport(6, 6, s, s);
    this.axes.cam.quaternion.copy(this.camera.quaternion);
    this.axes.cam.position.set(0, 0, 3.4).applyQuaternion(this.camera.quaternion);
    this.axes.cam.up.copy(this.camera.up);
    R.render(this.axes.scene, this.axes.cam);
    R.setViewport(0, 0, this.w, this.h);
  }
  lineMaterials() {
    const out = [];
    this.content.traverse((o) => { if (o.material && o.material.isLineMaterial) out.push(o.material); });
    return out;
  }
}

function makeAxesTriad() {
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1.25, 1.25, 1.25, -1.25, 0.1, 10);
  const cols = [0xe0473c, 0xe8d33f, 0x3fb34f];
  ['X', 'Y', 'Z'].forEach((name, i) => {
    const d = new THREE.Vector3(i === 0, i === 1, i === 2);
    scene.add(new THREE.ArrowHelper(d, new THREE.Vector3(), 0.9, cols[i], 0.22, 0.12));
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'); g.font = 'bold 44px sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, 32, 34);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
    sp.position.copy(d.multiplyScalar(1.12)); sp.scale.set(0.42, 0.42, 1);
    scene.add(sp);
  });
  return { scene, cam };
}

let syncing = false;
function syncCameras(src) {
  if (syncing || !S.link || !src.model) return;
  syncing = true;
  for (const v of Object.values(S.views)) {
    if (v === src || !v.model) continue;
    const off = src.camera.position.clone().sub(src.controls.target);
    const pan = src.controls.target.clone().sub(v3(src.model.center));
    v.controls.target.copy(v3(v.model.center)).add(pan);
    v.camera.position.copy(v.controls.target).add(off);
    v.camera.up.copy(src.camera.up);
    v.camera.lookAt(v.controls.target);
    v.needs = true;
  }
  syncing = false;
}

function setViewDirection(code) {
  const sign = code[0] === '-' ? -1 : 1, axis = 'XYZ'.indexOf(code[1]);
  const d = new THREE.Vector3(); d.setComponent(axis, sign);
  const up = axis === 2 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  for (const v of camTargets()) {
    v.camera.up.copy(up);
    v.camera.position.copy(v.controls.target).addScaledVector(d, -1);
    v.resetCamera();
  }
}
const camTargets = () => (S.link ? Object.values(S.views) : [S.views[S.activeView]]);

function setActiveView(name) {
  if (S.activeView === name) return;
  S.activeView = name;
  for (const v of Object.values(S.views)) v.host.classList.toggle('active', v.name === name);
}

function frame() {
  for (const v of Object.values(S.views)) {
    if (v.host.offsetParent === null) continue;
    v.controls.update();
    if (v.needs) { v.needs = false; v.render(); }
  }
  requestAnimationFrame(frame);
}
const redrawAll = () => { for (const v of Object.values(S.views)) v.needs = true; };

// ------------------------------------------------------------------ pipeline nodes
const TYPE_LABEL = { source: 'UnstructuredGridRepresentation', calculator: 'Calculator', clip: 'Clip', stream: 'StreamTracer' };

function defaults(type, model, parent) {
  const m = S.models[model];
  const center = m ? m.center.slice() : [0, 0, 0], diag = m ? m.diag : 10;
  if (type === 'source') return { arrays: true };
  if (type === 'calculator') return { attribute: 'Point Data', resultName: 'Result', expression: '' };
  if (type === 'clip') return { clipType: 'Plane', origin: center, normal: [1, 0, 0], invert: true, showPlane: true };
  if (type === 'stream') return { center, radius: +(diag / 10).toFixed(4), numPoints: 100, showSphere: true };
}
function defaultDisplay(type, parent) {
  const inherit = parent ? parent.display.colorBy : 'pressure';
  return { colorBy: type === 'source' ? 'pressure' : inherit, repr: 'Surface', opacity: 1, pointSize: 2, lineWidth: 1, tubes: false, solid: '#ffffff' };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createNode(type, model, parent) {
  const name = type === 'source' ? `${model}.vtu` : `${TYPE_LABEL[type]}${++S.counters[TYPE_LABEL[type]]}`;
  const node = {
    id: ++S.uid, type, model, parent, children: [], name, visible: true, applied: false, dirty: true,
    props: null, edit: defaults(type, model, parent), display: defaultDisplay(type, parent), out: null, actor: null,
  };
  if (parent) parent.children.push(node);
  S.nodes.push(node);
  return node;
}
const nodesOf = (model) => S.nodes.filter((n) => n.model === model);
const isSurfaceType = (n) => n && (n.type === 'source' || n.type === 'calculator' || n.type === 'clip');

function deleteNode(node) {
  if (node.children.length) { status(`Delete the items under ${node.name} first.`, true); return; }
  if (node.actor) node.actor.dispose();
  S.nodes = S.nodes.filter((n) => n !== node);
  if (node.parent) {
    node.parent.children = node.parent.children.filter((c) => c !== node);
    if (node.applied && !node.parent.visible) { node.parent.visible = true; refreshNode(node.parent); }
    S.selected = node.parent;
  } else {
    S.selected = S.nodes.find((n) => !n.parent) || null;
    if (S.views[node.model]) { const e = S.views[node.model].host.querySelector('.empty'); e.innerHTML = 'Click <b>Open</b> to load the data files.'; e.hidden = false; }
  }
  afterChange();
}

// ------------------------------------------------------------------ computing outputs
async function computeNode(node) {
  const model = S.models[node.model], view = S.views[node.model], P = node.props;
  if (node.actor) { node.actor.dispose(); node.actor = null; }
  if (node.type === 'source') {
    node.out = {};
    node.actor = new SurfaceActor(view, model, [], []);
  } else if (node.type === 'calculator') {
    const pf = nodeFields(node.parent);
    const name = (P.resultName || '').trim();
    if (!name) throw new Error('Give the result a name in Result Array Name.');
    const vars = new Map([...pf.values()].map((f) => [f.name, f.ncomp]));
    const { fn } = compile(P.expression, vars);
    const sEnv = makeSurfaceEnv(pf, model.surf.positions), rEnv = makeRecEnv(pf);
    sEnv.i = 0;
    const first = fn(sEnv);
    const ncomp = Array.isArray(first) ? 3 : 1;
    let surf = null;
    const field = {
      name, ncomp,
      surface() {
        if (surf) return surf;
        const n = model.surf.nverts; surf = new Float32Array(n * ncomp);
        for (let i = 0; i < n; i++) { sEnv.i = i; const v = fn(sEnv); if (ncomp === 1) surf[i] = v; else { surf[i * 3] = v[0]; surf[i * 3 + 1] = v[1]; surf[i * 3 + 2] = v[2]; } }
        return surf;
      },
      at(rec) { rEnv.rec = rec; return fn(rEnv); },
      _ranges: {},
      range(comp) { return (this._ranges[comp] ||= gridRange(model, (r) => this.at(r), comp)); },
    };
    field.surface();
    node.out = { field };
    node.actor = new SurfaceActor(view, model, [], []);
  } else if (node.type === 'clip') {
    const chain = clipChain(node);
    const planes = chain.map((c) => clipPlane(c.props));
    const caps = chain.map((c, i) => ({ props: c.props, others: planes.filter((_, j) => j !== i) }));
    node.out = {};
    node.actor = new SurfaceActor(view, model, planes, caps);
  } else if (node.type === 'stream') {
    status('Tracing streamlines…');
    await new Promise((r) => setTimeout(r, 30));
    // seeds: a point cloud of random points inside the sphere (fixed random seed, so results repeat)
    const seeds = [], rand = rng(1234567 + Math.round(P.numPoints));
    const R = Math.max(0, +P.radius), n = Math.max(1, Math.min(5000, Math.round(P.numPoints)));
    while (seeds.length < n) {
      const x = rand() * 2 - 1, y = rand() * 2 - 1, z = rand() * 2 - 1;
      if (x * x + y * y + z * z > 1) continue;
      seeds.push([P.center[0] + R * x, P.center[1] + R * y, P.center[2] + R * z]);
    }
    const F = STREAM_FIXED;
    const planes = clipChain(node.parent).map((c) => { const p = clipPlane(c.props); return { n: [p.normal.x, p.normal.y, p.normal.z], d: p.constant }; });
    const lines = traceStreamlines(model.grid, seeds, {
      maxLength: F.maxLength, maxSteps: F.maxSteps, step: model.grid.h * 0.5,
      terminalSpeed: F.terminalSpeed, direction: F.direction, planes,
    });
    node.out = { lines, nseeds: seeds.length };
    node.actor = new StreamActor(view, model, lines);
    hideStatus();
  }
  view.content.add(node.actor.group);
}

/** Data range of the array a node is coloured by, over that node's output. */
function nodeRange(node, field, comp) {
  if (node.type === 'stream' && node.actor) {
    const vals = cacheValues(node.actor.cache, field, comp);
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return lo <= hi ? [lo, hi] : [0, 1];
  }
  return field.range(comp);
}

/** ParaView-style "grow and update": the colour range covers every visible item coloured by that array. */
function autoRange(name, force = false) {
  const lut = getLut(name);
  if (lut.locked && !force) return;
  let lo = Infinity, hi = -Infinity;
  for (const n of S.nodes) {
    if (!n.applied || !n.visible || n.display.colorBy !== name) continue;
    const f = nodeFields(n).get(name);
    if (!f) continue;
    const [a, b] = nodeRange(n, f, compIndex(lut, f.ncomp));
    lo = Math.min(lo, a); hi = Math.max(hi, b);
  }
  if (lo <= hi) { lut.range = lo === hi ? [lo - 1e-6, hi + 1e-6] : [lo, hi]; lut.init = true; }
}

function recolor(node) {
  const a = node.actor;
  if (!a) return;
  const d = node.display, f = d.colorBy ? nodeFields(node).get(d.colorBy) : null;
  if (!f) {
    if (d.colorBy) d.colorBy = null;
    a.setSolid(d.solid);
    if (a.caps) for (const c of a.caps) c.setSolid(d.solid);
    return;
  }
  const lut = getLut(f.name), comp = compIndex(lut, f.ncomp);
  if (!lut.init) autoRange(f.name, true);
  if (node.type === 'stream') a.setScalars(cacheValues(a.cache, f, comp), lut);
  else {
    const s = f.surface(), n = s.length / f.ncomp, vals = new Float32Array(n);
    if (f.ncomp === 1) vals.set(s);
    else for (let i = 0; i < n; i++) vals[i] = comp < 0 ? Math.hypot(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]) : s[i * 3 + comp];
    a.setScalars(vals, lut);
    for (const c of a.caps) c.setValues(cacheValues(c.cache, f, comp, c.mask()), lut);
  }
}
function refreshNode(node) {
  if (!node.actor) return;
  node.actor.group.visible = node.visible;
  node.actor.setDisplay(node.display);
  recolor(node);
  S.views[node.model].needs = true;
}
function refreshAllColors() {
  const names = new Set(S.nodes.filter((n) => n.applied && n.visible && n.display.colorBy).map((n) => n.display.colorBy));
  for (const name of names) autoRange(name);
  for (const n of S.nodes) refreshNode(n);
  renderLegends();
}

// ------------------------------------------------------------------ apply / reset
let applying = false, autoTimer = 0;
async function applyAll() {
  if (applying) return;
  const pending = S.nodes.filter((n) => !n.applied || n.dirty);
  if (!pending.length) return;
  applying = true; refreshApplyButton();
  try {
    for (const m of new Set(pending.map((n) => n.model))) {
      if (!S.models[m]) { status(`Loading ${m}.vtu…`); S.models[m] = await S.loading[m]; }
    }
    const recompute = new Set();
    for (const node of pending) {
      const prev = node.props, first = !node.applied;
      node.props = clone(node.edit);
      try {
        await computeNode(node);
      } catch (e) {
        node.props = prev;
        if (prev) await computeNode(node).catch(() => {});
        status(e instanceof ExprError || e.message ? `${node.name}: ${e.message}` : String(e), true);
        console.error(e);
        throw e;
      }
      node.applied = true; node.dirty = false;
      if (first) {
        if (node.type === 'source') {
          S.views[node.model].setModel(S.models[node.model]);
          S.views[node.model].host.querySelector('.empty').hidden = true;
          syncFromActive(node.model);
        }
        if (node.type === 'calculator') node.display.colorBy = node.out.field.name;
        if ((node.type === 'calculator' || node.type === 'clip') && node.parent) node.parent.visible = false;
      }
      const walk = (n) => { for (const c of n.children) { if (c.applied && !pending.includes(c)) recompute.add(c); walk(c); } };
      walk(node);
    }
    for (const n of S.nodes) if (recompute.has(n)) await computeNode(n);
    for (const n of S.nodes) if (n.display.colorBy && n.applied && !nodeFields(n).get(n.display.colorBy)) n.display.colorBy = null;
    hideStatus();
  } catch (e) { /* message already shown */ }
  applying = false;
  refreshAllColors();
  afterChange(true);
}
/** After the first model appears, copy the camera of the view that already has one. */
function syncFromActive(model) {
  const other = Object.values(S.views).find((v) => v.name !== model && v.model);
  if (other && S.link) syncCameras(other);
}
function resetEdits(node) {
  node.edit = node.props ? clone(node.props) : defaults(node.type, node.model, node.parent);
  node.dirty = !node.applied;
  afterChange(true);
}
// widget visibility switches act at once, like in ParaView, without needing Apply
const UI_KEYS = new Set(['showPlane', 'showSphere']);
function setEdit(node, key, value) {
  node.edit[key] = value;
  if (UI_KEYS.has(key) && node.props) node.props[key] = value;
  node.dirty = !node.applied || !same(node.edit, node.props);
  refreshApplyButton(); renderTree(); updateWidgets(); markChanged(node); notify();
  if (S.autoApply && calcReady(node)) { clearTimeout(autoTimer); autoTimer = setTimeout(applyAll, node.type === 'stream' ? 450 : 200); }
}
/** With Auto Apply on, wait until a Calculator expression is complete before applying it. */
function calcReady(node) {
  if (node.type !== 'calculator') return true;
  try { compile(node.edit.expression, new Map([...nodeFields(node.parent).values()].map((f) => [f.name, f.ncomp]))); return !!node.edit.resultName.trim(); }
  catch { return false; }
}
function setDisplay(node, key, value) {
  node.display[key] = value;
  if (key === 'colorBy' && value) { const lut = getLut(value); if (!lut.locked) autoRange(value, true); refreshAllColors(); }
  else if (key === 'colorBy') { refreshNode(node); renderLegends(); }
  else refreshNode(node);
  syncToolbar(); notify();
}

// ------------------------------------------------------------------ status line
let statusTimer = 0;
function status(msg, err = false, ms = 0) {
  const s = $('#status');
  s.textContent = msg; s.classList.add('show'); s.classList.toggle('err', err);
  clearTimeout(statusTimer);
  if (err || ms) statusTimer = setTimeout(hideStatus, ms || 6000);
}
function hideStatus() { $('#status').classList.remove('show'); }

// ------------------------------------------------------------------ pipeline browser
const ICONS = {
  source: '<svg class="nicon" viewBox="0 0 16 16"><path d="M2 5l6-3 6 3v6l-6 3-6-3z" fill="#7fbf86" stroke="#2f7d3e"/><path d="M8 8L2 5M8 8l6-3M8 8v6" stroke="#2f7d3e" stroke-width=".8"/></svg>',
  calculator: '<svg class="nicon" viewBox="0 0 16 16"><rect x="3" y="1.5" width="10" height="13" rx="1.5" fill="#eef0f3" stroke="#59606d"/><rect x="4.8" y="3.2" width="6.4" height="2.6" fill="#9fd4a8"/><g fill="#59606d"><circle cx="5.8" cy="8.5" r=".8"/><circle cx="8" cy="8.5" r=".8"/><circle cx="10.2" cy="8.5" r=".8"/><circle cx="5.8" cy="11.5" r=".8"/><circle cx="8" cy="11.5" r=".8"/><circle cx="10.2" cy="11.5" r=".8"/></g></svg>',
  clip: '<svg class="nicon" viewBox="0 0 16 16"><path d="M2 5l6-3 6 3v6l-6 3-6-3z" fill="#7fbf86" stroke="#2f7d3e"/><path d="M1.5 12L14.5 3.5" stroke="#b02a3e" stroke-width="1.5"/></svg>',
  stream: '<svg class="nicon" viewBox="0 0 16 16"><path d="M1.5 5c3-2.5 5 2 8 0s3.5-1.5 5-.5M1.5 10c3-2.5 5 2 8 0s3.5-1.5 5-.5" fill="none" stroke="#3f7fd9" stroke-width="1.4" stroke-linecap="round"/></svg>',
};
const EYE_OPEN = '<svg viewBox="0 0 20 20"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.8" fill="currentColor"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 20 20" opacity=".55"><path d="M2 10s3.5 5 8 5 8-5 8-5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 13.2l-1.4 2M10 15v2.3M15 13.2l1.4 2" stroke="currentColor" stroke-width="1.4"/></svg>';

function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  tree.append(el('li', { class: 'root', role: 'treeitem' }, 'builtin:'));
  if (!S.nodes.length) { tree.append(el('li', { class: 'tree-empty' }, 'Nothing loaded yet. Click Open in the toolbar.')); return; }
  const add = (node, depth) => {
    const li = el('li', { class: 'node' + (node === S.selected ? ' selected' : ''), role: 'treeitem', 'aria-selected': node === S.selected ? 'true' : 'false', style: `padding-left:${10 + depth * 16}px` });
    const eye = el('button', { class: 'eye', title: node.visible ? `Hide ${node.name}` : `Show ${node.name}`, 'aria-label': `${node.visible ? 'Hide' : 'Show'} ${node.name}`, disabled: !node.applied, html: node.applied && node.visible ? EYE_OPEN : EYE_SHUT });
    eye.addEventListener('click', (e) => { e.stopPropagation(); node.visible = !node.visible; refreshAllColors(); renderTree(); notify(); });
    const name = el('span', { class: 'nname', tabindex: 0 }, node.name);
    li.append(eye, el('span', { html: ICONS[node.type] }), name);
    if (node.dirty) li.append(el('span', { class: 'pending', title: 'Click Apply to update this item' }, node.applied ? 'changed' : 'new'));
    const select = () => selectNode(node);
    name.addEventListener('click', select);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
    tree.append(li);
    for (const c of node.children) add(c, depth + 1);
  };
  for (const n of S.nodes.filter((n) => !n.parent)) add(n, 0);
}

function selectNode(node) {
  S.selected = node;
  if (node) setActiveView(node.model);
  afterChange(true);
}

// ------------------------------------------------------------------ toolbar sync
function syncToolbar() {
  const n = S.selected;
  const ready = n && n.applied;
  for (const id of ['#btn-calc', '#btn-clip', '#btn-stream']) $(id).disabled = !(ready && isSurfaceType(n));
  const selC = $('#sel-color'), selComp = $('#sel-comp');
  selC.disabled = !ready;
  selC.innerHTML = '';
  selC.append(el('option', { value: '' }, 'Solid Color'));
  if (ready) for (const f of nodeFields(n).values()) selC.append(el('option', { value: f.name }, f.name));
  selC.value = ready && n.display.colorBy ? n.display.colorBy : '';
  const f = ready && n.display.colorBy ? nodeFields(n).get(n.display.colorBy) : null;
  selComp.innerHTML = '';
  if (f && f.ncomp === 3) { for (const c of ['Magnitude', 'X', 'Y', 'Z']) selComp.append(el('option', { value: c }, c)); selComp.value = getLut(f.name).comp; selComp.disabled = false; }
  else { selComp.append(el('option', {}, f ? '—' : 'Magnitude')); selComp.disabled = true; }
}
function refreshApplyButton() {
  const any = S.nodes.some((n) => !n.applied || n.dirty);
  $('#btn-apply').disabled = !any || applying;
  $('#btn-resetprops').disabled = !(S.selected && S.selected.dirty && S.selected.applied);
  $('#btn-delete').disabled = !S.selected;
}

function afterChange(rebuildProps = false) {
  renderTree(); syncToolbar(); refreshApplyButton(); updateWidgets(); renderLegends();
  if (rebuildProps) { renderProps(); if (!$('#info-body').hidden) renderInfo(); }
  notify(); redrawAll();
}

// ------------------------------------------------------------------ properties panel
function psec(title, open = true) {
  const d = el('details', { class: 'psec', open });
  d.append(el('summary', {}, title));
  const body = el('div', { class: 'pbody' });
  d.append(body);
  return { root: d, body };
}
function prow(label, control, cls = '') {
  return el('div', { class: 'prop ' + cls }, el('span', { class: 'plabel' }, label), control);
}
function numInput(node, key, idx, opts = {}) {
  const val = idx == null ? node.edit[key] : node.edit[key][idx];
  const inp = el('input', { type: 'text', inputmode: 'decimal', value: fmtInput(val), 'data-key': key, 'data-idx': idx ?? '', 'aria-label': opts.label || key });
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v)) { inp.classList.add('bad'); return; }
    inp.classList.remove('bad');
    if (idx == null) setEdit(node, key, opts.int ? Math.round(v) : v);
    else { const a = node.edit[key].slice(); a[idx] = v; setEdit(node, key, a); }
  });
  return inp;
}
function fmtInput(v) { return typeof v === 'number' ? (Math.abs(v) < 1e-4 && v !== 0 ? v.toExponential() : String(+v.toPrecision(6))) : v; }
function trio(node, key) { return el('div', { class: 'trio' }, [0, 1, 2].map((i) => numInput(node, key, i, { label: `${key} ${'XYZ'[i]}` }))); }
function checkInput(node, key, label) {
  const c = el('input', { type: 'checkbox', 'data-key': key, checked: !!node.edit[key] });
  c.addEventListener('change', () => setEdit(node, key, c.checked));
  return el('label', { class: 'prop check' }, c, el('span', {}, label));
}
function selectInput(node, key, options) {
  const s = el('select', { 'data-key': key }, options.map((o) => el('option', { value: o }, o)));
  s.value = node.edit[key];
  s.addEventListener('change', () => setEdit(node, key, s.value));
  return s;
}
/** Highlight inputs that differ from the applied values, and pull widget-driven edits into the inputs. */
function markChanged(node) {
  if (node !== S.selected) return;
  for (const inp of document.querySelectorAll('#props-body [data-key]')) {
    const key = inp.dataset.key, idx = inp.dataset.idx;
    if (!(key in node.edit)) continue;
    const ev = idx === '' || idx == null ? node.edit[key] : node.edit[key][+idx];
    const pv = node.props ? (idx === '' || idx == null ? node.props[key] : node.props[key][+idx]) : undefined;
    if (document.activeElement !== inp) {
      if (inp.type === 'checkbox') inp.checked = !!ev;
      else if (inp.tagName === 'SELECT') inp.value = ev;
      else if (inp.type === 'range') inp.value = ev;
      else if (typeof ev === 'number' ? parseFloat(inp.value) !== ev : inp.value !== ev) inp.value = fmtInput(ev);
    }
    inp.classList.toggle('changed', node.applied && !same(ev, pv));
  }
}

function renderProps() {
  const body = $('#props-body');
  body.innerHTML = '';
  const n = S.selected;
  if (!n) { body.append(el('p', { class: 'props-empty' }, 'Select an item in the Pipeline Browser to see its properties.')); return; }
  const sec = psec(`Properties (${n.name})`);
  if (n.type === 'source') {
    const list = el('div', { class: 'arrays-status' });
    for (const a of ['GlobalNodeID', 'average_pressure', 'average_speed', 'pressure', 'timeDeriv', 'vWSS', 'velocity', 'vinplane_traction'])
      list.append(el('label', {}, el('input', { type: 'checkbox', checked: true, disabled: true }), a));
    sec.body.append(el('span', { class: 'pnote' }, 'Cell/Point Array Status'), list);
    if (!n.applied) sec.body.append(el('p', { class: 'pok' }, S.models[n.model] ? 'File ready. Click Apply to show it.' : 'Reading file… you can click Apply now.'));
  } else if (n.type === 'calculator') renderCalcProps(n, sec.body);
  else if (n.type === 'clip') renderClipProps(n, sec.body);
  else if (n.type === 'stream') renderStreamProps(n, sec.body);
  body.append(sec.root);
  if (n.applied) body.append(renderDisplayProps(n));
  else body.append(el('p', { class: 'props-empty' }, 'Display settings appear after you click Apply.'));
  markChanged(n);
}

function renderCalcProps(n, body) {
  const pf = nodeFields(n.parent);
  const name = el('input', { type: 'text', value: n.edit.resultName, 'data-key': 'resultName', 'aria-label': 'Result Array Name' });
  name.addEventListener('input', () => setEdit(n, 'resultName', name.value));
  body.append(prow('Result Array Name', name));
  const expr = el('input', { type: 'text', class: 'expr', value: n.edit.expression, 'data-key': 'expression', placeholder: 'type an expression', 'aria-label': 'Expression', spellcheck: 'false', autocomplete: 'off' });
  const msg = el('p', { class: 'pnote', 'aria-live': 'polite' });
  const vars = new Map([...pf.values()].map((f) => [f.name, f.ncomp]));
  const validate = () => {
    if (!expr.value.trim()) { msg.className = 'pnote'; msg.textContent = 'Example: pressure/1333'; return; }
    try { compile(expr.value, vars); msg.className = 'pok'; msg.textContent = 'Looks good. Click Apply.'; expr.classList.remove('bad'); }
    catch (e) { msg.className = 'perr'; msg.textContent = e.message; expr.classList.add('bad'); }
  };
  expr.addEventListener('input', () => { setEdit(n, 'expression', expr.value); validate(); });
  const insert = (t) => {
    const s = expr.selectionStart ?? expr.value.length, e = expr.selectionEnd ?? s;
    expr.value = expr.value.slice(0, s) + t + expr.value.slice(e);
    expr.focus(); expr.setSelectionRange(s + t.length, s + t.length);
    setEdit(n, 'expression', expr.value); validate();
  };
  body.append(el('div', { class: 'prop full' }, expr), msg);
  const sc = el('select', { 'aria-label': 'Insert a scalar array' }, el('option', { value: '' }, 'Scalars'), [...pf.values()].filter((f) => f.ncomp === 1).map((f) => el('option', { value: f.name }, f.name)));
  const vc = el('select', { 'aria-label': 'Insert a vector array' }, el('option', { value: '' }, 'Vectors'), [...pf.values()].filter((f) => f.ncomp === 3).map((f) => el('option', { value: f.name }, f.name)));
  const quote = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s}"`);
  sc.addEventListener('change', () => { if (sc.value) insert(quote(sc.value)); sc.value = ''; });
  vc.addEventListener('change', () => { if (vc.value) insert(quote(vc.value)); vc.value = ''; });
  body.append(el('div', { class: 'trio', style: 'grid-template-columns:1fr 1fr' }, el('div', { class: 'prop full' }, sc), el('div', { class: 'prop full' }, vc)));
  validate();
}

function renderClipProps(n, body) {
  body.append(checkInput(n, 'showPlane', 'Show Plane'));
  const btns = el('div', { class: 'btnrow' });
  const setN = (v) => setEdit(n, 'normal', v);
  btns.append(el('button', { type: 'button', class: 'pbtn', title: 'Turn the plane to face you, so you see the cut side', onclick: () => {
    const v = S.views[n.model], d = v.camera.position.clone().sub(v.controls.target).normalize();
    setN([+d.x.toFixed(5), +d.y.toFixed(5), +d.z.toFixed(5)]);
  } }, 'Camera Normal'));
  btns.append(el('button', { type: 'button', class: 'pbtn', title: 'Move the origin back to the middle of the model', onclick: () => setEdit(n, 'origin', S.models[n.model].center.slice()) }, 'Reset to Center'));
  body.append(btns);
  // slider that slides the plane along its normal
  const m = S.models[n.model];
  const slide = el('input', { type: 'range', min: -1, max: 1, step: 0.002, value: 0, 'aria-label': 'Slide the plane along its normal' });
  let base = null;
  slide.addEventListener('pointerdown', () => { base = n.edit.origin.slice(); });
  slide.addEventListener('focus', () => { base = n.edit.origin.slice(); });
  slide.addEventListener('input', () => {
    if (!base) base = n.edit.origin.slice();
    const N = v3(n.edit.normal).normalize(), t = +slide.value * m.diag / 2;
    setEdit(n, 'origin', [0, 1, 2].map((i) => +(base[i] + N.getComponent(i) * t).toFixed(5)));
  });
  slide.addEventListener('change', () => { base = null; slide.value = 0; });
  body.append(prow('Slide plane', slide));
  body.append(el('p', { class: 'pnote' }, 'Drag the plane in the view to slide it, and drag the arrow tip to tilt it. Camera Normal turns the plane to face you, so you see the cut side.'));
}

function renderStreamProps(n, body) {
  body.append(el('p', { class: 'pnote' }, 'Streamlines start from random points inside the sphere and follow the velocity forward and backward.'));
  body.append(checkInput(n, 'showSphere', 'Show Sphere'));
  body.append(prow('Center', trio(n, 'center')));
  const pick = el('button', { type: 'button', class: 'pbtn', title: 'Then click on the model to put the sphere there (shortcut: P)' }, 'Pick on model (P)');
  pick.addEventListener('click', () => startPick(n));
  body.append(el('div', { class: 'btnrow' }, pick,
    el('button', { type: 'button', class: 'pbtn', onclick: () => setEdit(n, 'center', S.models[n.model].center.slice()) }, 'Reset to Center')));
  body.append(prow('Radius', numInput(n, 'radius')));
  body.append(prow('Number Of Points', numInput(n, 'numPoints', null, { int: true })));
  body.append(el('p', { class: 'pnote' }, 'Drag the sphere in the view to move it.'));
}

function renderDisplayProps(n) {
  const sec = psec(`Display (${n.type === 'stream' ? 'GeometryRepresentation' : 'UnstructuredGridRepresentation'})`);
  const d = n.display, b = sec.body;
  const repr = el('select', {}, ['Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Outline'].map((o) => el('option', {}, o)));
  repr.value = d.repr;
  repr.addEventListener('change', () => setDisplay(n, 'repr', repr.value));
  b.append(prow('Representation', repr));
  const col = el('select', {}, el('option', { value: '' }, 'Solid Color'), [...nodeFields(n).values()].map((f) => el('option', { value: f.name }, f.name)));
  col.value = d.colorBy || '';
  col.addEventListener('change', () => { setDisplay(n, 'colorBy', col.value || null); renderProps(); });
  b.append(prow('Coloring', col));
  const f = d.colorBy ? nodeFields(n).get(d.colorBy) : null;
  if (f) {
    const lut = getLut(f.name);
    if (f.ncomp === 3) {
      const comp = el('select', {}, ['Magnitude', 'X', 'Y', 'Z'].map((o) => el('option', {}, o)));
      comp.value = lut.comp;
      comp.addEventListener('change', () => { lut.comp = comp.value; if (!lut.locked) autoRange(f.name, true); refreshAllColors(); syncToolbar(); renderProps(); notify(); });
      b.append(prow('Component', comp));
    }
    const preset = el('select', {}, Object.keys(PRESETS).map((o) => el('option', {}, o)));
    preset.value = lut.preset;
    preset.addEventListener('change', () => { lut.preset = preset.value; refreshAllColors(); renderProps(); });
    b.append(prow('Color Map', el('div', {}, preset, el('div', { class: 'cbar', style: `background:${cssGradient(lut.preset, lut.invert, 'to right')};margin-top:4px` }))));
    const lo = el('input', { type: 'text', value: fmtInput(+lut.range[0].toPrecision(6)), 'aria-label': 'Range minimum' });
    const hi = el('input', { type: 'text', value: fmtInput(+lut.range[1].toPrecision(6)), 'aria-label': 'Range maximum' });
    const setRange = () => {
      const a = parseFloat(lo.value), c = parseFloat(hi.value);
      if (!Number.isFinite(a) || !Number.isFinite(c) || a >= c) { status('The minimum must be smaller than the maximum.', true); return; }
      lut.range = [a, c]; lut.locked = true; refreshAllColors(); notify();
    };
    lo.addEventListener('change', setRange); hi.addEventListener('change', setRange);
    b.append(prow('Range', el('div', { class: 'trio', style: 'grid-template-columns:1fr 1fr' }, lo, hi)));
    const btns = el('div', { class: 'btnrow' });
    btns.append(el('button', { type: 'button', class: 'pbtn', title: 'Fit the colors to the data of this item', onclick: () => {
      lut.range = nodeRange(n, f, compIndex(lut, f.ncomp)); lut.locked = true; refreshAllColors(); renderProps(); notify();
    } }, 'Rescale to Data Range'));
    btns.append(el('button', { type: 'button', class: 'pbtn', title: 'Fit the colors to everything shown', onclick: () => {
      lut.locked = false; autoRange(f.name, true); refreshAllColors(); renderProps(); notify();
    } }, 'Rescale to Visible'));
    btns.append(el('button', { type: 'button', class: 'pbtn' + (lut.invert ? ' on' : ''), 'aria-pressed': lut.invert ? 'true' : 'false', onclick: () => { lut.invert = !lut.invert; refreshAllColors(); renderProps(); } }, 'Invert'));
    b.append(btns);
    const leg = el('input', { type: 'checkbox', checked: lut.legend });
    leg.addEventListener('change', () => { lut.legend = leg.checked; renderLegends(); });
    b.append(el('label', { class: 'prop check' }, leg, el('span', {}, 'Show color legend')));
  } else {
    const sw = el('input', { type: 'color', class: 'swatch', value: d.solid, 'aria-label': 'Solid color' });
    sw.addEventListener('input', () => setDisplay(n, 'solid', sw.value));
    b.append(prow('Solid Color', sw));
  }
  const sty = psec('Styling');
  const op = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: d.opacity, 'aria-label': 'Opacity slider' });
  const opn = el('input', { type: 'text', inputmode: 'decimal', value: d.opacity, 'aria-label': 'Opacity' });
  op.addEventListener('input', () => { opn.value = op.value; setDisplay(n, 'opacity', +op.value); });
  opn.addEventListener('change', () => { const v = Math.min(1, Math.max(0, parseFloat(opn.value))); if (Number.isFinite(v)) { op.value = v; opn.value = v; setDisplay(n, 'opacity', v); } });
  sty.body.append(prow('Opacity', el('div', { class: 'slider' }, op, opn)));
  const ps = el('input', { type: 'text', inputmode: 'decimal', value: d.pointSize, 'aria-label': 'Point Size' });
  ps.addEventListener('change', () => { const v = parseFloat(ps.value); if (v > 0) setDisplay(n, 'pointSize', v); });
  sty.body.append(prow('Point Size', ps));
  const lw = el('input', { type: 'text', inputmode: 'decimal', value: d.lineWidth, 'aria-label': 'Line Width' });
  lw.addEventListener('change', () => { const v = parseFloat(lw.value); if (v > 0) setDisplay(n, 'lineWidth', v); });
  sty.body.append(prow('Line Width', lw));
  if (n.type === 'stream') {
    const tb = el('input', { type: 'checkbox', checked: d.tubes });
    tb.addEventListener('change', () => setDisplay(n, 'tubes', tb.checked));
    sty.body.append(el('label', { class: 'prop check' }, tb, el('span', {}, 'Render Lines As Tubes')));
  }
  const wrap = el('div');
  wrap.append(sec.root, sty.root);
  return wrap;
}

// ------------------------------------------------------------------ information tab
function renderInfo() {
  const body = $('#info-body');
  body.innerHTML = '';
  const n = S.selected;
  if (!n || !n.applied) { body.append(el('p', { class: 'props-empty' }, 'Apply an item to see information about its data.')); return; }
  const m = S.models[n.model], wrap = el('div', { class: 'info' });
  const stats = el('table');
  const row = (k, v) => stats.append(el('tr', {}, el('th', {}, k), el('td', {}, v)));
  let bounds = m.meta.bounds;
  if (n.type === 'stream') {
    const pts = n.actor.nverts;
    row('Type', 'Polygonal Mesh'); row('Number of Lines', String(n.out.lines.length)); row('Number of Points', pts.toLocaleString('en-US'));
    row('Seed points inside the aorta', `${n.out.lines.length} of ${n.out.nseeds}`);
    if (pts) {
      const c = n.actor.cache; bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < c.n; i++) for (const [j, k] of [[0, 'x'], [1, 'y'], [2, 'z']]) { bounds[j * 2] = Math.min(bounds[j * 2], c[k][i]); bounds[j * 2 + 1] = Math.max(bounds[j * 2 + 1], c[k][i]); }
    }
  } else {
    row('Type', 'Unstructured Grid');
    if (n.type === 'clip') { row('Number of Cells', '≈ ' + Math.round(m.meta.ncells * clipFraction(n)).toLocaleString('en-US')); row('Number of Points', '≈ ' + Math.round(m.meta.npoints * clipFraction(n)).toLocaleString('en-US')); }
    else { row('Number of Cells', m.meta.ncells.toLocaleString('en-US')); row('Number of Points', m.meta.npoints.toLocaleString('en-US')); }
  }
  wrap.append(el('div', {}, el('h3', {}, 'Data Statistics'), stats));
  const arr = el('table', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Data Ranges')));
  for (const f of nodeFields(n).values()) {
    let ranges;
    if (n.type === 'stream') ranges = (f.ncomp === 1 ? [0] : [0, 1, 2]).map((c) => nodeRange(n, f, c));
    else if (f.base) { const a = m.meta.arrays.find((x) => x.name === f.name); ranges = a.ranges.slice(0, f.ncomp); }
    else ranges = (f.ncomp === 1 ? [0] : [0, 1, 2]).map((c) => f.range(c));
    arr.append(el('tr', {}, el('td', {}, f.name), el('td', {}, 'double'), el('td', {}, ranges.map((r) => `[${fmt(r[0])}, ${fmt(r[1])}]`).join(', '))));
  }
  wrap.append(el('div', {}, el('h3', {}, 'Data Arrays'), arr));
  const bt = el('table');
  ['X', 'Y', 'Z'].forEach((a, i) => bt.append(el('tr', {}, el('th', {}, `${a} range`), el('td', {}, `${fmt(bounds[i * 2])} to ${fmt(bounds[i * 2 + 1])} (delta: ${fmt(bounds[i * 2 + 1] - bounds[i * 2])})`))));
  wrap.append(el('div', {}, el('h3', {}, 'Bounds (cm)'), bt));
  wrap.append(el('div', {}, el('h3', {}, 'Time'), el('p', { class: 'pnote' }, 'One saved moment of the simulation (time 0).')));
  body.append(wrap);
}
function clipFraction(node) {
  const m = S.models[node.model], G = m.grid, planes = clipChain(node).map((c) => clipPlane(c.props));
  let tot = 0, keep = 0; const P = new THREE.Vector3(), nxy = G.nx * G.ny;
  for (let n = 0; n < G.sdf.length; n += 7) {
    if (G.sdf[n] <= 0) continue;
    tot++;
    P.set(G.ox + (n % G.nx) * G.h, G.oy + (Math.floor(n / G.nx) % G.ny) * G.h, G.oz + Math.floor(n / nxy) * G.h);
    if (planes.every((p) => p.distanceToPoint(P) >= 0)) keep++;
  }
  return tot ? keep / tot : 1;
}

// ------------------------------------------------------------------ legends
function legendData(model) {
  const seen = new Map();
  for (const n of nodesOf(model)) {
    if (!n.applied || !n.visible || !n.display.colorBy) continue;
    const f = nodeFields(n).get(n.display.colorBy);
    if (!f || seen.has(f.name)) continue;
    const lut = getLut(f.name);
    if (!lut.legend) continue;
    seen.set(f.name, { f, lut });
  }
  return [...seen.values()];
}
const legendTitle = (f, lut) => (f.ncomp === 3 ? `${f.name} ${lut.comp}` : f.name);
function ticks(lo, hi) { return [0, 0.25, 0.5, 0.75, 1].map((t) => lo + (hi - lo) * t); }
function renderLegends() {
  for (const v of Object.values(S.views)) {
    const box = v.host.querySelector('.legend');
    box.innerHTML = '';
    for (const { f, lut } of legendData(v.name)) {
      const [lo, hi] = lut.range;
      const tk = el('div', { class: 'lticks' });
      for (const t of ticks(lo, hi)) tk.append(el('span', { style: `bottom:${((t - lo) / (hi - lo || 1)) * 100}%` }, fmt(t)));
      box.append(el('div', { class: 'lg' }, el('div', { class: 'lt' }, legendTitle(f, lut)), el('div', { class: 'lb', style: `background:${cssGradient(lut.preset, lut.invert)}` }), tk));
    }
  }
}

// ------------------------------------------------------------------ widgets (clip plane, seed sphere, seed line)
const WMAT = {
  // pushed back in depth so the cut face drawn on the same plane wins
  plane: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
  edge: new THREE.LineBasicMaterial({ color: 0xffffff }),
  handle: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  hot: new THREE.MeshBasicMaterial({ color: 0xffd34d }),
  sphere: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  pick: new THREE.MeshBasicMaterial({ visible: false }),
};
function updateWidgets() {
  for (const v of Object.values(S.views)) {
    for (const c of v.widgets.children) c.geometry && c.geometry.dispose();
    v.widgets.clear();
    v.needs = true;
  }
  const n = S.selected;
  if (!n || !S.models[n.model]) return;
  const v = S.views[n.model], m = S.models[n.model], E = n.edit;
  if (n.type === 'clip' && E.showPlane) {
    const { N, u, w } = basisFor(E.normal), o = v3(E.origin), s = m.diag * 0.42;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => o.clone().addScaledVector(u, a * s).addScaledVector(w, b * s));
    const g = new THREE.BufferGeometry().setFromPoints(corners);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const quad = new THREE.Mesh(g, WMAT.plane); quad.userData.handle = 'plane';
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), WMAT.edge);
    const len = m.diag * 0.3, tip = o.clone().addScaledVector(N, len);
    const shaft = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o, tip]), WMAT.edge);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(m.diag * 0.018, m.diag * 0.06, 16), WMAT.handle);
    cone.position.copy(tip); cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), N); cone.userData.handle = 'tip';
    const tipPick = new THREE.Mesh(new THREE.SphereGeometry(m.diag * 0.04, 12, 8), WMAT.pick); tipPick.position.copy(tip); tipPick.userData.handle = 'tip';
    const org = new THREE.Mesh(new THREE.SphereGeometry(m.diag * 0.012, 16, 10), WMAT.handle); org.position.copy(o); org.userData.handle = 'origin';
    v.widgets.add(quad, outline, shaft, cone, tipPick, org);
  }
  if (n.type === 'stream' && E.showSphere) {
    const sph = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 18, 10)), WMAT.sphere);
    sph.scale.setScalar(Math.max(1e-4, E.radius)); sph.position.set(...E.center);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), WMAT.pick);
    pick.scale.copy(sph.scale); pick.position.copy(sph.position); pick.userData.handle = 'sphere';
    v.widgets.add(sph, pick);
  }
}

const ray = new THREE.Raycaster();
function rayFrom(view, e) {
  const r = view.canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), view.camera);
  return ray;
}
let drag = null;
function onViewPointerDown(view, e) {
  if (e.button !== 0) return;
  const n = S.selected;
  if (S.pick && S.pick.node.model === view.name) {
    const hit = pickSurface(view, e);
    if (hit) {
      const R = S.pick.node.edit.radius || 0;
      const p = hit.point.clone().addScaledVector(rayFrom(view, e).ray.direction, R * 0.6);
      setEdit(S.pick.node, 'center', [p.x, p.y, p.z].map((x) => +x.toFixed(5)));
      status('Sphere moved. Click Apply to trace the streamlines.', false, 3500);
    } else status('Click on the model to place the sphere.', false, 3000);
    endPick(); e.stopImmediatePropagation(); e.preventDefault();
    return;
  }
  if (!n || n.model !== view.name || !view.widgets.children.length) return;
  const hits = rayFrom(view, e).intersectObjects(view.widgets.children, false).filter((h) => h.object.userData.handle);
  if (!hits.length) return;
  const order = { tip: 0, origin: 1, sphere: 2, plane: 3 };
  hits.sort((a, b) => order[a.object.userData.handle] - order[b.object.userData.handle] || a.distance - b.distance);
  const h = hits[0], handle = h.object.userData.handle;
  const camDir = view.camera.getWorldDirection(new THREE.Vector3());
  drag = { view, node: n, handle, start: h.point.clone() };
  if (handle === 'plane') { drag.o0 = v3(n.edit.origin); drag.N = v3(n.edit.normal).normalize(); drag.t0 = lineParam(ray.ray, drag.o0, drag.N); }
  else if (handle === 'origin') { drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v3(n.edit.normal).normalize(), v3(n.edit.origin)); }
  else if (handle === 'tip') { drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, h.point); }
  else if (handle === 'sphere') { drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, v3(n.edit.center)); drag.off = v3(n.edit.center).sub(h.point); }
  else { drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, h.point); }
  view.controls.enabled = false;
  view.canvas.setPointerCapture(e.pointerId);
  e.stopImmediatePropagation(); e.preventDefault();
  const up = () => { if (drag) drag.view.controls.enabled = true; drag = null; window.removeEventListener('pointerup', up); };
  window.addEventListener('pointerup', up);
}
/** Parameter t of the point on line (o + t·N) closest to the ray. */
function lineParam(r, o, N) {
  const w0 = o.clone().sub(r.origin), a = N.dot(N), b = N.dot(r.direction), c = r.direction.dot(r.direction), d = N.dot(w0), e = r.direction.dot(w0);
  const den = a * c - b * b;
  return Math.abs(den) < 1e-9 ? 0 : (b * e - c * d) / den;
}
const r5 = (p) => [p.x, p.y, p.z].map((x) => +x.toFixed(5));
function onViewPointerMove(view, e) {
  if (drag && drag.view === view) {
    const r = rayFrom(view, e).ray, n = drag.node, hit = new THREE.Vector3();
    if (drag.handle === 'plane') {
      const t = lineParam(r, drag.o0, drag.N);
      setEdit(n, 'origin', r5(drag.o0.clone().addScaledVector(drag.N, t - drag.t0)));
    } else if (r.intersectPlane(drag.plane, hit)) {
      if (drag.handle === 'origin') setEdit(n, 'origin', r5(hit));
      else if (drag.handle === 'tip') { const d = hit.sub(v3(n.edit.origin)); if (d.lengthSq() > 1e-8) setEdit(n, 'normal', r5(d.normalize())); }
      else if (drag.handle === 'sphere') setEdit(n, 'center', r5(hit.add(drag.off)));
    }
    return;
  }
  if (S.probe) probeAt(view, e);
}

function startPick(node) { S.pick = { node }; status('Click on the model to place the seed sphere there.'); for (const v of Object.values(S.views)) v.canvas.style.cursor = 'crosshair'; }
function endPick() { S.pick = null; for (const v of Object.values(S.views)) v.canvas.style.cursor = ''; }

/** Nearest visible surface hit that is not clipped away. */
function pickSurface(view, e) {
  const r = rayFrom(view, e);
  let best = null;
  for (const n of nodesOf(view.name)) {
    if (!n.applied || !n.visible || !n.actor || !n.actor.pickables) continue;
    for (const obj of n.actor.pickables()) {
      if (!obj.visible) continue;
      for (const h of r.intersectObject(obj, false)) {
        const planes = obj.material.clippingPlanes || [];
        if (planes.some((p) => p.distanceToPoint(h.point) < 0)) continue;
        if (obj.userData.cap) {
          const rec = {}; if (sampleGrid(S.models[n.model].grid, h.point.x, h.point.y, h.point.z, rec) < 0) continue;
        }
        if (!best || h.distance < best.distance) best = { ...h, node: n };
        break;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ hover probe
let probeRaf = 0;
function probeAt(view, e) {
  if (probeRaf) return;
  probeRaf = requestAnimationFrame(() => {
    probeRaf = 0;
    const hit = pickSurface(view, e);
    if (!hit) { hideTooltip(); return; }
    const n = hit.node, m = S.models[n.model], fields = nodeFields(n);
    const rows = [];
    let vals;
    if (hit.object.userData.cap) {
      const rec = {}; sampleGrid(m.grid, hit.point.x, hit.point.y, hit.point.z, rec);
      vals = (f) => f.at(rec);
    } else {
      const f3 = hit.face, P = m.surf.positions;
      const tri = new THREE.Triangle(v3(P.subarray(f3.a * 3)), v3(P.subarray(f3.b * 3)), v3(P.subarray(f3.c * 3)));
      const bc = tri.getBarycoord(hit.point, new THREE.Vector3());
      vals = (f) => {
        const s = f.surface(), k = f.ncomp, out = [0, 0, 0];
        for (let c = 0; c < k; c++) out[c] = s[f3.a * k + c] * bc.x + s[f3.b * k + c] * bc.y + s[f3.c * k + c] * bc.z;
        return k === 1 ? out[0] : out;
      };
    }
    for (const f of fields.values()) {
      const v = vals(f);
      const unit = f.base ? UNITS[f.name] || '' : '';
      if (f.ncomp === 1) rows.push([f.name, `${fmt(v)} ${unit}`]);
      else rows.push([`${f.name} (size)`, `${fmt(Math.hypot(v[0], v[1], v[2]))} ${unit}`]);
    }
    const tt = $('#tooltip');
    tt.innerHTML = '';
    tt.append(el('div', { class: 'tt-src' }, `${n.name} · ${hit.object.userData.cap ? 'inside (cut face)' : 'surface'}`));
    const tb = el('table');
    for (const [k, v] of rows) tb.append(el('tr', {}, el('td', {}, k), el('td', {}, el('b', {}, v))));
    tt.append(tb);
    const host = $('#views').getBoundingClientRect();
    tt.style.display = 'block';
    const x = e.clientX - host.left + 14, y = e.clientY - host.top + 14;
    tt.style.left = Math.min(x, host.width - tt.offsetWidth - 6) + 'px';
    tt.style.top = Math.min(y, host.height - tt.offsetHeight - 6) + 'px';
  });
}
function hideTooltip() { $('#tooltip').style.display = 'none'; }

// ------------------------------------------------------------------ inlet marker (worksheet hint)
function flashInlet() {
  let shown = 0;
  for (const v of Object.values(S.views)) {
    const m = S.models[v.name];
    if (!m || !nodesOf(v.name).some((n) => n.applied)) continue;
    const cap = m.meta.caps.find((c) => c.role === 'inlet');
    const ring = new THREE.Mesh(new THREE.TorusGeometry(cap.radius * 1.25, cap.radius * 0.12, 12, 48), new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true }));
    ring.position.set(...cap.center);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v3(cap.normal).normalize());
    ring.renderOrder = 10;
    v.marks.add(ring);
    shown++;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      ring.material.opacity = 0.55 + 0.45 * Math.sin(t * 6);
      v.needs = true;
      if (t < 4) requestAnimationFrame(tick); else { ring.removeFromParent(); ring.geometry.dispose(); v.needs = true; }
    };
    tick();
  }
  if (!shown) status('Open and apply the files first.', true);
  else status('The inlet is where blood enters from the heart (yellow ring).', false, 4000);
}
function inletSeed(model) {
  const cap = S.models[model].meta.caps.find((c) => c.role === 'inlet');
  const N = v3(cap.normal).normalize(), c = v3(cap.center).addScaledVector(N, cap.radius * 0.45);
  return { center: r5(c), radius: +(cap.radius * 0.95).toFixed(4) };
}

// ------------------------------------------------------------------ screenshot
function screenshot() {
  const views = Object.values(S.views).filter((v) => v.host.offsetParent !== null && v.w);
  if (!views.length) return;
  const dpr = views[0].renderer.getPixelRatio(), gap = 4 * dpr;
  const W = views.reduce((s, v) => s + v.canvas.width, 0) + gap * (views.length - 1), H = Math.max(...views.map((v) => v.canvas.height));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  let x = 0;
  for (const v of views) {
    v.widgets.visible = false; v.render(); v.widgets.visible = true; v.needs = true;
    const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#5a5f78'); grd.addColorStop(1, '#464b62');
    g.fillStyle = grd; g.fillRect(x, 0, v.canvas.width, H);
    g.drawImage(v.canvas, x, 0);
    g.fillStyle = '#fff'; g.font = `600 ${13 * dpr}px sans-serif`; g.fillText(`${v.name}.vtu`, x + 12 * dpr, 22 * dpr);
    let ly = Math.round(H / 2 - 100 * dpr);
    for (const { f, lut } of legendData(v.name)) {
      const bx = Math.round(x + v.canvas.width - 90 * dpr), bh = Math.round(170 * dpr), T = lutTable(lut.preset, lut.invert);
      g.fillStyle = '#fff'; g.font = `600 ${12 * dpr}px sans-serif`; g.fillText(legendTitle(f, lut), bx - 40 * dpr, ly - 8 * dpr);
      for (let i = 0; i < bh; i++) {
        const k = Math.round((1 - i / bh) * 255) * 3;
        g.fillStyle = `rgb(${Math.round(T[k] * 255)},${Math.round(T[k + 1] * 255)},${Math.round(T[k + 2] * 255)})`; g.fillRect(bx, ly + i, Math.round(14 * dpr), 1);
      }
      g.font = `${12 * dpr}px sans-serif`; g.fillStyle = '#fff';
      const [lo, hi] = lut.range;
      for (const t of ticks(lo, hi)) g.fillText(fmt(t), bx + 20 * dpr, ly + bh - ((t - lo) / (hi - lo || 1)) * bh + 4 * dpr);
      ly += bh + 50 * dpr;
    }
    x += v.canvas.width + gap;
  }
  cv.toBlob((b) => {
    const a = el('a', { href: URL.createObjectURL(b), download: 'aorta-view.png' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

// ------------------------------------------------------------------ opening files
function openFiles(names) {
  let last = null;
  for (const name of names) {
    if (S.nodes.some((n) => n.type === 'source' && n.model === name)) { status(`${name}.vtu is already open.`, false, 3000); continue; }
    if (S.models[name]) S.views[name].host.querySelector('.empty').innerHTML = 'Click <b>Apply</b> to show the model.';
    else if (!S.loading[name]) {
      const host = S.views[name].host.querySelector('.empty');
      host.innerHTML = `<div>Reading ${name}.vtu…<div class="bar"><i></i></div></div>`;
      S.loading[name] = loadModel(DATA, name, (f) => { const b = host.querySelector('.bar i'); if (b) b.style.width = `${Math.round(f * 100)}%`; })
        .then((m) => { S.models[name] = m; host.innerHTML = 'Click <b>Apply</b> to show the model.'; renderProps(); return m; })
        .catch((e) => { host.textContent = `Could not read ${name}.vtu: ${e.message}`; delete S.loading[name]; throw e; });
      S.loading[name].catch(() => {});
    }
    last = createNode('source', name, null);
  }
  if (last) { S.selected = last; setActiveView(last.model); status('Files opened. Click the green Apply button to show them.', false, 5000); }
  afterChange(true);
}

function addFilter(type) {
  const p = S.selected;
  if (!p || !p.applied || !isSurfaceType(p)) return;
  if (type === 'stream' && !nodeFields(p).has(STREAM_FIXED.vectors)) { status('Stream Tracer needs the velocity array.', true); return; }
  const n = createNode(type, p.model, p);
  S.selected = n;
  status(`${n.name} added. Set its properties, then click Apply.`, false, 4000);
  afterChange(true);
}

// ------------------------------------------------------------------ wiring
function refitAfterLayout() {
  requestAnimationFrame(() => { for (const v of Object.values(S.views)) { v.resize(); v.resetCamera(); } });
}
function init() {
  for (const name of MODEL_NAMES) S.views[name] = new View(name, $(`#view-${name}`));
  S.views.healthy.host.classList.add('active');
  requestAnimationFrame(frame);

  const dlg = $('#open-dialog');
  $('#btn-open').addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const names = [...dlg.querySelectorAll('input[name=f]:checked')].map((i) => i.value);
    if (names.length) openFiles(names);
  });
  $('#btn-shot').addEventListener('click', screenshot);
  $('#btn-apply').addEventListener('click', applyAll);
  $('#btn-resetprops').addEventListener('click', () => S.selected && resetEdits(S.selected));
  $('#btn-delete').addEventListener('click', () => S.selected && deleteNode(S.selected));
  $('#btn-calc').addEventListener('click', () => addFilter('calculator'));
  $('#btn-clip').addEventListener('click', () => addFilter('clip'));
  $('#btn-stream').addEventListener('click', () => addFilter('stream'));
  $('#sel-color').addEventListener('change', (e) => { if (S.selected) { setDisplay(S.selected, 'colorBy', e.target.value || null); renderProps(); } });
  $('#sel-comp').addEventListener('change', (e) => {
    const n = S.selected; if (!n || !n.display.colorBy) return;
    const lut = getLut(n.display.colorBy); lut.comp = e.target.value; if (!lut.locked) autoRange(lut.name, true); refreshAllColors(); renderProps(); notify();
  });
  $('#btn-reset').addEventListener('click', () => { for (const v of camTargets()) v.resetCamera(); });
  for (const b of document.querySelectorAll('.tb.ax')) b.addEventListener('click', () => setViewDirection(b.dataset.view));
  $('#chk-link').addEventListener('change', (e) => { S.link = e.target.checked; if (S.link) syncCameras(S.views[S.activeView]); });
  $('#chk-auto').addEventListener('change', (e) => { S.autoApply = e.target.checked; if (S.autoApply) applyAll(); });
  $('#btn-probe').addEventListener('click', (e) => {
    S.probe = !S.probe; e.currentTarget.setAttribute('aria-pressed', S.probe); if (!S.probe) hideTooltip();
    if (S.probe) status('Move the mouse over a model to read its values.', false, 3500);
  });
  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => {
    S.layout = b.dataset.layout;
    for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-checked', x === b);
    $('#views').dataset.layout = S.layout;
    if (S.layout !== 'split') setActiveView(S.layout);
    refitAfterLayout();
  });
  const app = $('#app'), lb = $('#btn-lesson');
  lb.addEventListener('click', () => {
    const wide = window.matchMedia('(min-width: 1241px)').matches;
    const open = wide ? app.classList.contains('lesson-closed') : !app.classList.contains('lesson-open');
    app.classList.toggle('lesson-closed', !open); app.classList.toggle('lesson-open', open);
    lb.setAttribute('aria-expanded', open);
    refitAfterLayout();
  });
  for (const [tab, panel] of [['#tab-props', '#props-body'], ['#tab-info', '#info-body']]) {
    $(tab).addEventListener('click', () => {
      for (const [t, p] of [['#tab-props', '#props-body'], ['#tab-info', '#info-body']]) { $(t).setAttribute('aria-selected', t === tab); $(p).hidden = p !== panel; }
      if (tab === '#tab-info') renderInfo();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Escape' && S.pick) { endPick(); hideStatus(); }
    if ((e.key === 'p' || e.key === 'P') && S.selected && S.selected.type === 'stream') startPick(S.selected);
  });

  afterChange(true);
  initLesson($('#lesson'), api);
}

// API used by the worksheet panel (and handy from the console for testing)
const api = {
  S, nodesOf, fmt, onChange: (f) => listeners.add(f), select: selectNode, setEdit, flashInlet, inletSeed, status,
  fields: nodeFields, applyAll, openFiles,
  cameraPos: (model) => S.views[model].camera.position.toArray(),
  toScreen(model, p) {
    const v = S.views[model], q = v3(p).project(v.camera), r = v.canvas.getBoundingClientRect();
    return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
  },
  archPlane: (model) => S.models[model] && S.models[model].meta.arch_plane,
  sampleCalc(node) {
    // compare the calculator result with pressure/1333 at a few surface points
    if (!node.out || !node.out.field || node.out.field.ncomp !== 1) return null;
    const s = node.out.field.surface(), p = nodeFields(node.parent).get('pressure');
    if (!p) return null;
    const ps = p.surface(), idx = [0, Math.floor(s.length / 3), Math.floor(s.length / 2), s.length - 1];
    return idx.map((i) => s[i] / (ps[i] / 1333));
  },
};
window.aortaLab = api;
init();
