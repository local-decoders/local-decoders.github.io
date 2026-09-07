// X-cube lineon decoder with paired cross-direction fallback and Haah's host conventions.
import { XCubeStageDecoder, loadXCubeLogicals, DEFAULT_CLOCK_PERIOD } from './haah_stage.js';
export * from './haah_stage.js';

// Set false to restore the legacy independent cross-direction fallback flips.
export const LINEON_FALLBACK_REQUIRES_BOTH = true;

const logicalData = loadXCubeLogicals(new URL('../data/xcube_lineon_logicals.json', import.meta.url));

export class XCubeLineon2Decoder extends XCubeStageDecoder {
    constructor(L, clockPeriod = DEFAULT_CLOCK_PERIOD, opts = {}) {
        super(L, clockPeriod, opts, logicalData, true);
        // Per-instance override for rule comparisons: { fallbackRequiresBoth: false }.
        this.fallbackRequiresBoth = opts.fallbackRequiresBoth ?? LINEON_FALLBACK_REQUIRES_BOTH;
    }

    // From XCubeLineonNoWaitDecoder; only the fallback eligibility is configurable.

    calculateSyndrome() {
        const L = this.L;
        for (let i = 0; i < L; i++) {
            for (let j = 0; j < L; j++) {
                for (let k = 0; k < L; k++) {
                    const lx  = this.links[0][i][j][k];
                    const ly  = this.links[1][i][j][k];
                    const lz  = this.links[2][i][j][k];
                    const lxm = this.links[0][this.mod(i - 1)][j][k];
                    const lym = this.links[1][i][this.mod(j - 1)][k];
                    const lzm = this.links[2][i][j][this.mod(k - 1)];

                    const raw3 = lx ^ lxm ^ ly ^ lym;  // A_xy
                    const raw2 = lx ^ lxm ^ lz ^ lzm;  // A_xz
                    const raw1 = ly ^ lym ^ lz ^ lzm;  // A_yz

                    this.ell1[i][j][k] = raw2 && raw3;  // x-lineon
                    this.ell2[i][j][k] = raw1 && raw3;  // y-lineon
                    this.ell3[i][j][k] = raw1 && raw2;  // z-lineon

                    this.syndrome[i][j][k] = this.ell1[i][j][k] || this.ell2[i][j][k] || this.ell3[i][j][k];
                }
            }
        }
    }

