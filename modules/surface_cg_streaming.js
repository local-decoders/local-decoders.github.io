// Surface-code hierarchical (coarse-grained) streaming decoder -- literal
// JS port of anim/cg_streaming_surface.py. See that module's docstring for
// full paper-line citations and the seven documented reader's choices; this
// file follows every one of them identically (same slice geometry, same
// boundary-aware endpoint arithmetic for the correction expansion, same
// splitting-step index arithmetic).
//
// This module is the open-boundary counterpart of
// website/modules/toric_cg_streaming.js (the periodic hierarchical toric
// decoder -- supplies the record-intake/defect-update/message-update
// structure and the correction-expansion machinery, generalized here to a
// per-slice boundary-aware endpoint rather than a periodic shortest-arc),
// combined with website/modules/surface_streaming.js's open-boundary
// geometry and splitting step (qx shape [Lx+1,Ly] with an edge-indexed,
// not site-indexed, e_x channel; qy row 0 always false; the
// mHalf/isCenter/inBounds splitting-step index arithmetic), applied
// independently at each slice's own coarse resolution Lx/n**k x Ly/n**k.
//
// Paper citations (reference/paper/main.tex), matching anim/cg_streaming_surface.py:
//   4516-4627 (intro), 4628-4891 (repetition-code warm-up, record/timer
//   semantics), 4892-5407 (hierarchical toric-code decoder and its three
//   algorithms), 5546-5553 ("State preparation, state injection, and open
//   boundary conditions" -- the section licensing this module), 2298-2327 /
//   2808-2821 / 3511-3522 (the splitting-step definitions this section
//   refers to).
//
// Reader's choices (see the Python module's docstring for full derivations):
//   1. Each slice k is itself a planar (non-periodic) patch of shape
//      Lx/n**k x Ly/n**k, with the same rough/smooth boundary structure as
//      slice 0 at its own resolution.
//   2. A slice-k split requires both t % qs === 0 and t % n**k === 0 on the
//      same absolute t.
//   3. Center cut at floor(Lx_k/2), same even-length convention as slice 0.
//   4. e_x is edge-indexed (shape [Lx_k+1, Ly_k]); its two boundary entries
//      (index 0 and Lx_k) expand to the *true* physical boundary, not to a
//      nonexistent further block.
//   5. Child-to-parent correction strings use an x-then-y path between
//      identified block centers (no periodic tie-break needed).
//   6. The message-update defect-source condition is the resolved s(t)/
//      s(t+1), not a raw arrival-multiset predicate (may legitimately
//      diverge from a raw-arrival oracle in one documented, rare
//      configuration -- see the Python module and its test).
//   7. General-q growth: "c < growthWindow", plus the base-rule variant --
//      movementGated/growthWindow mirror torca.reference.step_sync's own
//      two parameters exactly. Default (movementGated:false,
//      growthWindow:1) is the numerics-style rule (movement checked every
//      tick, growth only at c===0); movementGated:true, growthWindow:q-1
//      reaches the formal general-q rule main.tex:4939 specializes to
//      q=3, still fully supported but no longer the default -- see the
//      Python module's docstring for why (on a small lattice, the formal
//      rule's near-q-times-faster message growth than defect movement lets
//      a message front outrun the pair of defects it should reunite).
//
// Noise model: physical bits bx_t, by_t on the patch are cumulative (each
// qubit flips independently w.p. pPhys per round); s~_t = syndrome(bx_t,
// by_t) xor meas_t (meas_t ~ Bernoulli(pMeas)); phi_t = s~_t xor s~_{t-1},
// s~_{-1}=0. Corrections (Ex,Ey) are expandCorrection()'s XOR-sum of every
// slice's correction channels; residual = b xor E; the logical indicator is
// the parity of the residual qx along the fixed geometric column x0=0
// (sum over y, NOT a row/sum-over-x quantity -- see checkLogicalError()'s
// comment for why only the column version is gauge-invariant).
//
// Two properties of the residual worth understanding (see
// anim/cg_streaming_surface.py's module docstring for the full derivation
// and website/tests/test_cg_streaming_surface.py for the confirming tests):
//   1. getErrorCount() (residual edge weight) accumulates closed loops --
//      harmless, zero-syndrome stabilizer elements formed whenever a
//      correction does not retrace its error's own path -- and random
//      -walks toward a constant density rather than staying near zero. It
//      is NOT a decoder-health metric; getSyndromeCount() (live defects at
//      slice 0) is. checkLogicalError() sampled while noise is ongoing
//      inherits this same contamination and is only a reliable "did a
//      logical error occur" check once all noise has stopped and the
//      decoder has fully drained (getSyndromeCount()===0 at every slice).
//   2. A correctly-drained residual is exactly zero, even under pMeas>0 --
//      there is no inherent measurement-noise floor. An earlier version of
//      this note claimed a small (1-2 edge) permanent residual was an
//      expected, physically-unavoidable consequence of noisy syndrome
//      extraction. Team-lead rejected that: a permanent residual with
//      every slice empty and nothing pending cannot be a measurement-noise
//      floor, since the decoder's own correction-expansion bookkeeping is
//      provably exact at every round (test_correction_expansion_identity,
//      zero exceptions under continuous noise). The real cause was a
//      Python test-harness bug: draining must deliver one more true
//      detector-event round (the frozen physical state's syndrome,
//      measured noiselessly) before falling back to zero, since the last
//      noisy round's own measurement error has a "trailing partner" event
//      one round later that an all-zero drain silently drops -- see
//      _noisy_then_drain_state's docstring in
//      website/tests/test_cg_streaming_surface.py. With that fixed, the
//      20-seed smoke sweep clears at every seed at both p=0.001 and
//      p=0.002; under pMeas=0 the same holds trivially.

// TASK 4ds: shared visual-language constants/helpers, same restyle as
// toric2.js/surface2.js/surface_streaming_3d.js -- see this module's own
// render() section below for the full rationale. Re-exported so main.js's
// getLegendItems() can read them off this module's own namespace object,
// the same pattern every other restyled module uses.
import {
    COLOR_GRID, COLOR_ERROR, COLOR_ORB_RIM,
    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE, drawOrb,
} from './repetition2.js';
import {
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    drawMessageCell,
} from './toric2.js';
import {
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH,
} from './surface_streaming_3d.js';

export {
    COLOR_ORB_RIM, COLOR_ERROR,
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH,
};

// Hierarchy promotion and condensation highlights use this positive green.
// Residual strings use COLOR_ERROR only.
export const COLOR_CORRECTION = '#1ea080';

// Apply extra message erasure only when the slice's own rule updates.
// False restores erasure on every slice after every physical step.
export const SURFACE_CG_ERASURE_PER_SLICE_CADENCE = false;

const MESSAGE_CHANNELS = [[0, 0], [0, 1], [1, 0]]; // m00 (+x,+y), m01 (+x,-y), m10 (-x,+y)
const MESSAGE_OFFSETS = MESSAGE_CHANNELS.map(([i, j]) => offsets(i, j));

// Per-level colours for the unified hierarchy-lattice rendering (nested
// coarse grid lines, defect block outlines) -- defined once here, listed
// in the legend. Index 0 (level-0 defects keep their original black
// outline, so this entry is unused for the outline itself but keeps the
// indexing uniform) through index 5 (K rarely exceeds this in practice).
// TASK 4ds: exported so main.js's getLegendItems() can build one HTML
// legend row per level (its own K/n come from the live decoder instance,
// not this module's static namespace, since the level count is per-
// instance) in this same colour, matching the swatch style of every
// other exported colour constant here.
export const LEVEL_COLORS = ['#4a4a4a', '#2f6fdb', '#a855c7', '#e08a1e', '#1ea080', '#c0392b'];
const LARGE_TIMER = 1 << 30;

function mulberry32(seed) {
    let a = seed >>> 0;
    const rng = function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.getState = () => a;
    rng.setState = state => { a = state | 0; };
    return rng;
}

function offsets(i, j) {
    return [i === 0 ? -1 : 1, j === 0 ? -1 : 1];
}

function make2D(nx, ny, fill) {
    const out = new Array(nx);
    for (let x = 0; x < nx; x++) out[x] = new Array(ny).fill(fill);
    return out;
}

function copy2D(arr) {
    return arr.map(col => col.slice());
}

function make3D(depth, nx, ny, fill) {
    const out = new Array(depth);
    for (let d = 0; d < depth; d++) out[d] = make2D(nx, ny, fill);
    return out;
}

function copy3D(arr) {
    return arr.map(copy2D);
}

