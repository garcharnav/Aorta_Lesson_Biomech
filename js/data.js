// Loading the pre-processed aorta data and sampling the volume solution.

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  let buf;
  if (res.body && onProgress) {
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(got, total);
    }
    buf = new Uint8Array(got); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
  } else buf = new Uint8Array(await res.arrayBuffer());
  // Some servers decompress .gz on the fly (Content-Encoding); only inflate if the gzip magic is present.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    buf = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return buf.buffer;
}

function dequant(u16, ncomp, lo, hi) {
  const n = u16.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % ncomp;
    out[i] = lo[c] + (u16[i] / 65535) * (hi[c] - lo[c]);
  }
  return out;
}

/** Load one model (meta, surface, grid). onProgress(fraction) is called as bytes arrive. */
export async function loadModel(base, name, onProgress = () => {}) {
  const meta = await (await fetch(`${base}/${name}/meta.json`)).json();
  const prog = { s: 0, g: 0 };
  const report = () => onProgress(Math.min(1, 0.4 * prog.s + 0.6 * prog.g));
  const [sbuf, gbuf] = await Promise.all([
    fetchBytes(`${base}/${name}/surface.bin.gz`, (a, t) => { prog.s = t ? a / t : 0.5; report(); }),
    fetchBytes(`${base}/${name}/grid.bin.gz`, (a, t) => { prog.g = t ? a / t : 0.5; report(); }),
  ]);

  // ---- surface ----
  const sm = meta.surface;
  let o = 0;
  const positions = new Float32Array(sbuf, o, sm.nverts * 3); o += sm.nverts * 12;
  const index = new Uint32Array(sbuf, o, sm.ntris * 3); o += sm.ntris * 12;
  const arrays = {};
  for (const a of sm.arrays) {
    const n = sm.nverts * a.ncomp;
    arrays[a.name] = dequant(new Uint16Array(sbuf.slice(o, o + n * 2)), a.ncomp, a.lo, a.hi);
    o += n * 2;
  }

  // ---- grid ----
  const g = meta.grid, [nx, ny, nz] = g.dims, N = nx * ny * nz, na = g.nactive;
  const sdf = new Int8Array(gbuf, 0, N);
  const idx = new Int32Array(N).fill(-1);
  let k = 0;
  for (let i = 0; i < N; i++) if (sdf[i] > -64) idx[i] = k++;
  if (k !== na) console.warn(`active voxel count ${k} != ${na}`);
  o = N;
  const ch = {};
  for (const c of g.channels) {
    const src = c.type === 'int16' ? new Int16Array(gbuf.slice(o, o + na * 2)) : new Uint16Array(gbuf.slice(o, o + na * 2));
    o += na * 2;
    const out = new Float32Array(na);
    for (let i = 0; i < na; i++) out[i] = src[i] * c.scale + c.offset;
    ch[c.name] = out;
  }
  const grid = {
    nx, ny, nz, h: g.h, ox: g.origin[0], oy: g.origin[1], oz: g.origin[2], sdf, idx,
    vx: ch.velocity0, vy: ch.velocity1, vz: ch.velocity2,
    p: ch.pressure, ap: ch.average_pressure, as: ch.average_speed,
  };
  const b = meta.bounds;
  const center = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const diag = Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
  return { name, meta, surf: { positions, index, arrays, nverts: sm.nverts }, grid, center, diag };
}

/**
 * Trilinear sample of the volume solution at (x, y, z).
 * Writes into rec: sdf (cm, >0 inside the fluid), vx, vy, vz, p, ap, as. Returns rec.sdf.
 */
export function sampleGrid(G, x, y, z, rec) {
  const fx = (x - G.ox) / G.h, fy = (y - G.oy) / G.h, fz = (z - G.oz) / G.h;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  rec.x = x; rec.y = y; rec.z = z;
  if (i < 0 || j < 0 || k < 0 || i >= G.nx - 1 || j >= G.ny - 1 || k >= G.nz - 1) {
    rec.sdf = -1; rec.vx = rec.vy = rec.vz = rec.p = rec.ap = rec.as = 0; return -1;
  }
  const u = fx - i, v = fy - j, w = fz - k;
  const sx = 1, sy = G.nx, sz = G.nx * G.ny;
  const base = i + j * sy + k * sz;
  let sdf = 0, vx = 0, vy = 0, vz = 0, p = 0, ap = 0, as = 0, wsum = 0;
  for (let c = 0; c < 8; c++) {
    const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
    const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
    const n = base + di * sx + dj * sy + dk * sz;
    sdf += wt * G.sdf[n];
    const a = G.idx[n];
    if (a >= 0) {
      vx += wt * G.vx[a]; vy += wt * G.vy[a]; vz += wt * G.vz[a];
      p += wt * G.p[a]; ap += wt * G.ap[a]; as += wt * G.as[a]; wsum += wt;
    }
  }
  rec.sdf = sdf * G.h / 32;
  rec.vx = vx; rec.vy = vy; rec.vz = vz; rec.as = as;
  // pressure is filled outside the wall, so normalise over the corners that carry data
  rec.p = wsum > 0 ? p / wsum : 0; rec.ap = wsum > 0 ? ap / wsum : 0;
  return rec.sdf;
}

