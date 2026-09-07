// Rep code streaming -- the paper's translation-invariant streaming decoder
// for the repetition code under phenomenological noise.
//
// Literal port of anim/streaming_rep.py (same candidate-based defect-sector
// and message-sector update loops; see that file's docstring for the exact
// main.tex line citations for Algorithm alg:layered-defect-update and
// Algorithm alg:layered-message-update). K stacked slices k=0..K-1; a
// timed slice k<K-1 carries a defect timer tau_k(x) and a message timer
// theta_k(x) with promotion threshold t_k = t0 * n^k; slice K-1 (the "back
// wall") is untimed. Detector events phi(x,t) enter slice 0; a defect that
// survives t_k steps in slice k is promoted to slice k+1.
//
// This module owns its own phenomenological-noise environment (physical
// bit-flips at rate pPhys, measurement errors at rate pMeas), pre-generated
// with a seeded mulberry32 PRNG in chunks of T_future rounds so the render
// can show a "future" window of not-yet-consumed noise ahead of the
// decoder. The decoder itself never reads the physical bits directly --
// only the detector events phi they produce -- exactly as in the paper's
// noise model.
//
// TASK 4cz: restyled to match repetition2.js's own visual conventions, the
// same way TASK 4cx/4cy did for toric2.js/surface2.js -- only _layout()'s
// geometry and render()'s drawing code change; every dynamics method below
// (_advance/_erasureSubstep/_applyErasureMoves/the environment generator/
// checkLogicalError/etc., check_streaming_rep.mjs's own oracle comparison)
// is untouched. This module's own colour/orb constants and drawSiteRow/
// drawDefects/findRuns/drawRunString helpers were already, in substance,
// independent re-implementations of repetition2.js's identical values and
// drawCaGridLines/drawCaDefects/errorStrings/drawErrorString -- replaced
// here with the real imports instead of parallel copies. No uncoordinated
// update variant exists on this decoder. Manual future-noise
// gestures are checked separately in check_streaming_rep_manual.mjs.
import {
    FONT_SERIF, AXIS_LABEL_CLEARANCE, AXIS_ARROW_INK_GAP,
    T_LABEL_EXTRA_CLEARANCE, X_LABEL_EXTRA_CLEARANCE, TLABEL_FONT_SIZE, TLABEL_GLYPH_W,
    COLOR_GRID, COLOR_ERROR, COLOR_MSG_FILL, COLOR_MSG_EDGE, COLOR_ORB_RIM,
    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE, drawOrb, drawCaGridLines, drawCaDefects,
    errorStrings, drawErrorString,
    fillBoldGlyph, anchorForLeftEdge, anchorForRightEdge, inkRightEdge, snapPixel,
    DESCRIPTION_TOP_CSS, siteRowBottomFor, boxTopFor, drawGutterCaptions,
} from './repetition2.js';

export { COLOR_MSG_FILL, COLOR_MSG_EDGE, COLOR_ORB_RIM, COLOR_ERROR };

// Minimum displayed future window, also used before the first render.
export const MIN_FUTURE_ROWS = 12;

// Midpoint hit radius in cell units, matching toric2's paint gestures.
export const MANUAL_EDGE_PAINT_TOLERANCE = 0.3;
// Keep a perfect round beyond the visible window to close temporal edges.
export const MANUAL_FUTURE_MARGIN_ROUNDS = 1;

const LEGEND_FONT_SIZE = 13;

// TASK 4dx: a small manual visual nudge applied AFTER _layout()'s own
// F/gap solve (TASK 4dw), not part of it -- lifts the K-slice stack up by
// this many px, moving that same height from the separator (future panel
// -> slices) straight into the gap (slices -> residual row), so the two
// edges TASK 4dt/4dw pin (futureBlockTop at the top, residualBottom at
// the bottom) are completely untouched; only where the stack sits between
// them shifts. See _layout()'s own comment at the point this is applied
// for the floor-clamping that keeps the separator from ever going
// negative-slack in some future edge case.
const SLICE_STACK_LIFT = 3;

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

function mod(x, size) {
    return ((x % size) + size) % size;
}

function shortestDelta(from, to, size) {
    const delta = mod(to - from, size);
    return delta > size / 2 ? delta - size : delta;
}

// TASK 4cz: drawOrb/RESIDUAL_ORB_RADIUS/RESIDUAL_ORB_OUTLINE/snapPixel/
// drawSiteRow/drawDefects/findRuns/drawRunString used to be local
// re-implementations of repetition2.js's own drawOrb/DEFECT_ORB_RADIUS/
// DEFECT_ORB_OUTLINE/snapPixel/drawCaGridLines/drawCaDefects/errorStrings/
// drawErrorString (already, in substance, byte-identical logic/values) --
// removed in favour of the real imports above. drawCaGridLines/
// drawCaDefects take a `messageAt(row, col)`/`defectAt(row, col)` callback
// (row 0 = topmost of `rows`); every call site below adapts a plain
// `fn(col)` callback to that shape with `rows: 1` for a single row.
// errorStrings(residual, L) + drawErrorString(...) directly replace
// findRuns + drawRunString -- the same "maximal run of true entries"
// computation, just already factored to return [leftDefect, rightDefect]
// pairs instead of {a, b} run bounds needing a -1 adjustment at draw time.

export class RepetitionStreamingDecoder {
    constructor(L, clockPeriod, opts = {}) {
        this.L = L;
        this.clockPeriod = (Number.isFinite(clockPeriod) && clockPeriod >= 1)
            ? Math.round(clockPeriod) : 2; // q
        this.K = Math.max(1, Math.round(opts.K ?? 3));
        this.t0 = Math.max(1, Math.round(opts.t0 ?? 3));
        this.n = Math.max(2, Math.round(opts.n ?? 2));
        this.pPhys = opts.pPhys ?? 0.003;
        this._pMeasOverridden = opts.pMeas !== undefined;
        this.pMeas = opts.pMeas ?? this.pPhys;
        this._noiseEnabled = true;
        this._noiseStopCutIndex = null;
        this.manualMode = false;
        this.lastRoundWithEvents = -1;
        this._resetPointerGesture();
        this._visibleFutureRows = MIN_FUTURE_ROWS;
        this.seed = opts.seed ?? 1;
        this.TFuture = Math.max(1, Math.round(opts.T_future ?? 200));
        // TASK 4am: extra message-sector-only "erasure" sub-steps run after
        // every real step -- see _applyErasureMoves()'s own comment.
        this.erasureMoves = Math.max(0, Math.round(opts.erasureMoves ?? 0));

        this.stepCount = 0;
        // Use the caller's stream for the initial window as well as every
        // later round; only an explicitly requested seed is deterministic.
        this._rng = opts.rng || (opts.seed == null ? Math.random : mulberry32(this.seed));
        this._bPrev = new Array(this.L).fill(0);
        this._sTildePrev = new Array(this.L).fill(0);
        this._bCurrent = new Array(this.L).fill(0);
        this._manualInitialB = new Array(this.L).fill(0);
        this._env = []; // _env[i] = {phi, physFlip, measErr, b} for absolute round i
        this._explicitPhi = null; // test-only override: array of L-length phi rounds
        this._explicitNoise = null; // supplied/manual {physFlip, measErr} arrays of L-length rounds

        this._allocState();
        this._extendEnvironmentChunk();
    }

    // For the stats panel; the streaming decoder's clock is uniform across
    // every site and slice (c(x,t) = t mod q everywhere, since every clock
    // starts at 0 and increments unconditionally every step), so a single
    // representative value suffices.
    get clock() {
        return this.stepCount % this.clockPeriod;
    }

    _allocState() {
        const K = this.K, L = this.L;
        this.e = Array.from({ length: K }, () => new Array(L).fill(false));
        this.s = Array.from({ length: K }, () => new Array(L).fill(false));
        this.tau = Array.from({ length: K }, () => new Array(L).fill(0));
        this.m = Array.from({ length: K }, () => new Array(L).fill(false));
        this.theta = Array.from({ length: K }, () => new Array(L).fill(0));
        this.c = Array.from({ length: K }, () => new Array(L).fill(0));
    }