function make4D(nx, ny, n, fill) {
    // shape [nx, ny, n, n], indexed [rx][ry][ax][ay]
    const out = new Array(nx);
    for (let rx = 0; rx < nx; rx++) {
        out[rx] = new Array(ny);
        for (let ry = 0; ry < ny; ry++) out[rx][ry] = make2D(n, n, fill);
    }
    return out;
}

function copy4D(arr) {
    if (arr === null) return null;
    return arr.map(row => row.map(copy2D));
}

// Boundary-aware read: outside [0,Lx) x [0,Ly), a channel reads as trivial
// (0/false) -- "outside neighbours read as 0" (no periodic wraparound; this
// JS port never runs in the Python reference's periodic test mode, since
// cross-validation is against the Python reference's own open-boundary
// output via the dump/check harness, not directly against torca).
function readBool(arr, x, y, Lx, Ly) {
    if (x < 0 || x >= Lx || y < 0 || y >= Ly) return false;
    return !!arr[x][y];
}

function readInt(arr, x, y, Lx, Ly) {
    if (x < 0 || x >= Lx || y < 0 || y >= Ly) return 0;
    return arr[x][y] | 0;
}

function toomVote(m, dx, dy, x, y, Lx, Ly) {
    const votes = (m[x][y] ? 1 : 0)
        + (readBool(m, x + dx, y, Lx, Ly) ? 1 : 0)
        + (readBool(m, x, y + dy, Lx, Ly) ? 1 : 0);
    return votes >= 2;
}

// s[x,y] = qx[x,y]^qx[x+1,y]^(qy[x,y] if y>=1)^(qy[x,y+1] if y+1<=Ly-1).
// Exported (matches toric_cg_streaming.js's physicalSyndrome) so a harness
// can exercise the JS environment-generation path directly -- computing s~
// and phi from externally-supplied raw bx/by/meas histories via THIS
// function, rather than only ever injecting a pre-computed phi history via
// setTestPhiHistory (which bypasses syndromeOpen entirely).
export function syndromeOpen(qx, qy, Lx, Ly) {
    const s = make2D(Lx, Ly, false);
    for (let x = 0; x < Lx; x++) {
        for (let y = 0; y < Ly; y++) {
            const a = qx[x][y] !== qx[x + 1][y];
            const bTerm = qy[x][y]; // row 0 always false, matches "if y>=1"
            const cTerm = (y + 1 <= Ly - 1) ? qy[x][y + 1] : false;
            s[x][y] = (a !== bTerm) !== cTerm;
        }
    }
    return s;
}

// ---------------------------------------------------------------------------
// One slice's complete state (mirrors anim/cg_streaming_surface.py's
// SliceState exactly). e_x is edge-indexed, shape [Lx_k+1, Ly_k] --
// reader's choice 4.
// ---------------------------------------------------------------------------

function makeSlice(LxK, LyK, k, n) {
    return {
        Lx: LxK, Ly: LyK,
        s: make2D(LxK, LyK, false),
        tau: make2D(LxK, LyK, 0),
        e_x: make2D(LxK + 1, LyK, false),
        e_y: make2D(LxK, LyK, false),
        e_child: k > 0 ? make4D(LxK, LyK, n, false) : null,
        m: make3D(3, LxK, LyK, false),      // m[channel][x][y]
        th: make3D(3, LxK, LyK, 0),
        c: make2D(LxK, LyK, 0),
        rho: k > 0 ? make2D(LxK, LyK, false) : null,
    };
}

// ---------------------------------------------------------------------------
// Physical correction expansion -- main.tex:4977-4994; reader's choices 4-5.
// ---------------------------------------------------------------------------

function physCenter(k, n, rx, ry) {
    const nk = Math.pow(n, k);
    return [nk * rx + Math.floor(nk / 2), nk * ry + Math.floor(nk / 2)];
}

// Physical x-endpoints of coarse same-slice x-edge index r (0<=r<=LxK) at
// slice k, row y: block r-1's center (or the true left boundary 0 if r=0)
// to block r's center (or the true right boundary Lx if r=LxK).
function xEdgeEndpoints(k, n, LxK, Lx, r, y) {
    // Boundary fallbacks are the physical-site coordinate one step past the
    // real site range (-1 left, Lx right), symmetric on the applyXRun side
    // -- NOT 0/Lx. At k=0 (nk=1), block 0's own center is site 0, so a "0"
    // left fallback would coincide with it and applyXRun would flip
    // nothing, silently dropping the correction for a defect condensing at
    // the true left boundary (qx[0,y]) via a split. See the matching fix
    // in anim/cg_streaming_surface.py's _x_edge_endpoints for the full
    // derivation.
    const nk = Math.pow(n, k);
    const left = (r - 1 >= 0) ? ((r - 1) * nk + Math.floor(nk / 2)) : -1;
    const right = (r < LxK) ? (r * nk + Math.floor(nk / 2)) : Lx;
    return [left, right];
}

function applyXRun(Ex, y, xStart, xEnd) {
    const lo = Math.min(xStart, xEnd), hi = Math.max(xStart, xEnd);
    for (let c = lo + 1; c <= hi; c++) Ex[c][y] = !Ex[c][y];
}

function applyYRun(Ey, x, yStart, yEnd) {
    const lo = Math.min(yStart, yEnd), hi = Math.max(yStart, yEnd);
    for (let c = lo + 1; c <= hi; c++) Ey[x][c] = !Ey[x][c];
}

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

