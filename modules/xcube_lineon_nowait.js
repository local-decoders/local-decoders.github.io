// X-Cube Lineon (No Wait) Decoder — combined 3D scatter + z-slice view
// Lineon types: ell1 = x-lineon (red), ell2 = y-lineon (green), ell3 = z-lineon (blue)
export class XCubeLineonNoWaitDecoder {
    constructor(L, clockPeriod = 10) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;

        this.links = [
            this._arr3(L, false),
            this._arr3(L, false),
            this._arr3(L, false)
        ];

        this.syndrome = this._arr3(L, false);
        this.ell1 = this._arr3(L, false);  // x-lineon (A_yz & A_xz violated)
        this.ell2 = this._arr3(L, false);  // y-lineon (A_yz & A_xy violated)
        this.ell3 = this._arr3(L, false);  // z-lineon (A_xz & A_xy violated)

        // m[i][j][k][x][y][z] — 8 message channels per site
        this.memory = this._arr6(L);

        // Three.js (lazy-loaded)
        this.THREE = null;
        this.OrbitControls = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.animationFrameId = null;
        this.synObjs = [];
        this.memObjs = [];
        this.edgeLineSegs  = null;
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap = [];
        this._hoveredSeg = -1;
        this.is3DMode = false;

        this.sliceCanvas = null;
        this.sliceCtx    = null;
        this.showMemoryField = null;
    }

    // ── Array helpers ──────────────────────────────────────────────────

    _arr3(L, fill = false) {
        return Array.from({ length: L }, () =>
            Array.from({ length: L }, () => new Array(L).fill(fill))
        );
    }

    _arr6(L) {
        return Array.from({ length: 2 }, () =>
            Array.from({ length: 2 }, () =>
                Array.from({ length: 2 }, () => this._arr3(L, false))
            )
        );
    }

    // Kept for backward compat inside step()
    create3DArray(size, fillValue) { return this._arr3(size, fillValue); }

    mod(n) { return ((n % this.L) + this.L) % this.L; }

    // ── Public API ─────────────────────────────────────────────────────

    initializeRandomErrors(p) {
        const L = this.L;
        for (let dir = 0; dir < 3; dir++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        this.links[dir][x][y][z] = Math.random() < p;
        this.memory = this._arr6(L);
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); this._refreshSlices(); }
    }

    initializeClear() {
        const L = this.L;
        for (let dir = 0; dir < 3; dir++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        this.links[dir][x][y][z] = false;
        this.memory = this._arr6(L);
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); this._refreshSlices(); }
    }

    toggleError(d, x, y, z) {
        const L = this.L;
        if (d < 0 || d > 2 || x < 0 || x >= L || y < 0 || y >= L || z < 0 || z >= L) return;
        this.links[d][x][y][z] ^= true;
        this.calculateSyndrome();
        if (this.is3DMode) { this._update3D(); this._refreshSlices(); }
    }

    // ── Syndrome ───────────────────────────────────────────────────────

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

    // ── CA Step ────────────────────────────────────────────────────────

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
                        else { if (yt) do_y[x][y][z] = true; if (zt) do_z[x][y][z] = true; }
                    }
                    if (e2 && !e1) {
                        if (yt) { do_y[x][y][z] = true; }
                        else { if (xt) do_x[x][y][z] = true; if (zt) do_z[x][y][z] = true; }
                    }
                    if (e3 && !e1 && !e2) {
                        if (zt) { do_z[x][y][z] = true; }
                        else { if (xt) do_x[x][y][z] = true; if (yt) do_y[x][y][z] = true; }
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

        if (this.is3DMode) { this._update3D(); this._refreshSlices(); }
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
        if (this.is3DMode) {
            this._refreshSlices(options);
            return;
        }
        this._drawSlices(ctx, width, height, options);
    }

    // ── z-slice drawing ────────────────────────────────────────────────
    // Colors: red = ell1 (x-lineon), green = ell2 (y-lineon), blue = ell3 (z-lineon)

    _drawSlices(ctx, width, height, options) {
        const L = this.L;
        options = options || { showSyndrome: true, showMessages: false, showGrid: true };
        const cols   = Math.min(L, 4);
        const rows   = Math.ceil(L / cols);
        const pad    = 8;
        const labelH = 15;
        const statsH = 20;

        const totalW = width  - pad * 2;
        const totalH = height - pad * 2 - statsH;
        const sliceW = Math.floor(totalW / cols);
        const sliceH = Math.floor(totalH / rows);
        const cell   = Math.max(1, Math.min(
            Math.floor((sliceW - 2) / L),
            Math.floor((sliceH - labelH - 2) / L)
        ));

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        for (let z = 0; z < L; z++) {
            const col = z % cols;
            const row = Math.floor(z / cols);
            const ox  = pad + col * sliceW;
            const oy  = pad + row * sliceH;

            ctx.fillStyle = '#64748b';
            ctx.font = '10px monospace';
            ctx.fillText(`z=${z}`, ox + 2, oy + 10);

            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    const px = ox + x * cell;
                    const py = oy + labelH + (L - 1 - y) * cell;  // y-up

                    const isSyn = options.showSyndrome && this.syndrome[x][y][z];
                    if (isSyn) {
                        if      (this.ell1[x][y][z]) ctx.fillStyle = 'rgb(220,60,60)';    // red
                        else if (this.ell2[x][y][z]) ctx.fillStyle = 'rgb(50,170,50)';    // green
                        else                          ctx.fillStyle = 'rgb(50,80,200)';    // blue
                    } else {
                        ctx.fillStyle = '#e8e8e8';
                    }
                    ctx.fillRect(px, py, cell, cell);

                    if (options.showMessages && this.showMemoryField) {
                        const [mi, mj, mk] = this.showMemoryField;
                        if (this.memory[mi][mj][mk][x][y][z]) {
                            ctx.fillStyle = 'rgba(220,160,20,0.45)';
                            ctx.fillRect(px, py, cell, cell);
                        }
                    }
                }
            }

            if (options.showGrid && cell >= 4) {
                ctx.strokeStyle = '#cbd5e1';
                ctx.lineWidth = 0.4;
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
        }

        ctx.fillStyle = '#64748b';
        ctx.font = '12px JetBrains Mono, monospace';
        ctx.fillText(
            `Step ${this.stepCount}  Clock ${this.clock}/${this.clockPeriod - 1}  Syn ${this.getSyndromeCount()}  Err ${this.getErrorCount()}  Mem ${this.getMemoryCount()}`,
            pad, height - 4
        );
    }

    _refreshSlices(options) {
        if (!this.sliceCanvas) return;
        const parent = this.sliceCanvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth  || 380;
        const h = parent.clientHeight || 580;
        if (this.sliceCanvas.width  !== w) this.sliceCanvas.width  = w;
        if (this.sliceCanvas.height !== h) this.sliceCanvas.height = h;
        if (!options) options = this._readOptions();
        this._drawSlices(this.sliceCtx, w, h, options);
    }

    _readOptions() {
        return {
            showSyndrome: document.getElementById('show-syndrome')?.checked  ?? true,
            showErrors:   document.getElementById('show-errors')?.checked    ?? true,
            showMessages: document.getElementById('show-messages')?.checked  ?? true,
            showGrid:     document.getElementById('show-grid')?.checked      ?? true,
        };
    }

    // ── Combined 3D + slice view ───────────────────────────────────────

    async enable3DMode() {
        if (this.is3DMode) return true;

        try {
            const T = await import('https://esm.sh/three@0.160.0');
            const { OrbitControls } = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
            this.THREE = T;
            this.OrbitControls = OrbitControls;
        } catch (e) {
            console.error('Three.js load failed:', e);
            return false;
        }

        const vizContainer = document.querySelector('.visualization-container');
        if (!vizContainer) return false;

        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = 'none';

        const wrapper = document.createElement('div');
        wrapper.id = 'combined-view';
        Object.assign(wrapper.style, {
            position: 'absolute', inset: '0',
            display: 'flex', gap: '10px', padding: '1rem', alignItems: 'stretch',
        });
        vizContainer.appendChild(wrapper);

        const threeDiv = document.createElement('div');
        threeDiv.id = 'three-left';
        Object.assign(threeDiv.style, {
            flex: '0 0 58%', borderRadius: '6px', overflow: 'hidden',
            background: '#f8fafc', border: '1px solid #e2e8f0', position: 'relative',
        });
        wrapper.appendChild(threeDiv);

        const sliceDiv = document.createElement('div');
        sliceDiv.id = 'slices-right';
        Object.assign(sliceDiv.style, {
            flex: '1', borderRadius: '6px', overflow: 'hidden',
            background: '#ffffff', border: '1px solid #e2e8f0', position: 'relative',
        });
        wrapper.appendChild(sliceDiv);

        this.sliceCanvas = document.createElement('canvas');
        this.sliceCanvas.style.display = 'block';
        sliceDiv.appendChild(this.sliceCanvas);
        this.sliceCtx = this.sliceCanvas.getContext('2d');

        await new Promise(r => requestAnimationFrame(r));
        this._initThree(threeDiv);
        this.is3DMode = true;

        ['show-syndrome', 'show-errors', 'show-grid', 'show-messages'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this._update3D();
                this._refreshSlices();
            });
        });

        requestAnimationFrame(() => {
            this._update3D();
            this._refreshSlices();
        });

        return true;
    }

    // ── Three.js scene setup ───────────────────────────────────────────

    _initThree(container) {
        const T = this.THREE;
        const L = this.L;
        const w = container.clientWidth  || 580;
        const h = container.clientHeight || 600;

        this.scene = new T.Scene();
        this.scene.background = new T.Color(0xf8fafc);

        this.camera = new T.PerspectiveCamera(50, w / h, 0.1, 1000);
        this.camera.position.set(L * 1.8, L * 1.4, L * 1.8);
        this.camera.lookAt(L / 2, L / 2, L / 2);

        this.renderer = new T.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.domElement.style.width  = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        this.controls = new this.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(L / 2, L / 2, L / 2);
        this.controls.enableDamping = true;

        this.scene.add(new T.AmbientLight(0xffffff, 0.6));
        const dl = new T.DirectionalLight(0xffffff, 0.5);
        dl.position.set(L, L * 2, L);
        this.scene.add(dl);

        // Axis labels
        for (const [lbl, pos] of [['X', [L + 1, 0, 0]], ['Y', [0, L + 1, 0]], ['Z', [0, 0, L + 1]]]) {
            const cv = document.createElement('canvas');
            cv.width = 128; cv.height = 64;
            const cx2 = cv.getContext('2d');
            cx2.font = 'bold 48px sans-serif';
            cx2.fillStyle = '#6b7280';
            cx2.textAlign = 'center'; cx2.textBaseline = 'middle';
            cx2.fillText(lbl, 64, 32);
            const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(cv) }));
            sp.scale.set(1, 0.5, 1);
            sp.position.set(...pos);
            this.scene.add(sp);
        }

        // Hover highlight
        this.renderer.domElement.addEventListener('mousemove', (evt) => {
            if (!this.edgeLineSegs) return;
            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new T.Vector2(
                ((evt.clientX - rect.left)  / rect.width)  * 2 - 1,
                -((evt.clientY - rect.top) / rect.height) * 2 + 1
            );
            const raycaster = new T.Raycaster();
            raycaster.params.Line = { threshold: 0.2 };
            raycaster.setFromCamera(mouse, this.camera);
            const hits = raycaster.intersectObject(this.edgeLineSegs);
            const newSeg = hits.length > 0 ? Math.floor(hits[0].index / 2) : -1;
            if (newSeg === this._hoveredSeg) return;
            this._hoveredSeg = newSeg;
            if (this.hoverLineSegs) { this.scene.remove(this.hoverLineSegs); this.hoverLineSegs = null; }
            if (newSeg >= 0 && newSeg < this.edgeMap.length) {
                const pa = this.edgeLineSegs.geometry.attributes.position;
                const hGeo = new T.BufferGeometry();
                hGeo.setAttribute('position', new T.Float32BufferAttribute([
                    pa.getX(newSeg * 2),     pa.getY(newSeg * 2),     pa.getZ(newSeg * 2),
                    pa.getX(newSeg * 2 + 1), pa.getY(newSeg * 2 + 1), pa.getZ(newSeg * 2 + 1),
                ], 3));
                this.hoverLineSegs = new T.LineSegments(hGeo,
                    new T.LineBasicMaterial({ color: 0xff6b6b }));
                this.scene.add(this.hoverLineSegs);
            }
        });

        // Manual error placement via raycasting
        let _mouseDownX = 0, _mouseDownY = 0;
        this.renderer.domElement.addEventListener('mousedown', (evt) => {
            _mouseDownX = evt.clientX; _mouseDownY = evt.clientY;
        });
        this.renderer.domElement.addEventListener('click', (evt) => {
            const modeEl = document.querySelector('input[name="init-mode"]:checked');
            if (!modeEl || modeEl.value !== 'manual') return;
            const dx = evt.clientX - _mouseDownX, dy = evt.clientY - _mouseDownY;
            if (Math.sqrt(dx * dx + dy * dy) > 4) return;
            if (!this.edgeLineSegs || !this.camera) return;
            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new T.Vector2(
                ((evt.clientX - rect.left) / rect.width)  * 2 - 1,
                -((evt.clientY - rect.top) / rect.height) * 2 + 1
            );
            const raycaster = new T.Raycaster();
            raycaster.params.Line = { threshold: 0.18 };
            raycaster.setFromCamera(mouse, this.camera);
            const hits = raycaster.intersectObject(this.edgeLineSegs);
            if (!hits.length) return;
            const edge = this.edgeMap[Math.floor(hits[0].index / 2)];
            if (edge) this.toggleError(edge.d, edge.x, edge.y, edge.z);
        });

        const _loop = () => {
            this.animationFrameId = requestAnimationFrame(_loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        _loop();
    }

    // ── 3D scene update ────────────────────────────────────────────────
    // Syndrome spheres colored by lineon type:
    //   ell1 (x-lineon) → red   0xcc2222
    //   ell2 (y-lineon) → green 0x22aa33
    //   ell3 (z-lineon) → blue  0x2244cc

    _update3D() {
        if (!this.scene) return;
        const T = this.THREE;
        const L = this.L;

        const opts         = this._readOptions();
        const showGrid     = opts.showGrid     ?? true;
        const showErrors   = opts.showErrors   ?? true;
        const showSyndrome = opts.showSyndrome ?? true;
        const showMessages = opts.showMessages ?? true;

        this.synObjs.forEach(o => this.scene.remove(o));
        this.memObjs.forEach(o => this.scene.remove(o));
        if (this.cleanLineSegs) this.scene.remove(this.cleanLineSegs);
        if (this.errLineSegs)   this.scene.remove(this.errLineSegs);
        if (this.hoverLineSegs) this.scene.remove(this.hoverLineSegs);
        this.synObjs = [];
        this.memObjs = [];
        this.edgeLineSegs  = null;
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap = [];
        this._hoveredSeg = -1;

        // Lattice edges
        const allPos = [], cleanPos = [], errPos = [];
        for (let d = 0; d < 3; d++) {
            const xMax = d === 0 ? L : L + 1;
            const yMax = d === 1 ? L : L + 1;
            const zMax = d === 2 ? L : L + 1;
            for (let x = 0; x < xMax; x++) {
                for (let y = 0; y < yMax; y++) {
                    for (let z = 0; z < zMax; z++) {
                        const lx = x % L, ly = y % L, lz = z % L;
                        const x2 = d === 0 ? x + 1 : x;
                        const y2 = d === 1 ? y + 1 : y;
                        const z2 = d === 2 ? z + 1 : z;
                        allPos.push(x, y, z, x2, y2, z2);
                        this.edgeMap.push({ d, x: lx, y: ly, z: lz });
                        if (this.links[d][lx][ly][lz])
                            errPos.push(x, y, z, x2, y2, z2);
                        else if (showGrid)
                            cleanPos.push(x, y, z, x2, y2, z2);
                    }
                }
            }
        }

        if (!showGrid) {
            cleanPos.push(
                0,0,0, L,0,0,   L,0,0, L,L,0,   L,L,0, 0,L,0,   0,L,0, 0,0,0,
                0,0,L, L,0,L,   L,0,L, L,L,L,   L,L,L, 0,L,L,   0,L,L, 0,0,L,
                0,0,0, 0,0,L,   L,0,0, L,0,L,   L,L,0, L,L,L,   0,L,0, 0,L,L
            );
        }

        const rayGeo = new T.BufferGeometry();
        rayGeo.setAttribute('position', new T.Float32BufferAttribute(allPos, 3));
        this.edgeLineSegs = new T.LineSegments(rayGeo, new T.LineBasicMaterial());

        if (cleanPos.length) {
            const cGeo = new T.BufferGeometry();
            cGeo.setAttribute('position', new T.Float32BufferAttribute(cleanPos, 3));
            this.cleanLineSegs = new T.LineSegments(cGeo,
                new T.LineBasicMaterial({ color: 0xb8c7e0 }));
            this.scene.add(this.cleanLineSegs);
        }

        if (showErrors && errPos.length) {
            const eGeo = new T.BufferGeometry();
            eGeo.setAttribute('position', new T.Float32BufferAttribute(errPos, 3));
            this.errLineSegs = new T.LineSegments(eGeo,
                new T.LineBasicMaterial({ color: 0xf01010 }));
            this.scene.add(this.errLineSegs);
        }

        // Syndrome spheres — colored by lineon type
        if (showSyndrome) {
            const sphereGeo = new T.SphereGeometry(0.22, 12, 12);
            const matEll1 = new T.MeshBasicMaterial({ color: 0xcc2222, transparent: true, opacity: 0.90 }); // red
            const matEll2 = new T.MeshBasicMaterial({ color: 0x22aa33, transparent: true, opacity: 0.90 }); // green
            const matEll3 = new T.MeshBasicMaterial({ color: 0x2244cc, transparent: true, opacity: 0.90 }); // blue

            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    for (let z = 0; z < L; z++) {
                        if (!this.syndrome[x][y][z]) continue;
                        const mat = this.ell1[x][y][z] ? matEll1
                                  : this.ell2[x][y][z] ? matEll2
                                  : matEll3;
                        const mesh = new T.Mesh(sphereGeo, mat);
                        mesh.position.set(x, y, z);
                        this.scene.add(mesh);
                        this.synObjs.push(mesh);
                    }
                }
            }
        }

        // Memory field overlay
        if (showMessages && this.showMemoryField) {
            const [mi, mj, mk] = this.showMemoryField;
            const cubeGeo = new T.BoxGeometry(0.2, 0.2, 0.2);
            const mat = new T.MeshPhongMaterial({ color: 0xdc9614, transparent: true, opacity: 0.45 });
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        if (this.memory[mi][mj][mk][x][y][z]) {
                            const mesh = new T.Mesh(cubeGeo, mat);
                            mesh.position.set(x, y, z);
                            this.scene.add(mesh);
                            this.memObjs.push(mesh);
                        }
        }
    }

    // ── Stats ──────────────────────────────────────────────────────────

    getSyndromeCount() {
        let n = 0;
        const L = this.L;
        for (let x = 0; x < L; x++)
            for (let y = 0; y < L; y++)
                for (let z = 0; z < L; z++)
                    if (this.syndrome[x][y][z]) n++;
        return n;
    }

    getErrorCount() {
        let n = 0;
        const L = this.L;
        for (let d = 0; d < 3; d++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        if (this.links[d][x][y][z]) n++;
        return n;
    }

    getMemoryCount() {
        let n = 0;
        const L = this.L;
        for (let mi = 0; mi < 2; mi++)
            for (let mj = 0; mj < 2; mj++)
                for (let mk = 0; mk < 2; mk++)
                    for (let x = 0; x < L; x++)
                        for (let y = 0; y < L; y++)
                            for (let z = 0; z < L; z++)
                                if (this.memory[mi][mj][mk][x][y][z]) n++;
        return n;
    }

    isConverged() {
        return this.getSyndromeCount() === 0 && this.getMemoryCount() === 0;
    }

    hasMessages() {
        return this.getMemoryCount() > 0;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        if (this.getSyndromeCount() !== 0) return { hasError: false };
        const L = this.L;
        const lx = this.links[0], ly = this.links[1], lz = this.links[2];
        // xy plane: XOR lx[1][y][z] over y
        for (let z = 0; z < L; z++) {
            let p = false;
            for (let y = 0; y < L; y++) p ^= lx[1][y][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xy plane: XOR ly[x][1][z] over x
        for (let z = 0; z < L; z++) {
            let p = false;
            for (let x = 0; x < L; x++) p ^= ly[x][1][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xz plane: XOR lx[1][y][z] over z
        for (let y = 0; y < L; y++) {
            let p = false;
            for (let z = 0; z < L; z++) p ^= lx[1][y][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xz plane: XOR lz[x][y][1] over x
        for (let y = 0; y < L; y++) {
            let p = false;
            for (let x = 0; x < L; x++) p ^= lz[x][y][1];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // yz plane: XOR ly[x][1][z] over z
        for (let x = 0; x < L; x++) {
            let p = false;
            for (let z = 0; z < L; z++) p ^= ly[x][1][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // yz plane: XOR lz[x][y][1] over y
        for (let x = 0; x < L; x++) {
            let p = false;
            for (let y = 0; y < L; y++) p ^= lz[x][y][1];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        return { hasError: false };
    }

    // ── Manual error placement (2D-only mode) ──────────────────────────

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight, dir) {
        if (this.is3DMode) return;
        dir = dir ?? 0;
        const L = this.L;
        const cols   = Math.min(L, 4);
        const pad    = 8, labelH = 15, statsH = 20;
        const sliceW = Math.floor((canvasWidth - pad * 2) / cols);
        const sliceH = Math.floor((canvasHeight - pad * 2 - statsH) / Math.ceil(L / cols));
        const cell   = Math.max(1, Math.min(
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
        const gx = Math.floor((x - ox) / cell);
        const gy = L - 1 - Math.floor((y - oy) / cell);
        if (gx < 0 || gx >= L || gy < 0 || gy >= L) return;
        this.toggleError(dir, gx, gy, z);
    }

    // ── Cleanup ────────────────────────────────────────────────────────

    dispose() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        if (this.renderer) this.renderer.dispose();
        if (this.controls) this.controls.dispose();

        const wrapper = document.getElementById('combined-view');
        if (wrapper) wrapper.remove();

        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = '';

        this.sliceCanvas = null;
        this.sliceCtx    = null;
        this.scene       = null;
        this.renderer    = null;
        this.controls    = null;
        this.is3DMode    = false;
        this.synObjs       = [];
        this.memObjs       = [];
        this.edgeLineSegs  = null;
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap       = [];
    }
}
