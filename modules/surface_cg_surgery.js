// Rough surgery in the Z stabilizer sector: two L-by-L hierarchies stacked
// along their NON-condensing y boundaries (main.tex:6462–6470, 6745–6752).
// Coarse cells never cross that boundary. When it is open, the two adjacent
// rows are ordinary neighbours, and their crossing e_y edge expands from
// one block centre to the other, through the physical qy[x,L] seam qubit.
import { SurfaceCGStreamingDecoder, syndromeOpen } from './surface_cg_streaming.js';
import { SurfaceCGSurgeryDecoder } from './surface_cg_surgery_base.js';
export { SurfaceCGSurgeryDecoder, SURGERY_SPACING_STEPS_PER_L,
    SURGERY_CONDENSING_M, SURGERY_DEFAULT_SIZE, SURGERY_MAX_SIZE } from './surface_cg_surgery_base.js';
export { SurfaceCGSurgeryXDecoder } from './surface_cg_surgery_x.js';

const array2 = (nx, ny, value = false) => Array.from({ length: nx }, () => new Array(ny).fill(value));
const clone = value => value == null ? value : Array.isArray(value) ? value.map(clone) : value;
const takeRows = (array, start, length) => array == null ? null : array.map(col => clone(col.slice(start, start + length)));
const joinRows = (a, b) => a == null ? null : a.map((col, x) => col.concat(b[x]));

function patchSlice(sl, patch) {
    const length = sl.Ly / 2, start = patch * length;
    const result = { Lx: sl.Lx, Ly: length };
    for (const name of ['s', 'tau', 'e_x', 'e_y', 'e_child', 'c', 'rho']) result[name] = takeRows(sl[name], start, length);
    // e_y[x,0] does not exist on an independent non-condensing patch.
    for (const col of result.e_y) col[0] = false;
    for (const name of ['m', 'th']) result[name] = sl[name].map(channel => takeRows(channel, start, length));
    return result;
}

