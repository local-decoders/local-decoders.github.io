// Toric-code hierarchical (coarse-grained) streaming decoder -- constant
// resource-density construction, main.tex:4892-5407 (Section "Constant-
// resource-density streaming decoders", subsection "Hierarchical toric-code
// decoder"). This is a literal port of anim/cg_streaming_toric.py; see that
// module's docstring for full paper-line citations, the two open geometric/
// modeling choices (child-to-parent correction-string shape; "T_future"),
// and the documented, expected discrepancy against the plain code-capacity
// rule in a rare defect-collision configuration (K=1 reduction).
//
// State layout mirrors the Python SliceState/State dataclasses exactly:
// `this.slices[k]` is one slice's channels (all plain arrays, row = x,
// column = y, matching torca's CONVENTIONS.md), `this.pending` is a Map from
// absolute arrival time -> array of [kTarget, yx, yy, ax, ay] promotion
// records, `this.t` is the absolute time (paper's "t"), starting at -1.
//
// Per main.tex:4939, this section reuses q=3 with growth on c in {0,1} and
// movement only at c=0 -- the same gating anim/streaming_toric.js-style
// (non-coarse-grained) modules hardcode -- so `clockPeriod` is only the
// clock *period* q; the growth/movement gates themselves are fixed below,
// not derived from it.

const MESSAGE_CHANNELS = [[0, 0], [0, 1], [1, 0]]; // m00 (+x,+y), m01 (+x,-y), m10 (-x,+y)

