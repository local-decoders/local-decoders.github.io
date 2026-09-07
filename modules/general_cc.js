// General translation-invariant stabilizer code -- code-capacity CA decoder.
//
// A literal JS port of anim/general_cc.py (Haah's polynomial formalism: the
// saturation-via-elimination construction, Buchberger's algorithm for F2
// submodules, preimage search, and the paper's parallelized-division CA
// rule, main.tex "General translation-invariant stabilizer codes",
// 6771-6926). Read anim/general_cc.py's module docstring first -- it has
// the full mathematical derivation and the documented reader's-choice
// design decisions (cyclic epoch schedule, global step counter, periodic
// boundary conditions, the torus-native logical check) this file follows
// exactly. This module recomputes the ENTIRE algebra pipeline from the
// code-spec text every time initializeRandomErrors() sees a new spec
// (cached by spec string, see compileCodeCached below) -- there is no
// precomputed table to fall back on, unlike every other decoder module on
// this site.
//
// Representation notes (mirroring the Python reference exactly):
//   - A "monomial" is a D-tuple (or D+1 during the saturation's temporary
//     extra `t` coordinate) of integers, represented here as a plain JS
//     array for arithmetic and as a comma-joined string ("1,-2,0") as a
//     Set/Map key (JS has no native tuple hashing).
//   - A "polynomial" (element of S or R) is a Set of such monomial-key
//     strings -- since coefficients are in F2, a polynomial *is* the set
//     of its present monomials, and addition is symmetric difference.
//   - A "vector" (element of a free module) is a plain array of
//     polynomials, one per component.
// Exact rational arithmetic (needed for the Phi weight order) is done
// with BigInt numerators over one shared fixed denominator (1e9), so
// comparisons are exact integer comparisons -- see PhiOrder below.
//
// checkLogicalError() note: computing it is a full F2 linear-algebra
// solve over the whole L^D torus (see isStabilizerOnTorus), not the O(L)
// lookup every other decoder's checkLogicalError() is. It is fast enough
// to call after every step() for this site's default sizes, but callers
// that render every animation frame should avoid calling it on every
// render() -- this class memoizes it internally (invalidated by step(),
// stepUncoord(), and initializeRandomErrors()) for exactly that reason.

// =====================================================================
// Low-level F2 polynomial / free-module arithmetic.
// =====================================================================

function monoKey(u) { return u.join(','); }
function parseMono(key) { return key.split(',').map(Number); }

function monoAdd(u, v) { return u.map((x, i) => x + v[i]); }
function monoSub(u, v) { return u.map((x, i) => x - v[i]); }
function monoLcm(u, v) { return u.map((x, i) => Math.max(x, v[i])); }
function monoDivides(v, u) { return v.every((x, i) => x <= u[i]); }

function polyAdd(a, b) {
    const result = new Set(a);
    for (const k of b) {
        if (result.has(k)) result.delete(k); else result.add(k);
    }
    return result;
}

function polyTranslate(a, w) {
    if (a.size === 0) return new Set();
    const result = new Set();
    for (const k of a) result.add(monoKey(monoAdd(parseMono(k), w)));
    return result;
}

function antipode(a) {
    const result = new Set();
    for (const k of a) result.add(monoKey(parseMono(k).map((x) => -x)));
    return result;
}

function vecAdd(f, g) { return f.map((fc, i) => polyAdd(fc, g[i])); }
function vecTranslate(f, w) { return f.map((fc) => polyTranslate(fc, w)); }
function vecIsZero(f) { return f.every((fc) => fc.size === 0); }
function vecClone(f) { return f.map((fc) => new Set(fc)); }

function padVector(f, extra = 1) {
    const zeros = new Array(extra).fill(0);
    return f.map((fc) => {
        const out = new Set();
        for (const k of fc) out.add(monoKey(parseMono(k).concat(zeros)));
        return out;
    });
}

function stripLastCoords(f, extra = 1) {
    return f.map((fc) => {
        const out = new Set();
        for (const k of fc) {
            const u = parseMono(k);
            out.add(monoKey(u.slice(0, u.length - extra)));
        }
        return out;
    });
}

function isFreeOfLastCoords(f, extra = 1) {
    for (const fc of f) {
        for (const k of fc) {
            const u = parseMono(k);
            for (let i = u.length - extra; i < u.length; i++) {
                if (u[i] !== 0) return false;
            }
        }
    }
    return true;
}

function clearingShift(v) {
    let D = 0;
    for (const poly of v) {
        for (const k of poly) { D = parseMono(k).length; break; }
        if (D) break;
    }
    if (!D) return [];
    const mins = new Array(D).fill(0);
    for (const poly of v) {
        for (const k of poly) {
            const u = parseMono(k);
            for (let i = 0; i < D; i++) mins[i] = Math.min(mins[i], u[i]);
        }
    }
    return mins.map((x) => -x);
}

// =====================================================================
// Term orders. Exact arithmetic via BigInt (Phi's rational weights share
// one fixed denominator, so comparing values reduces to comparing
// integer numerators -- no floating point anywhere in this file).
// =====================================================================

const PHI_DENOM = 1000000000n;
// omega_1, omega_2, omega_3 approximating (1, sqrt(2), sqrt(3)) to 9
// decimal places, as exact rationals over PHI_DENOM -- identical values
// to anim/general_cc.py's OMEGA (computed there via
// round(math.sqrt(n)*1e9), reproduced here as literal integers).
const OMEGA_NUM = [1000000000n, 1414213562n, 1732050808n];

class PhiOrder {
    // The paper's weight order (main.tex:6824-6842): Phi(x^u e_a) = sum_i
    // omega_i u_i + eta_a, eta_a = a+1. See anim/general_cc.py's
    // make_phi_key docstring for why the fixed lexicographic tie-break
    // below makes this a bona fide term order even though OMEGA is
    // (necessarily, for exact reproducibility) rational rather than
    // genuinely irrational.
    constructor(D) { this.D = D; }

    key(u, a) {
        let acc = BigInt(a + 1) * PHI_DENOM;
        for (let i = 0; i < this.D; i++) acc += OMEGA_NUM[i] * BigInt(u[i]);
        return { phi: acc, u: u.slice(), a };
    }

    cmp(k1, k2) {
        if (k1.phi !== k2.phi) return k1.phi < k2.phi ? -1 : 1;
        for (let i = 0; i < k1.u.length; i++) {
            if (k1.u[i] !== k2.u[i]) return k1.u[i] - k2.u[i];
        }
        return k1.a - k2.a;
    }
}

class EliminationOrder {
    // Elimination order on S[t]^m for the saturation trick (arity D+1,
    // last coordinate = power of t): t-degree first (the defining
    // elimination property), then graded lexicographic on the x-part --
    // see anim/general_cc.py's make_elimination_key docstring for why
    // graded lex (not Phi) is used here: reusing Phi for this order's
    // tie-break made the intermediate basis blow up for Haah's code.
    constructor(D) { this.D = D; }

    key(u, a) {
        const tDeg = u[this.D];
        const xPart = u.slice(0, this.D);
        let sum = 0;
        for (const x of xPart) sum += x;
        return { tDeg, sum, xPart, a };
    }

