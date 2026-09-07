// Haah Code Decoder — combined 3D scatter + z-slice view
// Qubits: 2 per vertex (qubitsA = q0, qubitsB = q1), shown as red spheres when errored.
// Syndrome: one per cube, at cube center (x+0.5, y+0.5, z+0.5).
//
// Syndrome formula (from haah_code_ca.py):
//   s[i,j,k] = q0[i,j,k]   ^ q0[i+1,j+1,k] ^ q0[i+1,j,k+1] ^ q0[i,j+1,k+1]
//            ^ q1[i,j,k]   ^ q1[i,j+1,k]   ^ q1[i+1,j,k]   ^ q1[i,j,k+1]
import { loadLogicalData, missingLogicalDataResult } from './logical_data.js';

// TASK 4ex: named, exported so main.js's getLegendItems('haah', ...) can
// build its legend from these same values instead of duplicating them --
// the exact colours _update3D() paints the syndrome ("defect") and
// errored-qubit ("error") spheres, the only two glyphs the 3D view (the
// only view left once the combined view's 2D slice panel is removed --
// see enable3DMode()) actually draws. String form (not a bare 0xRRGGBB
// number) so the identical constant works both as a CSS legend swatch
// colour and as a Three.js material colour -- Three.js's own Color
// constructor (and so any material's `color` option) accepts a CSS hex
// string exactly like a numeric literal.
export const COLOR_DEFECT = '#8a9ee8';
export const COLOR_ERROR_QUBIT = '#af3737';

// Inset the stage to the repetition spacetime box's top while retaining
// the shared canvas's bottom edge and the panel's natural height.
export const THREE_PILLAR_STAGE_HEIGHT = 650;
export const STAGE_TOP_INSET = 12;
// Preserve perspective pixel scale in the shorter viewport. The default
// page-space shift follows its centre; it is independent of lattice size.
export const CAMERA_VIEWPORT_SCALE = THREE_PILLAR_STAGE_HEIGHT
    / (THREE_PILLAR_STAGE_HEIGHT - STAGE_TOP_INSET);
export const CAMERA_VERTICAL_SHIFT_PX = STAGE_TOP_INSET / 2;

// 3D appearance: radii are world units at the reference size. Orb sizes
// grow gently with L so large lattices retain readable defects/errors.
export const STYLE_REFERENCE_L = 10;
export const ORB_SIZE_EXPONENT = 0.5;
export const DEFECT_RADIUS = 0.25;
export const ERROR_QUBIT_RADIUS = 0.105;
export const IDLE_QUBIT_RADIUS = 0.035;
export const QUBIT_OFFSET = 0.08;
export const ORB_RIM_SCALE = 1.12;
export const ORB_WIDTH_SEGMENTS = 20;
export const ORB_HEIGHT_SEGMENTS = 12;
export const IDLE_WIDTH_SEGMENTS = 8;
export const IDLE_HEIGHT_SEGMENTS = 6;
export const COLOR_DEFECT_RIM = '#525252';
export const COLOR_ERROR_RIM = '#702323';
export const COLOR_IDLE_QUBIT = '#808080';
export const IDLE_QUBIT_OPACITY = 0.38;
export const GHOST_OPACITY_SCALE = 0.4;
export const GHOST_ERROR_FADE = 0.55;
export const COLOR_3D_GRID = '#808080';
export const GRID_OPACITY = 0.24;
export const COLOR_CUBE_EDGE = '#808080';
export const CUBE_EDGE_OPACITY = 0.62;
export const AMBIENT_LIGHT_INTENSITY = 2.2;
export const KEY_LIGHT_INTENSITY = 0.9;
export const KEY_LIGHT_X_PER_L = -1;
export const KEY_LIGHT_Y_PER_L = 2;
export const KEY_LIGHT_Z_PER_L = 2;
// Translate the camera and orbit target together so the projected cube
// sits slightly above the stage midpoint, leaving more room below it.
// The camera-target vector, perspective, and proportional size stay fixed.
export const CAMERA_Y_OFFSET_PER_L = -0.2;
export const CAMERA_ELEVATION_FACTOR = 1.25;
export const CAMERA_DISTANCE_FACTOR = 1.09;

// Precomputed logical operators loaded once from JSON, keyed by L.
// Fetch begins immediately on module import. The host waits for this promise
// before finalizing a checked verdict; failed or absent data stays explicit.
const _haahLogicalData = loadLogicalData(new URL('../data/haah_logicals.json', import.meta.url));
const _haahLogicalsCache = _haahLogicalData.cache;

export class HaahCodeDecoder {
    constructor(L, clockPeriod = 8, opts = {}) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.stepCount = 0;
        this.logicalDataReady = _haahLogicalData.ready;
        // The host owns the radio, playback and verdict state. Standalone
        // viewers cannot edit until the host supplies an explicit gate.
        this._canEditInitialErrors = opts.canEditInitialErrors ?? null;
        this._prepareInitialErrorsEdit = opts.prepareInitialErrorsEdit ?? null;
        this._onInitialErrorsEdited = opts.onInitialErrorsEdited ?? null;
        // TASK 4ex: mirrors toric2.js/surface2.js/surface.js's own
        // `this.clock` convention (a persistent property, not just the
        // local `clock`/`clk` variable step()/the old on-canvas caption
        // computed for their own internal use) -- main.js's updateStats()
        // shows the state card's "clock" row generically for any decoder
        // whose `.clock` is a finite number, so this alone is what makes
        // that row appear for this tab now. Kept in sync with stepCount at
        // the end of every step() call, below.
        this.clock = 0;

        this.qubitsA = this._arr3(L, false);   // q0 errors at vertices
        this.qubitsB = this._arr3(L, false);   // q1 errors at vertices
        this.syndrome = this._arr3(L, false);  // per-cube syndromes

        // messages[x][y][z][i][j][k]: 8-channel boolean message array
        this.messages = this._arr6(L, false);

