// Condensing rough surgery, X-check sector (main.tex:6585–6740).
// Two independent n-adic patch hierarchies are retained (6745–6752).
// Only slice 0 has an additional seam-check column. Its promotions are
// assigned to the left patch's seam-adjacent parent (6747). At coarse
// levels the two seam-adjacent columns are neighbours once non-absorbing.
// Correction paths join identified block centres through both former
// dangling qx edges; absorbed candidates instead end at the physical seam.
//
// Reader's choices: hidden reference eigenvalues represent the intrinsically
// random first seam measurements. The reported outcome is the parity of
// committed seam checks requested by the task (6665–6666); it does not add
// the central-logical strip parity discussed separately at main.tex:6749.
import { SurfaceCGStreamingDecoder, syndromeOpen } from './surface_cg_streaming.js';
import { SurfaceCGSurgeryDecoder } from './surface_cg_surgery_base.js';

const LARGE_TIMER = 1 << 30;
const MESSAGE_OFFSETS = [[-1, -1], [-1, 1], [1, -1]];
const make2D = (nx, ny, value) => Array.from({ length: nx }, () => Array(ny).fill(value));
const make3D = (depth, nx, ny, value) => Array.from({ length: depth }, () => make2D(nx, ny, value));
const copy2D = rows => rows.map(row => row.slice());
const copy3D = rows => rows.map(copy2D);
const parity = bits => bits.reduce((a, b) => a !== !!b, false);
function secondaryRng(seed) {
    let state = seed >>> 0;
    const random = () => {
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    random.getState = () => state;
    random.setState = value => { state = value | 0; };
    return random;
}

export class SurfaceCGSurgeryXDecoder extends SurfaceCGSurgeryDecoder {
    constructor(L, clockPeriod = 6, opts = {}) {
        super(L, clockPeriod, { ...opts, sector: 'x' });
        this.sector = 'x';
        this.patchL = L;
        this.Lx = 2 * L + 1;
        this.Ly = L;
        this.reset();
    }

    sizeOf(k) {
        if (this.sector !== 'x') return SurfaceCGStreamingDecoder.prototype.sizeOf.call(this, k);
        const width = this.patchL / this.n ** k;
        return [2 * width + (k === 0 ? 1 : 0), width];
    }

    reset() {
        SurfaceCGStreamingDecoder.prototype.reset.call(this);
        if (this.sector !== 'x' || !this.patchL) return;
        this._resetSurgeryState();
        this._patchNoiseEnabled = [true, true];
        this._rngB = secondaryRng((this.seed ^ 0x51ED270B) >>> 0);
        this._seamHidden = Array(this.patchL).fill(false);
        this.seamFrame = Array(this.patchL).fill(false);
        this._seamPrevious = Array(this.patchL).fill(false);
        this._seamChi = Array(this.patchL).fill(false);
        this._preMergeSupport = Array(this.patchL).fill(false);
        this._seamMeasured = Array(this.patchL).fill(false);
        this._seamLeft = this.slices.map(sl => Array(sl.Ly).fill(false));
        this._seamRight = this.slices.map(sl => Array(sl.Ly).fill(false));
        this._seamChild = this.slices.map(sl => Array.from({ length: sl.Ly }, () => Array(this.n).fill(false)));
        this.trueSurgeryOutcome = null;
        this.surgeryOutcome = null;
        this.outcomeCheck = null;
        this.seamFrameCommitted = false;
        this.rejected = false;
        this._firstMergeMeasurement = false;
        this._resetFinalTimers = false;
        this._seamPresent = false;
    }

    setPatchNoiseEnabled(patch, enabled) {
        this._patchNoiseEnabled[patch === 'B' || patch === 1 ? 1 : 0] = !!enabled;
    }

    coarseSitePhysical(k, rx, ry) {
        const scale = this.n ** k;
        if (k === 0) return [rx, ry];
        const width = this.patchL / scale;
        return [scale * rx + Math.floor(scale / 2) + (rx >= width ? 1 : 0),
            scale * ry + Math.floor(scale / 2)];
    }

    isSeamSite(k, rx) {
        const width = this.patchL / this.n ** k;
        return k === 0 ? rx === width : rx === width - 1 || rx === width;
    }

    _absorbing(k) { return this.seamGeometry(k, this.t) === 'split'; }
    _inactiveFineSeam(k, x) { return k === 0 && x === this.patchL && this._absorbing(k); }
    _sliceTimed(k) {
        return k < this.K - 1 || (this.surgery?.kind === 'merge'
            && this.t < this.surgery.completeTime - 1);
    }
    _read(array, x, y, k, originX) {
        const [nx, ny] = this.sizeOf(k);
        if (x < 0 || y < 0 || x >= nx || y >= ny) return 0;
        if (this._absorbing(k)) {
            const width = this.patchL / this.n ** k;
            if (k === 0) {
                if (x === width || originX === width) return 0;
                if ((x < width) !== (originX < width)) return 0;
            } else if ((x < width) !== (originX < width)) return 0;
        }
        return array[x][y];
    }
    _vote(array, dx, dy, x, y, k) {
        return Number(!!array[x][y]) + Number(!!this._read(array, x + dx, y, k, x))
            + Number(!!this._read(array, x, y + dy, k, x)) >= 2;
    }

    _startMerge() {
        const correction = this.expandCorrection();
        this._preMergeSupport = this._seamSupport(correction.Ex, correction.Ey);
        this.by[this.patchL].fill(false); // fresh seam qubits in |0>, main.tex:6181.
        this.trueSurgeryOutcome = this._rng() < 0.5;
        for (let y = 0; y < this.patchL - 1; y++) this._seamHidden[y] = this._rng() < 0.5;
        this._seamHidden[this.patchL - 1] = this.trueSurgeryOutcome
            !== parity(this._seamHidden.slice(0, -1));
        this._firstMergeMeasurement = true;
        this._resetFinalTimers = true;
        this._seamPresent = true;
        this.seamFrameCommitted = false;
        this.surgeryOutcome = null;
        this.outcomeCheck = null;
    }

    _startSplit() {
        const pMeas = this._noiseEnabled ? this.pMeas : 0;
        this._seamMeasured = this.by[this.patchL].map((bit, y) => y > 0
            && (bit !== (pMeas > 0 && this._rng() < pMeas)));
        this._seamPresent = false;
        this._firstMergeMeasurement = false;
    }

    _commitMerge() {
        if (this.rejected) return;
        this.seamFrameCommitted = true;
        this.surgeryOutcome = Number(parity(this.seamFrame));
        this.outcomeCheck = !!this.surgeryOutcome === this.trueSurgeryOutcome;
    }
    _commitSplit() {}

    _seamSupport(qx, qy) {
        return Array.from({ length: this.patchL }, (_, y) =>
            ((qx[this.patchL][y] !== qx[this.patchL + 1][y])
                !== qy[this.patchL][y])
                !== (y + 1 < this.patchL && qy[this.patchL][y + 1]));
    }

    _drawPhi() {
        if (this._testPhiQueue?.length) return this._testPhiQueue.shift();
        const L = this.patchL;
        const phi = make2D(this.Lx, L, false);
        let measurementError = false;
        // Patch A owns the ordinary RNG stream. Independent B draws do not
        // perturb its trajectory when B's noise is disabled (split regression).
        for (let patch = 0; patch < 2; patch++) {
            const offset = patch * (L + 1), rng = patch ? this._rngB : this._rng;
            const active = this._noiseEnabled && this._patchNoiseEnabled[patch];
            const pPhys = active ? this.pPhys : 0, pMeas = active ? this.pMeas : 0;
            const meas = make2D(L, L, false);
            if (pPhys > 0 || pMeas > 0) {
                for (let x = 0; x <= L; x++) for (let y = 0; y < L; y++) {
                    if (rng() < pPhys) this.bx[offset + x][y] = !this.bx[offset + x][y];
                }
                for (let x = 0; x < L; x++) for (let y = 1; y < L; y++) {
                    if (rng() < pPhys) this.by[offset + x][y] = !this.by[offset + x][y];
                }
                for (let x = 0; x < L; x++) for (let y = 0; y < L; y++) {
                    meas[x][y] = rng() < pMeas;
                    measurementError ||= meas[x][y];
                }
            }
            for (let x = 0; x < L; x++) for (let y = 0; y < L; y++) {
                const gx = offset + x;
                const syndrome = ((this.bx[gx][y] !== this.bx[gx + 1][y]) !== this.by[gx][y])
                    !== (y + 1 < L && this.by[gx][y + 1]);
                const measured = syndrome !== meas[x][y];
                phi[gx][y] = measured !== this._prevTildeS[gx][y];
                this._prevTildeS[gx][y] = measured;
            }
        }
        if (this._seamPresent) {
            const pPhys = this._noiseEnabled ? this.pPhys : 0;
            const pMeas = this._noiseEnabled ? this.pMeas : 0;
            for (let y = 1; y < L; y++) if (pPhys > 0 && this._rng() < pPhys) {
                this.by[L][y] = !this.by[L][y];
            }
            const syndrome = this._seamSupport(this.bx, this.by);
            for (let y = 0; y < L; y++) {
                const noise = pMeas > 0 && this._rng() < pMeas;
                measurementError ||= noise;
                const measured = (this._seamHidden[y] !== syndrome[y]) !== noise;
                // main.tex:6597 first seam measurement creates a frame,
                // not a detector event; later rounds use differences.
                phi[L][y] = !this._firstMergeMeasurement && (measured !== this._seamPrevious[y]);
                this._seamPrevious[y] = measured;
                this._prevTildeS[L][y] = measured;
            }
        }
        this._lastMeasurementHasError = measurementError;
        return phi;
    }

    _promotionRecord(k, x, y) {
        const width = this.patchL / this.n ** k;
        const py = Math.floor(y / this.n), ay = y % this.n;
        if (k === 0 && x === width) {
            return [1, width / this.n - 1, py, this.n, ay];
        }
        const isB = k === 0 ? x > width : x >= width;
        const localX = x - (isB ? width + (k === 0 ? 1 : 0) : 0);
        return [k + 1, Math.floor(localX / this.n) + (isB ? width / this.n : 0),
            py, localX % this.n, ay];
    }

    _recordIntake() {
        const eChildNext = this.slices.map((sl, k) => k ? sl.e_child.map(row => row.map(copy2D)) : null);
        const rhoNext = this.slices.map((sl, k) => k ? copy2D(sl.rho) : null);
        for (const [k, x, y, ax, ay] of this.pending.get(this.t + 1) || []) {
            if (ax === this.n) this._seamChild[k][y][ay] = !this._seamChild[k][y][ay];
            else eChildNext[k][x][y][ax][ay] = !eChildNext[k][x][y][ax][ay];
            // Absorption is decided on record arrival, even if this slice's
            // n^k clock does not fire on this physical update (6620).
            if (this.surgery?.kind === 'merge' && this._absorbing(k) && this.isSeamSite(k, x, y)) {
                this._absorbAtSeam(k, x, y, this._intakeOnMove);
            } else rhoNext[k][x][y] = !rhoNext[k][x][y];
        }
        return { eChildNext, rhoNext };
    }

    _absorbAtSeam(k, x, y, onMove = null) {
        const width = this.patchL / this.n ** k;
        if (k > 0) {
            const channel = x < width ? this._seamLeft : this._seamRight;
            channel[k][y] = !channel[k][y];
        }
        const py = this.coarseSitePhysical(k, x, y)[1];
        if (this.surgery?.kind === 'merge') this._seamChi[py] = !this._seamChi[py];
        if (onMove) onMove({ from: { level: k, rx: x, ry: y },
            to: { level: k, rx: k ? width - 0.5 : width, ry: y, boundary: 'seam' }, kind: 'boundary' });
    }

    _finalPromotion(k, x, y, onMove) {
        if (this.isSeamSite(k, x, y)) this._absorbAtSeam(k, x, y, onMove);
        else this.rejected = true; // main.tex:6659, no auxiliary site away from seam.
    }

    step(onMove = null) {
        this._advanceSurgeryBeforeStep();
        this._seamChi.fill(false);
        if (this._resetFinalTimers) {
            const sl = this.slices[this.K - 1];
            sl.tau = make2D(sl.Lx, sl.Ly, 0);
            sl.th = make3D(3, sl.Lx, sl.Ly, 0);
            this._resetFinalTimers = false;
        }
        const firstMeasurement = this._firstMergeMeasurement;
        this._intakeOnMove = onMove;
        try {
            SurfaceCGStreamingDecoder.prototype.step.call(this, onMove);
        } finally {
            delete this._intakeOnMove; // an observer is not persistent decoder state.
        }
        if (this.surgery?.kind === 'merge') {
            for (let y = 0; y < this.patchL; y++) {
                this.seamFrame[y] = firstMeasurement
                    ? (this._seamPrevious[y] !== this._preMergeSupport[y]) !== this._seamChi[y]
                    : this.seamFrame[y] !== this._seamChi[y];
            }
        }
        this._firstMergeMeasurement = false;
        this._advanceSurgeryAfterStep();
    }
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
            const timed = this._sliceTimed(k);
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
                    if (this._inactiveFineSeam(k, x)) {
                        this._absorbAtSeam(k, x, y, onMove);
                        continue;
                    }
                    let tauPlus = 0;

                    if (timed) {
                        tauPlus = sl.tau[x][y] + 1;
                        if (tauPlus === t0) {
                            if (k === K - 1) {
                                this._finalPromotion(k, x, y, onMove);
                            } else {
                                const arrivalT = t + Math.pow(n, k + 1) + 1;
                                addPending(arrivalT, this._promotionRecord(k, x, y));
                            }
                            continue;
                        }
                    }

                    let moveLeft = false, moveDown = false;
                    const movementAllowed = !this.movementGated || sl.c[x][y] === 0;
                    if (movementAllowed) {
                        const m0jLeft = this._read(m00, x - 1, y, k, x) || this._read(m01, x - 1, y, k, x);
                        if (m0jLeft) {
                            moveLeft = true;
                        } else {
                            moveDown = this._read(m00, x, y - 1, k, x) || this._read(m10, x, y - 1, k, x);
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
            const timed = this._sliceTimed(k);
            const sT = sl.s, sT1 = sNext[k];
            const tauT = sl.tau, tauT1 = tauNext[k];
            const cT = sl.c;
            const mK = make3D(3, LxK, LyK, false);
            const thK = make3D(3, LxK, LyK, 0);

            for (let x = 0; x < LxK; x++) {
                for (let y = 0; y < LyK; y++) {
                    if (this._inactiveFineSeam(k, x)) continue;
                    const [dx00, dy00] = MESSAGE_OFFSETS[0];
                    const vote00 = this._vote(sl.m[0], dx00, dy00, x, y, k);
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
                                if (this._read(messageT, x + dx, y, k, x)) {
                                    const neighborTimer = this._read(thetaT, x + dx, y, k, x);
                                    if (neighborTimer < t0 - 1) growthTimer = neighborTimer;
                                }
                                if (this._read(messageT, x, y + dy, k, x)) {
                                    const neighborTimer = this._read(thetaT, x, y + dy, k, x);
                                    if (neighborTimer < t0 - 1) {
                                        growthTimer = Math.min(growthTimer, neighborTimer);
                                    }
                                }
                                if (growthTimer < Infinity) {
                                    hasCandidate = true;
                                    timer = Math.min(timer, 1 + growthTimer);
                                }
                            }

                            const voteIj = (idx === 0) ? vote00 : this._vote(messageT, dx, dy, x, y, k);
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
                                growth = this._read(messageT, x + dx, y, k, x) || this._read(messageT, x, y + dy, k, x);
                            }
                            const voteIj = (idx === 0) ? vote00 : this._vote(messageT, dx, dy, x, y, k);
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

    _splitDestination(k, x) {
        const width = this.patchL / this.n ** k;
        if (k === 0 && x === width) return { target: x, center: false,
            boundary: this._absorbing(k) ? 'seam' : null };
        const isB = k === 0 ? x > width : x >= width;
        const start = isB ? width + (k === 0 ? 1 : 0) : 0;
        const localX = x - start, centre = Math.floor(width / 2);
        const direction = localX < centre ? -1 : 1;
        let target = x + direction;
        let boundary = null;
        if (localX + direction < 0 || localX + direction >= width) {
            const towardSeam = (isB && direction < 0) || (!isB && direction > 0);
            if (towardSeam) {
                if (this._absorbing(k)) boundary = 'seam';
                else if (k > 0) target = x; // sweep stops in the seam-adjacent columns (6745).
            } else boundary = direction < 0 ? 'left' : 'right';
        }
        return { target, center: localX === centre - 1 || localX === centre, boundary };
    }

    _splittingStep(sl, LxK, LyK, timedIgnored, onMove = null, k = 0) {
        const timed = this._sliceTimed(k);
        const newM = make3D(3, LxK, LyK, false);
        const newTh = timed ? make3D(3, LxK, LyK, 0) : null;
        const newS = make2D(LxK, LyK, false);
        const minTau = make2D(LxK, LyK, LARGE_TIMER);
        const newEx = copy2D(sl.e_x);
        let condensed = 0;
        for (let x = 0; x < LxK; x++) {
            const { target, center, boundary } = this._splitDestination(k, x);
            for (let y = 0; y < LyK; y++) {
                const retain = center && !sl.s[x][y];
                for (let channel = 0; channel < 3; channel++) {
                    if (!sl.m[channel][x][y]) continue;
                    if (!boundary) {
                        newM[channel][target][y] = true;
                        if (timed) newTh[channel][target][y] = sl.th[channel][x][y];
                    }
                    if (retain) {
                        newM[channel][x][y] = true;
                        if (timed) newTh[channel][x][y] = sl.th[channel][x][y];
                    }
                }
                if (!sl.s[x][y]) continue;
                if (boundary === 'seam') {
                    if (k === 0 && x !== this.patchL) {
                        const edge = target < x ? x : x + 1;
                        newEx[edge][y] = !newEx[edge][y];
                    }
                    this._absorbAtSeam(k, x, y, onMove);
                    condensed++;
                } else {
                    if (target !== x) {
                        const edge = target < x ? x : x + 1;
                        newEx[edge][y] = !newEx[edge][y];
                    }
                    if (boundary) {
                        condensed++;
                        if (onMove) onMove({ from: { level: k, rx: x, ry: y },
                            to: { level: k, rx: boundary === 'left' ? -0.5 : LxK - 0.5,
                                ry: y, boundary }, kind: 'boundary' });
                    } else {
                        newS[target][y] = !newS[target][y];
                        minTau[target][y] = Math.min(minTau[target][y], sl.tau[x][y]);
                        if (onMove && target !== x) onMove({ from: { level: k, rx: x, ry: y },
                            to: { level: k, rx: target, ry: y }, kind: 'split' });
                    }
                }
            }
        }
        sl.s = newS;
        sl.e_x = newEx;
        sl.m = newM;
        if (timed) {
            sl.th = newTh;
            sl.tau = newS.map((row, x) => row.map((bit, y) => bit ? minTau[x][y] : 0));
        }
        return condensed;
    }

    _erasureSubstep(sl, nx, ny) {
        const k = this.slices.findIndex(candidate => candidate.Lx === nx && candidate.Ly === ny);
        const mNext = make3D(3, nx, ny, false), thNext = make3D(3, nx, ny, 0);
        for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
            if (this._inactiveFineSeam(k, x)) continue;
            const vote00 = this._vote(sl.m[0], -1, -1, x, y, k);
            const coupling = sl.m[0][x][y] && vote00;
            for (let channel = 0; channel < 3; channel++) {
                const [dx, dy] = MESSAGE_OFFSETS[channel];
                const vote = channel ? this._vote(sl.m[channel], dx, dy, x, y, k) : vote00;
                const bit = sl.s[x][y] || (sl.m[channel][x][y] && (vote || coupling));
                mNext[channel][x][y] = !!bit;
                if (bit) thNext[channel][x][y] = sl.th[channel][x][y];
            }
        }
        return { mNext, thNext };
    }

    expandCorrection() {
        const Ex = make2D(this.Lx + 1, this.Ly, false), Ey = make2D(this.Lx, this.Ly, false);
        const xRun = (x0, x1, y) => {
            for (let edge = Math.min(x0, x1) + 1; edge <= Math.max(x0, x1); edge++) {
                Ex[edge][y] = !Ex[edge][y];
            }
        };
        const yRun = (y0, y1, x) => {
            for (let edge = Math.min(y0, y1) + 1; edge <= Math.max(y0, y1); edge++) {
                Ey[x][edge] = !Ey[x][edge];
            }
        };
        for (let k = 0; k < this.K; k++) {
            const sl = this.slices[k], width = this.patchL / this.n ** k;
            for (let edge = 0; edge <= sl.Lx; edge++) for (let y = 0; y < sl.Ly; y++) {
                if (!sl.e_x[edge][y]) continue;
                const py = this.coarseSitePhysical(k, 0, y)[1];
                const x0 = edge === 0 ? -1 : this.coarseSitePhysical(k, edge - 1, y)[0];
                const x1 = edge === sl.Lx ? this.Lx : this.coarseSitePhysical(k, edge, y)[0];
                xRun(x0, x1, py);
            }
            for (let x = 0; x < sl.Lx; x++) for (let edge = 1; edge < sl.Ly; edge++) {
                if (!sl.e_y[x][edge]) continue;
                const [px, y0] = this.coarseSitePhysical(k, x, edge - 1);
                const y1 = this.coarseSitePhysical(k, x, edge)[1];
                yRun(y0, y1, px);
            }
            if (k === 0) continue;
            for (let y = 0; y < sl.Ly; y++) {
                const [left, py] = this.coarseSitePhysical(k, width - 1, y);
                const [right] = this.coarseSitePhysical(k, width, y);
                if (this._seamLeft[k][y]) xRun(left, this.patchL, py);
                if (this._seamRight[k][y]) xRun(this.patchL, right, py);
                for (let ay = 0; ay < this.n; ay++) if (this._seamChild[k][y][ay]) {
                    const childY = this.n * y + ay; // only physical seam children use this channel.
                    xRun(this.patchL, left, childY);
                    yRun(childY, py, left);
                }
            }
            for (let rx = 0; rx < sl.Lx; rx++) for (let ry = 0; ry < sl.Ly; ry++) {
                const parent = this.coarseSitePhysical(k, rx, ry);
                for (let ax = 0; ax < this.n; ax++) for (let ay = 0; ay < this.n; ay++) {
                    if (!sl.e_child[rx][ry][ax][ay]) continue;
                    const isB = rx >= width;
                    const childWidth = width * this.n;
                    const childX = this.n * (rx - (isB ? width : 0)) + ax
                        + (isB ? childWidth + (k === 1 ? 1 : 0) : 0);
                    const child = this.coarseSitePhysical(k - 1, childX, this.n * ry + ay);
                    xRun(child[0], parent[0], child[1]);
                    yRun(child[1], parent[1], parent[0]);
                }
            }
        }
        return { Ex, Ey };
    }

    getResidualSyndrome() {
        const { Ex, Ey } = this.expandCorrection();
        const residualX = this.bx.map((row, x) => row.map((bit, y) => bit !== Ex[x][y]));
        const residualY = this.by.map((row, x) => row.map((bit, y) => bit !== Ey[x][y]));
        const result = syndromeOpen(residualX, residualY, this.Lx, this.Ly);
        // A merged seam's ideal stabilizer is its committed frame. Hidden r
        // defines the physical eigenvalue and never enters detector corrections.
        for (let y = 0; y < this.Ly; y++) result[this.patchL][y] = this._seamPresent
            ? (result[this.patchL][y] !== this._seamHidden[y]) !== this.seamFrame[y] : false;
        return result;
    }
    getErrorCount() {
        const { Ex, Ey } = this.expandCorrection();
        let count = 0;
        for (let x = 0; x <= this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
            if (this.bx[x][y] !== Ex[x][y]) count++;
        }
        for (let x = 0; x < this.Lx; x++) {
            if (!this._seamPresent && x === this.patchL) continue;
            for (let y = 1; y < this.Ly; y++) if (this.by[x][y] !== Ey[x][y]) count++;
        }
        return count;
    }
    getResidualDefectCount() { return this.getResidualSyndrome().flat().filter(Boolean).length; }
    getSystemDefectCount() { return this.getResidualDefectCount(); }
    get seamPresent() { return this._seamPresent; }
    getPatchLogicalIndicators() {
        const { Ex } = this.expandCorrection();
        return [0, this.patchL + 1].map(x => Number(parity(this.bx[x].map((bit, y) => bit !== Ex[x][y]))));
    }
    checkLogicalError() {
        const patchLogical = this.getPatchLogicalIndicators();
        const residualClear = this.getResidualDefectCount() === 0;
        const logical = this._seamPresent ? !!patchLogical[0] : patchLogical.some(Boolean);
        return { hasError: this.rejected || !residualClear || logical, logical, residualClear,
            patchLogical, patches: patchLogical.map(logical => ({ logical })), rejected: this.rejected };
    }
    isQuiescent() {
        return !this.surgery && SurfaceCGStreamingDecoder.prototype.isQuiescent.call(this);
    }

    // Exact standalone-shaped view used by the split regression harness.
    getPatchSnapshot(patch = 0) {
        const isB = patch === 1 || patch === 'B';
        const offset = isB ? this.patchL + 1 : 0;
        const crop2 = (array, x0, nx) => array.slice(x0, x0 + nx).map(row => row.slice());
        const slices = this.slices.map((sl, k) => {
            const width = this.patchL / this.n ** k;
            const start = isB ? width + (k === 0 ? 1 : 0) : 0;
            const result = { Lx: width, Ly: width };
            for (const key of ['s', 'tau', 'e_y', 'c']) result[key] = crop2(sl[key], start, width);
            result.e_x = crop2(sl.e_x, start, width + 1);
            if (k > 0) result.e_x[isB ? 0 : width] = (isB ? this._seamRight : this._seamLeft)[k].slice();
            for (const key of ['m', 'th']) result[key] = sl[key].map(array => crop2(array, start, width));
            result.rho = k ? crop2(sl.rho, start, width) : null;
            result.e_child = k ? sl.e_child.slice(start, start + width).map(row => row.map(copy2D)) : null;
            return result;
        });
        const pending = new Map();
        for (const [time, records] of this.pending) {
            const selected = records.filter(([k, x]) => (x >= this.patchL / this.n ** k) === isB)
                .map(([k, x, y, ax, ay]) => [k, x - (isB ? this.patchL / this.n ** k : 0), y, ax, ay]);
            if (selected.length) pending.set(time, selected);
        }
        return { slices, pending, bx: crop2(this.bx, offset, this.patchL + 1),
            by: crop2(this.by, offset, this.patchL),
            _prevTildeS: crop2(this._prevTildeS, offset, this.patchL),
            _lastPhi: crop2(this._lastPhi, offset, this.patchL), t: this.t, stepCount: this.stepCount };
    }
}
