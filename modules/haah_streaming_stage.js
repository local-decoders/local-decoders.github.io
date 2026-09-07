// One Haah-style WebGL scene for the physical system and every decoder slice.
// The shared stage owns the canvas, orbit controls, display toggles and disposal;
// this layer only supplies the stack's geometry, instances and framing.
import {
    XCubeStageDecoder,
    COLOR_DEFECT, COLOR_ERROR_QUBIT, COLOR_DEFECT_RIM, COLOR_ERROR_RIM,
    COLOR_IDLE_QUBIT, IDLE_QUBIT_OPACITY, GHOST_OPACITY_SCALE, GHOST_ERROR_FADE,
    COLOR_3D_GRID, GRID_OPACITY, COLOR_CUBE_EDGE, CUBE_EDGE_OPACITY,
    COLOR_STAGE_BACKGROUND, COLOR_LIGHT, AMBIENT_LIGHT_INTENSITY,
    KEY_LIGHT_INTENSITY, KEY_LIGHT_X_PER_L, KEY_LIGHT_Y_PER_L, KEY_LIGHT_Z_PER_L,
    STYLE_REFERENCE_L, ORB_SIZE_EXPONENT, DEFECT_RADIUS, ERROR_QUBIT_RADIUS,
    IDLE_QUBIT_RADIUS, QUBIT_OFFSET, ORB_RIM_SCALE, ORB_WIDTH_SEGMENTS,
    ORB_HEIGHT_SEGMENTS, IDLE_WIDTH_SEGMENTS, IDLE_HEIGHT_SEGMENTS,
    CAMERA_FOV_DEG, CAMERA_NEAR, CAMERA_FAR, CAMERA_BASE_XZ_PER_L,
    CAMERA_BASE_Y_PER_L, CAMERA_ELEVATION_FACTOR, CAMERA_DISTANCE_FACTOR,
    CAMERA_VIEWPORT_SCALE,
} from './haah_stage.js';
import { CAPTION_SCALE, TLABEL_FONT_SIZE } from './repetition2.js';
import {
    STACK_BRACKET_INSET, STACK_BRACKET_TICK_LENGTH, STACK_CAPTION_GAP,
    STACK_BRACKET_WIDTH,
} from './surface_streaming_3d.js';

export { COLOR_DEFECT, COLOR_ERROR_QUBIT, COLOR_DEFECT_RIM, COLOR_ERROR_RIM };

export const HAAH_STACK_GAP_PER_L = 0.35;
// Lower elevation and a longer lens keep the separated world-space cubes
// separate in projection, including the lower cubes nearest the camera.
// Azimuth, viewport zoom and the starting distance follow the Haah stage.
export const HAAH_STACK_CAMERA_ELEVATION_SCALE = 0.25;
export const HAAH_STACK_CAMERA_FOV_SCALE = 0.25;
export const HAAH_STACK_CAMERA_FIT_PADDING = 1.06;
export const HAAH_STACK_CAPTION_GUTTER_PX = 98;
export const HAAH_STACK_TOP_MARGIN_PX = 12;
export const HAAH_STACK_RIGHT_MARGIN_PX = 16;
export const HAAH_STACK_BOTTOM_MARGIN_PX = 38;
export const HAAH_STACK_ORB_SCALE = 1;
// Decoder cubes show only defects; enable to also show their correction qubits.
export const HAAH_STACK_SLICES_SHOW_CORRECTIONS = false;

export class HaahStreamingStageDecoder extends XCubeStageDecoder {
    constructor(L, clockPeriod, opts, logicalData) {
        super(L, clockPeriod, opts, logicalData);
        // X-cube's rule arrays are not part of a Haah streaming instance.
        delete this.links;
        delete this.syndrome;
        delete this.memory;
        this._canEditInitialErrors = null;
        this._stackCubes = [];
        this._stackCaptionElements = null;
        this._stackCaptionGeometry = null;
    }

    render(ctx, width, height) {
        if (this.is3DMode) return;
        ctx.fillStyle = COLOR_STAGE_BACKGROUND;
        ctx.fillRect(0, 0, width, height);
    }

    toggleError() { return false; }
    toggleErrorAtPosition() { return false; }

    _initThree(container) {
        this._createStackCaptions(container);
        super._initThree(container);
        this.renderer.domElement.style.cursor = 'grab';
    }

    _stackHeight() {
        return this.L * (1 + this.K * (1 + HAAH_STACK_GAP_PER_L));
    }

