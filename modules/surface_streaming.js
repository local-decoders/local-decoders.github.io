// Surface-code streaming decoder (open-boundary translation-invariant
// construction) -- literal JS port of anim/streaming_surface.py.
//
// Paper citations (reference/paper/main.tex), same as the Python module:
//   Streaming overview: 2850-2876.
//   Toric-code streaming construction: definitions 3121-3200; defect-sector
//     Algorithm alg:layered-toric-defect-update 3203-3274; message-sector
//     text 3275-3404; Algorithm alg:layered-toric-message-update 3405-3509.
//   Streaming open-boundary conditions (splitting step applied per slice,
//     before the usual defect/message updates, at t in q_s*Z): 3511-3522.
//   Code-capacity open-boundary definitions (splitting step, even-length
//     convention): repetition code 2298-2327; toric/surface 2808-2821.
//   Code-capacity toric definitions / Algorithm alg:toric-code: 2537-2620.
//
// Generalizing q=3 to general q: the literal streaming algorithm hardcodes
// the q=3 growth window "c in {0,1}" (main.tex:3374,3436,3480); footnote
// 3512 says the surface code needs larger q, so every such gate here reads
// "c < growthWindow", matching the general-q code-capacity rule at
// main.tex:2562.
//
// Two base-rule variants (movementGated, growthWindow). The *formal*
// variant (movementGated=true, growthWindow=q-1) is the algorithm exactly
// as written, gating movement to c===0 (main.tex:3178,3190) with the
// widest growth window the general-q formula allows -- but it is a
// finite-size pathology: gated movement closes a defect pair's distance
// at only 1 site per q steps while growthWindow=q-1 spreads messages at
// (q-1)/q sites per step, so on a finite periodic patch the message front
// can lap around and strike a defect from behind before the intended
// approach arrives (e.g. q=6/movementGated=true/growthWindow=5 on a 16x16
// torus never annihilates a defect pair three sites apart). The
// *numerics-style* variant (movementGated=false, growthWindow=1) --
// movement checked every step, growth only at c===0 -- is what the
// paper's own numerics use (main.tex:2846) and is this module's default,
// matching every other 2D decoder in this codebase. The splitting step is
// unaffected by movementGated -- it always moves every present defect
// unconditionally, independent of clock phase.
//
// Geometry (planar patch, one error species): stabilizers (x,y) for
// x in [0,Lx), y in [0,Ly). qx[x][y] for x in [0,Lx] sits between
// stabilizers (x-1,y) and (x,y); qx[0][y], qx[Lx][y] are rough-boundary
// qubits. qy[x][y] for y in [1,Ly) sits between (x,y-1) and (x,y) (index 0
// is an always-false padding row -- there is no qy[x][0] qubit).
//   s[x][y] = qx[x][y] ^ qx[x+1][y] ^ (qy[x][y] if y>=1) ^ (qy[x][y+1] if y+1<=Ly-1)
// Flipping qx[x][y] moves a defect (x,y)->(x-1,y) (out of the patch at
// x=0); flipping qy[x][y] moves (x,y)->(x,y-1); no downward move from y=0;
// neighbours outside the patch read as trivial (0) messages. Only x carries
// condensing (rough) boundaries with the splitting step; y is a simple
// movement-blocking edge (main.tex:2810 only ever splits one pair of
// boundaries).
//
// Noise: physical bits bx_t, by_t are cumulative (each qubit flips
// independently w.p. pPhys per round); the noisy syndrome is
// s~_t = syndrome(bx_t,by_t) xor meas_t (meas_t ~ Bernoulli(pMeas)); the
// detector event fed to the decoder is phi_t = s~_t xor s~_{t-1}, s~_{-1}=0
// (main.tex:3136-3143). Corrections E are the XOR of every slice's
// correction channel; residual = b xor E; the logical indicator is the
// parity of the residual qx along a fixed COLUMN x0=0 (summed over y -- a
// vertical cut, matching torca.reference.winding_parities' convention),
// gauge-invariant on a syndrome-free residual. A fixed ROW's parity summed
// over x is NOT gauge-invariant (a straight horizontal qx-string is
// syndrome-free but only shows up in its own row's sum) -- see
// anim/streaming_surface.py's "Logical indicator" docstring section for
// the brute-force verification of this.
//
// Noise is generated on demand without a finite horizon. Stopping noise
// sets both effective rates to zero from the next round, retaining the
// configured probabilities for the next Initialize/Reset. A final perfect
// measurement supplies the trailing detector event for any measurement
// error in the previous round before the decoder can become quiescent.

// Message/defect channel index pairs, M_2 = {0,1}^2 \ {(1,1)}.
const CHANNELS = [[0, 0], [0, 1], [1, 0]];
const CHANNEL_KEYS = ['00', '01', '10'];
const CHANNEL_DX = [-1, -1, 1];
const CHANNEL_DY = [-1, 1, -1];
const LARGE_TIMER = 1 << 30;

function offsets(i, j) {
    return [i === 0 ? -1 : 1, j === 0 ? -1 : 1];
}

function chKey(i, j) {
    return `${i}${j}`;
}

function make2D(nx, ny, fill) {
    const out = new Array(nx);
    for (let x = 0; x < nx; x++) out[x] = new Array(ny).fill(fill);
    return out;
}

function copy2D(arr) {
    return arr.map(col => col.slice());
}

// Deterministic PRNG (mulberry32), matching website/js/main.js's convention.
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

