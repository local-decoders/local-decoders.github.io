// Shared X-cube host and rendering layer, copied from Haah without changing haah.js.
// Only link placement and the optional three lineon species differ in the 3D scene.
import { loadLogicalData, missingLogicalDataResult } from './logical_data.js';

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

// X-cube additions. The species have matching HSL lightness/saturation.
export const COLOR_LINEON_X = '#8a9ee8';
export const COLOR_LINEON_Y = '#c28ae8';
export const COLOR_LINEON_Z = '#8ae8bc';
export const COLOR_LINEON_X_RIM = COLOR_DEFECT_RIM;
export const COLOR_LINEON_Y_RIM = COLOR_DEFECT_RIM;
export const COLOR_LINEON_Z_RIM = COLOR_DEFECT_RIM;
export const LINEON_RADIUS = DEFECT_RADIUS;
export const DEFAULT_CLOCK_PERIOD = 10;
export const COLOR_STAGE_BACKGROUND = '#f8fafc';
export const COLOR_STAGE_BORDER = '#e2e8f0';
export const COLOR_LIGHT = '#ffffff';
export const STAGE_BORDER_RADIUS_PX = 6;
export const INITIAL_VIEWPORT_WIDTH = 580;
export const INITIAL_VIEWPORT_HEIGHT = 600;
export const CAMERA_FOV_DEG = 50;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 1000;
export const CAMERA_BASE_XZ_PER_L = 1.8;
export const CAMERA_BASE_Y_PER_L = 1.4;
export const CLICK_DRAG_THRESHOLD_PX = 4;
export const SLICE_MAX_COLUMNS = 4;
export const SLICE_PADDING = 8;
export const SLICE_LABEL_HEIGHT = 15;
export const SLICE_FOOTER_HEIGHT = 20;
export const SLICE_CELL_GAP = 2;
export const SLICE_MIN_CELL_SIZE = 1;
export const SLICE_FONT_SIZE = 10;
export const SLICE_GRID_WIDTH = 0.5;
export const SLICE_ERROR_RADIUS_FRACTION = 0.105;
export const SLICE_DEFECT_RADIUS_FRACTION = 0.25;
export const COLOR_SLICE_BACKGROUND = '#ffffff';
export const COLOR_SLICE_LABEL = '#64748b';
export const COLOR_SLICE_GRID = '#e2e8f0';

// Haah's exact file format: L -> detector rows -> little-endian uint32 words.
// The two sectors fetch independently; every instance of one sector shares data.
export function loadXCubeLogicals(url) {
    return loadLogicalData(url);
}

export class XCubeStageDecoder {
    constructor(L, clockPeriod, opts, logicalData, lineons = false) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;
        this.logicalDataReady = logicalData.ready;
        this._logicalData = logicalData;
        this._logicalsCache = logicalData.cache;
        this._canEditInitialErrors = opts.canEditInitialErrors ?? null;
        this._prepareInitialErrorsEdit = opts.prepareInitialErrorsEdit ?? null;
        this._onInitialErrorsEdited = opts.onInitialErrorsEdited ?? null;
        this._lineonSector = lineons;
        // Direction-major link ordering, shared with make_xcube_logicals.py:
        // bit = d * L^3 + x * L^2 + y * L + z, d=0,1,2 means x,y,z.
        this.links = Array.from({ length: 3 }, () => this._arr3(L, false));
        this.syndrome = this._arr3(L, false);
        this.memory = this._arr6(L);
        if (lineons) {
            this.ell1 = this._arr3(L, false);
            this.ell2 = this._arr3(L, false);
            this.ell3 = this._arr3(L, false);
        }
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

    _arr3(L, fill = false) {
        return Array.from({ length: L }, () =>
            Array.from({ length: L }, () => new Array(L).fill(fill)));
    }

    _arr6(L) {
        return Array.from({ length: 2 }, () =>
            Array.from({ length: 2 }, () =>
                Array.from({ length: 2 }, () => this._arr3(L, false))));
    }

