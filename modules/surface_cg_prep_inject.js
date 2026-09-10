// Hierarchical state preparation/injection, X-type stabilizer diagnostic sector.
// Read-only source: overleaf_ro/main.tex, lines 3678–3835, 4010–4345,
// 5546–5553. Quotes followed by this implementation:
// 3692: "\\phi(i,0)=0"; 3703: "\\psi(i,0)=\\tilde s_0(i)".
// 3748: "slice k becomes active at the output time"; 3758: "No promotions
// from slice K-1 into the absorber occur" on input time T_K-1.
// 3769: "commit to \\psi(i,T_K-1) as our initial stabilizer frame".
// 4261–4272: absorbing candidates use Act_k(t+1), with odd-parity frame flips.
// 4276–4294: "Stage 1: open-boundary splitting", "Stage 2: uniform drift",
// "Stage 3: ordinary update"; the final injection slice is temporarily timed.
// 4298–4306: rejection discards the attempt; ordinary decoding resumes at T_K.
// 5548: "the same type of boundary, rising-wall, rising-absorbing-region,
// and frame-update mechanisms" act on the coarse-grained lattices.
//
// Geometry derivation from syndromeOpen's actual edges (not screen axes):
// check (x,y) has qx[x,y], qx[x+1,y], qy[x,y] when y>0, and
// qy[x,y+1] when y+1<Ly. Their midpoint coordinates are respectively
// (x-.5,y), (x+.5,y), (x,y-.5), (x,y+.5). For top-left injection,
// q_star=qx[0,Ly-1] is at (-.5,Ly-1), and the diagonal is
// Y=Ly-1.5-X. Paper 4140–4152 puts non-q_star qubits ON the diagonal
// in Q_X (|+> qubits). Q_Z (|0> qubits) is strictly above it:
// qx[a,b] iff b>=Ly-a, and qy[a,b] iff b>=Ly-a, excluding q_star.
// Q_X contains the remaining non-q_star qubits. X-checks touching Q_Z
// or q_star give A_fr={(x,y):x+y>=Ly-1}, A_det={(x,y):x+y<Ly-1}.
// For Lx=Ly=16 these contain 136 and 120 sites. The left readout column
// is in Q_X except q_star, which is injected in |+>; its ideal Xbar=+1.
// The bottom-left fixture mirrors y: q_star=qx[0,0], diagonal Y=X+.5,
// Q_Z has qx[a,b] iff b<a and qy[a,b] iff b<=a, excluding q_star;
// A_fr={(x,y):y<=x}, A_det={(x,y):y>x}. Diagonal qubits remain in Q_X.
// The qy index mirrors
// as Ly-b (rather than Ly-1-b) because it labels an edge midpoint.
// Coarse sites use the base decoder's physical block-center embedding;
// membership is evaluated at that physical check, so a coarse absorption
// always flips a register entry in the physical frame region.
//
// Reader's choices licensed by 5546–5553: an absorbed promotion applies
// its child-to-parent correction immediately and flips psi at the parent's
// physical center; a kept promotion retains the base signal-flight delay.
// Persistent correction channels are frame bookkeeping, not absorbing-site
// automaton state. Injection uses the existing open split convention that
// does not retain the departed defect's own center message. Both protocols
// freeze psi at output T_K-1: the final update cannot change it. Injection
// rejection resets slices/frame and starts from the present physical bits,
// without rewinding RNG, configured noise, or the global step count.
//
// Verdicts are explicitly diagnostic proxies, not the paper's cluster-based
// failure definitions: residual syndrome must equal committed psi (zero
// on injection deterministic X-checks), and residual Xbar column parity
// XOR b_0 column parity must be even. Pre-round errors belong to the frame.
import {
    SurfaceCGStreamingDecoder, syndromeOpen,
    SURFACE_CG_ERASURE_PER_SLICE_CADENCE,
} from './surface_cg_streaming.js';

export const PREP_WALL_M = 2;
export const INJECTION_DRIFT_PERIOD = 4;
export const INJECTION_CORNER = 'top-left';
export const INJECTION_FRAME_OUTCOME_PROBABILITY = 0.5;