// Shared by both message updates. Each bit holds one channel's Toom
// vote, avoiding a votes object (and channel/offset arrays) at every site.
function toomPersistence(sl, x, y, Lx, Ly) {
    return (toomVote(sl.m['00'], -1, -1, x, y, Lx, Ly) ? 1 : 0)
        | (toomVote(sl.m['01'], -1, 1, x, y, Lx, Ly) ? 2 : 0)
        | (toomVote(sl.m['10'], 1, -1, x, y, Lx, Ly) ? 4 : 0);
}

function tK(t0, n, k) {
    return t0 * Math.pow(n, k);
}

function makeSlice(Lx, Ly, timed) {
    const m = {}, th = {};
    for (const [i, j] of CHANNELS) {
        m[chKey(i, j)] = make2D(Lx, Ly, false);
        th[chKey(i, j)] = make2D(Lx, Ly, 0);
    }
    return {
        timed,
        s: make2D(Lx, Ly, false),
        tau: make2D(Lx, Ly, 0),
        ex: make2D(Lx + 1, Ly, false),
        ey: make2D(Lx, Ly, false),
        m,
        th,
        c: make2D(Lx, Ly, 0),
    };
}

// Exported (in addition to being used internally) so exactness/coverage
// tests can exercise it directly against explicit qx/qy patterns -- this
// is exactly the environment-generator function a transposed-index bug
// would hide in (see check_streaming_surface.mjs's single-edge-flip check).
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