    create3DArray(size, fill) { return this._arr3(size, fill); }

    mod(n) { return ((n % this.L) + this.L) % this.L; }

    initializeRandomErrors(p, rng = Math.random) {
        const L = this.L;
        for (let d = 0; d < 3; d++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++)
                        this.links[d][x][y][z] = rng() < p;
        this.memory = this._arr6(L);
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
        if (this.is3DMode) this._update3D();
    }

    initializeClear() {
        this.initializeRandomErrors(0, () => 1);
    }

    toggleError(d, x, y, z) {
        if (![d, x, y, z].every(Number.isInteger) || d < 0 || d > 2
            || x < 0 || x >= this.L || y < 0 || y >= this.L || z < 0 || z >= this.L) return false;
        if (!this._canEditInitialErrors?.()) return false;
        if (this._prepareInitialErrorsEdit && !this._prepareInitialErrorsEdit()) return false;
        x %= this.L; y %= this.L; z %= this.L;
        this.links[d][x][y][z] = !this.links[d][x][y][z];
        this.calculateSyndrome();
        this._update3D();
        this._onInitialErrorsEdited?.();
        return true;
    }

    render(ctx, width, height, options) {
        if (this.is3DMode) return;
        this._drawSlices(ctx, width, height, options);
    }

    _sliceLayout(width, height) {
        const L = this.L;
        const cols = Math.min(L, SLICE_MAX_COLUMNS);
        const sliceW = Math.floor((width - SLICE_PADDING * 2) / cols);
        const sliceH = Math.floor((height - SLICE_PADDING * 2 - SLICE_FOOTER_HEIGHT)
            / Math.ceil(L / cols));
        const cell = Math.max(SLICE_MIN_CELL_SIZE, Math.min(
            Math.floor((sliceW - SLICE_CELL_GAP) / L),
            Math.floor((sliceH - SLICE_LABEL_HEIGHT - SLICE_CELL_GAP) / L)));
        return { cols, sliceW, sliceH, cell };
    }

    _defectColor(x, y, z) {
        if (!this._lineonSector) return COLOR_DEFECT;
        return this.ell1[x][y][z] ? COLOR_LINEON_X
            : this.ell2[x][y][z] ? COLOR_LINEON_Y : COLOR_LINEON_Z;
    }