    _tK(k) {
        return this.t0 * Math.pow(this.n, k);
    }

    // ---- Environment (phenomenological noise) --------------------------

    // `roundIndex` (this._env.length at call time, i.e. the absolute round
    // about to be generated) is only consulted in explicit-noise test mode
    // (this._explicitNoise set), to index into the supplied physFlip/
    // measErr histories; the live-RNG path ignores it.
    _genRound(isFirst, roundIndex) {
        const L = this.L;
        const explicit = this._explicitNoise;
        const pPhys = this._noiseEnabled ? this.pPhys : 0;
        const pMeas = this._noiseEnabled ? this.pMeas : 0;
        let physFlip, bNext;
        if (isFirst && !this.manualMode) {
            // b0 sits at t=0 directly -- no flip is drawn for the very
            // first round (matches anim/streaming_rep.py's run()), in
            // the RNG and oracle modes. Manual round 0 can be edited like
            // every other visible round, applying flips to its initial physical baseline.
            physFlip = new Array(L).fill(0);
            bNext = this._bPrev.slice();
        } else if (explicit) {
            physFlip = explicit.physFlip[roundIndex];
            bNext = new Array(L);
            for (let x = 0; x < L; x++) bNext[x] = this._bPrev[x] ^ physFlip[x];
        } else {
            physFlip = new Array(L);
            for (let x = 0; x < L; x++) physFlip[x] = this._rng() < pPhys ? 1 : 0;
            bNext = new Array(L);
            for (let x = 0; x < L; x++) bNext[x] = this._bPrev[x] ^ physFlip[x];
        }
        let measErr;
        if (explicit) {
            measErr = explicit.measErr[roundIndex];
        } else {
            measErr = new Array(L);
            for (let x = 0; x < L; x++) measErr[x] = this._rng() < pMeas ? 1 : 0;
        }
        const sTilde = new Array(L);
        for (let x = 0; x < L; x++) sTilde[x] = (bNext[x] ^ bNext[(x + 1) % L]) ^ measErr[x];
        const phi = new Array(L);
        for (let x = 0; x < L; x++) phi[x] = sTilde[x] ^ this._sTildePrev[x];

        this._bPrev = bNext;
        this._sTildePrev = sTilde;
        return { phi, physFlip, measErr, b: bNext };
    }

    _extendEnvironmentChunk() {
        for (let i = 0; i < this.TFuture; i++) {
            if (this.manualMode) {
                const t = this._env.length;
                this._explicitNoise.physFlip[t] ??= new Array(this.L).fill(0);
                this._explicitNoise.measErr[t] ??= new Array(this.L).fill(0);
            }
            const isFirst = this._env.length === 0;
            this._env.push(this._genRound(isFirst, this._env.length));
        }
    }

    _ensureEnvironment(uptoIndex) {
        if (this._explicitPhi) return;
        if (this.manualMode) uptoIndex += MANUAL_FUTURE_MARGIN_ROUNDS;
        while (this._env.length <= uptoIndex) {
            this._extendEnvironmentChunk();
        }
    }

    // ---- Public API ------------------------------------------------------

    setNoiseEnabled(enabled) {
        // Explicit histories exercise the supplied noise unchanged.
        if (this._explicitPhi || this._explicitNoise) return;
        enabled = !!enabled;
        if (enabled === this._noiseEnabled) return;
        const cutIndex = this.stepCount + this._visibleFutureRows;
        // Fill even a short custom buffer with the old rates before
        // changing them, so the entire visible window stays untouched.
        this._ensureEnvironment(cutIndex - 1);
        this._noiseEnabled = enabled;
        this._noiseStopCutIndex = enabled ? null : cutIndex;

        // The generator's cursors normally sit at the end of the buffered
        // future. Rewind only those cursors to the last visible round;
        // retain its measured syndrome so stopping noise closes any last
        // measurement-error string in the next round. The RNG continues
        // from its current position, including draws for discarded rounds.
        this._env.length = cutIndex;
        const previous = this._env[cutIndex - 1];
        this._bPrev = previous ? previous.b.slice() : new Array(this.L).fill(0);
        this._sTildePrev = this._bPrev.map((b, x) =>
            b ^ this._bPrev[(x + 1) % this.L] ^ (previous ? previous.measErr[x] : 0));
    }

    isNoiseEnabled() {
        return this._noiseEnabled;
    }

    initializeRandomErrors(p, rng = Math.random) {
        this.manualMode = false;
        this.lastRoundWithEvents = -1;
        this._resetPointerGesture();
        this.pPhys = p;
        if (!this._pMeasOverridden) this.pMeas = p;
        this._noiseEnabled = true;
        this._noiseStopCutIndex = null;
        this._allocState();
        this.stepCount = 0;
        this._rng = rng;
        this._bPrev = new Array(this.L).fill(0);
        this._sTildePrev = new Array(this.L).fill(0);
        this._bCurrent = new Array(this.L).fill(0);
        this._manualInitialB = new Array(this.L).fill(0);
        this._env = [];
        this._explicitPhi = null;
        this._explicitNoise = null;
        this._extendEnvironmentChunk();
    }

    // Initialize owns the mode for this run; the radio alone cannot change
    // a generated environment. Manual histories never consult the RNG.
    initializeClear() {
        this.setExplicitNoiseHistory([], []);
        this.manualMode = true;
        this._noiseEnabled = false;
        this._ensureEnvironment(this._visibleFutureRows - 1);
    }

    // Start a fresh manual timeline from the current system. The future
    // has a perfect-measurement boundary, so retaining a nonzero physical
    // baseline does not inject its syndrome again as a new detector event.
    resetForManualEditing() {
        this.manualMode = true;
        this._noiseEnabled = false;
        this._noiseStopCutIndex = null;
        this.stepCount = 0;
        for (const row of this.c) row.fill(0);
        this.lastRoundWithEvents = -1;
        this._resetPointerGesture();
        this._explicitPhi = null;
        this._explicitNoise = { physFlip: [], measErr: [] };
        this._manualInitialB = this._bCurrent.slice();
        this._bPrev = this._manualInitialB.slice();
        this._sTildePrev = this._bPrev.map((b, x) => b ^ this._bPrev[(x + 1) % this.L]);
        this._env = [];
        this._ensureEnvironment(this._visibleFutureRows - 1);
    }

    getDrainStartStep() {
        return Math.max(0, this.lastRoundWithEvents + 1);
    }

    // Test-only: bypass the environment entirely and feed an explicit,
    // pre-computed phi history (one L-length array per round). Resets the
    // decoder state to zero and stepCount to 0. This skips _genRound()
    // (and therefore this module's own syndrome/detector-event computation)
    // entirely -- it exercises only the CA update (_advance()), not the
    // environment generator; see setExplicitNoiseHistory() for the latter.
    setExplicitPhiHistory(phiHistory) {
        this.manualMode = false;
        this.lastRoundWithEvents = -1;
        this._resetPointerGesture();
        this._noiseEnabled = true;
        this._noiseStopCutIndex = null;
        this._explicitPhi = phiHistory;
        this._explicitNoise = null;
        this._allocState();
        this.stepCount = 0;
    }

