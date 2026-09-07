// Timed, layered Haah decoding. The slice construction is main.tex
// 6919–6923; the division moves and eight-channel message rule are the
// existing haah.js implementation, including its exclusive TryPair chain.
import { HaahStreamingStageDecoder } from './haah_streaming_stage.js';
import { haahLogicalData, checkHaahLogicalParity } from './haah_logicals.js';
import {
    HAAH_STREAMING_DEFAULT_SLICES, HAAH_STREAMING_DEFAULT_P,
    HAAH_STREAMING_FIXED_CLOCK_PERIOD, HAAH_STREAMING_DEFAULT_ERASURE_MOVES,
    HAAH_STREAMING_DEFAULT_TIMER_BASE, HAAH_STREAMING_DEFAULT_TIMER_GROWTH,
    HAAH_STREAMING_DEFAULT_P_MEAS,
} from './haah_streaming_defaults.js';
export * from './haah_streaming_defaults.js';
export { COLOR_DEFECT, COLOR_ERROR_QUBIT, COLOR_DEFECT_RIM, COLOR_ERROR_RIM } from './haah_stage.js';

export const HAAH_STREAMING_FINAL_SLICE_TIMED = false;

// Rendering state and immutable geometry tables are intentionally excluded.
// The history helper separately captures an RNG's getState()/setState().
export const HAAH_STREAMING_RULE_STATE_FIELDS = [
    'L', 'q', 'clockPeriod', 'clock', 'K', 't0', 'n', 'pPhys', 'pMeas',
    'erasureMoves', 'seed', 'finalSliceTimed', 'slices', 'physicalA', 'physicalB',
    'residualA', 'residualB', 'residualSyndrome', '_prevTildeS',
    '_noiseEnabled', '_lastMeasurementHasError', '_testPhiQueue',
    'stepCount', 't', 'lastPhi', 'lastPromotions',
];