    cmp(k1, k2) {
        if (k1.tDeg !== k2.tDeg) return k1.tDeg - k2.tDeg;
        if (k1.sum !== k2.sum) return k1.sum - k2.sum;
        for (let i = 0; i < k1.xPart.length; i++) {
            if (k1.xPart[i] !== k2.xPart[i]) return k1.xPart[i] - k2.xPart[i];
        }
        return k1.a - k2.a;
    }
}

// =====================================================================
// Buchberger's algorithm for F2 submodules of S^m (or S[t]^m).
//
// No coprime-leading-terms shortcut is used here -- see
// anim/general_cc.py's buchberger_modules docstring for why that standard
// optimization does not safely generalize to this module setting (it
// silently under-closed the basis for Haah's cubic code during
// development) and was removed entirely rather than ported.
// =====================================================================

function leadingTerm(f, order) {
    let best = null;
    for (let c = 0; c < f.length; c++) {
        for (const mkey of f[c]) {
            const u = parseMono(mkey);
            const k = order.key(u, c);
            if (best === null || order.cmp(k, best.key) > 0) best = { key: k, u, c };
        }
    }
    return best;
}

function sPoly(f, g, order) {
    const ltf = leadingTerm(f, order);
    const ltg = leadingTerm(g, order);
    const w = monoLcm(ltf.u, ltg.u);
    return vecAdd(
        vecTranslate(f, monoSub(w, ltf.u)),
        vecTranslate(g, monoSub(w, ltg.u)),
    );
}

function indexByComponent(lts) {
    const byComponent = new Map();
    for (let i = 0; i < lts.length; i++) {
        if (lts[i] === null) continue;
        const c = lts[i].c;
        if (!byComponent.has(c)) byComponent.set(c, []);
        byComponent.get(c).push(i);
    }
    return byComponent;
}

function findDivisor(gens, u, c, lts, byComponent) {
    const candidates = byComponent.has(c) ? byComponent.get(c) : [];
    for (const i of candidates) {
        const lt = lts[i];
        if (lt !== null && lt.c === c && monoDivides(lt.u, u)) return i;
    }
    return null;
}

function reduceFull(f, gens, order) {
    // Naive O(current-size) leading-term rescan per step. A heap-based
    // version exists in the Python reference for extra headroom but was
    // shown there (see development notes) to be unnecessary once the two
    // real bugs -- the coprime-criterion unsoundness and the combined-
    // saturation blowup -- were fixed: every preset's Groebner
    // computation is comfortably sub-second even with this simpler
    // rescan, so the simpler (and more obviously-correct-by-inspection)
    // version is what's ported here.
    const lts = gens.map((g) => leadingTerm(g, order));
    const byComponent = indexByComponent(lts);
    const fSets = f.map((fc) => new Set(fc));
    const remainder = f.map(() => new Set());

    for (;;) {
        let best = null;
        for (let c = 0; c < fSets.length; c++) {
            for (const mkey of fSets[c]) {
                const u = parseMono(mkey);
                const k = order.key(u, c);
                if (best === null || order.cmp(k, best.key) > 0) best = { key: k, u, c, mkey };
            }
        }
        if (best === null) break;
        const { u, c } = best;
        const idx = findDivisor(gens, u, c, lts, byComponent);
        if (idx !== null) {
            const shift = monoSub(u, lts[idx].u);
            const shifted = vecTranslate(gens[idx], shift);
            for (let comp = 0; comp < fSets.length; comp++) {
                for (const k of shifted[comp]) {
                    if (fSets[comp].has(k)) fSets[comp].delete(k); else fSets[comp].add(k);
                }
            }
        } else {
            fSets[c].delete(best.mkey);
            remainder[c].add(best.mkey);
        }
    }
    return remainder;
}

function buchbergerModules(generators, order, maxBasisSize = 2000) {
    const G = generators.filter((g) => !vecIsZero(g)).map(vecClone);
    const lts = G.map((g) => leadingTerm(g, order));
    const pairs = [];
    for (let i = 0; i < G.length; i++) {
        for (let j = i + 1; j < G.length; j++) {
            if (lts[i].c === lts[j].c) pairs.push([i, j]);
        }
    }
    while (pairs.length > 0) {
        const [i, j] = pairs.pop();
        const s = sPoly(G[i], G[j], order);
        const r = reduceFull(s, G, order);
        if (!vecIsZero(r)) {
            const newIdx = G.length;
            G.push(r);
            lts.push(leadingTerm(r, order));
            if (newIdx >= maxBasisSize) {
                throw new Error(`Buchberger's algorithm exceeded ${maxBasisSize} basis elements`);
            }
            for (let k = 0; k < newIdx; k++) {
                if (lts[k].c === lts[newIdx].c) pairs.push([k, newIdx]);
            }
        }
    }
    return G;
}

function minimalizeBasis(G, order) {
    const nz = G.filter((g) => !vecIsZero(g));
    const lts = nz.map((g) => leadingTerm(g, order));
    const n = nz.length;
    const redundant = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const sameU = lts[i].u.length === lts[j].u.length && lts[i].u.every((x, k) => x === lts[j].u[k]);
            if (lts[i].c === lts[j].c && monoDivides(lts[j].u, lts[i].u) && (!sameU || j < i)) {
                redundant[i] = true;
                break;
            }
        }
    }
    return nz.filter((_, i) => !redundant[i]);
}

function reducedGrobnerBasis(G, order) {
    const minimal = minimalizeBasis(G, order);
    const reduced = minimal.map((g, i) => {
        const others = minimal.slice(0, i).concat(minimal.slice(i + 1));
        return reduceFull(g, others, order);
    });
    reduced.sort((a, b) => order.cmp(leadingTerm(b, order).key, leadingTerm(a, order).key));
    return reduced;
}

function verifyGrobnerBasis(G, order) {
    const lts = G.map((g) => leadingTerm(g, order));
    for (let i = 0; i < G.length; i++) {
        for (let j = i + 1; j < G.length; j++) {
            if (lts[i].c !== lts[j].c) continue;
            const s = sPoly(G[i], G[j], order);
            const r = reduceFull(s, G, order);
            if (!vecIsZero(r)) {
                throw new Error(`Buchberger's criterion failed for pair (${i}, ${j})`);
            }
        }
    }
}

// =====================================================================
// Code specification parsing.
// =====================================================================

class CodeSpecError extends Error {}

