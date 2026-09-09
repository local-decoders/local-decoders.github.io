// Shared control plane for the two CSS sectors of a rough surgery.
// Physical updates remain in the sector modules. main.tex:6456 assumes
// distinct operations separated by a sufficiently large constant times L.
import { SurfaceCGStreamingDecoder } from './surface_cg_streaming.js';

export const SURGERY_SPACING_STEPS_PER_L = 1;
export const SURGERY_CONDENSING_M = 2;
export const SURGERY_DEFAULT_SIZE = 16;
export const SURGERY_MAX_SIZE = 32;

export class SurfaceCGSurgeryDecoder extends SurfaceCGStreamingDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        super(L, clockPeriod, { ...opts, Ly: opts.sector === 'z' ? 2 * L : L });
        if (opts.tuning) this.tuning = { ...opts.tuning };
        this.sector = opts.sector ?? 'z';
        this._initiallyMerged = !!opts.mergedFromStart;
        this._resetSurgeryState();
    }

    _resetSurgeryState() {
        this.surgery = null;
        this._stableSeamState = this._initiallyMerged ? 'merged' : 'split';
        this.lastSurgeryStep = 0;
        this.geometrySwitchLog = [];
        this._sliceGeometry = new Array(this.K).fill(this._stableSeamState);
        this.seamFrameCommitted = false;
        this.surgeryOutcome = null;
        this.outcomeCheck = null;
        this.rejected = false;
    }

    delta(k) {
        let delay = 0;
        for (let j = 0; j < k; j++) delay += this.t0 * this.n ** j;
        return delay;
    }

    get stepsSinceLastSurgery() { return this.stepCount - this.lastSurgeryStep; }
    get nextSurgeryStep() {
        const spaced = this.lastSurgeryStep
            + (this.tuning?.surgerySpacingStepsPerL ?? SURGERY_SPACING_STEPS_PER_L) * this.L;
        return this.surgery ? Math.max(spaced, this.surgery.completeTime + 1) : spaced;
    }
    canMerge() {
        return !this.surgery && this._stableSeamState === 'split'
            && this.stepsSinceLastSurgery
                >= (this.tuning?.surgerySpacingStepsPerL ?? SURGERY_SPACING_STEPS_PER_L) * this.L;
    }
    canSplit() {
        return !this.surgery && this._stableSeamState === 'merged'
            && this.stepsSinceLastSurgery
                >= (this.tuning?.surgerySpacingStepsPerL ?? SURGERY_SPACING_STEPS_PER_L) * this.L;
    }

    get seamState() {
        if (!this.surgery) return this._stableSeamState;
        return `${this.surgery.kind === 'merge' ? 'merging' : 'splitting'} ${this.switchedSliceCount}/${this.K} slices`;
    }
    get switchedSliceCount() {
        if (!this.surgery) return this.K;
        const wanted = this.surgery.kind === 'merge' ? 'merged' : 'split';
        // Report the same geometry the view shows for the upcoming update.
        return this.slices.filter((_, k) => this.seamGeometry(k) === wanted).length;
    }
    seamGeometry(k, t = this.t) {
        if (!this.surgery) return this._stableSeamState;
        const after = this.surgery.kind === 'merge' ? 'merged' : 'split';
        const before = this.surgery.kind === 'merge' ? 'split' : 'merged';
        return t >= this.surgery.switchTimes[k] ? after : before;
    }
    get sliceGeometry() { return this._sliceGeometry; }
    get geometryEvents() { return this.geometrySwitchLog; }
    getSliceSeamState(k, t = this.t) { return this.seamGeometry(k, t); }

    _beginSurgery(kind) {
        if (!(kind === 'merge' ? this.canMerge() : this.canSplit())) return false;
        const T = this.t;
        const switchTimes = Array.from({ length: this.K }, (_, k) => T +
            (this.sector === 'z'
                ? this.delta(k + (kind === 'split' ? 1 : 0))
                : this.delta(k) * (kind === 'merge'
                    ? (this.tuning?.surgeryCondensingM ?? SURGERY_CONDENSING_M) : 1)));
        const completeTime = this.sector === 'x' && kind === 'merge'
            ? T + (this.tuning?.surgeryCondensingM ?? SURGERY_CONDENSING_M) * this.delta(this.K)
            : switchTimes[this.K - 1] + 1;
        this.surgery = { kind, T, switchTimes, completeTime };
        this.lastSurgeryStep = this.stepCount;
        if (kind === 'merge') this._startMerge(); else this._startSplit();
        return true;
    }
    merge() { return this._beginSurgery('merge'); }
    split() { return this._beginSurgery('split'); }
    _startMerge() {}
    _startSplit() {}
    _commitMerge() {}
    _commitSplit() {}

    _advanceSurgeryBeforeStep() {
        if (!this.surgery) return;
        for (let k = 0; k < this.K; k++) {
            const geometry = this.seamGeometry(k, this.t);
            if (geometry === this._sliceGeometry[k]) continue;
            this._sliceGeometry[k] = geometry;
            this.geometrySwitchLog.push({ kind: this.surgery.kind, k, t: this.t,
                step: this.stepCount + 1, geometry });
            this.onGeometrySwitch?.(k, geometry, this.t);
        }
    }
    _advanceSurgeryAfterStep() {
        if (!this.surgery || this.t < this.surgery.completeTime) return;
        const kind = this.surgery.kind;
        if (kind === 'merge') this._commitMerge(); else this._commitSplit();
        this._stableSeamState = kind === 'merge' ? 'merged' : 'split';
        this.surgery = null;
    }

    isQuiescent() {
        return !this.surgery && super.isQuiescent();
    }
}