    // Test-only: bypass the RNG (not the generator code) and feed
    // pre-computed raw noise histories -- physFlipHistory/measErrHistory,
    // each one L-length 0/1 array per round, round 0's physFlip ignored
    // (matches the live-RNG path: no flip is ever drawn for the first
    // round). _genRound() then computes b, sTilde = (b(x) xor b(x+1)) xor
    // measErr(x), and phi = sTilde xor sTildePrev from these exactly as it
    // would from RNG draws -- so this exercises this module's own
    // environment-generator code (the one path setExplicitPhiHistory
    // bypasses entirely), for bit-for-bit cross-validation of *that* path
    // against an independent (e.g. Python) reference's phi output from the
    // same raw histories. `b0` (optional, defaults to all-zero) seeds the
    // physical state at round 0 directly, matching anim/streaming_rep.py's
    // run(b0=...) parameter -- needed because that reference's own test
    // dumps use a random (not all-zero) b0, and phi(0) = syndrome(b0) xor
    // measErr(0) xor sTildePrev(all-zero) depends on it. Resets the decoder
    // state to zero (b0 aside) and stepCount to 0, like the other two
    // initializers.
    setExplicitNoiseHistory(physFlipHistory, measErrHistory, b0) {
        this.manualMode = false;
        this.lastRoundWithEvents = -1;
        this._resetPointerGesture();
        this._noiseEnabled = true;
        this._noiseStopCutIndex = null;
        this._explicitNoise = { physFlip: physFlipHistory, measErr: measErrHistory };
        this._explicitPhi = null;
        this._allocState();
        this.stepCount = 0;
        this._bPrev = b0 ? b0.slice() : new Array(this.L).fill(0);
        this._sTildePrev = new Array(this.L).fill(0);
        this._bCurrent = this._bPrev.slice();
        this._manualInitialB = this._bPrev.slice();
        this._env = [];
    }

    step() {
        this._ensureEnvironment(this.stepCount);
        const round = this._explicitPhi
            ? { phi: this._explicitPhi[this.stepCount] }
            : this._env[this.stepCount];
        this._advance(round.phi);
        if (!this._explicitPhi) this._bCurrent = round.b.slice();
        this.stepCount++;
    }
    // No stepUncoord(): this decoder is not registered with uncoordVariant.

    // Literal port of anim/streaming_rep.py's _defect_update + _message_update.
    _advance(phiNext) {
        const K = this.K, L = this.L;

        // ---- defect-sector update (Algorithm alg:layered-defect-update) ---
        // Only candidate parity and the smallest timer survive resolution.
        // Fold them into the fresh output rows instead of allocating a list
        // for every site; keep minima even when the running parity is even.
        const sNext = Array.from({ length: K }, () => new Array(L).fill(false));
        const tauNext = Array.from({ length: K }, () => new Array(L).fill(Infinity));
        const eNext = this.e.map(row => row.slice());
        function addCandidate(k, x, timer) {
            sNext[k][x] = !sNext[k][x];
            tauNext[k][x] = Math.min(tauNext[k][x], timer);
        }

        for (let k = 0; k < K; k++) {
            const timed = k < K - 1;
            const sK = this.s[k], mK = this.m[k], tauK = this.tau[k];
            for (let x = 0; x < L; x++) {
                if (!sK[x]) continue;
                const xLeft = (x - 1 + L) % L;
                let tauPlus = 0;
                if (timed) {
                    tauPlus = tauK[x] + 1;
                    if (tauPlus === this._tK(k)) {
                        addCandidate(k + 1, x, 0); // (up, 0): vertical promotion
                        continue;
                    }
                }
                if (mK[xLeft]) { // lambda_k(x,t), already inside s_k(x,t)=1
                    eNext[k][x] = !eNext[k][x];
                    addCandidate(k, xLeft, tauPlus); // (move, tau+)
                } else {
                    addCandidate(k, x, tauPlus); // (stay, tau+)
                }
            }
        }

        for (let x = 0; x < L; x++) {
            if (phiNext[x]) addCandidate(0, x, 0); // (env, 0)
        }

        for (let k = 0; k < K; k++) {
            for (let x = 0; x < L; x++) {
                if (!sNext[k][x] || k === K - 1) tauNext[k][x] = 0;
            }
        }

        // ---- message-sector update (Algorithm alg:layered-message-update) -
        const mNext = Array.from({ length: K }, () => new Array(L).fill(false));
        const thetaNext = Array.from({ length: K }, () => new Array(L).fill(0));
        const cNext = this.c.map(row => row.map(v => (v + 1) % this.clockPeriod));

        for (let k = 0; k < K; k++) {
            const timed = k < K - 1;
            const tk = timed ? this._tK(k) : null;
            const mT = this.m[k], thetaT = this.theta[k], cT = this.c[k];

            for (let x = 0; x < L; x++) {
                const xLeft = (x - 1 + L) % L;
                const B = this._messageBaseSources(k, x, sNext, tauNext, mT);
                if (timed) {
                    if (mT[xLeft] && cT[x] === 0 && thetaT[xLeft] < tk - 1) B.push(thetaT[xLeft] + 1); // growth from left
                } else if (mT[xLeft] && cT[x] === 0) {
                    B.push(0); // growth from left, untimed
                }
                if (B.length > 0) {
                    mNext[k][x] = true;
                    thetaNext[k][x] = Math.min(...B);
                }
            }
        }

        this.e = eNext;
        this.s = sNext;
        this.tau = tauNext;
        this.m = mNext;
        this.theta = thetaNext;
        this.c = cNext;
        this._applyErasureMoves();
    }

    // Persistence + defect-sourcing candidate timers for one message-sector
    // site (k, x): the subset of _advance()'s own per-site candidate list
    // that does NOT include growth from the left. Returns an array of
    // candidate timer values (never a plain bool; an untimed back-wall
    // candidate is a placeholder 0), shared verbatim by _advance() (which
    // additionally appends the growth candidate before taking Math.min(B)
    // to set thetaNext) and _erasureSubstep() (which uses only whether
    // this list is non-empty and otherwise leaves theta/c untouched
    // entirely -- "message timers frozen" for the extra erasure-moves
    // feature). `mRow` is the message row to read m(x)/m(x-1) from for
    // slice k (NOT always this.m[k]: an erasure-move chain passes each
    // sub-step's own output back in as the next one's mRow, while
    // this.s/tau/theta/c stay fixed for the whole chain).
    _messageBaseSources(k, x, sNext, tauNext, mRow) {
        const L = this.L;
        const xLeft = (x - 1 + L) % L;
        const sT = this.s[k], tauT = this.tau[k], thetaT = this.theta[k];
        const sT1 = sNext[k], tauT1 = tauNext[k];
        const B = [];
        if (k < this.K - 1) {
            const tk = this._tK(k);
            if (sT1[x]) B.push(tauT1[x]); // surviving defect source
            if (sT[x] && tauT[x] + 1 < tk) B.push(tauT[x] + 1); // old non-promoted defect source
            if (mRow[x] && mRow[xLeft] && thetaT[x] < tk - 1) B.push(thetaT[x] + 1); // persistence
        } else {
            if (sT1[x] || sT[x]) B.push(0); // defect source, untimed
            if (mRow[x] && mRow[xLeft]) B.push(0); // persistence, untimed
        }
        return B;
    }

    // One persistence/erosion-only sub-step of the message sector -- an
    // app-level extension (not part of the ported algorithm) backing the
    // "extra erasure moves" feature. Shares _messageBaseSources() with the
    // real message update in _advance(); growth is disabled (never
    // appended) and theta/c are left completely untouched, so only the
    // returned m differs from mCurrent. Applying this repeatedly (each
    // call's output fed back in as the next call's mCurrent, while
    // sNext/tauNext -- and this.s/tau/theta/c -- stay fixed throughout the
    // chain) lets a message island not reinforced by an active defect
    // erode away from its right edge, one site per sub-step.
    _erasureSubstep(sNext, tauNext, mCurrent) {
        const K = this.K, L = this.L;
        const mNext = Array.from({ length: K }, () => new Array(L).fill(false));
        for (let k = 0; k < K; k++) {
            const mRow = mCurrent[k];
            for (let x = 0; x < L; x++) {
                mNext[k][x] = this._messageBaseSources(k, x, sNext, tauNext, mRow).length > 0;
            }
        }
        return mNext;
    }