// One colour per hierarchy level, used consistently for a level-k defect's
// block outline and for that level's nested coarse-grid lines, and named in
// the legend ("level 0 defect", "level 1 defect", ...). Cycles if K exceeds
// the palette (extraParams caps K at 5, so 6 entries always covers it).
const LEVEL_COLORS = ['#555555', '#3b6fd4', '#e07b39', '#2e9e5b', '#9b59b6', '#c2185b'];
function levelColor(k) {
    return LEVEL_COLORS[k % LEVEL_COLORS.length];
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mod(a, m) {
    return ((a % m) + m) % m;
}

function zeros2D(size, fill) {
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = new Array(size).fill(fill);
    return out;
}

function zeros3D(depth, size, fill) {
    const out = new Array(depth);
    for (let d = 0; d < depth; d++) out[d] = zeros2D(size, fill);
    return out;
}

function zeros4D(size, n, fill) {
    // shape [size, size, n, n], indexed [rx][ry][ax][ay]
    const out = new Array(size);
    for (let rx = 0; rx < size; rx++) {
        out[rx] = new Array(size);
        for (let ry = 0; ry < size; ry++) {
            out[rx][ry] = zeros2D(n, fill);
        }
    }
    return out;
}

function clone2D(arr) {
    return arr.map(row => row.slice());
}

function clone3D(arr) {
    return arr.map(clone2D);
}

function clone4D(arr) {
    if (arr === null) return null;
    return arr.map(row => row.map(clone2D));
}

// ---------------------------------------------------------------------------
// One slice's complete state: defect sector (e_x,e_y,e_child,s,tau) and
// message sector (m,theta,c), plus the arrival-parity bit rho (k>0 only).
// Mirrors anim/cg_streaming_toric.py's SliceState exactly.
// ---------------------------------------------------------------------------

function makeSlice(Lk, n, hasChildren) {
    return {
        Lk,
        e_x: zeros2D(Lk, false),
        e_y: zeros2D(Lk, false),
        e_child: hasChildren ? zeros4D(Lk, n, false) : null,
        s: zeros2D(Lk, false),
        tau: zeros2D(Lk, 0),
        m: zeros3D(3, Lk, false),      // m[channel][x][y]
        theta: zeros3D(3, Lk, 0),
        c: zeros2D(Lk, 0),
        rho: hasChildren ? zeros2D(Lk, false) : null,
    };
}

function cloneSlice(sl) {
    return {
        Lk: sl.Lk,
        e_x: clone2D(sl.e_x),
        e_y: clone2D(sl.e_y),
        e_child: clone4D(sl.e_child),
        s: clone2D(sl.s),
        tau: clone2D(sl.tau),
        m: clone3D(sl.m),
        theta: clone3D(sl.theta),
        c: clone2D(sl.c),
        rho: sl.rho === null ? null : clone2D(sl.rho),
    };
}

// ---------------------------------------------------------------------------
// Shared per-slice helpers (ToomVote, N_ij) -- main.tex:5227-5240
// ---------------------------------------------------------------------------

function toomVote(message, i, j, x, y, Lk) {
    const srcX = mod(x + (i === 0 ? -1 : 1), Lk);
    const srcY = mod(y + (j === 0 ? -1 : 1), Lk);
    const votes = (message[x][y] ? 1 : 0) + (message[srcX][y] ? 1 : 0) + (message[x][srcY] ? 1 : 0);
    return votes >= 2;
}

function growthSources(i, j, x, y, Lk) {
    const srcX = mod(x + (i === 0 ? -1 : 1), Lk);
    const srcY = mod(y + (j === 0 ? -1 : 1), Lk);
    return [[srcX, y], [x, srcY]];
}

// Physical (Lambda_0) toric syndrome: s(x,y) = qx(x,y) ^ qx(x+1,y) ^ qy(x,y) ^ qy(x,y+1).
// Exported (not just used internally by _genRound's own noise generator) so
// a test harness can exercise this exact function -- the real environment
// code path -- against externally-supplied bx/by/meas histories, rather
// than re-deriving the same formula independently in the test itself. See
// website/tests/check_cg_streaming_toric.mjs's environment-path checks.
export function physicalSyndrome(qx, qy, L) {
    const s = zeros2D(L, false);
    for (let x = 0; x < L; x++) {
        for (let y = 0; y < L; y++) {
            const a = qx[x][y], b = qx[(x + 1) % L][y], c = qy[x][y], d = qy[x][(y + 1) % L];
            s[x][y] = (a !== b) !== (c !== d);
        }
    }
    return s;
}

function windingParities(qx, qy, L) {
    let wx = false, wy = false;
    for (let x = 0; x < L; x++) wx = wx !== qx[x][0];
    for (let y = 0; y < L; y++) wy = wy !== qy[0][y];
    return [wx, wy];
}

// ---------------------------------------------------------------------------
// Physical correction expansion -- main.tex:4977-4994 (open choice 1: see
// anim/cg_streaming_toric.py's docstring for the "x-then-y shortest path"
// convention this mirrors exactly, including the tie-break).
// ---------------------------------------------------------------------------

function center0(k, rx, ry, n) {
    const nk = Math.pow(n, k);
    return [nk * rx + Math.floor(nk / 2), nk * ry + Math.floor(nk / 2)];
}

function shortestDelta(a, b, L) {
    let d = mod(b - a, L);
    if (d > Math.floor(L / 2)) d -= L;
    return d;
}

function applyXRun(Ex, y, xStart, steps, L) {
    if (steps === 0) return;
    const lo = steps > 0 ? xStart : xStart + steps;
    const hi = steps > 0 ? xStart + steps : xStart;
    for (let c = lo + 1; c <= hi; c++) {
        const cm = mod(c, L);
        Ex[cm][y] = !Ex[cm][y];
    }
}

function applyYRun(Ey, x, yStart, steps, L) {
    if (steps === 0) return;
    const lo = steps > 0 ? yStart : yStart + steps;
    const hi = steps > 0 ? yStart + steps : yStart;
    for (let c = lo + 1; c <= hi; c++) {
        const cm = mod(c, L);
        Ey[x][cm] = !Ey[x][cm];
    }
}

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

export class ToricCGStreamingDecoder {
    // clockPeriod (q), opts.movementGated, opts.growthWindow: the per-slice
    // base-rule clock period and gating (main.tex:4939's formal choice is
    // q=3, movementGated=true, growthWindow=2; applied identically inside
    // every slice's own defect/message update, by direct analogy with
    // torca.reference.step_sync's own movement_gated/growth_window
    // parameters -- see anim/cg_streaming_toric.py's Params docstring).
    // Defaults here are the reproduction/"numerics-style" choice this app
    // standardizes its other 2D decoders on: q=6, movementGated=false
    // (move every step), growthWindow=1 (grow only at c=0).
    constructor(L, clockPeriod = 6, opts = {}) {
        this.L = L;
        this.q = (Number.isFinite(clockPeriod) && clockPeriod >= 2) ? Math.round(clockPeriod) : 6;
        this.K = Math.max(1, Math.round(opts.K ?? 3));
        this.n = Math.max(2, Math.round(opts.n ?? 2));
        this.t0 = Math.max(1, Math.round(opts.t0 ?? 4));
        this.movementGated = opts.movementGated ?? false;
        this.growthWindow = Math.max(0, Math.min(this.q, Math.round(opts.growthWindow ?? 1)));
        // erasureMoves: extra message-only "erasure" sub-steps step() runs
        // after every real round (default 0, no change to the paper's own
        // dynamics) -- not part of the cited excerpt. Each sub-step applies
        // erasureSubstep() to EVERY slice: only the message sector's
        // persistence/erosion rule (growth disabled, defect-sourcing kept,
        // message timers frozen); see erasureSubstep()'s own comment and
        // anim/cg_streaming_toric.py's Params.erasure_moves docstring.
        this.erasureMoves = Math.max(0, Math.round(opts.erasureMoves ?? 0));
        this.pPhys = opts.pPhys ?? 0.001;
        this._pMeasOverridden = opts.pMeas !== undefined;
        this.pMeas = opts.pMeas ?? this.pPhys;
        this.seed = opts.seed ?? 1;
        // T_future: not part of the cited paper excerpt for this task.
        // Matches website/modules/repetition_streaming.js's convention
        // exactly (the analogous, already-registered hierarchical
        // repetition-code streaming decoder in this app): the chunk size,
        // in rounds, that the phenomenological-noise environment is
        // pre-generated in, exposed via getFutureRounds() so a renderer
        // can peek ahead at not-yet-consumed noise without touching the
        // PRNG stream out of order. Flagged as an open choice (this
        // module's own render() does not currently use it) in the
        // REGISTER notes.
        this.T_future = Math.max(1, Math.round(opts.T_future ?? 200));

        if (this.L % Math.pow(this.n, this.K - 1) !== 0) {
            throw new Error(`L=${this.L} must be divisible by n**(K-1)=${Math.pow(this.n, this.K - 1)}`);
        }

        this._rng = mulberry32(this.seed >>> 0);
        this._env = [];          // _env[i] = {phi, bx, by} for absolute round i
        this._explicitPhi = null; // test-only override: array of L x L phi grids, indexed by stepCount
        this._lastPhi = null;     // for rendering: detector events of the round that just entered

        this._initState();
        this._extendEnvironmentChunk();
    }

    // Integration fix: main.js's clock-period slider reads/writes
    // `currentDecoder.clockPeriod` generically (the convention every other
    // registered decoder supports, e.g. repetition_cg_streaming.js's own
    // accessor, or surface_streaming.js's after the same fix). This class
    // had no `clockPeriod` property at all, only the internal `q` every
    // slice's step actually reads -- so main.js's `clockPeriod !== undefined`
    // guard was false and both the initial slider-sync and any live slider
    // change were silently skipped entirely (no crash, but the slider could
    // never affect this decoder's q after construction). This accessor
    // makes `clockPeriod` and `q` the same value.
    get clockPeriod() { return this.q; }
    set clockPeriod(value) {
        const q = Math.round(value);
        if (Number.isFinite(q) && q >= 2) this.q = q;
    }

    // Integration fix: main.js calls this unconditionally when "Manual
    // Placement" is selected, regardless of decoder; this class had no
    // toggleErrorAtPosition() at all, so a canvas click while this decoder
    // was loaded threw. A no-op is correct here too: this decoder models
    // ongoing phenomenological noise, not a one-shot manually-placed error
    // pattern.
    toggleErrorAtPosition() {}

    sizeOf(k) {
        return this.L / Math.pow(this.n, k);
    }

    _initState() {
        const L = this.L;
        this.slices = [];
        for (let k = 0; k < this.K; k++) {
            this.slices.push(makeSlice(this.sizeOf(k), this.n, k > 0));
        }
        this.pending = new Map(); // arrivalTime -> [[kTarget,yx,yy,ax,ay], ...]
        this.t = -1;
        this.stepCount = 0;

        this.bx = zeros2D(L, false); // current-round physical error (public; test mode leaves this at zero)
        this.by = zeros2D(L, false);
        this._genBx = zeros2D(L, false);   // generation cursor: advances as environment chunks are pre-generated
        this._genBy = zeros2D(L, false);
        this._genSTildePrev = zeros2D(L, false);
        this._env = [];
    }

    // ---- Environment (phenomenological noise), pre-generated in
    // T_future-round chunks -- mirrors repetition_streaming.js exactly. ----

    _genRound() {
        const L = this.L;
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (this._rng() < this.pPhys) this._genBx[x][y] = !this._genBx[x][y];
                if (this._rng() < this.pPhys) this._genBy[x][y] = !this._genBy[x][y];
            }
        }
        const sTilde = physicalSyndrome(this._genBx, this._genBy, L);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (this._rng() < this.pMeas) sTilde[x][y] = !sTilde[x][y];
            }
        }
        const phi = zeros2D(L, false);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                phi[x][y] = sTilde[x][y] !== this._genSTildePrev[x][y];
            }
        }
        this._genSTildePrev = sTilde;
        return { phi, bx: clone2D(this._genBx), by: clone2D(this._genBy) };
    }

    _extendEnvironmentChunk() {
        for (let i = 0; i < this.T_future; i++) this._env.push(this._genRound());
    }

    _ensureEnvironment(uptoIndex) {
        if (this._explicitPhi) return;
        while (this._env.length <= uptoIndex) this._extendEnvironmentChunk();
    }

    // The next `count` not-yet-consumed rounds of the environment (each
    // {phi, bx, by}), for a renderer that wants to preview upcoming noise
    // ahead of the decoder (undefined entries in explicit-phi test mode,
    // which has no underlying physical-bit environment to report).
    getFutureRounds(count) {
        if (this._explicitPhi) return new Array(count).fill(undefined);
        this._ensureEnvironment(this.stepCount + count - 1);
        const rounds = [];
        for (let i = 0; i < count; i++) rounds.push(this._env[this.stepCount + i]);
        return rounds;
    }

    // Generic-decoder-interface compatibility (mirrors repetition_streaming.js):
    // re-seed and restart from t=-1 with new noise rates.
    initializeRandomErrors(p, rng = Math.random) {
        this.pPhys = p;
        if (!this._pMeasOverridden) this.pMeas = p;
        this._rng = rng;
        this._initState();
        this._explicitPhi = null;
        this._extendEnvironmentChunk();
    }

    // -----------------------------------------------------------------
    // Test-only: bypass the noise environment entirely and feed an
    // explicit, pre-computed phi history (one L x L boolean array per
    // round, indexed by stepCount) -- so a Node harness can drive this
    // decoder with the *exact* same phi(.,t) sequence a Python reference
    // run used, for bit-for-bit cross-validation of the CA channels (not
    // of the noise model, which is deliberately implementation-specific;
    // see website/tests/check_cg_streaming_toric.mjs). Resets the decoder
    // state to t=-1 / stepCount=0.
    // -----------------------------------------------------------------
    setExplicitPhiHistory(phiHistory) {
        this._explicitPhi = phiHistory;
        this._initState();
    }

    // -----------------------------------------------------------------
    // Stage 1: record intake -- main.tex:5072-5107
    // -----------------------------------------------------------------
    _recordIntake() {
        const K = this.K, tNext = this.t + 1;
        const eChildNext = new Array(K).fill(null);
        const rhoNext = new Array(K).fill(null);
        for (let k = 1; k < K; k++) {
            eChildNext[k] = clone4D(this.slices[k].e_child);
            rhoNext[k] = clone2D(this.slices[k].rho);
        }
        const due = this.pending.get(tNext);
        if (due) {
            for (const [kTarget, yx, yy, ax, ay] of due) {
                eChildNext[kTarget][yx][yy][ax][ay] = !eChildNext[kTarget][yx][yy][ax][ay];
                rhoNext[kTarget][yx][yy] = !rhoNext[kTarget][yx][yy];
            }
        }
        return { eChildNext, rhoNext };
    }

    // -----------------------------------------------------------------
    // Stage 2: movement indicators + defect-sector update -- main.tex:5109-5225
    // -----------------------------------------------------------------
    _defectUpdate(phiNext, rhoNext) {
        const { K, n, t0, t, movementGated } = this;
        const exNext = this.slices.map(sl => clone2D(sl.e_x));
        const eyNext = this.slices.map(sl => clone2D(sl.e_y));
        const sNext = new Array(K);
        const tauNext = new Array(K);
        const newPending = new Map(); // arrivalTime -> [[kTarget,yx,yy,ax,ay],...]

        const addPending = (arrivalT, rec) => {
            if (!newPending.has(arrivalT)) newPending.set(arrivalT, []);
            newPending.get(arrivalT).push(rec);
        };

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            if (mod(t, Math.pow(n, k)) !== 0) {
                sNext[k] = clone2D(sl.s);
                tauNext[k] = clone2D(sl.tau);
                continue;
            }

            const Lk = sl.Lk;
            const timed = k < K - 1;
            const candidates = new Map(); // key = x*Lk+y -> array of timers

            const addCandidate = (x, y, timer) => {
                const key = x * Lk + y;
                if (!candidates.has(key)) candidates.set(key, []);
                candidates.get(key).push(timer);
            };

            if (k === 0) {
                for (let x = 0; x < Lk; x++) {
                    for (let y = 0; y < Lk; y++) {
                        if (phiNext[x][y]) addCandidate(x, y, 0); // (env, 0)
                    }
                }
            }

            if (k > 0) {
                const rk = rhoNext[k];
                for (let rx = 0; rx < Lk; rx++) {
                    for (let ry = 0; ry < Lk; ry++) {
                        if (rk[rx][ry]) {
                            addCandidate(rx, ry, 0); // (up, 0) / (up, None)
                            rk[rx][ry] = false;
                        }
                    }
                }
            }

            const m00 = sl.m[0], m01 = sl.m[1], m10 = sl.m[2];
            for (let x = 0; x < Lk; x++) {
                for (let y = 0; y < Lk; y++) {
                    if (!sl.s[x][y]) continue;
                    const xLeft = mod(x - 1, Lk), yDown = mod(y - 1, Lk);
                    let tauPlus = 0;

                    if (timed) {
                        tauPlus = sl.tau[x][y] + 1;
                        if (tauPlus === t0) {
                            const px = Math.floor(x / n), py = Math.floor(y / n);
                            const ax = mod(x, n), ay = mod(y, n);
                            const arrivalT = t + Math.pow(n, k + 1) + 1;
                            addPending(arrivalT, [k + 1, px, py, ax, ay]);
                            continue;
                        }
                    }

                    const cVal = sl.c[x][y];
                    const moveAllowed = (!movementGated) || cVal === 0;
                    const lamX = moveAllowed && (m00[xLeft][y] || m01[xLeft][y]);
                    const lamY = (!lamX) && moveAllowed && (m00[x][yDown] || m10[x][yDown]);

                    if (lamX) {
                        exNext[k][x][y] = !exNext[k][x][y];
                        addCandidate(xLeft, y, tauPlus);
                    } else if (lamY) {
                        eyNext[k][x][y] = !eyNext[k][x][y];
                        addCandidate(x, yDown, tauPlus);
                    } else {
                        addCandidate(x, y, tauPlus);
                    }
                }
            }

            const sK = zeros2D(Lk, false);
            const tauK = zeros2D(Lk, 0);
            for (const [key, timers] of candidates) {
                if (timers.length % 2 === 1) {
                    const x = Math.floor(key / Lk), y = key % Lk;
                    sK[x][y] = true;
                    if (timed) tauK[x][y] = Math.min(...timers);
                }
            }
            sNext[k] = sK;
            tauNext[k] = tauK;
        }

        return { exNext, eyNext, sNext, tauNext, rhoNext, newPending };
    }

    // -----------------------------------------------------------------
    // Stage 3: N_ij / ToomVote / growth / coupling / persistence +
    // message-sector update -- main.tex:5227-5404
    //
    // _messageSliceUpdate is the per-slice core, shared by the real
    // per-round update below (enableGrowth=true, freezeTheta=false,
    // called only on firing slices with the freshly-resolved
    // sCurr/tauCurr = sNext[k]/tauNext[k]) and erasureSubstep() further
    // down (enableGrowth=false, freezeTheta=true, called on EVERY slice
    // with sCurr=sl.s/tauCurr=sl.tau -- the defect sector held fixed) --
    // see anim/cg_streaming_toric.py's _message_slice_update docstring,
    // which this mirrors line for line. When enableGrowth is false the
    // growth candidate/term (G) is simply never computed; defect-sourcing
    // (D/S) and persistence (P/coupling) are otherwise identical to the
    // real rule. When freezeTheta is true, a channel's theta output is its
    // *old* value whenever the message survives, rather than
    // min(bCandidates): real steps still advance a surviving message's
    // timer; erasure sub-steps do not.
    // -----------------------------------------------------------------
    _messageSliceUpdate(sl, sCurr, tauCurr, timed, enableGrowth, freezeTheta) {
        const { t0, growthWindow } = this;
        const Lk = sl.Lk;
        const sT = sl.s, tauT = sl.tau, cT = sl.c;
        const mK = zeros3D(3, Lk, false);
        const thetaK = zeros3D(3, Lk, 0);

        for (let x = 0; x < Lk; x++) {
            for (let y = 0; y < Lk; y++) {
                const vote00 = toomVote(sl.m[0], 0, 0, x, y, Lk);
                const coupling = sl.m[0][x][y] && vote00;

                if (timed) {
                    const dCandidates = [];
                    if (sCurr[x][y]) dCandidates.push(tauCurr[x][y]);
                    if (sT[x][y] && tauT[x][y] + 1 < t0) dCandidates.push(tauT[x][y] + 1);

                    for (let idx = 0; idx < 3; idx++) {
                        const [i, j] = MESSAGE_CHANNELS[idx];
                        const messageT = sl.m[idx], thetaT = sl.theta[idx];
                        const bCandidates = dCandidates.slice();

                        if (enableGrowth) {
                            const sources = growthSources(i, j, x, y, Lk);
                            const validGrowth = [];
                            for (const [px, py] of sources) {
                                if (messageT[px][py] && thetaT[px][py] < t0 - 1) validGrowth.push(thetaT[px][py]);
                            }
                            if (cT[x][y] < growthWindow && validGrowth.length > 0) {
                                bCandidates.push(1 + Math.min(...validGrowth));
                            }
                        }

                        const ownVote = toomVote(messageT, i, j, x, y, Lk);
                        const persistence = messageT[x][y] && (thetaT[x][y] < t0 - 1) && (ownVote || coupling);
                        if (persistence) bCandidates.push(thetaT[x][y] + 1);

                        if (bCandidates.length > 0) {
                            mK[idx][x][y] = true;
                            thetaK[idx][x][y] = freezeTheta ? thetaT[x][y] : Math.min(...bCandidates);
                        }
                    }
                } else {
                    const sSource = sCurr[x][y] || sT[x][y];
                    for (let idx = 0; idx < 3; idx++) {
                        const [i, j] = MESSAGE_CHANNELS[idx];
                        const messageT = sl.m[idx];
                        let growth = false;
                        if (enableGrowth) {
                            const sources = growthSources(i, j, x, y, Lk);
                            growth = (cT[x][y] < growthWindow) &&
                                sources.some(([px, py]) => messageT[px][py]);
                        }
                        const ownVote = toomVote(messageT, i, j, x, y, Lk);
                        const persistence = messageT[x][y] && (ownVote || coupling);
                        mK[idx][x][y] = sSource || growth || persistence;
                        // thetaK stays all-zero on the untimed slice, exactly as before
                        // (freezeTheta is moot here: this branch never had a theta to freeze).
                    }
                }
            }
        }

        return { mK, thetaK };
    }

    _messageUpdate(sNext, tauNext) {
        const { K, n, q, t } = this;
        const mNext = this.slices.map(sl => clone3D(sl.m));
        const thetaNext = this.slices.map(sl => clone3D(sl.theta));
        const cNext = this.slices.map(sl => clone2D(sl.c));

        for (let k = 0; k < K; k++) {
            if (mod(t, Math.pow(n, k)) !== 0) continue;

            const sl = this.slices[k];
            const timed = k < K - 1;
            const { mK, thetaK } = this._messageSliceUpdate(sl, sNext[k], tauNext[k], timed, true, false);

            mNext[k] = mK;
            thetaNext[k] = thetaK;
            cNext[k] = sl.c.map(row => row.map(v => (v + 1) % q));
        }

        return { mNext, thetaNext, cNext };
    }

    // -----------------------------------------------------------------
    // Erasure sub-step (not part of the cited excerpt): the message
    // sector's persistence/erosion rule ONLY (_messageSliceUpdate with
    // enableGrowth=false, freezeTheta=true), applied to EVERY slice
    // k=0..K-1 regardless of which slices would normally fire at this t --
    // unlike a real step, an erasure sub-step is not gated by t % n**k,
    // since it is not part of the paper's own per-slice cadence at all.
    // step() calls this exactly `erasureMoves` times after every real
    // round. Does not touch the defect sector (s, tau), the clock (c),
    // promotion bookkeeping (rho, pending), corrections (e_x, e_y,
    // e_child), or t -- only m (and, on timed slices, theta, frozen at its
    // old value wherever a message survives) can change. See the
    // constructor's erasureMoves comment and anim/cg_streaming_toric.py's
    // erasure_substep docstring.
    // -----------------------------------------------------------------
    erasureSubstep() {
        const newSlices = new Array(this.K);
        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k];
            const timed = k < this.K - 1;
            const { mK, thetaK } = this._messageSliceUpdate(sl, sl.s, sl.tau, timed, false, true);
            newSlices[k] = {
                Lk: sl.Lk,
                e_x: clone2D(sl.e_x), e_y: clone2D(sl.e_y),
                e_child: sl.e_child === null ? null : clone4D(sl.e_child),
                s: clone2D(sl.s), tau: clone2D(sl.tau),
                m: mK, theta: thetaK, c: clone2D(sl.c),
                rho: sl.rho === null ? null : clone2D(sl.rho),
            };
        }
        this.slices = newSlices;
        // this.pending, this.t, this.stepCount, this.bx, this.by untouched.
    }

    // -----------------------------------------------------------------
    // One full update from time t to t+1 (main.tex:5054-5058).
    // -----------------------------------------------------------------
    step() {
        this._ensureEnvironment(this.stepCount);
        const round = this._explicitPhi
            ? { phi: this._explicitPhi[this.stepCount] }
            : this._env[this.stepCount];
        if (round.phi === undefined) {
            throw new Error("explicit phi history exhausted");
        }
        const phiNext = round.phi;
        if (!this._explicitPhi) { this.bx = round.bx; this.by = round.by; }
        this._lastPhi = phiNext;

        const tNext = this.t + 1;
        const { eChildNext, rhoNext } = this._recordIntake();
        const { exNext, eyNext, sNext, tauNext, rhoNext: rhoAfter, newPending } =
            this._defectUpdate(phiNext, rhoNext);
        const { mNext, thetaNext, cNext } = this._messageUpdate(sNext, tauNext);

        const pendingNext = new Map();
        for (const [tt, recs] of this.pending) {
            if (tt !== tNext) pendingNext.set(tt, recs);
        }
        for (const [tt, recs] of newPending) {
            if (!pendingNext.has(tt)) pendingNext.set(tt, []);
            pendingNext.get(tt).push(...recs);
        }

        const newSlices = new Array(this.K);
        for (let k = 0; k < this.K; k++) {
            newSlices[k] = {
                Lk: this.slices[k].Lk,
                e_x: exNext[k], e_y: eyNext[k], e_child: eChildNext[k],
                s: sNext[k], tau: tauNext[k],
                m: mNext[k], theta: thetaNext[k], c: cNext[k],
                rho: rhoAfter[k],
            };
        }
        this.slices = newSlices;
        this.pending = pendingNext;
        this.t = tNext;
        this.stepCount++;

        // Extra message-only erasure sub-steps (not part of the cited
        // excerpt): run entirely "inside" this one real step -- t and
        // stepCount already advanced above and do not move again here,
        // however large erasureMoves is. See erasureSubstep()'s comment.
        for (let i = 0; i < this.erasureMoves; i++) this.erasureSubstep();
    }

    // -----------------------------------------------------------------
    // Physical correction expansion -- main.tex:4977-4994
    // -----------------------------------------------------------------
    expandCorrection() {
        const { L, n } = this;
        const Ex = zeros2D(L, false), Ey = zeros2D(L, false);

        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k];
            const nk = Math.pow(n, k);
            const Lk = sl.Lk;

            for (let rx = 0; rx < Lk; rx++) {
                for (let ry = 0; ry < Lk; ry++) {
                    if (sl.e_x[rx][ry]) {
                        const [cx, cy] = center0(k, rx, ry, n);
                        applyXRun(Ex, cy, cx, -nk, L);
                    }
                    if (sl.e_y[rx][ry]) {
                        const [cx, cy] = center0(k, rx, ry, n);
                        applyYRun(Ey, cx, cy, -nk, L);
                    }
                }
            }

            if (k > 0) {
                for (let rx = 0; rx < Lk; rx++) {
                    for (let ry = 0; ry < Lk; ry++) {
                        for (let ax = 0; ax < n; ax++) {
                            for (let ay = 0; ay < n; ay++) {
                                if (!sl.e_child[rx][ry][ax][ay]) continue;
                                const parent0 = center0(k, rx, ry, n);
                                const child0 = center0(k - 1, n * rx + ax, n * ry + ay, n);
                                const dx = shortestDelta(child0[0], parent0[0], L);
                                const dy = shortestDelta(child0[1], parent0[1], L);
                                applyXRun(Ex, child0[1], child0[0], dx, L);
                                applyYRun(Ey, parent0[0], child0[1], dy, L);
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

    getSyndromeCount() {
        let count = 0;
        const s0 = this.slices[0].s;
        for (let x = 0; x < this.L; x++) for (let y = 0; y < this.L; y++) if (s0[x][y]) count++;
        return count;
    }

    // Residual weight: Hamming weight of (bx xor Ex, by xor Ey).
    getErrorCount() {
        const { Ex, Ey } = this.expandCorrection();
        let count = 0;
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                if (this.bx[x][y] !== Ex[x][y]) count++;
                if (this.by[x][y] !== Ey[x][y]) count++;
            }
        }
        return count;
    }

    // Number of live (nonzero-syndrome) sites in the residual -- unlike
    // getErrorCount()'s raw edge weight, this is the genuine decoder-health
    // metric: it stays bounded even while edge weight grows, because every
    // correction that does not retrace its error's exact path leaves a
    // closed (syndrome-free) loop in the residual. See
    // website/tests/test_cg_streaming_toric.py's Part (d) docstring.
    getResidualDefectCount() {
        const { Ex, Ey } = this.expandCorrection();
        const residualX = zeros2D(this.L, false), residualY = zeros2D(this.L, false);
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                residualX[x][y] = this.bx[x][y] !== Ex[x][y];
                residualY[x][y] = this.by[x][y] !== Ey[x][y];
            }
        }
        const residualSyndrome = physicalSyndrome(residualX, residualY, this.L);
        let count = 0;
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                if (residualSyndrome[x][y]) count++;
            }
        }
        return count;
    }

    hasMessages() {
        for (const sl of this.slices) {
            for (let idx = 0; idx < 3; idx++) {
                for (let x = 0; x < sl.Lk; x++) {
                    for (let y = 0; y < sl.Lk; y++) {
                        if (sl.m[idx][x][y]) return true;
                    }
                }
            }
        }
        return false;
    }

    // A streaming decoder under live phenomenological noise never truly
    // "finishes" -- pPhys/pMeas keep injecting fresh detector events every
    // round, so there is no terminal state to freeze at while noise is on
    // (matches repetition_streaming.js's isQuiescent exactly). Only
    // reports quiescent in the degenerate case where both noise rates are
    // exactly zero and the decoder has already cleared everything.
    isQuiescent() {
        if (this.pPhys > 0 || this.pMeas > 0) return false;
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        const { Ex, Ey } = this.expandCorrection();
        const residualX = zeros2D(this.L, false), residualY = zeros2D(this.L, false);
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                residualX[x][y] = this.bx[x][y] !== Ex[x][y];
                residualY[x][y] = this.by[x][y] !== Ey[x][y];
            }
        }
        const residualSyndrome = physicalSyndrome(residualX, residualY, this.L);
        let residualClear = true;
        for (let x = 0; x < this.L && residualClear; x++) {
            for (let y = 0; y < this.L; y++) {
                if (residualSyndrome[x][y]) { residualClear = false; break; }
            }
        }
        const [wx, wy] = windingParities(residualX, residualY, this.L);
        const hasError = residualClear && (wx || wy);
        const result = { hasError, horizontal: wx, vertical: wy, residualClear };
        if (hasError) result.description = 'nontrivial winding on the cleared residual';
        return result;
    }

    // -----------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------

    // Chooses whichever of {single row, 2-column grid (only when
    // nPanels<=4)} of the K+1 panels (K slices + residual) maximises panel
    // cell size for the given canvas, given a top-centred "t=N" label, a
    // title above every individual panel, and a stats line + legend below
    // the block. Centres the resulting block both horizontally and
    // vertically in the space between the label and the stats/legend.
    // Two panels only (hierarchy lattice, residual), side by side or
    // stacked -- whichever maximises cell size -- centred both ways in the
    // space below the top-centred "t = N" label and above the stats +
    // legend lines. No HTML-overlay reservation: the website's canvas-
    // legend tabs (this one included) have that overlay hidden by main.js.
    _layout(canvasWidth, canvasHeight) {
        const L = this.L;
        const margin = 12;
        const gap = 16;

        const topLabelH = 24;      // centred "t = N"
        const titleGap = 8;
        const panelTitleH = 16;    // each panel's own title, drawn just above it
        const titleToPanelGap = 3;
        const perPanelHeaderH = panelTitleH + titleToPanelGap;
        const gapBelowBlock = 10;
        const statsH = 18;         // stats line (defects/residual defects/weight/logical)
        const gapToLegend = 10;
        const legendH = 40;        // legend now spans up to 2 lines (per-level defect entries)

        const topReserve = margin + topLabelH + titleGap;
        const bottomReserve = gapBelowBlock + statsH + gapToLegend + legendH + margin;

        const availW = canvasWidth - 2 * margin;
        const availH = canvasHeight - topReserve - bottomReserve;

        // Option A: side by side (1 row, 2 cols).
        const sizeSideBySide = Math.min((availW - gap) / 2, availH - perPanelHeaderH);
        // Option B: stacked (2 rows, 1 col).
        const sizeStacked = Math.min(availW, (availH - gap) / 2 - perPanelHeaderH);

        const stacked = sizeStacked > sizeSideBySide;
        const cols = stacked ? 1 : 2;
        const rows = stacked ? 2 : 1;
        const rawPanelSize = Math.max(L, stacked ? sizeStacked : sizeSideBySide); // never below 1 px/cell

        const cell0 = Math.max(1, Math.floor(rawPanelSize / L));
        const panelSize = cell0 * L;

        const blockW = cols * panelSize + gap * (cols - 1);
        const blockH = rows * (perPanelHeaderH + panelSize) + gap * (rows - 1);

        const blockLeft = margin + Math.max(0, (availW - blockW) / 2);
        const blockTop = topReserve + Math.max(0, (availH - blockH) / 2);

        const panels = [];
        for (let p = 0; p < 2; p++) {
            const col = p % cols, row = Math.floor(p / cols);
            const rowTop = blockTop + row * (perPanelHeaderH + panelSize + gap);
            const left = blockLeft + col * (panelSize + gap);
            panels.push({
                left, size: panelSize,
                titleBaselineY: rowTop + panelTitleH - 3,
                top: rowTop + perPanelHeaderH,
            });
        }

        const blockBottom = blockTop + rows * (perPanelHeaderH + panelSize) + (rows - 1) * gap;

        return {
            L, cell0, panelSize, panels, cols, rows,
            topLabelBaselineY: margin + topLabelH * 0.75,
            statsBaselineY: blockBottom + gapBelowBlock + statsH * 0.75,
            legendTop: blockBottom + gapBelowBlock + statsH + gapToLegend,
        };
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showMessages = options.showMessages === true; // default off, per spec
        const layout = this._layout(canvasWidth, canvasHeight);

        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.textBaseline = 'alphabetic';

        // Top-centred "t = N" -- N is stepCount (number of step() calls
        // since initialisation), matching every other registered decoder's
        // convention; this module's own `t` field is a *different*,
        // paper-native absolute-time index starting at -1 (main.tex:5040-
        // 5041's canonical all-zero state), one less than stepCount, kept
        // internally as-is since the cross-validation harness checks it
        // against torca.reference's own time convention -- only the
        // on-canvas label uses stepCount.
        ctx.fillStyle = '#222222';
        ctx.font = 'bold 16px "Latin Modern Roman", "CMU Serif", serif';
        ctx.textAlign = 'center';
        ctx.fillText(`t = ${this.stepCount}`, canvasWidth / 2, layout.topLabelBaselineY);

        this._drawHierarchyPanel(ctx, layout.panels[0], showMessages);
        this._drawPanelLabel(ctx, layout.panels[0], `hierarchy (Λ0..Λ${this.K - 1})`);
        this._drawResidualPanel(ctx, layout.panels[1]);
        this._drawPanelLabel(ctx, layout.panels[1], 'residual');

        // Stats line, centred under the panel block: live decoder defects
        // (slice-0 syndrome weight), residual defects (the genuine
        // decoder-health metric -- see getResidualDefectCount), residual
        // weight (raw edge count -- NOT a health metric in 2D, see that
        // method's comment: it accumulates harmless closed loops), and the
        // logical indicator (only meaningful when the residual is clear).
        const logical = this.checkLogicalError();
        const logicalText = !logical.residualClear ? 'n/a' : (logical.hasError ? 'ERROR' : 'clear');
        ctx.font = '13px "Latin Modern Roman", "CMU Serif", serif';
        ctx.fillStyle = '#444444';
        ctx.textAlign = 'center';
        ctx.fillText(
            `defects=${this.getSyndromeCount()}   residual defects=${this.getResidualDefectCount()}   `
            + `residual weight=${this.getErrorCount()}   logical=${logicalText}`,
            canvasWidth / 2, layout.statsBaselineY
        );
        ctx.fillStyle = '#222222';
        ctx.textAlign = 'left';

        this._drawLegend(ctx, canvasWidth, canvasHeight, showMessages, layout.legendTop);

        ctx.restore();
    }

    _drawPanelLabel(ctx, panel, text) {
        ctx.fillStyle = '#444444';
        ctx.font = '13px "Latin Modern Roman", "CMU Serif", serif';
        ctx.textAlign = 'center';
        ctx.fillText(text, panel.left + panel.size / 2, panel.titleBaselineY);
        ctx.textAlign = 'left';
    }

    // The whole hierarchy on ONE L x L physical lattice, using the paper's
    // own "natural coarse-grained placement" (main.tex:4930-4932, restated
    // for the layout proof at main.tex:5554-5575): a slice-k site r is
    // identified with center0(k,r), the centre of its n^k x n^k physical
    // block. Draw order: message blocks (translucent, largest concept
    // first is irrelevant since fills just blend), the base physical grid,
    // nested per-level coarse grids (spacing n^k, coloured and weighted by
    // level), this round's detector-event crosses, then defect block
    // outlines + orbs (always on top, so defects are never obscured).
    _drawHierarchyPanel(ctx, panel, showMessages) {
        const { L, n, K } = this;
        const cell = panel.size / L;
        const MSG_COLORS = ['rgba(90,110,230,0.28)', 'rgba(220,80,80,0.22)', 'rgba(70,170,90,0.22)'];

        ctx.save();
        ctx.translate(panel.left, panel.top);

        // physical-cell (x,y) [+ an nk x nk block anchored there] -> pixel rect, y=0 at bottom
        const rect = (x, y, sizeInCells = 1) => {
            const px = x * cell;
            const pyTop = panel.size - (y + sizeInCells) * cell;
            return [px, pyTop, sizeInCells * cell];
        };

        if (showMessages) {
            for (let k = 0; k < K; k++) {
                const sl = this.slices[k];
                const nk = Math.pow(n, k);
                for (let idx = 0; idx < 3; idx++) {
                    const m = sl.m[idx];
                    for (let rx = 0; rx < sl.Lk; rx++) {
                        for (let ry = 0; ry < sl.Lk; ry++) {
                            if (!m[rx][ry]) continue;
                            const [px, pyTop, s] = rect(rx * nk, ry * nk, nk);
                            ctx.fillStyle = MSG_COLORS[idx];
                            ctx.fillRect(px, pyTop, s, s);
                        }
                    }
                }
            }
        }

        ctx.strokeStyle = 'rgb(195,195,195)';
        ctx.lineWidth = Math.max(0.4, cell / 50);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                const [px, pyTop, s] = rect(x, y);
                ctx.strokeRect(px, pyTop, s, s);
            }
        }

        for (let k = 1; k < K; k++) {
            const nk = Math.pow(n, k);
            ctx.strokeStyle = levelColor(k);
            ctx.lineWidth = Math.max(0.6, cell * 0.05 * (k + 1)); // heavier for coarser levels
            ctx.beginPath();
            for (let i = 0; i <= L / nk; i++) {
                const p = i * nk * cell;
                ctx.moveTo(p, 0); ctx.lineTo(p, panel.size);
                ctx.moveTo(0, panel.size - p); ctx.lineTo(panel.size, panel.size - p);
            }
            ctx.stroke();
        }

        if (this._lastPhi) {
            ctx.strokeStyle = 'rgb(230,140,0)';
            ctx.lineWidth = Math.max(1, cell / 12);
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    if (!this._lastPhi[x][y]) continue;
                    const cx = (x + 0.5) * cell, cy = panel.size - (y + 0.5) * cell;
                    const r = cell * 0.22;
                    ctx.beginPath();
                    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
                    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
                    ctx.stroke();
                }
            }
        }

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            const nk = Math.pow(n, k);
            const timed = k < K - 1;
            for (let rx = 0; rx < sl.Lk; rx++) {
                for (let ry = 0; ry < sl.Lk; ry++) {
                    if (!sl.s[rx][ry]) continue;

                    if (k > 0) {
                        const [px, pyTop, s] = rect(rx * nk, ry * nk, nk);
                        const lw = Math.max(1, cell * 0.12);
                        ctx.strokeStyle = levelColor(k);
                        ctx.lineWidth = lw;
                        ctx.strokeRect(px + lw / 2, pyTop + lw / 2, s - lw, s - lw);
                    }

                    const [ccx, ccy] = center0(k, rx, ry, n);
                    const cx = (ccx + 0.5) * cell, cy = panel.size - (ccy + 0.5) * cell;
                    const r = Math.min(cell * 0.36 + k * cell * 0.05, nk * cell * 0.42);
                    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
                    grad.addColorStop(0, '#ffffff');
                    grad.addColorStop(1, levelColor(k)); // per-level colour cue, alongside the block outline above
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.lineWidth = Math.max(0.75, cell / 20);
                    ctx.strokeStyle = '#000000';
                    ctx.stroke();

                    if (timed && this.t0 > 0) {
                        const frac = Math.min(1, sl.tau[rx][ry] / this.t0);
                        if (frac > 0) {
                            ctx.fillStyle = 'rgba(200,30,30,0.85)';
                            ctx.beginPath();
                            ctx.moveTo(cx, cy);
                            ctx.arc(cx, cy, r * 0.55, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
                            ctx.closePath();
                            ctx.fill();
                        }
                    }
                }
            }
        }

        ctx.restore();
    }

    _drawResidualPanel(ctx, panel) {
        const L = this.L;
        const cell = panel.size / L;
        const { Ex, Ey } = this.expandCorrection();
        const residualX = zeros2D(L, false), residualY = zeros2D(L, false);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                residualX[x][y] = this.bx[x][y] !== Ex[x][y];
                residualY[x][y] = this.by[x][y] !== Ey[x][y];
            }
        }
        const residualSyndrome = physicalSyndrome(residualX, residualY, L);

        ctx.save();
        ctx.translate(panel.left, panel.top);

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                const py = panel.size - (y + 1) * cell;
                ctx.strokeStyle = 'rgb(150,150,150)';
                ctx.lineWidth = Math.max(0.5, cell / 40);
                ctx.strokeRect(x * cell, py, cell, cell);
            }
        }

        // Residual strings (user convention): a red piece joins the
        // CENTRES of the two cells the qubit separates -- qx[x,y]: centre
        // of (x-1,y) to centre of (x,y); qy[x,y]: centre of (x,y-1) to
        // centre of (x,y) -- rather than a link along their shared edge,
        // so a chain of residual edges reads as one continuous string
        // between its endpoint defects (like the repetition-code strings).
        // A torus-wrapping piece (x=0 or y=0) is drawn as two half-pieces
        // out to the panel's borders instead of one line spanning the
        // whole panel. Round caps so consecutive pieces join cleanly.
        // Drawn before the defect orbs below, so orbs sit on top.
        ctx.strokeStyle = 'rgb(190,40,40)';
        ctx.lineWidth = Math.max(1.5, cell / 8);
        ctx.lineCap = 'round';
        const centerPx = (x, y) => [(x + 0.5) * cell, panel.size - (y + 0.5) * cell];

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (residualX[x][y]) {
                    const [cx2, cy2] = centerPx(x, y);
                    if (x === 0) {
                        ctx.beginPath(); ctx.moveTo(cx2, cy2); ctx.lineTo(0, cy2); ctx.stroke();
                        const [px1, py1] = centerPx(L - 1, y);
                        ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(panel.size, py1); ctx.stroke();
                    } else {
                        const [cx1, cy1] = centerPx(x - 1, y);
                        ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
                    }
                }
                if (residualY[x][y]) {
                    const [cx2, cy2] = centerPx(x, y);
                    if (y === 0) {
                        ctx.beginPath(); ctx.moveTo(cx2, cy2); ctx.lineTo(cx2, panel.size); ctx.stroke();
                        const [px1, py1] = centerPx(x, L - 1);
                        ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px1, 0); ctx.stroke();
                    } else {
                        const [cx1, cy1] = centerPx(x, y - 1);
                        ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
                    }
                }
            }
        }

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (!residualSyndrome[x][y]) continue;
                const [cx, cy] = centerPx(x, y);
                const r = cell * 0.36;
                const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
                grad.addColorStop(0, '#ffffff');
                grad.addColorStop(1, '#555555');
                ctx.fillStyle = grad;
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill();
                ctx.lineWidth = Math.max(0.75, cell / 20);
                ctx.strokeStyle = '#000000';
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    _drawLegend(ctx, canvasWidth, canvasHeight, showMessages, legendTop) {
        const fs = 12;
        const margin = 12;
        const lineGap = 16;
        ctx.font = `${fs}px "Latin Modern Roman", "CMU Serif", serif`;
        ctx.textAlign = 'left';

        let x = margin, y = (legendTop ?? (canvasHeight - 30)) + fs;
        const wrap = (w) => {
            if (x + w > canvasWidth - margin) { x = margin; y += lineGap; }
        };

        const orbR = 6;
        const drawOrb = (cx, cy, color) => {
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
            grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, color);
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, 2 * Math.PI); ctx.fill();
            ctx.lineWidth = 1; ctx.strokeStyle = '#000000'; ctx.stroke();
        };

        for (let k = 0; k < this.K; k++) {
            const label = `level ${k} defect`;
            const w = 2 * orbR + 6 + ctx.measureText(label).width + 16;
            wrap(w);
            drawOrb(x + orbR, y - orbR + 3, levelColor(k));
            ctx.fillStyle = '#333333';
            ctx.fillText(label, x + 2 * orbR + 6, y);
            x += w;
        }
        {
            const note = '(arc = timer fraction)';
            wrap(ctx.measureText(note).width + 16);
            ctx.fillStyle = '#333333';
            ctx.fillText(note, x, y);
            x += ctx.measureText(note).width + 16;
        }

        {
            const label = 'detector event (this round)';
            const w = 14 + ctx.measureText(label).width + 18;
            wrap(w);
            ctx.strokeStyle = 'rgb(230,140,0)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, y - 10); ctx.lineTo(x + 9, y - 1);
            ctx.moveTo(x, y - 1); ctx.lineTo(x + 9, y - 10);
            ctx.stroke();
            ctx.fillStyle = '#333333';
            ctx.fillText(label, x + 14, y);
            x += w;
        }

        {
            const label = 'residual error (string)';
            const w = 22 + ctx.measureText(label).width + 18;
            wrap(w);
            ctx.strokeStyle = 'rgb(190,40,40)';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 16, y - 5); ctx.stroke();
            ctx.fillStyle = '#333333';
            ctx.fillText(label, x + 22, y);
            x += w;
        }

        if (showMessages) {
            const label = 'messages m00/m01/m10';
            const w = 50 + ctx.measureText(label).width + 16;
            wrap(w);
            ctx.fillStyle = 'rgba(90,110,230,0.45)'; ctx.fillRect(x, y - 11, 14, 12);
            ctx.fillStyle = 'rgba(220,80,80,0.40)'; ctx.fillRect(x + 16, y - 11, 14, 12);
            ctx.fillStyle = 'rgba(70,170,90,0.40)'; ctx.fillRect(x + 32, y - 11, 14, 12);
            ctx.fillStyle = '#333333';
            ctx.fillText(label, x + 50, y);
            x += w;
        }
    }
}