const LARGE_TIMER = 1 << 30;
const MESSAGE_OFFSETS = [[-1, -1], [-1, 1], [1, -1]];
const make2D = (nx, ny, value) => Array.from({ length: nx }, () => Array(ny).fill(value));
const copy2D = array => array.map(column => column.slice());
const copy3D = array => array.map(copy2D);
const make3D = (depth, nx, ny, value) => Array.from({ length: depth }, () => make2D(nx, ny, value));
const readBool = (array, x, y, nx, ny) => x >= 0 && x < nx && y >= 0 && y < ny && !!array[x][y];
const readInt = (array, x, y, nx, ny) => readBool(array, x, y, nx, ny) ? array[x][y] | 0 : 0;
const toomVote = (array, dx, dy, x, y, nx, ny) =>
    Number(array[x][y]) + Number(readBool(array, x + dx, y, nx, ny))
        + Number(readBool(array, x, y + dy, nx, ny)) >= 2;

export class SurfaceCGPrepDecoder extends SurfaceCGStreamingDecoder {
    constructor(L, clockPeriod, opts = {}) {
        const corner = opts.injectionCorner ?? INJECTION_CORNER;
        if (corner !== 'top-left' && corner !== 'bottom-left') {
            throw new Error(`Unsupported injection corner: ${corner}`);
        }
        super(L, clockPeriod, opts);
        if (opts.tuning) {
            this.tuning = { ...opts.tuning };
            this.reset();
        }
        this.injectionCorner = corner;
        this.qStar.y = corner === 'top-left' ? this.Ly - 1 : 0;
    }

    get protocolKind() { return 'prep'; }
    get protocolStep() { return this.t; }
    get protocolEnd() { return this.protocolSchedule[this.K]; }
    get psi() { return this.frame; }

    reset() {
        super.reset();
        this.protocolSchedule = [0];
        for (let k = 0; k < this.K; k++) {
            this.protocolSchedule.push(this.protocolSchedule[k]
                + (this.tuning?.prepWallM ?? PREP_WALL_M) * this.t0 * this.n ** k);
        }
        this.frame = make2D(this.Lx, this.Ly, false);
        this.committedFrame = null;
        this.frameCommitted = false;
        this.frameCommitStep = null;
        this.frameFlips = 0;
        // Net absorption flips relative to this attempt's first-round frame.
        // Initial random outcomes set the reference, not this display mask.
        this.frameFlipMask = make2D(this.Lx, this.Ly, false);
        this.attempts = 1;
        this.rejected = false;
        this.rejectionCount = 0;
        this.lastRejectionStep = null;
        this.initialBx = make2D(this.Lx + 1, this.Ly, false);
        this.initialBy = make2D(this.Lx, this.Ly, false);
        this.initialTildeS = make2D(this.Lx, this.Ly, false);
        this.qStar = { channel: 'qx', x: 0,
            y: (this.injectionCorner ?? INJECTION_CORNER) === 'top-left' ? this.Ly - 1 : 0 };
        this.lastProtocolStages = [];
        this.lastAbsorptions = [];
        this._rejectionThisStep = false;
        this._restartFromCurrent = false;
        this._protocolIntake = null;
    }

    coarseSitePhysical(k, x, y) {
        const scale = this.n ** k;
        return [scale * x + Math.floor(scale / 2), scale * y + Math.floor(scale / 2)];
    }

    isFrameSite(k, x, y) {
        if (this.protocolKind === 'prep') return true;
        const [px, py] = this.coarseSitePhysical(k, x, y);
        return this.injectionCorner === 'bottom-left' ? py <= px : px + py >= this.Ly - 1;
    }

    isAbsorbingSite(k, x, y, time = this.protocolStep) {
        if (time >= this.protocolEnd || k === 0) return false;
        if (!this.isFrameSite(Math.min(k, this.K - 1), x, y)) return false;
        return k >= this.K || time < this.protocolSchedule[k];
    }

    driftDestination(k, x, y) {
        return [x, this.injectionCorner === 'bottom-left'
            ? Math.max(0, y - 1) : Math.min(this.sizeOf(k)[1] - 1, y + 1)];
    }

    _isTimedSlice(k, time = this.t) {
        if (k < this.K - 1) return true;
        return time < this.protocolEnd - 1 && (this.protocolKind === 'inject'
            ? time >= 0 : time >= this.protocolSchedule[k]);
    }