const TERM_RE = /^([XYZ])(\d+)\(([^)]*)\)$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseCodeSpec(text) {
    const genOrder = [];
    const gens = new Map(); // name -> Map(qubit -> {X: Set, Z: Set})
    let D = null;
    const qubitLabels = new Set();

    const lines = text.split('\n');
    for (let lineno = 1; lineno <= lines.length; lineno++) {
        const line = lines[lineno - 1].trim();
        if (!line || line.startsWith('#')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
            throw new CodeSpecError(`line ${lineno}: expected '<name>: <term> <term> ...', got ${JSON.stringify(line)}`);
        }
        const name = line.slice(0, colonIdx).trim();
        const bodyPart = line.slice(colonIdx + 1);
        if (!NAME_RE.test(name)) {
            throw new CodeSpecError(`line ${lineno}: invalid generator name ${JSON.stringify(name)}`);
        }
        if (gens.has(name)) {
            throw new CodeSpecError(`line ${lineno}: duplicate generator name '${name}'`);
        }
        const tokens = bodyPart.split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length === 0) {
            throw new CodeSpecError(`line ${lineno}: generator '${name}' has no terms`);
        }
        genOrder.push(name);
        gens.set(name, new Map());

        for (const token of tokens) {
            const m = TERM_RE.exec(token);
            if (!m) {
                throw new CodeSpecError(`line ${lineno}: cannot parse term ${JSON.stringify(token)} in generator '${name}' (expected e.g. 'X1(0,0)')`);
            }
            const pauli = m[1];
            const qubit = parseInt(m[2], 10);
            if (qubit < 1) {
                throw new CodeSpecError(`line ${lineno}: qubit index must be a positive integer, got ${qubit} in term ${JSON.stringify(token)}`);
            }
            const offsetStr = m[3];
            const rawCoords = offsetStr.split(',').map((c) => c.trim());
            if (!offsetStr.trim() || rawCoords.some((c) => !/^-?\d+$/.test(c))) {
                throw new CodeSpecError(`line ${lineno}: bad offset ${JSON.stringify(offsetStr)} in term ${JSON.stringify(token)}`);
            }
            const offset = rawCoords.map((c) => parseInt(c, 10));

            if (D === null) D = offset.length;
            else if (offset.length !== D) {
                throw new CodeSpecError(`line ${lineno}: term ${JSON.stringify(token)} has ${offset.length} offset coordinates, expected ${D}`);
            }

            qubitLabels.add(qubit);
            const genMap = gens.get(name);
            if (!genMap.has(qubit)) genMap.set(qubit, { X: new Set(), Z: new Set() });
            const slot = genMap.get(qubit);
            const key = monoKey(offset);
            if (pauli === 'X' || pauli === 'Y') {
                if (slot.X.has(key)) slot.X.delete(key); else slot.X.add(key);
            }
            if (pauli === 'Z' || pauli === 'Y') {
                if (slot.Z.has(key)) slot.Z.delete(key); else slot.Z.add(key);
            }
        }
    }

    if (genOrder.length === 0) throw new CodeSpecError('code spec has no generators');
    if (D === null) throw new CodeSpecError('code spec has no terms');
    if (D !== 2 && D !== 3) throw new CodeSpecError(`D=${D} is not supported; only D in {2, 3} are implemented`);

    const q = Math.max(...qubitLabels);
    for (let k = 1; k <= q; k++) {
        if (!qubitLabels.has(k)) {
            const missing = [];
            for (let j = 1; j <= q; j++) if (!qubitLabels.has(j)) missing.push(j);
            throw new CodeSpecError(`qubit labels must be exactly {1, ..., ${q}} with no gaps; missing ${JSON.stringify(missing)}`);
        }
    }

    const m = genOrder.length;
    const sigma = genOrder.map((name) => {
        const components = new Array(2 * q).fill(null).map(() => new Set());
        for (const [qubit, slot] of gens.get(name)) {
            components[2 * (qubit - 1)] = new Set(slot.X);
            components[2 * (qubit - 1) + 1] = new Set(slot.Z);
        }
        return components;
    });

    return { D, q, m, genNames: genOrder, sigma };
}

function codeRadius(spec) {
    let best = 0;
    for (const gen of spec.sigma) {
        for (const poly of gen) {
            for (const k of poly) {
                for (const c of parseMono(k)) best = Math.max(best, Math.abs(c));
            }
        }
    }
    return best;
}

// =====================================================================
// sigma / epsilon.
// =====================================================================

function computeEpsBasis(spec) {
    const { q, m, sigma } = spec;
    const dual = (c) => (c % 2 === 0 ? c + 1 : c - 1);
    const basis = [];
    for (let c = 0; c < 2 * q; c++) {
        const d = dual(c);
        basis.push(Array.from({ length: m }, (_, a) => antipode(sigma[a][d])));
    }
    return basis;
}

function applyEpsilon(spec, epsBasis, pauli) {
    const m = spec.m;
    const result = Array.from({ length: m }, () => new Set());
    for (let c = 0; c < pauli.length; c++) {
        for (let a = 0; a < m; a++) {
            if (epsBasis[c][a].size === 0) continue;
            for (const k of pauli[c]) {
                result[a] = polyAdd(result[a], polyTranslate(epsBasis[c][a], parseMono(k)));
            }
        }
    }
    return result;
}

function applySigma(spec, f) {
    const q = spec.q;
    const result = Array.from({ length: 2 * q }, () => new Set());
    for (let a = 0; a < f.length; a++) {
        for (let c = 0; c < 2 * q; c++) {
            if (spec.sigma[a][c].size === 0) continue;
            for (const k of f[a]) {
                result[c] = polyAdd(result[c], polyTranslate(spec.sigma[a][c], parseMono(k)));
            }
        }
    }
    return result;
}

// =====================================================================
// Saturation (sequential, one variable at a time -- see
// anim/general_cc.py's compute_module_saturation docstring for the proof
// that this equals one combined saturation by the product of all
// variables, and why it is done this way for performance).
// =====================================================================

function saturateByOneVariable(generators, D, rank, i) {
    const embedded = generators.map((g) => padVector(g, 1));
    const unitI = new Array(D).fill(0); unitI[i] = 1;
    const special = [];
    for (let a = 0; a < rank; a++) {
        const vec = Array.from({ length: rank }, () => new Set());
        vec[a] = new Set([monoKey(new Array(D + 1).fill(0)), monoKey(unitI.concat([1]))]);
        special.push(vec);
    }
    const order = new EliminationOrder(D);
    let closed = buchbergerModules(embedded.concat(special), order);
    closed = reducedGrobnerBasis(closed, order);
    return closed.filter((g) => isFreeOfLastCoords(g, 1)).map((g) => stripLastCoords(g, 1));
}

function computeModuleSaturation(generators, D, rank) {
    let current = generators.map((g) => vecTranslate(g, clearingShift(g)));
    for (let i = 0; i < D; i++) current = saturateByOneVariable(current, D, rank, i);
    return current;
}

function computePlusGrobnerBasis(generators, D, rank) {
    const spanning = computeModuleSaturation(generators, D, rank);
    const order = new PhiOrder(D);
    const closed = buchbergerModules(spanning, order);
    const G = reducedGrobnerBasis(closed, order);
    verifyGrobnerBasis(G, order);
    return G;
}

// =====================================================================
// F2 linear solve (bit-packed via BigInt) and preimage search.
// =====================================================================