export class SurfaceCGStreamingDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        this.Lx = L;
        this.Ly = opts.Ly !== undefined ? opts.Ly : L;
        this.L = L; // kept for compatibility with the generic size slider
        this.q = (Number.isFinite(clockPeriod) && clockPeriod >= 2) ? Math.round(clockPeriod) : 6;
        // Base-rule variant (reader's choice 7): movementGated/growthWindow
        // mirror torca.reference.step_sync's own two parameters exactly.
        // Default is the numerics-style rule (movement checked every tick,
        // growth only at c===0) -- movementGated:true, growthWindow:q-1
        // reaches the formal general-q rule main.tex:4939 specializes to
        // q=3, still fully supported but no longer the default (see the
        // Python module's docstring for why: on a small lattice -- every
        // coarse slice here is small by construction -- the formal rule's
        // near-q-times-faster message growth than defect movement lets a
        // message front outrun the pair of defects it should reunite).
        this.movementGated = opts.movementGated ?? false;
        this.growthWindow = opts.growthWindow !== undefined ? opts.growthWindow : 1;
        // Extra erasure-only message sub-steps run after each slice's real
        // update (task spec, not part of the cited paper excerpt).
        // 0 (default) is a no-op -- see _erasureSubstep()/step().
        this.erasureMoves = Math.max(0, Math.round(opts.erasureMoves ?? 0));
        this.K = Math.max(1, Math.round(opts.K ?? 3));
        this.n = Math.max(2, Math.round(opts.n ?? 2));
        this.t0 = Math.max(1, Math.round(opts.t0 ?? 4));
        this.qs = Math.max(1, Math.round(opts.qs ?? 16));
        this.pPhys = opts.pPhys ?? 0.001;
        this._pMeasOverridden = opts.pMeas !== undefined;
        this.pMeas = opts.pMeas ?? this.pPhys;
        this.seed = opts.seed ?? 1;
        this.x0 = 0; // reference column for the logical indicator (checkLogicalError)

        const nK1 = Math.pow(this.n, this.K - 1);
        if (this.Lx % nK1 !== 0 || this.Ly % nK1 !== 0) {
            throw new Error(`Lx=${this.Lx}, Ly=${this.Ly} must both be divisible by n**(K-1)=${nK1}`);
        }

        // Explicit seeds retain reproducible standalone runs; a caller's
        // generator owns every noise draw, and an omitted seed stays fresh.
        this._rng = opts.rng || (opts.seed == null ? Math.random : mulberry32(this.seed >>> 0));
        this._testPhiQueue = null; // set via setTestPhiHistory()
        this._lastPhi = null;

        this.reset();
    }

    sizeOf(k) {
        const nk = Math.pow(this.n, k);
        return [Math.round(this.Lx / nk), Math.round(this.Ly / nk)];
    }

    reset() {
        this._noiseEnabled = true;
        this._lastMeasurementHasError = false;
        this.slices = [];
        for (let k = 0; k < this.K; k++) {
            const [lxK, lyK] = this.sizeOf(k);
            this.slices.push(makeSlice(lxK, lyK, k, this.n));
        }
        this.pending = new Map(); // arrivalTime -> [[kTarget,px,py,ax,ay], ...]
        this.t = -1;
        this.stepCount = 0;

        this.bx = make2D(this.Lx + 1, this.Ly, false);
        this.by = make2D(this.Lx, this.Ly, false);
        this._prevTildeS = make2D(this.Lx, this.Ly, false);
        this._lastPhi = make2D(this.Lx, this.Ly, false);
        this.lastPromotions = new Array(this.K).fill(0);
        this.lastCondensations = new Array(this.K).fill(0);
        this.lastDidSplit = false;
    }

    // Generic-decoder-interface compatibility: re-seed and restart.
    initializeRandomErrors(p, rng) {
        this.pPhys = p;
        if (!this._pMeasOverridden) this.pMeas = p;
        this._rng = rng || Math.random;
        this._testPhiQueue = null;
        this.reset();
    }

    // -----------------------------------------------------------------
    // Test-only: bypass the noise environment entirely and feed an
    // explicit, pre-computed phi history (one (Lx x Ly) boolean nested
    // array per round) -- so a Node harness can drive this decoder with
    // the *exact* same phi(.,t) sequence a Python reference run used, for
    // bit-for-bit cross-validation of the CA channels (not of the noise
    // model, which is deliberately implementation-specific). Resets the
    // decoder state to t=-1 / stepCount=0.
    // -----------------------------------------------------------------
    setTestPhiHistory(phiList) {
        this._testPhiQueue = phiList.map(p => p.map(col => col.slice()));
        this.reset();
    }

    // ------------------------------------------------------------------
    // Noise (main.tex:3136-3143 restated for slice 0's input, 5030-5033)
    // ------------------------------------------------------------------

    // There is no future window: each step draws one fresh round, and a
    // stop takes effect on that next round while preserving configured rates.
    setNoiseEnabled(enabled) {
        this._noiseEnabled = !!enabled;
    }

    isNoiseEnabled() {
        return this._noiseEnabled;
    }

    _drawPhi() {
        const Lx = this.Lx, Ly = this.Ly;
        if (this._testPhiQueue && this._testPhiQueue.length > 0) {
            return this._testPhiQueue.shift();
        }

        const pPhys = this._noiseEnabled ? this.pPhys : 0;
        const pMeas = this._noiseEnabled ? this.pMeas : 0;
        const flipX = make2D(Lx + 1, Ly, false);
        const flipY = make2D(Lx, Ly, false);
        const meas = make2D(Lx, Ly, false);
        if (pPhys > 0 || pMeas > 0) {
            for (let x = 0; x <= Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (this._rng() < pPhys) flipX[x][y] = true;
                }
            }
            for (let x = 0; x < Lx; x++) {
                for (let y = 1; y < Ly; y++) {
                    if (this._rng() < pPhys) flipY[x][y] = true;
                }
            }
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (this._rng() < pMeas) meas[x][y] = true;
                }
            }
        }
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                if (flipX[x][y]) this.bx[x][y] = !this.bx[x][y];
            }
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 1; y < Ly; y++) {
                if (flipY[x][y]) this.by[x][y] = !this.by[x][y];
            }
        }
        const trueS = syndromeOpen(this.bx, this.by, Lx, Ly);
        const tildeS = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) tildeS[x][y] = trueS[x][y] !== meas[x][y];
        }
        const phi = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) phi[x][y] = tildeS[x][y] !== this._prevTildeS[x][y];
        }
        this._prevTildeS = tildeS;
        this._lastMeasurementHasError = meas.some(col => col.some(Boolean));
        return phi;
    }

    // -----------------------------------------------------------------
    // Stage 1: record intake -- main.tex:5073-5141
    // -----------------------------------------------------------------
    _recordIntake() {
        const K = this.K, tNext = this.t + 1;
        const eChildNext = new Array(K).fill(null);
        const rhoNext = new Array(K).fill(null);
        for (let k = 1; k < K; k++) {
            eChildNext[k] = copy4D(this.slices[k].e_child);
            rhoNext[k] = copy2D(this.slices[k].rho);
        }
        const due = this.pending.get(tNext);
        if (due) {
            for (const [kTarget, px, py, ax, ay] of due) {
                eChildNext[kTarget][px][py][ax][ay] = !eChildNext[kTarget][px][py][ax][ay];
                rhoNext[kTarget][px][py] = !rhoNext[kTarget][px][py];
            }
        }
        return { eChildNext, rhoNext };
    }

    // -----------------------------------------------------------------
    // Stage 2: movement indicators + defect-sector update -- main.tex:5109-5225
    // -----------------------------------------------------------------
    _defectUpdate(phiNext, rhoNext, onMove = null) {
        const { K, n, t0, t } = this;
        const exNext = this.slices.map(sl => copy2D(sl.e_x));
        const eyNext = this.slices.map(sl => copy2D(sl.e_y));
        const sNext = new Array(K);
        const tauNext = new Array(K);
        const newPending = new Map();

        const addPending = (arrivalT, rec) => {
            if (!newPending.has(arrivalT)) newPending.set(arrivalT, []);
            newPending.get(arrivalT).push(rec);
        };

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            const nk = Math.pow(n, k);
            if (t % nk !== 0) {
                sNext[k] = copy2D(sl.s);
                tauNext[k] = copy2D(sl.tau);
                continue;
            }

            const [LxK, LyK] = this.sizeOf(k);
            const timed = k < K - 1;
            const candCount = make2D(LxK, LyK, 0);
            const candMinTau = make2D(LxK, LyK, LARGE_TIMER);

            if (k === 0) {
                for (let x = 0; x < LxK; x++) {
                    for (let y = 0; y < LyK; y++) {
                        if (phiNext[x][y]) {
                            candCount[x][y] += 1;
                            if (timed) candMinTau[x][y] = Math.min(candMinTau[x][y], 0);
                        }
                    }
                }
            }

            if (k > 0) {
                const rk = rhoNext[k];
                for (let x = 0; x < LxK; x++) {
                    for (let y = 0; y < LyK; y++) {
                        if (rk[x][y]) {
                            candCount[x][y] += 1;
                            if (timed) candMinTau[x][y] = Math.min(candMinTau[x][y], 0);
                            rk[x][y] = false;
                        }
                    }
                }
            }

            const m00 = sl.m[0], m01 = sl.m[1], m10 = sl.m[2];
            for (let x = 0; x < LxK; x++) {
                for (let y = 0; y < LyK; y++) {
                    if (!sl.s[x][y]) continue;
                    let tauPlus = 0;

                    if (timed) {
                        tauPlus = sl.tau[x][y] + 1;
                        if (tauPlus === t0) {
                            const px = Math.floor(x / n), py = Math.floor(y / n);
                            const ax = x % n, ay = y % n;
                            const arrivalT = t + Math.pow(n, k + 1) + 1;
                            addPending(arrivalT, [k + 1, px, py, ax, ay]);
                            continue;
                        }
                    }

                    let moveLeft = false, moveDown = false;
                    const movementAllowed = !this.movementGated || sl.c[x][y] === 0;
                    if (movementAllowed) {
                        const m0jLeft = readBool(m00, x - 1, y, LxK, LyK) || readBool(m01, x - 1, y, LxK, LyK);
                        if (m0jLeft) {
                            moveLeft = true;
                        } else {
                            moveDown = readBool(m00, x, y - 1, LxK, LyK) || readBool(m10, x, y - 1, LxK, LyK);
                        }
                    }

                    if (moveLeft) {
                        exNext[k][x][y] = !exNext[k][x][y];
                        const tx = x - 1;
                        if (tx >= 0) {
                            candCount[tx][y] += 1;
                            if (onMove) onMove({
                                from: { level: k, rx: x, ry: y },
                                to: { level: k, rx: tx, ry: y },
                                kind: 'street',
                            });
                            if (timed) candMinTau[tx][y] = Math.min(candMinTau[tx][y], tauPlus);
                        }
                    } else if (moveDown) {
                        eyNext[k][x][y] = !eyNext[k][x][y];
                        const ty = y - 1;
                        if (ty >= 0) {
                            candCount[x][ty] += 1;
                            if (onMove) onMove({
                                from: { level: k, rx: x, ry: y },
                                to: { level: k, rx: x, ry: ty },
                                kind: 'street',
                            });
                            if (timed) candMinTau[x][ty] = Math.min(candMinTau[x][ty], tauPlus);
                        }
                    } else {
                        candCount[x][y] += 1;
                        if (timed) candMinTau[x][y] = Math.min(candMinTau[x][y], tauPlus);
                    }
                }
            }

            const sK = make2D(LxK, LyK, false);
            const tauK = make2D(LxK, LyK, 0);
            for (let x = 0; x < LxK; x++) {
                for (let y = 0; y < LyK; y++) {
                    if (candCount[x][y] % 2 === 1) {
                        sK[x][y] = true;
                        if (timed && candMinTau[x][y] < LARGE_TIMER) tauK[x][y] = candMinTau[x][y];
                    }
                }
            }
            sNext[k] = sK;
            tauNext[k] = tauK;
        }

        return { exNext, eyNext, sNext, tauNext, newPending };
    }

    // -----------------------------------------------------------------
    // Stage 3: N_ij / ToomVote / growth / coupling / persistence +
    // message-sector update -- main.tex:5227-5404
    // -----------------------------------------------------------------
    _messageUpdate(sNext, tauNext) {
        const { K, n, q, t0, t, growthWindow } = this;
        const mNext = new Array(K);
        const thetaNext = new Array(K);
        const cNext = new Array(K);

        for (let k = 0; k < K; k++) {
            const nk = Math.pow(n, k);
            const sl = this.slices[k];
            if (t % nk !== 0) {
                mNext[k] = copy3D(sl.m);
                thetaNext[k] = copy3D(sl.th);
                cNext[k] = copy2D(sl.c);
                continue;
            }

            const [LxK, LyK] = this.sizeOf(k);
            const timed = k < K - 1;
            const sT = sl.s, sT1 = sNext[k];
            const tauT = sl.tau, tauT1 = tauNext[k];
            const cT = sl.c;
            const mK = make3D(3, LxK, LyK, false);
            const thK = make3D(3, LxK, LyK, 0);

            for (let x = 0; x < LxK; x++) {
                for (let y = 0; y < LyK; y++) {
                    const [dx00, dy00] = MESSAGE_OFFSETS[0];
                    const vote00 = toomVote(sl.m[0], dx00, dy00, x, y, LxK, LyK);
                    const coupling = sl.m[0][x][y] && vote00;
                    const cVal = cT[x][y];

                    if (timed) {
                        // Reduce candidates directly instead of allocating
                        // timer/neighbor arrays at every site and channel.
                        let hasSource = false, sourceTimer = Infinity;
                        if (sT1[x][y]) {
                            hasSource = true;
                            sourceTimer = Math.min(sourceTimer, tauT1[x][y]);
                        }
                        if (sT[x][y] && tauT[x][y] + 1 < t0) {
                            hasSource = true;
                            sourceTimer = Math.min(sourceTimer, tauT[x][y] + 1);
                        }

                        for (let idx = 0; idx < 3; idx++) {
                            const [dx, dy] = MESSAGE_OFFSETS[idx];
                            const messageT = sl.m[idx], thetaT = sl.th[idx];
                            let hasCandidate = hasSource, timer = sourceTimer;

                            if (cVal < growthWindow) {
                                let growthTimer = Infinity;
                                if (readBool(messageT, x + dx, y, LxK, LyK)) {
                                    const neighborTimer = readInt(thetaT, x + dx, y, LxK, LyK);
                                    if (neighborTimer < t0 - 1) growthTimer = neighborTimer;
                                }
                                if (readBool(messageT, x, y + dy, LxK, LyK)) {
                                    const neighborTimer = readInt(thetaT, x, y + dy, LxK, LyK);
                                    if (neighborTimer < t0 - 1) {
                                        growthTimer = Math.min(growthTimer, neighborTimer);
                                    }
                                }
                                if (growthTimer < Infinity) {
                                    hasCandidate = true;
                                    timer = Math.min(timer, 1 + growthTimer);
                                }
                            }

                            const voteIj = (idx === 0) ? vote00 : toomVote(messageT, dx, dy, x, y, LxK, LyK);
                            const persistence = messageT[x][y] && (thetaT[x][y] < t0 - 1) && (voteIj || coupling);
                            if (persistence) {
                                hasCandidate = true;
                                timer = Math.min(timer, thetaT[x][y] + 1);
                            }

                            if (hasCandidate) {
                                mK[idx][x][y] = true;
                                thK[idx][x][y] = timer;
                            }
                        }
                    } else {
                        const sSource = sT1[x][y] || sT[x][y];
                        for (let idx = 0; idx < 3; idx++) {
                            const [dx, dy] = MESSAGE_OFFSETS[idx];
                            const messageT = sl.m[idx];
                            let growth = false;
                            if (cVal < growthWindow) {
                                growth = readBool(messageT, x + dx, y, LxK, LyK) || readBool(messageT, x, y + dy, LxK, LyK);
                            }
                            const voteIj = (idx === 0) ? vote00 : toomVote(messageT, dx, dy, x, y, LxK, LyK);
                            const persistence = messageT[x][y] && (voteIj || coupling);
                            mK[idx][x][y] = sSource || growth || persistence;
                        }
                    }
                }
            }

            mNext[k] = mK;
            thetaNext[k] = thK;
            cNext[k] = sl.c.map(row => row.map(v => (v + 1) % q));
        }

        return { mNext, thetaNext, cNext };
    }

    // -----------------------------------------------------------------
    // Erasure-only ablation: extra message-sector sub-steps with growth
    // disabled, run after each slice's own real update (task spec, not
    // part of the cited paper excerpt). Mirrors
    // anim/cg_streaming_surface.py's erasure_substep exactly -- see that
    // function's docstring for the full derivation of why growth and the
    // timed-slice timer cap are both dropped unconditionally, why
    // defect-sourcing is kept as a plain `sl.s` read with no timer logic,
    // and why "message timers frozen" and "0 wherever unset" never
    // conflict. Reuses the same toomVote()/offsets() primitives as
    // _messageUpdate()'s own persistence check, so the real per-round
    // update and this ablation cannot silently drift on what "a message
    // survives" means.
    // -----------------------------------------------------------------
    _erasureSubstep(sl, LxK, LyK) {
        const mNext = make3D(3, LxK, LyK, false);
        const thNext = make3D(3, LxK, LyK, 0);

        for (let x = 0; x < LxK; x++) {
            for (let y = 0; y < LyK; y++) {
                const isDefect = !!sl.s[x][y];
                const [dx00, dy00] = offsets(0, 0);
                const vote00 = toomVote(sl.m[0], dx00, dy00, x, y, LxK, LyK);
                const coupling = !!sl.m[0][x][y] && vote00;
                for (let idx = 0; idx < 3; idx++) {
                    const [i, j] = MESSAGE_CHANNELS[idx];
                    const [dx, dy] = offsets(i, j);
                    const voteIj = (idx === 0) ? vote00 : toomVote(sl.m[idx], dx, dy, x, y, LxK, LyK);
                    const persistence = !!sl.m[idx][x][y] && (voteIj || coupling);
                    const newBit = isDefect || persistence;
                    mNext[idx][x][y] = newBit;
                    if (newBit) thNext[idx][x][y] = sl.th[idx][x][y];
                }
            }
        }

        return { mNext, thNext };
    }

    // -----------------------------------------------------------------
    // Open-boundary splitting step (main.tex:2298-2327, 2808-2821,
    // 3511-3522, 5546-5553; reader's choices 1-4). Applied independently
    // per slice at that slice's own coarse resolution.
    // -----------------------------------------------------------------
    // Explicit, documented deviation from the paper's literal text (found
    // via the Python module's drain-then-read tests). main.tex's "Center
    // sites" bullet states message copying at the center is
    // UNCONDITIONAL: "the messages are copied rather than translated --
    // that is, after the step, both the original site and its outward
    // neighbor carry a copy of the message," with no stated exception.
    // This module deviates: the center-site message RETENTION below is
    // instead skipped when that same site ALSO currently hosts a live
    // defect being evacuated this split (sl.s[x][y] true) -- the one-line
    // rule actually implemented is `retainHere = isCenter && !sl.s[x][y]`
    // (copy the message at a center site UNLESS that site's own defect is
    // departing this split), not the paper's unconditional copy.
    // Mechanism this fixes: unconditional retention creates a self
    // -referential ghost message -- a lone defect sitting exactly at a
    // center site sources its own messages, so evacuating its defect while
    // still retaining a copy of that same message at the vacated site
    // leaves a message there with no source but the defect that just
    // left. The very next sub-step of the same tick then reads that
    // leftover message and pulls the defect straight back -- repeating
    // forever, a permanent stuck oscillation. See the matching fix and
    // full derivation (including why the paper's own bridge-preservation
    // motivation for retention is unaffected by this exception) in
    // anim/cg_streaming_surface.py's splitting_step docstring.
    _splittingStep(sl, LxK, LyK, timed, onMove = null, k = 0) {
        const center = Math.floor(LxK / 2);
        const newM = make3D(3, LxK, LyK, false);
        const newTh = timed ? make3D(3, LxK, LyK, 0) : null;

        for (let x = 0; x < LxK; x++) {
            const target = x < center ? x - 1 : x + 1;
            const isCenter = (x === center - 1 || x === center);
            const inBounds = target >= 0 && target < LxK;
            if (!inBounds && !isCenter) continue;
            for (let y = 0; y < LyK; y++) {
                const retainHere = isCenter && !sl.s[x][y];
                for (let idx = 0; idx < 3; idx++) {
                    if (!sl.m[idx][x][y]) continue;
                    const thVal = timed ? sl.th[idx][x][y] : 0;
                    if (inBounds) {
                        newM[idx][target][y] = true;
                        if (timed) newTh[idx][target][y] = thVal;
                    }
                    if (retainHere) {
                        newM[idx][x][y] = true;
                        if (timed) newTh[idx][x][y] = thVal;
                    }
                }
            }
        }

        const newEx = copy2D(sl.e_x); // shape [LxK+1, LyK]
        const candCount = make2D(LxK, LyK, 0);
        const candMinTau = make2D(LxK, LyK, LARGE_TIMER);
        let condensed = 0;
        for (let x = 0; x < LxK; x++) {
            for (let y = 0; y < LyK; y++) {
                if (!sl.s[x][y]) continue;
                let target;
                if (x < center) {
                    newEx[x][y] = !newEx[x][y]; // edge immediately to x's left
                    target = x - 1;
                } else {
                    newEx[x + 1][y] = !newEx[x + 1][y]; // edge immediately to x's right
                    target = x + 1;
                }
                if (target >= 0 && target < LxK) {
                    candCount[target][y] += 1;
                    if (onMove) onMove({
                        from: { level: k, rx: x, ry: y },
                        to: { level: k, rx: target, ry: y },
                        kind: 'split',
                    });
                    if (timed) candMinTau[target][y] = Math.min(candMinTau[target][y], sl.tau[x][y]);
                } else {
                    condensed += 1;
                    if (onMove) onMove({
                        from: { level: k, rx: x, ry: y },
                        // Half-index coordinates end at the actual lattice
                        // edge, half a slice pitch beyond the last site.
                        to: { level: k, rx: target < 0 ? -0.5 : LxK - 0.5,
                            ry: y, boundary: target < 0 ? 'left' : 'right' },
                        kind: 'boundary',
                    });
                }
            }
        }

        const newS = make2D(LxK, LyK, false);
        for (let x = 0; x < LxK; x++) {
            for (let y = 0; y < LyK; y++) newS[x][y] = (candCount[x][y] % 2) === 1;
        }

        sl.m = newM;
        sl.e_x = newEx;
        sl.s = newS;
        if (timed) {
            sl.th = newTh;
            const newTau = make2D(LxK, LyK, 0);
            for (let x = 0; x < LxK; x++) {
                for (let y = 0; y < LyK; y++) {
                    if (newS[x][y] && candMinTau[x][y] < LARGE_TIMER) newTau[x][y] = candMinTau[x][y];
                }
            }
            sl.tau = newTau;
        }
        return condensed;
    }

    // Splits every slice whose rule *also* fires this step (reader's choice
    // 2: both t % qs === 0, checked by the caller, and t % n**k === 0,
    // checked here per slice).
    _applySplitting(onMove = null) {
        const condensations = new Array(this.K).fill(0);
        for (let k = 0; k < this.K; k++) {
            const nk = Math.pow(this.n, k);
            if (this.t % nk !== 0) continue;
            const [LxK, LyK] = this.sizeOf(k);
            condensations[k] = this._splittingStep(this.slices[k], LxK, LyK, k < this.K - 1, onMove, k);
        }
        return condensations;
    }

    // -----------------------------------------------------------------
    // One full update from time t to t+1 (main.tex:5054-5058, plus the
    // splitting insertion of 3511-3522/5546-5553).
    // -----------------------------------------------------------------
    // The optional observer reports defect moves, including condensation,
    // before arrival parity hides them through annihilation or replacement.
    // Coordinates belong to each slice, so one unit at level k spans n**k
    // fine cells. Boundary targets use rx=-0.5 or LxK-0.5 so they end at
    // the lattice edge. In-bounds split shifts report kind 'split' before
    // the ordinary kind 'street' moves from the shifted sites. It adds no
    // state or changes to decoder dynamics.
    step(onMove = null) {
        const K = this.K;
        const didSplit = this.t > 0 && this.t % this.qs === 0;
        const condensations = didSplit ? this._applySplitting(onMove) : new Array(K).fill(0);

        const phiNext = this._drawPhi();
        this._lastPhi = phiNext;

        const tNext = this.t + 1;
        const promotedIn = new Array(K).fill(0);
        const due = this.pending.get(tNext);
        if (due) for (const [kTarget] of due) promotedIn[kTarget] += 1;

        const { eChildNext, rhoNext } = this._recordIntake();
        const { exNext, eyNext, sNext, tauNext, newPending } = this._defectUpdate(phiNext, rhoNext, onMove);
        const { mNext, thetaNext, cNext } = this._messageUpdate(sNext, tauNext);

        const pendingNext = new Map();
        for (const [tt, recs] of this.pending) {
            if (tt !== tNext) pendingNext.set(tt, recs);
        }
        for (const [tt, recs] of newPending) {
            if (!pendingNext.has(tt)) pendingNext.set(tt, []);
            pendingNext.get(tt).push(...recs);
        }

        const newSlices = new Array(K);
        for (let k = 0; k < K; k++) {
            newSlices[k] = {
                Lx: this.slices[k].Lx, Ly: this.slices[k].Ly,
                e_x: exNext[k], e_y: eyNext[k], e_child: eChildNext[k],
                s: sNext[k], tau: tauNext[k],
                m: mNext[k], th: thetaNext[k], c: cNext[k],
                rho: rhoNext[k],
            };
        }

        // erasureMoves extra message-only sub-steps (task spec, not part of
        // the cited paper excerpt): applied to every slice by default,
        // or only slices that updated when per-slice cadence is enabled,
        // after the real update is fully resolved, at the SAME t (stepCount/t do
        // not advance for these). Each round reads the previous round's
        // m/th and produces the next, so erasureMoves=2 means two full
        // rounds of persistence/erosion compound -- not one round applied
        // twice to the same input. erasureMoves=0 (the default) makes this
        // loop a no-op: bit-identical to this module's behavior before
        // erasureMoves existed.
        for (let move = 0; move < this.erasureMoves; move++) {
            for (let k = 0; k < K; k++) {
                // Match _defectUpdate/_messageUpdate's pre-increment time.
                if (SURFACE_CG_ERASURE_PER_SLICE_CADENCE
                    && this.t % Math.pow(this.n, k) !== 0) continue;
                const [LxK, LyK] = this.sizeOf(k);
                const { mNext: mErased, thNext: thErased } = this._erasureSubstep(newSlices[k], LxK, LyK);
                newSlices[k].m = mErased;
                newSlices[k].th = thErased;
            }
        }

        this.slices = newSlices;
        this.pending = pendingNext;
        this.t = tNext;
        this.stepCount++;
        this.lastDidSplit = didSplit;
        this.lastCondensations = condensations;
        this.lastPromotions = promotedIn;
    }

    // -----------------------------------------------------------------
    // Physical correction expansion -- main.tex:4977-4994; reader's choices 4-5.
    // -----------------------------------------------------------------
    expandCorrection() {
        const { Lx, Ly, n } = this;
        const Ex = make2D(Lx + 1, Ly, false), Ey = make2D(Lx, Ly, false);

        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k];
            const [LxK, LyK] = this.sizeOf(k);

            for (let r = 0; r <= LxK; r++) {
                for (let y = 0; y < LyK; y++) {
                    if (!sl.e_x[r][y]) continue;
                    const physY = physCenter(k, n, 0, y)[1];
                    const [left, right] = xEdgeEndpoints(k, n, LxK, Lx, r, y);
                    applyXRun(Ex, physY, left, right);
                }
            }
            for (let x = 0; x < LxK; x++) {
                for (let r = 1; r < LyK; r++) { // r=0 never set (no qy[x,0])
                    if (!sl.e_y[x][r]) continue;
                    const physX = physCenter(k, n, x, 0)[0];
                    const bottom = physCenter(k, n, x, r - 1)[1];
                    const top = physCenter(k, n, x, r)[1];
                    applyYRun(Ey, physX, bottom, top);
                }
            }

            if (k > 0) {
                for (let rx = 0; rx < LxK; rx++) {
                    for (let ry = 0; ry < LyK; ry++) {
                        for (let ax = 0; ax < n; ax++) {
                            for (let ay = 0; ay < n; ay++) {
                                if (!sl.e_child[rx][ry][ax][ay]) continue;
                                const parent0 = physCenter(k, n, rx, ry);
                                const child0 = physCenter(k - 1, n, n * rx + ax, n * ry + ay);
                                applyXRun(Ex, child0[1], child0[0], parent0[0]); // x-leg at child's row
                                applyYRun(Ey, parent0[0], child0[1], parent0[1]); // y-leg at parent's column
                            }
                        }
                    }
                }
            }
        }

        return { Ex, Ey };
    }

    // -----------------------------------------------------------------
    // Stats-panel / generic-decoder-interface methods
    // -----------------------------------------------------------------

    // Include every level's stored defects and buffered intakes. Count s
    // and rho independently, before the next slice update combines them.
    getSyndromeCount() {
        let count = 0;
        for (const sl of this.slices) {
            for (let x = 0; x < sl.Lx; x++) {
                for (let y = 0; y < sl.Ly; y++) {
                    if (sl.s[x][y]) count++;
                    if (sl.rho?.[x][y]) count++;
                }
            }
        }
        return count;
    }

    // Residual weight: Hamming weight of (bx xor Ex, by xor Ey).
    getErrorCount() {
        const { Ex, Ey } = this.expandCorrection();
        const Lx = this.Lx, Ly = this.Ly;
        let count = 0;
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) if (this.bx[x][y] !== Ex[x][y]) count++;
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) if (this.by[x][y] !== Ey[x][y]) count++;
        }
        return count;
    }

    /**
     * Live defects in the residual syndrome (not the residual edge weight
     * above, which accumulates harmless closed loops and random-walks
     * upward under continuous noise -- see the module header comment).
     * This is the meaningful per-round decoder-health signal; mirrors
     * toric_streaming.js's/surface_streaming.js's identical getter and the
     * same "residual defects" figure already shown in render()'s own
     * caption line.
     */
    getResidualDefectCount() {
        const { Ex, Ey } = this.expandCorrection();
        const Lx = this.Lx, Ly = this.Ly;
        const residualX = make2D(Lx + 1, Ly, false), residualY = make2D(Lx, Ly, false);
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) residualX[x][y] = this.bx[x][y] !== Ex[x][y];
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) residualY[x][y] = this.by[x][y] !== Ey[x][y];
        }
        const residualSyndrome = syndromeOpen(residualX, residualY, Lx, Ly);
        let count = 0;
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) if (residualSyndrome[x][y]) count++;
        }
        return count;
    }

    getSystemDefectCount() {
        return this.getResidualDefectCount();
    }

    // Integration compatibility: main.js's clock-period slider reads/writes
    // currentDecoder.clockPeriod generically (see toric_cg_streaming.js /
    // surface_streaming.js for the identical pattern); alias the internal
    // q field so that control actually takes effect instead of silently
    // no-op'ing. Floor of 2 matches the constructor's own clamp above.
    get clockPeriod() { return this.q; }
    set clockPeriod(value) {
        const q = Math.round(value);
        if (Number.isFinite(q) && q >= 2) this.q = q;
    }

    // Integration compatibility, continued: main.js's state card shows a
    // "clock" row only when `.clock` is a finite number. this.t (the
    // paper's internal absolute-time index) and this.q (clockPeriod) both
    // already exist but no single representative clock value did; mirrors
    // repetition_streaming.js's/surface_streaming_3d.js's identical
    // `get clock()` (TASK 4ds/4dr). A pure accessor, not part of any
    // dynamics/rule logic above.
    get clock() { return this.t % this.q; }

    // Integration compatibility: main.js's handleCanvasClick() calls this
    // unconditionally in Manual Placement mode. A K+1-panel pyramid driven
    // by ongoing injected phenomenological noise has no single lattice for
    // a click to address (matching toric_streaming.js / surface_streaming.js
    // / toric_cg_streaming.js, which take the same no-op for the same
    // reason); this only prevents a TypeError on click.
    toggleErrorAtPosition() {}

    hasMessages() {
        for (const sl of this.slices) {
            for (let idx = 0; idx < 3; idx++) {
                for (let x = 0; x < sl.Lx; x++) {
                    for (let y = 0; y < sl.Ly; y++) if (sl.m[idx][x][y]) return true;
                }
            }
        }
        return false;
    }

    // Drain every level, its buffered intake and every scheduled promotion.
    // A final perfect measurement must also close the previous round's errors.
    isQuiescent() {
        if (this._noiseEnabled && (this.pPhys > 0 || this.pMeas > 0)) return false;
        if (this._lastMeasurementHasError || this.pending.size > 0) return false;
        for (const sl of this.slices) {
            for (let x = 0; x < sl.Lx; x++) {
                for (let y = 0; y < sl.Ly; y++) if (sl.s[x][y] || sl.rho?.[x][y]) return false;
            }
        }
        return !this.hasMessages();
    }

    checkLogicalError() {
        const { Ex, Ey } = this.expandCorrection();
        const Lx = this.Lx, Ly = this.Ly;
        const residualX = make2D(Lx + 1, Ly, false), residualY = make2D(Lx, Ly, false);
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) residualX[x][y] = this.bx[x][y] !== Ex[x][y];
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) residualY[x][y] = this.by[x][y] !== Ey[x][y];
        }
        const residualSyndrome = syndromeOpen(residualX, residualY, Lx, Ly);
        let residualClear = true;
        for (let x = 0; x < Lx && residualClear; x++) {
            for (let y = 0; y < Ly; y++) {
                if (residualSyndrome[x][y]) { residualClear = false; break; }
            }
        }
        // Parity of residual qx along the fixed geometric COLUMN x0 (sum
        // over y), NOT a fixed row (sum over x): a bulk "vertex star" (the
        // code's other stabilizer generator, distinct from this decoder's
        // own defect-syndrome check) flips exactly two qx entries in the
        // SAME column and none in any other, so column parity is invariant
        // under it (and under its weight-3 truncation at the rough
        // boundaries x=0/x=Lx) -- whereas it flips one qx entry in each of
        // two DIFFERENT rows, which is exactly why a row-based parity is
        // NOT gauge-invariant. Mirrors anim/surface_cc.py's
        // logical_error_from_qx exactly.
        let logical = false;
        for (let y = 0; y < Ly; y++) logical = logical !== residualX[this.x0][y];
        const hasError = !residualClear || logical;
        const result = { hasError, logical, residualClear };
        if (!residualClear) result.description = 'residual syndrome is not clear';
        else if (logical) result.description = 'nontrivial logical parity on the cleared residual (column x0=0)';
        return result;
    }

    // -----------------------------------------------------------------
    // Rendering
    // TASK 4ds: restyled to match repetition2.js's/toric2.js's/surface2.js's
    // shared visual language, the same way TASK 4dr did for
    // surface_streaming_3d.js -- every on-canvas caption/panel title/
    // stats-line/legend removed (the state card and HTML legend carry
    // that information now), every glyph/colour/line-weight choice
    // reusing the shared constants/helpers imported above. The two-panel
    // layout itself (hierarchy panel with its nested per-level grids/
    // block outlines, residual panel) and every
    // dynamics method above this section are all unchanged -- this task
    // only ever touches drawing code below this point.
    // -----------------------------------------------------------------

    // One row of layout constants, shared by _layout()/render() so the
    // two never drift apart. TASK 4ds: topLabelH/titleH/statsH/legendH
    // (which reserved room for the now-removed "t = N" caption, panel
    // titles, stats line, and on-canvas legend) replaced with topGap
    // (13px, matching every other restyled module's own top gap) and a
    // small bottomMargin; leftMargin widened asymmetrically -- see
    // _layout()'s own comment below. TASK 4dv: rightMargin widened the
    // same way (225px card footprint + 8px buffer, rounded to 233) --
    // see surface_streaming_3d.js's own identical _layout() comment for
    // the full derivation (same .overlay-stack cards, same worst-case
    // reasoning, same live-measured 196.25px card width / 28px inset).
    // TASK 4ew: leftMargin/rightMargin here are the SAME worst-case
    // reserve surface_streaming_3d.js's own _layout() used to fall back to
    // unconditionally (see that file's identical derivation comment) --
    // this module never had a "live" branch that measures the cards' real
    // position, only ever this fixed guess, so _layout() below now takes
    // an overlayRects argument (forwarded from render()/getTitleAnchor())
    // solely to read its noOverlayCards flag and drop both reserves to 0
    // under the three-pillar layout, where no card exists anywhere to
    // reserve room for. Unchanged (still exactly 200/233) for every other
    // caller, including this file's own Node test harness, which never
    // passes a third argument at all.
    static get _CHROME() {
        return { topGap: 13, bottomMargin: 10, leftMargin: 200, rightMargin: 233, panelGap: 20 };
    }

    // Two panels only (hierarchy lattice, residual), side by side or
    // stacked -- whichever gives the larger cell size for this canvas.
    // Both panels share the same Lx:Ly aspect ratio, so comparing raw
    // panel width is equivalent to comparing cell size (panelW / Lx).
    //
    // TASK 4ds: leftMargin widened from the original symmetric 12px
    // margin, matching TASK 4dr's identical fix for surface_streaming_3d.js
    // (see that file's own _layout() comment for the full derivation) --
    // the hierarchy panel's own left columns were found, by live pixel
    // scan, sitting under the HTML description card, which sits at a
    // fixed `left: 8px, max-width: 180px` within .canvas-area independent
    // of this module's own canvas-local layout. 200px clears the card's
    // worst-case right edge (8+180=188) plus a small buffer.
    //
    // Top-anchored at exactly topGap (not vertically centred within the
    // available height), matching every other restyled module's own
    // _layout() convention -- any leftover height simply goes unused
    // below the panels.
    _layout(canvasWidth, canvasHeight, overlayRects) {
        const { topGap, bottomMargin, leftMargin: leftMarginDefault, rightMargin: rightMarginDefault, panelGap } = SurfaceCGStreamingDecoder._CHROME;
        // TASK 4ew: see _CHROME's own comment above.
        const leftMargin = overlayRects?.noOverlayCards ? 0 : leftMarginDefault;
        const rightMargin = overlayRects?.noOverlayCards ? 0 : rightMarginDefault;
        const aspect = this.Ly / this.Lx; // panelH = panelW * aspect

        const availW = canvasWidth - leftMargin - rightMargin;
        const availH = canvasHeight - topGap - bottomMargin;

        let sbsW = (availW - panelGap) / 2;
        let sbsH = sbsW * aspect;
        if (sbsH > availH) { sbsH = availH; sbsW = sbsH / aspect; }

        let stkW = availW;
        let stkH = stkW * aspect;
        const stkAvailH = (availH - panelGap) / 2;
        if (stkH > stkAvailH) { stkH = stkAvailH; stkW = stkH / aspect; }

        const useStacked = stkW > sbsW;
        const panelW = Math.max(20, useStacked ? stkW : sbsW);
        const panelH = Math.max(20, useStacked ? stkH : sbsH);

        const panels = [];
        if (!useStacked) {
            const totalW = panelW * 2 + panelGap;
            const left0 = leftMargin + (availW - totalW) / 2;
            panels.push({ left: left0, top: topGap, w: panelW, h: panelH });
            panels.push({ left: left0 + panelW + panelGap, top: topGap, w: panelW, h: panelH });
        } else {
            const left0 = leftMargin + (availW - panelW) / 2;
            panels.push({ left: left0, top: topGap, w: panelW, h: panelH });
            panels.push({ left: left0, top: topGap + panelH + panelGap, w: panelW, h: panelH });
        }

        return {
            panels,
            // TASK 4ds: centred within availW by construction (same
            // derivation as TASK 4dr's own stackCenterX) -- correct for
            // both the side-by-side and stacked cases, since the pair of
            // panels always shares the same combined horizontal extent
            // [leftMargin, leftMargin+availW] either way.
            stackCenterX: leftMargin + availW / 2,
        };
    }

    // TASK 4ds: centres the decoder title on the two panels' own combined
    // horizontal centre (matching getTitleAnchor()'s role in every other
    // restyled module). getDescriptionAnchor() is deliberately NOT
    // defined: main.js's own default for a decoder without one
    // ({ top: DESCRIPTION_TOP_CSS }, TASK 4de) already applies.
    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        return { centerX: this._layout(canvasWidth, canvasHeight, overlayRects).stackCenterX };
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showMessages = options.showMessages === true; // default off, per spec -- unchanged from before this task
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;
        const showGrid = options.showGrid !== false;
        const layout = this._layout(canvasWidth, canvasHeight, options.overlayRects);

        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        this._drawHierarchyPanel(ctx, layout.panels[0], showMessages, showSyndrome, showErrors, showGrid);
        this._drawResidualPanel(ctx, layout.panels[1], showSyndrome, showErrors, showGrid);
        ctx.restore();
    }

    // Like surface2, only smooth (top/bottom) edges have a black frame.
    // A vertical black stroke would overpaint the rough boundary's colour.
    _drawPanelOutline(ctx, panel) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(panel.w, 0);
        ctx.moveTo(0, panel.h); ctx.lineTo(panel.w, panel.h);
        ctx.stroke();
    }

    _drawRoughBoundaries(ctx, panel) {
        // Rough (condensing) boundaries at x=0 and x=Lx -- reader's choice
        // 1: these carry the splitting-step machinery; y does not. Shared
        // by every level (main.tex:5546-5553 adaptation): a coarse-level
        // boundary site is simply the block touching this same line.
        // Match surface2's fixed CSS-pixel width and half-width inset.
        // A panel can touch the canvas edge, which clips an uninset stroke
        // even without a panel-local clip. Keep its full width inside.
        ctx.strokeStyle = ROUGH_BOUNDARY_COLOR;
        ctx.lineWidth = ROUGH_BOUNDARY_WIDTH;
        const inset = ROUGH_BOUNDARY_WIDTH / 2;
        ctx.beginPath(); ctx.moveTo(inset, 0); ctx.lineTo(inset, panel.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(panel.w - inset, 0); ctx.lineTo(panel.w - inset, panel.h); ctx.stroke();
    }

    // Renders the ENTIRE hierarchy on one Lx x Ly physical lattice, using
    // the paper's block-centre placement (main.tex:4931: a slice-k site r
    // is identified with the physical site n^k*r + floor(n^k/2)*(x^+y^),
    // the centre of its n^k x n^k block -- main.tex:5554-5575's "natural
    // coarse-grained placement", stated for the torus). Adapted to the
    // open patch (explicit choices, since the paper only states this for
    // periodic boundaries): blocks tile the patch starting from its
    // lower-left physical corner (0,0) -- i.e. a level-k block's extent is
    // exactly [n^k*rx, n^k*(rx+1)) x [n^k*ry, n^k*(ry+1)) in physical
    // coordinates, with NO wraparound/offset, so the block grid always
    // lands exactly on the patch's own boundaries; the rough boundaries
    // x=0 and x=Lx are literally shared by every level (they sit at the
    // same physical pixel column regardless of k, since Lx is a multiple
    // of n^k for every k<K); a "coarse boundary site" is simply whichever
    // block touches x=0 or x=Lx -- no separate boundary bookkeeping is
    // needed for the drawing itself (unlike the dynamics' own splitting
    // step, this is a pure visualization of already-computed state).
    _drawHierarchyPanel(ctx, panel, showMessages, showSyndrome, showErrors, showGrid) {
        const { Lx, Ly, K, n } = this;
        const cellW = panel.w / Lx, cellH = panel.h / Ly;
        const cellMin = Math.min(cellW, cellH);
        // TASK 4ds: shared base line-weight unit (same formula as every
        // other restyled module's own grid-line width), used below for
        // the fine grid and (scaled by level) the
        // per-level block outlines.
        const gridLineWidth = Math.max(1, Math.round(cellMin / 18));

        ctx.save();
        ctx.translate(panel.left, panel.top);

        // Shared solid/striped tiles fill each level's physical block.
        // Coarsest-first preserves finer blocks; grids and orbs remain
        // above every fill, and messages have no separate outlines.
        if (showMessages) {
            for (let k = K - 1; k >= 0; k--) {
                const [LxK, LyK] = this.sizeOf(k);
                const nk = Math.pow(n, k);
                const sl = this.slices[k];
                for (let rx = 0; rx < LxK; rx++) {
                    for (let ry = 0; ry < LyK; ry++) {
                        const mask = (sl.m[0][rx][ry] ? 1 : 0)
                            | (sl.m[1][rx][ry] ? 2 : 0) | (sl.m[2][rx][ry] ? 4 : 0);
                        if (!mask) continue;
                        const bx0 = rx * nk * cellW, by0 = panel.h - (ry + 1) * nk * cellH;
                        drawMessageCell(ctx, bx0, by0, bx0 + nk * cellW, by0 + nk * cellH, mask);
                    }
                }
            }
        }

        // Fine physical (level-0) grid -- TASK 4ds: shared grey/width
        // (was this module's own rgb(210,210,210)/cellMin-50 literal),
        // and now an interior line gated on showGrid (previously always
        // drawn regardless of the grid toggle) -- the panel's own black
        // outline (_drawPanelOutline, below) is unaffected by this toggle.
        if (showGrid) {
            ctx.strokeStyle = COLOR_GRID;
            ctx.lineWidth = gridLineWidth;
            for (let x = 0; x <= Lx; x++) {
                ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, panel.h); ctx.stroke();
            }
            for (let y = 0; y <= Ly; y++) {
                ctx.beginPath(); ctx.moveTo(0, panel.h - y * cellH); ctx.lineTo(panel.w, panel.h - y * cellH); ctx.stroke();
            }

            // Nested coarse grids, one per level k=1..K-1, at spacing n^k,
            // heavier for coarser k, in that level's own colour (the
            // paper's nested-hierarchy figure, main.tex:4518-4618,
            // fig:toric-coarse-grained-layout) -- colours/weights
            // unchanged from before this task, now gated on showGrid too
            // (an interior structural grid, same reasoning as the fine
            // grid above).
            for (let k = 1; k < K; k++) {
                const nk = Math.pow(n, k);
                ctx.strokeStyle = LEVEL_COLORS[k % LEVEL_COLORS.length];
                ctx.lineWidth = Math.max(1, cellMin * 0.05 * (1 + k));
                ctx.globalAlpha = 0.5;
                for (let x = 0; x <= Lx; x += nk) {
                    ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, panel.h); ctx.stroke();
                }
                for (let y = 0; y <= Ly; y += nk) {
                    ctx.beginPath(); ctx.moveTo(0, panel.h - y * cellH); ctx.lineTo(panel.w, panel.h - y * cellH); ctx.stroke();
                }
                ctx.globalAlpha = 1;
            }
        }

        // Occupied coarse-block outlines are structural ink, like grids.
        // Finish them before the boundary so they cannot thin its stroke.
        if (showSyndrome) {
            for (let k = 1; k < K; k++) {
                const [LxK, LyK] = this.sizeOf(k);
                const nk = Math.pow(n, k), sl = this.slices[k];
                ctx.strokeStyle = LEVEL_COLORS[k % LEVEL_COLORS.length];
                ctx.lineWidth = gridLineWidth * (1 + k);
                for (let rx = 0; rx < LxK; rx++) {
                    for (let ry = 0; ry < LyK; ry++) {
                        if (!sl.s[rx][ry]) continue;
                        const blockPx = rx * nk * cellW, blockPy = panel.h - (ry + 1) * nk * cellH;
                        ctx.strokeRect(blockPx + 1, blockPy + 1, nk * cellW - 2, nk * cellH - 2);
                    }
                }
            }
        }
        this._drawRoughBoundaries(ctx, panel);
        this._drawPanelOutline(ctx, panel);

        // TASK 4ed: the detector-event crosses (slice 0 only, this._lastPhi)
        // that used to be drawn here are removed entirely, per the user's
        // own request, for consistency with surface_streaming_3d.js.
        // this._lastPhi itself is untouched -- core dynamics state, not a
        // drawing-only concern.

        // Defects at every level, drawn at their block's physical centre
        // as the shared anyon orb (TASK 4ds: replaces this module's own
        // previous radial-gradient circle -- same glyph, same
        // DEFECT_ORB_RADIUS/OUTLINE, drawn at cellMin scale like
        // surface_streaming_3d.js's identical adaptation), with a block
        // outline in the level's colour as the level cue for k>0 (k=0's
        // "block" is a single physical cell, already delineated by the
        // fine grid, so no outline is drawn there -- only the orb, exactly
        // as before). TASK 4ds: the block outline's own width now derives
        // from the shared gridLineWidth base unit (scaled by level, same
        // (1+k) factor as before) instead of an independent cellMin*0.08
        // literal -- a deliberate interpretation, disclosed in this task's
        // own report. Per team-lead's own earlier instruction: the orb
        // itself stays the same base size at every level (not scaled with
        // block size).
        // Gated on showSyndrome, same as every other module's own defect
        // glyphs.
        if (showSyndrome) {
            for (let k = 0; k < K; k++) {
                const [LxK, LyK] = this.sizeOf(k);
                const nk = Math.pow(n, k);
                const sl = this.slices[k];
                for (let rx = 0; rx < LxK; rx++) {
                    for (let ry = 0; ry < LyK; ry++) {
                        if (!sl.s[rx][ry]) continue;
                        const blockPx = rx * nk * cellW, blockPy = panel.h - (ry + 1) * nk * cellH;
                        const blockW = nk * cellW, blockH = nk * cellH;
                        const cx = blockPx + blockW / 2, cy = blockPy + blockH / 2;
                        drawOrb(ctx, cx, cy, cellMin, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                    }
                }
            }
        }

        ctx.restore();
    }

    _drawResidualPanel(ctx, panel, showSyndrome, showErrors, showGrid) {
        const Lx = this.Lx, Ly = this.Ly;
        const cellW = panel.w / Lx, cellH = panel.h / Ly;
        const cellMin = Math.min(cellW, cellH);
        const gridLineWidth = Math.max(1, Math.round(cellMin / 18));
        const { Ex, Ey } = this.expandCorrection();
        const residualX = make2D(Lx + 1, Ly, false), residualY = make2D(Lx, Ly, false);
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) residualX[x][y] = this.bx[x][y] !== Ex[x][y];
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) residualY[x][y] = this.by[x][y] !== Ey[x][y];
        }
        const residualSyndrome = syndromeOpen(residualX, residualY, Lx, Ly);

        ctx.save();
        ctx.translate(panel.left, panel.top);

        // TASK 4ds: shared grey/width, interior lines only (was a
        // per-cell strokeRect at a fixed light grey, always drawn
        // regardless of the grid toggle) -- gated on showGrid now; the
        // panel's own black outline below is always drawn regardless.
        if (showGrid) {
            ctx.strokeStyle = COLOR_GRID;
            ctx.lineWidth = gridLineWidth;
            for (let x = 0; x <= Lx; x++) {
                ctx.beginPath(); ctx.moveTo(x * cellW, 0); ctx.lineTo(x * cellW, panel.h); ctx.stroke();
            }
            for (let y = 0; y <= Ly; y++) {
                ctx.beginPath(); ctx.moveTo(0, panel.h - y * cellH); ctx.lineTo(panel.w, panel.h - y * cellH); ctx.stroke();
            }
        }

        this._drawRoughBoundaries(ctx, panel);
        this._drawPanelOutline(ctx, panel);

        // Residual errors are string pieces joining the centres
        // of the two cells the qubit separates -- NOT links along the
        // shared edge -- so a chain of residual-1 qubits reads as one
        // continuous string between its two endpoint defects, matching
        // the repetition-code decoders' string convention. qx[x,y]: centre
        // of (x-1,y) to centre of (x,y); qy[x,y]: centre of (x,y-1) to
        // centre of (x,y). The two rough-boundary qx columns (x=0, x=Lx)
        // have no cell on the outside, so their piece is a HALF piece: from
        // the cell centre out to the boundary line itself. 'round' caps
        // (not 'butt' or 'square') so consecutive collinear or
        // right-angled pieces join smoothly at their shared cell-centre
        // endpoint without a visible gap or a doubled-up square corner.
        // bx/by are physical errors E; expandCorrection's Ex/Ey are the
        // accumulated decoder flips C. Draw only E XOR C in red, including
        // a spurious correction with C alone, matching the syndrome and
        // statistics. A corrected physical error leaves no string.
        if (showErrors) {
            const wBlue = Math.max(2, Math.round(cellMin / 9));
            const stringWidth = Math.max(1, 1.05 * wBlue);
            const cellCenter = (x, y) => [(x + 0.5) * cellW, panel.h - (y + 0.5) * cellH];
            ctx.lineWidth = stringWidth;
            ctx.lineCap = 'round';
            ctx.strokeStyle = COLOR_ERROR;
            for (let x = 0; x <= Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!residualX[x][y]) continue;
                    let x0, y0, x1, y1;
                    if (x === 0) {
                        [x1, y1] = cellCenter(0, y);
                        x0 = 0; y0 = y1; // boundary line at panel x=0
                    } else if (x === Lx) {
                        [x0, y0] = cellCenter(Lx - 1, y);
                        x1 = panel.w; y1 = y0; // boundary line at panel x=panel.w
                    } else {
                        [x0, y0] = cellCenter(x - 1, y);
                        [x1, y1] = cellCenter(x, y);
                    }
                    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
                }
            }
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!residualY[x][y]) continue;
                    const [x0, y0] = cellCenter(x, y - 1);
                    const [x1, y1] = cellCenter(x, y);
                    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
                }
            }
            ctx.lineCap = 'butt';
        }

        // TASK 4ds: shared anyon orb (was this module's own radial-
        // gradient circle) -- same glyph as the hierarchy panel's own
        // defects; gated on showSyndrome, same as every other module's
        // own defect glyphs (previously always drawn regardless of the
        // toggle).
        if (showSyndrome) {
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!residualSyndrome[x][y]) continue;
                    const cx = (x + 0.5) * cellW, cy = panel.h - (y + 0.5) * cellH;
                    drawOrb(ctx, cx, cy, cellMin, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
            }
        }

        ctx.restore();
    }
}