    // Applies this.erasureMoves extra message-sector-only sub-steps right
    // after _advance() commits a real step's new state: this.s/this.tau
    // (now this round's freshly-resolved values) serve as BOTH the "old"
    // and "new" slots of _messageBaseSources, since nothing about the
    // defect sector moves between erasure sub-steps -- there is no
    // old-vs-new distinction left. Leaves e/s/tau/theta/c/stepCount
    // completely untouched; only this.m changes. erasureMoves=0 is a
    // no-op by construction (the loop body never runs), so it is
    // bit-identical to the pre-existing behaviour.
    _applyErasureMoves() {
        if (this.erasureMoves <= 0) return;
        let m = this.m;
        for (let i = 0; i < this.erasureMoves; i++) {
            m = this._erasureSubstep(this.s, this.tau, m);
        }
        this.m = m;
    }

    getSyndromeCount() {
        let count = 0;
        for (let k = 0; k < this.K; k++) {
            for (let x = 0; x < this.L; x++) if (this.s[k][x]) count++;
        }
        return count;
    }

    getSystemDefectCount() {
        return this._systemSyndrome().filter(Boolean).length;
    }

    // Residual weight, per spec -- NOT the raw physical-error count (this
    // decoder's "error" of interest is what survives decoding, not what
    // noise injected).
    getErrorCount() {
        return this.getResidual().filter(Boolean).length;
    }

    hasMessages() {
        for (let k = 0; k < this.K; k++) {
            for (let x = 0; x < this.L; x++) if (this.m[k][x]) return true;
        }
        return false;
    }

    // Live nonzero noise keeps injecting detector events. Once it stops,
    // the visible future must be consumed before the decoder can drain.
    // The final noisy measurement must also close in one perfect round,
    // even if the current slices happen to be empty.
    isQuiescent() {
        if (this.manualMode && this.stepCount <= this.lastRoundWithEvents) return false;
        if (this._noiseEnabled && (this.pPhys > 0 || this.pMeas > 0)) return false;
        if (!this._noiseEnabled && this.stepCount < this._noiseStopCutIndex) return false;
        if (!this._noiseEnabled && this._env[this.stepCount - 1]?.measErr.some(Boolean)) return false;
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        const residual = this.getResidual();
        const weight = residual.filter(Boolean).length;
        const hasError = weight > this.L / 2;
        const result = { hasError, horizontal: hasError, vertical: false };
        if (hasError) result.description = 'residual majority flipped';
        return result;
    }

    // ---- Manual future-noise gestures ----------------------------------

    _resetPointerGesture() {
        this._pointerMode = null;
        this._paintVertex = null;
        this._paintVisited = [];
        this._paintValue = null;
        this._paintInitialEdge = null;
        this._paintMoved = false;
    }

    // The exact inverse of render(): site x in absolute round t is at
    // (rowLeft + (x + 1/2)cell, futureBottom - (t-stepCount + 1/2)cell).
    // Space is periodic; time is bounded by the visible vertex rows.
    _pointerToFuture(x, y, cssW, cssH) {
        const layout = this._layout(cssW, cssH);
        const { rowLeft, rowWidth, futureBlockTop, futureBottom, cell, futureRows } = layout;
        if (x < rowLeft || x > rowLeft + rowWidth || y < futureBlockTop || y > futureBottom) return null;
        const lx = (x - rowLeft) / cell - 0.5;
        const t = this.stepCount + (futureBottom - y) / cell - 0.5;
        const last = this.stepCount + futureRows - 1;
        return {
            lx, t, last,
            vertex: [mod(Math.round(lx), this.L), Math.max(this.stepCount, Math.min(last, Math.round(t)))],
        };
    }

    // Validate the visible hit before the host resets a finished timeline.
    canStartPointer(x, y, cssW, cssH) {
        return this._pointerToFuture(x, y, cssW, cssH) !== null;
    }

    _nearestFutureEdge({ lx, t, last }) {
        const rawX = Math.round(lx + 0.5);
        const row = Math.max(this.stepCount, Math.min(last, Math.round(t)));
        const horizontal = {
            kind: 'physFlip', x: mod(rawX, this.L), t: row,
            dist: Math.hypot(lx - (rawX - 0.5), t - row),
        };
        // Both endpoints of temporal edges must be visible. In particular,
        // neither half-cell beyond the first/last row edits a hidden round.
        const lower = Math.max(this.stepCount, Math.min(last - 1, Math.floor(t)));
        const vertical = {
            kind: 'measErr', x: mod(Math.round(lx), this.L), t: lower,
            dist: last > this.stepCount ? Math.hypot(lx - Math.round(lx), t - (lower + 0.5)) : Infinity,
        };
        return horizontal.dist <= vertical.dist ? horizontal : vertical;
    }

    _setFutureEdge(edge) {
        const row = this._explicitNoise[edge.kind][edge.t];
        if (this._paintValue === null) this._paintValue = !row[edge.x];
        const value = Number(this._paintValue);
        if (row[edge.x] === value) return false;
        row[edge.x] = value;
        return true;
    }

    // Rewind generator cursors only, leaving consumed rounds, physical
    // state and the decoder's CA slices untouched. Regenerate the suffix
    // so every downstream b and detector event follows the edited noise.
    _recomputeManualEnvironment(fromRound) {
        const end = this._env.length;
        const previous = this._env[fromRound - 1];
        this._bPrev = previous ? previous.b.slice() : this._manualInitialB.slice();
        this._sTildePrev = this._bPrev.map((b, x) =>
            b ^ this._bPrev[(x + 1) % this.L] ^ (previous?.measErr[x] ?? 0));
        this._env.length = fromRound;
        while (this._env.length < end) {
            this._env.push(this._genRound(this._env.length === 0, this._env.length));
        }
        this.lastRoundWithEvents = -1;
        for (let t = this._env.length - 1; t >= 0; t--) {
            const round = this._env[t];
            // Include closed noise paths as well as their detector boundary:
            // a spatial winding has no phi but must still reach the system.
            if (round.phi.some(Boolean) || round.physFlip.some(Boolean) || round.measErr.some(Boolean)) {
                this.lastRoundWithEvents = t;
                break;
            }
        }
    }

    pointerDown(x, y, cssW, cssH) {
        this._resetPointerGesture();
        if (!this.manualMode) return false;
        const point = this._pointerToFuture(x, y, cssW, cssH);
        if (!point) return false;
        this._ensureEnvironment(point.last);
        const edge = this._nearestFutureEdge(point);
        this._pointerMode = 'paint';
        this._paintVertex = point.vertex;
        this._paintVisited = [point.vertex];
        if (edge.dist <= MANUAL_EDGE_PAINT_TOLERANCE) {
            this._paintInitialEdge = edge;
            this._paintValue = !this._explicitNoise[edge.kind][edge.t][edge.x];
        }
        return true;
    }

    _walkFuturePaintTo(target) {
        let [x, t] = this._paintVertex;
        const dx = shortestDelta(x, target[0], this.L);
        const dt = target[1] - t;
        let firstChangedRound = Infinity;
        const stepX = () => {
            const dir = Math.sign(dx);
            while (x !== target[0]) {
                const next = mod(x + dir, this.L);
                if (this._setFutureEdge({ kind: 'physFlip', x: dir > 0 ? next : x, t })) {
                    firstChangedRound = Math.min(firstChangedRound, t);
                }
                x = next;
                this._paintVisited.push([x, t]);
            }
        };
        const stepT = () => {
            const dir = Math.sign(dt);
            while (t !== target[1]) {
                const next = t + dir;
                const lower = Math.min(t, next);
                if (this._setFutureEdge({ kind: 'measErr', x, t: lower })) {
                    firstChangedRound = Math.min(firstChangedRound, lower);
                }
                t = next;
                this._paintVisited.push([x, t]);
            }
        };
        if (Math.abs(dx) >= Math.abs(dt)) { stepX(); stepT(); } else { stepT(); stepX(); }
        if (Number.isFinite(firstChangedRound)) this._recomputeManualEnvironment(firstChangedRound);
        return Number.isFinite(firstChangedRound);
    }