function solveF2System(equations, numVars) {
    const eqs = equations.slice();
    const pivotRowOfBit = new Map();
    let row = 0;
    const n = eqs.length;
    for (let bit = 1; bit <= numVars; bit++) {
        let piv = -1;
        const bitBig = BigInt(bit);
        for (let i = row; i < n; i++) {
            if ((eqs[i] >> bitBig) & 1n) { piv = i; break; }
        }
        if (piv === -1) continue;
        const tmp = eqs[row]; eqs[row] = eqs[piv]; eqs[piv] = tmp;
        for (let i = 0; i < n; i++) {
            if (i !== row && ((eqs[i] >> bitBig) & 1n)) eqs[i] ^= eqs[row];
        }
        pivotRowOfBit.set(bit, row);
        row++;
    }
    for (const eq of eqs) {
        if ((eq >> 1n) === 0n && (eq & 1n) === 1n) return null;
    }
    let solution = 0n;
    for (const [bit, r] of pivotRowOfBit) {
        if (eqs[r] & 1n) solution |= (1n << BigInt(bit - 1));
    }
    return solution;
}

function cartesianRanges(ranges) {
    let acc = [[]];
    for (const r of ranges) {
        const next = [];
        for (const prefix of acc) for (const x of r) next.push(prefix.concat([x]));
        acc = next;
    }
    return acc;
}

function rangeArr(lo, hiExclusive) {
    const out = [];
    for (let i = lo; i < hiExclusive; i++) out.push(i);
    return out;
}

function findPreimage(spec, epsBasis, g, maxRadiusMultiplier = 8) {
    const D = spec.D, q = spec.q;
    const radiusStep = Math.max(1, codeRadius(spec));

    const nonzeroMonomials = [];
    for (const poly of g) for (const k of poly) nonzeroMonomials.push(parseMono(k));
    if (nonzeroMonomials.length === 0) return Array.from({ length: 2 * q }, () => new Set());

    const lo = [], hi = [];
    for (let i = 0; i < D; i++) {
        lo.push(Math.min(...nonzeroMonomials.map((u) => u[i])));
        hi.push(Math.max(...nonzeroMonomials.map((u) => u[i])));
    }

    for (let attempt = 1; attempt <= maxRadiusMultiplier; attempt++) {
        const R = radiusStep * attempt;
        const vBox = cartesianRanges(Array.from({ length: D }, (_, i) => rangeArr(lo[i] - R, hi[i] + R + 1)));
        const varIndex = new Map();
        for (let c = 0; c < 2 * q; c++) {
            for (let k = 0; k < vBox.length; k++) varIndex.set(`${c},${monoKey(vBox[k])}`, c * vBox.length + k);
        }
        const numVars = 2 * q * vBox.length;

        const equationsByKey = new Map();
        for (let c = 0; c < 2 * q; c++) {
            for (let a = 0; a < spec.m; a++) {
                const basisPoly = epsBasis[c][a];
                if (basisPoly.size === 0) continue;
                for (const v of vBox) {
                    const varBit = 1n << BigInt(varIndex.get(`${c},${monoKey(v)}`) + 1);
                    for (const uk of basisPoly) {
                        const w = monoAdd(v, parseMono(uk));
                        const key = `${a},${monoKey(w)}`;
                        equationsByKey.set(key, (equationsByKey.get(key) || 0n) | varBit);
                    }
                }
            }
        }
        for (let a = 0; a < spec.m; a++) {
            for (const wk of g[a]) {
                const key = `${a},${wk}`;
                if (!equationsByKey.has(key)) equationsByKey.set(key, 0n);
            }
        }

        const equations = [];
        for (const [key, row] of equationsByKey) {
            const commaIdx = key.indexOf(',');
            const a = parseInt(key.slice(0, commaIdx), 10);
            const wk = key.slice(commaIdx + 1);
            const target = g[a].has(wk) ? 1n : 0n;
            equations.push(row | target);
        }

        const solution = solveF2System(equations, numVars);
        if (solution !== null) {
            const h = Array.from({ length: 2 * q }, () => new Set());
            for (const [ck, idx] of varIndex) {
                if ((solution >> BigInt(idx)) & 1n) {
                    const commaIdx = ck.indexOf(',');
                    const c = parseInt(ck.slice(0, commaIdx), 10);
                    h[c].add(ck.slice(commaIdx + 1));
                }
            }
            return h;
        }
    }
    throw new Error('findPreimage: no solution found within the radius budget');
}

function computePreimages(spec, epsBasis, G) {
    return G.map((g) => {
        const h = findPreimage(spec, epsBasis, g);
        const check = applyEpsilon(spec, epsBasis, h);
        for (let a = 0; a < g.length; a++) {
            if (check[a].size !== g[a].size || [...check[a]].some((k) => !g[a].has(k))) {
                throw new Error('findPreimage produced a wrong preimage');
            }
        }
        return h;
    });
}

// =====================================================================
// Compiled code (cached by spec text).
// =====================================================================

function orthantsOf(D) {
    const all = cartesianRanges(Array.from({ length: D }, () => [0, 1]));
    const allOnes = new Array(D).fill(1);
    const filtered = all.filter((s) => !s.every((x, i) => x === allOnes[i]));
    filtered.sort((a, b) => {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
    });
    return filtered;
}

function compileCode(spec) {
    const { D, q, m } = spec;
    const epsBasis = computeEpsBasis(spec);

    const G = computePlusGrobnerBasis(epsBasis, D, m);
    const phiOrder = new PhiOrder(D);
    const gLt = G.map((g) => { const lt = leadingTerm(g, phiOrder); return { u: lt.u, c: lt.c }; });
    const gByComponent = new Map();
    for (let j = 0; j < gLt.length; j++) {
        const c = gLt[j].c;
        if (!gByComponent.has(c)) gByComponent.set(c, []);
        gByComponent.get(c).push(j);
    }

    const H = computePreimages(spec, epsBasis, G);
    const GSigma = computePlusGrobnerBasis(spec.sigma, D, 2 * q);

    const orthants = orthantsOf(D);
    const zeroInAxis = [];
    for (let i = 0; i < D; i++) {
        const idxs = [];
        for (let idx = 0; idx < orthants.length; idx++) if (orthants[idx][i] === 0) idxs.push(idx);
        zeroInAxis.push(idxs);
    }

    return {
        spec, epsBasis, G, gLt, gByComponent, H, GSigma, orthants, zeroInAxis,
        codeRadius: codeRadius(spec),
    };
}

const compileCache = new Map();
function compileCodeCached(specText) {
    if (!compileCache.has(specText)) {
        const spec = parseCodeSpec(specText);
        compileCache.set(specText, compileCode(spec));
    }
    return compileCache.get(specText);
}

// =====================================================================
// Dense torus arrays: flat Uint8Array per channel-set, D-generic via
// explicit strided indexing (no numpy equivalent in JS). `shape` is
// always (L,)*D.
// =====================================================================

function flatSize(L, D) { return Math.pow(L, D); }

function flatIndex(pos, L, D) {
    let idx = 0;
    for (let i = 0; i < D; i++) idx = idx * L + (((pos[i] % L) + L) % L);
    return idx;
}

function allPositions(L, D) {
    return cartesianRanges(Array.from({ length: D }, () => rangeArr(0, L)));
}

function makeChannels(count, L, D) {
    const size = flatSize(L, D);
    return Array.from({ length: count }, () => new Uint8Array(size));
}

// result[pos] = arr[pos - shift] (mod L), matching numpy.roll(arr, shift=shift, axis=all).
function rollArray(arr, shift, L, D, positions) {
    const size = arr.length;
    const out = new Uint8Array(size);
    for (const pos of positions) {
        const srcPos = pos.map((x, i) => x - shift[i]);
        out[flatIndex(pos, L, D)] = arr[flatIndex(srcPos, L, D)];
    }
    return out;
}