        // Three.js (lazy-loaded)
        this.THREE = null;
        this.OrbitControls = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this._threeContainer = null;
        this._threeWidth = 0;
        this._threeHeight = 0;
        this._threePixelRatio = 0;
        this.controls = null;
        this.animationFrameId = null;
        this.synObjs = [];
        this.qubitMeshes = [];      // idle/error instance batches, with qubit mappings
        this.ghostQubitMeshes = []; // PBC instance batches, mapped to real qubits
        this._qubitSites = [];
        this._ghostQubitSites = [];
        this._displayChange = null;
        this.cleanLineSegs = null;
        this.outerLineSegs = null;
        this.is3DMode = false;
    }

    // ── Array helpers ──────────────────────────────────────────────────

    _arr3(L, fill = false) {
        return Array.from({ length: L }, () =>
            Array.from({ length: L }, () => new Array(L).fill(fill))
        );
    }

    _arr6(L, fill = false) {
        return Array.from({ length: L }, () =>
            Array.from({ length: L }, () =>
                Array.from({ length: L }, () =>
                    Array.from({ length: 2 }, () =>
                        Array.from({ length: 2 }, () => new Array(2).fill(fill))
                    )
                )
            )
        );
    }

    // Keep compat alias
    create3DArray(size, fill) { return this._arr3(size, fill); }

    // ── Public API ─────────────────────────────────────────────────────

    initializeRandomErrors(p, rng = Math.random) {
        const L = this.L;
        for (let i = 0; i < L; i++)
            for (let j = 0; j < L; j++)
                for (let k = 0; k < L; k++) {
                    this.qubitsA[i][j][k] = rng() < p;
                    this.qubitsB[i][j][k] = rng() < p;
                }
        this.messages = this._arr6(L, false);
        this.stepCount = 0;
        this.clock = 0;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); }
    }

    initializeClear() {
        const L = this.L;
        for (let i = 0; i < L; i++)
            for (let j = 0; j < L; j++)
                for (let k = 0; k < L; k++) {
                    this.qubitsA[i][j][k] = false;
                    this.qubitsB[i][j][k] = false;
                }
        this.messages = this._arr6(L, false);
        this.stepCount = 0;
        this.clock = 0;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); }
    }

    // ── Syndrome ───────────────────────────────────────────────────────
    // Syndrome at cube (i,j,k) matches haah_code_ca.py calculate_syndrome:
    //   s[i,j,k] = q0[i,j,k]     ^ q0[i+1,j+1,k] ^ q0[i+1,j,k+1] ^ q0[i,j+1,k+1]
    //            ^ q1[i,j,k]     ^ q1[i,j+1,k]   ^ q1[i+1,j,k]   ^ q1[i,j,k+1]

    calculateSyndrome() {
        const L = this.L;
        for (let i = 0; i < L; i++) {
            const ip = (i + 1) % L;
            for (let j = 0; j < L; j++) {
                const jp = (j + 1) % L;
                for (let k = 0; k < L; k++) {
                    const kp = (k + 1) % L;
                    this.syndrome[i][j][k] = (
                        this.qubitsA[i][j][k] ^
                        this.qubitsA[ip][jp][k] ^
                        this.qubitsA[ip][j][kp] ^
                        this.qubitsA[i][jp][kp] ^
                        this.qubitsB[i][j][k] ^
                        this.qubitsB[i][jp][k] ^
                        this.qubitsB[ip][j][k] ^
                        this.qubitsB[i][j][kp]
                    );
                }
            }
        }
    }

    // ── CA Step — matches haah_code_ca.py step_ca exactly ─────────────
    //
    // Messages: m[x][y][z][i][j][k], 8 channels per site.
    // Channel (i,j,k): x-neighbor at (x + (-1)^i), y-neighbor at (y + (-1)^j),
    //                  z-neighbor at (z + (-1)^k).
    // Clock: counter = stepCount % clockPeriod; spread fires at counter == 0.

    step(site = null) {
        const L = this.L;
        // r(v, shift): modular index v - shift (used for _roll semantics)
        const r = (v, s) => (v - s + L * 100) % L;

        this.calculateSyndrome();
        const s = this.syndrome;
        const m = this.messages;
        const clock = this.stepCount % this.clockPeriod;

        // ── 2. HasM aggregates ────────────────────────────────────────────
        // any_m1jk[x][y][z] = ∃ j,k: m[x][y][z][1][j][k]
        // any_mi1k[x][y][z] = ∃ i,k: m[x][y][z][i][1][k]
        // any_mij1[x][y][z] = ∃ i,j: m[x][y][z][i][j][1]
        const any_m1jk = this._arr3(L, false);
        const any_mi1k = this._arr3(L, false);
        const any_mij1 = this._arr3(L, false);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++)
                    for (let a = 0; a < 2; a++)
                        for (let b = 0; b < 2; b++) {
                            if (m[x][y][z][1][a][b]) any_m1jk[x][y][z] = true;
                            if (m[x][y][z][a][1][b]) any_mi1k[x][y][z] = true;
                            if (m[x][y][z][a][b][1]) any_mij1[x][y][z] = true;
                        }

        // ── 3. Check conditions ───────────────────────────────────────────
        // Check(r,1): HasM(i=1) at r-ex, r-ex-ey, r-ex-ez, r-ex-ey-ez
        // Check(r,2): HasM(j=1) at r-ey, r-ex-ey, r-ey-ez, r-ex-ey-ez
        // Check(r,3): HasM(k=1) at r-ez, r-ex-ez, r-ey-ez, r-ex-ey-ez
        const check1 = this._arr3(L, false);
        const check2 = this._arr3(L, false);
        const check3 = this._arr3(L, false);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    const xm = r(x, 1), ym = r(y, 1), zm = r(z, 1);
                    check1[x][y][z] = any_m1jk[xm][y][z] || any_m1jk[xm][ym][z]
                        || any_m1jk[xm][y][zm] || any_m1jk[xm][ym][zm];
                    check2[x][y][z] = any_mi1k[x][ym][z] || any_mi1k[xm][ym][z]
                        || any_mi1k[x][ym][zm] || any_mi1k[xm][ym][zm];
                    check3[x][y][z] = any_mij1[x][y][zm] || any_mij1[xm][y][zm]
                        || any_mij1[x][ym][zm] || any_mij1[xm][ym][zm];
                }

        // ── 4. TryPair ────────────────────────────────────────────────────
        // TryPair(r,1): HasM(j=1) at r-ey,r-2ey AND HasM(k=1) at r-ez,r-2ez
        // TryPair(r,2): HasM(i=1) at r-ex,r-2ex AND HasM(k=1) at r-ez,r-2ez
        // TryPair(r,3): HasM(i=1) at r-ex,r-2ex AND HasM(j=1) at r-ey,r-2ey
        const tp1_raw = this._arr3(L, false);
        const tp2_raw = this._arr3(L, false);
        const tp3_raw = this._arr3(L, false);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    tp1_raw[x][y][z] = any_mi1k[x][r(y, 1)][z] && any_mi1k[x][r(y, 2)][z]
                        && any_mij1[x][y][r(z, 1)] && any_mij1[x][y][r(z, 2)];
                    tp2_raw[x][y][z] = any_m1jk[r(x, 1)][y][z] && any_m1jk[r(x, 2)][y][z]
                        && any_mij1[x][y][r(z, 1)] && any_mij1[x][y][r(z, 2)];
                    tp3_raw[x][y][z] = any_m1jk[r(x, 1)][y][z] && any_m1jk[r(x, 2)][y][z]
                        && any_mi1k[x][r(y, 1)][z] && any_mi1k[x][r(y, 2)][z];
                }

        // ── 5. Exclusive condition chain ──────────────────────────────────
        const cond_all = this._arr3(L, false);
        const tp1 = this._arr3(L, false);
        const tp2 = this._arr3(L, false);
        const tp3 = this._arr3(L, false);
        const unhandled = this._arr3(L, false);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    const sv = s[x][y][z];
                    const ca = sv && check1[x][y][z] && check2[x][y][z] && check3[x][y][z];
                    cond_all[x][y][z] = ca;
                    const t1 = sv && !ca && tp1_raw[x][y][z];
                    tp1[x][y][z] = t1;
                    const t2 = sv && !ca && !t1 && tp2_raw[x][y][z];
                    tp2[x][y][z] = t2;
                    const t3 = sv && !ca && !t1 && !t2 && tp3_raw[x][y][z];
                    tp3[x][y][z] = t3;
                    unhandled[x][y][z] = sv && !ca && !t1 && !t2 && !t3;
                }

        // ── 6. PairInCheck ────────────────────────────────────────────────
        // isin_xm1[r] = unhandled[r-ex], etc.
        // PairInCheck(r,1): isin_ym1 & isin_zm1 & check1
        // PairInCheck(r,2): isin_xm1 & isin_zm1 & check2
        // PairInCheck(r,3): isin_xm1 & isin_ym1 & check3
        // cond_nin: satisfied site where any PairInCheck fires
        const cond_nin = this._arr3(L, false);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    if (s[x][y][z]) continue;  // must be satisfied
                    const pic1 = unhandled[x][r(y, 1)][z] && unhandled[x][y][r(z, 1)] && check1[x][y][z];
                    const pic2 = unhandled[r(x, 1)][y][z] && unhandled[x][y][r(z, 1)] && check2[x][y][z];
                    const pic3 = unhandled[r(x, 1)][y][z] && unhandled[x][r(y, 1)][z] && check3[x][y][z];
                    cond_nin[x][y][z] = pic1 || pic2 || pic3;
                }

        // ── 7. S_in accumulation ──────────────────────────────────────────
        // setOr(arr, dx, dy, dz): for each r where arr[r] is true,
        //   set s_in[r - (dx,dy,dz)]  (matches _shifted_3d(arr,dx,dy,dz) semantics)
        const s_in = this._arr3(L, false);
        const setOr = (arr, dx, dy, dz) => {
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        if (arr[x][y][z])
                            s_in[r(x, dx)][r(y, dy)][r(z, dz)] = true;
        };
        // cond_all: S_in ← {r-(0,1,1), r-(1,1,0), r-(1,0,1)}
        setOr(cond_all, 0, 1, 1); setOr(cond_all, 1, 1, 0); setOr(cond_all, 1, 0, 1);
        // tp1: S_in ← {r-(0,1,0), r-(0,2,0), r-(0,0,1), r-(0,0,2)}
        setOr(tp1, 0, 1, 0); setOr(tp1, 0, 2, 0); setOr(tp1, 0, 0, 1); setOr(tp1, 0, 0, 2);
        // tp2: S_in ← {r-(1,0,0), r-(2,0,0), r-(0,0,1), r-(0,0,2)}
        setOr(tp2, 1, 0, 0); setOr(tp2, 2, 0, 0); setOr(tp2, 0, 0, 1); setOr(tp2, 0, 0, 2);
        // tp3: S_in ← {r-(1,0,0), r-(2,0,0), r-(0,1,0), r-(0,2,0)}
        setOr(tp3, 1, 0, 0); setOr(tp3, 2, 0, 0); setOr(tp3, 0, 1, 0); setOr(tp3, 0, 2, 0);
        // cond_nin: S_in ← {r'-(1,0,0), r'-(0,1,0), r'-(0,0,1), r'-(1,1,0), r'-(1,0,1), r'-(0,1,1), r'-(1,1,1)}
        setOr(cond_nin, 1, 0, 0); setOr(cond_nin, 0, 1, 0); setOr(cond_nin, 0, 0, 1);
        setOr(cond_nin, 1, 1, 0); setOr(cond_nin, 1, 0, 1); setOr(cond_nin, 0, 1, 1);
        setOr(cond_nin, 1, 1, 1);

        // ── 8. Message update ─────────────────────────────────────────────
        // For channel (i,j,k) at site (x,y,z):
        //   x-neighbor: (x + (-1)^i) = i==0 ? x+1 : x-1
        //   y-neighbor: (y + (-1)^j) = j==0 ? y+1 : y-1
        //   z-neighbor: (z + (-1)^k) = k==0 ? z+1 : z-1
        // Spread (counter==0, satisfied, m_old=0): absorb any neighbor
        // Toom (m_old=1): vote = (self+nb_x+nb_y+nb_z)>=2 OR failsafe
        // Failsafe: m[1][1][1]_old & vote[1][1][1] broadcast to all channels
        // Syndrome: force all channels true
        // S_in: force all channels true
        const m_new = this._arr6(L, false);
        const do_spread = (clock === 0);

        for (let x = 0; x < L; x++) {
            const xp = (x + 1) % L, xm2 = (x - 1 + L) % L;
            for (let y = 0; y < L; y++) {
                const yp = (y + 1) % L, ym2 = (y - 1 + L) % L;
                for (let z = 0; z < L; z++) {
                    const zp = (z + 1) % L, zm2 = (z - 1 + L) % L;
                    const sv = s[x][y][z];
                    const sin_v = s_in[x][y][z];
                    const spread_here = do_spread && !sv;

                    // First pass: compute vote[i][j][k] for all channels
                    const vote = [[[false, false], [false, false]], [[false, false], [false, false]]];
                    for (let i = 0; i < 2; i++) {
                        const xnb = (i === 0) ? xp : xm2;
                        for (let j = 0; j < 2; j++) {
                            const ynb = (j === 0) ? yp : ym2;
                            for (let k = 0; k < 2; k++) {
                                const znb = (k === 0) ? zp : zm2;
                                const sm = m[x][y][z][i][j][k] ? 1 : 0;
                                const nx = m[xnb][y][z][i][j][k] ? 1 : 0;
                                const ny = m[x][ynb][z][i][j][k] ? 1 : 0;
                                const nz = m[x][y][znb][i][j][k] ? 1 : 0;
                                vote[i][j][k] = (sm + nx + ny + nz) >= 2;
                            }
                        }
                    }
                    const failsafe = m[x][y][z][1][1][1] && vote[1][1][1];

                    // Second pass: apply update rules
                    for (let i = 0; i < 2; i++) {
                        const xnb = (i === 0) ? xp : xm2;
                        for (let j = 0; j < 2; j++) {
                            const ynb = (j === 0) ? yp : ym2;
                            for (let k = 0; k < 2; k++) {
                                const znb = (k === 0) ? zp : zm2;
                                const self_m = m[x][y][z][i][j][k];
                                let cur;
                                if (self_m) {
                                    cur = vote[i][j][k] || failsafe;
                                } else if (spread_here) {
                                    cur = m[xnb][y][z][i][j][k]
                                        || m[x][ynb][z][i][j][k]
                                        || m[x][y][znb][i][j][k];
                                } else {
                                    cur = false;
                                }
                                if (sv || sin_v) cur = true;
                                m_new[x][y][z][i][j][k] = cur;
                            }
                        }
                    }
                }
            }
        }

        // ── 9. Corrective flips ───────────────────────────────────────────
        // flip_q0[r] = cond_all ^ tp1 ^ tp2 ^ tp3 ^ cond_nin
        // flip_q1[r] = _shifted3d(tp1,0,1,0) ^ _shifted3d(tp1,0,0,1)
        //            ^ _shifted3d(tp2,1,0,0) ^ _shifted3d(tp2,0,0,1)
        //            ^ _shifted3d(tp3,1,0,0) ^ _shifted3d(tp3,0,1,0)
        //            ^ cond_nin
        // _shifted3d(arr,dx,dy,dz)[x][y][z] = arr[x+dx][y+dy][z+dz]
        for (let x = 0; x < L; x++) {
            const xp = (x + 1) % L;
            for (let y = 0; y < L; y++) {
                const yp = (y + 1) % L;
                for (let z = 0; z < L; z++) {
                    if (site && (x !== site[0] || y !== site[1] || z !== site[2])) continue;
                    const zp = (z + 1) % L;
                    const fq0 = cond_all[x][y][z] ^ tp1[x][y][z] ^ tp2[x][y][z]
                        ^ tp3[x][y][z] ^ cond_nin[x][y][z];
                    const fq1 = tp1[x][yp][z] ^ tp1[x][y][zp]
                        ^ tp2[xp][y][z] ^ tp2[x][y][zp]
                        ^ tp3[xp][y][z] ^ tp3[x][yp][z]
                        ^ cond_nin[x][y][z];
                    if (fq0) this.qubitsA[x][y][z] = !this.qubitsA[x][y][z];
                    if (fq1) this.qubitsB[x][y][z] = !this.qubitsB[x][y][z];
                }
            }
        }

        if (site) {
            const [x0, y0, z0] = site;
            for (let i = 0; i < 2; i++)
                for (let j = 0; j < 2; j++)
                    for (let k = 0; k < 2; k++)
                        this.messages[x0][y0][z0][i][j][k] = m_new[x0][y0][z0][i][j][k];
        } else {
            this.messages = m_new;
        }
        this.stepCount++;
        // TASK 4ex: see this.clock's own constructor comment -- kept in
        // lockstep with stepCount, independent of the pre-increment local
        // `clock` above (this step's own do_spread condition, which must
        // stay tied to the OLD stepCount).
        this.clock = this.stepCount % this.clockPeriod;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); }
    }

    stepUncoord() {
        const L = this.L;
        this.step([
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L)
        ]);
    }

    // ── render() — called by main.js ───────────────────────────────────

    render(ctx, width, height, options) {
        // TASK 4ex: no-op while in 3D mode -- the combined view's own 2D
        // slice panel is gone (see enable3DMode()'s own comment), and the
        // 3D scene refreshes itself independently (its own
        // requestAnimationFrame loop, plus _update3D() called directly
        // after every state change: initializeRandomErrors()/
        // initializeClear()/step()/the raycaster click handler), so this
        // call -- main.js's normal per-render hook, still fired on every
        // Step/Play/resize -- has nothing left to do once a 3D scene
        // already exists. Falls through to the original flat 2D drawing
        // only if Three.js failed to load (enable3DMode() returned false
        // without ever setting is3DMode), so the decoder is never left
        // with a blank canvas in that case.
        if (this.is3DMode) return;
        this._drawSlices(ctx, width, height, options);
    }

    // ── z-slice drawing ────────────────────────────────────────────────
    // Right panel shows fractons only (syndrome violations as amber dots).
    // Qubit balls and error toggling are in the 3D panel on the left.

    _drawSlices(ctx, width, height, options) {
        const L = this.L;
        options = options || { showSyndrome: true, showGrid: true };
        const cols = Math.min(L, 4);
        const rows = Math.ceil(L / cols);
        const pad = 8;
        const labelH = 15;
        const statsH = 20;

        const totalW = width - pad * 2;
        const totalH = height - pad * 2 - statsH;
        const sliceW = Math.floor(totalW / cols);
        const sliceH = Math.floor(totalH / rows);
        const cell = Math.max(4, Math.min(
            Math.floor((sliceW - 2) / L),
            Math.floor((sliceH - labelH - 2) / L)
        ));

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        for (let z = 0; z < L; z++) {
            const col = z % cols;
            const row = Math.floor(z / cols);
            const ox = pad + col * sliceW;
            const oy = pad + row * sliceH;

            ctx.fillStyle = '#64748b';
            ctx.font = '10px JetBrains Mono, monospace';
            ctx.fillText(`z=${z}`, ox + 2, oy + 10);

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(ox, oy + labelH, L * cell, L * cell);

            if (options.showGrid && cell >= 4) {
                ctx.strokeStyle = '#e2e8f0';
                ctx.lineWidth = 0.5;
                for (let i = 0; i <= L; i++) {
                    ctx.beginPath();
                    ctx.moveTo(ox + i * cell, oy + labelH);
                    ctx.lineTo(ox + i * cell, oy + labelH + L * cell);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(ox, oy + labelH + i * cell);
                    ctx.lineTo(ox + L * cell, oy + labelH + i * cell);
                    ctx.stroke();
                }
            }

            // Fracton excitations: fill entire cell (x,y) when syndrome[x][y][z] is active
            if (options.showSyndrome) {
                ctx.fillStyle = COLOR_DEFECT;
                for (let x = 0; x < L; x++) {
                    for (let y = 0; y < L; y++) {
                        if (this.syndrome[x][y][z]) {
                            ctx.fillRect(
                                ox + x * cell,
                                oy + labelH + (L - 1 - y) * cell,
                                cell, cell
                            );
                        }
                    }
                }
            }
        }

        // TASK 4ex: on-canvas "Step/Clock/Syn" caption removed -- this
        // duplicated the HTML state card's own step/clock/defects rows,
        // which main.js's updateStats() already keeps current regardless
        // of which of this method's two callers (the 3D-mode combined
        // view -- gone now, see enable3DMode() -- or this render() path's
        // own Three.js-load-failure fallback) is active.
    }

    _readOptions() {
        return {
            showSyndrome: document.getElementById('show-syndrome')?.checked ?? true,
            showErrors: document.getElementById('show-errors')?.checked ?? true,
            showGrid: document.getElementById('show-grid')?.checked ?? true,
        };
    }

    // ── Combined 3D + slice view ───────────────────────────────────────

    async enable3DMode(isCurrent = () => true) {
        if (!isCurrent()) return false;
        if (this.is3DMode) return true;

        try {
            const T = await import('https://esm.sh/three@0.160.0');
            if (!isCurrent()) return false;
            const { OrbitControls } = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
            if (!isCurrent()) return false;
            this.THREE = T;
            this.OrbitControls = OrbitControls;
        } catch (e) {
            if (isCurrent()) console.error('Three.js load failed:', e);
            return false;
        }

        const canvasArea = document.querySelector('.canvas-area');
        if (!canvasArea) return false;

        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = 'none';

        // Replace the hidden canvas in normal flow. This gives the panel
        // the same title + 650px stage/inset + padding height as the 2D tabs,
        // and fixes the stage dimensions before camera initialization.
        const wrapper = document.createElement('div');
        wrapper.id = 'combined-view';
        Object.assign(wrapper.style, {
            position: 'relative', display: 'flex', alignItems: 'stretch',
            width: '100%', height: `${THREE_PILLAR_STAGE_HEIGHT - STAGE_TOP_INSET}px`,
            marginTop: `${STAGE_TOP_INSET}px`,
            flex: '0 0 100%',
        });
        canvasArea.appendChild(wrapper);

        const threeDiv = document.createElement('div');
        threeDiv.id = 'three-left';
        Object.assign(threeDiv.style, {
            flex: '1 1 auto', borderRadius: '6px', overflow: 'hidden',
            background: '#f8fafc', outline: '1px solid #e2e8f0',
            outlineOffset: '-1px', position: 'relative',
        });
        wrapper.appendChild(threeDiv);

        await new Promise(r => requestAnimationFrame(r));
        if (!isCurrent()) {
            wrapper.remove();
            return false;
        }
        this._initThree(threeDiv);
        this.is3DMode = true;

        this._displayChange = () => this._update3D();
        ['show-syndrome', 'show-errors', 'show-grid'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', this._displayChange);
        });

        return true;
    }

    // ── Three.js scene setup ───────────────────────────────────────────

    _initThree(container) {
        const T = this.THREE;
        const w = container.clientWidth || 580;
        const h = container.clientHeight || 600;
        this._threeContainer = container;
        this._threeWidth = w;
        this._threeHeight = h;
        this._threePixelRatio = window.devicePixelRatio || 1;
        this.renderer = new T.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(this._threePixelRatio);
        this.renderer.setSize(w, h);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        this._resetCamera();
        this._buildScene();

        // Only fire on genuine clicks (not drag-ends from OrbitControls).
        let mouseDownX = 0, mouseDownY = 0;
        this.renderer.domElement.style.cursor = 'pointer';
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            mouseDownX = e.clientX; mouseDownY = e.clientY;
        });
        this.renderer.domElement.addEventListener('click', (e) => {
            const dx = e.clientX - mouseDownX, dy = e.clientY - mouseDownY;
            if (dx * dx + dy * dy > 16) return;
            if (!this._canEditInitialErrors?.()) return;

            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new T.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                ((e.clientY - rect.top) / rect.height) * -2 + 1
            );
            const raycaster = new T.Raycaster();
            raycaster.setFromCamera(mouse, this.camera);
            const hits = raycaster.intersectObjects([...this.qubitMeshes, ...this.ghostQubitMeshes]);
            if (hits.length === 0) return;

            const { object, instanceId } = hits[0];
            let { x, y, z, q } = object.userData.qubits[instanceId];
            // Resolve the hit before resetting a finished run. The host keeps
            // this lattice and its errors while restarting run bookkeeping.
            if (this._prepareInitialErrorsEdit && !this._prepareInitialErrorsEdit()) return;
            // Keep a picked site in range if a standalone host replaces state
            // while preparing the edit; pending site controls wait for Initialize.
            x %= this.L; y %= this.L; z %= this.L;
            if (q === 0) this.qubitsA[x][y][z] = !this.qubitsA[x][y][z];
            else this.qubitsB[x][y][z] = !this.qubitsB[x][y][z];
            this.calculateSyndrome();
            this._update3D();
            this._onInitialErrorsEdited?.();
        });

        const _loop = () => {
            this.animationFrameId = requestAnimationFrame(_loop);
            this._resizeThree();
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        _loop();
    }

    // Keep the live canvas, renderer, input handlers and animation loop.
    // Fresh state is already initialized before any new instance is filled;
    // in particular, a smaller lattice never visits the old site's indices.
    reinitialize3D(fresh) {
        const sizeChanged = this.L !== fresh.L;
        for (const key of ['L', 'clockPeriod', 'stepCount', 'clock', 'qubitsA', 'qubitsB', 'syndrome', 'messages']) {
            this[key] = fresh[key];
        }
        if (sizeChanged) {
            const previousScene = this.scene;
            this._buildScene();
            this._resetCamera();
            // Upload all filled instances and draw at the final camera/target
            // in this same task. Never clear, resize or detach the canvas.
            this.renderer.render(this.scene, this.camera);
            this._disposeScene(previousScene);
        } else {
            this._update3D();
            // Populate the retained buffer before paint, including the
            // automatic Initialize immediately after the first load draw.
            this.renderer.render(this.scene, this.camera);
        }
    }

    _updateCameraProjection() {
        const w = this._threeWidth, h = this._threeHeight;
        this.camera.aspect = w / h;
        this.camera.zoom = CAMERA_VIEWPORT_SCALE;
        // setViewOffset also updates the inverse projection used by picking.
        // Subtract the stage-centre movement so the knob denotes the total
        // translation from the original, uninset stage in page pixels.
        this.camera.setViewOffset(w, h, 0,
            STAGE_TOP_INSET / 2 - CAMERA_VERTICAL_SHIFT_PX, w, h);
    }

    _resizeThree() {
        const w = this._threeContainer.clientWidth;
        const h = this._threeContainer.clientHeight;
        // A display/DPR change need not emit a CSS resize; check every frame.
        const pixelRatio = window.devicePixelRatio || 1;
        if (!w || !h || (w === this._threeWidth && h === this._threeHeight
            && pixelRatio === this._threePixelRatio)) return;
        this._threeWidth = w;
        this._threeHeight = h;
        // Resize and repaint within the existing frame, retaining the scene,
        // camera position and orbit target. Rebuilds never resize the buffer.
        if (pixelRatio !== this._threePixelRatio) {
            this._threePixelRatio = pixelRatio;
            this.renderer.setPixelRatio(pixelRatio);
        }
        this.renderer.setSize(w, h, false);
        this._updateCameraProjection();
    }

    _resetCamera() {
        const T = this.THREE;
        const L = this.L;
        const cameraOffset = L * CAMERA_Y_OFFSET_PER_L;
        // OrbitControls keeps private damping deltas. Replacing only the
        // controls discards those deltas without touching the live renderer.
        this.controls?.dispose();
        this.camera = new T.PerspectiveCamera(50, this._threeWidth / this._threeHeight, 0.1, 1000);
        this._updateCameraProjection();
        // Adjust the original target-relative view in spherical coordinates,
        // keeping elevation and distance independent of the framing offset.
        const baseHorizontal = Math.SQRT2 * (1.8 - 0.5);
        const baseVertical = 1.4 - 0.5;
        const elevation = Math.atan2(baseVertical, baseHorizontal) * CAMERA_ELEVATION_FACTOR;
        const distance = L * Math.hypot(baseHorizontal, baseVertical) * CAMERA_DISTANCE_FACTOR;
        const horizontal = distance * Math.cos(elevation) / Math.SQRT2;
        this.camera.position.set(L / 2 + horizontal,
            L / 2 + cameraOffset + distance * Math.sin(elevation), L / 2 + horizontal);
        this.controls = new this.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(L / 2, L / 2 + cameraOffset, L / 2);
        this.controls.update();
        this.controls.enableDamping = true;
        this.controls.saveState();
    }

    _buildScene() {
        const T = this.THREE;
        const L = this.L;
        this.scene = new T.Scene();
        this.scene.background = new T.Color(0xf8fafc);

        this.scene.add(new T.AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY));
        const dl = new T.DirectionalLight(0xffffff, KEY_LIGHT_INTENSITY);
        dl.position.set(L * KEY_LIGHT_X_PER_L, L * KEY_LIGHT_Y_PER_L, L * KEY_LIGHT_Z_PER_L);
        dl.target.position.set(L / 2, L / 2, L / 2);
        this.scene.add(dl, dl.target);

        const idleGeo = new T.SphereGeometry(1, IDLE_WIDTH_SEGMENTS, IDLE_HEIGHT_SEGMENTS);
        const orbGeo = new T.SphereGeometry(1, ORB_WIDTH_SEGMENTS, ORB_HEIGHT_SEGMENTS);
        // The enlarged back faces provide a real silhouette rim at every
        // orbit angle, sharing the fill's instance transforms and mapping.
        const rimGeo = orbGeo.clone().scale(ORB_RIM_SCALE, ORB_RIM_SCALE, ORB_RIM_SCALE);
        const idleMat = new T.MeshBasicMaterial({
            color: COLOR_IDLE_QUBIT, transparent: true,
            opacity: IDLE_QUBIT_OPACITY, depthWrite: false,
        });
        // Neutral diffuse shading follows the shared anyon orb palette;
        // Lambert has no specular highlight to wash out the site red.
        const errorMat = new T.MeshLambertMaterial({
            color: COLOR_ERROR_QUBIT,
        });
        const defectMat = new T.MeshLambertMaterial({
            color: COLOR_DEFECT,
        });
        const errorRimMat = new T.MeshBasicMaterial({ color: COLOR_ERROR_RIM, side: T.BackSide });
        const defectRimMat = new T.MeshBasicMaterial({ color: COLOR_DEFECT_RIM, side: T.BackSide });
        const ghostIdleMat = idleMat.clone();
        ghostIdleMat.opacity *= GHOST_OPACITY_SCALE;
        // Opaque, background-mixed ghosts avoid transparency sorting
        // artifacts while remaining quieter than the real error qubits.
        const ghostErrorMat = errorMat.clone();
        ghostErrorMat.color.lerp(this.scene.background, GHOST_ERROR_FADE);
        const ghostRimMat = errorRimMat.clone();
        ghostRimMat.color.lerp(this.scene.background, GHOST_ERROR_FADE);

        this._qubitSites = [];
        this._ghostQubitSites = [];
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    for (let q = 0; q < 2; q++) {
                        const offset = q === 0 ? QUBIT_OFFSET : -QUBIT_OFFSET;
                        this._qubitSites.push({ x, y, z, q, px: x + offset, py: y, pz: z });
                        const xs = x === 0 ? [0, L] : [x];
                        const ys = y === 0 ? [0, L] : [y];
                        const zs = z === 0 ? [0, L] : [z];
                        for (const gx of xs) {
                            for (const gy of ys) {
                                for (const gz of zs) {
                                    if (gx === x && gy === y && gz === z) continue;
                                    this._ghostQubitSites.push({ x, y, z, q, px: gx + offset, py: gy, pz: gz });
                                }
                            }
                        }
                    }
                }
            }
        }

        const makeBatch = (geometry, material, capacity, rimMaterial = null) => {
            const mesh = new T.InstancedMesh(geometry, material, capacity);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.count = 0;
            mesh.userData.qubits = [];
            // Every batch stays within the same cube. A fixed conservative
            // bound avoids scanning all instance matrices after every step.
            mesh.boundingSphere = new T.Sphere(
                new T.Vector3(L / 2, L / 2, L / 2), Math.sqrt(3) * (L / 2 + 1)
            );
            this.scene.add(mesh);
            if (rimMaterial) {
                const rim = new T.InstancedMesh(rimGeo, rimMaterial, capacity);
                rim.instanceMatrix = mesh.instanceMatrix;
                rim.count = 0;
                rim.boundingSphere = mesh.boundingSphere;
                mesh.userData.rim = rim;
                this.scene.add(rim);
            }
            return mesh;
        };
        this.qubitMeshes = [
            makeBatch(idleGeo, idleMat, this._qubitSites.length),
            makeBatch(orbGeo, errorMat, this._qubitSites.length, errorRimMat),
        ];
        this.ghostQubitMeshes = [
            makeBatch(idleGeo, ghostIdleMat, this._ghostQubitSites.length),
            makeBatch(orbGeo, ghostErrorMat, this._ghostQubitSites.length, ghostRimMat),
        ];
        this.synObjs = [makeBatch(orbGeo, defectMat, L ** 3, defectRimMat)];
        this._instanceTransform = new T.Matrix4();

        // Allocate both grid layers once. Outer edges belong only to the
        // stronger layer, so their weight does not depend on overdraw.
        const edgePos = [], outerPos = [];
        for (let i = 0; i <= L; i++) {
            for (let j = 0; j <= L; j++) {
                const positions = (i === 0 || i === L) && (j === 0 || j === L) ? outerPos : edgePos;
                positions.push(i, j, 0, i, j, L);
                positions.push(i, 0, j, i, L, j);
                positions.push(0, i, j, L, i, j);
            }
        }
        const makeLines = (positions, color, opacity) => {
            const geometry = new T.BufferGeometry();
            geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            const lines = new T.LineSegments(geometry,
                new T.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
            this.scene.add(lines);
            return lines;
        };
        this.cleanLineSegs = makeLines(edgePos, COLOR_3D_GRID,
            GRID_OPACITY * Math.min(1, STYLE_REFERENCE_L / L));
        this.outerLineSegs = makeLines(outerPos, COLOR_CUBE_EDGE, CUBE_EDGE_OPACITY);
        this._update3D();

    }

    // Update compact instance batches in place; no geometry/material
    // allocation during Initialize, stepping or display changes.
    _update3D() {
        if (!this.scene) return;
        const L = this.L;
        const opts = this._readOptions();
        const orbScale = Math.pow(L / STYLE_REFERENCE_L, ORB_SIZE_EXPONENT);
        const transform = this._instanceTransform;
        const place = (mesh, x, y, z, radius, qubit = null) => {
            transform.makeScale(radius, radius, radius).setPosition(x, y, z);
            mesh.setMatrixAt(mesh.count, transform);
            if (qubit) mesh.userData.qubits[mesh.count] = qubit;
            mesh.count++;
        };
        const finish = (mesh, visible) => {
            mesh.visible = visible;
            mesh.instanceMatrix.needsUpdate = true;
            const rim = mesh.userData.rim;
            if (rim) {
                rim.count = mesh.count;
                rim.visible = visible;
            }
        };
        const updateQubits = (sites, batches) => {
            for (const mesh of batches) {
                mesh.count = 0;
                mesh.userData.qubits.length = 0;
            }
            for (const site of sites) {
                const { x, y, z, q, px, py, pz } = site;
                const errored = q === 0 ? this.qubitsA[x][y][z] : this.qubitsB[x][y][z];
                place(batches[errored ? 1 : 0], px, py, pz,
                    errored ? ERROR_QUBIT_RADIUS * orbScale : IDLE_QUBIT_RADIUS, site);
            }
            for (const mesh of batches) finish(mesh, opts.showErrors);
        };
        updateQubits(this._qubitSites, this.qubitMeshes);
        updateQubits(this._ghostQubitSites, this.ghostQubitMeshes);
        this.cleanLineSegs.visible = opts.showGrid;
        this.outerLineSegs.visible = opts.showGrid;

        const defects = this.synObjs[0];
        defects.count = 0;
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    if (this.syndrome[x][y][z]) {
                        place(defects, x + 0.5, y + 0.5, z + 0.5, DEFECT_RADIUS * orbScale);
                    }
                }
            }
        }
        finish(defects, opts.showSyndrome);
    }

    // ── Stats ──────────────────────────────────────────────────────────

    getSyndromeCount() {
        let n = 0;
        const L = this.L;
        for (let i = 0; i < L; i++)
            for (let j = 0; j < L; j++)
                for (let k = 0; k < L; k++)
                    if (this.syndrome[i][j][k]) n++;
        return n;
    }

    getErrorCount() {
        let n = 0;
        const L = this.L;
        for (let i = 0; i < L; i++)
            for (let j = 0; j < L; j++)
                for (let k = 0; k < L; k++) {
                    if (this.qubitsA[i][j][k]) n++;
                    if (this.qubitsB[i][j][k]) n++;
                }
        return n;
    }

    getMemoryCount() {
        // Count sites with any active message channel
        let n = 0;
        const L = this.L;
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                site: for (let z = 0; z < L; z++)
                    for (let i = 0; i < 2; i++)
                        for (let j = 0; j < 2; j++)
                            for (let k = 0; k < 2; k++)
                                if (this.messages[x][y][z][i][j][k]) { n++; continue site; }
        return n;
    }

    hasMessages() {
        return this.getMemoryCount() > 0;
    }

    isQuiescent() {
        // The run's verdict depends on defects; residual messages do not delay it.
        return this.getSyndromeCount() === 0;
    }

    retryLogicalData() { return _haahLogicalData.retry(); }

    checkLogicalError() {
        if (this.getSyndromeCount() !== 0) return { hasError: false };
        const logicals = _haahLogicalsCache.get(this.L);
        if (!logicals) return missingLogicalDataResult(_haahLogicalData);
        const L = this.L, L3 = L * L * L, n = 2 * L3, nw = Math.ceil(n / 32);
        const ep = new Uint32Array(nw);
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    const s = x * L * L + y * L + z;
                    if (this.qubitsA[x][y][z]) ep[s >> 5] ^= (1 << (s & 31));
                    if (this.qubitsB[x][y][z]) { const i = L3 + s; ep[i >> 5] ^= (1 << (i & 31)); }
                }
        for (const row of logicals) {
            let parity = 0;
            for (let w = 0; w < nw; w++) {
                let v = row[w] & ep[w];
                v ^= v >> 16; v ^= v >> 8; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
                parity ^= v & 1;
            }
            if (parity) return { hasError: true, description: 'logical error' };
        }
        return { hasError: false };
    }

    // ── Manual error placement ─────────────────────────────────────────
    // (x, y) are pixel coords in _drawSlices()'s own coordinate system
    // (matches its cols/pad/labelH/cell geometry exactly). The shared
    // canvas handler gates this fallback when Three.js fails to load;
    // the 3D raycaster uses the same host predicate through its hook.
    // Left half of cell → q0 ball, right half → q1 ball.

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const L = this.L;
        const cols = Math.min(L, 4);
        const pad = 8, labelH = 15, statsH = 20;
        const totalW = canvasWidth - pad * 2;
        const totalH = canvasHeight - pad * 2 - statsH;
        const sliceW = Math.floor(totalW / cols);
        const sliceH = Math.floor(totalH / Math.ceil(L / cols));
        const cell = Math.max(6, Math.min(
            Math.floor((sliceW - 2) / L),
            Math.floor((sliceH - labelH - 2) / L)
        ));

        const col = Math.floor((x - pad) / sliceW);
        const row = Math.floor((y - pad) / sliceH);
        if (col < 0 || col >= cols || row < 0) return;
        const z = row * cols + col;
        if (z >= L) return;

        const ox = pad + col * sliceW;
        const oy = pad + row * sliceH + labelH;
        const lx = x - ox;
        const ly = y - oy;
        const gx = Math.floor(lx / cell);
        const gy = L - 1 - Math.floor(ly / cell);
        if (gx < 0 || gx >= L || gy < 0 || gy >= L) return;

        // Left half of cell → q0, right half → q1
        const cx_in_cell = lx - gx * cell;
        if (cx_in_cell < cell / 2) {
            this.qubitsA[gx][gy][z] = !this.qubitsA[gx][gy][z];
        } else {
            this.qubitsB[gx][gy][z] = !this.qubitsB[gx][gy][z];
        }
        this.calculateSyndrome();
        this._update3D();
    }

    // ── Cleanup ────────────────────────────────────────────────────────

    _disposeScene(scene) {
        const geometries = new Set(), materials = new Set();
        scene?.traverse(object => {
            if (object.geometry) geometries.add(object.geometry);
            if (object.material) materials.add(object.material);
            if (object.isInstancedMesh) object.dispose();
        });
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
    }

    dispose() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        this._disposeScene(this.scene);
        if (this.renderer) this.renderer.dispose();
        if (this.controls) this.controls.dispose();
        ['show-syndrome', 'show-errors', 'show-grid'].forEach(id => {
            document.getElementById(id)?.removeEventListener('change', this._displayChange);
        });

        const wrapper = document.getElementById('combined-view');
        if (wrapper) wrapper.remove();

        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = '';

        this.scene = null;
        this.renderer = null;
        this._threeContainer = null;
        this._threeWidth = 0;
        this._threeHeight = 0;
        this._threePixelRatio = 0;
        this.controls = null;
        this.is3DMode = false;
        this.synObjs = [];
        this.qubitMeshes = [];
        this.ghostQubitMeshes = [];
        this._qubitSites = [];
        this._ghostQubitSites = [];
        this._instanceTransform = null;
        this._displayChange = null;
        this.cleanLineSegs = null;
        this.outerLineSegs = null;
    }
}