    pointerMove(x, y, cssW, cssH) {
        if (!this.manualMode || this._pointerMode !== 'paint') return false;
        const point = this._pointerToFuture(x, y, cssW, cssH);
        if (!point) return false;
        const target = point.vertex;
        const [vx, vt] = this._paintVertex;
        const distance = Math.abs(shortestDelta(vx, target[0], this.L)) + Math.abs(vt - target[1]);
        if (!distance) return false;
        const visited = this._paintVisited.findIndex(([px, pt]) => px === target[0] && pt === target[1]);
        let changed = false;
        // Toric paint retrace rule: reuse an equally short recorded route
        // rather than making a new diagonal corner. A longer recorded route
        // is a loop closure and must walk its missing shortest segment.
        if (visited !== -1 && this._paintVisited.length - 1 - visited === distance) {
            this._paintVisited.length = visited + 1;
        } else {
            changed = this._walkFuturePaintTo(target);
        }
        this._paintVertex = target;
        this._paintMoved = true;
        return changed;
    }

    pointerUp() {
        let changed = false;
        if (this.manualMode && this._pointerMode === 'paint' && !this._paintMoved && this._paintInitialEdge) {
            changed = this._setFutureEdge(this._paintInitialEdge);
            if (changed) this._recomputeManualEnvironment(this._paintInitialEdge.t);
        }
        this._resetPointerGesture();
        return changed;
    }

    toggleErrorAtPosition(x, y, cssW, cssH) {
        if (!this.pointerDown(x, y, cssW, cssH)) return false;
        return this.pointerUp();
    }

    // ---- Getters for the render (and for external inspection/tests) ----

    getE() {
        const E = new Array(this.L).fill(false);
        for (let k = 0; k < this.K; k++) {
            for (let x = 0; x < this.L; x++) {
                if (this.e[k][x]) E[x] = !E[x];
            }
        }
        return E;
    }

    getB() {
        return this._bCurrent.slice();
    }

    getResidual() {
        const E = this.getE();
        return this._bCurrent.map((b, x) => (!!b) !== (!!E[x]));
    }

    // Shared by the system-row glyphs and the state card: parity checks
    // act on the physical bits after the decoder's accumulated correction.
    _systemSyndrome(residual = this.getResidual()) {
        return residual.map((value, x) => (!!value) !== (!!residual[(x + 1) % this.L]));
    }

    // The next `count` not-yet-consumed rounds of the environment
    // (undefined entries if an explicit phi history is in use, since there
    // is no underlying physical-bit environment to report in that mode).
    getFutureRounds(count) {
        this._ensureEnvironment(this.stepCount + count - 1);
        const rounds = [];
        for (let i = 0; i < count; i++) rounds.push(this._env[this.stepCount + i]);
        return rounds;
    }

    // ---- Render ------------------------------------------------------

