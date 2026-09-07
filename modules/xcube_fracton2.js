// X-cube fracton decoder with the legacy CA rule and Haah's host conventions.
import { XCubeStageDecoder, loadXCubeLogicals, DEFAULT_CLOCK_PERIOD } from './haah_stage.js';
export * from './haah_stage.js';

const logicalData = loadXCubeLogicals(new URL('../data/xcube_fracton_logicals.json', import.meta.url));

export class XCubeFracton2Decoder extends XCubeStageDecoder {
    constructor(L, clockPeriod = DEFAULT_CLOCK_PERIOD, opts = {}) {
        super(L, clockPeriod, opts, logicalData, false);
    }

    // Copied from XCubeFractonDecoder; preserve rule ordering and values exactly.

    _copyMem(m) {
        const L = this.L;
        const out = this._arr6(L);
        for (let mi = 0; mi < 2; mi++)
            for (let mj = 0; mj < 2; mj++)
                for (let mk = 0; mk < 2; mk++)
                    for (let x = 0; x < L; x++)
                        for (let y = 0; y < L; y++)
                            for (let z = 0; z < L; z++)
                                out[mi][mj][mk][x][y][z] = m[mi][mj][mk][x][y][z];
        return out;
    }

    calculateSyndrome() {
        const L = this.L;
        const lx = this.links[0], ly = this.links[1], lz = this.links[2];
        for (let x = 0; x < L; x++) {
            const xp = (x + 1) % L;
            for (let y = 0; y < L; y++) {
                const yp = (y + 1) % L;
                for (let z = 0; z < L; z++) {
                    const zp = (z + 1) % L;
                    let p = 0;
                    p ^= lx[x][y][z] ? 1 : 0;
                    p ^= lx[x][yp][z] ? 1 : 0;
                    p ^= lx[x][y][zp] ? 1 : 0;
                    p ^= lx[x][yp][zp] ? 1 : 0;
                    p ^= ly[x][y][z] ? 1 : 0;
                    p ^= ly[xp][y][z] ? 1 : 0;
                    p ^= ly[x][y][zp] ? 1 : 0;
                    p ^= ly[xp][y][zp] ? 1 : 0;
                    p ^= lz[x][y][z] ? 1 : 0;
                    p ^= lz[xp][y][z] ? 1 : 0;
                    p ^= lz[x][yp][z] ? 1 : 0;
                    p ^= lz[xp][yp][z] ? 1 : 0;
                    this.syndrome[x][y][z] = (p === 1);
                }
            }
        }
    }

    step(site = null) {
        const L = this.L;
        const m = this.memory;
        const syn = this.syndrome;
        const clock0 = (this.clock === 0);
        const newM = this._copyMem(m);

        // 1. Syndrome sites → all m_ijk = 1
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++)
                    if (syn[x][y][z])
                        for (let mi = 0; mi < 2; mi++)
                            for (let mj = 0; mj < 2; mj++)
                                for (let mk = 0; mk < 2; mk++)
                                    newM[mi][mj][mk][x][y][z] = true;

        // 2. Moves: compute do_z/do_y/do_x from OLD memory
        const do_z = this._arr3(L, false);
        const do_y = this._arr3(L, false);
        const do_x = this._arr3(L, false);
        for (let x = 0; x < L; x++) {
            const xm = (x - 1 + L) % L;
            for (let y = 0; y < L; y++) {
                const ym = (y - 1 + L) % L;
                for (let z = 0; z < L; z++) {
                    if (!syn[x][y][z]) continue;
                    const zm = (z - 1 + L) % L;
                    const zt = m[1][1][0][xm][ym][z] || m[1][1][1][xm][ym][z];
                    const yt = m[1][0][1][xm][y][zm] || m[1][1][1][xm][y][zm];
                    const xt = m[0][1][1][x][ym][zm] || m[1][1][1][x][ym][zm];
                    if (zt) do_z[x][y][z] = true;
                    else if (yt) do_y[x][y][z] = true;
                    else if (xt) do_x[x][y][z] = true;
                }
            }
        }

        // 3. Incoming: neighbors of movers
        const is_in = this._arr3(L, false);
        for (let x = 0; x < L; x++) {
            const xp = (x + 1) % L;
            for (let y = 0; y < L; y++) {
                const yp = (y + 1) % L;
                for (let z = 0; z < L; z++) {
                    if (syn[x][y][z]) continue;
                    const zp = (z + 1) % L;
                    const in_z = do_z[xp][y][z] || do_z[x][yp][z] || do_z[xp][yp][z];
                    const in_y = do_y[xp][y][z] || do_y[x][y][zp] || do_y[xp][y][zp];
                    const in_x = do_x[x][yp][z] || do_x[x][y][zp] || do_x[x][yp][zp];
                    if (in_z || in_y || in_x) {
                        is_in[x][y][z] = true;
                        for (let mi = 0; mi < 2; mi++)
                            for (let mj = 0; mj < 2; mj++)
                                for (let mk = 0; mk < 2; mk++)
                                    newM[mi][mj][mk][x][y][z] = true;
                    }
                }
            }
        }