    _drawPhi() {
        if (this.t !== -1) return super._drawPhi();
        if (this.protocolKind === 'inject' && !this._restartFromCurrent && !this._testPhiQueue?.length) {
            // Projection makes the first A_fr outcomes unbiased even without
            // noise. Represent that syndrome by qx strings ending at the right
            // rough boundary: only Q_Z edges can be nonzero, and qx[0] (the
            // Xbar support, including q_star) stays zero. These are preparation
            // frame representatives, not extra physical noise. Keeping them in
            // bx makes later measured differences and residual proxies agree.
            for (let y = 0; y < this.Ly; y++) {
                let parity = false;
                for (let x = 0; x < this.Lx; x++) {
                    if (this.isFrameSite(0, x, y)
                        && this._rng() < INJECTION_FRAME_OUTCOME_PROBABILITY) parity = !parity;
                    if (parity) this.bx[x + 1][y] = !this.bx[x + 1][y];
                }
            }
        }
        let phi;
        if (this._restartFromCurrent && !this._testPhiQueue?.length) {
            // A retry's current physical bits already contain its pre-round b_0.
            const pPhys = this.pPhys;
            this.pPhys = 0;
            try { phi = super._drawPhi(); } finally { this.pPhys = pPhys; }
        } else {
            phi = super._drawPhi();
        }
        this._restartFromCurrent = false;
        // A test phi[0] is interpreted as an explicitly supplied tilde_s0.
        this.initialTildeS = copy2D(phi);
        this.initialBx = copy2D(this.bx);
        this.initialBy = copy2D(this.by);
        for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
            if (this.isFrameSite(0, x, y)) {
                this.frame[x][y] = phi[x][y];
                phi[x][y] = false;
            }
        }
        return phi;
    }

    _recordIntake(onMove = null) {
        if (this.t >= this.protocolEnd) return super._recordIntake();
        this._protocolIntake = super._recordIntake();
        // Mask buffered arrivals immediately, including ticks when this
        // coarse slice does not run and erasureMoves is zero.
        for (let k = 1; k < this.K; k++) {
            const rho = this._protocolIntake.rhoNext[k], sl = this.slices[k];
            for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
                if (!this.isAbsorbingSite(k, x, y, this.t + 1)) continue;
                if (rho[x][y]) this._absorbAt(k, x, y, onMove);
                rho[x][y] = false;
            }
        }
        return this._protocolIntake;
    }

    _absorbAt(k, x, y, onMove = null, from = null) {
        const mappedK = Math.min(k, this.K - 1);
        const [px, py] = this.coarseSitePhysical(mappedK, x, y);
        if (!this.isFrameSite(mappedK, x, y)) {
            this._rejectionThisStep = true;
            return;
        }
        this.frame[px][py] = !this.frame[px][py];
        this.frameFlipMask[px][py] = !this.frameFlipMask[px][py];
        this.frameFlips++;
        this.lastAbsorptions.push({ level: k, x, y, physicalX: px, physicalY: py, step: this.t + 1 });
        const parentCoordinates = !from || k === this.K;
        if (onMove) onMove({
            from: from || { level: mappedK, rx: x, ry: y },
            to: { level: from ? k : mappedK + 1,
                rx: parentCoordinates ? Math.floor(x / this.n) : x,
                ry: parentCoordinates ? Math.floor(y / this.n) : y, boundary: 'wall' },
            absorbedAt: { level: k, rx: x, ry: y, physicalX: px, physicalY: py },
            kind: 'boundary',
        });
    }

    _promotionCandidate(k, x, y, addPending, onMove = null) {
        if (k === this.K - 1) {
            this._absorbAt(this.K, x, y, onMove, { level: k, rx: x, ry: y });
            return;
        }
        const px = Math.floor(x / this.n), py = Math.floor(y / this.n);
        const ax = x % this.n, ay = y % this.n;
        if (this.isAbsorbingSite(k + 1, px, py, this.t + 1)) {
            const child = this._protocolIntake?.eChildNext[k + 1] || this.slices[k + 1].e_child;
            child[px][py][ax][ay] = !child[px][py][ax][ay];
            this._absorbAt(k + 1, px, py, onMove, { level: k, rx: x, ry: y });
        } else {
            addPending(this.t + this.n ** (k + 1) + 1, [k + 1, px, py, ax, ay]);
        }
    }

    _clearAbsorbing(sl, k, time, onMove = null) {
        for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
            if (!this.isAbsorbingSite(k, x, y, time)) continue;
            if (sl.s[x][y]) this._absorbAt(k, x, y, onMove);
            if (sl.rho?.[x][y]) this._absorbAt(k, x, y, onMove);
            sl.s[x][y] = false;
            sl.tau[x][y] = 0;
            sl.c[x][y] = 0;
            if (sl.rho) sl.rho[x][y] = false;
            for (let channel = 0; channel < 3; channel++) {
                sl.m[channel][x][y] = false;
                sl.th[channel][x][y] = 0;
            }
        }
    }

    _applySplitting(onMove = null) {
        if (this.t >= this.protocolEnd) return super._applySplitting(onMove);
        const counts = Array(this.K).fill(0);
        for (let k = 0; k < this.K; k++) {
            if (this.t % this.n ** k !== 0) continue;
            const sl = this.slices[k];
            counts[k] = super._splittingStep(sl, sl.Lx, sl.Ly, this._isTimedSlice(k), onMove, k);
            this._clearAbsorbing(sl, k, this.t + 1, onMove);
        }
        return counts;
    }

    _applyDrift(onMove = null) {
        for (let k = 0; k < this.K; k++) {
            if (this.t % this.n ** k !== 0) continue;
            const sl = this.slices[k], timed = this._isTimedSlice(k);
            const s = make2D(sl.Lx, sl.Ly, false);
            const tau = make2D(sl.Lx, sl.Ly, 0);
            const minTau = make2D(sl.Lx, sl.Ly, LARGE_TIMER);
            const m = make3D(3, sl.Lx, sl.Ly, false);
            const th = make3D(3, sl.Lx, sl.Ly, 0);
            for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
                const [tx, ty] = this.driftDestination(k, x, y);
                const absorbing = this.isAbsorbingSite(k, tx, ty, this.t + 1);
                if (sl.s[x][y]) {
                    if (ty !== y) {
                        const edgeY = Math.max(y, ty);
                        sl.e_y[x][edgeY] = !sl.e_y[x][edgeY];
                    }
                    if (onMove && ty !== y) onMove({
                        from: { level: k, rx: x, ry: y },
                        to: { level: k, rx: tx, ry: ty }, kind: 'drift',
                    });
                    if (absorbing) this._absorbAt(k, tx, ty, onMove);
                    else {
                        s[tx][ty] = !s[tx][ty];
                        minTau[tx][ty] = Math.min(minTau[tx][ty], sl.tau[x][y]);
                    }
                }
                if (absorbing) continue;
                for (let channel = 0; channel < 3; channel++) {
                    if (!sl.m[channel][x][y]) continue;
                    const nextTimer = timed ? sl.th[channel][x][y] : 0;
                    th[channel][tx][ty] = m[channel][tx][ty]
                        ? Math.min(th[channel][tx][ty], nextTimer) : nextTimer;
                    m[channel][tx][ty] = true;
                }
            }
            if (timed) for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
                if (s[x][y]) tau[x][y] = minTau[x][y];
            }
            Object.assign(sl, { s, tau, m, th });
        }
    }

    _disableFinalTimers() {
        const final = this.slices[this.K - 1];
        final.tau = make2D(final.Lx, final.Ly, 0);
        final.th = make3D(3, final.Lx, final.Ly, 0);
    }

    step(onMove = null) {
        if (this.t >= this.protocolEnd) {
            this.lastProtocolStages = ['ordinary'];
            this.lastAbsorptions = [];
            return super.step(onMove);
        }
        this.lastProtocolStages = [];
        this.lastAbsorptions = [];
        this._rejectionThisStep = false;
        for (let k = 0; k < this.K; k++) this._clearAbsorbing(this.slices[k], k, this.t, onMove);
        if (this.t >= this.protocolEnd - 1) this._disableFinalTimers();
        const didSplit = this.t >= (this.protocolKind === 'inject' ? 0 : 1) && this.t % this.qs === 0;
        let condensations = Array(this.K).fill(0);
        if (didSplit) {
            this.lastProtocolStages.push('splitting');
            condensations = this._applySplitting(onMove);
        }
        if (this.protocolKind === 'inject' && this.t >= 0
            && this.t % (this.tuning?.injectionDriftPeriod ?? INJECTION_DRIFT_PERIOD) === 0) {
            this.lastProtocolStages.push('drift');
            this._applyDrift(onMove);
        }
        this.lastProtocolStages.push('ordinary');
        this._ordinaryUpdate(onMove, didSplit, condensations);
        if (this._rejectionThisStep) {
            this._restartAttempt();
        } else if (!this.frameCommitted && this.t >= this.protocolEnd - 1) {
            this.committedFrame = copy2D(this.frame);
            this.frameCommitted = true;
            this.frameCommitStep = this.protocolEnd - 1;
        }
    }

    _ordinaryUpdate(onMove, didSplit, condensations) {
        const phiNext = this._drawPhi();
        this._lastPhi = phiNext;
        const tNext = this.t + 1;
        const promotedIn = Array(this.K).fill(0);
        const due = this.pending.get(tNext);
        if (due) for (const [kTarget] of due) promotedIn[kTarget]++;
        const { eChildNext, rhoNext } = this._recordIntake(onMove);
        const { exNext, eyNext, sNext, tauNext, newPending } = this._defectUpdate(phiNext, rhoNext, onMove);
        const { mNext, thetaNext, cNext } = this._messageUpdate(sNext, tauNext);
        const pendingNext = new Map();
        for (const [time, records] of this.pending) if (time !== tNext) pendingNext.set(time, records);
        for (const [time, records] of newPending) {
            if (!pendingNext.has(time)) pendingNext.set(time, []);
            pendingNext.get(time).push(...records);
        }
        const newSlices = this.slices.map((sl, k) => ({
            Lx: sl.Lx, Ly: sl.Ly, e_x: exNext[k], e_y: eyNext[k], e_child: eChildNext[k],
            s: sNext[k], tau: tauNext[k], m: mNext[k], th: thetaNext[k], c: cNext[k], rho: rhoNext[k],
        }));
        for (let move = 0; move < this.erasureMoves; move++) for (let k = 0; k < this.K; k++) {
            if (SURFACE_CG_ERASURE_PER_SLICE_CADENCE && this.t % this.n ** k !== 0) continue;
            const sl = newSlices[k];
            const { mNext: erasedM, thNext: erasedTh } = this._erasureSubstep(sl, sl.Lx, sl.Ly);
            sl.m = erasedM;
            sl.th = erasedTh;
            this._clearAbsorbing(sl, k, tNext, onMove);
        }
        this.slices = newSlices;
        this.pending = pendingNext;
        this.t = tNext;
        this.stepCount++;
        this.lastDidSplit = didSplit;
        this.lastCondensations = condensations;
        this.lastPromotions = promotedIn;
        this._protocolIntake = null;
    }

    _restartAttempt() {
        const bx = copy2D(this.bx), by = copy2D(this.by);
        const stepCount = this.stepCount, enabled = this._noiseEnabled;
        const attempts = this.attempts + 1, rejections = this.rejectionCount + 1;
        this.reset();
        this.bx = bx;
        this.by = by;
        this.stepCount = stepCount;
        this._noiseEnabled = enabled;
        this.attempts = attempts;
        this.rejectionCount = rejections;
        this.rejected = true;
        this.lastRejectionStep = stepCount;
        this._restartFromCurrent = true;
    }

    // Quiescence drains automaton traffic; the verdict then distinguishes
    // frame-consistent success from a drained residual failure. Raw random
    // first-round outcomes must never prevent a frame-consistent drain.
    isQuiescent() {
        return this.frameCommitted && this.t >= this.protocolEnd && !this._noiseEnabled && super.isQuiescent();
    }

    getRawResidualDefectCount() {
        return super.getResidualDefectCount();
    }

    // Unmodified b XOR E for diagnostics; rendering separately subtracts b_0.
    getRawSystemResidual() {
        const { Ex, Ey } = this.expandCorrection();
        const residualX = this.bx.map((col, x) => col.map((bit, y) => bit !== Ex[x][y]));
        const residualY = this.by.map((col, x) => col.map((bit, y) => bit !== Ey[x][y]));
        return { residualX, residualY,
            syndrome: syndromeOpen(residualX, residualY, this.Lx, this.Ly) };
    }

    getSystemResidual() {
        const { residualX, residualY } = this.getRawSystemResidual();
        const psi = this.frameCommitted ? this.committedFrame : this.frame;
        // Use the same right-rough-boundary qx representative as the initial
        // injection outcomes. Its syndrome is exactly psi, while qx[0] and
        // every qy remain unchanged. Factoring out the live (then committed)
        // frame removes random preparation outcomes without changing b, E,
        // the noise stream, or the protocol's raw diagnostic representation.
        for (let y = 0; y < this.Ly; y++) {
            let parity = false;
            for (let x = 0; x < this.Lx; x++) {
                parity = parity !== psi[x][y];
                residualX[x + 1][y] = residualX[x + 1][y] !== parity;
            }
        }
        if (this.isQuiescent()) {
            const verdict = this.getProtocolVerdict();
            if (verdict.frameConsistent && verdict.logicalEven) {
                // A successful drain can retain harmless error/correction
                // cycles. Choose the empty representative of that finished
                // state; the raw accessor still exposes every original edge.
                // Keep all residual strings during the run and on failure.
                for (const column of residualX) column.fill(false);
                for (const column of residualY) column.fill(false);
            }
        }
        return { residualX, residualY,
            syndrome: syndromeOpen(residualX, residualY, this.Lx, this.Ly) };
    }

    _countFrameDefects(syndrome) {
        const psi = this.frameCommitted ? this.committedFrame : this.frame;
        let count = 0;
        for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
            if (syndrome[x][y] !== psi[x][y]) count++;
        }
        return count;
    }

    // The inherited getSystemDefectCount() also dispatches here, so the
    // state card counts departures from the live/committed stabilizer frame.
    getResidualDefectCount() {
        const { syndrome } = this.getSystemResidual();
        return syndrome.reduce((count, column) => count + column.filter(Boolean).length, 0);
    }

    getProtocolState() {
        const step = this.protocolStep;
        let activeSlice = 0;
        for (let k = 1; k < this.K; k++) if (step >= this.protocolSchedule[k]) activeSlice = k;
        const wallPosition = step >= this.protocolEnd ? 'removed' : `above slice ${activeSlice}`;
        return { kind: this.protocolKind, step, end: this.protocolEnd, wallPosition,
            frameCommitted: this.frameCommitted, frameCommitStep: this.frameCommitStep,
            frameFlips: this.frameFlips, flips: this.frameFlips, committed: this.frameCommitted,
            commitStep: this.frameCommitStep, attempts: this.attempts, rejected: this.rejected,
            rejectionCount: this.rejectionCount };
    }

    getProtocolVerdict() {
        const drained = this.isQuiescent();
        if (!drained) return { drained: false, frameConsistent: null, logicalEven: null };
        const { Ex, Ey } = this.expandCorrection();
        const residualX = this.bx.map((col, x) => col.map((bit, y) => bit !== Ex[x][y]));
        const residualY = this.by.map((col, x) => col.map((bit, y) => bit !== Ey[x][y]));
        const syndrome = syndromeOpen(residualX, residualY, this.Lx, this.Ly);
        const frameConsistent = this._countFrameDefects(syndrome) === 0;
        let logicalOdd = false;
        for (let y = 0; y < this.Ly; y++) {
            logicalOdd = logicalOdd !== (residualX[this.x0][y] !== this.initialBx[this.x0][y]);
        }
        return { drained, frameConsistent, logicalEven: !logicalOdd };
    }

    checkLogicalError() {
        const verdict = this.getProtocolVerdict();
        if (!verdict.drained) return { hasError: false, logical: false, residualClear: false,
            pending: true, description: 'X-check frame and X̄ proxies are pending drain' };
        const result = { hasError: !verdict.frameConsistent || !verdict.logicalEven,
            logical: !verdict.logicalEven, residualClear: verdict.frameConsistent };
        if (!verdict.frameConsistent) result.description = 'residual syndrome differs from the committed frame';
        else if (!verdict.logicalEven) result.description = 'odd pre-round-adjusted X̄ column parity';
        return result;
    }
    _defectUpdate(phiNext, rhoNext, onMove = null) {
        if (this.t >= this.protocolEnd) return super._defectUpdate(phiNext, rhoNext, onMove);
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
            const timed = this._isTimedSlice(k);
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
                            this._promotionCandidate(k, x, y, addPending, onMove);
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

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
                if (!this.isAbsorbingSite(k, x, y, t + 1)) continue;
                if (sNext[k][x][y]) this._absorbAt(k, x, y, onMove);
                sNext[k][x][y] = false;
                tauNext[k][x][y] = 0;
            }
        }
        return { exNext, eyNext, sNext, tauNext, newPending };
    }


    _messageUpdate(sNext, tauNext) {
        if (this.t >= this.protocolEnd) return super._messageUpdate(sNext, tauNext);
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
            const timed = this._isTimedSlice(k);
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

        for (let k = 0; k < K; k++) {
            const sl = this.slices[k];
            for (let x = 0; x < sl.Lx; x++) for (let y = 0; y < sl.Ly; y++) {
                if (!this.isAbsorbingSite(k, x, y, t + 1)) continue;
                cNext[k][x][y] = 0;
                for (let channel = 0; channel < 3; channel++) {
                    mNext[k][channel][x][y] = false;
                    thetaNext[k][channel][x][y] = 0;
                }
            }
        }
        return { mNext, thetaNext, cNext };
    }

}

export class SurfaceCGInjectDecoder extends SurfaceCGPrepDecoder {
    get protocolKind() { return 'inject'; }
}