    // Pure geometry (no ctx) -- callable directly from Node for a layout
    // trace.
    //
    // TASK 4dq: top to bottom, flipped from the original order so a given
    // detector event's own drawn position visibly moves DOWNWARD as real
    // time (stepCount) advances: the fixed-height future panel (its own
    // top row is the farthest-future round shown; its own bottom row,
    // across the separator from the K-slice block, is the NEXT round to
    // enter the decoder), the separator, the K-slice block, then the
    // residual row. F is fixed at 12 rather than grown to fill the
    // canvas. Box outlines/grid/gaps/cell-size and the horizontal
    // x-extent are all unchanged from before this task -- only which box
    // occupies which vertical position changed, reusing the exact same
    // two gap values (sepH, gapResidualToSlices) for the same two
    // transitions, just mirrored. TASK 4dt amendment: WITHIN the K-slice
    // block, k=K-1 is the top slice (adjacent to the future panel across
    // the separator) and k=0 is the bottom slice (adjacent to the
    // residual row) -- reversed from 4dq's own original direct k=0-at-top
    // ordering; the block's own outer position (between the separator and
    // the residual row) is untouched by this, only which slice index
    // renders at which row within it.
    //
    // TASK 4cz: anchored at a fixed topGap (13px, the same value
    // repetition2/toric2/surface2 all use under the decoder title) instead
    // of the previous vertical centring in leftover canvas height -- item 8
    // of the restyle checklist asks for the same top gap specifically, and
    // a fixed anchor is what the other three modules' own _layout()s do.
    // The "logical"-indicator right margin is unchanged from before this
    // task. `boxLeft`/`boxWidth`/`boxBottom` name the future panel
    // specifically (see getDescriptionAnchor/getTitleAnchor below -- the
    // largest, most prominent of this module's three boxes, playing the
    // role repetition2's single history box plays for its own module) --
    // TASK 4dq keeps this naming/meaning exactly as-is per its own
    // instruction to keep the description/title anchors on the main box,
    // even though the future panel's own screen position moved to the top.
    // TASK 4dt: the fixed 13px topGap this paragraph describes is now only
    // a floor (`minTopGap`, see below) -- the diagram is pushed further
    // down than that whenever needed to line its residual row's bottom edge
    // up with repetition2's own site-row strip.
    //
    // TASK 4cz-c: labelReserve/rowLeft reverted from TASK 4cz-b's 270px
    // (and its own preceding bare 70px) to reuse repetition2's own
    // _layout() cell-size and horizontal-centring policy verbatim -- see
    // that method's comment for the underlying budget derivation
    // (cell*L + TLABEL_GLYPH_W + AXIS_LABEL_CLEARANCE + 0.2*cell <=
    // canvasWidth - 120, box centred as a "label reserve + box" panel).
    // TASK 4cz-b's wide gutter existed only to keep the "residual"/
    // "k = N"/"t" labels clear of the HTML description card, which back
    // then was anchored beside this diagram's own boxes at a height that
    // could overlap them; TASK 4cz-b's OWN follow-up switched
    // getDescriptionAnchor() (below) to the fixed top all four modules
    // share, which -- given this module's boxes end well above that fixed
    // top at any realistic viewport width -- puts the card entirely BELOW
    // the whole diagram instead. That makes the wide horizontal gutter
    // unnecessary (nothing to dodge left-to-right any more) while it was
    // still costing real cell size (8px cells here vs repetition2's own
    // 11px at the same L=64/canvasWidth). Reusing repetition2's exact
    // formula both recovers that cell size AND reproduces repetition2's
    // own box extent exactly at matching L/canvasWidth (verified live:
    // page x 601-1305 at 1600px wide, L=64, cell=11 -- matching what
    // repetition2's own formula gives at that same L/canvasWidth by
    // construction, since it's the identical calculation). "residual"'s
    // own ink (the widest of this module's row labels, ~55px) still
    // clears the canvas's own left edge comfortably at this rowLeft --
    // the panel-centring formula leaves ~80-100px of blank margin to its
    // left at this L/canvasWidth, verified by the same pixel scan used in
    // 4cz-b (now checking for the card's fixed top-anchored rect instead,
    // which -- per the above -- is moot by construction but reverified
    // anyway per the task's own request).
    _layout(canvasWidth, canvasHeight, overlayRects) {
        if (overlayRects !== undefined) this._lastOverlayRects = overlayRects;
        const effectiveOverlayRects = overlayRects !== undefined ? overlayRects : this._lastOverlayRects;
        const L = this.L, K = this.K;
        const targetTop = boxTopFor(canvasWidth, canvasHeight, L);
        const targetBottom = siteRowBottomFor(canvasWidth, canvasHeight, L);
        // These gaps and the minimum future rows must fit even when a
        // small lattice would otherwise select the full 28px cell size.
        const minSepH = 12;
        const minGapResidualToSlices = 4;
        // Same reserve/cap/divisor repetition2's own cell-size formula
        // uses (TLABEL_GLYPH_W: conservative single-glyph width estimate;
        // AXIS_LABEL_CLEARANCE: the label-to-box gap folded into the
        // budget; 120: the same generic right-side/slop reserve, used only
        // as a fallback -- see TASK 4em note below; 28: the same cell-size
        // cap; L + 0.2: the same per-cell budget).
        //
        // TASK 4em fix: this used to size the panel against a flat
        // "canvasWidth - 120" guess for the info/legend cards' own width
        // and centre it within the FULL canvasWidth (no live-DOM
        // awareness at all, and no awareness of the description card on
        // the LEFT either, unlike repetition2.js's own 'right'-placement
        // branch which only ever has to worry about its right side).
        // Both guesses were fine as long as the cards' real edges stayed
        // clear of where they put the panel's own edges -- true before
        // TASK 4em, which capped .visualization-container's own width
        // and, as a side effect, moved BOTH the right-hand info/legend
        // cards AND the left-hand description card (position:absolute
        // against .visualization-container, see .description-stack's own
        // CSS) relative to the canvas: the cards' real left edge shrinks
        // along with .canvas-area on the right, while the description
        // card's real position shifts right in lockstep with
        // .visualization-container's own (now smaller, re-centred) left
        // edge on the left -- shrinking the panel's clearance from BOTH
        // directions at once. Fixed by sizing/centring against the real
        // span between both cards (via overlayRects, threaded through
        // from render()/getTitleAnchor() below the same way
        // repetition2.js's own _layout() takes it) when it's available,
        // falling back to the original flat guess/full-canvasWidth
        // centring when it isn't (this file's own Node test harness,
        // which never passes overlayRects, so those checks keep seeing
        // exactly today's numbers). panelWidth <= freeRight - freeLeft is
        // guaranteed by construction (cell is floor/min-capped against
        // that same span, so rowWidth + labelReserve can never exceed
        // it), so centring within [freeLeft, freeRight] always leaves at
        // least the intended 8px clear of both cards.
        const cardsLeft = effectiveOverlayRects?.infoPanel?.left;
        const descStackRight = effectiveOverlayRects?.description?.right;
        const haveOverlay = Number.isFinite(cardsLeft) && Number.isFinite(descStackRight);
        const freeLeft = haveOverlay ? (descStackRight + 8) : 0;
        const freeRight = haveOverlay ? (cardsLeft - 8) : canvasWidth;
        const cellSizingSpan = haveOverlay ? (freeRight - freeLeft) : (canvasWidth - 120);
        let cell = Math.max(1, Math.floor(Math.min(28, (cellSizingSpan - TLABEL_GLYPH_W - AXIS_LABEL_CLEARANCE) / (L + 0.2))));
        if (effectiveOverlayRects?.narrowLayout) {
            cell = Math.min(cell, (targetBottom - targetTop - minSepH - minGapResidualToSlices)
                / (MIN_FUTURE_ROWS + K + 1));
        }
        const rowWidth = cell * L;
        // Same "label reserve + box" panel, centred as one unit within
        // [freeLeft, freeRight] ([0, canvasWidth] by default, or the
        // cards-aware bounds above), that repetition2's own
        // boxLeft/panelLeft use -- this is what makes "rowLeft" land at
        // the same x as repetition2's own boxLeft at matching
        // L/canvasWidth, not just cell matching (true only in the
        // fallback case now that the live case is aware of cards
        // repetition2's own 'right'-placement variant doesn't have to
        // dodge on its left).
        const labelGutter = AXIS_LABEL_CLEARANCE + 0.2 * cell;
        const labelReserve = TLABEL_GLYPH_W + labelGutter;
        const panelWidth = rowWidth + labelReserve;
        const panelLeft = freeLeft + (freeRight - freeLeft - panelWidth) / 2;
        const rowLeft = panelLeft + labelReserve;
        // Right-aligned with the same clearance repetition2's own "t"
        // label uses (AXIS_LABEL_CLEARANCE + T_LABEL_EXTRA_CLEARANCE from
        // the box's own left edge) -- unchanged from TASK 4cz-b, just now
        // measured from the new (smaller) rowLeft.
        const labelRightX = rowLeft - AXIS_LABEL_CLEARANCE - T_LABEL_EXTRA_CLEARANCE;

        const xLabelGap = AXIS_LABEL_CLEARANCE;
        const xLabelH = Math.ceil(TLABEL_FONT_SIZE * 1.2);
        const bottomMargin = 10;

        // TASK 4dt (bottom edge) + TASK 4dw (top edge): both the future
        // panel's own top edge and the residual row's own bottom edge now
        // land exactly on repetition2's own history-box top (boxTopFor(),
        // 13px under the title) and site-row-strip bottom
        // (siteRowBottomFor()) respectively, at matching
        // canvasWidth/canvasHeight/L -- both helpers reuse that module's
        // real _layout() solve rather than a second hardcoded formula
        // that could drift out of sync with it. Without TASK 4dt, the two
        // tabs' "bottom of the last box" landed at very different
        // heights (repetition2's own history box grows to fill most of
        // the available canvas height, while this module's box heights
        // used to be fixed row counts anchored near the top); TASK 4dw
        // closes the matching gap at the TOP too, by growing the future
        // panel (F, the number of rows it shows) to fill the space
        // between the two targets, rather than leaving a blank gap above
        // it the way a fixed F=12 did.
        //
        // topGap is fixed at targetTop (not solved for, unlike TASK 4dt's
        // own topGap) -- F is the one free quantity now: the total height
        // from targetTop to targetBottom is a fixed budget; K slices, the
        // residual row, and the two minimum gaps are subtracted from it,
        // and whatever whole cells of budget remain become F (floored, so
        // the budget divides evenly into whole rows), clamped to never
        // show fewer rows than this module's own previous fixed count
        // (12) or more than the future buffer (this.TFuture) actually
        // holds. The sub-cell remainder left over after flooring F goes
        // entirely into sepH (the future-panel/slice-stack gap) -- this
        // is what makes both edges land exactly on whole-cell rows at
        // once, rather than needing fractional-pixel cell heights.
        // gapResidualToSlices stays at its own floor untouched (the whole
        // remainder fits in sepH alone in every case reachable at any
        // realistic canvas size; nothing here stops it from being split
        // across both gaps instead, per the user's own note allowing
        // that, but there was no need to touch it, see report).
        const totalAvailable = targetBottom - targetTop;
        const fixedRowsHeight = (K + 1) * cell; // K slices + the residual row
        const budgetForF = totalAvailable - fixedRowsHeight - minSepH - minGapResidualToSlices;
        const naturalF = Math.floor(budgetForF / cell);
        const F = Math.max(MIN_FUTURE_ROWS, Math.min(naturalF, this.TFuture));
        // Only negative if F had to be clamped UP to the 12-row floor
        // despite an insufficient budget (an extremely short canvas) --
        // clamped at 0 there, so sepH falls back to its own floor and the
        // residual row's bottom (not checked live at any such extreme
        // size) would land past targetBottom instead, mirroring TASK
        // 4dt's own floor precedent just with the roles reversed.
        const remainder = Math.max(0, budgetForF - F * cell);
        const sepHSolved = minSepH + remainder;
        const gapResidualToSlicesSolved = minGapResidualToSlices;
        const topGap = targetTop;

        // TASK 4dx: SLICE_STACK_LIFT applied here, strictly AFTER the F/gap
        // solve above, so the 4dw edge alignment (topGap/F already fixed)
        // is completely untouched by it -- moves height straight from the
        // separator into the residual gap, shifting only where the stack
        // sits between the two pinned edges. actualLift clamps the lift to
        // whatever slack sepHSolved actually has above its own floor
        // (minSepH), so this can never push the separator below that floor
        // even in some future scenario where the 4dw solve above left it
        // sitting exactly at the floor already (not the case at any
        // canvas size reachable on this site today -- see _layout()'s own
        // top comment on why -- but a free, harmless guard to keep either
        // way).
        const actualLift = Math.min(SLICE_STACK_LIFT, sepHSolved - minSepH);
        const sepH = sepHSolved - actualLift;
        const gapResidualToSlices = gapResidualToSlicesSolved + actualLift;

        // TASK 4dq: future panel first (top), a separator-line transition
        // into the K-slice stack, then a second gap transition out of it
        // into the residual row (bottom) -- TASK 4dw made both gaps'
        // exact heights (sepH/gapResidualToSlices, computed above) vary
        // with the solved F rather than the original fixed 12px/4px, but
        // the structure (two transitions, same two named gaps) is
        // unchanged.
        const futureBlockTop = topGap;
        const futureTop = (i) => futureBlockTop + i * cell; // i=0 (top) = farthest future; i=F-1 (bottom) = next round, adjacent to slice k=K-1 across the separator
        const futureBottom = futureBlockTop + F * cell;
        const separatorY = futureBottom + sepH / 2;
        const sliceBlockTop = futureBottom + sepH;
        const sliceTop = (i) => sliceBlockTop + i * cell; // i=0 -> k=K-1 (top, adjacent to the future panel), i=K-1 -> k=0 (bottom, adjacent to the residual row) -- TASK 4dt amendment
        const residualTop = sliceBlockTop + K * cell + gapResidualToSlices;
        const residualBottom = residualTop + cell;
        // "t" label sits beside the future panel specifically -- it's the
        // one genuinely time-stacked box here (each row = one round), the
        // direct analogue of repetition2's own history box; the residual
        // row and the K slices are distinct structural levels, not a time
        // axis, so they don't get their own "t". Now anchored on the
        // future panel's new (top) position.
        const tLabelMidY = futureBlockTop + (F * cell) / 2;
        // "x" now sits below the residual row, since that's the bottom
        // box in the flipped order (was the future panel before).
        const xLabelTop = residualBottom + xLabelGap;

        return {
            cell, rowLeft, rowWidth, labelRightX,
            residualTop, residualBottom, sliceBlockTop, sliceTop, separatorY,
            futureBlockTop, futureTop, futureRows: F, futureBottom,
            tLabelMidY, tLabelFontSize: TLABEL_FONT_SIZE, xLabelFontSize: TLABEL_FONT_SIZE,
            xLabelGap, xLabelH, xLabelTop,
            boxLeft: rowLeft, boxWidth: rowWidth, boxBottom: futureBottom,
        };
    }