        // 4. Precompute v111 and coupled from OLD m[1][1][1]
        const v111 = this._arr3(L, false);
        const coupled = this._arr3(L, false);
        for (let x = 0; x < L; x++) {
            const xm = (x - 1 + L) % L;
            for (let y = 0; y < L; y++) {
                const ym = (y - 1 + L) % L;
                for (let z = 0; z < L; z++) {
                    const zm = (z - 1 + L) % L;
                    const tot = (m[1][1][1][x][y][z] ? 1 : 0)
                        + (m[1][1][1][xm][y][z] ? 1 : 0)
                        + (m[1][1][1][x][ym][z] ? 1 : 0)
                        + (m[1][1][1][x][y][zm] ? 1 : 0);
                    v111[x][y][z] = tot >= 2;
                    coupled[x][y][z] = m[1][1][1][x][y][z] && v111[x][y][z];
                }
            }
        }

        // 5. Spreading pass (clock==0): rest sites, m=0, directed neighbor active
        if (clock0) {
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++) {
                        if (syn[x][y][z] || is_in[x][y][z]) continue;
                        for (let mi = 0; mi < 2; mi++) {
                            const nx = mi === 0 ? (x + 1) % L : (x - 1 + L) % L;
                            for (let mj = 0; mj < 2; mj++) {
                                const ny = mj === 0 ? (y + 1) % L : (y - 1 + L) % L;
                                for (let mk = 0; mk < 2; mk++) {
                                    if (m[mi][mj][mk][x][y][z]) continue;
                                    const nz = mk === 0 ? (z + 1) % L : (z - 1 + L) % L;
                                    if (m[mi][mj][mk][nx][y][z] ||
                                        m[mi][mj][mk][x][ny][z] ||
                                        m[mi][mj][mk][x][y][nz]) {
                                        newM[mi][mj][mk][x][y][z] = true;
                                    }
                                }
                            }
                        }
                    }
        }

        // 6. Decay pass: rest sites
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    if (syn[x][y][z] || is_in[x][y][z]) continue;

                    // m[1][1][1] special decay
                    {
                        const old = m[1][1][1][x][y][z];
                        const g = newM[1][1][1][x][y][z] && !old;
                        newM[1][1][1][x][y][z] = g || (old && v111[x][y][z]);
                    }

                    // Non-111 decay + failsafe
                    const cp = coupled[x][y][z];
                    for (let mi = 0; mi < 2; mi++) {
                        const nx = mi === 0 ? (x + 1) % L : (x - 1 + L) % L;
                        for (let mj = 0; mj < 2; mj++) {
                            const ny = mj === 0 ? (y + 1) % L : (y - 1 + L) % L;
                            for (let mk = 0; mk < 2; mk++) {
                                if (mi === 1 && mj === 1 && mk === 1) continue;
                                const nz = mk === 0 ? (z + 1) % L : (z - 1 + L) % L;
                                const old = m[mi][mj][mk][x][y][z];
                                const nbx = m[mi][mj][mk][nx][y][z] ? 1 : 0;
                                const nby = m[mi][mj][mk][x][ny][z] ? 1 : 0;
                                const nbz = m[mi][mj][mk][x][y][nz] ? 1 : 0;
                                const hnb = (old ? 1 : 0) + nbx + nby + nbz >= 2;
                                const g = newM[mi][mj][mk][x][y][z] && !old;
                                newM[mi][mj][mk][x][y][z] = g || (old && hnb) || (cp && (old || g));
                            }
                        }
                    }
                }

        // 7. Link flips
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    if (site && (x !== site[0] || y !== site[1] || z !== site[2])) continue;
                    if (do_x[x][y][z]) this.links[0][x][y][z] ^= true;
                    if (do_y[x][y][z]) this.links[1][x][y][z] ^= true;
                    if (do_z[x][y][z]) this.links[2][x][y][z] ^= true;
                }

        // 8. Recompute syndrome
        this.calculateSyndrome();

        // 9. Incoming override (applied last, as in Python)
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++) {
                    if (site && (x !== site[0] || y !== site[1] || z !== site[2])) continue;
                    if (is_in[x][y][z])
                        for (let mi = 0; mi < 2; mi++)
                            for (let mj = 0; mj < 2; mj++)
                                for (let mk = 0; mk < 2; mk++)
                                    newM[mi][mj][mk][x][y][z] = true;
                }

        if (site) {
            const [x0, y0, z0] = site;
            for (let mi = 0; mi < 2; mi++)
                for (let mj = 0; mj < 2; mj++)
                    for (let mk = 0; mk < 2; mk++)
                        this.memory[mi][mj][mk][x0][y0][z0] = newM[mi][mj][mk][x0][y0][z0];
        } else {
            this.memory = newM;
        }
        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;

        if (this.is3DMode) {
            this._update3D();
        }
    }
}