    // Corners are public, DOM-free geometry for the host's framing checks.
    getStackCubeCorners() {
        const L = this.L;
        return Array.from({ length: this.K + 1 }, (_, index) => {
            const bottom = index * L * (1 + HAAH_STACK_GAP_PER_L);
            const corners = [];
            for (const x of [0, L]) {
                for (const y of [bottom, bottom + L]) {
                    for (const z of [0, L]) corners.push([x, y, z]);
                }
            }
            return { index, slice: index - 1, kind: index ? 'decoder' : 'system', corners };
        });
    }

    getStackProjection() {
        if (!this.camera || !this.THREE) return null;
        this.camera.updateMatrixWorld();
        const point = new this.THREE.Vector3();
        const width = this._threeWidth, height = this._threeHeight;
        const cubes = this.getStackCubeCorners().map(cube => {
            const corners = cube.corners.map(([x, y, z]) => {
                point.set(x, y, z).project(this.camera);
                return { x: (point.x + 1) * width / 2,
                    y: (1 - point.y) * height / 2, z: point.z };
            });
            return { ...cube, corners, bounds: {
                left: Math.min(...corners.map(p => p.x)),
                right: Math.max(...corners.map(p => p.x)),
                top: Math.min(...corners.map(p => p.y)),
                bottom: Math.max(...corners.map(p => p.y)),
            } };
        });
        return { width, height, cubes };
    }

    _updateCameraProjection() {
        const width = this._threeWidth, height = this._threeHeight;
        this.camera.aspect = width / height;
        this.camera.zoom = CAMERA_VIEWPORT_SCALE;
        // Leave a fixed font-size gutter while orbiting about the stack centre.
        // The camera target stays at that centre; only its screen location moves.
        this.camera.setViewOffset(width, height,
            -(HAAH_STACK_CAPTION_GUTTER_PX - HAAH_STACK_RIGHT_MARGIN_PX) / 2,
            -(HAAH_STACK_TOP_MARGIN_PX - HAAH_STACK_BOTTOM_MARGIN_PX) / 2,
            width, height);
    }

    _resetCamera() {
        const T = this.THREE, L = this.L;
        this.controls?.dispose();
        this.camera = new T.PerspectiveCamera(CAMERA_FOV_DEG * HAAH_STACK_CAMERA_FOV_SCALE,
            this._threeWidth / this._threeHeight, CAMERA_NEAR, CAMERA_FAR);
        this._updateCameraProjection();
        const horizontal = Math.SQRT2 * (CAMERA_BASE_XZ_PER_L - 0.5);
        const vertical = CAMERA_BASE_Y_PER_L - 0.5;
        const elevation = Math.atan2(vertical, horizontal)
            * CAMERA_ELEVATION_FACTOR * HAAH_STACK_CAMERA_ELEVATION_SCALE;
        const distance = L * Math.hypot(horizontal, vertical) * CAMERA_DISTANCE_FACTOR;
        const xz = distance * Math.cos(elevation) / Math.SQRT2;
        this.camera.position.set(L / 2 + xz,
            this._stackHeight() / 2 + distance * Math.sin(elevation), L / 2 + xz);
        this.controls = new this.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.addEventListener('change', () => this._updateStackCaptions());
        this.controls.target.set(L / 2, this._stackHeight() / 2, L / 2);
        this._fitStackCamera();
        this.controls.update();
        this.controls.enableDamping = true;
        this.controls.saveState();
    }

    _fitStackCamera() {
        const T = this.THREE;
        const target = new T.Vector3(this.L / 2, this._stackHeight() / 2, this.L / 2);
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();
        const right = new T.Vector3().crossVectors(this.camera.up, direction).normalize();
        const up = new T.Vector3().crossVectors(direction, right).normalize();
        const halfWidth = Math.max(1, (this._threeWidth
            - HAAH_STACK_CAPTION_GUTTER_PX - HAAH_STACK_RIGHT_MARGIN_PX) / 2);
        const halfHeight = Math.max(1, (this._threeHeight
            - HAAH_STACK_TOP_MARGIN_PX - HAAH_STACK_BOTTOM_MARGIN_PX) / 2);
        const focal = this._threeHeight * this.camera.zoom
            / (2 * Math.tan(this.camera.fov * Math.PI / 360));
        const offset = new T.Vector3();
        let distance = 0;
        for (const cube of this.getStackCubeCorners()) {
            for (const corner of cube.corners) {
                offset.fromArray(corner).sub(target);
                const depth = offset.dot(direction);
                distance = Math.max(distance,
                    depth + Math.abs(offset.dot(right)) * focal / halfWidth,
                    depth + Math.abs(offset.dot(up)) * focal / halfHeight);
            }
        }
        distance *= HAAH_STACK_CAMERA_FIT_PADDING;
        this.controls.target.copy(target);
        this.camera.position.copy(target).addScaledVector(direction, distance);
        this.camera.lookAt(target);
        this.camera.updateMatrixWorld();
    }