    _drawSlices(ctx, width, height, options = {}) {
        const { showSyndrome = true, showErrors = true, showGrid = true } = options || {};
        const L = this.L;
        const { cols, sliceW, sliceH, cell } = this._sliceLayout(width, height);
        ctx.fillStyle = COLOR_SLICE_BACKGROUND;
        ctx.fillRect(0, 0, width, height);
        for (let z = 0; z < L; z++) {
            const ox = SLICE_PADDING + (z % cols) * sliceW;
            const oy = SLICE_PADDING + Math.floor(z / cols) * sliceH + SLICE_LABEL_HEIGHT;
            ctx.fillStyle = COLOR_SLICE_LABEL;
            ctx.font = `${SLICE_FONT_SIZE}px JetBrains Mono, monospace`;
            ctx.fillText(`z=${z}`, ox + SLICE_CELL_GAP, oy - SLICE_LABEL_HEIGHT + SLICE_FONT_SIZE);
            if (showGrid) {
                ctx.strokeStyle = COLOR_SLICE_GRID;
                ctx.lineWidth = SLICE_GRID_WIDTH;
                for (let i = 0; i <= L; i++) {
                    ctx.beginPath();
                    ctx.moveTo(ox + i * cell, oy);
                    ctx.lineTo(ox + i * cell, oy + L * cell);
                    ctx.moveTo(ox, oy + i * cell);
                    ctx.lineTo(ox + L * cell, oy + i * cell);
                    ctx.stroke();
                }
            }
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    const px = ox + x * cell, py = oy + (L - 1 - y) * cell;
                    if (showSyndrome && this.syndrome[x][y][z]) {
                        ctx.fillStyle = this._defectColor(x, y, z);
                        ctx.beginPath();
                        ctx.arc(px + cell / 2, py + cell / 2,
                            cell * SLICE_DEFECT_RADIUS_FRACTION, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    if (showErrors) {
                        ctx.fillStyle = COLOR_ERROR_QUBIT;
                        // Each cell's three columns select its x/y/z link.
                        for (let d = 0; d < 3; d++) {
                            if (!this.links[d][x][y][z]) continue;
                            ctx.beginPath();
                            ctx.arc(px + cell * (d + 0.5) / 3,
                                py + cell / 2, cell * SLICE_ERROR_RADIUS_FRACTION, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                }
            }
        }
    }

    toggleErrorAtPosition(x, y, width, height) {
        const { cols, sliceW, sliceH, cell } = this._sliceLayout(width, height);
        const col = Math.floor((x - SLICE_PADDING) / sliceW);
        const row = Math.floor((y - SLICE_PADDING) / sliceH);
        if (col < 0 || col >= cols || row < 0) return false;
        const z = row * cols + col;
        if (z >= this.L) return false;
        const lx = x - SLICE_PADDING - col * sliceW;
        const ly = y - SLICE_PADDING - row * sliceH - SLICE_LABEL_HEIGHT;
        const gx = Math.floor(lx / cell), gy = this.L - 1 - Math.floor(ly / cell);
        const d = Math.floor((lx / cell - gx) * 3);
        return this.toggleError(d, gx, gy, z);
    }

    stepUncoord() {
        const L = this.L;
        this.step([
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L),
            Math.floor(Math.random() * L)
        ]);
    }

    _readOptions() {
        return {
            showSyndrome: document.getElementById('show-syndrome')?.checked ?? true,
            showErrors: document.getElementById('show-errors')?.checked ?? true,
            showGrid: document.getElementById('show-grid')?.checked ?? true,
        };
    }

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
            flex: '1 1 auto', borderRadius: `${STAGE_BORDER_RADIUS_PX}px`, overflow: 'hidden',
            background: COLOR_STAGE_BACKGROUND, outline: `1px solid ${COLOR_STAGE_BORDER}`,
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

    _initThree(container) {
        const T = this.THREE;
        const w = container.clientWidth || INITIAL_VIEWPORT_WIDTH;
        const h = container.clientHeight || INITIAL_VIEWPORT_HEIGHT;
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
            if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_PX ** 2) return;
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
            const { x, y, z, q } = object.userData.qubits[instanceId];
            this.toggleError(q, x, y, z);
        });

        const _loop = () => {
            this.animationFrameId = requestAnimationFrame(_loop);
            this._resizeThree();
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        _loop();
    }