function mulberry32(seed) {
    let state = seed >>> 0;
    const rng = () => {
        state |= 0; state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    rng.getState = () => state;
    rng.setState = value => { state = value | 0; };
    return rng;
}

function makeSlice(volume, timed) {
    return {
        timed, s: new Uint8Array(volume), tau: new Float64Array(volume),
        m: new Uint8Array(8 * volume), theta: new Float64Array(8 * volume),
        cA: new Uint8Array(volume), cB: new Uint8Array(volume), c: 0,
    };
}

// Keep presence parity and timer reduction separate: the minimum includes
// all incoming candidates, including a pair that cancels before a third.
export function addHaahDefectCandidate(parity, minimum, site, timer) {
    parity[site] ^= 1;
    minimum[site] = Math.min(minimum[site], timer);
}

function makeNeighbors(L) {
    const shifts = {
        xp: [1, 0, 0], xm: [-1, 0, 0], yp: [0, 1, 0], ym: [0, -1, 0],
        zp: [0, 0, 1], zm: [0, 0, -1], xmm: [-2, 0, 0],
        ymm: [0, -2, 0], zmm: [0, 0, -2],
        xmym: [-1, -1, 0], xmzm: [-1, 0, -1], ymzm: [0, -1, -1],
        xmymzm: [-1, -1, -1], xpyp: [1, 1, 0],
        xpzp: [1, 0, 1], ypzp: [0, 1, 1],
    };
    const result = {};
    for (const [key, [dx, dy, dz]] of Object.entries(shifts)) {
        const sites = new Uint32Array(L ** 3);
        for (let x = 0; x < L; x++) for (let y = 0; y < L; y++) for (let z = 0; z < L; z++) {
            sites[x * L * L + y * L + z] = ((x + dx + L) % L) * L * L
                + ((y + dy + L) % L) * L + (z + dz + L) % L;
        }
        result[key] = sites;
    }
    return result;
}

// Exact Haah cube syndrome, with two qubits at every lattice vertex.
export function haahSyndrome(A, B, L, output = new Uint8Array(L ** 3)) {
    for (let x = 0; x < L; x++) for (let y = 0; y < L; y++) for (let z = 0; z < L; z++) {
        const xp = (x + 1) % L, yp = (y + 1) % L, zp = (z + 1) % L;
        const i = x * L * L + y * L + z;
        output[i] = A[i] ^ A[xp * L * L + yp * L + z]
            ^ A[xp * L * L + y * L + zp] ^ A[x * L * L + yp * L + zp]
            ^ B[i] ^ B[x * L * L + yp * L + z]
            ^ B[xp * L * L + y * L + z] ^ B[x * L * L + y * L + zp];
    }
    return output;
}

export class HaahStreamingDecoder extends HaahStreamingStageDecoder {
    constructor(L, clockPeriod = HAAH_STREAMING_FIXED_CLOCK_PERIOD, opts = {}) {
        super(L, clockPeriod, opts, haahLogicalData);
        this.q = clockPeriod;
        this.K = opts.K ?? HAAH_STREAMING_DEFAULT_SLICES;
        this.t0 = opts.t0 ?? HAAH_STREAMING_DEFAULT_TIMER_BASE;
        this.n = opts.n ?? HAAH_STREAMING_DEFAULT_TIMER_GROWTH;
        this.pPhys = opts.pPhys ?? HAAH_STREAMING_DEFAULT_P;
        this.pMeas = opts.pMeas ?? HAAH_STREAMING_DEFAULT_P_MEAS;
        this.erasureMoves = opts.erasureMoves ?? HAAH_STREAMING_DEFAULT_ERASURE_MOVES;
        this.finalSliceTimed = opts.finalSliceTimed ?? HAAH_STREAMING_FINAL_SLICE_TIMED;
        this.seed = opts.seed ?? 1;
        this._rng = opts.rng || (opts.seed == null ? Math.random : mulberry32(this.seed));
        this._neighbors = makeNeighbors(L);
        this._testPhiQueue = null;
        this.reset();
    }

    get clockPeriod() { return this.q; }
    set clockPeriod(value) {
        const period = Math.round(value);
        if (Number.isFinite(period) && period >= 1) this.q = period;
    }

    reset() {
        const volume = this.L ** 3;
        this.slices = Array.from({ length: this.K }, (_, k) =>
            makeSlice(volume, k < this.K - 1 || this.finalSliceTimed));
        this.physicalA = new Uint8Array(volume);
        this.physicalB = new Uint8Array(volume);
        this._prevTildeS = new Uint8Array(volume);
        this._noiseEnabled = true;
        this._lastMeasurementHasError = false;
        this.t = 0;
        this.stepCount = 0;
        this.clock = 0;
        this.lastPhi = new Uint8Array(volume);
        this.lastPromotions = new Array(this.K).fill(0);
        this._recomputeResidual();
        if (this.is3DMode) this._update3D();
    }

    initializeRandomErrors(p, rng) {
        // SurfaceStreamingDecoder's convention: step zero is empty, and
        // the first real step draws the first physical/measurement round.
        this.pPhys = p;
        this._rng = rng || Math.random;
        this.reset();
    }

    initializeClear() { this.initializeRandomErrors(0, this._rng); }
    toggleErrorAtPosition() {}
    setNoiseEnabled(enabled) { this._noiseEnabled = !!enabled; }
    isNoiseEnabled() { return this._noiseEnabled; }
    setTestPhiHistory(history) { this._testPhiQueue = history.map(phi => Uint8Array.from(phi)); }

    _replaceStreamingState(fresh) {
        for (const field of HAAH_STREAMING_RULE_STATE_FIELDS) this[field] = fresh[field];
        this._neighbors = fresh._neighbors;
        this._rng = fresh._rng;
    }

    _computePhiFromPhysical(A, B, measurement) {
        const tilde = haahSyndrome(A, B, this.L);
        const phi = new Uint8Array(tilde.length);
        for (let site = 0; site < tilde.length; site++) {
            tilde[site] ^= measurement[site];
            phi[site] = tilde[site] ^ this._prevTildeS[site];
        }
        this._prevTildeS = tilde;
        return phi;
    }

    _drawPhi() {
        if (this._testPhiQueue?.length) return this._testPhiQueue.shift();
        const pPhys = this._noiseEnabled ? this.pPhys : 0;
        const pMeas = this._noiseEnabled ? this.pMeas : 0;
        const volume = this.L ** 3;
        const measurement = new Uint8Array(volume);
        this._lastMeasurementHasError = false;
        if (pPhys > 0 || pMeas > 0) {
            // A then B at each site matches HaahCodeDecoder's seeded draw
            // order. Measurement draws follow the physical round.
            for (let site = 0; site < volume; site++) {
                if (this._rng() < pPhys) this.physicalA[site] ^= 1;
                if (this._rng() < pPhys) this.physicalB[site] ^= 1;
            }
            for (let site = 0; site < volume; site++) {
                if (this._rng() < pMeas) {
                    measurement[site] = 1;
                    this._lastMeasurementHasError = true;
                }
            }
        }
        // With noise off, this is a perfect measurement of the retained
        // physical errors, supplying any trailing measurement-error event.
        return this._computePhiFromPhysical(this.physicalA, this.physicalB, measurement);
    }

    _defectSectorUpdate(phi) {
        const volume = this.L ** 3, K = this.K, nb = this._neighbors;
        const sNext = [], tauNext = [], cANext = [], cBNext = [], sourceTimers = [];
        const promotions = new Array(K).fill(0);
        for (let k = 0; k < K; k++) {
            sNext.push(new Uint8Array(volume));
            tauNext.push(new Float64Array(volume).fill(Infinity));
            cANext.push(this.slices[k].cA.slice());
            cBNext.push(this.slices[k].cB.slice());
            sourceTimers.push(new Float64Array(volume).fill(Infinity));
        }
        for (let k = 0; k < K; k++) {
            const sl = this.slices[k], timed = sl.timed;
            const limit = this.t0 * this.n ** k;
            const active = new Uint8Array(volume), timers = new Float64Array(volume);
            for (let i = 0; i < volume; i++) {
                if (!sl.s[i]) continue;
                const timer = timed ? Math.min(sl.tau[i] + 1, limit) : 0;
                if (timed && k < K - 1 && timer >= limit) {
                    addHaahDefectCandidate(sNext[k + 1], tauNext[k + 1], i, 0);
                    sourceTimers[k + 1][i] = 0;
                    promotions[k + 1]++;
                } else {
                    active[i] = 1;
                    timers[i] = timer;
                    if (!timed || timer < limit) sourceTimers[k][i] = Math.min(sourceTimers[k][i], timer);
                }
            }

            const hasX = new Uint8Array(volume), hasY = new Uint8Array(volume), hasZ = new Uint8Array(volume);
            const checkX = new Uint8Array(volume), checkY = new Uint8Array(volume), checkZ = new Uint8Array(volume);
            const moves = new Uint8Array(volume), unhandled = new Uint8Array(volume);
            const m = sl.m;
            for (let i = 0; i < volume; i++) {
                const o = 8 * i;
                hasX[i] = m[o + 4] | m[o + 5] | m[o + 6] | m[o + 7];
                hasY[i] = m[o + 2] | m[o + 3] | m[o + 6] | m[o + 7];
                hasZ[i] = m[o + 1] | m[o + 3] | m[o + 5] | m[o + 7];
            }
            for (let i = 0; i < volume; i++) {
                checkX[i] = hasX[nb.xm[i]] | hasX[nb.xmym[i]] | hasX[nb.xmzm[i]] | hasX[nb.xmymzm[i]];
                checkY[i] = hasY[nb.ym[i]] | hasY[nb.xmym[i]] | hasY[nb.ymzm[i]] | hasY[nb.xmymzm[i]];
                checkZ[i] = hasZ[nb.zm[i]] | hasZ[nb.xmzm[i]] | hasZ[nb.ymzm[i]] | hasZ[nb.xmymzm[i]];
                if (!active[i]) continue;
                if (checkX[i] && checkY[i] && checkZ[i]) moves[i] = 1;
                else if (hasY[nb.ym[i]] && hasY[nb.ymm[i]] && hasZ[nb.zm[i]] && hasZ[nb.zmm[i]]) moves[i] = 2;
                else if (hasX[nb.xm[i]] && hasX[nb.xmm[i]] && hasZ[nb.zm[i]] && hasZ[nb.zmm[i]]) moves[i] = 3;
                else if (hasX[nb.xm[i]] && hasX[nb.xmm[i]] && hasY[nb.ym[i]] && hasY[nb.ymm[i]]) moves[i] = 4;
                else unhandled[i] = 1;
            }

            const candidate = (i, timer) => addHaahDefectCandidate(sNext[k], tauNext[k], i, timer);
            const messageSource = (i, timer) => {
                if (!timed || timer < limit) sourceTimers[k][i] = Math.min(sourceTimers[k][i], timer);
            };
            const flipA = (i, timer) => {
                cANext[k][i] ^= 1;
                candidate(i, timer); candidate(nb.xmym[i], timer);
                candidate(nb.xmzm[i], timer); candidate(nb.ymzm[i], timer);
            };
            const flipB = (i, timer) => {
                cBNext[k][i] ^= 1;
                candidate(i, timer); candidate(nb.xm[i], timer);
                candidate(nb.ym[i], timer); candidate(nb.zm[i], timer);
            };
            for (let i = 0; i < volume; i++) {
                if (!active[i]) continue;
                const timer = timers[i], move = moves[i];
                // The stationary root XOR the four syndrome toggles of
                // each flip implements root consumption and its children.
                candidate(i, timer);
                if (!move) continue;
                flipA(i, timer);
                if (move === 1) {
                    messageSource(nb.ymzm[i], timer); messageSource(nb.xmym[i], timer); messageSource(nb.xmzm[i], timer);
                } else if (move === 2) {
                    flipB(nb.ym[i], timer); flipB(nb.zm[i], timer);
                    messageSource(nb.ym[i], timer); messageSource(nb.ymm[i], timer);
                    messageSource(nb.zm[i], timer); messageSource(nb.zmm[i], timer);
                } else if (move === 3) {
                    flipB(nb.xm[i], timer); flipB(nb.zm[i], timer);
                    messageSource(nb.xm[i], timer); messageSource(nb.xmm[i], timer);
                    messageSource(nb.zm[i], timer); messageSource(nb.zmm[i], timer);
                } else {
                    flipB(nb.xm[i], timer); flipB(nb.ym[i], timer);
                    messageSource(nb.xm[i], timer); messageSource(nb.xmm[i], timer);
                    messageSource(nb.ym[i], timer); messageSource(nb.ymm[i], timer);
                }
            }

            // PairInCheck is a joint move based at a satisfied cube. Its
            // one A+B flip uses the youngest participating pair's timer.
            // All participating old defects remain stationary candidates;
            // the flip's six syndrome toggles consume their endpoints by
            // parity, exactly reproducing haah.js's simultaneous update.
            for (let i = 0; i < volume; i++) {
                if (active[i]) continue;
                let timer = Infinity;
                if (unhandled[nb.ym[i]] && unhandled[nb.zm[i]] && checkX[i]) timer = Math.min(timer, timers[nb.ym[i]], timers[nb.zm[i]]);
                if (unhandled[nb.xm[i]] && unhandled[nb.zm[i]] && checkY[i]) timer = Math.min(timer, timers[nb.xm[i]], timers[nb.zm[i]]);
                if (unhandled[nb.xm[i]] && unhandled[nb.ym[i]] && checkZ[i]) timer = Math.min(timer, timers[nb.xm[i]], timers[nb.ym[i]]);
                if (timer === Infinity) continue;
                flipA(i, timer); flipB(i, timer);
                messageSource(nb.xm[i], timer); messageSource(nb.ym[i], timer); messageSource(nb.zm[i], timer);
                messageSource(nb.xmym[i], timer); messageSource(nb.xmzm[i], timer);
                messageSource(nb.ymzm[i], timer); messageSource(nb.xmymzm[i], timer);
            }
        }
        for (let i = 0; i < volume; i++) if (phi[i]) {
            addHaahDefectCandidate(sNext[0], tauNext[0], i, 0);
            sourceTimers[0][i] = 0;
        }
        for (let k = 0; k < K; k++) for (let i = 0; i < volume; i++) {
            if (!sNext[k][i] || !this.slices[k].timed) tauNext[k][i] = 0;
        }
        return { sNext, tauNext, cANext, cBNext, promotions, sourceTimers };
    }

    _messageSectorUpdate(sNext, tauNext, sourceTimers) {
        const volume = this.L ** 3, nb = this._neighbors;
        const mNext = [], thetaNext = [], cNext = [];
        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k], m = sl.m, th = sl.theta, timed = sl.timed;
            const limit = this.t0 * this.n ** k;
            const next = new Uint8Array(8 * volume), timers = new Float64Array(8 * volume);
            const spread = this.stepCount % this.q === 0;
            for (let i = 0; i < volume; i++) {
                const offset = 8 * i;
                const xm = nb.xm[i] * 8, ym = nb.ym[i] * 8, zm = nb.zm[i] * 8;
                const xp = nb.xp[i] * 8, yp = nb.yp[i] * 8, zp = nb.zp[i] * 8;
                const failsafe = m[offset + 7] && m[offset + 7] + m[xm + 7] + m[ym + 7] + m[zm + 7] >= 2;
                // Haah sources the old syndrome and its exact S_in set.
                // S_in is NOT generally the flip syndrome support: a
                // TryPair move has one extra syndrome child, whereas
                // PairInCheck's S_in has an extra message-only corner.
                // Preserve both sets separately for capacity equivalence.
                const source = sourceTimers ? sourceTimers[k][i]
                    : (sNext[k][i] ? tauNext[k][i] : Infinity);
                for (let channel = 0; channel < 8; channel++) {
                    const j = offset + channel;
                    const x = (channel & 4 ? xm : xp) + channel;
                    const y = (channel & 2 ? ym : yp) + channel;
                    const z = (channel & 1 ? zm : zp) + channel;
                    let minimum = source;
                    if (m[j]) {
                        if ((!timed || th[j] + 1 < limit)
                            && (m[j] + m[x] + m[y] + m[z] >= 2 || failsafe)) {
                            minimum = Math.min(minimum, timed ? th[j] + 1 : 0);
                        }
                    } else if (spread && !(sl.s[i] && (!timed || k === this.K - 1 || sl.tau[i] + 1 < limit))) {
                        if (m[x] && (!timed || th[x] + 1 < limit)) minimum = Math.min(minimum, timed ? th[x] + 1 : 0);
                        if (m[y] && (!timed || th[y] + 1 < limit)) minimum = Math.min(minimum, timed ? th[y] + 1 : 0);
                        if (m[z] && (!timed || th[z] + 1 < limit)) minimum = Math.min(minimum, timed ? th[z] + 1 : 0);
                    }
                    if (minimum < Infinity) {
                        next[j] = 1;
                        timers[j] = timed ? minimum : 0;
                    }
                }
            }
            mNext.push(next); thetaNext.push(timers); cNext.push((this.stepCount + 1) % this.q);
        }
        return { mNext, thetaNext, cNext };
    }

    _erasureSubstep() {
        const volume = this.L ** 3, nb = this._neighbors;
        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k], m = sl.m, th = sl.theta;
            const limit = this.t0 * this.n ** k;
            const next = new Uint8Array(8 * volume), timers = new Float64Array(8 * volume);
            for (let i = 0; i < volume; i++) {
                const offset = 8 * i;
                const xm = nb.xm[i] * 8, ym = nb.ym[i] * 8, zm = nb.zm[i] * 8;
                const xp = nb.xp[i] * 8, yp = nb.yp[i] * 8, zp = nb.zp[i] * 8;
                const failsafe = m[offset + 7] && m[offset + 7] + m[xm + 7] + m[ym + 7] + m[zm + 7] >= 2;
                for (let channel = 0; channel < 8; channel++) {
                    const j = offset + channel;
                    const x = (channel & 4 ? xm : xp) + channel;
                    const y = (channel & 2 ? ym : yp) + channel;
                    const z = (channel & 1 ? zm : zp) + channel;
                    const persists = m[j] && (!sl.timed || th[j] < limit - 1)
                        && (m[j] + m[x] + m[y] + m[z] >= 2 || failsafe);
                    const defectSource = sl.s[i] && (!sl.timed || sl.tau[i] < limit);
                    if (defectSource || persists) {
                        next[j] = 1;
                        timers[j] = th[j];
                    }
                }
            }
            sl.m = next; sl.theta = timers;
        }
    }

    step() {
        const phi = this._drawPhi();
        const defects = this._defectSectorUpdate(phi);
        const messages = this._messageSectorUpdate(defects.sNext, defects.tauNext, defects.sourceTimers);
        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k];
            sl.s = defects.sNext[k]; sl.tau = defects.tauNext[k];
            sl.cA = defects.cANext[k]; sl.cB = defects.cBNext[k];
            sl.m = messages.mNext[k]; sl.theta = messages.thetaNext[k]; sl.c = messages.cNext[k];
        }
        for (let move = 0; move < this.erasureMoves; move++) this._erasureSubstep();
        this.lastPhi = phi;
        this.lastPromotions = defects.promotions;
        this.t++;
        this.stepCount++;
        this.clock = this.stepCount % this.q;
        this._recomputeResidual();
        if (this.is3DMode) this._update3D();
    }

    _recomputeResidual() {
        const volume = this.L ** 3;
        this.residualA = this.physicalA.slice();
        this.residualB = this.physicalB.slice();
        for (const sl of this.slices) for (let i = 0; i < volume; i++) {
            this.residualA[i] ^= sl.cA[i]; this.residualB[i] ^= sl.cB[i];
        }
        this.residualSyndrome = haahSyndrome(this.residualA, this.residualB, this.L);
    }

    getSyndromeCount() {
        let count = 0;
        for (const sl of this.slices) for (const value of sl.s) count += value;
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let i = 0; i < this.residualA.length; i++) count += this.residualA[i] + this.residualB[i];
        return count;
    }

    getResidualDefectCount() {
        let count = 0;
        for (const value of this.residualSyndrome) count += value;
        return count;
    }

    getSystemDefectCount() { return this.getResidualDefectCount(); }
    getMemoryCount() {
        let count = 0;
        for (const sl of this.slices) for (let i = 0; i < sl.s.length; i++) {
            for (let channel = 0; channel < 8; channel++) if (sl.m[8 * i + channel]) { count++; break; }
        }
        return count;
    }

    hasMessages() {
        for (const sl of this.slices) if (sl.m.some(Boolean)) return true;
        return false;
    }

    isQuiescent() {
        if (this._noiseEnabled && (this.pPhys > 0 || this.pMeas > 0)) return false;
        if (this._lastMeasurementHasError) return false;
        // Match the code-capacity Haah verdict: residual messages can keep
        // eroding after defects clear, or survive on the untimed torus.
        return this.getSyndromeCount() === 0 && this.getResidualDefectCount() === 0;
    }

    checkLogicalError() {
        const residualSyndromeClear = this.getResidualDefectCount() === 0;
        if (!residualSyndromeClear) return { residualSyndromeClear, logicalError: false, hasError: false };
        const result = checkHaahLogicalParity(this.L, this.residualA, this.residualB, this._logicalsCache, this._logicalData);
        return { ...result, residualSyndromeClear, logicalError: result.hasError };
    }
}
