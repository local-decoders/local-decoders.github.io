// Toric-code streaming decoder -- literal JS port of anim/streaming_toric.py,
// which is itself a literal NumPy transcription of the paper's
// translation-invariant streaming decoder for the toric code under
// phenomenological noise. Full citations into
// local-comp-numerics/reference/paper/main.tex live in that Python module's
// docstring; the short version:
//
//   - Algorithm alg:layered-toric-defect-update   (main.tex:3203-3274)
//   - Algorithm alg:layered-toric-message-update  (main.tex:3405-3509)
//   - base per-slice rule: Algorithm alg:toric-code (main.tex:2566-2618),
//     verified as torca.reference.step_sync in local-comp-numerics.
//
// Array convention (torca/CONVENTIONS.md, matched exactly): every grid is
// indexed grid[x][y], x in [0,L), y in [0,L), both periodic; the stabilizer
// at r=(x,y) is s(r) = qx(r) ^ qx(r+x) ^ qy(r) ^ qy(r+y); flipping qx(r)
// moves a defect r -> r-x, flipping qy(r) moves a defect r -> r-y; the three
// message channels are m00 (propagating (+x,+y)), m01 (propagating
// (+x,-y)), m10 (propagating (-x,+y)).
//
// Base-rule gating: messages grow when the local clock c is in
// {0,...,growthWindow-1}; defects move only when c==0 if movementGated.
// The paper's *formal* streaming convention (main.tex:3149-3152) is
// growthWindow=2 (c in {0,1}), movementGated=true, with q=3. That is NOT
// this module's default: measurement showed the formal (gated) rule fails
// on small tori, because a gated defect closes distance at only 1 site per
// q steps while an ungated message front still spreads at (q-1)/q sites
// per step, so the message front wraps the periodic lattice and reaches a
// cluster's own leftmost defect from behind before the pair can close its
// own gap. The DEFAULT here instead matches this project's numerics-style
// code-capacity convention: clockPeriod (q) = 6, growthWindow = 1 (growth
// only at c==0), movementGated = false (movement every step), K = 3, t0 =
// 4 -- matching anim/streaming_toric.py's own defaults, which were
// confirmed (not just assumed) by a (t0, K) sweep; see that module's
// docstring and toric_streaming.REGISTER.md for the sweep table. The
// formal rule remains reachable by passing q=3 as clockPeriod and {
// movementGated: true, growthWindow: 2 } explicitly; default-options
// behavior against the Python reference is checked for both rules in
// website/tests/check_streaming_toric.mjs.
//
// Residual health metric: getErrorCount() (the raw residual edge weight)
// is informational only, not a health indicator -- it climbs even under a
// perfectly healthy decoder because every correction that fails to
// exactly retrace a physical error's own worldline still XORs a
// syndrome-free closed loop into the residual, and nothing ever erases an
// old loop (see anim/streaming_toric.py's docstring for the full
// argument, and the "Choosing K and t0" / "Residual health" sections of
// toric_streaming.REGISTER.md). getResidualDefectCount() (the residual
// SYNDROME weight, i.e. live defects) is the quantity that reflects
// whether the decoder is keeping up; it is shown in the residual panel's
// own title ("residual (defects=N)") and should ideally also appear next
// to "Errors" in any external stats display.
//
// K=1 note: the Python reference's own test suite
// (website/tests/test_streaming_toric.py) found that this streaming
// construction's back-wall message rule can genuinely diverge from
// torca.reference.step_sync's SetAll-based message rule at sites where two
// defect-movement candidates arrive from perpendicular directions in the
// same step and annihilate (the paper's rule consults only the *resolved*
// post-annihilation defect parity, never the raw arrival count), for any
// choice of movementGated/growthWindow. This port reproduces that same
// paper-literal behavior, not step_sync's.

const MESSAGE_CHANNELS = [[0, 0], [0, 1], [1, 0]]; // m00, m01, m10

const FONT_SERIF = '"Latin Modern Roman", "CMU Serif", "Times New Roman", serif';
const COLOR_GRID = 'rgb(128,128,128)';
const COLOR_ERROR = 'rgb(175,55,55)';
const COLOR_ORB_RIM = 'rgb(82,82,82)';
const COLOR_TEXT = '#000000';
const LABEL_FONT_SIZE = 15;
const LEGEND_FONT_SIZE = 13;
const MESSAGE_TINTS = ['rgba(170,195,255,0.30)', 'rgba(140,175,255,0.50)', 'rgba(110,155,255,0.72)'];

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mod(x, m) {
    return ((x % m) + m) % m;
}

function zeros2D(L) {
    return Array.from({ length: L }, () => new Array(L).fill(false));
}

function zerosInt2D(L) {
    return Array.from({ length: L }, () => new Array(L).fill(0));
}

function zeros3D(K, L) {
    return Array.from({ length: K }, () => zeros2D(L));
}

function zerosInt3D(K, L) {
    return Array.from({ length: K }, () => zerosInt2D(L));
}

function cloneGrid(grid) {
    return grid.map((row) => row.slice());
}

function cloneGrid3D(stack) {
    return stack.map((grid) => cloneGrid(grid));
}