    _resizeThree() {
        const previousWidth = this._threeWidth, previousHeight = this._threeHeight;
        super._resizeThree();
        if (this._threeWidth !== previousWidth || this._threeHeight !== previousHeight) {
            this._fitStackCamera();
            this.controls.update();
        }
        // The parent animation loop calls this on every frame, even at rest.
        this._updateStackCaptions();
    }

    _createStackCaptions(container) {
        const overlay = document.createElement('div');
        overlay.id = 'haah-stack-captions';
        overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, {
            position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: `${CAPTION_SCALE * TLABEL_FONT_SIZE}px`,
            lineHeight: '1', color: 'var(--text-dim, #6b7280)',
        });
        const bracket = document.createElement('div');
        bracket.dataset.caption = 'bracket';
        Object.assign(bracket.style, {
            position: 'absolute', boxSizing: 'border-box', pointerEvents: 'none',
            width: `${STACK_BRACKET_TICK_LENGTH}px`,
            borderLeft: `${STACK_BRACKET_WIDTH}px solid currentColor`,
            borderTop: `${STACK_BRACKET_WIDTH}px solid currentColor`,
            borderBottom: `${STACK_BRACKET_WIDTH}px solid currentColor`,
        });
        const decoder = document.createElement('span');
        decoder.dataset.caption = 'decoder';
        decoder.textContent = 'decoder';
        Object.assign(decoder.style, { position: 'absolute', whiteSpace: 'nowrap',
            pointerEvents: 'none', transform: 'translate(-100%, -50%)' });
        const system = document.createElement('span');
        system.dataset.caption = 'system';
        system.textContent = 'system';
        Object.assign(system.style, { position: 'absolute', whiteSpace: 'nowrap',
            pointerEvents: 'none', transform: 'translateX(-50%)' });
        overlay.append(bracket, decoder, system);
        container.appendChild(overlay);
        this._stackCaptionElements = { overlay, bracket, decoder, system };
    }

    _updateStackCaptions() {
        if (!this._stackCaptionElements) return;
        const projection = this.getStackProjection();
        if (!projection) return;
        const decoderBounds = projection.cubes.slice(1).map(cube => cube.bounds);
        const top = Math.min(...decoderBounds.map(bounds => bounds.top));
        const bottom = Math.max(...decoderBounds.map(bounds => bounds.bottom));
        const left = Math.min(...decoderBounds.map(bounds => bounds.left)) - STACK_BRACKET_INSET;
        const systemBounds = projection.cubes[0].bounds;
        const systemX = (systemBounds.left + systemBounds.right) / 2;
        const systemY = systemBounds.bottom + STACK_CAPTION_GAP;
        const { bracket, decoder, system } = this._stackCaptionElements;
        Object.assign(bracket.style, { left: `${left}px`, top: `${top}px`,
            height: `${bottom - top}px` });
        Object.assign(decoder.style, { left: `${left - STACK_CAPTION_GAP}px`,
            top: `${(top + bottom) / 2}px` });
        Object.assign(system.style, { left: `${systemX}px`, top: `${systemY}px` });
        this._stackCaptionGeometry = {
            bracket: { left, top, bottom },
            decoder: { right: left - STACK_CAPTION_GAP, centerY: (top + bottom) / 2 },
            system: { centerX: systemX, top: systemY },
        };
    }

    _buildScene() {
        const T = this.THREE, L = this.L;
        this.scene = new T.Scene();
        this.scene.background = new T.Color(COLOR_STAGE_BACKGROUND);
        this.scene.add(new T.AmbientLight(COLOR_LIGHT, AMBIENT_LIGHT_INTENSITY));
        const light = new T.DirectionalLight(COLOR_LIGHT, KEY_LIGHT_INTENSITY);
        light.position.set(L * KEY_LIGHT_X_PER_L,
            this._stackHeight() / 2 + L * KEY_LIGHT_Y_PER_L, L * KEY_LIGHT_Z_PER_L);
        light.target.position.set(L / 2, this._stackHeight() / 2, L / 2);
        this.scene.add(light, light.target);

        const idleGeometry = new T.SphereGeometry(1, IDLE_WIDTH_SEGMENTS, IDLE_HEIGHT_SEGMENTS);
        const orbGeometry = new T.SphereGeometry(1, ORB_WIDTH_SEGMENTS, ORB_HEIGHT_SEGMENTS);
        const rimGeometry = orbGeometry.clone().scale(ORB_RIM_SCALE, ORB_RIM_SCALE, ORB_RIM_SCALE);
        const idleMaterial = new T.MeshBasicMaterial({ color: COLOR_IDLE_QUBIT,
            transparent: true, opacity: IDLE_QUBIT_OPACITY, depthWrite: false });
        const errorMaterial = new T.MeshLambertMaterial({ color: COLOR_ERROR_QUBIT });
        const errorRim = new T.MeshBasicMaterial({ color: COLOR_ERROR_RIM, side: T.BackSide });
        const defectMaterial = new T.MeshLambertMaterial({ color: COLOR_DEFECT });
        const defectRim = new T.MeshBasicMaterial({ color: COLOR_DEFECT_RIM, side: T.BackSide });
        const ghostIdle = idleMaterial.clone();
        ghostIdle.opacity *= GHOST_OPACITY_SCALE;
        const ghostError = errorMaterial.clone();
        ghostError.color.lerp(this.scene.background, GHOST_ERROR_FADE);
        const ghostRim = errorRim.clone();
        ghostRim.color.lerp(this.scene.background, GHOST_ERROR_FADE);

        this._qubitSites = [];
        this._ghostQubitSites = [];
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                for (let z = 0; z < L; z++) {
                    const site = x * L * L + y * L + z;
                    for (let q = 0; q < 2; q++) {
                        const offset = q === 0 ? QUBIT_OFFSET : -QUBIT_OFFSET;
                        this._qubitSites.push({ site, q, px: x + offset, py: y, pz: z });
                        for (const gx of x === 0 ? [0, L] : [x]) {
                            for (const gy of y === 0 ? [0, L] : [y]) {
                                for (const gz of z === 0 ? [0, L] : [z]) {
                                    if (gx === x && gy === y && gz === z) continue;
                                    this._ghostQubitSites.push({ site, q,
                                        px: gx + offset, py: gy, pz: gz });
                                }
                            }
                        }
                    }
                }
            }
        }

        const gridPositions = [], edgePositions = [];
        for (let i = 0; i <= L; i++) {
            for (let j = 0; j <= L; j++) {
                const positions = (i === 0 || i === L) && (j === 0 || j === L)
                    ? edgePositions : gridPositions;
                positions.push(i, j, 0, i, j, L, i, 0, j, i, L, j, 0, i, j, L, i, j);
            }
        }
        const makeGeometry = positions => new T.BufferGeometry().setAttribute('position',
            new T.Float32BufferAttribute(positions, 3));
        const gridGeometry = makeGeometry(gridPositions), edgeGeometry = makeGeometry(edgePositions);
        const gridMaterial = new T.LineBasicMaterial({ color: COLOR_3D_GRID,
            transparent: true, opacity: GRID_OPACITY * Math.min(1, STYLE_REFERENCE_L / L),
            depthWrite: false });
        const edgeMaterial = new T.LineBasicMaterial({ color: COLOR_CUBE_EDGE,
            transparent: true, opacity: CUBE_EDGE_OPACITY, depthWrite: false });
        this._instanceTransform = new T.Matrix4();
        this._stackCubes = [];
        this.qubitMeshes = [];
        this.ghostQubitMeshes = [];
        this.synObjs = [];

        for (let index = 0; index <= this.K; index++) {
            const group = new T.Group();
            group.name = index ? `haah-slice-${index - 1}` : 'haah-system';
            group.position.y = index * L * (1 + HAAH_STACK_GAP_PER_L);
            group.userData = { stackIndex: index, slice: index - 1 };
            this.scene.add(group);
            const makeBatch = (geometry, material, capacity, rimMaterial = null) => {
                const mesh = new T.InstancedMesh(geometry, material, capacity);
                mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
                mesh.count = 0;
                mesh.boundingSphere = new T.Sphere(new T.Vector3(L / 2, L / 2, L / 2),
                    Math.sqrt(3) * (L / 2 + 1));
                group.add(mesh);
                if (rimMaterial) {
                    const rim = new T.InstancedMesh(rimGeometry, rimMaterial, capacity);
                    rim.instanceMatrix = mesh.instanceMatrix;
                    rim.count = 0;
                    rim.boundingSphere = mesh.boundingSphere;
                    mesh.userData.rim = rim;
                    group.add(rim);
                }
                return mesh;
            };
            const makeQubits = (sites, idle, error, rim) => {
                const batches = [makeBatch(idleGeometry, idle, sites.length),
                    makeBatch(orbGeometry, error, sites.length, rim)];
                // Idle vertices stay fixed, including beneath the larger opaque
                // error orbs. Stepping only uploads the sparse red/blue batches.
                for (const { px, py, pz } of sites) {
                    this._instanceTransform.makeScale(IDLE_QUBIT_RADIUS,
                        IDLE_QUBIT_RADIUS, IDLE_QUBIT_RADIUS).setPosition(px, py, pz);
                    batches[0].setMatrixAt(batches[0].count++, this._instanceTransform);
                }
                batches[0].instanceMatrix.needsUpdate = true;
                return batches;
            };
            const qubits = makeQubits(this._qubitSites, idleMaterial, errorMaterial, errorRim);
            const ghosts = makeQubits(this._ghostQubitSites, ghostIdle, ghostError, ghostRim);
            const defects = makeBatch(orbGeometry, defectMaterial, L ** 3, defectRim);
            const grid = new T.LineSegments(gridGeometry, gridMaterial);
            const edges = new T.LineSegments(edgeGeometry, edgeMaterial);
            group.add(grid, edges);
            this._stackCubes.push({ index, group, qubits, ghosts, defects, grid, edges });
            this.qubitMeshes.push(...qubits);
            this.ghostQubitMeshes.push(...ghosts);
            this.synObjs.push(defects);
        }
        this._update3D();
    }

    _update3D() {
        if (!this.scene) return;
        const L = this.L, options = this._readOptions();
        const orbScale = Math.pow(L / STYLE_REFERENCE_L, ORB_SIZE_EXPONENT) * HAAH_STACK_ORB_SCALE;
        const place = (mesh, x, y, z, radius) => {
            this._instanceTransform.makeScale(radius, radius, radius).setPosition(x, y, z);
            mesh.setMatrixAt(mesh.count++, this._instanceTransform);
        };
        const finish = (mesh, visible) => {
            mesh.visible = visible;
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.userData.rim) {
                mesh.userData.rim.count = mesh.count;
                mesh.userData.rim.visible = visible;
            }
        };
        for (const cube of this._stackCubes) {
            const slice = cube.index ? this.slices[cube.index - 1] : null;
            const showQubits = options.showErrors
                && (!slice || HAAH_STACK_SLICES_SHOW_CORRECTIONS);
            const a = slice ? slice.cA : this.residualA;
            const b = slice ? slice.cB : this.residualB;
            const syndrome = slice ? slice.s : this.residualSyndrome;
            const updateQubits = (sites, batches) => {
                const error = batches[1];
                error.count = 0;
                for (const { site, q, px, py, pz } of sites) {
                    if ((q ? b : a)[site]) place(error, px, py, pz,
                        ERROR_QUBIT_RADIUS * orbScale);
                }
                batches[0].visible = showQubits;
                finish(error, showQubits);
            };
            updateQubits(this._qubitSites, cube.qubits);
            updateQubits(this._ghostQubitSites, cube.ghosts);
            cube.defects.count = 0;
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    for (let z = 0; z < L; z++) {
                        if (syndrome[x * L * L + y * L + z]) place(cube.defects,
                            x + 0.5, y + 0.5, z + 0.5, DEFECT_RADIUS * orbScale);
                    }
                }
            }
            finish(cube.defects, options.showSyndrome);
            cube.grid.visible = options.showGrid;
            cube.edges.visible = options.showGrid;
        }
        this._updateStackCaptions();
    }

    reinitialize3D(fresh) {
        const geometryChanged = this.L !== fresh.L || this.K !== fresh.K;
        this._replaceStreamingState(fresh);
        if (geometryChanged) {
            const previousScene = this.scene;
            this._buildScene();
            this._resetCamera();
            this.renderer.render(this.scene, this.camera);
            this._disposeScene(previousScene);
        } else {
            this._update3D();
            this.renderer.render(this.scene, this.camera);
        }
        this._updateStackCaptions();
    }

    dispose() {
        super.dispose();
        this._stackCubes = [];
        this._stackCaptionElements = null;
        this._stackCaptionGeometry = null;
    }
}