    step(site = null) {
        this.calculateSyndrome();

        const L = this.L;
        const c = this.clock;
        const clock0 = (c === 0);

        // Trigger conditions
        const x_trig = this.create3DArray(L, false);
        const y_trig = this.create3DArray(L, false);
        const z_trig = this.create3DArray(L, false);

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    const xm = this.mod(x - 1);
                    const ym = this.mod(y - 1);
                    const zm = this.mod(z - 1);
                    x_trig[x][y][z] =
                        this.memory[1][0][0][xm][y][z] || this.memory[1][0][1][xm][y][z] ||
                        this.memory[1][1][0][xm][y][z] || this.memory[1][1][1][xm][y][z];
                    y_trig[x][y][z] =
                        this.memory[0][1][0][x][ym][z] || this.memory[0][1][1][x][ym][z] ||
                        this.memory[1][1][0][x][ym][z] || this.memory[1][1][1][x][ym][z];
                    z_trig[x][y][z] =
                        this.memory[0][0][1][x][y][zm] || this.memory[0][1][1][x][y][zm] ||
                        this.memory[1][0][1][x][y][zm] || this.memory[1][1][1][x][y][zm];
                }
            }
        }

        // PrimaryThenFallback → DoMove flags
        const do_x = this.create3DArray(L, false);
        const do_y = this.create3DArray(L, false);
        const do_z = this.create3DArray(L, false);

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    if (!this.syndrome[x][y][z]) continue;
                    const xt = x_trig[x][y][z];
                    const yt = y_trig[x][y][z];
                    const zt = z_trig[x][y][z];
                    const e1 = this.ell1[x][y][z];
                    const e2 = this.ell2[x][y][z];
                    const e3 = this.ell3[x][y][z];

                    if (e1) {
                        if (xt) { do_x[x][y][z] = true; }
                        else if (!this.fallbackRequiresBoth || (yt && zt)) {
                            if (yt) do_y[x][y][z] = true;
                            if (zt) do_z[x][y][z] = true;
                        }
                    }
                    if (e2 && !e1) {
                        if (yt) { do_y[x][y][z] = true; }
                        else if (!this.fallbackRequiresBoth || (xt && zt)) {
                            if (xt) do_x[x][y][z] = true;
                            if (zt) do_z[x][y][z] = true;
                        }
                    }
                    if (e3 && !e1 && !e2) {
                        if (zt) { do_z[x][y][z] = true; }
                        else if (!this.fallbackRequiresBoth || (xt && yt)) {
                            if (xt) do_x[x][y][z] = true;
                            if (yt) do_y[x][y][z] = true;
                        }
                    }
                }
            }
        }

        // DoMove: flip link at r - ê_a
        const flip_x = this.create3DArray(L, false);
        const flip_y = this.create3DArray(L, false);
        const flip_z = this.create3DArray(L, false);
        const s_in   = this.create3DArray(L, false);

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    flip_x[x][y][z] = do_x[(x + 1) % L][y][z];
                    flip_y[x][y][z] = do_y[x][(y + 1) % L][z];
                    flip_z[x][y][z] = do_z[x][y][(z + 1) % L];
                    s_in[x][y][z]   = flip_x[x][y][z] || flip_y[x][y][z] || flip_z[x][y][z];
                }
            }
        }

        // Precompute Toom-3D vote (using OLD m)
        const v_all = new Array(2).fill(null).map((_, ii) =>
            new Array(2).fill(null).map((_, jj) =>
                new Array(2).fill(null).map((_, kk) =>
                    this.create3DArray(L, false)
                )
            )
        );

        for (let ii = 0; ii < 2; ii++) {
            for (let jj = 0; jj < 2; jj++) {
                for (let kk = 0; kk < 2; kk++) {
                    for (let x = 0; x < L; x++) {
                        for (let y = 0; y < L; y++) {
                            for (let z = 0; z < L; z++) {
                                const xn = ii === 0 ? (x + 1) % L : this.mod(x - 1);
                                const yn = jj === 0 ? (y + 1) % L : this.mod(y - 1);
                                const zn = kk === 0 ? (z + 1) % L : this.mod(z - 1);
                                const cur = this.memory[ii][jj][kk][x][y][z]  ? 1 : 0;
                                const nbx = this.memory[ii][jj][kk][xn][y][z] ? 1 : 0;
                                const nby = this.memory[ii][jj][kk][x][yn][z] ? 1 : 0;
                                const nbz = this.memory[ii][jj][kk][x][y][zn] ? 1 : 0;
                                v_all[ii][jj][kk][x][y][z] = (cur + nbx + nby + nbz) >= 2;
                            }
                        }
                    }
                }
            }
        }

        // Build m_new from copy of old m
        const m_new = new Array(2).fill(null).map((_, ii) =>
            new Array(2).fill(null).map((_, jj) =>
                new Array(2).fill(null).map((_, kk) => {
                    const arr = this.create3DArray(L, false);
                    for (let x = 0; x < L; x++)
                        for (let y = 0; y < L; y++)
                            for (let z = 0; z < L; z++)
                                arr[x][y][z] = this.memory[ii][jj][kk][x][y][z];
                    return arr;
                })
            )
        );

        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    if (this.syndrome[x][y][z] || s_in[x][y][z]) {
                        for (let ii = 0; ii < 2; ii++)
                            for (let jj = 0; jj < 2; jj++)
                                for (let kk = 0; kk < 2; kk++)
                                    m_new[ii][jj][kk][x][y][z] = true;
                        continue;
                    }

                    const xm = this.mod(x - 1), xp = (x + 1) % L;
                    const ym = this.mod(y - 1), yp = (y + 1) % L;
                    const zm = this.mod(z - 1), zp = (z + 1) % L;

                    const m111_old = this.memory[1][1][1][x][y][z];
                    const v111     = v_all[1][1][1][x][y][z];
                    const coupled  = m111_old && v111;

                    for (let ii = 0; ii < 2; ii++) {
                        for (let jj = 0; jj < 2; jj++) {
                            for (let kk = 0; kk < 2; kk++) {
                                const cur_m = this.memory[ii][jj][kk][x][y][z];
                                if (!cur_m) {
                                    if (clock0) {
                                        const xn = ii === 0 ? xp : xm;
                                        const yn = jj === 0 ? yp : ym;
                                        const zn = kk === 0 ? zp : zm;
                                        if (this.memory[ii][jj][kk][xn][y][z] ||
                                            this.memory[ii][jj][kk][x][yn][z] ||
                                            this.memory[ii][jj][kk][x][y][zn]) {
                                            m_new[ii][jj][kk][x][y][z] = true;
                                        }
                                    }
                                } else {
                                    if (ii === 1 && jj === 1 && kk === 1) {
                                        m_new[1][1][1][x][y][z] = v111;
                                    } else {
                                        m_new[ii][jj][kk][x][y][z] = v_all[ii][jj][kk][x][y][z] || coupled;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Final S_in override
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++)
                    if (s_in[x][y][z])
                        for (let ii = 0; ii < 2; ii++)
                            for (let jj = 0; jj < 2; jj++)
                                for (let kk = 0; kk < 2; kk++)
                                    m_new[ii][jj][kk][x][y][z] = true;

        // Apply link flips
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    if (site && (x !== site[0] || y !== site[1] || z !== site[2])) continue;
                    if (flip_x[x][y][z]) this.links[0][x][y][z] = !this.links[0][x][y][z];
                    if (flip_y[x][y][z]) this.links[1][x][y][z] = !this.links[1][x][y][z];
                    if (flip_z[x][y][z]) this.links[2][x][y][z] = !this.links[2][x][y][z];
                }

        if (site) {
            const [x0, y0, z0] = site;
            for (let ii = 0; ii < 2; ii++)
                for (let jj = 0; jj < 2; jj++)
                    for (let kk = 0; kk < 2; kk++)
                        this.memory[ii][jj][kk][x0][y0][z0] = m_new[ii][jj][kk][x0][y0][z0];
        } else {
            this.memory = m_new;
        }
        this.calculateSyndrome();
        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;

        if (this.is3DMode) { this._update3D(); }
    }
}