export class SurfaceCGSurgeryZDecoder extends SurfaceCGSurgeryDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        super(L, clockPeriod, { ...opts, sector: 'z' });
        this._rngBState = (this.seed ^ 0x9e3779b9) >>> 0;
        this.reset();
    }

    reset() {
        super.reset();
        if (!this.sector) return;
        this._resetSurgeryState();
        this._seamQubitsPresent = this._initiallyMerged;
        this._patchNoiseEnabled = [true, true];
        this._rngBState = (this.seed ^ 0x9e3779b9) >>> 0;
        this.seamFrame = array2(this.L, 2);
        // The committed frame is an interpretation. This separately records
        // its already incorporated part when a later surgery reuses channels.
        this._seamFrameBaseline = array2(this.L, 2);
        this._splitMeasurements = null;
        this._seamFirstRound = null;
        this._seamEverMerged = this._initiallyMerged;
    }

    _randomB() {
        this._rngBState = (this._rngBState + 0x6D2B79F5) | 0;
        let t = Math.imul(this._rngBState ^ (this._rngBState >>> 15), 1 | this._rngBState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    setPatchNoiseEnabled(patch, enabled) { this._patchNoiseEnabled[patch] = !!enabled; }

    getPatchDecoder(patch) {
        const view = Object.create(SurfaceCGStreamingDecoder.prototype);
        Object.assign(view, this);
        view.Lx = this.L;
        view.Ly = this.L;
        view.slices = this.slices.map(sl => patchSlice(sl, patch));
        view.bx = takeRows(this.bx, patch * this.L, this.L);
        view.by = takeRows(this.by, patch * this.L, this.L);
        for (const col of view.by) col[0] = false;
        view._prevTildeS = takeRows(this._prevTildeS, patch * this.L, this.L);
        view._lastPhi = takeRows(this._lastPhi, patch * this.L, this.L);
        view.pending = new Map();
        for (const [time, records] of this.pending) {
            const own = records.filter(([k, , y]) => Math.floor(y / (this.L / this.n ** k)) === patch)
                .map(([k, x, y, ax, ay]) => [k, x, y - patch * this.L / this.n ** k, ax, ay]);
            if (own.length) view.pending.set(time, own);
        }
        view._rng = patch === 0 ? this._rng : () => this._randomB();
        view._noiseEnabled = this._noiseEnabled && this._patchNoiseEnabled[patch];
        view._testPhiQueue = null;
        return view;
    }
    getPatchSnapshot(patch) {
        const d = this.getPatchDecoder(patch);
        return { t: d.t, stepCount: d.stepCount, slices: d.slices, pending: d.pending,
            bx: d.bx, by: d.by, _prevTildeS: d._prevTildeS, _lastPhi: d._lastPhi };
    }
    coarseSitePhysical(k, x, y) {
        const pitch = this.n ** k;
        return [pitch * x + Math.floor(pitch / 2), pitch * y + Math.floor(pitch / 2)];
    }
    isSeamSite(k, x, y) {
        const edge = this.L / this.n ** k;
        return y === edge - 1 || y === edge;
    }

    _startMerge() {
        // |0> seam qubits (caption 6181, lines 6470–6477). Only physical
        // bits reset: retained e_y seam channels are never reinitialised.
        this._seamQubitsPresent = true;
        for (let x = 0; x < this.L; x++) this.by[x][this.L] = false;
        this._seamEverMerged = true;
        this._seamFirstRound = 'merge';
        this._seamFrameBaseline = clone(this.seamFrame);
    }
    _startSplit() {
        // Error-bit model of Z measurement: the noiseless outcome is the
        // seam's b_q, then an independent Bernoulli(pMeas) readout fault.
        // This is a simulation choice, not a new physical decoder rule.
        this._splitMeasurements = new Array(this.L);
        const p = this._noiseEnabled ? this.pMeas : 0;
        for (let x = 0; x < this.L; x++) {
            const measured = this.by[x][this.L] !== (p > 0 && this._rng() < p);
            this._splitMeasurements[x] = measured;
            this.slices[0].e_y[x][this.L] = this.slices[0].e_y[x][this.L] !== measured;
            this.by[x][this.L] = false;
        }
        this._seamQubitsPresent = false;
        this._seamFirstRound = 'split';
        this.seamFrameCommitted = false;
    }
    _commitSplit() {
        // F(q) includes the physical expansion of EVERY slice, hence a
        // coarse crossing contributes at its block-centre seam column.
        const { Ey } = this.expandCorrection();
        for (let x = 0; x < this.L; x++) {
            for (let side = 0; side < 2; side++) this.seamFrame[x][side] = this.seamFrame[x][side] !== Ey[x][this.L];
        }
        this.seamFrameCommitted = true;
    }

    _drawPhi() {
        if (this._testPhiQueue?.length) return this._testPhiQueue.shift();
        let phi;
        if (this._seamQubitsPresent) {
            // From-start merged mode has exactly the standalone rectangle's
            // draw order and dynamics (no extra surgery RNG draws).
            phi = SurfaceCGStreamingDecoder.prototype._drawPhi.call(this);
        } else {
            const patches = [this.getPatchDecoder(0), this.getPatchDecoder(1)];
            const draws = patches.map(p => SurfaceCGStreamingDecoder.prototype._drawPhi.call(p));
            this.bx = joinRows(patches[0].bx, patches[1].bx);
            this.by = joinRows(patches[0].by, patches[1].by);
            this._prevTildeS = joinRows(patches[0]._prevTildeS, patches[1]._prevTildeS);
            this._lastMeasurementHasError = patches.some(p => p._lastMeasurementHasError);
            phi = joinRows(draws[0], draws[1]);
        }
        if (this._seamFirstRound === 'split') {
            // phi(a,T+1)=s^-_(T+1)(a) xor z~(q) xor s^+_T(a).
            for (let x = 0; x < this.L; x++) {
                phi[x][this.L - 1] = phi[x][this.L - 1] !== this._splitMeasurements[x];
                phi[x][this.L] = phi[x][this.L] !== this._splitMeasurements[x];
            }
        }
        this._seamFirstRound = null;
        return phi;
    }

    _defectUpdate(phiNext, rhoNext, onMove = null) {
        if (this.slices.every((_, k) => this.seamGeometry(k) === 'merged')) {
            return super._defectUpdate(phiNext, rhoNext, onMove);
        }
        const mergedMoves = [];
        const merged = super._defectUpdate(phiNext, rhoNext.map(clone), onMove ? move => mergedMoves.push(move) : null);
        const patchMoves = [[], []];
        const patches = [0, 1].map(patch => {
            const view = this.getPatchDecoder(patch);
            return SurfaceCGStreamingDecoder.prototype._defectUpdate.call(view,
                takeRows(phiNext, patch * this.L, this.L),
                rhoNext.map((rho, k) => takeRows(rho, patch * this.L / this.n ** k, this.L / this.n ** k)),
                onMove ? move => patchMoves[patch].push(move) : null);
        });
        for (let k = 0; k < this.K; k++) {
            if (this.seamGeometry(k) === 'merged') continue;
            for (const name of ['exNext', 'eyNext', 'sNext', 'tauNext']) {
                merged[name][k] = joinRows(patches[0][name][k], patches[1][name][k]);
            }
            // An absent crossing channel retains its accumulated value.
            const seam = this.L / this.n ** k;
            for (let x = 0; x < this.slices[k].Lx; x++) merged.eyNext[k][x][seam] = this.slices[k].e_y[x][seam];
        }
        const pending = new Map();
        const add = (time, record) => {
            if (!pending.has(time)) pending.set(time, []);
            pending.get(time).push(record);
        };
        for (const [time, records] of merged.newPending) {
            for (const record of records) if (this.seamGeometry(record[0] - 1) === 'merged') add(time, record);
        }
        for (let patch = 0; patch < 2; patch++) {
            for (const [time, records] of patches[patch].newPending) {
                for (const [k, x, y, ax, ay] of records) {
                    if (this.seamGeometry(k - 1) === 'split') add(time, [k, x, y + patch * this.L / this.n ** k, ax, ay]);
                }
            }
        }
        merged.newPending = pending;
        // _defectUpdate consumes each active rho. Preserve that mutation in
        // the caller's arrays, including when the split views did the work.
        for (let k = 1; k < this.K; k++) if (this.t % this.n ** k === 0) {
            for (const col of rhoNext[k]) col.fill(false);
        }
        if (onMove) {
            for (const move of mergedMoves) if (this.seamGeometry(move.from.level) === 'merged') onMove(move);
            for (let patch = 0; patch < 2; patch++) {
                for (const move of patchMoves[patch]) {
                    if (this.seamGeometry(move.from.level) !== 'split') continue;
                    const offset = patch * this.L / this.n ** move.from.level;
                    onMove({ ...move, from: { ...move.from, ry: move.from.ry + offset },
                        to: { ...move.to, ry: move.to.ry + offset } });
                }
            }
        }
        return merged;
    }

    _messageUpdate(sNext, tauNext) {
        if (this.slices.every((_, k) => this.seamGeometry(k) === 'merged')) return super._messageUpdate(sNext, tauNext);
        const result = super._messageUpdate(sNext, tauNext);
        const patches = [0, 1].map(patch => SurfaceCGStreamingDecoder.prototype._messageUpdate.call(this.getPatchDecoder(patch),
            sNext.map((s, k) => takeRows(s, patch * this.L / this.n ** k, this.L / this.n ** k)),
            tauNext.map((s, k) => takeRows(s, patch * this.L / this.n ** k, this.L / this.n ** k))));
        for (let k = 0; k < this.K; k++) {
            if (this.seamGeometry(k) === 'merged') continue;
            for (const name of ['mNext', 'thetaNext']) {
                result[name][k] = patches[0][name][k].map((channel, i) => joinRows(channel, patches[1][name][k][i]));
            }
            result.cNext[k] = joinRows(patches[0].cNext[k], patches[1].cNext[k]);
        }
        return result;
    }

    _erasureSubstep(sl, lx, ly) {
        const k = Math.round(Math.log(this.L / lx) / Math.log(this.n));
        if (this.seamGeometry(k) === 'merged') return super._erasureSubstep(sl, lx, ly);
        const halves = [0, 1].map(p => super._erasureSubstep(patchSlice(sl, p), lx, ly / 2));
        return {
            mNext: halves[0].mNext.map((channel, i) => joinRows(channel, halves[1].mNext[i])),
            thNext: halves[0].thNext.map((channel, i) => joinRows(channel, halves[1].thNext[i])),
        };
    }

    step(onMove = null) {
        this._advanceSurgeryBeforeStep();
        super.step(onMove);
        this._advanceSurgeryAfterStep();
    }

    getResidualSyndrome() {
        const { Ex, Ey } = this.expandCorrection();
        const rx = this.bx.map((col, x) => col.map((b, y) => b !== Ex[x][y]));
        const ry = this.by.map((col, x) => col.map((b, y) => b !== Ey[x][y]));
        if (!this._seamQubitsPresent) for (const col of ry) col[this.L] = false;
        const syndrome = syndromeOpen(rx, ry, this.Lx, this.Ly);
        if (!this._seamQubitsPresent && this.seamFrameCommitted) {
            // In this error-bit representation each merge's |0> preparation
            // starts a new physical reference. The frame change in that
            // reference is δψ=ψ_committed xor ψ_premerge=F(q), while ψ itself
            // remains cumulative as required by 6563. Thus, at every seam
            // endpoint, S(b_nonseam xor E_nonseam) xor δψ equals the syndrome
            // of the virtual residual with its retained E_seam included.
            // The harness proves this identity for every check, including a
            // nonzero seam frame and a second split with retained channels.
            for (let x = 0; x < this.L; x++) {
                for (let side = 0; side < 2; side++) {
                    const y = this.L - 1 + side;
                    syndrome[x][y] = syndrome[x][y] !== (this.seamFrame[x][side] !== this._seamFrameBaseline[x][side]);
                }
            }
        }
        return syndrome;
    }
    getErrorCount() {
        const { Ex, Ey } = this.expandCorrection();
        let count = 0;
        for (let x = 0; x <= this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) if (this.bx[x][y] !== Ex[x][y]) count++;
        }
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 1; y < this.Ly; y++) {
                if (!this._seamQubitsPresent && y === this.L) continue;
                if (this.by[x][y] !== Ey[x][y]) count++;
            }
        }
        return count;
    }
    getResidualDefectCount() { return this.getResidualSyndrome().flat().filter(Boolean).length; }
    checkLogicalError() {
        const { Ex } = this.expandCorrection();
        const syndrome = this.getResidualSyndrome();
        const patches = [0, 1].map(patch => {
            const y0 = patch * this.L;
            let logical = false;
            for (let y = y0; y < y0 + this.L; y++) logical = logical !== (this.bx[this.x0][y] !== Ex[this.x0][y]);
            const residualClear = syndrome.every(col => !col.slice(y0, y0 + this.L).some(Boolean));
            return { logical, residualClear, hasError: logical || !residualClear };
        });
        const residualClear = patches.every(p => p.residualClear);
        const logical = this._seamQubitsPresent ? patches[0].logical !== patches[1].logical : patches.some(p => p.logical);
        return { residualClear, logical, hasError: logical || !residualClear, patches,
            description: !residualClear ? 'residual syndrome is not clear' : logical ? 'nontrivial logical column parity' : undefined };
    }
}