// Exported (not just used internally) so a test harness can exercise the
// environment-generation formula -- syndromeGrid + this XOR recurrence --
// directly, independent of setPhiHistory, which bypasses both entirely.
// This is exactly the gap that let a syndromeGrid indexing bug (the y-term
// read qy[yp][y], which doesn't depend on x, instead of qy[x][yp]) ship
// undetected: see website/tests/check_streaming_toric.mjs's "generator
// path" and "single-flip" checks.
export function xorGrids(a, b) {
    return a.map((row, x) => row.map((v, y) => v !== b[x][y]));
}

// s(r) = qx(r) ^ qx(r+x) ^ qy(r) ^ qy(r+y) (torca/CONVENTIONS.md).
export function syndromeGrid(qx, qy, L) {
    const s = zeros2D(L);
    for (let x = 0; x < L; x++) {
        const xp = mod(x + 1, L);
        for (let y = 0; y < L; y++) {
            const yp = mod(y + 1, L);
            s[x][y] = (qx[x][y] !== qx[xp][y]) !== (qy[x][y] !== qy[x][yp]);
        }
    }
    return s;
}

// ToomVote(i,j,r,t): Maj of m(r), m(r+(-1)^{i+1}x), m(r+(-1)^{j+1}y).
function toomVote(message, i, j, x, y, L) {
    const srcX = mod(x + (i === 0 ? -1 : 1), L);
    const srcY = mod(y + (j === 0 ? -1 : 1), L);
    const votes = (message[x][y] ? 1 : 0) + (message[srcX][y] ? 1 : 0) + (message[x][srcY] ? 1 : 0);
    return votes >= 2;
}

// N_ij(r) = {r + (-1)^{i+1} x, r + (-1)^{j+1} y}, as two lattice points.
function growthSources(i, j, x, y, L) {
    const srcX = mod(x + (i === 0 ? -1 : 1), L);
    const srcY = mod(y + (j === 0 ? -1 : 1), L);
    return [[srcX, y], [x, srcY]];
}

function drawOrb(ctx, cx, cy, cell) {
    const r = 0.34 * cell;
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, COLOR_ORB_RIM);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.strokeStyle = '#000000';
    ctx.stroke();
}