export class SurfaceStreamingDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        this.Lx = L;
        this.Ly = opts.Ly !== undefined ? opts.Ly : L;
        this.L = L; // kept for compatibility with the generic size slider
        this.q = clockPeriod;
        // Numerics-style default (main.tex:2846): growth only at c===0,
        // movement checked every step. Pass movementGated:true and
        // growthWindow: q-1 for the formal algorithm as literally written
        // (see this file's header comment for why that combination is a
        // finite-size pathology and not the default).
        this.growthWindow = opts.growthWindow !== undefined ? opts.growthWindow : 1;
        this.movementGated = opts.movementGated !== undefined ? opts.movementGated : false;
        // Extra message-only erosion sub-steps after each real step (user
        // request, not a paper construction); see _erasureSubstep().
        // erasureMoves=0 (the default) never calls it, reproducing every
        // earlier trajectory exactly.
        this.erasureMoves = opts.erasureMoves !== undefined ? opts.erasureMoves : 0;
        this.K = opts.K !== undefined ? opts.K : 3;
        this.t0 = opts.t0 !== undefined ? opts.t0 : 4;
        this.n = opts.n !== undefined ? opts.n : 2;
        this.qs = opts.qs !== undefined ? opts.qs : 16;
        this.pPhys = opts.pPhys !== undefined ? opts.pPhys : 0.002;
        this.pMeas = opts.pMeas !== undefined ? opts.pMeas : 0.0;
        this.seed = opts.seed !== undefined ? opts.seed : 1;
        this.x0 = 0; // fixed column the logical indicator is read at

        // Explicit seeds retain reproducible standalone runs; a caller's
        // generator owns every noise draw, and an omitted seed stays fresh.
        this._rng = opts.rng || (opts.seed == null ? Math.random : mulberry32(this.seed));
        this._testPhiQueue = null; // set via setTestPhiHistory()

        this.stepCount = 0;
        this.reset();
    }

    // Integration fix: main.js's clock-period slider does
    // `currentDecoder.clockPeriod = newValue` on a live change (the
    // convention every registered decoder supports, e.g.
    // repetition_cg_streaming.js's own clockPeriod accessor). This class
    // previously had no `clockPeriod` property at all, only the internal
    // `q` that step() actually reads under that name -- so main.js's
    // generic sync-back (`clockSlider.value = currentDecoder.clockPeriod`)
    // read `undefined`, and a live slider change would have set a
    // `clockPeriod` field nothing ever consulted, silently not affecting
    // the simulation. This accessor makes `clockPeriod` and `q` the same
    // value.
    get clockPeriod() { return this.q; }
    set clockPeriod(value) {
        const q = Math.round(value);
        if (Number.isFinite(q) && q >= 1) this.q = q;
    }

    reset() {
        const Lx = this.Lx, Ly = this.Ly;
        this._noiseEnabled = true;
        this._lastMeasurementHasError = false;
        this.slices = [];
        for (let k = 0; k < this.K; k++) {
            this.slices.push(makeSlice(Lx, Ly, k < this.K - 1));
        }
        this.bx = make2D(Lx + 1, Ly, false);
        this.by = make2D(Lx, Ly, false);
        this._prevTildeS = make2D(Lx, Ly, false);
        this.t = 0;
        this.stepCount = 0;
        this.lastPhi = make2D(Lx, Ly, false);
        this.lastPromotions = new Array(this.K).fill(0);
        this.lastCondensations = new Array(this.K).fill(0);
        this.lastDidSplit = false;
        this._recomputeResidual();
    }

    // Test-only: feed an explicit queue of phi arrays (each Lx x Ly boolean
    // nested array) instead of internally-generated noise. Consumed one per
    // step(); once exhausted, step() falls back to internal noise
    // generation. Used by check_streaming_surface.mjs to replay a recorded
    // Python trajectory exactly.
    setTestPhiHistory(phiList) {
        this._testPhiQueue = phiList.map(p => p.map(col => col.slice()));
    }

    // ------------------------------------------------------------------
    // Noise
    // ------------------------------------------------------------------

    setNoiseEnabled(enabled) {
        this._noiseEnabled = !!enabled;
    }

    isNoiseEnabled() {
        return this._noiseEnabled;
    }

    _drawPhi() {
        const Lx = this.Lx, Ly = this.Ly;
        if (this._testPhiQueue && this._testPhiQueue.length > 0) {
            const phi = this._testPhiQueue.shift();
            // Test-driven steps still need a consistent bx/by for residual
            // bookkeeping; since exactness tests only check decoder
            // channels (not residual), leave bx/by untouched here.
            return phi;
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
        this._lastMeasurementHasError = meas.some(col => col.some(Boolean));
        return this._computePhiFromPhysical(this.bx, this.by, meas);
    }

    // Shared by _drawPhi() (live noise) and computePhiHistoryForTest()
    // (dumped bx/by/meas histories): s~_t = syndrome(bx_t,by_t) xor meas_t,
    // phi_t = s~_t xor s~_{t-1} (main.tex:3136-3143). Advances
    // this._prevTildeS. This is the exact code path a coverage gap would
    // otherwise hide: check_streaming_surface.mjs's setTestPhiHistory()
    // bypasses it entirely by injecting phi directly, so an environment
    // bug here (e.g. a transposed index in syndromeOpen) would never
    // surface through that harness alone -- see
    // computePhiHistoryForTest()'s own doc comment.
    _computePhiFromPhysical(bx, by, meas) {
        const Lx = this.Lx, Ly = this.Ly;
        const trueS = syndromeOpen(bx, by, Lx, Ly);
        const tildeS = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) tildeS[x][y] = trueS[x][y] !== meas[x][y];
        }
        const phi = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) phi[x][y] = tildeS[x][y] !== this._prevTildeS[x][y];
        }
        this._prevTildeS = tildeS;
        return phi;
    }

    // Test-only: given explicit per-round bx/by/meas histories (each an
    // array of length T of nested boolean arrays, matching
    // anim/streaming_surface.py's generate_noise() output shapes exactly),
    // compute the resulting phi history using this class's OWN
    // environment-generator code (syndromeOpen + the s~/phi comparisons
    // above) -- exercising precisely the code path setTestPhiHistory()
    // lets every other exactness check skip. Resets _prevTildeS to
    // all-false first (matching s~_{-1}=0); does not touch this.bx/this.by,
    // this.t, or the RNG, so it is safe to call on a fresh or live decoder
    // without disturbing it.
    computePhiHistoryForTest(bxHistory, byHistory, measHistory) {
        this._prevTildeS = make2D(this.Lx, this.Ly, false);
        const out = [];
        for (let t = 0; t < bxHistory.length; t++) {
            out.push(this._computePhiFromPhysical(bxHistory[t], byHistory[t], measHistory[t]));
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Defect-sector update -- Algorithm alg:layered-toric-defect-update
    // (main.tex:3203-3274).
    // ------------------------------------------------------------------

    _defectSectorUpdate(phiNext) {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        const slices = this.slices;
        const candCount = [];
        const candMinTau = [];
        const exNext = [];
        const eyNext = [];
        for (let k = 0; k < K; k++) {
            candCount.push(make2D(Lx, Ly, 0));
            candMinTau.push(make2D(Lx, Ly, LARGE_TIMER));
            exNext.push(copy2D(slices[k].ex));
            eyNext.push(copy2D(slices[k].ey));
        }
        const promotions = new Array(K).fill(0);

        for (let k = 0; k < K; k++) {
            const sl = slices[k];
            const timed = sl.timed;
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!sl.s[x][y]) continue;

                    let tauPlus = null;
                    if (timed) {
                        tauPlus = sl.tau[x][y] + 1;
                        if (tauPlus === tK(this.t0, this.n, k)) {
                            candCount[k + 1][x][y] += 1;
                            if (slices[k + 1].timed) {
                                candMinTau[k + 1][x][y] = Math.min(candMinTau[k + 1][x][y], 0);
                            }
                            promotions[k + 1] += 1;
                            continue;
                        }
                    }

                    let moveLeft = false, moveDown = false;
                    const movementAllowed = (!this.movementGated) || sl.c[x][y] === 0;
                    if (movementAllowed) {
                        const m0jLeft = readBool(sl.m['00'], x - 1, y, Lx, Ly)
                            || readBool(sl.m['01'], x - 1, y, Lx, Ly);
                        if (m0jLeft) {
                            moveLeft = true;
                        } else {
                            moveDown = readBool(sl.m['00'], x, y - 1, Lx, Ly)
                                || readBool(sl.m['10'], x, y - 1, Lx, Ly);
                        }
                    }

                    if (moveLeft) {
                        exNext[k][x][y] = !exNext[k][x][y];
                        const tx = x - 1;
                        if (tx >= 0) {
                            candCount[k][tx][y] += 1;
                            if (timed) candMinTau[k][tx][y] = Math.min(candMinTau[k][tx][y], tauPlus);
                        }
                    } else if (moveDown) {
                        eyNext[k][x][y] = !eyNext[k][x][y];
                        const ty = y - 1;
                        if (ty >= 0) {
                            candCount[k][x][ty] += 1;
                            if (timed) candMinTau[k][x][ty] = Math.min(candMinTau[k][x][ty], tauPlus);
                        }
                    } else {
                        candCount[k][x][y] += 1;
                        if (timed) candMinTau[k][x][y] = Math.min(candMinTau[k][x][y], tauPlus);
                    }
                }
            }
        }

        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                if (phiNext[x][y]) {
                    candCount[0][x][y] += 1;
                    if (slices[0].timed) candMinTau[0][x][y] = Math.min(candMinTau[0][x][y], 0);
                }
            }
        }

        const sNext = [], tauNext = [];
        for (let k = 0; k < K; k++) {
            const sk = make2D(Lx, Ly, false);
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) sk[x][y] = (candCount[k][x][y] % 2) === 1;
            }
            sNext.push(sk);
            if (slices[k].timed) {
                const tauK = make2D(Lx, Ly, 0);
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (sk[x][y] && candMinTau[k][x][y] < LARGE_TIMER) {
                            tauK[x][y] = candMinTau[k][x][y];
                        }
                    }
                }
                tauNext.push(tauK);
            } else {
                tauNext.push(null);
            }
        }

        return { sNext, tauNext, exNext, eyNext, promotions };
    }

    // ------------------------------------------------------------------
    // Message-sector update -- Algorithm alg:layered-toric-message-update
    // (main.tex:3405-3509), generalized growth window.
    // ------------------------------------------------------------------

    _messageSectorUpdate(sNext, tauNext) {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        const slices = this.slices;
        const growthWindow = this.growthWindow;
        const mNext = [], thNext = [], cNext = [];

        for (let k = 0; k < K; k++) {
            const sl = slices[k];
            const timed = sl.timed;
            const mK = {}, thK = timed ? {} : null;
            for (const [i, j] of CHANNELS) {
                mK[chKey(i, j)] = make2D(Lx, Ly, false);
                if (timed) thK[chKey(i, j)] = make2D(Lx, Ly, 0);
            }
            const tk = timed ? tK(this.t0, this.n, k) : null;

            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    const cT = sl.c[x][y];
                    const votes = toomPersistence(sl, x, y, Lx, Ly);
                    const coupling = sl.m['00'][x][y] && (votes & 1) !== 0;

                    if (timed) {
                        // Reduce candidates as they arrive. Keep a separate presence
                        // flag so a legitimate Infinity/NaN timer retains the same
                        // Math.min semantics as the former candidate arrays.
                        let defectMin = Infinity;
                        let hasDefect = false;
                        if (sNext[k][x][y]) {
                            defectMin = Math.min(defectMin, tauNext[k][x][y]);
                            hasDefect = true;
                        }
                        if (sl.s[x][y] && sl.tau[x][y] + 1 < tk) {
                            defectMin = Math.min(defectMin, sl.tau[x][y] + 1);
                            hasDefect = true;
                        }

                        for (let channel = 0; channel < CHANNEL_KEYS.length; channel++) {
                            const key = CHANNEL_KEYS[channel];
                            const dx = CHANNEL_DX[channel], dy = CHANNEL_DY[channel];
                            const messages = sl.m[key], timers = sl.th[key];
                            let minimum = defectMin;
                            let hasCandidate = hasDefect;

                            if (cT < growthWindow) {
                                let sourceMin = Infinity;
                                let hasSource = false;
                                if (readBool(messages, x + dx, y, Lx, Ly)) {
                                    const theta = readInt(timers, x + dx, y, Lx, Ly);
                                    if (theta < tk - 1) {
                                        sourceMin = Math.min(sourceMin, theta);
                                        hasSource = true;
                                    }
                                }
                                if (readBool(messages, x, y + dy, Lx, Ly)) {
                                    const theta = readInt(timers, x, y + dy, Lx, Ly);
                                    if (theta < tk - 1) {
                                        sourceMin = Math.min(sourceMin, theta);
                                        hasSource = true;
                                    }
                                }
                                if (hasSource) {
                                    minimum = Math.min(minimum, 1 + sourceMin);
                                    hasCandidate = true;
                                }
                            }

                            if (messages[x][y] && timers[x][y] < tk - 1) {
                                if ((votes & (1 << channel)) !== 0 || coupling) {
                                    minimum = Math.min(minimum, timers[x][y] + 1);
                                    hasCandidate = true;
                                }
                            }

                            if (hasCandidate) {
                                mK[key][x][y] = true;
                                thK[key][x][y] = minimum;
                            }
                        }
                    } else {
                        const srcDefect = sNext[k][x][y] || sl.s[x][y];
                        for (let channel = 0; channel < CHANNEL_KEYS.length; channel++) {
                            const key = CHANNEL_KEYS[channel];
                            const dx = CHANNEL_DX[channel], dy = CHANNEL_DY[channel];
                            let growth = false;
                            if (cT < growthWindow) {
                                growth = readBool(sl.m[key], x + dx, y, Lx, Ly)
                                    || readBool(sl.m[key], x, y + dy, Lx, Ly);
                            }
                            const persist = sl.m[key][x][y] && ((votes & (1 << channel)) !== 0 || coupling);
                            mK[key][x][y] = srcDefect || growth || persist;
                        }
                    }
                }
            }

            mNext.push(mK);
            thNext.push(thK);
            const cK = make2D(Lx, Ly, 0);
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) cK[x][y] = (sl.c[x][y] + 1) % this.q;
            }
            cNext.push(cK);
        }

        return { mNext, thNext, cNext };
    }

    // Apply one "extra erasure move" to every slice, in place. User-
    // requested addition, not a paper construction: after a real step,
    // running extra message-only sub-steps lets messages keep eroding (via
    // Toom-vote persistence) without any further growth, so a viewer can
    // watch stray messages clear faster without disturbing the decoder's
    // own clock. Per slice, per site, per channel: growth is disabled
    // entirely; defect-sourcing is kept (a defect's own site still keeps
    // every message, condition (i)) using the CURRENT s -- unchanged,
    // since nothing here ever moves, promotes, or inserts a defect; the
    // persistence/coupling condition is otherwise unchanged, still gated
    // by theta < t_k-1 on timed slices, via the shared toomPersistence()
    // helper _messageSectorUpdate also uses, so the two cannot drift.
    // Whenever a channel's message stays true its timer is left exactly
    // as it was (frozen, never incremented); a channel that erodes to
    // false has its timer reset to 0. Touches only sl.m and (on timed
    // slices) sl.th; s, tau, ex, ey, and c are untouched on every slice.
    _erasureSubstep() {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            const timed = sl.timed;
            const tk = timed ? tK(this.t0, this.n, k) : null;
            const newM = {}, newTh = timed ? {} : null;
            for (const [i, j] of CHANNELS) {
                newM[chKey(i, j)] = make2D(Lx, Ly, false);
                if (timed) newTh[chKey(i, j)] = make2D(Lx, Ly, 0);
            }

            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    const defectSource = sl.s[x][y];
                    const votes = toomPersistence(sl, x, y, Lx, Ly);
                    const coupling = sl.m['00'][x][y] && (votes & 1) !== 0;
                    for (let channel = 0; channel < CHANNEL_KEYS.length; channel++) {
                        const key = CHANNEL_KEYS[channel];
                        const channelOn = sl.m[key][x][y];
                        const withinTimer = (!timed) || sl.th[key][x][y] < tk - 1;
                        const persists = channelOn && withinTimer && ((votes & (1 << channel)) !== 0 || coupling);
                        const val = defectSource || persists;
                        newM[key][x][y] = val;
                        if (timed) newTh[key][x][y] = val ? sl.th[key][x][y] : 0;
                    }
                }
            }

            sl.m = newM;
            if (timed) sl.th = newTh;
        }
    }

    // ------------------------------------------------------------------
    // Open-boundary splitting step (main.tex:2306-2314, 2808-2810,
    // 3511-3522). Splits along x only, independently per row y.
    //
    // Deliberate deviation from the literal main.tex:2312-2314 copy rule:
    // the paper copies a center site's messages unconditionally, but for
    // an isolated defect sitting exactly on a center site with nothing
    // else nearby to move it between splits, this leaves every message
    // channel copied back at the vacated center site (a defect carries all
    // three via defect persistence); those messages persist there
    // (refreshed by growth from the defect's own new, adjacent position),
    // so this same split's subsequent defect-sector update sees a
    // "message at my left neighbour" trigger pointing back at the site the
    // defect just left and moves it back -- a permanent oscillation with
    // period qs that never condenses (confirmed directly: a lone defect at
    // x=mHalf, the right-hand center site, under the numerics-style
    // default rule never leaves in 6+ splits; the mirrored left-hand
    // center site mHalf-1 is unaffected, since a leftward-evacuating
    // defect's leftover copy sits behind its new position, where the
    // leftward-priority movement check never looks -- only a rightward
    // evacuation places the leftover exactly where the base rule's own
    // leftward check looks). Minimal fix: skip the copy-back (but still
    // translate normally) only for a message at a center site whose own
    // defect is being evacuated in this same split.
    // ------------------------------------------------------------------

    _splittingStep(sl) {
        const Lx = this.Lx, Ly = this.Ly;
        const mHalf = Math.floor(Lx / 2);

        const newM = {}, newTh = sl.timed ? {} : null;
        for (const [i, j] of CHANNELS) {
            newM[chKey(i, j)] = make2D(Lx, Ly, false);
            if (sl.timed) newTh[chKey(i, j)] = make2D(Lx, Ly, 0);
        }

        for (let x = 0; x < Lx; x++) {
            const target = x < mHalf ? x - 1 : x + 1;
            const isCenter = (x === mHalf - 1 || x === mHalf);
            const inBounds = target >= 0 && target < Lx;
            if (!inBounds && !isCenter) continue;
            for (let y = 0; y < Ly; y++) {
                const copyBack = isCenter && !sl.s[x][y];
                for (const [i, j] of CHANNELS) {
                    const key = chKey(i, j);
                    if (!sl.m[key][x][y]) continue;
                    const thVal = sl.timed ? sl.th[key][x][y] : 0;
                    if (inBounds) {
                        newM[key][target][y] = true;
                        if (sl.timed) newTh[key][target][y] = thVal;
                    }
                    if (copyBack) {
                        newM[key][x][y] = true;
                        if (sl.timed) newTh[key][x][y] = thVal;
                    }
                }
            }
        }

        const newEx = copy2D(sl.ex);
        const candCount = make2D(Lx, Ly, 0);
        const candMinTau = make2D(Lx, Ly, LARGE_TIMER);
        let condensed = 0;
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                if (!sl.s[x][y]) continue;
                let target;
                if (x < mHalf) {
                    newEx[x][y] = !newEx[x][y];
                    target = x - 1;
                } else {
                    newEx[x + 1][y] = !newEx[x + 1][y];
                    target = x + 1;
                }
                if (target >= 0 && target < Lx) {
                    candCount[target][y] += 1;
                    if (sl.timed) candMinTau[target][y] = Math.min(candMinTau[target][y], sl.tau[x][y]);
                } else {
                    condensed += 1;
                }
            }
        }

        const newS = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) newS[x][y] = (candCount[x][y] % 2) === 1;
        }

        sl.m = newM;
        sl.ex = newEx;
        sl.s = newS;
        if (sl.timed) {
            sl.th = newTh;
            const newTau = make2D(Lx, Ly, 0);
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (newS[x][y] && candMinTau[x][y] < LARGE_TIMER) newTau[x][y] = candMinTau[x][y];
                }
            }
            sl.tau = newTau;
        }
        return condensed;
    }

    // ------------------------------------------------------------------
    // Top-level step
    // ------------------------------------------------------------------

    step() {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        let didSplit = false;
        const condensations = new Array(K).fill(0);
        if (this.t > 0 && this.t % this.qs === 0) {
            didSplit = true;
            for (let k = 0; k < K; k++) condensations[k] = this._splittingStep(this.slices[k]);
        }

        const phi = this._drawPhi();
        const { sNext, tauNext, exNext, eyNext, promotions } = this._defectSectorUpdate(phi);
        const { mNext, thNext, cNext } = this._messageSectorUpdate(sNext, tauNext);

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            sl.s = sNext[k];
            if (sl.timed) { sl.tau = tauNext[k]; sl.th = thNext[k]; }
            sl.ex = exNext[k];
            sl.ey = eyNext[k];
            sl.m = mNext[k];
            sl.c = cNext[k];
        }

        for (let i = 0; i < this.erasureMoves; i++) this._erasureSubstep();

        this.lastPhi = phi;
        this.lastPromotions = promotions;
        this.lastCondensations = condensations;
        this.lastDidSplit = didSplit;
        this.t += 1;
        this.stepCount += 1;
        this._recomputeResidual();
    }

    _recomputeResidual() {
        const Lx = this.Lx, Ly = this.Ly;
        let Ex = copy2D(this.slices[0].ex);
        let Ey = copy2D(this.slices[0].ey);
        for (let k = 1; k < this.K; k++) {
            for (let x = 0; x <= Lx; x++) for (let y = 0; y < Ly; y++) Ex[x][y] = Ex[x][y] !== this.slices[k].ex[x][y];
            for (let x = 0; x < Lx; x++) for (let y = 0; y < Ly; y++) Ey[x][y] = Ey[x][y] !== this.slices[k].ey[x][y];
        }
        const residualX = make2D(Lx + 1, Ly, false);
        for (let x = 0; x <= Lx; x++) for (let y = 0; y < Ly; y++) residualX[x][y] = this.bx[x][y] !== Ex[x][y];
        const residualY = make2D(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) for (let y = 0; y < Ly; y++) residualY[x][y] = this.by[x][y] !== Ey[x][y];
        this.residualX = residualX;
        this.residualY = residualY;
        this.residualSyndrome = syndromeOpen(residualX, residualY, Lx, Ly);
    }

    // ------------------------------------------------------------------
    // Query API
    // ------------------------------------------------------------------

    getSyndromeCount() {
        let n = 0;
        for (const sl of this.slices) {
            for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) if (sl.s[x][y]) n++;
        }
        return n;
    }

    // Residual EDGE weight (popcount of residualX/residualY). Not a health
    // metric in 2D: a fully-resolved cluster's correction differs from its
    // original error by a closed loop (a stabilizer element), and a closed
    // loop's edge weight random-walks toward a constant density regardless
    // of whether decoding is working -- there is no such loop in 1D, which
    // is why a 1D decoder's residual weight instead sits at a small
    // constant. Kept for continuity/comparison; see getResidualDefectCount()
    // for the metric that actually indicates decoder health.
    getErrorCount() {
        let n = 0;
        for (let x = 0; x <= this.Lx; x++) for (let y = 0; y < this.Ly; y++) if (this.residualX[x][y]) n++;
        for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) if (this.residualY[x][y]) n++;
        return n;
    }

    // Residual SYNDROME weight ("live defects": popcount of
    // syndrome(residualX, residualY)). This -- together with
    // checkLogicalError()'s residualSyndromeClear and logicalError -- is
    // the meaningful bounded health metric; see getErrorCount()'s comment.
    getResidualDefectCount() {
        let n = 0;
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) if (this.residualSyndrome[x][y]) n++;
        }
        return n;
    }

    getSystemDefectCount() {
        return this.getResidualDefectCount();
    }

    hasMessages() {
        for (const sl of this.slices) {
            for (const [i, j] of CHANNELS) {
                const arr = sl.m[chKey(i, j)];
                for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) if (arr[x][y]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        if (this._noiseEnabled && (this.pPhys > 0 || this.pMeas > 0)) return false;
        if (this._lastMeasurementHasError) return false;
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        let residualClear = true;
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) if (this.residualSyndrome[x][y]) residualClear = false;
        }
        // Logical indicator: parity of qx along a FIXED COLUMN x0 (a
        // vertical cut), summed over y -- NOT a fixed row summed over x.
        // Every closed loop (star product) crosses any vertical cut an
        // even number of times, so this is gauge-invariant; a fixed row's
        // parity is not (see surface_streaming.js's header comment and
        // anim/streaming_surface.py's "Logical indicator" docstring
        // section for the brute-force verification).
        let parity = false;
        for (let y = 0; y < this.Ly; y++) parity = parity !== this.residualX[this.x0][y];
        // Integration fix: main.js's updateStats() reads `.hasError` (every
        // other decoder's checkLogicalError() convention, e.g.
        // toric_streaming.js's own `hasError = residualClear && (windingX
        // || windingY)`) to decide whether to show the "Logical Error" row
        // at all; without it the row silently never appeared for this
        // decoder, logical error or not. Added alongside the original
        // fields (unchanged) so nothing that reads those breaks.
        return {
            residualSyndromeClear: residualClear, logicalError: parity,
            hasError: residualClear && parity, horizontal: parity, vertical: false,
        };
    }

    // Integration fix (same as toric_streaming.js / repetition_streaming.js):
    // main.js calls this unconditionally when "Manual Placement" is
    // selected, regardless of decoder; this class had no
    // toggleErrorAtPosition() at all, so a canvas click while this decoder
    // was loaded threw. A no-op is correct here too: this decoder models
    // ongoing phenomenological noise, not a one-shot manually-placed
    // error pattern.
    toggleErrorAtPosition() {}

    initializeRandomErrors(p, rng) {
        this.pPhys = p;
        this._rng = rng || Math.random;
        this.reset();
    }

    dispose() {}

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const panels = K + 1; // K slices + residual
        const sideMargin = 14, gap = 22, labelH = 18;
        const topLabelHeight = 30; // reserved for the top-centred "t = N" caption
        const statsHeight = 56;    // reserved for the stats line + legend line

        const availW = canvasWidth - 2 * sideMargin;
        const availH = canvasHeight - topLabelHeight - statsHeight;

        // Choose the panel layout that maximises cell size: a single row
        // of `panels` patches, or (when panels <= 4) a 2x2 grid instead.
        // Each candidate's limiting cell size is whichever of width/height
        // binds tighter; comparing the two candidates' resulting cell sizes
        // picks whichever arrangement uses the canvas better.
        const cellForGrid = (rows, cols) => {
            const cellW = (availW - (cols - 1) * gap) / (cols * (Lx + 1.6));
            const cellH = (availH - rows * labelH - (rows - 1) * gap) / (rows * (Ly + 1.6));
            return Math.min(cellW, cellH);
        };
        let rows = 1, cols = panels, cell = cellForGrid(1, panels);
        if (panels <= 4) {
            const cell2 = cellForGrid(2, 2);
            if (cell2 > cell) { rows = 2; cols = 2; cell = cell2; }
        }
        cell = Math.max(4, cell);

        const panelW = cell * (Lx + 1.6);
        const panelH = cell * (Ly + 1.6);
        const blockW = cols * panelW + (cols - 1) * gap;
        const blockH = rows * (labelH + panelH) + (rows - 1) * gap;
        // Centre the chosen block both horizontally (within the full
        // canvas width) and vertically (within the space left between the
        // top caption and the bottom stats/legend lines).
        const blockOx = sideMargin + (availW - blockW) / 2;
        const blockOy = topLabelHeight + (availH - blockH) / 2;

        // Per-panel (ox, oy) -- oy is the top of that panel's OWN grid
        // cells (its title is drawn just above oy). A short last row (e.g.
        // 3 panels in a 2x2 grid) is centred within the block's width.
        const positions = [];
        for (let idx = 0; idx < panels; idx++) {
            const r = Math.floor(idx / cols);
            const cInRow = idx % cols;
            const panelsInRow = Math.min(cols, panels - r * cols);
            const rowW = panelsInRow * panelW + (panelsInRow - 1) * gap;
            const rowOx = blockOx + (blockW - rowW) / 2;
            const ox = rowOx + cInRow * (panelW + gap);
            const oy = blockOy + r * (labelH + panelH + gap) + labelH;
            positions.push([ox, oy]);
        }

        const showMessages = !!options.showMessages;
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;
        const showGrid = options.showGrid !== false;

        const msgColor = { '00': 'rgba(96,165,250,0.35)', '01': 'rgba(248,113,113,0.35)', '10': 'rgba(74,222,128,0.35)' };

        const drawPatch = (ox, oy, label, drawSlice) => {
            // origin of stabilizer (0,0) cell, y increasing upward; oy is
            // the top of this panel's own panelH-tall cell area.
            const x0 = ox + cell * 0.9;
            const yBase = oy + panelH - cell * 0.6;
            const yAt = (y) => yBase - y * cell;
            const xAt = (x) => x0 + x * cell;

            if (showGrid) {
                ctx.strokeStyle = '#e2e8f0';
                ctx.lineWidth = 1;
                for (let x = 0; x <= Lx; x++) {
                    ctx.beginPath();
                    ctx.moveTo(xAt(x), yAt(-0.5));
                    ctx.lineTo(xAt(x), yAt(Ly - 0.5));
                    ctx.stroke();
                }
                for (let y = 0; y < Ly; y++) {
                    ctx.beginPath();
                    ctx.moveTo(xAt(-0.5), yAt(y - 0.5));
                    ctx.lineTo(xAt(Lx - 0.5), yAt(y - 0.5));
                    ctx.stroke();
                }
            }

            // Rough boundaries marked on left/right edges.
            ctx.strokeStyle = '#8764b9';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(xAt(-0.5), yAt(-0.5));
            ctx.lineTo(xAt(-0.5), yAt(Ly - 0.5));
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xAt(Lx - 0.5), yAt(-0.5));
            ctx.lineTo(xAt(Lx - 0.5), yAt(Ly - 0.5));
            ctx.stroke();

            drawSlice(xAt, yAt);

            ctx.fillStyle = '#475569';
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(label, ox + panelW / 2, oy - 8);
        };

        for (let k = 0; k < K; k++) {
            const [ox, oy] = positions[k];
            const sl = this.slices[k];
            const label = k === K - 1 ? `slice ${k} (back wall)` : `slice ${k}`;
            drawPatch(ox, oy, label, (xAt, yAt) => {
                if (showMessages) {
                    for (const [i, j] of CHANNELS) {
                        const key = chKey(i, j);
                        ctx.fillStyle = msgColor[key];
                        for (let x = 0; x < Lx; x++) {
                            for (let y = 0; y < Ly; y++) {
                                if (sl.m[key][x][y]) {
                                    ctx.fillRect(xAt(x - 0.5), yAt(y + 0.5), cell, cell);
                                }
                            }
                        }
                    }
                }
                if (showSyndrome) {
                    for (let x = 0; x < Lx; x++) {
                        for (let y = 0; y < Ly; y++) {
                            if (sl.s[x][y]) {
                                ctx.beginPath();
                                const r = Math.max(2, cell * 0.28);
                                const grad = ctx.createRadialGradient(xAt(x), yAt(y), 0, xAt(x), yAt(y), r);
                                grad.addColorStop(0, '#f1f5f9');
                                grad.addColorStop(1, '#0f172a');
                                ctx.fillStyle = grad;
                                ctx.arc(xAt(x), yAt(y), r, 0, 2 * Math.PI);
                                ctx.fill();
                            }
                        }
                    }
                }
                if (k === 0) {
                    // Detector events of the round that just entered, as
                    // small crosses on slice 0.
                    ctx.strokeStyle = '#ea580c';
                    ctx.lineWidth = 2;
                    const r = Math.max(2, cell * 0.2);
                    for (let x = 0; x < Lx; x++) {
                        for (let y = 0; y < Ly; y++) {
                            if (this.lastPhi[x][y]) {
                                ctx.beginPath();
                                ctx.moveTo(xAt(x) - r, yAt(y) - r);
                                ctx.lineTo(xAt(x) + r, yAt(y) + r);
                                ctx.moveTo(xAt(x) + r, yAt(y) - r);
                                ctx.lineTo(xAt(x) - r, yAt(y) + r);
                                ctx.stroke();
                            }
                        }
                    }
                }
            });
        }

        // Residual patch (last position: single row -> far right; 2x2 grid
        // -> wherever the last cell falls).
        const [rx, ry] = positions[K];
        drawPatch(rx, ry, 'residual', (xAt, yAt) => {
            if (showErrors) {
                // Each residual error is a string piece joining the
                // centres of the two cells the qubit separates (not a
                // link along their shared edge), so a chain of adjacent
                // flipped qubits reads as one continuous string between
                // its endpoint defects, like the repetition-code strings.
                // qx[0,y]/qx[Lx,y] (the rough-boundary qubits) are half
                // pieces from the one adjacent cell's centre to the
                // boundary line. Round caps make consecutive pieces join
                // at shared cell-centre endpoints without a doubled or
                // notched seam. Drawn before (under) the defect/syndrome
                // glyphs below.
                ctx.strokeStyle = '#ef4444';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                for (let x = 0; x <= Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!this.residualX[x][y]) continue;
                        ctx.beginPath();
                        if (x === 0) {
                            ctx.moveTo(xAt(0), yAt(y));
                            ctx.lineTo(xAt(-0.5), yAt(y));
                        } else if (x === Lx) {
                            ctx.moveTo(xAt(Lx - 1), yAt(y));
                            ctx.lineTo(xAt(Lx - 0.5), yAt(y));
                        } else {
                            ctx.moveTo(xAt(x - 1), yAt(y));
                            ctx.lineTo(xAt(x), yAt(y));
                        }
                        ctx.stroke();
                    }
                }
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!this.residualY[x][y]) continue;
                        ctx.beginPath();
                        ctx.moveTo(xAt(x), yAt(y - 1));
                        ctx.lineTo(xAt(x), yAt(y));
                        ctx.stroke();
                    }
                }
                ctx.lineCap = 'butt';
            }
            if (showSyndrome) {
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (this.residualSyndrome[x][y]) {
                            ctx.beginPath();
                            ctx.fillStyle = '#fbbf24';
                            ctx.arc(xAt(x), yAt(y), Math.max(2, cell * 0.24), 0, 2 * Math.PI);
                            ctx.fill();
                        }
                    }
                }
            }
        });

        // Caption: "t = N" centred at the top, matching every other tab.
        ctx.fillStyle = '#334155';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`t = ${this.t}`, canvasWidth / 2, 20);

        // Stats line, in the reserved bottom area.
        ctx.textAlign = 'left';
        const check = this.checkLogicalError();
        ctx.fillText(
            `defects=${this.getSyndromeCount()}  residual weight=${this.getErrorCount()}  `
            + `residual defects=${this.getResidualDefectCount()}  `
            + `residual syndrome ${check.residualSyndromeClear ? 'clear' : 'NONZERO'}  `
            + `logical=${check.logicalError ? '1' : '0'}`,
            sideMargin, canvasHeight - statsHeight + 20
        );

        // Legend.
        const legendY = canvasHeight - 14;
        let lx = sideMargin;
        const legendItem = (color, text, isLine, roundCap) => {
            if (isLine) {
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.lineCap = roundCap ? 'round' : 'butt';
                ctx.beginPath();
                ctx.moveTo(lx, legendY);
                ctx.lineTo(lx + 14, legendY);
                ctx.stroke();
                ctx.lineCap = 'butt';
            } else {
                ctx.fillStyle = color;
                ctx.fillRect(lx, legendY - 6, 14, 10);
            }
            ctx.fillStyle = '#475569';
            ctx.font = '10px JetBrains Mono, monospace';
            ctx.textAlign = 'left';
            ctx.fillText(text, lx + 18, legendY + 3);
            lx += 18 + ctx.measureText(text).width + 16;
        };
        legendItem('#0f172a', 'defect', false);
        legendItem('#ef4444', 'residual error', true, true);
        legendItem('#fbbf24', 'residual syndrome', false);
        legendItem('#8764b9', 'rough boundary', true);
        legendItem('#ea580c', 'detector event', true);
        if (showMessages) legendItem('rgba(96,165,250,0.6)', 'm00/m01/m10', false);
    }
}
