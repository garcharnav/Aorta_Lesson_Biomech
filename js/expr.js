// A small, safe expression parser for the Calculator filter (ParaView-style syntax).
// Values are numbers or 3-component vectors ([x, y, z]); arithmetic broadcasts scalars over vectors.

export class ExprError extends Error {
  constructor(message, pos) { super(message); this.pos = pos; }
}

const FUNCS1 = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, ceil: Math.ceil, floor: Math.floor,
};
const FUNCS2 = { min: Math.min, max: Math.max, pow: Math.pow };
const VEC_FUNCS = ['mag', 'norm', 'dot', 'cross'];
export const FUNCTION_NAMES = [...VEC_FUNCS, ...Object.keys(FUNCS1), ...Object.keys(FUNCS2)];

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`"${c}" is not a valid number`, i);
      toks.push({ t: 'num', v: parseFloat(m[0]), pos: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0], pos: i }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new ExprError('A quoted array name is missing its closing quote', i);
      toks.push({ t: 'id', v: src.slice(i + 1, j), pos: i, quoted: true }); i = j + 1; continue;
    }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: c, pos: i }); i++; continue; }
    throw new ExprError(`"${c}" can't be used in an expression`, i);
  }
  toks.push({ t: 'end', pos: src.length });
  return toks;
}

function parse(src) {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const take = (t) => {
    if (toks[k].t !== t) throw new ExprError(t === ')' ? 'A closing bracket ")" is missing' : `Expected "${t}"`, toks[k].pos);
    return toks[k++];
  };
  function expr() {
    let a = term();
    while (peek().t === '+' || peek().t === '-') { const op = toks[k++].t; a = { k: 'bin', op, a, b: term() }; }
    return a;
  }
  function term() {
    let a = unary();
    while (peek().t === '*' || peek().t === '/') { const op = toks[k++].t; a = { k: 'bin', op, a, b: unary() }; }
    return a;
  }
  function unary() {
    if (peek().t === '-') { k++; return { k: 'neg', a: unary() }; }
    if (peek().t === '+') { k++; return unary(); }
    return power();
  }
  function power() {
    const a = primary();
    if (peek().t === '^') { k++; return { k: 'bin', op: '^', a, b: unary() }; }
    return a;
  }
  function primary() {
    const tok = peek();
    if (tok.t === 'num') { k++; return { k: 'num', v: tok.v }; }
    if (tok.t === '(') { k++; const e = expr(); take(')'); return e; }
    if (tok.t === 'id') {
      k++;
      if (!tok.quoted && peek().t === '(') {
        k++;
        const args = [];
        if (peek().t !== ')') { args.push(expr()); while (peek().t === ',') { k++; args.push(expr()); } }
        take(')');
        return { k: 'call', name: tok.v, args, pos: tok.pos };
      }
      return { k: 'var', name: tok.v, pos: tok.pos };
    }
    if (tok.t === 'end') throw new ExprError('The expression ends too early', tok.pos);
    throw new ExprError(`Unexpected "${tok.t}"`, tok.pos);
  }
  if (peek().t === 'end') throw new ExprError('Type an expression, for example pressure/1333', 0);
  const e = expr();
  if (peek().t !== 'end') throw new ExprError(`Unexpected "${peek().t === 'id' || peek().t === 'num' ? peek().v : peek().t}" — is an operator missing?`, peek().pos);
  return e;
}

const isVec = (v) => Array.isArray(v);
function binop(op, a, b) {
  const f = op === '+' ? (x, y) => x + y : op === '-' ? (x, y) => x - y : op === '*' ? (x, y) => x * y
    : op === '/' ? (x, y) => x / y : (x, y) => Math.pow(x, y);
  if (!isVec(a) && !isVec(b)) return f(a, b);
  const A = isVec(a) ? a : [a, a, a], B = isVec(b) ? b : [b, b, b];
  return [f(A[0], B[0]), f(A[1], B[1]), f(A[2], B[2])];
}