export class ToricStreamingDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        this.L = L;
        this.q = (Number.isFinite(clockPeriod) && clockPeriod >= 2) ? Math.round(clockPeriod) : 6;

        this.K = (Number.isInteger(opts.K) && opts.K >= 1) ? opts.K : 3;
        this.t0 = (Number.isInteger(opts.t0) && opts.t0 >= 1) ? opts.t0 : 4;
        this.n = (Number.isInteger(opts.n) && opts.n >= 2) ? opts.n : 2;
        this.pPhys = (typeof opts.pPhys === 'number') ? opts.pPhys : 0.001;
        this.pMeas = (typeof opts.pMeas === 'number') ? opts.pMeas : 0.001;
        this.T_future = (Number.isInteger(opts.T_future) && opts.T_future >= 0) ? opts.T_future : 64;
        this.movementGated = (opts.movementGated !== undefined) ? !!opts.movementGated : false;
        this.growthWindow = Number.isInteger(opts.growthWindow) ? opts.growthWindow : 1;
        this.erasureMoves = (Number.isInteger(opts.erasureMoves) && opts.erasureMoves >= 0) ? opts.erasureMoves : 0;
        this.seed = (opts.seed === undefined || opts.seed === null) ? null : opts.seed;
        this.rng = (this.seed !== null) ? mulberry32(this.seed) : Math.random;

        this.t = 0;
        this.stepCount = 0;
        this._testMode = false;

        // Physical-error environment (only meaningful outside test mode).
        this._bx0 = zeros2D(this.L);
        this._by0 = zeros2D(this.L);
        this._bxHist = null;
        this._byHist = null;
        this._measHist = null;
        this._sTildePrev = null;
        this._phiHistory = null;

        this._ensureEnvironment(0);
        this._applyInitialPhi(this._phiHistory[0]);
        this._ensureEnvironment(this.T_future);
    }

    // t_k = t0 * n^k, for a timed slice k < K-1 (main.tex:3225-3227).
    t_k(k) {
        return this.t0 * Math.pow(this.n, k);
    }

    // -----------------------------------------------------------------
    // Environment (seeded mulberry32 pre-generation of the phi(.,t) history)
    // -----------------------------------------------------------------

    _randomBoolGrid(p) {
        const { L } = this;
        const grid = new Array(L);
        for (let x = 0; x < L; x++) {
            const row = new Array(L);
            for (let y = 0; y < L; y++) row[y] = this.rng() < p;
            grid[x] = row;
        }
        return grid;
    }

    // Ensures the phi(.,t) history (and the bx/by/meas histories behind it)
    // covers at least t = 0..uptoT, extending it by continuing this.rng and
    // continuing from the last generated bx/by, exactly mirroring
    // anim/streaming_toric.py's run(): s~_t = syndrome(bx_t,by_t) xor
    // meas_t, phi(.,t) = s~_t xor s~_{t-1}, s~_{-1}=0.
    _ensureEnvironment(uptoT) {
        const { L } = this;
        if (!this._phiHistory) {
            this._bxHist = [cloneGrid(this._bx0)];
            this._byHist = [cloneGrid(this._by0)];
            const meas0 = this._randomBoolGrid(this.pMeas);
            const sTilde0 = xorGrids(syndromeGrid(this._bxHist[0], this._byHist[0], L), meas0);
            this._sTildePrev = sTilde0;
            this._phiHistory = [sTilde0]; // phi(.,0) = s~_0 xor s~_{-1}(=0)
        }
        while (this._phiHistory.length <= uptoT) {
            const bxPrev = this._bxHist[this._bxHist.length - 1];
            const byPrev = this._byHist[this._byHist.length - 1];
            const bxT = xorGrids(bxPrev, this._randomBoolGrid(this.pPhys));
            const byT = xorGrids(byPrev, this._randomBoolGrid(this.pPhys));
            this._bxHist.push(bxT);
            this._byHist.push(byT);
            const measT = this._randomBoolGrid(this.pMeas);
            const sTildeT = xorGrids(syndromeGrid(bxT, byT, L), measT);
            const phiT = xorGrids(sTildeT, this._sTildePrev);
            this._sTildePrev = sTildeT;
            this._phiHistory.push(phiT);
        }
    }

    // Test-only: replace the auto-generated environment with an explicit
    // phi(.,t) history (e.g. dumped bit-for-bit from
    // anim/streaming_toric.py's run()/_defect_update pipeline via
    // website/tests/dump_streaming_toric.py), so a Node harness can drive
    // this decoder through exactly the same trajectory as the Python
    // reference and compare internal state at every step. Disables further
    // automatic environment generation: step() past the end of
    // `phiHistory` throws rather than silently falling back to noise.
    setPhiHistory(phiHistory) {
        this._phiHistory = phiHistory.map((grid) => grid.map((row) => row.map((v) => !!v)));
        this._bxHist = null;
        this._byHist = null;
        this._testMode = true;
        this._applyInitialPhi(this._phiHistory[0]);
    }

    // If `rng` is explicitly passed, it becomes this decoder's rng for
    // every subsequent random draw (including the per-round noise drawn
    // later by _ensureEnvironment, not just this call's initial bx0/by0) --
    // otherwise this.rng is left as whatever the constructor already set it
    // to (mulberry32(opts.seed) if a seed was given there, else
    // Math.random), so a construction-time seed keeps working end to end
    // even when this method is later called with no rng argument.
    initializeRandomErrors(p, rng) {
        if (typeof rng === 'function') this.rng = rng;
        const { L } = this;
        const bx0 = zeros2D(L);
        const by0 = zeros2D(L);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                bx0[x][y] = this.rng() < p;
                by0[x][y] = this.rng() < p;
            }
        }
        this._bx0 = bx0;
        this._by0 = by0;
        this._bxHist = null;
        this._byHist = null;
        this._phiHistory = null;
        this._testMode = false;
        this._ensureEnvironment(0);
        this._applyInitialPhi(this._phiHistory[0]);
        this._ensureEnvironment(this.T_future);
    }

    // Integration fix (main.js calls this unconditionally when the
    // "Manual Placement" radio is selected, regardless of decoder): this
    // class had no toggleErrorAtPosition() at all, so a canvas click while
    // this decoder was loaded threw. A no-op is correct here in the same
    // spirit as repetition_streaming.js's: this decoder models ongoing
    // phenomenological noise, not a one-shot manually-placed error pattern.
    toggleErrorAtPosition() {}

    // -----------------------------------------------------------------
    // Decoder state: initialization, defect sector, message sector
    // -----------------------------------------------------------------

    // main.tex:3163-3168: the defect sector at t=0 is Algorithm
    // alg:layered-toric-defect-update applied once from the all-zero
    // previous state against phi(.,0), which (no pre-existing defects)
    // reduces to s_0(r,0)=phi(r,0), s_k(r,0)=0 for k>0, no correction
    // flips, and c(r,0)=0. Messages/timers have no analogous t=-1
    // condition and are simply initialized to zero at t=0 (matching
    // torca.reference.initial_state's own all-zero message/timer start).
    _applyInitialPhi(phi0) {
        const { K, L } = this;
        this.eX = zeros3D(K, L);
        this.eY = zeros3D(K, L);
        this.s = zeros3D(K, L);
        this.tau = zerosInt3D(K, L);
        this.m00 = zeros3D(K, L);
        this.m01 = zeros3D(K, L);
        this.m10 = zeros3D(K, L);
        this.theta00 = zerosInt3D(K, L);
        this.theta01 = zerosInt3D(K, L);
        this.theta10 = zerosInt3D(K, L);
        this.c = zerosInt3D(K, L);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) this.s[0][x][y] = !!phi0[x][y];
        }
        this.t = 0;
        this.stepCount = 0;
    }

    // Algorithm alg:layered-toric-defect-update (main.tex:3211-3274).
    _defectUpdate(phiNext) {
        const { K, L } = this;
        const eXNext = cloneGrid3D(this.eX);
        const eYNext = cloneGrid3D(this.eY);

        // A_k(r,t+1): candidate timers keyed by flat (k,x,y) index. The
        // timer value is irrelevant (kept 0) for candidates landing on the
        // untimed back wall.
        const candidates = new Map();
        const addCandidate = (k, x, y, timer) => {
            const key = (k * L + x) * L + y;
            let arr = candidates.get(key);
            if (!arr) { arr = []; candidates.set(key, arr); }
            arr.push(timer);
        };

        for (let k = 0; k < K; k++) {
            const timed = k < K - 1;
            const sK = this.s[k];
            const m00 = this.m00[k], m01 = this.m01[k], m10 = this.m10[k];
            const cK = this.c[k];
            const tauK = this.tau[k];

            for (let x = 0; x < L; x++) {
                const xLeft = mod(x - 1, L);
                for (let y = 0; y < L; y++) {
                    if (!sK[x][y]) continue;
                    const yDown = mod(y - 1, L);

                    let tauPlus = 0;
                    if (timed) {
                        tauPlus = tauK[x][y] + 1;
                        if (tauPlus === this.t_k(k)) {
                            addCandidate(k + 1, x, y, 0); // (up, 0): vertical promotion
                            continue;
                        }
                    }

                    const cVal = cK[x][y];
                    const moveOk = (!this.movementGated) || (cVal === 0);
                    const lamX = moveOk && (m00[xLeft][y] || m01[xLeft][y]);
                    const lamY = (!lamX) && moveOk && (m00[x][yDown] || m10[x][yDown]);

                    if (lamX) {
                        eXNext[k][x][y] = !eXNext[k][x][y];
                        addCandidate(k, xLeft, y, tauPlus); // (left, tau+)
                    } else if (lamY) {
                        eYNext[k][x][y] = !eYNext[k][x][y];
                        addCandidate(k, x, yDown, tauPlus); // (down, tau+)
                    } else {
                        addCandidate(k, x, y, tauPlus); // (stay, tau+)
                    }
                }
            }
        }

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (phiNext[x][y]) addCandidate(0, x, y, 0); // (env, 0)
            }
        }

        const sNext = zeros3D(K, L);
        const tauNext = zerosInt3D(K, L);
        for (const [key, timers] of candidates) {
            const y = key % L;
            const x = Math.floor(key / L) % L;
            const k = Math.floor(key / (L * L));
            if (timers.length % 2 === 1) {
                sNext[k][x][y] = true;
                if (k < K - 1) {
                    let m = timers[0];
                    for (let i = 1; i < timers.length; i++) if (timers[i] < m) m = timers[i];
                    tauNext[k][x][y] = m;
                }
            }
        }

        return { eXNext, eYNext, sNext, tauNext };
    }

    // Algorithm alg:layered-toric-message-update (main.tex:3411-3496), or
    // (with the options below) the "erasure sub-step" variant shared with
    // _erasureSubstep(). Runs strictly after the defect-sector update and
    // consults only the resolved sNext/tauNext plus the *old*
    // s/tau/m/theta/c -- never a raw arrival multiset (main.tex:3298-3300).
    // See this module's header comment for the consequence at a
    // two-arrival annihilation site.
    //
    // opts.growthEnabled=false drops the growth-candidate contribution
    // entirely. opts.freezeTimers=true contributes the *unincremented*
    // thetaT[x][y] as the persistence candidate's timer instead of
    // thetaT[x][y]+1; the defect-source candidates are already effectively
    // frozen whenever _erasureSubstep calls this with sNext===this.s and
    // tauNext===this.tau (defect sector unchanged), since the "surviving
    // defect source" term then always contributes the bare tauT[x][y],
    // which is <= the "old non-promoted defect source" term's
    // tauT[x][y]+1 whenever both fire (which is exactly whenever sT[x][y]
    // is set, since sNext===sT there), so it always wins the min() and no
    // special case is needed. opts.advanceClock=false leaves c unchanged
    // instead of incrementing it mod q.
    _messageUpdate(sNext, tauNext, opts = {}) {
        const growthEnabled = opts.growthEnabled ?? true;
        const freezeTimers = opts.freezeTimers ?? false;
        const advanceClock = opts.advanceClock ?? true;

        const { K, L, q } = this;
        const m00Next = zeros3D(K, L), m01Next = zeros3D(K, L), m10Next = zeros3D(K, L);
        const theta00Next = zerosInt3D(K, L), theta01Next = zerosInt3D(K, L), theta10Next = zerosInt3D(K, L);
        const cNext = zerosInt3D(K, L);

        const mArrs = [this.m00, this.m01, this.m10];
        const thetaArrs = [this.theta00, this.theta01, this.theta10];
        const mNextArrs = [m00Next, m01Next, m10Next];
        const thetaNextArrs = [theta00Next, theta01Next, theta10Next];

        for (let k = 0; k < K; k++) {
            const timed = k < K - 1;
            const tk = timed ? this.t_k(k) : null;
            const sT = this.s[k], sT1 = sNext[k];
            const tauT = this.tau[k], tauT1 = tauNext[k];
            const cT = this.c[k];
            const m00Old = this.m00[k];

            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    cNext[k][x][y] = advanceClock ? mod(cT[x][y] + 1, q) : cT[x][y];
                    const vote00 = toomVote(m00Old, 0, 0, x, y, L);
                    const coupling = m00Old[x][y] && vote00;

                    if (timed) {
                        const dCandidates = [];
                        if (sT1[x][y]) dCandidates.push(tauT1[x][y]); // surviving defect source
                        if (sT[x][y] && tauT[x][y] + 1 < tk) dCandidates.push(tauT[x][y] + 1); // old non-promoted defect source

                        for (let idx = 0; idx < 3; idx++) {
                            const [i, j] = MESSAGE_CHANNELS[idx];
                            const messageT = mArrs[idx][k];
                            const thetaT = thetaArrs[idx][k];
                            const bCandidates = dCandidates.slice();

                            if (growthEnabled) {
                                const sources = growthSources(i, j, x, y, L);
                                let minGrowthTheta = null;
                                for (const [px, py] of sources) {
                                    if (messageT[px][py] && thetaT[px][py] < tk - 1) {
                                        if (minGrowthTheta === null || thetaT[px][py] < minGrowthTheta) {
                                            minGrowthTheta = thetaT[px][py];
                                        }
                                    }
                                }
                                if (cT[x][y] < this.growthWindow && minGrowthTheta !== null) {
                                    bCandidates.push(1 + minGrowthTheta); // growth candidate
                                }
                            }

                            const ownVote = toomVote(messageT, i, j, x, y, L);
                            const persistence = messageT[x][y] && (thetaT[x][y] < tk - 1) && (ownVote || coupling);
                            if (persistence) {
                                // persistence/erosion candidate
                                bCandidates.push(freezeTimers ? thetaT[x][y] : thetaT[x][y] + 1);
                            }

                            if (bCandidates.length > 0) {
                                mNextArrs[idx][k][x][y] = true;
                                let m = bCandidates[0];
                                for (let bi = 1; bi < bCandidates.length; bi++) if (bCandidates[bi] < m) m = bCandidates[bi];
                                thetaNextArrs[idx][k][x][y] = m;
                            }
                        }
                    } else {
                        const sSource = sT1[x][y] || sT[x][y]; // defect-source condition, back wall
                        for (let idx = 0; idx < 3; idx++) {
                            const [i, j] = MESSAGE_CHANNELS[idx];
                            const messageT = mArrs[idx][k];
                            let growth = false;
                            if (growthEnabled && cT[x][y] < this.growthWindow) {
                                const sources = growthSources(i, j, x, y, L);
                                for (const [px, py] of sources) {
                                    if (messageT[px][py]) { growth = true; break; }
                                }
                            }
                            const ownVote = toomVote(messageT, i, j, x, y, L);
                            const persistence = messageT[x][y] && (ownVote || coupling);
                            mNextArrs[idx][k][x][y] = sSource || growth || persistence;
                        }
                    }
                }
            }
        }

        return { m00Next, m01Next, m10Next, theta00Next, theta01Next, theta10Next, cNext };
    }

    // One "erasure" sub-step: only the message sector's persistence/erosion
    // rule runs, in every slice, with growth disabled and message timers
    // frozen. The defect sector (eX, eY, s, tau) and the per-site clock c
    // are entirely unchanged -- no defect movement, no promotion, no
    // environmental input, no correction change. Shares _messageUpdate
    // with the real per-round update, so the erosion rule itself can never
    // drift out of sync between the two call sites. Used by step() to
    // apply this.erasureMoves extra sub-steps after every real step.
    _erasureSubstep() {
        const {
            m00Next, m01Next, m10Next, theta00Next, theta01Next, theta10Next, cNext,
        } = this._messageUpdate(this.s, this.tau, {
            growthEnabled: false, freezeTimers: true, advanceClock: false,
        });
        this.m00 = m00Next; this.m01 = m01Next; this.m10 = m10Next;
        this.theta00 = theta00Next; this.theta01 = theta01Next; this.theta10 = theta10Next;
        this.c = cNext;
        // eX, eY, s, tau are left exactly as they are.
    }

    // One full update from time t to t+1: defect sector, then message
    // sector (main.tex:3296-3300).
    _applyStep(phiNext) {
        const { eXNext, eYNext, sNext, tauNext } = this._defectUpdate(phiNext);
        const {
            m00Next, m01Next, m10Next, theta00Next, theta01Next, theta10Next, cNext,
        } = this._messageUpdate(sNext, tauNext);

        this.eX = eXNext; this.eY = eYNext; this.s = sNext; this.tau = tauNext;
        this.m00 = m00Next; this.m01 = m01Next; this.m10 = m10Next;
        this.theta00 = theta00Next; this.theta01 = theta01Next; this.theta10 = theta10Next;
        this.c = cNext;
    }

    step() {
        const nextT = this.t + 1;
        if (this._testMode) {
            if (nextT >= this._phiHistory.length) {
                throw new Error('ToricStreamingDecoder: phi history exhausted in test mode');
            }
        } else {
            this._ensureEnvironment(nextT);
        }
        this._applyStep(this._phiHistory[nextT]);
        for (let i = 0; i < this.erasureMoves; i++) this._erasureSubstep();
        this.t = nextT;
        this.stepCount++;
    }

    // -----------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------

    get clock() {
        return this.c[0][0][0];
    }

    getSyndromeCount() {
        let count = 0;
        for (let k = 0; k < this.K; k++) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) if (this.s[k][x][y]) count++;
            }
        }
        return count;
    }

    hasMessages() {
        for (let k = 0; k < this.K; k++) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) {
                    if (this.m00[k][x][y] || this.m01[k][x][y] || this.m10[k][x][y]) return true;
                }
            }
        }
        return false;
    }

    // False whenever the environment keeps injecting noise (pPhys>0 or
    // pMeas>0): under phenomenological noise, "no syndrome, no messages"
    // is never a stable fixed point, unlike the code-capacity decoders.
    isQuiescent() {
        if (this.pPhys > 0 || this.pMeas > 0) return false;
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    // E_x = XOR_k e_{x,k}, E_y = XOR_k e_{y,k}.
    _computeCorrectionTotals() {
        const { K, L } = this;
        const Ex = zeros2D(L), Ey = zeros2D(L);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                let ex = false, ey = false;
                for (let k = 0; k < K; k++) {
                    ex = ex !== this.eX[k][x][y];
                    ey = ey !== this.eY[k][x][y];
                }
                Ex[x][y] = ex; Ey[x][y] = ey;
            }
        }
        return { Ex, Ey };
    }

    _currentPhysicalBits() {
        const { L } = this;
        return {
            bx: this._bxHist ? this._bxHist[this.t] : zeros2D(L),
            by: this._byHist ? this._byHist[this.t] : zeros2D(L),
        };
    }

    // residual r_x = bx xor E_x, r_y = by xor E_y (only meaningful outside
    // test mode, where physical bx/by are tracked).
    getResidual() {
        const { L } = this;
        const { bx, by } = this._currentPhysicalBits();
        const { Ex, Ey } = this._computeCorrectionTotals();
        const residualX = xorGrids(bx, Ex);
        const residualY = xorGrids(by, Ey);
        const residualSyndrome = syndromeGrid(residualX, residualY, L);
        return { residualX, residualY, residualSyndrome };
    }

    // phi(.,t) for the round that just entered slice 0.
    getDetectorEvents() {
        return this._phiHistory ? this._phiHistory[this.t] : zeros2D(this.L);
    }

    // Residual EDGE weight (popcount(residualX) + popcount(residualY)).
    // Informational only: it is not a health metric in 2D (see this
    // module's header comment and anim/streaming_toric.py's docstring) --
    // it climbs even under a perfectly healthy decoder because every
    // correction that fails to exactly retrace a physical error's own
    // worldline still XORs a syndrome-free closed loop into the residual,
    // and nothing ever erases an old loop. Use getResidualDefectCount()
    // for the quantity that actually reflects decoder health.
    getErrorCount() {
        const { L } = this;
        const { residualX, residualY } = this.getResidual();
        let count = 0;
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (residualX[x][y]) count++;
                if (residualY[x][y]) count++;
            }
        }
        return count;
    }

    // Residual SYNDROME weight ("live defects" -- the number of defects
    // in syndrome(residualX, residualY)). Unlike getErrorCount() (the raw
    // residual edge weight), this is unaffected by syndrome-free loop
    // accumulation: a nonzero value here means an actual, currently
    // uncorrected error remains detectable. This is the quantity that
    // should sit in a stats display next to "Error Count" (residual edge
    // weight) as e.g. "Residual Defects" -- see toric_streaming.REGISTER.md.
    getResidualDefectCount() {
        const { residualSyndrome } = this.getResidual();
        let count = 0;
        for (const row of residualSyndrome) {
            for (const v of row) if (v) count++;
        }
        return count;
    }

    // Logical indicator via the residual's winding-cut parities
    // (torca.reference.winding_parities): sum(qx[0,:]) mod 2,
    // sum(qy[:,0]) mod 2. Only meaningful when residualClear is true.
    checkLogicalError() {
        const { L } = this;
        const { residualX, residualY, residualSyndrome } = this.getResidual();
        let residualClear = true;
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) if (residualSyndrome[x][y]) residualClear = false;
        }
        let windingX = false;
        for (let y = 0; y < L; y++) if (residualX[0][y]) windingX = !windingX;
        let windingY = false;
        for (let x = 0; x < L; x++) if (residualY[x][0]) windingY = !windingY;
        const hasError = residualClear && (windingX || windingY);
        return { hasError, residualClear, windingX, windingY, horizontal: windingX, vertical: windingY };
    }

    getSlice(k) {
        return {
            s: this.s[k], m00: this.m00[k], m01: this.m01[k], m10: this.m10[k],
            eX: this.eX[k], eY: this.eY[k], c: this.c[k],
            tau: (k < this.K - 1) ? this.tau[k] : null,
        };
    }

    // -----------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------

    // Chooses whichever row count (1..n) maximizes cell size for the K+1
    // panels (a single row and a 2x2 grid are simply the r=1 and r=2
    // candidates when K+1<=4; this generalizes to more panels too), given
    // the canvas width and the height between the top-centred "t = N"
    // label and the legend line, then centres the resulting block
    // horizontally (within the full canvas width) and, together with the
    // legend directly under it, vertically (within the space below the
    // "t = N" label).
    _layout(w, h) {
        const { K, L } = this;
        const n = K + 1; // K slices + the residual lattice
        const topH = 26;          // "t = N" caption strip
        const labelH = 18;        // per-panel "k=0"/"residual" label strip
        const legendH = 28;       // legend line height
        const outerMargin = 14;
        const panelGap = 14;      // horizontal gap between panels in the same row
        const rowGap = 22;        // vertical gap between rows of panels
        const blockLegendGap = 14; // gap between the panel block and the legend line

        const wAvail = w - 2 * outerMargin;
        const vAvail = h - topH - 2 * outerMargin; // below the "t = N" strip, down to the bottom margin

        let best = null;
        for (let rows = 1; rows <= n; rows++) {
            const cols = Math.ceil(n / rows);
            const cellW = (wAvail - (cols - 1) * panelGap) / (cols * L);
            const cellH = (vAvail - rows * labelH - (rows - 1) * rowGap - blockLegendGap - legendH) / (rows * L);
            if (cellW <= 0 || cellH <= 0) continue;
            const cell = Math.min(cellW, cellH);
            if (!best || cell > best.cell + 1e-9 || (Math.abs(cell - best.cell) < 1e-9 && rows < best.rows)) {
                best = { rows, cols, cell };
            }
        }
        if (!best) best = { rows: 1, cols: n, cell: 3 };

        let cell = Math.floor(best.cell);
        cell = Math.max(3, Math.min(cell, 40));
        const { rows, cols } = best;

        const gridSize = cell * L;
        const rowHeight = labelH + gridSize;
        const blockWidth = cols * gridSize + (cols - 1) * panelGap;
        const blockHeight = rows * rowHeight + (rows - 1) * rowGap;

        const blockLeft = (w - blockWidth) / 2;
        const comboHeight = blockHeight + blockLegendGap + legendH;
        const blockTop = topH + outerMargin + Math.max(0, (vAvail - comboHeight) / 2);
        const legendTop = blockTop + blockHeight + blockLegendGap;

        const panels = [];
        for (let idx = 0; idx < n; idx++) {
            const row = Math.floor(idx / cols);
            const col = idx % cols;
            const panelsInThisRow = Math.min(cols, n - row * cols);
            const rowWidth = panelsInThisRow * gridSize + (panelsInThisRow - 1) * panelGap;
            const rowLeft = blockLeft + (blockWidth - rowWidth) / 2; // centres a short last row
            const labelTop = blockTop + row * (rowHeight + rowGap);
            panels.push({
                left: rowLeft + col * (gridSize + panelGap),
                top: labelTop + labelH,
                labelTop,
                cell,
                size: gridSize,
            });
        }

        return {
            panels, cell, gridSize, rows, cols,
            topH, labelH, legendH, outerMargin, legendTop,
            blockLeft, blockWidth, blockTop, blockHeight,
        };
    }

    _drawGrid(ctx, left, top, cell, L) {
        ctx.strokeStyle = COLOR_GRID;
        ctx.lineWidth = Math.max(1, cell / 20);
        for (let i = 0; i <= L; i++) {
            ctx.beginPath();
            ctx.moveTo(left + i * cell, top);
            ctx.lineTo(left + i * cell, top + L * cell);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(left, top + i * cell);
            ctx.lineTo(left + L * cell, top + i * cell);
            ctx.stroke();
        }
    }

    _drawSlicePanel(ctx, panel, k, showMessages, showDetectorEvents) {
        const { L } = this;
        const { left, top, cell } = panel;
        const s = this.s[k], m00 = this.m00[k], m01 = this.m01[k], m10 = this.m10[k];

        if (showMessages) {
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    const n = (m00[x][y] ? 1 : 0) + (m01[x][y] ? 1 : 0) + (m10[x][y] ? 1 : 0);
                    if (n === 0) continue;
                    ctx.fillStyle = MESSAGE_TINTS[n - 1];
                    const px = left + x * cell;
                    const py = top + (L - 1 - y) * cell;
                    ctx.fillRect(px, py, cell, cell);
                }
            }
        }

        this._drawGrid(ctx, left, top, cell, L);

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (!s[x][y]) continue;
                const cx = left + (x + 0.5) * cell;
                const cy = top + (L - 1 - y + 0.5) * cell;
                drawOrb(ctx, cx, cy, cell);
            }
        }

        if (showDetectorEvents) {
            const phi = this.getDetectorEvents();
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = Math.max(1.5, cell / 12);
            const half = cell * 0.18;
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    if (!phi[x][y]) continue;
                    const cx = left + (x + 0.5) * cell;
                    const cy = top + (L - 1 - y + 0.5) * cell;
                    ctx.beginPath();
                    ctx.moveTo(cx - half, cy - half); ctx.lineTo(cx + half, cy + half);
                    ctx.moveTo(cx - half, cy + half); ctx.lineTo(cx + half, cy - half);
                    ctx.stroke();
                }
            }
        }
    }

    // Each residual qubit is drawn as a string piece joining the centres of
    // the two cells it separates -- qx(x,y) joins cells (x-1,y) and (x,y);
    // qy(x,y) joins (x,y-1) and (x,y) -- so a chain of adjacent residual
    // errors reads as one continuous string between its endpoint defects
    // (matching repetition2.js's errorStrings() convention), rather than as
    // isolated edge tick-marks. On torus wraparound (x==0 for qx, y==0 for
    // qy) the joined cells are on opposite sides of the panel, so instead of
    // one line cutting across every cell in between, draw two half-pieces
    // reaching from each endpoint cell's centre to its near panel border.
    _drawResidualPanel(ctx, panel) {
        const { L } = this;
        const { left, top, cell } = panel;
        const { residualX, residualY, residualSyndrome } = this.getResidual();

        this._drawGrid(ctx, left, top, cell, L);

        const centerOf = (x, y) => [left + (x + 0.5) * cell, top + (L - 1 - y + 0.5) * cell];

        ctx.strokeStyle = COLOR_ERROR;
        ctx.lineWidth = Math.max(2, cell / 8);
        // 'round' caps, not 'butt'/'square': pieces meet at right angles as
        // often as end-to-end here (unlike the 1D repetition-code case,
        // which is always collinear), and a round cap is the one choice
        // that closes the gap at an angled joint the same way a projecting
        // cap closes it at a collinear one -- while still not creating any
        // visible doubling, since two opaque round caps of the same radius
        // meeting at the same point (collinear or not) just retrace the
        // same pixels, exactly as two projecting caps do along a shared run.
        ctx.lineCap = 'round';

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (residualX[x][y]) {
                    const [cx, cy] = centerOf(x, y);
                    if (x === 0) {
                        ctx.beginPath();
                        ctx.moveTo(cx, cy);
                        ctx.lineTo(left, cy);
                        ctx.stroke();
                        const [px, py] = centerOf(L - 1, y);
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(left + L * cell, py);
                        ctx.stroke();
                    } else {
                        const [px, py] = centerOf(x - 1, y);
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(cx, cy);
                        ctx.stroke();
                    }
                }
                if (residualY[x][y]) {
                    const [cx, cy] = centerOf(x, y);
                    if (y === 0) {
                        ctx.beginPath();
                        ctx.moveTo(cx, cy);
                        ctx.lineTo(cx, top + L * cell);
                        ctx.stroke();
                        const [px, py] = centerOf(x, L - 1);
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(px, top);
                        ctx.stroke();
                    } else {
                        const [px, py] = centerOf(x, y - 1);
                        ctx.beginPath();
                        ctx.moveTo(px, py);
                        ctx.lineTo(cx, cy);
                        ctx.stroke();
                    }
                }
            }
        }

        ctx.lineCap = 'butt'; // restore the canvas default

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                if (!residualSyndrome[x][y]) continue;
                const [cx, cy] = centerOf(x, y);
                drawOrb(ctx, cx, cy, cell);
            }
        }
    }

    // Centred under the panel block (== centred in the full canvas width,
    // since the block itself is already horizontally centred), sitting
    // directly below it at layout.legendTop (see _layout).
    _drawLegend(ctx, w, h, layout) {
        const y = layout.legendTop + layout.legendH / 2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `${LEGEND_FONT_SIZE}px ${FONT_SERIF}`;

        const orbIconW = 18;
        const lineIconW = 22;
        const iconTextGap = 8;
        const itemGap = 26;
        const defectText = 'defect';
        const errorText = 'error link';
        const defectTextW = ctx.measureText(defectText).width;
        const errorTextW = ctx.measureText(errorText).width;
        const totalW = orbIconW + iconTextGap + defectTextW + itemGap + lineIconW + iconTextGap + errorTextW;

        let x = (w - totalW) / 2;

        drawOrb(ctx, x + orbIconW / 2, y, 24);
        ctx.fillStyle = COLOR_TEXT;
        ctx.fillText(defectText, x + orbIconW + iconTextGap, y);
        x += orbIconW + iconTextGap + defectTextW + itemGap;

        ctx.strokeStyle = COLOR_ERROR;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round'; // matches the residual panel's string pieces
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + lineIconW, y); ctx.stroke();
        ctx.lineCap = 'butt'; // restore the canvas default
        ctx.fillStyle = COLOR_TEXT;
        ctx.fillText(errorText, x + lineIconW + iconTextGap, y);
    }

    render(ctx, w, h, options = {}) {
        const { K } = this;
        const showMessages = options.showMessages ?? false;
        const showErrors = options.showErrors ?? false;

        const layout = this._layout(w, h);
        const { panels, topH, outerMargin } = layout;

        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = COLOR_TEXT;
        ctx.font = `${LABEL_FONT_SIZE}px ${FONT_SERIF}`;
        ctx.fillText(`t = ${this.t}`, w / 2, outerMargin + topH * 0.7);

        for (let k = 0; k < K; k++) {
            const panel = panels[k];
            this._drawSlicePanel(ctx, panel, k, showMessages, showErrors && k === 0);
            const label = (k === K - 1) ? `k = ${k} (back wall)` : `k = ${k}`;
            ctx.fillStyle = COLOR_TEXT;
            ctx.font = `${LABEL_FONT_SIZE}px ${FONT_SERIF}`;
            ctx.fillText(label, panel.left + panel.size / 2, panel.labelTop + layout.labelH - 4);
        }

        const residualPanel = panels[K];
        this._drawResidualPanel(ctx, residualPanel);
        ctx.fillStyle = COLOR_TEXT;
        ctx.fillText(
            `residual (defects=${this.getResidualDefectCount()})`,
            residualPanel.left + residualPanel.size / 2,
            residualPanel.labelTop + layout.labelH - 4,
        );

        this._drawLegend(ctx, w, h, layout);
        ctx.restore();
    }
}