    reinitialize3D(fresh) {
        const sizeChanged = this.L !== fresh.L;
        for (const key of ['L', 'clockPeriod', 'stepCount', 'clock', 'links', 'syndrome', 'memory',
            ...(this._lineonSector ? ['ell1', 'ell2', 'ell3'] : [])]) {
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
        this.camera = new T.PerspectiveCamera(CAMERA_FOV_DEG, this._threeWidth / this._threeHeight, CAMERA_NEAR, CAMERA_FAR);
        this._updateCameraProjection();
        // Adjust the original target-relative view in spherical coordinates,
        // keeping elevation and distance independent of the framing offset.
        const baseHorizontal = Math.SQRT2 * (CAMERA_BASE_XZ_PER_L - 0.5);
        const baseVertical = CAMERA_BASE_Y_PER_L - 0.5;
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
        this.scene.background = new T.Color(COLOR_STAGE_BACKGROUND);

        this.scene.add(new T.AmbientLight(COLOR_LIGHT, AMBIENT_LIGHT_INTENSITY));
        const dl = new T.DirectionalLight(COLOR_LIGHT, KEY_LIGHT_INTENSITY);
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
        const errorRimMat = new T.MeshBasicMaterial({ color: COLOR_ERROR_RIM, side: T.BackSide });
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
                    for (let q = 0; q < 3; q++) {
                        // A link starts at (x,y,z) and points along q. Its
                        // midpoint lies inside the cube along that axis;
                        // transverse zero coordinates have PBC face copies.
                        const px = x + (q === 0 ? 0.5 : 0);
                        const py = y + (q === 1 ? 0.5 : 0);
                        const pz = z + (q === 2 ? 0.5 : 0);
                        this._qubitSites.push({ x, y, z, q, px, py, pz });
                        const xs = px === 0 ? [0, L] : [px];
                        const ys = py === 0 ? [0, L] : [py];
                        const zs = pz === 0 ? [0, L] : [pz];
                        for (const gx of xs) {
                            for (const gy of ys) {
                                for (const gz of zs) {
                                    if (gx === px && gy === py && gz === pz) continue;
                                    this._ghostQubitSites.push({ x, y, z, q, px: gx, py: gy, pz: gz });
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
        const defectStyles = this._lineonSector ? [
            [COLOR_LINEON_X, COLOR_LINEON_X_RIM],
            [COLOR_LINEON_Y, COLOR_LINEON_Y_RIM],
            [COLOR_LINEON_Z, COLOR_LINEON_Z_RIM],
        ] : [[COLOR_DEFECT, COLOR_DEFECT_RIM]];
        this.synObjs = defectStyles.map(([color, rimColor]) => makeBatch(orbGeo,
            new T.MeshLambertMaterial({ color }), L ** 3,
            new T.MeshBasicMaterial({ color: rimColor, side: T.BackSide })));
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
                const errored = this.links[q][x][y][z];
                place(batches[errored ? 1 : 0], px, py, pz,
                    errored ? ERROR_QUBIT_RADIUS * orbScale : IDLE_QUBIT_RADIUS, site);
            }
            for (const mesh of batches) finish(mesh, opts.showErrors);
        };
        updateQubits(this._qubitSites, this.qubitMeshes);
        updateQubits(this._ghostQubitSites, this.ghostQubitMeshes);
        this.cleanLineSegs.visible = opts.showGrid;
        this.outerLineSegs.visible = opts.showGrid;

        for (const defects of this.synObjs) defects.count = 0;
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    if (!this.syndrome[x][y][z]) continue;
                    if (this._lineonSector) {
                        const species = this.ell1[x][y][z] ? 0 : this.ell2[x][y][z] ? 1 : 2;
                        place(this.synObjs[species], x, y, z, LINEON_RADIUS * orbScale);
                    } else {
                        place(this.synObjs[0], x + 0.5, y + 0.5, z + 0.5, DEFECT_RADIUS * orbScale);
                    }
                }
            }
        }
        for (const defects of this.synObjs) finish(defects, opts.showSyndrome);
    }

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
        for (const links of this.links)
            for (const plane of links)
                for (const row of plane)
                    for (const error of row) if (error) n++;
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
                                if (this.memory[i][j][k][x][y][z]) { n++; continue site; }
        return n;
    }

    hasMessages() {
        return this.getMemoryCount() > 0;
    }

    isQuiescent() {
        // The run's verdict depends on defects; residual messages do not delay it.
        return this.getSyndromeCount() === 0;
    }

    retryLogicalData() { return this._logicalData.retry?.(); }

    checkLogicalError() {
        const logicals = this._logicalsCache.get(this.L);
        if (!logicals) return missingLogicalDataResult(this._logicalData);
        if (this.getSyndromeCount() !== 0) return { hasError: false };
        const L = this.L, L3 = L * L * L, n = 3 * L3, nw = Math.ceil(n / 32);
        const ep = new Uint32Array(nw);
        for (let d = 0; d < 3; d++)
            for (let x = 0; x < L; x++)
                for (let y = 0; y < L; y++)
                    for (let z = 0; z < L; z++) {
                        const bit = d * L3 + x * L * L + y * L + z;
                        if (this.links[d][x][y][z]) ep[bit >> 5] ^= 1 << (bit & 31);
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