function orAll(channels, indices, size) {
    const out = new Uint8Array(size);
    for (const idx of indices) {
        const ch = channels[idx];
        for (let k = 0; k < size; k++) if (ch[k]) out[k] = 1;
    }
    return out;
}

function anyOfChannels(channels) {
    for (const ch of channels) for (const v of ch) if (v) return true;
    return false;
}

function countChannels(channels) {
    let c = 0;
    for (const ch of channels) for (const v of ch) if (v) c++;
    return c;
}

// =====================================================================
// The code-capacity CA rule.
// =====================================================================

function computeDefectsFromPauli(compiled, pauli, L) {
    const { spec, epsBasis } = compiled;
    const D = spec.D;
    const size = flatSize(L, D);
    const defect = makeChannels(spec.m, L, D);
    const positions = allPositions(L, D);
    for (let c = 0; c < 2 * spec.q; c++) {
        let any = false;
        for (const v of pauli[c]) if (v) { any = true; break; }
        if (!any) continue;
        for (let a = 0; a < spec.m; a++) {
            for (const uk of epsBasis[c][a]) {
                const u = parseMono(uk);
                const rolled = rollArray(pauli[c], u, L, D, positions);
                for (let k = 0; k < size; k++) defect[a][k] ^= rolled[k];
            }
        }
    }
    return defect;
}

function epochBoundaries(K, t0, n) {
    if (K <= 0) return [];
    const boundaries = [];
    let total = 0;
    for (let k = 0; k < K; k++) {
        total += t0 * Math.pow(n, k);
        boundaries.push(total);
    }
    return boundaries;
}

function epochResetsAt(t, boundaries) {
    if (boundaries.length === 0) return false;
    const period = boundaries[boundaries.length - 1];
    const phase = ((t - 1) % period) + 1;
    return boundaries.includes(phase);
}

function initialStateFromError(compiled, error, L) {
    const spec = compiled.spec;
    const D = spec.D;
    return {
        L,
        defect: computeDefectsFromPauli(compiled, error, L),
        message: makeChannels(compiled.orthants.length, L, D),
        correction: makeChannels(2 * spec.q, L, D),
        t: 0,
    };
}

function stepSync(compiled, state, K, t0, n) {
    const spec = compiled.spec;
    const D = spec.D, m = spec.m, q = spec.q;
    const L = state.L;
    const size = flatSize(L, D);
    const positions = allPositions(L, D);

    const oldDefect = state.defect, oldMessage = state.message, oldCorrection = state.correction;

    const indicators = [];
    for (let i = 0; i < D; i++) {
        indicators.push(compiled.zeroInAxis[i].length > 0
            ? orAll(oldMessage, compiled.zeroInAxis[i], size)
            : new Uint8Array(size));
    }

    const decided = makeChannels(m, L, D);
    const deltaDefect = makeChannels(m, L, D);
    const deltaCorrection = makeChannels(2 * q, L, D);

    for (let c = 0; c < m; c++) {
        const candidates = compiled.gByComponent.has(c) ? compiled.gByComponent.get(c) : [];
        for (const j of candidates) {
            const avail = new Uint8Array(size);
            let anyAvail = false;
            for (let k = 0; k < size; k++) {
                if (oldDefect[c][k] && !decided[c][k]) { avail[k] = 1; anyAvail = true; }
            }
            if (!anyAvail) continue;

            const aJ = compiled.gLt[j].u;
            let cond = avail;
            for (let i = 0; i < D; i++) {
                const shifted = aJ[i] !== 0
                    ? rollArray(indicators[i], (() => { const s = new Array(D).fill(0); s[i] = aJ[i]; return s; })(), L, D, positions)
                    : indicators[i];
                const next = new Uint8Array(size);
                let anyNext = false;
                for (let k = 0; k < size; k++) if (cond[k] && shifted[k]) { next[k] = 1; anyNext = true; }
                cond = next;
                if (!anyNext) break;
            }
            let anyCond = false;
            for (let k = 0; k < size; k++) if (cond[k]) { anyCond = true; break; }
            if (!anyCond) continue;

            for (let k = 0; k < size; k++) if (cond[k]) decided[c][k] = 1;

            const gJ = compiled.G[j], hJ = compiled.H[j];
            for (let a2 = 0; a2 < m; a2++) {
                for (const vk of gJ[a2]) {
                    const v = parseMono(vk);
                    const off = v.map((x, i) => x - aJ[i]);
                    const rolled = rollArray(cond, off, L, D, positions);
                    for (let k = 0; k < size; k++) deltaDefect[a2][k] ^= rolled[k];
                }
            }
            for (let c2 = 0; c2 < 2 * q; c2++) {
                for (const vk of hJ[c2]) {
                    const v = parseMono(vk);
                    const off = v.map((x, i) => x - aJ[i]);
                    const rolled = rollArray(cond, off, L, D, positions);
                    for (let k = 0; k < size; k++) deltaCorrection[c2][k] ^= rolled[k];
                }
            }
        }
    }

    const newDefect = oldDefect.map((ch, a) => {
        const out = new Uint8Array(size);
        for (let k = 0; k < size; k++) out[k] = ch[k] ^ deltaDefect[a][k];
        return out;
    });
    const newCorrection = oldCorrection.map((ch, c) => {
        const out = new Uint8Array(size);
        for (let k = 0; k < size; k++) out[k] = ch[k] ^ deltaCorrection[c][k];
        return out;
    });

    const defectAnyOld = new Uint8Array(size);
    for (let k = 0; k < size; k++) {
        for (let a = 0; a < m; a++) if (oldDefect[a][k]) { defectAnyOld[k] = 1; break; }
    }

    const newMessage = [];
    for (let idx = 0; idx < compiled.orthants.length; idx++) {
        const s = compiled.orthants[idx];
        const grow = new Uint8Array(defectAnyOld);
        for (let i = 0; i < D; i++) {
            const shiftI = s[i] === 0 ? -1 : 1;
            const shiftVec = new Array(D).fill(0); shiftVec[i] = -shiftI;
            const neighbor = rollArray(oldMessage[idx], shiftVec, L, D, positions);
            for (let k = 0; k < size; k++) if (neighbor[k]) grow[k] = 1;
        }
        const out = new Uint8Array(size);
        for (let k = 0; k < size; k++) out[k] = (oldMessage[idx][k] || grow[k]) ? 1 : 0;
        newMessage.push(out);
    }

    const tNext = state.t + 1;
    const boundaries = epochBoundaries(K, t0, n);
    let finalMessage = newMessage;
    if (epochResetsAt(tNext, boundaries)) {
        finalMessage = newMessage.map(() => new Uint8Array(size));
    }

    return { L, defect: newDefect, message: finalMessage, correction: newCorrection, t: tNext };
}