/**
 * Compile an expression against the available arrays.
 * vars: Map name -> ncomp (1 or 3). The compiled function takes an env object
 * { get(name) -> number | [x,y,z] } and returns number or [x,y,z].
 */
export function compile(src, vars) {
  const ast = parse(src);
  const used = new Set();
  function resolveVar(name, pos) {
    if (vars.has(name)) { used.add(name); return (env) => env.get(name); }
    const m = /^(.*)_([XYZ])$/.exec(name);
    if (m && vars.get(m[1]) === 3) {
      used.add(m[1]); const c = 'XYZ'.indexOf(m[2]);
      return (env) => env.get(m[1])[c];
    }
    if (name === 'coordsX' || name === 'coordsY' || name === 'coordsZ') {
      const c = 'XYZ'.indexOf(name[6]); used.add('coords');
      return (env) => env.get('coords')[c];
    }
    if (name === 'coords') { used.add('coords'); return (env) => env.get('coords'); }
    if (name === 'iHat') return () => [1, 0, 0];
    if (name === 'jHat') return () => [0, 1, 0];
    if (name === 'kHat') return () => [0, 0, 1];
    const lower = name.toLowerCase();
    const near = [...vars.keys()].find((v) => v.toLowerCase() === lower || v.toLowerCase().startsWith(lower));
    if (near) throw new ExprError(`There is no array called "${name}". Did you mean "${near}"? Names must match exactly, including capital letters.`, pos);
    if (FUNCTION_NAMES.includes(name)) throw new ExprError(`"${name}" is a function; add brackets, like ${name}(velocity)`, pos);
    throw new ExprError(`There is no array called "${name}". Pick one from the Scalars or Vectors lists.`, pos);
  }
  function gen(n) {
    switch (n.k) {
      case 'num': { const v = n.v; return () => v; }
      case 'var': return resolveVar(n.name, n.pos);
      case 'neg': { const a = gen(n.a); return (e) => { const v = a(e); return isVec(v) ? [-v[0], -v[1], -v[2]] : -v; }; }
      case 'bin': { const a = gen(n.a), b = gen(n.b), op = n.op; return (e) => binop(op, a(e), b(e)); }
      case 'call': {
        const args = n.args.map(gen), name = n.name, nargs = n.args.length;
        const need = (cnt) => { if (nargs !== cnt) throw new ExprError(`${name}() needs ${cnt} value${cnt > 1 ? 's' : ''} inside the brackets`, n.pos); };
        if (name === 'mag') { need(1); const a = args[0]; return (e) => { const v = a(e); return isVec(v) ? Math.hypot(v[0], v[1], v[2]) : Math.abs(v); }; }
        if (name === 'norm') { need(1); const a = args[0]; return (e) => { const v = a(e); if (!isVec(v)) return Math.sign(v); const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }; }
        if (name === 'dot') { need(2); const [a, b] = args; return (e) => { const u = a(e), v = b(e); return isVec(u) && isVec(v) ? u[0] * v[0] + u[1] * v[1] + u[2] * v[2] : NaN; }; }
        if (name === 'cross') { need(2); const [a, b] = args; return (e) => { const u = a(e), v = b(e); if (!isVec(u) || !isVec(v)) return NaN; return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; }; }
        if (FUNCS1[name]) { need(1); const f = FUNCS1[name], a = args[0]; return (e) => { const v = a(e); return isVec(v) ? v.map(f) : f(v); }; }
        if (FUNCS2[name]) { need(2); const f = FUNCS2[name], [a, b] = args; return (e) => { const u = a(e), v = b(e); return isVec(u) || isVec(v) ? NaN : f(u, v); }; }
        throw new ExprError(`"${name}" is not a function the Calculator knows`, n.pos);
      }
    }
    throw new ExprError('Could not read the expression', 0);
  }
  const fn = gen(ast);
  return { fn, used };
}