/** Fast velocity-only sample used by the stream tracer. out = [vx, vy, vz]; returns sdf or -1 outside. */
export function sampleVel(G, x, y, z, out) {
  const fx = (x - G.ox) / G.h, fy = (y - G.oy) / G.h, fz = (z - G.oz) / G.h;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  if (i < 0 || j < 0 || k < 0 || i >= G.nx - 1 || j >= G.ny - 1 || k >= G.nz - 1) return -1;
  const u = fx - i, v = fy - j, w = fz - k;
  const sy = G.nx, sz = G.nx * G.ny, base = i + j * sy + k * sz;
  let sdf = 0, vx = 0, vy = 0, vz = 0;
  for (let c = 0; c < 8; c++) {
    const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
    const wt = (di ? u : 1 - u) * (dj ? v : 1 - v) * (dk ? w : 1 - w);
    const n = base + di + dj * sy + dk * sz;
    sdf += wt * G.sdf[n];
    const a = G.idx[n];
    if (a >= 0) { vx += wt * G.vx[a]; vy += wt * G.vy[a]; vz += wt * G.vz[a]; }
  }
  out[0] = vx; out[1] = vy; out[2] = vz;
  return sdf * G.h / 32;
}

/** Deterministic pseudo-random numbers (mulberry32) so a given seed cloud is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Trace streamlines through the velocity field (RK4 on the unit direction field, both directions).
 * seeds: array of [x,y,z]; opts: { maxLength, maxSteps, step, terminalSpeed, direction, planes }
 * planes: list of {n:[...], d} half-spaces that must satisfy n·x + d >= 0 (from upstream clips).
 * Returns array of polylines, each a Float32Array of xyz.
 */
export function traceStreamlines(G, seeds, opts) {
  const { maxLength, maxSteps, step, terminalSpeed, direction, planes } = opts;
  const v = [0, 0, 0];
  const inside = (x, y, z) => {
    for (const pl of planes) if (pl.n[0] * x + pl.n[1] * y + pl.n[2] * z + pl.d < 0) return false;
    return true;
  };
  const dirAt = (x, y, z, out) => {
    const s = sampleVel(G, x, y, z, v);
    if (s < 0 || !inside(x, y, z)) return false;
    const m = Math.hypot(v[0], v[1], v[2]);
    if (m <= terminalSpeed) return false;
    out[0] = v[0] / m; out[1] = v[1] / m; out[2] = v[2] / m;
    return true;
  };
  const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];
  function half(x0, y0, z0, sgn) {
    const pts = [];
    let x = x0, y = y0, z = z0, len = 0;
    const hs = step * sgn;
    for (let n = 0; n < maxSteps && len < maxLength; n++) {
      if (!dirAt(x, y, z, k1)) break;
      if (!dirAt(x + 0.5 * hs * k1[0], y + 0.5 * hs * k1[1], z + 0.5 * hs * k1[2], k2)) break;
      if (!dirAt(x + 0.5 * hs * k2[0], y + 0.5 * hs * k2[1], z + 0.5 * hs * k2[2], k3)) break;
      if (!dirAt(x + hs * k3[0], y + hs * k3[1], z + hs * k3[2], k4)) break;
      const nx = x + hs / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      const ny = y + hs / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      const nz = z + hs / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
      if (sampleVel(G, nx, ny, nz, v) < 0 || !inside(nx, ny, nz)) break;
      x = nx; y = ny; z = nz; len += step;
      pts.push(x, y, z);
    }
    return pts;
  }
  const lines = [];
  for (const s of seeds) {
    if (sampleVel(G, s[0], s[1], s[2], v) < 0 || !inside(s[0], s[1], s[2])) continue;
    const fwd = direction !== 'BACKWARD' ? half(s[0], s[1], s[2], 1) : [];
    const bwd = direction !== 'FORWARD' ? half(s[0], s[1], s[2], -1) : [];
    const n = bwd.length / 3 + 1 + fwd.length / 3;
    if (n < 2) continue;
    const out = new Float32Array(n * 3);
    let o = 0;
    for (let i = bwd.length / 3 - 1; i >= 0; i--) { out[o++] = bwd[i * 3]; out[o++] = bwd[i * 3 + 1]; out[o++] = bwd[i * 3 + 2]; }
    out[o++] = s[0]; out[o++] = s[1]; out[o++] = s[2];
    out.set(fwd, o);
    lines.push(out);
  }
  return lines;
}
