// X-Cube Fracton Decoder — combined 3D scatter + z-slice view matching the Python notebook
// Pipeline: CA step → _update3D (Three.js left panel) + _drawSlices (canvas right panel)

export class XCubeFractonDecoder {
    constructor(L, clockPeriod = 10) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;

        // links[dir][x][y][z]  dir: 0=x-edges, 1=y-edges, 2=z-edges
        this.links = [
            this._arr3(L, false),
            this._arr3(L, false),
            this._arr3(L, false),
        ];
        // syndrome[x][y][z]
        this.syndrome = this._arr3(L, false);
        // memory[mi][mj][mk][x][y][z]
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
        this.edgeLineSegs  = null;  // off-scene raycasting target only (never added to scene)
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap = [];          // edgeMap[segmentIndex] = {d, x, y, z}
        this._hoveredSeg = -1;
        this.is3DMode = false;

        // Slice canvas (right panel in combined view)
        this.sliceCanvas = null;
        this.sliceCtx = null;

        // Which memory field to overlay: null | [mi,mj,mk]
        this.showMemoryField = null;
    }

    // ── Array helpers ─────────────────────────────────────────────────

    _arr3(L, fill) {
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

    // ── Public API ────────────────────────────────────────────────────

    initializeRandomErrors(p) {
        const L = this.L;
        for (let d = 0; d < 3; d++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        this.links[d][x][y][z] = Math.random() < p;
        this.memory = this._arr6(L);
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
        if (this.is3DMode) {
            this._update3D();
            this._refreshSlices();
        }
    }

    initializeClear() {
        const L = this.L;
        for (let d = 0; d < 3; d++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        this.links[d][x][y][z] = false;
        this.memory = this._arr6(L);
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
        if (this.is3DMode) {
            this._update3D();
            this._refreshSlices();
        }
    }

    // Toggle a specific link and recalculate syndrome
    toggleError(d, x, y, z) {
        const L = this.L;
        if (d < 0 || d > 2 || x < 0 || x >= L || y < 0 || y >= L || z < 0 || z >= L) return;
        this.links[d][x][y][z] ^= true;
        this.calculateSyndrome();
        if (this.is3DMode) {
            this._update3D();
            this._refreshSlices();
        }
    }

    // ── Syndrome (matches Python cube_stabilizers) ────────────────────

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

    // ── CA Step (matches Python step_ca exactly) ──────────────────────

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
            this._refreshSlices();
        }
    }

    stepUncoord() {
        const L = this.L;
        this.step([
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L)
        ]);
    }

    // ── render() — called by main.js ──────────────────────────────────
    // In combined mode: draw slices on the right-panel canvas.
    // In 2D-only mode: draw the full slice grid on the provided ctx.

    render(ctx, width, height, options) {
        if (this.is3DMode) {
            this._refreshSlices(options);
            return;
        }
        this._drawSlices(ctx, width, height, options);
    }

    // ── z-slice drawing ───────────────────────────────────────────────
    // Shows fracton (cube stabilizer violation) sites per z-slice.
    // x→right, y→up, arranged in min(L,4) columns.

    _drawSlices(ctx, width, height, options) {
        const L = this.L;
        options = options || { showSyndrome: true, showMessages: false, showGrid: true };
        const cols = Math.min(L, 4);
        const rows = Math.ceil(L / cols);
        const pad = 8;
        const labelH = 15;
        const statsH = 20;

        const totalW = width - pad * 2;
        const totalH = height - pad * 2 - statsH;
        const sliceW = Math.floor(totalW / cols);
        const sliceH = Math.floor(totalH / rows);
        const cell = Math.max(1, Math.min(
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
            ctx.font = '10px monospace';
            ctx.fillText(`z=${z}`, ox + 2, oy + 10);

            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    const px = ox + x * cell;
                    const py = oy + labelH + (L - 1 - y) * cell;  // y-up

                    const isSyn = options.showSyndrome && this.syndrome[x][y][z];
                    ctx.fillStyle = isSyn ? '#7BA7CC' : '#e8e8e8';
                    ctx.fillRect(px, py, cell, cell);

                    if (options.showMessages && this.showMemoryField) {
                        const [mi, mj, mk] = this.showMemoryField;
                        if (this.memory[mi][mj][mk][x][y][z]) {
                            ctx.fillStyle = 'rgba(220,80,80,0.45)';
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

    // Resize slice canvas to its container and redraw
    _refreshSlices(options) {
        if (!this.sliceCanvas) return;
        const parent = this.sliceCanvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth || 380;
        const h = parent.clientHeight || 580;
        if (this.sliceCanvas.width !== w) this.sliceCanvas.width = w;
        if (this.sliceCanvas.height !== h) this.sliceCanvas.height = h;
        if (!options) options = this._readOptions();
        this._drawSlices(this.sliceCtx, w, h, options);
    }

    _readOptions() {
        return {
            showSyndrome: document.getElementById('show-syndrome')?.checked ?? true,
            showErrors: document.getElementById('show-errors')?.checked ?? true,
            showMessages: document.getElementById('show-messages')?.checked ?? true,
            showGrid: document.getElementById('show-grid')?.checked ?? true,
        };
    }

    // ── Combined 3D + slice view ──────────────────────────────────────

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

        // Hide main canvas — combined view replaces it
        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = 'none';

        // ── Outer flex wrapper ──
        const wrapper = document.createElement('div');
        wrapper.id = 'combined-view';
        Object.assign(wrapper.style, {
            position: 'absolute',
            inset: '0',
            display: 'flex',
            gap: '10px',
            padding: '1rem',
            alignItems: 'stretch',
        });
        vizContainer.appendChild(wrapper);

        // ── Left panel: Three.js ────────────────────────────────────
        const threeDiv = document.createElement('div');
        threeDiv.id = 'three-left';
        Object.assign(threeDiv.style, {
            flex: '0 0 58%',
            borderRadius: '6px',
            overflow: 'hidden',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            position: 'relative',
        });
        wrapper.appendChild(threeDiv);

        // ── Right panel: z-slice canvas ─────────────────────────────
        const sliceDiv = document.createElement('div');
        sliceDiv.id = 'slices-right';
        Object.assign(sliceDiv.style, {
            flex: '1',
            borderRadius: '6px',
            overflow: 'hidden',
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            position: 'relative',
        });
        wrapper.appendChild(sliceDiv);

        this.sliceCanvas = document.createElement('canvas');
        this.sliceCanvas.style.display = 'block';
        sliceDiv.appendChild(this.sliceCanvas);
        this.sliceCtx = this.sliceCanvas.getContext('2d');

        // ── Init Three.js after one frame ──
        await new Promise(r => requestAnimationFrame(r));
        this._initThree(threeDiv);
        this.is3DMode = true;

        // Wire display-option checkboxes to refresh the 3D view
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

    // ── Three.js scene setup ──────────────────────────────────────────

    _initThree(container) {
        const T = this.THREE;
        const L = this.L;
        const w = container.clientWidth || 580;
        const h = container.clientHeight || 600;

        this.scene = new T.Scene();
        this.scene.background = new T.Color(0xf8fafc);

        this.camera = new T.PerspectiveCamera(50, w / h, 0.1, 1000);
        this.camera.position.set(L * 1.8, L * 1.4, L * 1.8);
        this.camera.lookAt(L / 2, L / 2, L / 2);

        this.renderer = new T.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        this.controls = new this.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(L / 2, L / 2, L / 2);
        this.controls.enableDamping = true;

        // Lights
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

        // ── Hover highlight ───────────────────────────────────────────
        this.renderer.domElement.addEventListener('mousemove', (evt) => {
            if (!this.edgeLineSegs) return;
            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new T.Vector2(
                ((evt.clientX - rect.left) / rect.width) * 2 - 1,
                -((evt.clientY - rect.top) / rect.height) * 2 + 1
            );
            const raycaster = new T.Raycaster();
            raycaster.params.Line = { threshold: 0.2 };
            raycaster.setFromCamera(mouse, this.camera);
            const hits = raycaster.intersectObject(this.edgeLineSegs);
            const newSeg = hits.length > 0 ? Math.floor(hits[0].index / 2) : -1;
            if (newSeg === this._hoveredSeg) return;
            this._hoveredSeg = newSeg;

            // Remove previous hover overlay
            if (this.hoverLineSegs) {
                this.scene.remove(this.hoverLineSegs);
                this.hoverLineSegs = null;
            }

            // Draw a bright overlay on the hovered edge
            if (newSeg >= 0 && newSeg < this.edgeMap.length) {
                const pa = this.edgeLineSegs.geometry.attributes.position;
                const hGeo = new T.BufferGeometry();
                hGeo.setAttribute('position', new T.Float32BufferAttribute([
                    pa.getX(newSeg * 2),     pa.getY(newSeg * 2),     pa.getZ(newSeg * 2),
                    pa.getX(newSeg * 2 + 1), pa.getY(newSeg * 2 + 1), pa.getZ(newSeg * 2 + 1),
                ], 3));
                const e = this.edgeMap[newSeg];
                const isErr = e && this.links[e.d][e.x][e.y][e.z];
                this.hoverLineSegs = new T.LineSegments(hGeo,
                    new T.LineBasicMaterial({ color: isErr ? 0xff6b6b : 0xff6b6b }));
                this.scene.add(this.hoverLineSegs);
            }
        });

        // ── Manual error placement via raycasting ─────────────────────
        // Track mousedown position to distinguish clicks from orbit drags.
        let _mouseDownX = 0, _mouseDownY = 0;
        this.renderer.domElement.addEventListener('mousedown', (evt) => {
            _mouseDownX = evt.clientX;
            _mouseDownY = evt.clientY;
        });

        this.renderer.domElement.addEventListener('click', (evt) => {
            const modeEl = document.querySelector('input[name="init-mode"]:checked');
            if (!modeEl || modeEl.value !== 'manual') return;
            // Ignore if this was actually a drag (orbit rotation)
            const dx = evt.clientX - _mouseDownX;
            const dy = evt.clientY - _mouseDownY;
            if (Math.sqrt(dx * dx + dy * dy) > 4) return;
            if (!this.edgeLineSegs || !this.camera) return;

            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new T.Vector2(
                ((evt.clientX - rect.left) / rect.width) * 2 - 1,
                -((evt.clientY - rect.top) / rect.height) * 2 + 1
            );
            const raycaster = new T.Raycaster();
            raycaster.params.Line = { threshold: 0.18 };
            raycaster.setFromCamera(mouse, this.camera);

            const hits = raycaster.intersectObject(this.edgeLineSegs);
            if (hits.length === 0) return;

            // intersect.index is the first vertex index of the hit segment
            const segIdx = Math.floor(hits[0].index / 2);
            const edge = this.edgeMap[segIdx];
            if (!edge) return;
            this.toggleError(edge.d, edge.x, edge.y, edge.z);
        });

        const _loop = () => {
            this.animationFrameId = requestAnimationFrame(_loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        _loop();
    }

    // ── Coolwarm colormap (matches matplotlib) ────────────────────────
    // t=0 → blue (#3B4CC0), t=0.5 → near-white (#DDDCDC), t=1 → red (#B40426)

    _coolwarm(t) {
        let r, g, b;
        if (t <= 0.5) {
            const s = t * 2;
            r = Math.round(59 + (221 - 59) * s);
            g = Math.round(76 + (220 - 76) * s);
            b = Math.round(192 + (220 - 192) * s);
        } else {
            const s = (t - 0.5) * 2;
            r = Math.round(221 + (180 - 221) * s);
            g = Math.round(220 + (4 - 220) * s);
            b = Math.round(220 + (38 - 220) * s);
        }
        return (r << 16) | (g << 8) | b;
    }

    // ── 3D scene update ───────────────────────────────────────────────

    _update3D() {
        if (!this.scene) return;
        const T = this.THREE;
        const L = this.L;

        const opts         = this._readOptions();
        const showGrid     = opts.showGrid     ?? true;
        const showErrors   = opts.showErrors   ?? true;
        const showSyndrome = opts.showSyndrome ?? true;
        const showMessages = opts.showMessages ?? true;

        // Clear dynamic objects
        this.synObjs.forEach(o => this.scene.remove(o));
        this.memObjs.forEach(o => this.scene.remove(o));
        if (this.cleanLineSegs) this.scene.remove(this.cleanLineSegs);
        if (this.errLineSegs)   this.scene.remove(this.errLineSegs);
        if (this.hoverLineSegs) this.scene.remove(this.hoverLineSegs);
        this.synObjs = [];
        this.memObjs = [];
        this.edgeLineSegs  = null;  // not in scene, just nulled
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap = [];
        this._hoveredSeg = -1;

        // ── Lattice edges ─────────────────────────────────────────────
        // allPos    : full geometry, invisible raycasting target (always built)
        // cleanPos  : non-error edges shown when showGrid is true,
        //             or just the 12 outer bbox edges when showGrid is false
        // errPos    : error edges, shown only when showErrors is true
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

        // When grid is hidden, show only the 12 outer bounding-box edges
        if (!showGrid) {
            cleanPos.push(
                0,0,0, L,0,0,   L,0,0, L,L,0,   L,L,0, 0,L,0,   0,L,0, 0,0,0,  // bottom
                0,0,L, L,0,L,   L,0,L, L,L,L,   L,L,L, 0,L,L,   0,L,L, 0,0,L,  // top
                0,0,0, 0,0,L,   L,0,0, L,0,L,   L,L,0, L,L,L,   0,L,0, 0,L,L   // verticals
            );
        }

        // Raycasting target — full geometry, never added to scene (no rendering artifacts)
        const rayGeo = new T.BufferGeometry();
        rayGeo.setAttribute('position', new T.Float32BufferAttribute(allPos, 3));
        this.edgeLineSegs = new T.LineSegments(rayGeo, new T.LineBasicMaterial());

        // Clean / bbox edges: white, semi-transparent
        if (cleanPos.length) {
            const cGeo = new T.BufferGeometry();
            cGeo.setAttribute('position', new T.Float32BufferAttribute(cleanPos, 3));
            this.cleanLineSegs = new T.LineSegments(cGeo,
                new T.LineBasicMaterial({ color: 0xb8c7e0 }));
            this.scene.add(this.cleanLineSegs);
        }

        // Error edges: red, fully opaque (only when showErrors)
        if (showErrors && errPos.length) {
            const eGeo = new T.BufferGeometry();
            eGeo.setAttribute('position', new T.Float32BufferAttribute(errPos, 3));
            this.errLineSegs = new T.LineSegments(eGeo,
                new T.LineBasicMaterial({ color: 0xf01010 }));
            this.scene.add(this.errLineSegs);
        }

        // ── Syndrome spheres ──────────────────────────────────────────
        if (showSyndrome) {
            const sphereGeo = new T.SphereGeometry(0.22, 32, 32);
            const synMat = new T.MeshBasicMaterial({
                color: 0x6495ED, transparent: true, opacity: 0.90,
            });
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        if (this.syndrome[x][y][z]) {
                            const mesh = new T.Mesh(sphereGeo, synMat);
                            mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
                            this.scene.add(mesh);
                            this.synObjs.push(mesh);
                        }
        }

        // ── Memory field overlay ──────────────────────────────────────
        if (showMessages && this.showMemoryField) {
            const [mi, mj, mk] = this.showMemoryField;
            const cubeGeo = new T.BoxGeometry(0.2, 0.2, 0.2);
            const mat = new T.MeshPhongMaterial({ color: 0xdc2626, transparent: true, opacity: 0.45 });
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        if (this.memory[mi][mj][mk][x][y][z]) {
                            const mesh = new T.Mesh(cubeGeo, mat);
                            mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
                            this.scene.add(mesh);
                            this.memObjs.push(mesh);
                        }
        }
    }

    // ── Stats ─────────────────────────────────────────────────────────

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
        // xy plane: XOR lx[x][1][z] over x
        for (let z = 0; z < L; z++) {
            let p = false;
            for (let x = 0; x < L; x++) p ^= lx[x][1][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xy plane: XOR ly[1][y][z] over y
        for (let z = 0; z < L; z++) {
            let p = false;
            for (let y = 0; y < L; y++) p ^= ly[1][y][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xz plane: XOR lx[x][y][1] over x
        for (let y = 0; y < L; y++) {
            let p = false;
            for (let x = 0; x < L; x++) p ^= lx[x][y][1];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // xz plane: XOR lz[1][y][z] over z
        for (let y = 0; y < L; y++) {
            let p = false;
            for (let z = 0; z < L; z++) p ^= lz[1][y][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // yz plane: XOR ly[x][y][1] over y
        for (let x = 0; x < L; x++) {
            let p = false;
            for (let y = 0; y < L; y++) p ^= ly[x][y][1];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        // yz plane: XOR lz[x][1][z] over z
        for (let x = 0; x < L; x++) {
            let p = false;
            for (let z = 0; z < L; z++) p ^= lz[x][1][z];
            if (p) return { hasError: true, description: 'Logical Error' };
        }
        return { hasError: false };
    }

    // ── Manual error placement (2D-only mode) ─────────────────────────

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight, dir) {
        if (this.is3DMode) return;
        dir = dir ?? 0;
        const L = this.L;
        const cols = Math.min(L, 4);
        const pad = 8, labelH = 15, statsH = 20;
        const sliceW = Math.floor((canvasWidth - pad * 2) / cols);
        const sliceH = Math.floor((canvasHeight - pad * 2 - statsH) / Math.ceil(L / cols));
        const cell = Math.max(1, Math.min(
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

    // ── Cleanup ───────────────────────────────────────────────────────

    dispose() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        if (this.renderer) this.renderer.dispose();
        if (this.controls) this.controls.dispose();

        const wrapper = document.getElementById('combined-view');
        if (wrapper) wrapper.remove();

        // Restore main canvas
        const mainCanvas = document.getElementById('main-canvas');
        if (mainCanvas) mainCanvas.style.display = '';

        this.sliceCanvas = null;
        this.sliceCtx = null;
        this.scene = null;
        this.renderer = null;
        this.controls = null;
        this.is3DMode = false;
        this.synObjs       = [];
        this.memObjs       = [];
        this.edgeLineSegs  = null;
        this.cleanLineSegs = null;
        this.errLineSegs   = null;
        this.hoverLineSegs = null;
        this.edgeMap       = [];
    }
}