function sampleIidError(compiled, L, p, rng, xOnly) {
    const spec = compiled.spec;
    const D = spec.D;
    const size = flatSize(L, D);
    const pauli = makeChannels(2 * spec.q, L, D);
    for (let kIdx = 0; kIdx < spec.q; kIdx++) {
        for (let k = 0; k < size; k++) {
            if (rng() < p) {
                if (xOnly) {
                    pauli[2 * kIdx][k] = 1;
                } else {
                    const kind = Math.floor(rng() * 3); // 0=X,1=Y,2=Z
                    if (kind !== 2) pauli[2 * kIdx][k] = 1;
                    if (kind !== 0) pauli[2 * kIdx + 1][k] = 1;
                }
            }
        }
    }
    return pauli;
}

// =====================================================================
// Torus-native stabilizer membership test (see
// anim/general_cc.py's is_stabilizer_on_torus docstring for why this,
// not the abstract Groebner-basis sigma_+ machinery, is the right tool
// for the interactive decoder's own logical-error readout).
// =====================================================================

function isStabilizerOnTorus(compiled, total, L) {
    const spec = compiled.spec;
    const D = spec.D, m = spec.m, q = spec.q;
    const sites = allPositions(L, D);

    const equationsByKey = new Map();
    for (let a = 0; a < m; a++) {
        const base = a * sites.length;
        for (let c = 0; c < 2 * q; c++) {
            const poly = spec.sigma[a][c];
            if (poly.size === 0) continue;
            for (let wIdx = 0; wIdx < sites.length; wIdx++) {
                const w = sites[wIdx];
                const varBit = 1n << BigInt(base + wIdx + 1);
                for (const uk of poly) {
                    const u = parseMono(uk);
                    const pos = w.map((x, i) => (((x + u[i]) % L) + L) % L);
                    const key = `${c},${monoKey(pos)}`;
                    equationsByKey.set(key, (equationsByKey.get(key) || 0n) | varBit);
                }
            }
        }
    }
    for (let c = 0; c < 2 * q; c++) {
        for (const w of sites) {
            const key = `${c},${monoKey(w)}`;
            if (!equationsByKey.has(key)) equationsByKey.set(key, 0n);
        }
    }

    const numVars = m * sites.length;
    const equations = [];
    for (const [key, row] of equationsByKey) {
        const commaIdx = key.indexOf(',');
        const c = parseInt(key.slice(0, commaIdx), 10);
        const pos = parseMono(key.slice(commaIdx + 1));
        const bit = total[c][flatIndex(pos, L, D)] ? 1n : 0n;
        equations.push(row | bit);
    }

    return solveF2System(equations, numVars) !== null;
}

// =====================================================================
// The decoder class -- standard module API used by this site.
// =====================================================================

const PRESETS = {
    toric2d: `A: X1(0,0) X2(0,0) X1(-1,0) X2(0,-1)
B: Z1(0,0) Z2(0,0) Z1(0,1) Z2(1,0)`,
    toric3d: `A: X1(0,0,0) X1(-1,0,0) X2(0,0,0) X2(0,-1,0) X3(0,0,0) X3(0,0,-1)
Bxy: Z1(0,0,0) Z2(0,0,0) Z1(0,1,0) Z2(1,0,0)
Byz: Z2(0,0,0) Z3(0,0,0) Z2(0,0,1) Z3(0,1,0)
Bzx: Z3(0,0,0) Z1(0,0,0) Z3(1,0,0) Z1(0,0,1)`,
    xcube: `Cxy: X1(0,0,0) X1(-1,0,0) X2(0,0,0) X2(0,-1,0)
Cyz: X2(0,0,0) X2(0,-1,0) X3(0,0,0) X3(0,0,-1)
Czx: X3(0,0,0) X3(0,0,-1) X1(0,0,0) X1(-1,0,0)
Cube: Z1(0,0,0) Z1(0,1,0) Z1(0,0,1) Z1(0,1,1) Z2(0,0,0) Z2(1,0,0) Z2(0,0,1) Z2(1,0,1) Z3(0,0,0) Z3(1,0,0) Z3(0,1,0) Z3(1,1,0)`,
    haah: `A: X1(0,0,0) X1(1,0,0) X1(0,1,0) X1(0,0,1) X2(0,0,0) X2(1,1,0) X2(1,0,1) X2(0,1,1)
B: Z1(1,0,0) Z1(0,1,0) Z1(0,0,1) Z1(1,1,1) Z2(1,1,0) Z2(1,0,1) Z2(0,1,1) Z2(1,1,1)`,
};

const GENERATOR_COLORS = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#fb923c'];

// Message glyphs: a small triangle in the cell corner matching orthant s,
// at modest alpha -- NOT a full-cell tint (a full-cell tint saturates the
// whole lattice within a few CA steps and hides the defect/correction
// glyphs underneath it). The corner for s = (s_1, ..., s_D) is the one
// where axis i sits at its "low" (s_i=0) or "high" (s_i=1) side -- exactly
// the corner opposite s's own propagation direction (main.tex's "(-1)^{s_i}
// e_i"), so this is a direct generalization of the toric/surface
// code-capacity tabs' m00/m01/m10 corner-triangle convention (D=2's three
// corners here use the identical blue/pink/green palette, in the identical
// (0,0)/(0,1)/(1,0) corner positions, as those tabs' m00/m01/m10).
const MESSAGE_CORNERS_2D = [
    { sx: 0, sy: 0, color: 'rgba(96,165,250,0.85)' },  // bottom-left, matches m00 (blue)
    { sx: 0, sy: 1, color: 'rgba(248,113,113,0.85)' }, // top-left, matches m01 (pink)
    { sx: 1, sy: 0, color: 'rgba(52,211,153,0.85)' },  // bottom-right, matches m10 (green)
];
// D=3 reuses the same four (s_x, s_y) corners (the (1,1) corner only ever
// hosts s_z=0, since (1,1,1) is the excluded all-ones orthant), and
// distinguishes s_z by hue instead: each corner triangle is split in half
// (by the segment from the corner to its hypotenuse's midpoint) when both
// s_z values are present there.
const Z_HUES = ['rgba(96,165,250,0.85)', 'rgba(251,146,60,0.85)'];

function fillTriangle(ctx, p1, p2, p3) {
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.closePath();
    ctx.fill();
}

// The corner point plus its two leg-endpoints (toward the cell center
// along each axis) and their midpoint (used to bisect the triangle when a
// D=3 corner needs to show both s_z halves). `cx, cy` are the cell's own
// top-left screen corner, `cell` its size; `legFrac` controls how far the
// triangle's legs reach toward the cell's center.
function cornerTriangleGeometry(cx, cy, cell, sx, sy, legFrac) {
    const legLen = cell * legFrac;
    const cornerX = cx + sx * cell;
    const cornerY = cy + (1 - sy) * cell;
    const dirX = sx === 0 ? 1 : -1;
    const dirY = sy === 0 ? -1 : 1;
    const A = [cornerX + dirX * legLen, cornerY];
    const B = [cornerX, cornerY + dirY * legLen];
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    return { corner: [cornerX, cornerY], A, B, mid };
}

// A small fixed-size corner-triangle icon for the legend, positioned like
// the other legend swatches' 10x10 rects (top-left at (lx, ly-8)),
// independent of any actual cell.
function legendCornerTriangle(lx, ly, sx, sy) {
    const { corner, A, B } = cornerTriangleGeometry(lx, ly - 8, 10, sx, sy, 0.95);
    return [corner, A, B];
}