    // TASK 4cq/4cw analogues: the future panel is this module's "main
    // drawn box" (see _layout()'s own comment) -- its bottom edge and
    // horizontal centre, in the same canvas-local CSS-pixel coordinate
    // system _layout() uses.
    // TASK 4cz-b: switched to the same fixed { top: DESCRIPTION_TOP_CSS }
    // toric2.js/surface2.js use (TASK 4da), so all four modules' cards
    // start at the same height -- this module's own future panel sits far
    // higher up its canvas than repetition2's history box does on its own
    // (fixed row counts near the top, not a box that grows to fill
    // available height), so anchoring to *this* box's bottom landed the
    // card much higher than repetition2's.
    getDescriptionAnchor(canvasWidth, canvasHeight) {
        return { top: DESCRIPTION_TOP_CSS };
    }

    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        const layout = this._layout(canvasWidth, canvasHeight, overlayRects);
        return { centerX: layout.boxLeft + layout.boxWidth / 2 };
    }

    // TASK 4cz: restyled to match repetition2.js's own render() -- no
    // on-canvas caption/status text (the "t = N" caption is gone, matching
    // repetition2's own precedent of dropping a caption that duplicates
    // the state card's step count; the "logical" indicator is gone too,
    // now that removing it lets the state card's own pre-existing generic
    // logical-error row -- driven by checkLogicalError(), unchanged --
    // surface the exact same "residual majority flipped" text automatically,
    // with zero main.js changes needed). Each of the three structural
    // boxes (residual row, K-slice stack, future panel) gets its own
    // repetition2-weight black outline and clipped interior, exactly like
    // repetition2's own box/site-row. TASK 4ff: the slice stack now has
    // a shared "decoder" caption in place of k and its numeral tick labels.
    // TASK 4dq: the residual row's own
    // "residual" label is removed (its own instruction); sections below
    // are now drawn future-panel-first, matching the new top-to-bottom
    // visual order.
    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showGrid = options.showGrid !== false;
        const showMessages = options.showMessages !== false;
        const showErrors = options.showErrors !== false;
        const showSyndrome = options.showSyndrome !== false;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const L = this.L, K = this.K;
        const layout = this._layout(canvasWidth, canvasHeight, options.overlayRects);
        const {
            cell, rowLeft, rowWidth,
            residualTop, residualBottom, sliceBlockTop, futureBlockTop, futureRows: F, futureBottom,
            tLabelMidY, tLabelFontSize, xLabelFontSize, xLabelTop,
        } = layout;
        // Shared error-string thickness formula (repetition2's own
        // wBlue/stringWidth rule), replacing this module's previous
        // 1.5 * wBlue -- used for every red "string" drawn below.
        const wBlue = Math.max(2, Math.round(cell / 9));
        const stringWidth = Math.max(1, 1.05 * wBlue);

        function outlineBox(top, height) {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.3;
            ctx.strokeRect(rowLeft, top, rowWidth, height);
        }
        // ---- Future panel (top): F not-yet-consumed rounds.
        // TASK 4dq: row i=0 (top of this box) is the farthest-future
        // round shown; row i=F-1 (bottom, adjacent to slice 0 below) is
        // the NEXT round to enter the decoder -- flipped from before, so
        // a given detector event's own drawn row visibly moves DOWNWARD,
        // toward the decoder, as stepCount advances (this box's own
        // sliding window shifts by one round each step; an event already
        // shown moves from a smaller round-index/array-position to a
        // larger row-index/lower position). getFutureRounds(F) itself is
        // unchanged (still round-index order, nearest round first) --
        // reversed once here into row order. This is the one genuinely
        // time-stacked box here (each row = one round), so it's the box
        // the "t" label anchors to below, and the box
        // getDescriptionAnchor/getTitleAnchor use. -----
        const roundsByIndex = this.getFutureRounds(F);
        this._visibleFutureRows = F;
        const rounds = roundsByIndex.slice().reverse(); // rounds[i] is now row i's own round data
        ctx.save();
        ctx.beginPath();
        ctx.rect(rowLeft, futureBlockTop, rowWidth, F * cell);
        ctx.clip();
        // Grid lines only -- the future panel has no "message" concept of
        // its own (it shows raw noise: physical flips, measurement
        // errors, detector events), drawn via the same shared grid
        // colour/width formula as every other box in this diagram.
        drawCaGridLines(ctx, {
            left: rowLeft, top: futureBlockTop, cell, cols: L, rows: F,
            messageAt: () => false, showGrid, showMessages: false,
        });
        for (let i = 0; i < F; i++) {
            const round = rounds[i];
            if (!round) continue;
            const rowTop = layout.futureTop(i);
            const midY = rowTop + cell / 2;

            // Physical bit-flip on qubit x: a horizontal string between the
            // two detector endpoints (centre of cell x-1 to centre of cell x).
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            for (let x = 0; x < L; x++) {
                if (!round.physFlip[x]) continue;
                if (x > 0) {
                    ctx.beginPath();
                    ctx.moveTo(rowLeft + (x - 1) * cell + cell / 2, midY);
                    ctx.lineTo(rowLeft + x * cell + cell / 2, midY);
                    ctx.stroke();
                } else {
                    // PBC wrap: qubit 0 sits between site L-1 and site 0.
                    ctx.beginPath();
                    ctx.moveTo(rowLeft + (L - 1) * cell + cell / 2, midY);
                    ctx.lineTo(rowLeft + rowWidth, midY);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(rowLeft, midY);
                    ctx.lineTo(rowLeft + cell / 2, midY);
                    ctx.stroke();
                }
            }

            // Measurement error at site x: a vertical temporal string
            // connecting this round to the chronologically-later round
            // (one absolute round index higher). TASK 4dq: that round is
            // now ONE ROW ABOVE (i-1), not below -- farther-future rounds
            // sit higher in the flipped layout, since defects now travel
            // downward toward the decoder. Row i=0 (the topmost/farthest-
            // future row shown) has no row above it to connect to
            // (T_future's own buffer extends further, just not drawn),
            // so its own half-string ends at this row's own top edge
            // instead, mirroring the old boundary case at the other end.
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            for (let x = 0; x < L; x++) {
                if (!round.measErr[x]) continue;
                const cx = rowLeft + x * cell + cell / 2;
                const yTo = (i > 0) ? (rowTop - cell / 2) : rowTop;
                ctx.beginPath();
                ctx.moveTo(cx, midY);
                ctx.lineTo(cx, yTo);
                ctx.stroke();
            }
        }
        // Detector events: same shared anyon-orb glyph as every defect
        // elsewhere in this diagram (TASK 4cz -- was cell*0.7 with the
        // default 0.42/0.06 radius/outline factors; now the standard
        // DEFECT_ORB_RADIUS/DEFECT_ORB_OUTLINE at the normal cell size,
        // drawn as one combined drawCaDefects() call across all F rows).
        if (showSyndrome) {
            drawCaDefects(ctx, {
                left: rowLeft, top: futureBlockTop, cell, cols: L, rows: F,
                defectAt: (i, c) => !!(rounds[i] && rounds[i].phi[c]),
            });
        }
        ctx.restore();
        outlineBox(futureBlockTop, F * cell);

        // "t" label to the left of the future panel, with its bold UPWARD
        // arrow -- TASK 4dt: reverted from TASK 4dq's downward arrow, which
        // read this diagram's own row order backward. Row i=0, at the top
        // of the future panel, is the farthest-future round; the bottom
        // row, adjacent to slice 0 across the separator, is the very next
        // round about to be consumed -- so going UP this box is the
        // direction of increasing t (later rounds sit higher), exactly the
        // same convention repetition2's own history box uses (newest row
        // on top), and the arrow points the same way for the same reason.
        // Otherwise identical to repetition2's own "t" label code (same
        // font, arrow style, AXIS_LABEL_CLEARANCE/AXIS_ARROW_INK_GAP/
        // T_LABEL_EXTRA_CLEARANCE, arrow centred above the glyph's ink).
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `italic ${tLabelFontSize}px ${FONT_SERIF}`;
        const tMetrics = ctx.measureText('t');
        const tAnchorX = anchorForRightEdge(rowLeft - AXIS_LABEL_CLEARANCE - T_LABEL_EXTRA_CLEARANCE, tMetrics);
        ctx.fillText('t', tAnchorX, tLabelMidY);

        const tInkLeft = tAnchorX - tMetrics.actualBoundingBoxLeft;
        const tInkRight = rowLeft - AXIS_LABEL_CLEARANCE - T_LABEL_EXTRA_CLEARANCE; // by construction
        const tInkCenterX = (tInkLeft + tInkRight) / 2;
        const tInkTopY = tLabelMidY - tMetrics.actualBoundingBoxAscent;

        ctx.font = `bold ${tLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const tArrowMetrics = ctx.measureText('↑');
        const tArrowAnchorX = tInkCenterX - (tArrowMetrics.actualBoundingBoxRight - tArrowMetrics.actualBoundingBoxLeft) / 2;
        const tArrowBaselineY = tInkTopY - AXIS_ARROW_INK_GAP - tArrowMetrics.actualBoundingBoxDescent;
        fillBoldGlyph(ctx, '↑', tArrowAnchorX, tArrowBaselineY);
        ctx.textBaseline = 'alphabetic';

        // ---- Separator: the next future round above, slice 0 below. -------
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(rowLeft, layout.separatorY);
        ctx.lineTo(rowLeft + rowWidth, layout.separatorY);
        ctx.stroke();

        // ---- K slice rows (middle): TASK 4dt amendment -- k=K-1 at the
        // top (adjacent to the future panel above, across the separator),
        // k=0 at the bottom (adjacent to the residual row below) -- an
        // i->K-1-i mapping from physical row i to slice index k (reversed
        // from TASK 4dq's own direct i->k). One combined box
        // (repetition2-style: a single black outline around all K rows,
        // like its own history box spanning many history rows), with the
        // shared "decoder" gutter caption alongside.
        ctx.save();
        ctx.beginPath();
        ctx.rect(rowLeft, sliceBlockTop, rowWidth, K * cell);
        ctx.clip();
        drawCaGridLines(ctx, {
            left: rowLeft, top: sliceBlockTop, cell, cols: L, rows: K,
            messageAt: (i, c) => !!this.m[K - 1 - i][c], showGrid, showMessages,
        });
        if (showSyndrome) {
            drawCaDefects(ctx, {
                left: rowLeft, top: sliceBlockTop, cell, cols: L, rows: K,
                defectAt: (i, c) => !!this.s[K - 1 - i][c],
            });
        }
        ctx.restore();
        outlineBox(sliceBlockTop, K * cell);

        // TASK 4ff: the captions share repetition2's font, colour, fitted
        // size and ink centre; the slice-stack caption replaces k/numerals.
        drawGutterCaptions(ctx, {
            tInkRight, boxTop: futureBlockTop,
            blockLines: ['future', 'noise'],
            decoderMidY: sliceBlockTop + (K * cell) / 2,
            systemMidY: (residualTop + residualBottom) / 2,
        });

        // ---- Residual row (bottom): r = b xor E. TASK 4dq: the "residual"
        // text label is removed (this task's own instruction); everything
        // else about this row -- grid, error strings, defect orbs,
        // outline -- is unchanged. Drawn like repetition2's own site row
        // (grey grid; no message tinting -- the residual isn't a message
        // channel), with orbs at the residual's own syndrome
        // s_res(x) = r(x) xor r(x+1), and each maximal run of residual-1
        // qubits as one string via the same errorStrings()/
        // drawErrorString() repetition2's own site row uses (qubit x sits
        // between sites x-1 and x, so a run a..b has defects at a-1 and
        // b -- errorStrings() already returns exactly that
        // [leftDefect, rightDefect] pair per run). ------------------------
        const residual = this.getResidual();
        const residualMidY = residualTop + cell / 2;
        const residualSyndrome = this._systemSyndrome(residual);

        ctx.save();
        ctx.beginPath();
        ctx.rect(rowLeft, residualTop, rowWidth, cell);
        ctx.clip();
        drawCaGridLines(ctx, {
            left: rowLeft, top: residualTop, cell, cols: L, rows: 1,
            messageAt: () => false, showGrid, showMessages: false,
        });
        if (showErrors) {
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            for (const [leftDefect, rightDefect] of errorStrings(residual, L)) {
                drawErrorString(ctx, leftDefect, rightDefect, rowLeft, rowWidth, cell, residualMidY);
            }
        }
        if (showSyndrome) {
            drawCaDefects(ctx, {
                left: rowLeft, top: residualTop, cell, cols: L, rows: 1,
                defectAt: (_i, c) => residualSyndrome[c],
            });
        }
        ctx.restore();
        outlineBox(residualTop, cell);

        // "x ->" label below the residual row (TASK 4dq: was below the
        // future panel, since the residual row is now the bottom box) --
        // identical to repetition2's own "x" label code, anchored on
        // residualBottom.
        const cx = rowLeft + rowWidth / 2;
        ctx.fillStyle = '#000000';
        ctx.font = `italic ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const xMetrics = ctx.measureText('x');
        const xBaseline = residualBottom + AXIS_LABEL_CLEARANCE + X_LABEL_EXTRA_CLEARANCE + xMetrics.actualBoundingBoxAscent;
        const xInkRight = inkRightEdge(cx, xMetrics);
        ctx.fillText('x', cx, xBaseline);

        ctx.font = `bold ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'left';
        const arrowMetrics = ctx.measureText('→');
        const arrowAnchorX = anchorForLeftEdge(xInkRight + AXIS_ARROW_INK_GAP, arrowMetrics);
        fillBoldGlyph(ctx, '→', arrowAnchorX, xBaseline);
    }
}