function orthantIndexFor(orthants, sx, sy, sz) {
    for (let i = 0; i < orthants.length; i++) {
        const o = orthants[i];
        if (o[0] === sx && o[1] === sy && (o.length < 3 || o[2] === sz)) return i;
    }
    return -1;
}

export class GeneralCCDecoder {
    /**
     * @param {number} L - torus side length per axis
     * @param {number} clockPeriod - unused (kept for the shared UI slider)
     * @param {object} opts - { codeSpec: string (default: 2D toric preset),
     *   D: optional hint, overridden by the parsed spec's own D if they
     *   disagree, K, t0, n (epoch schedule, defaults 3, 8, 2), xOnly: bool }
     */
    constructor(L, clockPeriod = 6, opts = {}) {
        this.L = L;
        this._clockPeriod = clockPeriod;
        this.codeSpecText = opts.codeSpec !== undefined ? opts.codeSpec : PRESETS.toric2d;
        this.K = opts.K !== undefined ? opts.K : 3;
        this.t0 = opts.t0 !== undefined ? opts.t0 : 8;
        this.n = opts.n !== undefined ? opts.n : 2;
        this.xOnly = !!opts.xOnly;

        const t0Compile = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        this.compiled = compileCodeCached(this.codeSpecText);
        const t1Compile = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        this.lastCompileMs = t1Compile - t0Compile;

        this.D = this.compiled.spec.D;
        if (opts.D !== undefined && opts.D !== this.D) {
            // eslint-disable-next-line no-console
            console.warn(`GeneralCCDecoder: opts.D=${opts.D} disagrees with the parsed spec's D=${this.D}; using the parsed value.`);
        }

        this.stepCount = 0;
        this._rng = Math.random;
        this._logicalCache = null;

        this.error = makeChannels(2 * this.compiled.spec.q, this.L, this.D);
        this.state = initialStateFromError(this.compiled, this.error, this.L);
    }

    get clockPeriod() { return this._clockPeriod; }
    set clockPeriod(v) { this._clockPeriod = v; }

    // -- initialization --------------------------------------------------

    initializeRandomErrors(p, rng) {
        this._rng = rng || Math.random;
        this.compiled = compileCodeCached(this.codeSpecText);
        this.D = this.compiled.spec.D;
        this.error = sampleIidError(this.compiled, this.L, p, this._rng, this.xOnly);
        this.state = initialStateFromError(this.compiled, this.error, this.L);
        this.stepCount = 0;
        this._logicalCache = null;
    }

    // -- dynamics ---------------------------------------------------------

    step() {
        this.state = stepSync(this.compiled, this.state, this.K, this.t0, this.n);
        this.stepCount = this.state.t;
        this._logicalCache = null;
    }

    /** Documented no-op: this decoder only implements the synchronous rule. */
    stepUncoord() {
        this.step();
    }

    // -- queries -----------------------------------------------------------

    getSyndromeCount() { return countChannels(this.state.defect); }

    getErrorCount() {
        const total = this.error.map((ch, c) => {
            const out = new Uint8Array(ch.length);
            const corr = this.state.correction[c];
            for (let k = 0; k < ch.length; k++) out[k] = ch[k] ^ corr[k];
            return out;
        });
        return countChannels(total);
    }

    hasMessages() { return anyOfChannels(this.state.message); }

    isQuiescent() { return this.getSyndromeCount() === 0 && !this.hasMessages(); }

    /**
     * {hasError, horizontal: false, vertical: false} via the torus-native
     * generic stabilizer test (isStabilizerOnTorus) -- see that
     * function's header comment and anim/general_cc.py's
     * is_stabilizer_on_torus docstring. Memoized per (defect/correction)
     * state since it is a full linear solve, not an O(L) lookup.
     */
    checkLogicalError() {
        if (this._logicalCache !== null) return this._logicalCache;
        const total = this.error.map((ch, c) => {
            const out = new Uint8Array(ch.length);
            const corr = this.state.correction[c];
            for (let k = 0; k < ch.length; k++) out[k] = ch[k] ^ corr[k];
            return out;
        });
        const stabilizer = isStabilizerOnTorus(this.compiled, total, this.L);
        this._logicalCache = { hasError: !stabilizer, horizontal: false, vertical: false };
        return this._logicalCache;
    }

    /** No-op: toggling an arbitrary Pauli component at a clicked cell has no canonical single choice for a general code. */
    toggleErrorAtPosition() {}

    // -- rendering -----------------------------------------------------

    _cellPositionsForPanel(z) {
        const D = this.D;
        const L = this.L;
        if (D === 2) return allPositions(L, 2);
        const out = [];
        for (const [x, y] of allPositions(L, 2)) out.push([x, y, z]);
        return out;
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const opts = {
            showSyndrome: true, showErrors: true, showMessages: true, showGrid: true,
            ...options,
        };
        const L = this.L, D = this.D, m = this.compiled.spec.m, q = this.compiled.spec.q;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const titleSpace = 30;
        const legendSpace = 46;
        const padding = 16;

        let panels; // [{ x0, y0, size, z }]
        if (D === 2) {
            const avail = Math.min(canvasWidth - 2 * padding, canvasHeight - titleSpace - legendSpace - 2 * padding);
            const cell = Math.max(3, Math.floor(avail / L));
            panels = [{
                x0: (canvasWidth - cell * L) / 2,
                y0: titleSpace + padding,
                cell,
                z: null,
            }];
        } else {
            const cols = Math.ceil(Math.sqrt(L));
            const rows = Math.ceil(L / cols);
            const panelGap = 6;
            const rowTitleSpace = 16; // per-row allowance for each panel's own "z = k" label
            const availW = (canvasWidth - 2 * padding - (cols - 1) * panelGap) / cols;
            // Must match the step used below (cell*L + panelGap + rowTitleSpace per
            // row) exactly, or the actual grid ends up taller than budgeted and
            // overlaps the stats/legend band reserved beneath it.
            const availH = (canvasHeight - titleSpace - legendSpace - 2 * padding - (rows - 1) * (panelGap + rowTitleSpace)) / rows;
            const panelSize = Math.max(20, Math.min(availW, availH));
            const cell = Math.max(2, Math.floor(panelSize / L));
            const gridW = cols * (cell * L + panelGap) - panelGap;
            const offsetX = (canvasWidth - gridW) / 2;
            panels = [];
            for (let z = 0; z < L; z++) {
                const col = z % cols, row = Math.floor(z / cols);
                panels.push({
                    x0: offsetX + col * (cell * L + panelGap),
                    y0: titleSpace + padding + row * (cell * L + panelGap + rowTitleSpace),
                    cell,
                    z,
                });
            }
        }

        for (const panel of panels) {
            this._renderPanel(ctx, panel, opts);
        }

        const syndromeCount = this.getSyndromeCount();
        const errorCount = this.getErrorCount();
        ctx.fillStyle = '#1f2937';
        ctx.font = 'bold 15px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`t = ${this.stepCount}`, canvasWidth / 2, 20);

        ctx.fillStyle = '#64748b';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText(
            `defects=${syndromeCount} errors=${errorCount} generators=${m} qubits=${q} D=${D}`,
            canvasWidth / 2, canvasHeight - legendSpace + 14,
        );

        // Legend.
        ctx.textAlign = 'left';
        ctx.font = '11px "JetBrains Mono", monospace';
        let lx = padding;
        const ly = canvasHeight - 18;
        for (let a = 0; a < m; a++) {
            ctx.fillStyle = GENERATOR_COLORS[a % GENERATOR_COLORS.length];
            ctx.fillRect(lx, ly - 8, 10, 10);
            ctx.fillStyle = '#334155';
            ctx.fillText(this.compiled.spec.genNames[a], lx + 14, ly);
            lx += 14 + ctx.measureText(this.compiled.spec.genNames[a]).width + 12;
        }
        ctx.fillStyle = '#334155';
        ctx.fillText('X-corr', lx, ly); lx += ctx.measureText('X-corr').width + 8;
        ctx.fillStyle = '#f87171';
        ctx.fillRect(lx, ly - 8, 10, 4);
        lx += 18;
        ctx.fillStyle = '#334155';
        ctx.fillText('Z-corr', lx, ly); lx += ctx.measureText('Z-corr').width + 8;
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(lx, ly - 8, 10, 4);
        lx += 20;

        // Message orthants: a corner-triangle icon per color actually used
        // in the cells above (D=2: one swatch per corner, matching
        // MESSAGE_CORNERS_2D exactly; D=3: one swatch per s_z hue, since
        // position alone already encodes (s_x, s_y) in the cells).
        ctx.fillStyle = '#334155';
        ctx.fillText('messages:', lx, ly);
        lx += ctx.measureText('messages:').width + 6;
        if (this.D === 2) {
            for (const { sx, sy, color } of MESSAGE_CORNERS_2D) {
                ctx.fillStyle = color;
                fillTriangle(ctx, ...legendCornerTriangle(lx, ly, sx, sy));
                const label = `(${sx}${sy})`;
                ctx.fillStyle = '#334155';
                ctx.fillText(label, lx + 14, ly);
                lx += 14 + ctx.measureText(label).width + 10;
            }
        } else {
            for (let sz = 0; sz < 2; sz++) {
                ctx.fillStyle = Z_HUES[sz];
                fillTriangle(ctx, ...legendCornerTriangle(lx, ly, 0, 1));
                const label = `s_z=${sz}`;
                ctx.fillStyle = '#334155';
                ctx.fillText(label, lx + 14, ly);
                lx += 14 + ctx.measureText(label).width + 10;
            }
            ctx.fillStyle = '#334155';
            ctx.fillText('(corner position = s_x, s_y)', lx, ly);
        }
    }

    _renderPanel(ctx, panel, opts) {
        const { L, D, compiled } = this;
        const { x0, y0, cell, z } = panel;
        const m = compiled.spec.m, q = compiled.spec.q;
        const legFrac = 0.42;
        const corners2D = [[0, 0], [0, 1], [1, 0]]; // (1,1) is the excluded all-ones orthant in D=2

        if (z !== null) {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`z = ${z}`, x0, y0 - 4);
        }

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                const pos = D === 2 ? [x, y] : [x, y, z];
                const idx = flatIndex(pos, L, D);
                const cx = x0 + x * cell, cy = y0 + (L - 1 - y) * cell;

                if (opts.showGrid) {
                    ctx.strokeStyle = 'rgba(148,163,184,0.6)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1);
                }

                // Messages: a small corner triangle per orthant s, at
                // modest alpha, instead of a full-cell tint (which would
                // saturate the whole lattice within a few steps and hide
                // everything else). See MESSAGE_CORNERS_2D's comment for
                // the corner convention and the D=3 s_z-hue split.
                if (opts.showMessages) {
                    for (const [sx, sy] of corners2D) {
                        const { corner, A, B, mid } = cornerTriangleGeometry(cx, cy, cell, sx, sy, legFrac);
                        if (D === 2) {
                            const oi = orthantIndexFor(compiled.orthants, sx, sy, 0);
                            if (oi >= 0 && this.state.message[oi][idx]) {
                                ctx.fillStyle = MESSAGE_CORNERS_2D.find((c) => c.sx === sx && c.sy === sy).color;
                                fillTriangle(ctx, corner, A, B);
                            }
                        } else {
                            const szOptions = (sx === 1 && sy === 1) ? [0] : [0, 1];
                            for (const sz of szOptions) {
                                const oi = orthantIndexFor(compiled.orthants, sx, sy, sz);
                                if (oi < 0 || !this.state.message[oi][idx]) continue;
                                ctx.fillStyle = Z_HUES[sz];
                                if (szOptions.length === 1) fillTriangle(ctx, corner, A, B);
                                else if (sz === 0) fillTriangle(ctx, corner, A, mid);
                                else fillTriangle(ctx, corner, mid, B);
                            }
                        }
                    }
                }

                // Defect channels: the dominant glyph -- a vertical stack
                // of filled squares centred in the cell, one per
                // generator, each about a third of the cell wide; absent
                // channels draw nothing at all (no outline).
                if (opts.showSyndrome && cell >= 6) {
                    const sqSize = cell / 3;
                    const gap = sqSize * 0.15;
                    const totalHeight = m * sqSize + (m - 1) * gap;
                    const sqX = cx + cell / 2 - sqSize / 2;
                    let sqY = cy + cell / 2 - totalHeight / 2;
                    for (let a = 0; a < m; a++) {
                        if (this.state.defect[a][idx]) {
                            ctx.fillStyle = GENERATOR_COLORS[a % GENERATOR_COLORS.length];
                            ctx.fillRect(sqX, sqY, sqSize, sqSize);
                        }
                        sqY += sqSize + gap;
                    }
                }

                // Corrections: thin ticks along the bottom edge (secondary
                // to the defect stack), X in one colour and Z in another.
                if (opts.showErrors && cell >= 6) {
                    const tickH = cell * 0.25;
                    const tickW = cell / (2 * q);
                    for (let c = 0; c < 2 * q; c++) {
                        if (!this.state.correction[c][idx]) continue;
                        ctx.fillStyle = (c % 2 === 0) ? '#ef4444' : '#3b82f6'; // X vs Z
                        ctx.fillRect(cx + c * tickW, cy + cell - tickH, Math.max(1, tickW - 0.5), tickH);
                    }
                }
            }
        }
    }
}

export {
    PRESETS,
    parseCodeSpec,
    compileCode,
    compileCodeCached,
    computeEpsBasis,
    applyEpsilon,
    applySigma,
    computeModuleSaturation,
    computePlusGrobnerBasis,
    computePreimages,
    findPreimage,
    solveF2System,
    buchbergerModules,
    reducedGrobnerBasis,
    verifyGrobnerBasis,
    reduceFull,
    leadingTerm,
    vecTranslate,
    vecAdd,
    vecIsZero,
    clearingShift,
    PhiOrder,
    EliminationOrder,
    isStabilizerOnTorus,
    computeDefectsFromPauli,
    initialStateFromError,
    stepSync,
    monoKey,
    parseMono,
};
