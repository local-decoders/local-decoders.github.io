// Main JavaScript Module for CA Decoder Visualizer

// TASK 4de: static import solely for the one shared constant
// updateDescriptionCardPosition() needs as its own default anchor below --
// every decoder module is still loaded dynamically via import() inside
// loadDecoder() (which module depends on the user's selection), but this
// one named export is safe and cheap to import statically up front: ES
// modules are cached per URL, so this doesn't cause repetition2.js to be
// fetched/evaluated twice, whether or not the repetition2 decoder itself
// ever gets selected.
import { DESCRIPTION_TOP_CSS } from '../modules/repetition2.js';
import { captureDecoderState, restoreDecoderState } from '../modules/step_history.js';
import * as HaahStreamingDefaults from '../modules/haah_streaming_defaults.js';
import { SURGERY_DEFAULT_SIZE, SURGERY_MAX_SIZE } from '../modules/surface_cg_surgery.js';

// TASK 4do: site-wide kill switch for asynchronous ("uncoordinated")
// mode, without removing the capability itself -- every decoder module
// keeps its own stepUncoord() unchanged, and every test harness
// (check_toric2.mjs and the rest) keeps exercising those paths directly,
// completely independent of this flag (they call stepUncoord() on a
// decoder instance directly, never through this UI layer at all).
// Flipping this back to true is meant to be the only change needed to
// restore the feature everywhere it was wired in before this task: the
// "mode" section's own visibility (loadDecoder()), whether a Step/Play
// tick actually calls stepUncoord() at all (stepOnce()), whether the
// clock-period stat row is hidden for async reasons (updateStats()), and
// which section updateSectionDividers() treats as the last visible one
// all read this flag rather than the checkbox's raw .checked value
// directly. See each call site's own comment for why gating the READ
// (not resetting the checkbox's own .checked property) is enough: with
// every read short-circuited to "off" by this flag, the checkbox's own
// underlying state -- however it got there, including any URL parameter
// a page load might otherwise have used to preset it -- can never
// actually take effect.
const ASYNC_MODE_ENABLED = false;

// TASK 4ew: page-level trial flag for the three-pillar layout (a third
// grid column on the right holding the state/legend/description cards,
// freeing the canvas of every floating overlay card). Flag OFF must
// reproduce today's (pre-4ew) layout exactly -- every code path that
// existed before this task is left completely unchanged and still runs
// unconditionally; every NEW thing this task adds (setupThreePillarLayout()
// below, the body class it sets, computeOverlayRects()'s null-card-rects
// branch, applyCanvasSize()'s uncapped width branch, and the two skipped
// calls in loadDecoder()/render()) is gated on this single constant, so
// flipping it back to false is enough to fully restore the old behaviour
// everywhere. See setupThreePillarLayout()'s own comment for the DOM move
// this enables, and styles.css's own body.layout-three-pillars-scoped
// block for the CSS side.
const LAYOUT_THREE_PILLARS = true;

// Preview placement for the existing card; ?desc=below / ?desc=right
// overrides this default without changing canvas or overlay geometry.
export const DESCRIPTION_PLACEMENT = 'below';
let requestedBoundaryStyle = null;

// TASK 4hi: shared description leading leaves room below every pillar's
// card stack, including the hierarchical surface decoder's taller legend.
// At 1600x1100, 1.381 leaves only 3.95px spare; 1.38 leaves 4.20px.
export const DESCRIPTION_LINE_HEIGHT = 1.38;

// TASK 4it: every decoder load opens with a paused random run.
export const PREINITIALIZE_ON_LOAD = true;
export const DEFAULT_CODE = 'surface_cg_htree';

// Transport buttons retain the existing control-row height.
export const TRANSPORT_BUTTON_HEIGHT_PX = 24;

// Narrow presentation only; CSS uses the same 1024px / 640px breakpoints.
export const NARROW_LAYOUT_MAX_WIDTH = 1024;
export const NARROW_CANVAS_MAX_VH = 0.85;
export const NARROW_STABLE_VIEWPORT_HEIGHT = true;
export const NARROW_CANVAS_ASPECT = 1.5;
export const NARROW_CODE_CAPACITY_CANVAS_ASPECT = 1.1;
export const NARROW_HIERARCHICAL_CANVAS_ASPECT = 2.25;
export const SURGERY_DEFAULT_SLICES = 3;
export const SURGERY_Z_DEFAULT_SLICES = 3;
// The UI ends rejected runs; decoder retries remain available to benchmarks.
export const SURGERY_REJECTION_IS_TERMINAL = true;
export const SURFACE_CG_PROTOCOL_DEFAULT_SLICES = 3;
export const SURGERY_MIN_SIZE = 3;
export const SURGERY_X_NARROW_CANVAS_ASPECT = 1.3;
export const SURGERY_Z_NARROW_CANVAS_ASPECT = 2.25;
export const NARROW_3D_CANVAS_ASPECT = 1;
export const NARROW_TOUCH_TARGET_PX = 40;
export const NARROW_BASE_TEXT_PX = 15;
export const NARROW_SLIDER_THUMB_PX = 24;

export function narrowCanvasHeight(canvasWidth, viewportHeight, aspect = NARROW_CANVAS_ASPECT) {
    return Math.min(canvasWidth * aspect, viewportHeight * NARROW_CANVAS_MAX_VH);
}

// Retain one large-viewport measurement, or the largest observed innerHeight,
// until the width or actual screen orientation changes.
export function selectNarrowViewportHeight(previous, {
    width, height, orientation, largeViewportHeight = null,
}) {
    const sameViewport = previous?.width === width && previous?.orientation === orientation;
    const measured = sameViewport ? previous.largeViewportHeight ?? largeViewportHeight : largeViewportHeight;
    const largeHeight = Number.isFinite(measured) && measured > 0 ? measured : null;
    return {
        width, orientation, largeViewportHeight: largeHeight,
        height: largeHeight ?? (sameViewport ? Math.max(previous.height, height) : height),
    };
}

let narrowViewportState = null;
let narrowViewportProbe = null;

function narrowViewportOrientation() {
    const orientation = window.screen?.orientation;
    // Height-only browser-chrome changes must not masquerade as a rotation.
    return orientation ? `${orientation.type}:${orientation.angle}` : window.orientation ?? null;
}

function narrowViewportHeight() {
    if (!NARROW_STABLE_VIEWPORT_HEIGHT) return window.innerHeight;
    const width = window.innerWidth;
    const orientation = narrowViewportOrientation();
    const sameViewport = narrowViewportState?.width === width
        && narrowViewportState?.orientation === orientation;
    let largeViewportHeight = null;
    if (!sameViewport && window.CSS?.supports?.('height', '100lvh')) {
        if (!narrowViewportProbe) {
            narrowViewportProbe = document.createElement('div');
            narrowViewportProbe.style.cssText = 'position:fixed;top:0;left:0;height:100lvh;width:0;visibility:hidden;pointer-events:none';
            narrowViewportProbe.setAttribute('aria-hidden', 'true');
            document.body.appendChild(narrowViewportProbe);
        }
        largeViewportHeight = narrowViewportProbe.getBoundingClientRect().height;
    }
    narrowViewportState = selectNarrowViewportHeight(narrowViewportState, {
        width, height: window.innerHeight, orientation, largeViewportHeight,
    });
    return narrowViewportState.height;
}

function isNarrowLayout() {
    return window.innerWidth <= NARROW_LAYOUT_MAX_WIDTH;
}


// Match the moving pulse's thickness, with a three-head-length fading tail.
export const HTREE_LEGEND_TRANSIT_HEAD_WIDTH_FACTOR = 2.4;
export const HTREE_LEGEND_TRANSIT_TAIL_HEAD_RATIO = 3;

// Every forward tick, including Play, retains one reversible state.
export const STEP_HISTORY_MAX = 500;
const stepHistory = [];
const redoHistory = [];
// Keep rejection terminal for this decoder instance until Initialize or Reset
// replaces it, even if another UI action would otherwise alter its state.
const terminalSurgeryRejections = new WeakSet();

// A completed decode waits this long for logical data before reporting
// that the check is unavailable. A later response still updates the verdict.
export const LOGICAL_DATA_WAIT_MS = 10000;
const logicalDataStates = new WeakMap();

// TASK 4cm: the browser's own scroll-position restoration on reload was
// putting the page wherever the user last scrolled it before reloading,
// not the top -- reproduced via CDP (scrollY 0 on first load, but 174 at
// a 1600x700 viewport after scrolling to the bottom and reloading, on both
// the default tab and ?code=repetition2). No focus()/scrollIntoView()/
// scrollTo()/autofocus/hash usage was found anywhere in this file or
// index.html, so scroll restoration itself is the whole cause. Setting
// this to 'manual' as the very first thing that runs (before anything
// else has a chance to trigger a restore) opts out of it entirely; the
// one-time window.scrollTo(0, 0) that actually lands the page at the top
// on every load lives at the end of loadDecoder(), once the decoder has
// finished initializing. Manual scrolling between loads is untouched.
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// Global state
let currentDecoder = null;
let currentDecoderType = null;
let decoderLoadToken = 0;
let animationId = null;
let transientAnimationId = null;
let isPlaying = false;
let playDirection = 'forward';
// TASK 4dc: true once the user has actually asked the current
// configuration to advance (a Step click, or engaging Play), independent
// of whether stepCount itself ever moved -- a configuration that's already
// quiescent right after Initialize (p=0, p=1, or an untouched manual
// lattice) makes stepSimulation() bail out before calling step(), so
// stepCount stays exactly 0 forever; gating the success/failure/timeout
// verdict on stepCount (the old check) meant such a configuration could
// never show one, even though the user genuinely asked it to run.
// Cleared everywhere the decoder's own stepCount gets reset to 0 --
// loadDecoder() (initial load and decoder switch), initializeErrors()
// (Initialize, Reset, and Play after a stopped-noise verdict), and the manual-mode canvas gesture entry
// points (a fresh paint/drag edit is a new configuration the user hasn't
// yet asked to advance, exactly like a fresh Initialize).
let advanceRequested = false;
// Null while noise is enabled; the one-shot stop starts the drain budget.
let noiseStoppedAtStep = null;
// TASK 4bf/delta: the freshly `import()`ed decoder module for the
// currently loaded decoder, kept around so the "grid" checkbox's own
// change handler can re-call updateLegend() (which needs a module's
// exported colour constants for decoders like repetition2 that build
// their legend items from them) without re-importing anything.
let currentLoadedModule = null;
// The hierarchical legend follows the applied decoder K, not pending inputs.
let hierarchicalLegendK = null;
let surgeryLegendSignature = null;
let canvas = null;
let ctx = null;
export const ANIMATION_SPEED_DEFAULT = 24;
let animationSpeed = ANIMATION_SPEED_DEFAULT;
// Canvas CSS size (device-pixel-ratio independent): every decoder module's
// render(ctx, w, h, options) keeps drawing in these CSS units unconditionally;
// resizeCanvas() sets the backing store to cssWidth*dpr x cssHeight*dpr and
// render()/the decoder-switch clear scale the context so 1 drawing unit = 1
// CSS px, matching what canvas.style.width/height display it at.
let cssWidth = 900;
let cssHeight = 650;
let canvasPixelRatio = null;

// Dynamically load decoder modules
const decoderModules = {};

// TASK 4al: inlined verbatim from general_cc.js's own exported PRESETS
// (rather than a static top-level `import { PRESETS } from
// '../modules/general_cc.js'`, which would eagerly load that module's full
// compiler pipeline on every page load regardless of which decoder is
// selected -- every other decoder module is loaded lazily, on demand, by
// loadDecoder()'s own dynamic import() below, and this keeps that
// discipline). Used only for the preset dropdown's own glue
// (onExtraParamChange) and to seed codeSpec's initial default so the
// textarea isn't empty before the user touches the dropdown; re-copy this
// object if general_cc.js's own PRESETS ever changes.
const PRESETS = {
    toric2d: `A: X1(0,0) X2(0,0) X1(-1,0) X2(0,-1)
B: Z1(0,0) Z2(0,0) Z1(0,1) Z2(1,0)`,
    toric3d: `A: X1(0,0,0) X1(-1,0,0) X2(0,0,0) X2(0,-1,0) X3(0,0,0) X3(0,0,-1)
Bxy: Z1(0,0,0) Z2(0,0,0) Z1(0,1,0) Z2(1,0,0)
Byz: Z2(0,0,0) Z3(0,0,0) Z2(0,0,1) Z3(0,1,0)
Bzx: Z3(0,0,0) Z1(0,0,0) Z3(1,0,0) Z1(0,0,1)`,
    xcube: `Cxy: X1(0,0,0) X1(-1,0,0) X2(0,0,0) X2(0,-1,0)
Cyz: X2(0,0,0) X2(0,-1,0) X3(0,0,0) X3(0,0,-1)
Czx: X3(0,0,0) X3(0,0,-1) X1(0,0,0) X1(-1,0,0)
Cube: Z1(0,0,0) Z1(0,1,0) Z1(0,0,1) Z1(0,1,1) Z2(0,0,0) Z2(1,0,0) Z2(0,0,1) Z2(1,0,1) Z3(0,0,0) Z3(1,0,0) Z3(0,1,0) Z3(1,1,0)`,
    haah: `A: X1(0,0,0) X1(1,0,0) X1(0,1,0) X1(0,0,1) X2(0,0,0) X2(1,1,0) X2(1,0,1) X2(0,1,1)
B: Z1(1,0,0) Z1(0,1,0) Z1(0,0,1) Z1(1,1,1) Z2(1,1,0) Z2(1,0,1) Z2(0,1,1) Z2(1,1,1)`,
};

// Shared phenomenological control bound.
export const STREAMING_MAX_ERASURE_MOVES = 4;
export const STREAMING_FIXED_CLOCK_PERIOD = 2;

// Phenomenological repetition probability defaults and input precision.
export const REPETITION_STREAMING_DEFAULT_P = 0.02;
export const REPETITION_STREAMING_P_STEP = 0.01;
export const REPETITION_STREAMING_DEFAULT_P_MEAS = 0.02;
export const REPETITION_STREAMING_P_MEAS_STEP = 0.01;
export const REPETITION_STREAMING_DEFAULT_ERASURE_MOVES = 4;
export const REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS = 667;
export const REPETITION_STREAMING_MAX_SLICES = 8;
export const REPETITION_STREAMING_TIMER_BASE = 2;
export const REPETITION_STREAMING_TIMER_GROWTH = 2;
export const REPETITION_STREAMING_MIN_CLOCK_PERIOD = 2;
// Haah previously used the shared clock control's initial value on first load.
export const HAAH_DEFAULT_CLOCK_PERIOD = 6;
export const HAAH_DEFAULT_P = 0.003;
export const HAAH_CODE_CAPACITY_PROBABILITY_STEP = 0.001;
export const HAAH_PROBABILITY_STEP = 0.0001;

// Layered Haah defaults; timers are supplied through opts below.
export const HAAH_STREAMING_DEFAULT_SIZE = HaahStreamingDefaults.HAAH_STREAMING_DEFAULT_SIZE;
export const HAAH_STREAMING_MIN_SIZE = HaahStreamingDefaults.HAAH_STREAMING_MIN_SIZE;
export const HAAH_STREAMING_MAX_SIZE = HaahStreamingDefaults.HAAH_STREAMING_MAX_SIZE;
export const HAAH_STREAMING_DEFAULT_SLICES = HaahStreamingDefaults.HAAH_STREAMING_DEFAULT_SLICES;
export const HAAH_STREAMING_MIN_SLICES = HaahStreamingDefaults.HAAH_STREAMING_MIN_SLICES;
export const HAAH_STREAMING_MAX_SLICES = HaahStreamingDefaults.HAAH_STREAMING_MAX_SLICES;
export const HAAH_STREAMING_DEFAULT_P = HaahStreamingDefaults.HAAH_STREAMING_DEFAULT_P;
export const HAAH_STREAMING_DEFAULT_P_MEAS = HaahStreamingDefaults.HAAH_STREAMING_DEFAULT_P_MEAS;
export const HAAH_STREAMING_FIXED_CLOCK_PERIOD = HaahStreamingDefaults.HAAH_STREAMING_FIXED_CLOCK_PERIOD;
export const HAAH_STREAMING_DEFAULT_ERASURE_MOVES = HaahStreamingDefaults.HAAH_STREAMING_DEFAULT_ERASURE_MOVES;

// X-cube host defaults; the rule modules retain the legacy clock period.
export const XCUBE_DEFAULT_SIZE = 20;
export const XCUBE_MIN_SIZE = 3;
export const XCUBE_MAX_SIZE = 20;
export const XCUBE_DEFAULT_CLOCK_PERIOD = 10;
export const XCUBE_LINEON_DEFAULT_P = 0.02;
export const XCUBE_FRACTON_DEFAULT_P = 0.003;
export const XCUBE_P_STEP = 0.001;
export const XCUBE_MAX_STEPS = 20000;

export const SURFACE2_DEFAULT_P = 0.04;
export const SURFACE_STREAMING_MAX_SIZE = 64;
export const SURFACE_STREAMING_DEFAULT_SLICES = 5;
export const SURFACE_STREAMING_MAX_SLICES = 5;
export const SURFACE_STREAMING_DEFAULT_P = 0.002;
export const SURFACE_STREAMING_DEFAULT_P_MEAS = 0.002;
export const SURFACE_STREAMING_DEFAULT_ERASURE_MOVES = 4;
export const SURFACE_CG_STREAMING_DEFAULT_SIZE = 24;
export const SURFACE_CG_PROTOCOL_DEFAULT_SIZE = 24;
export const SURFACE_CG_STREAMING_DEFAULT_P = 0.0005;
export const SURFACE_CG_STREAMING_DEFAULT_P_MEAS = 0.0005;
export const SURFACE_CG_PROBABILITY_STEP = 0.0001;
export const SURFACE_CG_STREAMING_DEFAULT_ERASURE_MOVES = 4;
export const SURFACE_CG_MAX_SLICES = 3;
export const SURFACE_CG_COARSE_GRAINING_FACTOR = 2;
export const SURFACE_CG_FIXED_TIMER_BOUND = 3;
export const SURFACE_CG_FIXED_SPLIT_PERIOD = 16;
export const SURFACE_CG_PREP_FIXED_TIMER_BOUND = 2;
export const SURFACE_CG_INJECT_FIXED_TIMER_BOUND = 2;
export const SURFACE_CG_SURGERY_Z_FIXED_TIMER_BOUND = 4;
export const SURFACE_CG_PREP_FIXED_SPLIT_PERIOD = 10;
export const SURFACE_CG_INJECT_FIXED_SPLIT_PERIOD = 8;
export const SURFACE_CG_SURGERY_X_FIXED_SPLIT_PERIOD = 12;
export const SURFACE_CG_SURGERY_Z_FIXED_SPLIT_PERIOD = 12;
export const SURFACE_CG_PROTOCOL_DEFAULT_ERASURE_MOVES = 4;
export const SURFACE_STREAMING_PROBABILITY_STEP = 0.001;
export const SURFACE_DEFAULT_CLOCK_PERIOD = 6;
export const SURFACE_DEFAULT_SPLIT_PERIOD = 16;
export const SURFACE_STREAMING_DEFAULT_CLOCK_PERIOD = STREAMING_FIXED_CLOCK_PERIOD;
export const SURFACE_CG_STREAMING_DEFAULT_CLOCK_PERIOD = STREAMING_FIXED_CLOCK_PERIOD;
export const SURFACE_STREAMING_DEFAULT_SPLIT_PERIOD = 16;
export const SURFACE2_MIN_CLOCK_PERIOD = 2;
export const TORIC2_MIN_CLOCK_PERIOD = 2;
export const SURFACE2_MAX_CLOCK_PERIOD = 60;
// For integer q >= 2, q_s_min(q) = 2q + 1; allow the maximum clock.
export const SURFACE2_MAX_SPLIT_PERIOD = 2 * SURFACE2_MAX_CLOCK_PERIOD + 1;
export const SURFACE_STREAMING_MAX_CLOCK_PERIOD = SURFACE2_MAX_CLOCK_PERIOD;
export const SURFACE_STREAMING_MAX_SPLIT_PERIOD = 2 * SURFACE_STREAMING_MAX_CLOCK_PERIOD + 1;

// Both strict inequalities require qs > 2q/(q-1) and qs > 2q.
// floor(bound) + 1 is the smallest integer strictly above both bounds.
export function surface2MinSplitPeriod(q) {
    return Math.floor(Math.max(2 * q / (q - 1), 2 * q)) + 1;
}

// Splitting follows the selected or fixed clock upward only when needed.
// Used by surface configurations with an adjustable splitting period.
export function constrainSurfacePeriods(key, value, currentValues, maxClockPeriod) {
    if (key === 'clockPeriod') {
        const q = Math.min(maxClockPeriod, Math.max(SURFACE2_MIN_CLOCK_PERIOD, value));
        return { clockPeriod: q, qs: Math.max(currentValues.qs, surface2MinSplitPeriod(q)) };
    }
    if (key === 'qs') {
        return Math.max(value, surface2MinSplitPeriod(currentValues.clockPeriod));
    }
    return value;
}

// Round to the nearest multiple (ties up), then clamp to valid multiples.
export function roundToMultiple(L, m, min, max) {
    return Math.min(Math.floor(max / m) * m,
        Math.max(Math.ceil(min / m) * m, Math.round(L / m) * m));
}

// Decoder configurations
// Both surgery sectors share the existing hierarchical controls and rule knobs.
function surgeryDecoderConfig(sector) {
    const xSector = sector === 'x';
    return {
        name: `lattice surgery rough merge (phenomenological, constant-resource-density, ${sector.toUpperCase()}-type stabilizer sector)`,
        title: `lattice surgery on the constant-resource-density surface-code decoder, ${sector.toUpperCase()}-type stabilizer sector`,
        description: xSector
            ? 'Two <span class="nobreak"><i>L</i> × <i>L</i></span> surface-code patches sit side by side, with a vertical rough seam at their condensing boundaries. In the <i>X</i>-type stabilizer sector, merging adds a column of seam checks: the first measured outcomes initialize a seam frame and produce no detector events, while later rounds use ordinary measurement differences. The seam becomes non-absorbing slice by slice after delays proportional to each slice’s update period; an absorbing seam above the final slice collects the remaining seam defects before the frame and surgery outcome are committed. Splitting measures out the seam qubits, removes the seam checks and their detector events, and restores an absorbing seam with the corresponding slice delays. Each patch retains its own hierarchy, and coarse corrections across the seam expand through the physical seam qubits. Operations are separated by at least <span class="nobreak"><i>L</i></span> steps and wait for the previous introduction to finish. The state card reports the seam geometry, the committed outcome, and whether the decoded outcome agrees with the hidden outcome; a rejected merge is reported as indeterminate and ends the run.'
            : 'Two <span class="nobreak"><i>L</i> × <i>L</i></span> surface-code patches sit side by side, with a vertical rough seam. The same physical rough merge is non-condensing in the <i>Z</i>-type stabilizer sector, which this decoder represents internally at a <i>y</i>-edge and displays after a quarter turn. Merging initializes the seam qubits in <span class="nobreak">|0⟩</span> and compares the first modified seam checks with their final pre-merge measurements; the merged geometry is introduced slice by slice with delays set by the slice update periods. Splitting measures out the seam qubits, includes those outcomes in the first post-split detector events, and introduces the split geometry with an additional slice delay. The measured bits are folded into the correction channels, whose final values commit a consistent seam frame. Each patch retains its own hierarchy, and coarse corrections across the seam expand through its physical qubits. Operations are separated by at least <span class="nobreak"><i>L</i></span> steps and wait for the previous introduction to finish. The state card reports the seam geometry and the committed frame.',
        module: '../modules/surface_cg_surgery_htree.js',
        className: xSector ? 'SurfaceCGSurgeryXHTreeDecoder' : 'SurfaceCGSurgeryZHTreeDecoder',
        narrowAspect: xSector ? SURGERY_X_NARROW_CANVAS_ASPECT : SURGERY_Z_NARROW_CANVAS_ASPECT,
        defaultSize: SURGERY_DEFAULT_SIZE,
        maxSize: SURGERY_MAX_SIZE,
        minSize: SURGERY_MIN_SIZE,
        defaultP: SURFACE_CG_STREAMING_DEFAULT_P,
        noiseStop: true,
        surgery: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: SURFACE_CG_STREAMING_DEFAULT_CLOCK_PERIOD,
        fixedClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        minClockPeriod: SURFACE2_MIN_CLOCK_PERIOD,
        maxClockPeriod: SURFACE_STREAMING_MAX_CLOCK_PERIOD,
        constrainSize(L, currentValues) {
            return roundToMultiple(L, SURFACE_CG_COARSE_GRAINING_FACTOR ** currentValues.K,
                this.minSize ?? 3, this.maxSize);
        },
        is3D: false,
        uncoordVariant: false,
        noManualPlacement: true,
        pStep: SURFACE_CG_PROBABILITY_STEP,
        opts: { n: SURFACE_CG_COARSE_GRAINING_FACTOR,
            t0: xSector ? SURFACE_CG_FIXED_TIMER_BOUND : SURFACE_CG_SURGERY_Z_FIXED_TIMER_BOUND,
            qs: xSector ? SURFACE_CG_SURGERY_X_FIXED_SPLIT_PERIOD : SURFACE_CG_SURGERY_Z_FIXED_SPLIT_PERIOD },
        extraParams: [
            { key: 'K', label: 'Slices', default: xSector ? SURGERY_DEFAULT_SLICES : SURGERY_Z_DEFAULT_SLICES, min: 1, max: SURFACE_CG_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: SURFACE_CG_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: SURFACE_CG_PROBABILITY_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: SURFACE_CG_STREAMING_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    };
}

// Preparation and injection keep the hierarchical tab's physical controls.
function protocolDecoderConfig(kind) {
    const injection = kind === 'inject';
    const protocol = injection ? 'injection' : 'preparation';
    return {
        name: `surface code state ${protocol} (phenomenological, constant-resource-density)`,
        title: `constant-resource-density surface-code decoder during state ${protocol}`,
        description: injection
            ? 'In the <i>X</i>-type stabilizer sector diagnostic, |+⟩ is injected at the upper-left <i>q</i><sub>⋆</sub>, with a rising absorbing frame region in the upper-right half. Absorptions flip <i>ψ</i>; splitting precedes upward drift and ordinary decoding. Deterministic-site expiry rejects and restarts. After the hover, <i>ψ</i> is committed. After stop noise and drain, frame consistency compares residual syndrome with <i>ψ</i> on frame checks and zero elsewhere; the <span class="nobreak">X̄ = +1</span> readout proxy checks left-column parity adjusted by pre-round errors. Both proxy the paper’s cluster-based definitions.'
            : 'In the <i>X</i>-type stabilizer sector diagnostic, data qubits are prepared in <span class="nobreak">|+⟩<sup>⊗<i>n</i></sup></span>, so ideal first-round <i>X</i>-check outcomes are deterministic. The first measured syndrome initializes a frame <i>ψ</i> without producing defects. An absorbing wall rises through the coarse slices at <span class="nobreak"><i>T</i><sub><i>k</i></sub> = <i>M</i> ∑<sub><i>j</i>&lt;<i>k</i></sub> <i>t</i><sub><i>j</i></sub></span>; absorbed defects flip <i>ψ</i>. Temporary final-slice timers collect defects during the hover. The wall disappears, <i>ψ</i> is committed, and ordinary decoding resumes. After stop noise and drain, frame consistency compares residual syndrome with <i>ψ</i>; the <span class="nobreak">X̄ = +1</span> readout proxy checks left-column parity adjusted by pre-round errors. These are proxies for the paper’s cluster-based failure definitions.',
        module: '../modules/surface_cg_prep_inject_htree.js',
        className: injection ? 'SurfaceCGInjectHTreeDecoder' : 'SurfaceCGPrepHTreeDecoder',
        narrowAspect: NARROW_HIERARCHICAL_CANVAS_ASPECT,
        defaultSize: SURFACE_CG_PROTOCOL_DEFAULT_SIZE,
        maxSize: SURFACE_STREAMING_MAX_SIZE,
        defaultP: SURFACE_CG_STREAMING_DEFAULT_P,
        noiseStop: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: SURFACE_CG_STREAMING_DEFAULT_CLOCK_PERIOD,
        fixedClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        minClockPeriod: SURFACE2_MIN_CLOCK_PERIOD,
        maxClockPeriod: SURFACE_STREAMING_MAX_CLOCK_PERIOD,
        constrainSize(L, currentValues) {
            return roundToMultiple(L, SURFACE_CG_COARSE_GRAINING_FACTOR ** currentValues.K,
                this.minSize ?? 3, this.maxSize);
        },
        is3D: false,
        uncoordVariant: false,
        noManualPlacement: true,
        pStep: SURFACE_CG_PROBABILITY_STEP,
        opts: { n: SURFACE_CG_COARSE_GRAINING_FACTOR,
            t0: injection ? SURFACE_CG_INJECT_FIXED_TIMER_BOUND : SURFACE_CG_PREP_FIXED_TIMER_BOUND,
            qs: injection ? SURFACE_CG_INJECT_FIXED_SPLIT_PERIOD : SURFACE_CG_PREP_FIXED_SPLIT_PERIOD },
        extraParams: [
            { key: 'K', label: 'Slices', default: SURFACE_CG_PROTOCOL_DEFAULT_SLICES, min: 1, max: SURFACE_CG_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: SURFACE_CG_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: SURFACE_CG_PROBABILITY_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: SURFACE_CG_PROTOCOL_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    };
}

function isHierarchicalPresentation(decoderType) {
    return decoderType === 'surface_cg_htree'
        || decoderType === 'surface_cg_prep' || decoderType === 'surface_cg_inject'
        || decoderType === 'surface_cg_surgery_x' || decoderType === 'surface_cg_surgery_z';
}

const decoderConfigs = {
    'toric2': {
        name: 'toric code (code capacity)',
        title: 'toric-code decoder for code-capacity noise',
        description: 'The toric-code decoder for code-capacity noise corrects a single round of bit-flip errors using a single round of noiseless stabilizer measurement outcomes. Sites carry defects and messages, and links between sites carry qubits. Defects correspond to violated parity checks <span class="nobreak">Z<sub>1</sub>Z<sub>2</sub>Z<sub>3</sub>Z<sub>4</sub> = −1</span>. Each defect sources three types of messages that grow into three different quadrants, respectively, once every clock period. A defect moves left whenever it sees a blue or red message immediately to its left and otherwise moves down whenever it sees a blue or green message immediately below it. Each message channel is erased using a rotated variant of Toom\'s rule, oriented so that erasure proceeds from the direction opposite to growth.',
        module: '../modules/toric2.js',
        className: 'ToricCode2Decoder',
        narrowAspect: NARROW_CODE_CAPACITY_CANVAS_ASPECT,
        defaultSize: 48,
        defaultP: 0.04,
        defaultClockPeriod: 6,
        minClockPeriod: TORIC2_MIN_CLOCK_PERIOD,
        is3D: false,
        uncoordVariant: true,
        maxSteps: 20000, // TASK 4dp: reverted from TASK 4dk's 1000000, back to matching repetition2's own value
    },
    'surface2': {
        name: 'surface code (code capacity)',
        title: 'surface-code decoder for code-capacity noise',
        description: 'The surface-code decoder for code-capacity noise corrects a single round of bit-flip errors using a single round of noiseless stabilizer measurement outcomes. It is the open-boundary analog of the toric-code decoder for code-capacity noise. Defects and messages behave as in the toric-code decoder, except that once every splitting period the lattice “splits” down the middle, and the defects and messages in each half are shifted outward, toward that half’s condensing boundary.',
        module: '../modules/surface2.js',
        className: 'SurfaceCode2Decoder',
        narrowAspect: NARROW_CODE_CAPACITY_CANVAS_ASPECT,
        // TASK 4df: 24 -> 48, matching toric2's own default size (its
        // dynamics are otherwise identical -- see this module's own
        // description above); defaultP/qs checked empirically at 48 and
        // still make sense (see the TASK 4df report).
        defaultSize: 48,
        defaultP: SURFACE2_DEFAULT_P,
        defaultClockPeriod: SURFACE_DEFAULT_CLOCK_PERIOD,
        minClockPeriod: SURFACE2_MIN_CLOCK_PERIOD,
        maxClockPeriod: SURFACE2_MAX_CLOCK_PERIOD,
        is3D: false,
        maxSteps: 20000, // TASK 4dp: reverted from TASK 4dk's 1000000, back to matching repetition2's own value
        extraParams: [
            { key: 'qs', label: 'splitting period', type: 'slider', default: SURFACE_DEFAULT_SPLIT_PERIOD, min: 1, max: SURFACE2_MAX_SPLIT_PERIOD, step: 1 }
        ],
        constrain: constrainSurfacePeriods
    },
    'surface_streaming_3d': {
        name: 'surface code (phenomenological)',
        title: 'surface-code decoder for phenomenological noise',
        description: 'The surface-code decoder for phenomenological noise consists of <i>K</i> coupled code-capacity surface-code decoders, called slices, stacked along an auxiliary dimension. A new defect is inserted in slice <span class="nobreak"><i>k</i> = 0</span> whenever two consecutive stabilizer measurements at the same site disagree. Each slice is a slightly modified version of the code-capacity surface-code decoder. In addition, a defect that survives in slice <span class="nobreak"><i>k</i> &lt; <i>K</i> − 1</span> for <span class="nobreak"><i>t</i><sub><i>k</i></sub> ∼ <i>e</i><sup><i>k</i></sup></span> time steps is promoted to the same spatial location in slice <span class="nobreak"><i>k</i> + 1</span>. Apart from promotion, the slices evolve independently of one another. After each step, the message-erasure rule is applied for several additional time steps, with defects held fixed.',
        module: '../modules/surface_streaming_3d.js',
        className: 'SurfaceStreaming3DDecoder',
        narrowAspect: NARROW_3D_CANVAS_ASPECT,
        defaultSize: 16,
        maxSize: SURFACE_STREAMING_MAX_SIZE,
        defaultP: SURFACE_STREAMING_DEFAULT_P,
        noiseStop: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: SURFACE_STREAMING_DEFAULT_CLOCK_PERIOD,
        fixedClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        minClockPeriod: SURFACE2_MIN_CLOCK_PERIOD,
        maxClockPeriod: SURFACE_STREAMING_MAX_CLOCK_PERIOD,
        is3D: false,
        uncoordVariant: false,
        noManualPlacement: true, // TASK 4ej: no pointerDown/Move/Up gesture protocol of its own
        pStep: SURFACE_STREAMING_PROBABILITY_STEP,
        // Fixed timers and splitting have no inputs, so URL t0/n/qs cannot override them.
        opts: { t0: REPETITION_STREAMING_TIMER_BASE, n: REPETITION_STREAMING_TIMER_GROWTH, qs: SURFACE_STREAMING_DEFAULT_SPLIT_PERIOD },
        extraParams: [
            { key: 'K', label: 'Slices', default: SURFACE_STREAMING_DEFAULT_SLICES, min: 1, max: SURFACE_STREAMING_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: SURFACE_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: SURFACE_STREAMING_PROBABILITY_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: SURFACE_STREAMING_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    },
    'surface_cg_htree': {
        name: 'surface code (phenomenological, constant-resource-density)',
        title: 'constant-resource-density surface-code decoder for phenomenological noise',
        description: 'The constant-resource-density surface-code decoder for phenomenological noise replaces the <i>K</i> full-resolution slices of the translation-invariant decoder with progressively more coarse-grained ones: slice <i>k</i> is a copy of the code-capacity surface-code decoder on an <span class="nobreak">(<i>L</i>/2<sup><i>k</i></sup>) × (<i>L</i>/2<sup><i>k</i></sup>)</span> lattice, and each of its sites is the parent of a <span class="nobreak">2 × 2</span> block of child sites in slice <span class="nobreak"><i>k</i> − 1</span>. The total number of sites, summed over all slices, is <span class="nobreak"><i>O</i>(<i>L</i><sup>2</sup>)</span>, where <i>L</i> is the linear system size. New defects are inserted in slice <span class="nobreak"><i>k</i> = 0</span> whenever two consecutive stabilizer measurements at the same site disagree. Slice <i>k</i> updates once every <span class="nobreak">2<sup><i>k</i></sup></span> time steps, and, for <span class="nobreak"><i>k</i> &lt; <i>K</i> − 1</span>, a defect that survives there for three of its updates is promoted to its current site\'s parent site in slice <span class="nobreak"><i>k</i> + 1</span>. Corrections performed on a coarse-grained slice are expanded back into physical corrections on the original lattice. Sites in different slices are interleaved in the plane, which allows the decoder to be implemented with a constant density of classical bits and a constant density of bounded-bandwidth, bounded-propagation-speed wires. Physically, the <span class="nobreak">2<sup><i>k</i></sup>-step</span> clock delays of the coarse-grained slices can be implemented using only a constant amount of memory by using a constant-bandwidth pulse that travels back and forth along a wire of length <span class="nobreak">∼2<sup><i>k</i></sup></span>.',
        module: '../modules/surface_cg_htree.js',
        className: 'SurfaceCGHTreeDecoder',
        narrowAspect: NARROW_HIERARCHICAL_CANVAS_ASPECT,
        defaultSize: SURFACE_CG_STREAMING_DEFAULT_SIZE,
        maxSize: SURFACE_STREAMING_MAX_SIZE,
        defaultP: SURFACE_CG_STREAMING_DEFAULT_P,
        noiseStop: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: SURFACE_CG_STREAMING_DEFAULT_CLOCK_PERIOD,
        fixedClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        minClockPeriod: SURFACE2_MIN_CLOCK_PERIOD,
        maxClockPeriod: SURFACE_STREAMING_MAX_CLOCK_PERIOD,
        constrainSize(L, currentValues) {
            return roundToMultiple(L, SURFACE_CG_COARSE_GRAINING_FACTOR ** currentValues.K,
                this.minSize ?? 3, this.maxSize);
        },
        is3D: false,
        uncoordVariant: false,
        noManualPlacement: true, // TASK 4ej: no pointerDown/Move/Up gesture protocol of its own
        pStep: SURFACE_CG_PROBABILITY_STEP,
        // Fixed values have no inputs, so URL n/t0/qs cannot override them.
        opts: {
            n: SURFACE_CG_COARSE_GRAINING_FACTOR,
            t0: SURFACE_CG_FIXED_TIMER_BOUND,
            qs: SURFACE_CG_FIXED_SPLIT_PERIOD
        },
        extraParams: [
            { key: 'K', label: 'Slices', default: 3, min: 1, max: SURFACE_CG_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: SURFACE_CG_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: SURFACE_CG_PROBABILITY_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: SURFACE_CG_STREAMING_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    },
    'surface_cg_surgery_x': surgeryDecoderConfig('x'),
    'surface_cg_surgery_z': surgeryDecoderConfig('z'),
    'surface_cg_prep': protocolDecoderConfig('prep'),
    'surface_cg_inject': protocolDecoderConfig('inject'),
    'repetition2': {
        name: 'repetition code (code capacity)',
        title: 'repetition-code decoder for code-capacity noise',
        description: 'The repetition-code decoder for code-capacity noise corrects a single round of bit-flip errors using a single round of noiseless stabilizer measurement outcomes. Sites carry defects and messages, and links between sites carry bits. Defects correspond to violated parity checks <span class="nobreak">Z<sub>i</sub> Z<sub>i+1</sub> = −1</span>. Messages grow rightward once every clock period, and defects move left whenever they see a message to their left. A message at a site is erased whenever there is both no defect at that site and no message to the left of the site.',
        module: '../modules/repetition2.js',
        className: 'RepetitionCode2Decoder',
        defaultSize: 64,
        defaultP: 0.2,
        defaultClockPeriod: 2,
        minClockPeriod: 2, // TASK 4ap: q < 2 is degenerate for this decoder's rule
        is3D: false,
        is1D: true,
        uncoordVariant: true,
        // TASK 4bb originally hid this ('defects are always drawn here, so
        // the checkbox would be a no-op'), but repetition2.js's render()
        // already gates both drawCaDefects() calls (spacetime history and
        // site row) on options.showSyndrome -- TASK 4co re-enables the
        // checkbox to match what the code actually does now.
        hideDisplayOptions: [],
        maxSteps: 20000, // TASK 4bc: runaway-safety valve -- some configurations (e.g. p=0.5) never quiesce at all
        // TASK 4ek: trial -- moves the description card into the
        // right-hand overlay stack (see applyDescriptionPlacement() and
        // repetition2.js's own _layout()/getDescriptionAnchor()/
        // getTitleAnchor()). Remove this line (or set to undefined) to
        // restore today's left-hand placement exactly.
        descriptionPlacement: 'right'
    },
    'repetition_streaming': {
        name: 'repetition code (phenomenological)',
        title: 'repetition-code decoder for phenomenological noise',
        description: 'The repetition-code decoder for phenomenological noise consists of <i>K</i> coupled code-capacity repetition-code decoders, called slices, stacked along an auxiliary dimension. A new defect is inserted in slice <span class="nobreak"><i>k</i> = 0</span> whenever two consecutive stabilizer measurements at the same site disagree. Each slice is a slightly modified version of the code-capacity repetition-code decoder. In addition, a defect that survives in slice <span class="nobreak"><i>k</i> &lt; <i>K</i> − 1</span> for <span class="nobreak"><i>t</i><sub><i>k</i></sub> ∼ <i>e</i><sup><i>k</i></sup></span> time steps is promoted to the same spatial location in slice <span class="nobreak"><i>k</i> + 1</span>. Apart from promotion, the slices evolve independently of one another. After each step, the message-erasure rule is applied for several additional time steps, with defects held fixed.',
        module: '../modules/repetition_streaming.js',
        className: 'RepetitionStreamingDecoder',
        defaultSize: 64,
        defaultP: REPETITION_STREAMING_DEFAULT_P,
        noiseStop: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        fixedClockPeriod: STREAMING_FIXED_CLOCK_PERIOD,
        minClockPeriod: REPETITION_STREAMING_MIN_CLOCK_PERIOD,
        is3D: false,
        is1D: true,
        uncoordVariant: false,
        pStep: REPETITION_STREAMING_P_STEP,
        // Fixed site timers have no inputs, so URL t0/n cannot override them.
        opts: { t0: REPETITION_STREAMING_TIMER_BASE, n: REPETITION_STREAMING_TIMER_GROWTH },
        extraParams: [
            { key: 'K', label: 'Slices', default: 3, min: 1, max: REPETITION_STREAMING_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: REPETITION_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: REPETITION_STREAMING_P_MEAS_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: REPETITION_STREAMING_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    },
    'haah': {
        name: 'Haah\'s code (code capacity)',
        title: 'Haah\'s code decoder for code-capacity noise',
        description: 'The decoder for Haah\'s code under code-capacity noise corrects a single round of bit-flip errors using a single round of noiseless stabilizer measurement outcomes. Loosely speaking, it is a three-dimensional analog of the toric-code decoder for code-capacity noise. Each defect sources messages that grow outward into seven of the eight octants around it (all but the one pointing left, down, and back) once every clock period. Defects that see messages from other defects to their left, bottom, or back are driven in the leftward, downward, and backward directions by local corrective moves, analogous to the way that the toric-code decoder drives defects leftward and downward. Each message channel is erased using a rotated variant of Toom\'s rule, oriented so that erasure proceeds from the direction opposite to growth.',
        module: '../modules/haah.js',
        className: 'HaahCodeDecoder',
        webglStage: true,
        narrowAspect: NARROW_3D_CANVAS_ASPECT,
        defaultSize: 20,
        defaultP: HAAH_DEFAULT_P,
        defaultClockPeriod: HAAH_DEFAULT_CLOCK_PERIOD,
        minSize: 3,
        maxSize: 20,
        is3D: true,
        disabledDisplayOptions: ['messages'],
        uncoordVariant: true,
        maxSteps: 20000, // TASK 4dp: added, matching every other code-capacity tab's own runaway-safety valve
        pStep: HAAH_CODE_CAPACITY_PROBABILITY_STEP,
    },
    'haah_streaming': {
        name: 'Haah\'s code (phenomenological)',
        title: 'Haah\'s-code decoder for phenomenological noise',
        description: 'The Haah\'s-code decoder for phenomenological noise consists of <i>K</i> coupled code-capacity Haah\'s-code decoders, called slices, stacked along an auxiliary dimension. A new defect is inserted in slice <span class="nobreak"><i>k</i> = 0</span> whenever two consecutive stabilizer measurements at the same site disagree. Each slice is a slightly modified version of the code-capacity Haah\'s-code decoder. In addition, a defect that survives in slice <span class="nobreak"><i>k</i> &lt; <i>K</i> − 1</span> for <span class="nobreak"><i>t</i><sub><i>k</i></sub> ∼ <i>e</i><sup><i>k</i></sup></span> time steps is promoted to the same spatial location in slice <span class="nobreak"><i>k</i> + 1</span>. Apart from promotion, the slices evolve independently of one another. After each step, the message-erasure rule is applied for several additional time steps, with defects held fixed.',
        module: '../modules/haah_streaming.js',
        className: 'HaahStreamingDecoder',
        webglStage: true,
        narrowAspect: NARROW_3D_CANVAS_ASPECT,
        defaultSize: HAAH_STREAMING_DEFAULT_SIZE,
        minSize: HAAH_STREAMING_MIN_SIZE,
        maxSize: HAAH_STREAMING_MAX_SIZE,
        defaultP: HAAH_STREAMING_DEFAULT_P,
        noiseStop: true,
        drainTimeoutSteps: REPETITION_STREAMING_DRAIN_TIMEOUT_STEPS,
        errorProbLabel: 'physical error probability',
        defaultClockPeriod: HAAH_STREAMING_FIXED_CLOCK_PERIOD,
        fixedClockPeriod: HAAH_STREAMING_FIXED_CLOCK_PERIOD,
        is3D: true,
        disabledDisplayOptions: ['messages'],
        uncoordVariant: false,
        noManualPlacement: true,
        pStep: HAAH_PROBABILITY_STEP,
        opts: { t0: REPETITION_STREAMING_TIMER_BASE, n: REPETITION_STREAMING_TIMER_GROWTH },
        extraParams: [
            { key: 'K', label: 'Slices', default: HAAH_STREAMING_DEFAULT_SLICES, min: HAAH_STREAMING_MIN_SLICES, max: HAAH_STREAMING_MAX_SLICES, step: 1 },
            { key: 'pMeas', label: 'measurement error probability', default: HAAH_STREAMING_DEFAULT_P_MEAS, min: 0, max: 1, step: HAAH_PROBABILITY_STEP, afterErrorProb: true },
            { key: 'erasureMoves', label: 'extra message erasure moves', default: HAAH_STREAMING_DEFAULT_ERASURE_MOVES, min: 0, max: STREAMING_MAX_ERASURE_MOVES, step: 1 }
        ]
    },
    'xcube_lineon': {
        name: 'X-cube model (code capacity, lineons)',
        title: 'X-cube-model lineon decoder for code-capacity noise',
        description: 'The decoder for the lineon sector of the X-cube model under code-capacity noise corrects a single round of bit-flip errors using a single round of noiseless stabilizer measurement outcomes. Loosely speaking, it is a three-dimensional analog of the toric-code decoder for code-capacity noise. Each defect sources messages that grow outward into all eight octants around it once every clock period. Defects that see messages from other defects to their left, bottom, or back are driven in the leftward, downward, and backward directions by local corrective moves, analogous to the way that the toric-code decoder drives defects leftward and downward. Each message channel is erased using a rotated variant of Toom\'s rule, oriented so that erasure proceeds from the direction opposite to growth.',
        module: '../modules/xcube_lineon2.js',
        className: 'XCubeLineon2Decoder',
        webglStage: true,
        narrowAspect: NARROW_3D_CANVAS_ASPECT,
        defaultSize: XCUBE_DEFAULT_SIZE,
        defaultP: XCUBE_LINEON_DEFAULT_P,
        defaultClockPeriod: XCUBE_DEFAULT_CLOCK_PERIOD,
        minSize: XCUBE_MIN_SIZE,
        maxSize: XCUBE_MAX_SIZE,
        is3D: true,
        showErrorCount: true,
        disabledDisplayOptions: ['messages'],
        uncoordVariant: true,
        maxSteps: XCUBE_MAX_STEPS,
        pStep: XCUBE_P_STEP,
    },
    'xcube_fracton': {
        name: 'X-cube model (code capacity, fractons)',
        title: 'X-cube-model fracton decoder for code-capacity noise',
        description: 'The decoder for the fracton sector of the X-cube model under code-capacity noise corrects a single round of phase-flip errors using a single round of noiseless stabilizer measurement outcomes. Loosely speaking, it is a three-dimensional analog of the toric-code decoder for code-capacity noise. Each defect sources messages that grow outward into all eight octants around it once every clock period. Defects that see messages from other defects to their left, bottom, or back are driven in the leftward, downward, and backward directions by local corrective moves, analogous to the way that the toric-code decoder drives defects leftward and downward. Each message channel is erased using a rotated variant of Toom\'s rule, oriented so that erasure proceeds from the direction opposite to growth.',
        module: '../modules/xcube_fracton2.js',
        className: 'XCubeFracton2Decoder',
        webglStage: true,
        narrowAspect: NARROW_3D_CANVAS_ASPECT,
        defaultSize: XCUBE_DEFAULT_SIZE,
        defaultP: XCUBE_FRACTON_DEFAULT_P,
        defaultClockPeriod: XCUBE_DEFAULT_CLOCK_PERIOD,
        minSize: XCUBE_MIN_SIZE,
        maxSize: XCUBE_MAX_SIZE,
        is3D: true,
        showErrorCount: true,
        disabledDisplayOptions: ['messages'],
        uncoordVariant: true,
        maxSteps: XCUBE_MAX_STEPS,
        pStep: XCUBE_P_STEP,
    }
};

// Initialize on page load
// TASK 4ew: one-time DOM restructuring for the three-pillar trial layout --
// a no-op entirely (not even the body class is added) when the flag is
// off, so the flag-off DOM/layout is byte-for-byte what it was before this
// task. Moves the state card, the legend, and the description card (in
// that fixed order, per this task's own (1) -- not decoder-dependent, so
// this runs exactly once rather than on every loadDecoder() the way
// applyDescriptionPlacement() does) out of their current homes inside
// .canvas-area's two overlay stacks and into the new #right-pillar
// column (or the centre column's description band for ?desc=below).
// Same elements (never cloned/recreated), so every existing
// id-based lookup elsewhere in this file (getElementById('step-count'),
// ('legend-content'), ('decoder-description'), ...) keeps working
// completely unchanged regardless of which ancestor now contains them.
// Adding the body class before initializeCanvas()'s own first
// resizeCanvas() call (see the DOMContentLoaded handler below) matters:
// applyCanvasSize()'s flag-on branch reads .visualization-container's
// clientWidth, which itself depends on .container's grid-template-columns
// already being in 3-column mode (styles.css's own
// body.layout-three-pillars .container override) by the time that first
// measurement happens.
function setupThreePillarLayout() {
    if (!LAYOUT_THREE_PILLARS) return;
    document.body.classList.add('layout-three-pillars');
    const pillar = document.querySelector('.right-pillar');
    if (!pillar) return;
    const infoPanel = document.querySelector('.info-panel');
    const legendEl = document.querySelector('.legend');
    const descriptionPanel = document.querySelector('.description-panel');
    const params = new URLSearchParams(window.location.search);
    const requestedPlacement = params.get('desc');
    requestedBoundaryStyle = params.get('boundary');
    const placement = requestedPlacement === 'below' || requestedPlacement === 'right'
        ? requestedPlacement : DESCRIPTION_PLACEMENT;
    const visualization = document.querySelector('.visualization-container');
    const placeBelow = placement === 'below' && !!visualization;
    document.body.classList.toggle('description-below', placeBelow);
    if (infoPanel) pillar.appendChild(infoPanel);
    if (legendEl) pillar.appendChild(legendEl);
    if (descriptionPanel) {
        if (placeBelow) {
            const band = document.querySelector('.description-band') || document.createElement('section');
            band.className = 'description-band';
            visualization.insertAdjacentElement('afterend', band);
            band.appendChild(descriptionPanel);
        } else {
            pillar.appendChild(descriptionPanel);
        }
    }
    // TASK 4fe: match the description card's full pillar width. An auto
    // width lets flex stretch override the state's fit-content width;
    // legend syncing below leaves these styles alone in this layout.
    for (const card of [infoPanel, legendEl]) {
        if (!card) continue;
        card.style.width = 'auto';
        card.style.alignSelf = 'stretch';
    }
}

// Move the original controls/cards, retaining their handlers and IDs. Comment
// bookmarks restore their exact desktop locations when the breakpoint changes.
function setupNarrowLayout() {
    const media = window.matchMedia(`(max-width: ${NARROW_LAYOUT_MAX_WIDTH}px)`);
    // An initial desktop load needs only a breakpoint listener. Build the
    // disclosure and card bookmarks when a narrow layout is first entered.
    if (!media.matches) {
        const enterNarrow = () => {
            if (!media.matches) return;
            media.removeEventListener('change', enterNarrow);
            setupNarrowLayout();
        };
        media.addEventListener('change', enterNarrow);
        return;
    }
    const container = document.querySelector('.container');
    const visualization = document.querySelector('.visualization-container');
    const controls = document.getElementById('control-panel');
    if (!container || !visualization || !controls) return;
    let toggle;
    const moves = [
        [document.querySelector('.info-panel'), container],
        [document.querySelector('.legend'), container],
        // The preview band remains directly below the animation at every
        // width; the right-placement card keeps its existing narrow order.
        [document.querySelector('.description-band') ? null : document.querySelector('.description-panel'), container],
        [document.getElementById('transport-controls'), visualization],
    ].filter(([element]) => element).map(([element, destination]) => {
        const bookmark = document.createComment('desktop position');
        return { element, destination, bookmark };
    });
    const update = () => {
        // Keep the disclosure entirely out of the desktop DOM, including on
        // first load; preserve its handler/state when crossing the breakpoint.
        if (media.matches) {
            if (!toggle) {
                toggle = document.createElement('button');
                toggle.id = 'controls-toggle';
                toggle.className = 'btn btn-secondary narrow-controls-toggle';
                toggle.type = 'button';
                toggle.textContent = 'show controls';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-controls', controls.id);
                toggle.addEventListener('click', () => {
                    const expanded = controls.classList.toggle('controls-expanded');
                    toggle.textContent = expanded ? 'hide controls' : 'show controls';
                    toggle.setAttribute('aria-expanded', String(expanded));
                });
            }
            controls.prepend(toggle);
        } else {
            toggle?.remove();
        }
        const rootStyle = document.documentElement.style;
        for (const [property, value] of [
            ['--narrow-touch-target', NARROW_TOUCH_TARGET_PX],
            ['--narrow-base-text', NARROW_BASE_TEXT_PX],
            ['--narrow-slider-thumb', NARROW_SLIDER_THUMB_PX],
        ]) {
            if (media.matches) rootStyle.setProperty(property, `${value}px`);
            else if (rootStyle.getPropertyValue(property)) rootStyle.removeProperty(property);
        }
        for (const { element, destination, bookmark } of moves) {
            if (media.matches) {
                if (!bookmark.parentNode) element.before(bookmark);
                destination.appendChild(element);
            } else if (bookmark.parentNode) {
                bookmark.after(element);
                bookmark.remove();
            }
        }
        if (canvas) resizeCanvas();
    };
    media.addEventListener('change', update);
    update();
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("Initializing CA Visualizer...");
    // TASK 4gp: the glyph view takes the original hierarchical option's
    // position. Its base module remains unregistered, like the flat
    // surface-phenomenological and general_cc modules.
    const hierarchicalOption = document.querySelector('#decoder-select option[value="surface_cg_streaming"]');
    if (hierarchicalOption) {
        hierarchicalOption.value = 'surface_cg_htree';
        hierarchicalOption.textContent = decoderConfigs.surface_cg_htree.name;
    }
    setupThreePillarLayout();
    setupNarrowLayout();
    initializeCanvas();
    setupEventListeners();
    // TASK 4ec: armed before applyUrlParamsAndLoad()'s own first
    // loadDecoder()/render() call, so both the font-ready hook and the
    // ResizeObserver are already watching the moment that first render
    // happens -- catching the exact race this task fixes (the first
    // render landing before the web font, and nothing re-rendering when
    // it arrives) rather than only covering renders after this point.
    watchOverlayCardSizes();
    applyUrlParamsAndLoad();
});

// Every run owns a checkpointable PRNG. URL seeds reproduce startup;
// manual initialization gets fresh entropy instead of replaying that seed.
function freshRandomSeed() {
    const words = new Uint32Array(1);
    try {
        if (globalThis.crypto?.getRandomValues) {
            globalThis.crypto.getRandomValues(words);
            return words[0];
        }
    } catch {
        // Keep Initialize available when browser entropy is unavailable.
    }
    return Math.floor(Math.random() * 4294967296);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    const rng = function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.getState = () => a;
    rng.setState = state => { a = state; };
    return rng;
}

// TASK 4ap: shared clamp/round/revert logic for a slider's paired numeric
// input (the animation-speed and clock-period controls; the min/max this
// reads are the input's own attributes, kept in sync with the slider's --
// including any per-decoder override, e.g. repetition2's clock-period
// minimum of 2 -- by loadDecoder()/applyUrlParamsAndLoad(), so this never
// hardcodes a range itself). An <input type="number"> with min/max/step
// attributes does NOT, on its own, clamp an out-of-range typed or pasted
// value or round a non-integer one -- the browser only flags it as
// :invalid via the Constraint Validation API -- so this enforces all of
// that explicitly: non-numeric (or empty) text reverts to the slider's own
// current value (the last value actually applied); a valid number is
// rounded to the nearest integer, then clamped into [min, max]. Writes the
// final value back to both the input and the slider (two-way sync) and
// returns it so the caller can apply it to whatever state the slider
// itself drives (animationSpeed, currentDecoder.clockPeriod, ...).
// TASK 4eh: sliderEl is now optional -- a bare numeric control with no
// paired slider (e.g. a generic integer-stepped extraParam like K) passes
// null, and falls back to inputEl.dataset.lastCommitted (kept in sync
// below on every call, and seeded once at the control's own creation) in
// place of "the slider's own current value" -- reading inputEl.value
// itself as that fallback would be wrong the moment inputEl.value is
// itself the invalid text being rejected.
function clampNumericInput(inputEl, sliderEl) {
    const min = parseFloat(inputEl.min);
    const max = parseFloat(inputEl.max);
    const fallback = sliderEl ? parseFloat(sliderEl.value) : parseFloat(inputEl.dataset.lastCommitted);
    const parsed = parseFloat(inputEl.value.trim());
    let value = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    if (!Number.isFinite(value)) value = Number.isFinite(min) ? min : 0; // unreachable once a caller seeds dataset.lastCommitted at creation; last-resort only
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);
    inputEl.value = value;
    if (sliderEl) sliderEl.value = value;
    if (inputEl.dataset.lastCommitted !== String(value)) inputEl.dataset.lastCommitted = value;
    return value;
}

// TASK 4at: clamping on every keystroke (the old behaviour, wired on the
// 'input' event) fought the user mid-edit -- typing "12" got rewritten
// after the first "1", and briefly clearing the field to retype was
// impossible. Typing is now unconstrained while the field has focus; the
// value commits (via clampNumericInput() above, unchanged) only on Enter
// or on blur/change (a plain text input's native 'change' event already
// fires exactly on blur when the value differs from what it was at focus
// time; the blur listener also catches programmatic edits that do not
// trigger native change). Enter also blurs the field, signalling
// "done"; Escape instead discards the in-progress edit and restores the
// last committed value without blurring, so the user can immediately try
// again -- read from the slider, which (since it's never touched by an
// uncommitted keystroke here) always holds exactly that value. Re-running
// commit() from the 'change' that Enter's own blur() triggers is harmless:
// clamping an already-committed value is idempotent.
// TASK 4aw: digits-only entry. A keydown filter rejects any single
// printable, non-digit character outright (so "2.7"/"-3"/"abc" can never
// be typed at all), while leaving Backspace/Delete/Tab/arrows/Home/End/
// Enter/Escape and any Ctrl/Cmd/Alt-modified shortcut (copy, paste,
// select-all, undo, ...) completely alone -- those either aren't
// single-character key values at all (e.g. 'Shift', 'ArrowLeft') or are
// explicitly allow-listed. Paste (and anything else that mutates the
// value without going through individual keydown events, e.g. drag-drop
// or IME) is instead caught after the fact on 'input' by stripping
// non-digits from whatever landed in the field, preserving the caret
// position as best it can by subtracting only the characters that were
// actually removed from before it.
const DIGITS_ONLY_ALLOWED_KEYS = new Set([
    'Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'Enter', 'Escape',
]);

function sanitizeDigitsOnly(inputEl) {
    // Number inputs accept pasted fractions but expose no selection API.
    // Keep their pending numeric text; commit rounds, then clamps it.
    if (inputEl.type === 'number') return;
    const original = inputEl.value;
    const filtered = original.replace(/[^0-9]/g, '');
    if (filtered === original) return;
    const caret = inputEl.selectionStart ?? filtered.length;
    const removedBefore = caret - original.slice(0, caret).replace(/[^0-9]/g, '').length;
    inputEl.value = filtered;
    const newCaret = Math.max(0, caret - removedBefore);
    inputEl.setSelectionRange(newCaret, newCaret);
}

// TASK 4at: clamping on every keystroke (the old behaviour, wired on the
// 'input' event) fought the user mid-edit -- typing "12" got rewritten
// after the first "1", and briefly clearing the field to retype was
// impossible. Typing is now unconstrained (subject to the digits-only
// filtering above) while the field has focus; the value commits (via
// clampNumericInput() above, unchanged) only on Enter or on blur/change
// (a plain text input's native 'change' event already fires exactly on
// blur when the value differs from what it was at focus time; the blur
// listener also commits programmatic edits that do not trigger native change).
// Enter also blurs the field, signalling "done";
// Escape instead discards the in-progress edit and restores the last
// committed value without blurring, so the user can immediately try
// again -- read from the slider, which (since it's never touched by an
// uncommitted keystroke here) always holds exactly that value. Re-running
// commit() from the 'change' that Enter's own blur() triggers is harmless:
// clamping an already-committed value is idempotent.
function wireCommitOnlyNumericInput(inputEl, sliderEl, onCommit, initializeOnEnter = false) {
    const commit = () => {
        clearStepRedo();
        onCommit(clampNumericInput(inputEl, sliderEl));
    };
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            inputEl.blur();
            // Initialize only from Enter, after blur finishes storing the
            // control; the change/blur listeners never initialize again.
            if (initializeOnEnter) initializeErrors();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            // TASK 4eh: sliderEl may be null (a bare numeric control with
            // no paired slider) -- dataset.lastCommitted is this
            // function's own equivalent "last value actually applied" in
            // that case (see clampNumericInput above).
            inputEl.value = sliderEl ? sliderEl.value : inputEl.dataset.lastCommitted;
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (DIGITS_ONLY_ALLOWED_KEYS.has(e.key)) return;
        if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
            e.preventDefault();
        }
    });
    inputEl.addEventListener('input', () => sanitizeDigitsOnly(inputEl));
    inputEl.addEventListener('change', commit);
    inputEl.addEventListener('blur', commit);
}

// Deferred fields validate through blur before Enter applies Initialize.
// Blur alone stores only; Escape restores the text from focus.
function wireEnterBlurEscape(inputEl) {
    let valueAtFocus = inputEl.value;
    let probabilityAtFocus;
    const isProbability = inputEl.id === 'error-prob' || inputEl.dataset.extraKey === 'pMeas';
    inputEl.addEventListener('focus', () => {
        valueAtFocus = inputEl.value;
        probabilityAtFocus = probabilityInputValues.get(inputEl);
    });
    if (isProbability) inputEl.addEventListener('input', () => probabilityInputValues.delete(inputEl));
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            inputEl.blur(); // triggers this field's own existing change/blur handler naturally
            initializeErrors();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            inputEl.value = valueAtFocus;
            if (isProbability) {
                if (probabilityAtFocus) probabilityInputValues.set(inputEl, probabilityAtFocus);
                syncProbabilityInputs();
            }
        }
    });
}

// TASK 4br: formats a numeric value to a given step's decimal precision
// (0.01 -> 2 decimals, 0.001 -> 3), padding with trailing zeros rather
// than the shortest-round-trip string a plain String(number) would give
// (0.4 -> "0.40", not "0.4") -- toFixed() also strips ordinary binary
// floating-point residue (0.12999999999999998 -> "0.13") as a side effect
// of rounding to that many places. Returns the original value unchanged
// (stringified) if it doesn't parse as a number. Every call site writes
// its result directly (TASK 4by: format once at the moment a value is
// first written, not raw-then-corrected in a later pass) rather than
// reading a field's existing value back out, which is why there's no
// DOM-element wrapper here -- each caller already has the specific
// {value, step} pair it wants formatted (a decoder's config.defaultP and
// config.pStep, or a just-clamped input value and its own live .step).
function formatPValue(value, step) {
    const s = parseFloat(step) || 0.01;
    const decimals = Math.max(0, -Math.floor(Math.log10(s)));
    const v = parseFloat(value);
    return Number.isNaN(v) ? String(value) : v.toFixed(decimals);
}

export const PROBABILITY_DISPLAY_MAX_DECIMALS = 6;

// Count the decimal places of the numeric value, including exponent notation,
// without letting previously padded text keep the pair unnecessarily wide.
function probabilityDecimals(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const [coefficient, exponent = '0'] = String(number).split('e');
    return Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent));
}

export function formatProbabilityValues(p, pMeas, pStep, pMeasStep) {
    const decimals = Math.min(PROBABILITY_DISPLAY_MAX_DECIMALS,
        Math.max(...[pStep, pMeasStep, p, pMeas].map(probabilityDecimals)));
    return { p: Number(p).toFixed(decimals), pMeas: Number(pMeas).toFixed(decimals) };
}

// A capped display can round its text; construction must still receive the
// original number. An actual edit invalidates this record, while repeated
// commits and control rebuilds retain it. Code-capacity inputs never use it.
const probabilityInputValues = new WeakMap();

function probabilityInputValue(input) {
    const stored = probabilityInputValues.get(input);
    return stored && stored.text === input.value ? stored.value : parseFloat(input.value);
}

function syncProbabilityInputs(config = getCurrentDecoderConfig(), overrides = {}) {
    const measurement = config?.extraParams?.find(param => param.key === 'pMeas');
    const physicalInput = document.getElementById('error-prob');
    const measurementInput = document.getElementById('extra-param-pMeas');
    if (!measurement || !physicalInput || !measurementInput) return null;
    const rawP = overrides.p ?? probabilityInputValue(physicalInput);
    const p = Math.min(parseFloat(physicalInput.max), Math.max(parseFloat(physicalInput.min),
        Number.isFinite(rawP) ? rawP : 0.1));
    const pMeas = clampExtraParamValue(measurement, overrides.pMeas ?? probabilityInputValue(measurementInput));
    const text = formatProbabilityValues(p, pMeas, config.pStep ?? 0.01, measurement.step);
    for (const [input, key, value] of [[physicalInput, 'p', p], [measurementInput, 'pMeas', pMeas]]) {
        setControlValue(input, text[key]);
        probabilityInputValues.set(input, { value, text: text[key] });
    }
    return { p, pMeas };
}

// Validation is shared by typed commits, preserved reloads, and URL loads.
// It changes only the controls; construction happens at an explicit boundary.
function validateSizeInput(config) {
    const input = document.getElementById('size-input');
    const raw = parseInt(input?.value, 10);
    const requested = Number.isFinite(raw) ? raw : config.defaultSize;
    const value = typeof config.constrainSize === 'function'
        ? config.constrainSize(requested, getExtraParamsOpts(config))
        : Math.min(config.maxSize ?? 100, Math.max(config.minSize ?? 3, requested));
    if (input && Number(input.value) !== value) input.value = value;
    return value;
}

function commitErrorProb(input) {
    const probabilities = syncProbabilityInputs();
    if (probabilities) return probabilities.p;
    probabilityInputValues.delete(input);
    const parsed = parseFloat(input.value);
    const value = Math.min(parseFloat(input.max), Math.max(parseFloat(input.min),
        Number.isFinite(parsed) ? parsed : 0.1));
    const text = formatPValue(value, input.step);
    if (input.value !== text) input.value = text;
    return parseFloat(text);
}

function setControlValue(input, value) {
    if (!input) return;
    probabilityInputValues.delete(input);
    const text = String(value);
    if (input.value !== text) input.value = text;
    if (input.dataset.lastCommitted !== undefined && input.dataset.lastCommitted !== text) {
        input.dataset.lastCommitted = text;
    }
}

// Reset writes defaults into existing controls, preserving UI preferences.
function restoreDecoderDefaults(config) {
    setControlValue(document.getElementById('size-input'), config.defaultSize);
    const hasMeasurement = config.extraParams?.some(param => param.key === 'pMeas');
    setControlValue(document.getElementById('error-prob'), hasMeasurement
        ? config.defaultP : formatPValue(config.defaultP, config.pStep));
    const clock = document.getElementById('clock-period');
    const q = config.fixedClockPeriod ?? config.defaultClockPeriod ?? clock.defaultValue;
    setControlValue(clock, q);
    setControlValue(document.getElementById('clock-period-value'), q);
    for (const p of config.extraParams || []) {
        const input = document.getElementById(`extra-param-${p.key}`);
        if (p.type === 'bool') {
            if (input) input.checked = !!p.default;
        } else {
            setControlValue(input, p.default);
            setControlValue(document.getElementById(`extra-param-${p.key}-value`), p.default);
        }
    }
    const split = document.getElementById('split-period');
    if (config.hasSplitPeriod && split) {
        setControlValue(split, config.defaultSplitPeriod ?? split.defaultValue);
        updateStatText(document.getElementById('split-period-value'), split.value);
    }
    syncProbabilityInputs(config);
}

// Reuse the loaded class, honoring fixed config values before control inputs.
// No imports, control rendering, legends, or section layout changes here.
function decoderFromControls(config, seed = null, module = currentLoadedModule) {
    const size = validateSizeInput(config);
    const p = commitErrorProb(document.getElementById('error-prob'));
    const clock = document.getElementById('clock-period');
    const clockBox = document.getElementById('clock-period-value');
    const q = applyConstraint('clockPeriod', config.fixedClockPeriod ?? clampNumericInput(clockBox, clock), clock, clockBox);
    // Read extra params after the clock constraint has pushed any peers.
    const opts = getExtraParamsOpts(config);
    for (const param of config.extraParams || []) {
        if (param.type === 'bool' || param.type === 'select' || param.type === 'textarea') continue;
        const input = document.getElementById(`extra-param-${param.key}`);
        if (input && Number(input.value) !== opts[param.key]) setControlValue(input, opts[param.key]);
        if (param.type === 'slider') {
            opts[param.key] = applyConstraint(param.key, opts[param.key], input,
                document.getElementById(`extra-param-${param.key}-value`));
            setControlValue(document.getElementById(`extra-param-${param.key}-value`), opts[param.key]);
        }
    }
    syncProbabilityInputs(config, { p, pMeas: opts.pMeas });
    opts.pPhys = p;
    opts.descriptionPlacement = config.descriptionPlacement;
    opts.seed = seed ?? freshRandomSeed();
    opts.rng = mulberry32(opts.seed);
    // Module-owned gestures use the same live gate and verdict refresh
    // as the shared canvas. Retained 3D viewers keep their original hooks.
    opts.canEditInitialErrors = () => canEditInitialErrors(decoder);
    opts.prepareInitialErrorsEdit = () => prepareInitialErrorsEdit(decoder);
    opts.onInitialErrorsEdited = () => {
        if (decoder !== currentDecoder) return;
        clearStepRedo();
        advanceRequested = false;
        updateStats();
        render();
    };
    const DecoderClass = module[config.className];
    const decoder = new DecoderClass(size, q, opts);
    if (config.hasSplitPeriod && decoder.qPrime !== undefined) {
        decoder.qPrime = parseInt(document.getElementById('split-period').value, 10);
    }
    return decoder;
}

// Reproducible-URL support: ?code=<key>&L=&p=&q=&seed=&init=1&steps=N.
// Load owns initialization for landing URLs, explicit links, and switches.
async function applyUrlParamsAndLoad() {
    const params = new URLSearchParams(window.location.search);
    if ([...params.keys()].length === 0) {
        await loadDecoder(DEFAULT_CODE);
        return;
    }

    const code = params.get('code');
    const decoderType = (code && decoderConfigs[code]) ? code : DEFAULT_CODE;
    const config = decoderConfigs[decoderType];
    // This tab's preview survives Initialize/Reset via its constructor opts.
    const orbStyle = params.get('orbStyle');
    if (decoderType === 'surface_streaming_3d' && (orbStyle === 'disc' || orbStyle === 'sphere')) {
        config.opts = { ...config.opts, orbStyle };
    }

    const decoderSelect = document.getElementById('decoder-select');
    if (decoderSelect) decoderSelect.value = decoderType;

    const sizeInput = document.getElementById('size-input');
    const errorProbInput = document.getElementById('error-prob');
    const clockPeriodSlider = document.getElementById('clock-period');
    const clockPeriodValue = document.getElementById('clock-period-value');

    // Seed every field this decoder cares about with its own defaults first,
    // then let explicit URL params override individual fields -- so a field
    // left unspecified still gets the newly selected decoder's own default
    // rather than whatever a previously loaded decoder left behind.
    if (sizeInput) sizeInput.value = params.get('L') ?? config.defaultSize;
    if (errorProbInput && config.defaultP !== undefined) {
        const value = params.get('p') ?? config.defaultP;
        // Paired probabilities are formatted together once both controls exist.
        setControlValue(errorProbInput, config.extraParams?.some(param => param.key === 'pMeas')
            ? value : formatPValue(value, config.pStep ?? '0.01'));
    }
    if (clockPeriodSlider) {
        const clockMin = config.minClockPeriod ?? 1;
        const clockMax = config.maxClockPeriod ?? 60;
        clockPeriodSlider.min = clockMin;
        clockPeriodSlider.max = clockMax;
        if (clockPeriodValue) { clockPeriodValue.min = clockMin; clockPeriodValue.max = clockMax; }
        const clockDefault = config.fixedClockPeriod ?? config.defaultClockPeriod ?? clockPeriodSlider.value ?? 6;
        // TASK 4ap: a URL &q= below this decoder's own minimum (e.g.
        // repetition2's 2) is clamped up rather than silently producing an
        // out-of-range slider value.
        const rawQ = config.fixedClockPeriod ?? (params.has('q') ? parseInt(params.get('q'), 10) : clockDefault);
        clockPeriodSlider.value = Number.isFinite(rawQ) ? Math.min(clockMax, Math.max(clockMin, rawQ)) : clockDefault;
        if (clockPeriodValue) clockPeriodValue.value = clockPeriodSlider.value;
    }

    // Extra parameters (decoder-specific): render with defaults first (so
    // the inputs exist to override), then let URL params override
    // individual fields, exactly mirroring the built-in fields above.
    renderExtraParams(config, false);
    const extraUrlKeys = {
        K: 'K', t0: 't0', n: 'n', pmeas: 'pMeas', qs: 'qs', erasureMoves: 'erasureMoves',
        // TASK 4al: select/textarea round-trip through URL params the same
        // generic way as every numeric/bool one -- a <select>/<textarea>'s
        // .type is never 'checkbox', so both fall straight into the plain
        // `input.value = ...` branch below with no special-casing needed.
        // codeSpec in particular only round-trips "where short enough" for
        // a URL's own practical length limits to tolerate -- an inherent
        // property of URL-based state, not something this code needs to
        // separately enforce or truncate.
        presetChoice: 'presetChoice', codeSpec: 'codeSpec'
    };
    Object.entries(extraUrlKeys).forEach(([urlKey, optKey]) => {
        if (!params.has(urlKey)) return;
        const input = document.getElementById(`extra-param-${optKey}`);
        if (!input) return;
        if (input.type === 'checkbox') {
            // Bool params: accept 0/1/true/false from the URL.
            const raw = params.get(urlKey).trim().toLowerCase();
            input.checked = raw === '1' || raw === 'true';
        } else {
            // TASK 4eh: a numeric extraParam's own config (min/max/step)
            // clamps a URL-supplied value (e.g. &K=7) before it ever
            // reaches the input's own .value -- getExtraParamsOpts()
            // clamps again right before construction regardless, but this
            // also keeps the control's own displayed value correct from
            // the very first render, matching what a typed-and-committed
            // value would show, and keeps dataset.lastCommitted (read by
            // this control's own Escape handling) in sync. presetChoice/
            // codeSpec aren't numeric (a select value and free text), so
            // they round-trip unchanged as before.
            const paramConfig = config.extraParams.find((param) => param.key === optKey);
            const isNumeric = paramConfig && paramConfig.type !== 'select' && paramConfig.type !== 'textarea';
            if (isNumeric) {
                const clamped = clampExtraParamValue(paramConfig, params.get(urlKey));
                setControlValue(input, clamped);
                input.dataset.lastCommitted = clamped;
            } else {
                input.value = params.get(urlKey);
            }
        }
    });
    syncProbabilityInputs(config);
    // The generic loop above just copies each URL param straight into its
    // control's .value, bypassing onExtraParamChange()'s own glue -- so a
    // URL that sets presetChoice alone (without also setting codeSpec)
    // needs that same "refill the spec textarea from the chosen preset"
    // glue applied here too, or the preset selection would silently do
    // nothing to the spec actually used.
    if (params.has('presetChoice') && !params.has('codeSpec')) {
        const specEl = document.getElementById('extra-param-codeSpec');
        const chosen = params.get('presetChoice');
        if (specEl && PRESETS[chosen] !== undefined) specEl.value = PRESETS[chosen];
    }

    // Seed both construction and Initialize's fresh run. Keep it local to
    // this load so later button clicks and dropdown loads sample normally.
    const parsedSeed = parseInt(params.get('seed'), 10);
    const seed = Number.isNaN(parsedSeed) ? null : parsedSeed;

    // preserveSize=true keeps exactly the values just set above instead of
    // having loadDecoder overwrite them with its own defaulting logic.
    await loadDecoder(decoderType, true, { seed, initialize: params.get('init') === '1' });

    if (params.has('steps')) {
        const n = parseInt(params.get('steps'), 10);
        if (currentDecoder && Number.isFinite(n) && n > 0) {
            for (let i = 0; i < n; i++) {
                if (!stepOnce()) break;
            }
            updateStats();
            render();
        }
    }

}

function initializeCanvas() {
    canvas = document.getElementById('main-canvas');
    if (!canvas) {
        console.error("Canvas element not found!");
        return;
    }
    ctx = canvas.getContext('2d');

    // Set initial canvas size
    resizeCanvas();

    // Mobile browser chrome changes innerHeight while scrolling. Observe the
    // fallback maximum, but only re-layout for width/orientation/DPR changes.
    let viewportWidth = window.innerWidth;
    let viewportOrientation = narrowViewportOrientation();
    window.addEventListener('resize', () => {
        const width = window.innerWidth;
        const orientation = narrowViewportOrientation();
        const sameViewport = width === viewportWidth && orientation === viewportOrientation;
        viewportWidth = width;
        viewportOrientation = orientation;
        if (NARROW_STABLE_VIEWPORT_HEIGHT && isNarrowLayout()) {
            narrowViewportHeight();
            if (sameViewport && canvasPixelRatio === (window.devicePixelRatio || 1)) return;
        } else {
            narrowViewportState = null;
        }
        resizeCanvas();
    });
    // A display/DPR change need not produce a window resize, even paused.
    const watchPixelRatio = () => {
        window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
            .addEventListener('change', () => {
                watchPixelRatio();
                resizeCanvas();
            }, { once: true });
    };
    watchPixelRatio();
}

// TASK 4eg: the "compute cssWidth/cssHeight and apply them to the canvas
// element" work, factored out of resizeCanvas() below so
// relayoutForCardResize() (triggered by a card resizing -- e.g. the real
// font swapping in, which can change a card's real width/height and so
// this decoder's own margins and preferred canvas height -- without the
// viewport itself resizing) can also trigger it, without duplicating this
// logic or disturbing relayoutForCardResize()'s own careful ordering
// (legend-width sync, then this, then render -- see that function's own
// comment for why that order matters).
function applyCanvasSize() {
    const container = document.querySelector('.visualization-container');
    const canvasArea = document.querySelector('.canvas-area');
    if (!container || !canvasArea) return;

    const dpr = window.devicePixelRatio || 1;

    // TASK 4es-b: the canvas fills .canvas-area's own inner width, not a
    // flat 900/940px cap with a -100 reserve for the overlay cards' worst
    // case. This is NOT .visualization-container's own clientWidth --
    // canvasArea.clientWidth is smaller by exactly this element's own
    // padding (var(--sp-5), 20px each side: e.g. 784 vs 744 at a 1600px
    // viewport under TASK 4ew's three-pillar layout, confirmed live) --
    // .canvas-area is a flex CHILD of .visualization-container and so is
    // laid out within that padding, not flush with its border. Landing on
    // container.clientWidth here (an earlier version of this function
    // did, briefly, under TASK 4ew) sets canvas.width (the backing store,
    // below) 40px wider than #main-canvas's own CSS max-width:100% then
    // actually renders it at (100% resolving against .canvas-area, this
    // element's true containing block) -- every decoder's own drawing
    // coordinate system (cssWidth) would then be a few percent wider than
    // the canvas's real on-page width, squishing everything drawn
    // horizontally and throwing off any page-coordinate computation
    // (e.g. updateTitlePosition()'s own canvasRect.left + anchor.centerX)
    // by the same few percent. Querying .canvas-area directly, not
    // deriving it from .visualization-container's own clientWidth,
    // avoids the whole class of bug.
    // TASK 4ew: this is now the SAME computation under either
    // LAYOUT_THREE_PILLARS state -- flag-off's own container/canvas-area
    // padding is unchanged by this task, so this naturally reproduces
    // today's (TASK 4es-b) numbers there, while under the flag
    // .canvas-area is simply wider (styles.css's own three-pillar-scoped
    // .visualization-container max-width), with no overlay cards left to
    // reserve room for either way.
    cssWidth = canvasArea.clientWidth;

    // TASK 4eg: a decoder module can provide its own
    // getPreferredCanvasHeight(canvasWidth, overlayRects) when the shared
    // fixed 650px leaves too much (or too little) room for its own drawn
    // content -- so far, only surface_streaming_3d.js, whose approved
    // stack size left a growing wedge of dead space below the residual
    // layer at K = 1, 2, 3. Passed the same overlayRects every other
    // card-size-aware hook gets (computeOverlayRects(), TASK 4dy), so its
    // own answer can depend on the description card's real position too.
    // Falls back to the shared 650 for every module without that method,
    // exactly as before this task.
    let preferredHeight = 650;
    if (currentDecoder && typeof currentDecoder.getPreferredCanvasHeight === 'function') {
        const overlayRects = computeOverlayRects();
        const preferred = currentDecoder.getPreferredCanvasHeight(cssWidth, overlayRects);
        if (Number.isFinite(preferred) && preferred > 0) preferredHeight = preferred;
    }
    if (isNarrowLayout()) {
        const aspect = decoderConfigs[currentDecoderType]?.narrowAspect ?? NARROW_CANVAS_ASPECT;
        preferredHeight = narrowCanvasHeight(cssWidth, narrowViewportHeight(), aspect);
        if (typeof currentDecoder?.getPreferredNarrowCanvasHeight === 'function') {
            const fitted = currentDecoder.getPreferredNarrowCanvasHeight(cssWidth, preferredHeight);
            if (Number.isFinite(fitted) && fitted > 0) preferredHeight = Math.min(preferredHeight, fitted);
        }
        // Haah's existing WebGL stage shares this height through narrow CSS.
        canvasArea.style.setProperty('--narrow-canvas-height', `${preferredHeight}px`);
    } else {
        if (canvasArea.style.getPropertyValue('--narrow-canvas-height')) {
            canvasArea.style.removeProperty('--narrow-canvas-height');
        }
    }
    cssHeight = preferredHeight;

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvasPixelRatio = dpr;

    // TASK 4eg: #main-canvas's own CSS min-height:500px/max-height:650px
    // (styles.css) exist as a sane safety range for the shared fixed
    // height every other module still uses -- left alone, they'd clamp
    // the explicit height just set above right back toward that range
    // for any module whose own preferred height falls outside it. Pin
    // both to the exact same value as an inline override (inline always
    // wins over a stylesheet rule for the same property, and neither
    // rule uses !important) so height is never fought here, and clear
    // both back to '' -- falling back to the stylesheet's own 500-650 --
    // for every module without a custom preferred height, so their
    // existing safety net is completely unchanged by this task.
    if (isNarrowLayout() || preferredHeight !== 650) {
        canvas.style.minHeight = `${cssHeight}px`;
        canvas.style.maxHeight = `${cssHeight}px`;
    } else {
        canvas.style.minHeight = '';
        canvas.style.maxHeight = '';
    }

    // TASK 4eg: .visualization-container's own CSS min-height:650px keeps
    // that whole card reading as "full height" for every module that
    // fills the shared fixed canvas -- a module with a shorter preferred
    // height needs that floor lifted, or the card (and, since
    // .container's own grid uses align-items:start rather than
    // stretching its rows, .right-column right along with it, being this
    // card's only child) would stay 650px tall with dead space below the
    // now-shorter canvas. Cleared back to '' (the stylesheet's own 650)
    // for every module without a custom preferred height.
    container.style.minHeight = (isNarrowLayout() || preferredHeight !== 650) ? '0' : '';
}

function resizeCanvas() {
    applyCanvasSize();

    // Re-render after resizing
    if (currentDecoder) {
        render();
    }

    // TASK 4bg: keep the legend card's width matched to the stats card's
    // on resize too, per that task's own suggested integration points
    // (the stats card's width doesn't actually depend on viewport size in
    // the current CSS, but this is cheap and defends against that ever
    // changing).
    syncLegendWidthToInfoPanel();
}

function setupEventListeners() {
    // Decoder selection
    const decoderSelect = document.getElementById('decoder-select');
    if (decoderSelect) {
        decoderSelect.addEventListener('change', (e) => {
            // Reset the uncoordinated checkbox when switching codes
            const uncoordCheck = document.getElementById('uncoordinated');
            if (uncoordCheck) uncoordCheck.checked = false;
            loadDecoder(e.target.value);
        });
    }

    // Uncoordinated checkbox
    const uncoordCheck = document.getElementById('uncoordinated');
    if (uncoordCheck) {
        uncoordCheck.addEventListener('change', () => {
            const decoderType = document.getElementById('decoder-select')?.value || currentDecoderType || DEFAULT_CODE;
            loadDecoder(decoderType, true);
        });
    }

    // Blur stores system size; Enter also applies Initialize.
    const sizeInput = document.getElementById('size-input');
    if (sizeInput) {
        const commitSize = () => {
            clearStepRedo();
            validateSizeInput(getCurrentDecoderConfig());
        };
        sizeInput.addEventListener('change', commitSize);
        sizeInput.addEventListener('blur', commitSize);
        wireEnterBlurEscape(sizeInput);
    }

    // Error probability input (TASK 4bl: native type="number" spinner,
    // styled and behaving like size-input -- step/min/max are DOM
    // attributes, kept current per-decoder by loadDecoder() above. No
    // keypress filter is needed any more: type="number" already restricts
    // keystrokes to valid numeric syntax at the browser level, same as
    // size-input has never needed one.)
    const errorProbInput = document.getElementById('error-prob');
    if (errorProbInput) {
        // Validate + commit on blur, change, and Enter (wireEnterBlurEscape
        // below turns Enter into a blur) -- 'change' is included because
        // the native spinner/arrow-key stepping fires it immediately,
        // without waiting for the field to lose focus, and TASK 4br wants
        // that commit point formatted too (e.g. stepping from 0.09 up to
        // 0.10 -- the browser's own stepping produces the shortest string,
        // "0.1", not "0.10"). Firing on both events for a typed-then-blurred
        // edit just reformats the same already-clean value twice; harmless.
        // Paired probabilities share their precision; code-capacity p
        // keeps its existing step-based formatting. The native spinner and arrow-key stepping are
        // already residue-free per the HTML stepping algorithm and already
        // clamp to min/max on their own; this handler exists mainly to
        // catch typed entries and to (re)pad every commit to fixed width.
        errorProbInput.addEventListener('blur', () => { clearStepRedo(); commitErrorProb(errorProbInput); });
        errorProbInput.addEventListener('change', () => { clearStepRedo(); commitErrorProb(errorProbInput); });
        wireEnterBlurEscape(errorProbInput);
    }

    // Clock period slider, paired with its now-editable numeric input
    // (TASK 4ap: two-way sync -- the slider's own 'input' event just
    // mirrors its value into the input, matching the pre-existing
    // behaviour; TASK 4at: the input's own text entry only commits on
    // Enter/blur/change now, via wireCommitOnlyNumericInput() above).
    const clockPeriodSlider = document.getElementById('clock-period');
    const clockPeriodValue = document.getElementById('clock-period-value');
    if (clockPeriodSlider && clockPeriodValue) {
        clockPeriodSlider.addEventListener('input', (e) => {
            clearStepRedo();
            // TASK 4dm: applyConstraint() is a no-op for every decoder
            // without its own constrain(), so this is safe to call
            // here for every tab.
            const newClockPeriod = applyConstraint('clockPeriod', parseInt(e.target.value), clockPeriodSlider, clockPeriodValue);
            clockPeriodValue.value = newClockPeriod;
            console.log(`Clock period changed to: ${newClockPeriod}`);
            commitClockPeriod(newClockPeriod);
        });
        wireCommitOnlyNumericInput(clockPeriodValue, clockPeriodSlider, (newClockPeriod) => {
            newClockPeriod = applyConstraint('clockPeriod', newClockPeriod, clockPeriodSlider, clockPeriodValue);
            console.log(`Clock period changed to: ${newClockPeriod}`);
            commitClockPeriod(newClockPeriod);
        });
        // Every editable clock uses the same rule: blur stores the live
        // period/phase; Enter commits, then applies Initialize exactly once.
        clockPeriodValue.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && getCurrentDecoderConfig()?.fixedClockPeriod === undefined) initializeErrors();
        });
    }

    // Splitting period (q') slider -- unchanged (still a plain read-only
    // span, not one of the two controls TASK 4ap asked for a numeric input
    // next to).
    const splitPeriodSlider = document.getElementById('split-period');
    const splitPeriodValue = document.getElementById('split-period-value');
    const splitPeriodLabel = document.querySelector('label[for="split-period"]');
    if (splitPeriodLabel) splitPeriodLabel.textContent = 'splitting period';
    if (splitPeriodSlider && splitPeriodValue) {
        splitPeriodSlider.addEventListener('input', (e) => {
            clearStepRedo();
            const newQPrime = parseInt(e.target.value);
            splitPeriodValue.textContent = newQPrime;
            console.log(`Splitting period changed to: ${newQPrime}`);
            if (currentDecoder && currentDecoder.qPrime !== undefined) {
                currentDecoder.qPrime = newQPrime;
            }
        });
    }

    // Speed slider, paired with its now-editable numeric input (TASK 4ap;
    // same two-way-sync pattern as clock period above; TASK 4at: commits
    // only on Enter/blur/change, via wireCommitOnlyNumericInput()).
    const speedSlider = document.getElementById('speed-slider');
    const speedValue = document.getElementById('speed-value');
    if (speedSlider && speedValue) {
        speedSlider.value = animationSpeed;
        speedValue.value = animationSpeed;
        speedSlider.addEventListener('input', (e) => {
            animationSpeed = parseInt(e.target.value);
            speedValue.value = animationSpeed;
        });
        wireCommitOnlyNumericInput(speedValue, speedSlider, (newSpeed) => {
            animationSpeed = newSpeed;
        });
    }

    // Control buttons
    const initBtn = document.getElementById('init-btn');
    const stepBtn = document.getElementById('step-btn');
    const backBtn = document.getElementById('step-back-btn');
    const playBtn = document.getElementById('play-btn');
    const playBackBtn = document.getElementById('play-back-btn');
    const playForwardBtn = document.getElementById('play-fwd-btn');
    const transportRow = document.getElementById('transport-controls');
    const resetBtn = document.getElementById('reset-btn');
    const noiseBtn = document.getElementById('noise-btn');

    if (transportRow) transportRow.style.height = `${TRANSPORT_BUTTON_HEIGHT_PX}px`;
    if (initBtn) initBtn.addEventListener('click', initializeErrors);
    if (stepBtn) stepBtn.addEventListener('click', stepSimulation);
    if (backBtn) backBtn.addEventListener('click', stepBackSimulation);
    document.addEventListener('keydown', handleStepKeydown);
    if (playBtn) playBtn.addEventListener('click', togglePlayback);
    if (playBackBtn) playBackBtn.addEventListener('click', togglePlayBack);
    if (playForwardBtn) playForwardBtn.addEventListener('click', playForward);
    if (resetBtn) resetBtn.addEventListener('click', resetSimulation);
    if (noiseBtn) noiseBtn.addEventListener('click', stopNoise);
    document.getElementById('merge-btn')?.addEventListener('click', () => startSurgery('merge'));
    document.getElementById('split-btn')?.addEventListener('click', () => startSurgery('split'));
    for (const radio of document.querySelectorAll('input[name="init-mode"]')) {
        radio.addEventListener('change', handleInitModeChange);
    }

    // Display options
    const showSyndrome = document.getElementById('show-syndrome');
    const showErrors = document.getElementById('show-errors');
    const showMessages = document.getElementById('show-messages');
    const showGrid = document.getElementById('show-grid');

    if (showSyndrome) showSyndrome.addEventListener('change', render);
    if (showErrors) showErrors.addEventListener('change', render);
    if (showMessages) showMessages.addEventListener('change', render);
    if (showGrid) showGrid.addEventListener('change', () => {
        render();
        // Refresh the legend from the already-loaded module; its message
        // borders keep their channel colours with either grid setting.
        const decoderType = document.getElementById('decoder-select')?.value;
        if (decoderType) updateLegend(decoderType, currentLoadedModule);
    });


    // Canvas click for manual error placement
    if (canvas) {
        canvas.addEventListener('click', handleCanvasClick);
        canvas.addEventListener('wheel', handleCanvasWheel, { passive: false });
        // TASK 4ar: pointer-drag protocol (paint / defect-drag gestures),
        // layered alongside the plain click above -- see handleCanvasClick
        // and handleCanvasPointerDown for how the two avoid double-toggling.
        canvas.addEventListener('pointerdown', handleCanvasPointerDown);
        canvas.addEventListener('pointermove', handleCanvasPointerMove);
        canvas.addEventListener('pointerup', handleCanvasPointerUp);
        canvas.addEventListener('pointercancel', handleCanvasPointerUp);
        canvas.addEventListener('pointerleave', handleCanvasPointerUp);
    }
}

// TASK 4l: scroll a decoder's spacetime history (currently only
// repetition2.js defines scrollHistory()) while paused or terminated.
// Ignored entirely while playing, so the view stays pinned to the newest
// row during playback exactly as before; preventDefault() stops the page
// itself from scrolling under the canvas. One wheel "notch" is typically
// ~100 units of deltaY in pixel mode, so /20 gives a handful of rows per
// notch; sign(deltaY) > 0 (scroll down) moves toward older rows, matching
// this module's newest-row-at-the-top convention (scrolling "down" reveals
// what is further down the box, i.e. further into the past).
function commitClockPeriod(period) {
    if (!currentDecoder || period < 1 || currentDecoder.clockPeriod === undefined) return;
    currentDecoder.clockPeriod = period;
    // Normalize the stored clocks, including decoders whose public clock
    // is a read-only view of a per-site array. Preserve run progress.
    if (currentDecoderType === 'toric2') {
        for (const column of currentDecoder.c) {
            for (let i = 0; i < column.length; i++) column[i] %= period;
        }
    } else if (currentDecoderType === 'repetition2') {
        for (let i = 0; i < currentDecoder.clockGrid.length; i++) currentDecoder.clockGrid[i] %= period;
    } else if (Number.isFinite(currentDecoder.clock)) {
        currentDecoder.clock %= period;
    }
    updateStats();
    render();
}

function handleCanvasWheel(event) {
    if (isPlaying || !currentDecoder || typeof currentDecoder.scrollHistory !== 'function') return;
    event.preventDefault();
    const deltaRows = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 20));
    currentDecoder.scrollHistory(deltaRows);
    render();
}

// Generic "extra parameters" mechanism: a decoder config may list
// extraParams: [{key, label, default, min, max, step, type}]; type is
// 'number' (the default -- omit the field), 'bool', 'select', 'textarea',
// or 'slider' (TASK 4dg: a range input paired with a commit-only typed
// value box, styled and behaving exactly like the clock-period control --
// see renderExtraParams()'s own 'slider' branch). This renders the
// matching control per entry (hidden entirely for decoders without any),
// and getExtraParamsOpts() reads their current values back into a
// {key: value} object passed as the constructor's third argument. Typed
// construction parameters stay in the controls until Initialize; sliders
// live-mutate a supported decoder property without rebuilding anything.
// TASK 4al: funnels every extra-param control's change through one place,
// so the preset dropdown (general_cc's `presetChoice`) can do its extra
// glue -- refilling the codeSpec textarea, and seeding the size input with
// the preset's own recommended default (16 for the 2D toric preset, 8 for
// the 3D ones), hooked on the very same event rather than a decoderType
// special-case inside loadDecoder(). These values are also deferred.
function onExtraParamChange(p, el) {
    clearStepRedo();
    if (p.key === 'presetChoice') {
        const specEl = document.getElementById('extra-param-codeSpec');
        if (specEl && PRESETS[el.value] !== undefined) specEl.value = PRESETS[el.value];
        const sizeInput = document.getElementById('size-input');
        if (sizeInput) sizeInput.value = (el.value === 'toric2d') ? 16 : 8;
    }
    // A committed parameter may change the permitted sizes. Store the
    // rounded size now; Enter/Initialize applies both pending values.
    const config = getCurrentDecoderConfig();
    if (typeof config?.constrainSize === 'function') validateSizeInput(config);
}

// TASK 4dn: exactly one of three sections -- #extra-params-container,
// the "mode" .control-group (#uncoordinated-row), or the "clock period"
// .control-group -- is the actual last VISIBLE section in the left
// column for the current decoder, and it needs .last-visible-section
// (styles.css) so it shows no trailing divider, matching every other
// section's own :last-child behaviour. Pure CSS can't express this:
// #extra-params-container is always the true last DOM child now (empty
// or not), so neither "mode" nor "clock period" is ever a real
// :last-child to hang a :last-child rule off, and :not(:empty) alone
// can't account for "mode" being hidden too. Priority, checked in this
// order: #extra-params-container whenever it has any children (an
// extraParam group), else "mode" whenever config.uncoordVariant made it
// visible, else "clock period" (always visible, the fallback). Called
// from renderExtraParams() below (both exit paths), since every code
// path that could change any of these three sections' own visibility --
// loadDecoder() setting uncoordRow.style.display, or extraParams content
// itself -- already calls renderExtraParams() afterward.
function updateSectionDividers() {
    // A group inside this middle container is still followed by clock
    // period, even when :last-child would suppress its own divider.
    const probabilityGroup = document.getElementById('error-prob')?.closest('.control-group');
    if (probabilityGroup) {
        const sectionStyle = getComputedStyle(probabilityGroup);
        document.querySelectorAll('#after-error-prob-params-container > .control-group').forEach((group) => {
            group.style.borderBottom = sectionStyle.borderBottom;
            group.style.marginBottom = sectionStyle.marginBottom;
            group.style.paddingBottom = sectionStyle.paddingBottom;
        });
    }
    const extraParams = document.getElementById('extra-params-container');
    const modeGroup = document.getElementById('uncoordinated-row');
    const clockGroup = document.getElementById('clock-period')?.closest('.control-group');

    if (modeGroup) modeGroup.classList.remove('last-visible-section');
    if (clockGroup) clockGroup.classList.remove('last-visible-section');

    if (extraParams && extraParams.children.length > 0) {
        return; // extra-params-container itself is last; needs no class (it's a bare div, not a .control-group)
    }
    // TASK 4do: explicitly re-checked here (not just relying on
    // loadDecoder() already having forced uncoordRow.style.display to
    // 'none') so this function's own correctness doesn't depend on
    // running after that -- while async mode is disabled site-wide, the
    // mode section is always treated as hidden, so clock period (or
    // extra-params-container, handled above) is the last visible section.
    if (ASYNC_MODE_ENABLED && modeGroup && modeGroup.style.display !== 'none') {
        modeGroup.classList.add('last-visible-section');
        return;
    }
    if (clockGroup) clockGroup.classList.add('last-visible-section');
}

// TASK 4eh: shared numeric-extraParam clamp, using only a param config
// object's own min/max/step/default -- reused at every point a value can
// enter one of these controls (the control's own creation with a
// preserved or default value, a URL parameter written straight into
// .value, and this file's own last line of defense in
// getExtraParamsOpts() right before a decoder is constructed) so an
// out-of-range number can never reach a decoder regardless of which path
// it arrived through. Rounds to the nearest integer only when this
// param's own step is a whole number (its own declared granularity --
// e.g. K's step:1); a decimal-step param (pMeas's step:0.001) is left as
// a plain float, just clamped into [min, max]. Falls back to the param's
// own default when the raw value isn't a finite number at all (an empty
// or non-numeric field, or a non-numeric URL parameter).
function clampExtraParamValue(p, rawValue) {
    let value = parseFloat(rawValue);
    if (!Number.isFinite(value)) value = p.default;
    const step = p.step !== undefined ? parseFloat(p.step) : 1;
    if (Number.isFinite(step) && Number.isInteger(step)) value = Math.round(value);
    if (p.min !== undefined) value = Math.max(p.min, value);
    if (p.max !== undefined) value = Math.min(p.max, value);
    return value;
}

// TASK 4eh: true for a generic numeric extraParam whose own declared
// step is a whole number (the common case -- K, t0, n, T_future,
// erasureMoves, ...) as opposed to a decimal one (pMeas's step:0.001).
// Selects which commit-time UI treatment renderExtraParams() below wires
// up: an integer-stepped control gets the exact same digits-only,
// commit-only, round-and-clamp treatment as the clock-period/animation-
// speed boxes (wireCommitOnlyNumericInput), which would silently strip
// the decimal point out of a decimal-stepped control's typed value, so
// those instead get the gentler wireEnterBlurEscape plus a plain clamp
// on commit.
function isIntegerStepParam(p) {
    const step = p.step !== undefined ? parseFloat(p.step) : 1;
    return Number.isFinite(step) && Number.isInteger(step);
}

function renderExtraParams(config, preserveValues) {
    const container = document.getElementById('extra-params-container');
    if (!container) return;
    const afterErrorProbContainer = document.getElementById('after-error-prob-params-container');
    const containers = [container, afterErrorProbContainer].filter(Boolean);

    const prevValues = {};
    if (preserveValues) {
        containers.forEach((paramContainer) => paramContainer.querySelectorAll('input[data-extra-key], select[data-extra-key], textarea[data-extra-key]').forEach((inp) => {
            prevValues[inp.dataset.extraKey] = inp.dataset.extraType === 'bool' ? inp.checked
                : inp.dataset.extraKey === 'pMeas' ? probabilityInputValue(inp) : inp.value;
        }));
    }

    containers.forEach((paramContainer) => { paramContainer.innerHTML = ''; });
    const params = config.extraParams;
    if (!params || params.length === 0) {
        updateSectionDividers();
        return;
    }

    params.forEach((p) => {
        const targetContainer = (p.afterErrorProb && afterErrorProbContainer) ? afterErrorProbContainer : container;
        const group = document.createElement('div');

        if (p.type === 'select') {
            group.className = 'control-group';
            const label = document.createElement('label');
            label.className = 'control-label';
            label.setAttribute('for', `extra-param-${p.key}`);
            label.textContent = p.label;
            const select = document.createElement('select');
            select.id = `extra-param-${p.key}`;
            select.className = 'control-input';
            select.dataset.extraKey = p.key;
            select.dataset.extraType = 'select';
            p.options.forEach((o) => {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.label;
                select.appendChild(opt);
            });
            select.value = (preserveValues && prevValues[p.key] !== undefined) ? prevValues[p.key] : p.default;
            group.appendChild(label);
            group.appendChild(select);
            select.addEventListener('change', () => onExtraParamChange(p, select));
            targetContainer.appendChild(group);
            return;
        }

        if (p.type === 'textarea') {
            group.className = 'control-group';
            const label = document.createElement('label');
            label.className = 'control-label';
            label.setAttribute('for', `extra-param-${p.key}`);
            label.textContent = p.label;
            const textarea = document.createElement('textarea');
            textarea.id = `extra-param-${p.key}`;
            textarea.className = 'control-input';
            textarea.rows = p.rows || 4;
            textarea.style.fontFamily = 'var(--font-mono)';
            textarea.style.resize = 'vertical';
            textarea.dataset.extraKey = p.key;
            textarea.dataset.extraType = 'textarea';
            textarea.value = (preserveValues && prevValues[p.key] !== undefined) ? prevValues[p.key] : p.default;
            group.appendChild(label);
            group.appendChild(textarea);
            textarea.addEventListener('change', () => onExtraParamChange(p, textarea));
            targetContainer.appendChild(group);
            return;
        }

        if (p.type === 'slider') {
            // TASK 4dg: generic slider + commit-only typed value box,
            // matching the clock-period control's own markup and
            // behaviour exactly (same .slider/.slider-value CSS classes
            // and structure; same wireCommitOnlyNumericInput commit
            // semantics below -- free typing while focused, digits-only
            // filtering, Enter/blur commits with round+clamp, Escape
            // reverts to the slider's own last-committed value). Any
            // numeric extraParam can opt into this styling by giving its
            // config entry type: 'slider' (with min/max/step/default)
            // instead of the plain type: 'number' input below.
            group.className = 'control-group';
            const label = document.createElement('label');
            label.className = 'control-label';
            label.setAttribute('for', `extra-param-${p.key}`);
            label.textContent = p.label;

            const sliderContainer = document.createElement('div');
            sliderContainer.className = 'slider-container';

            // The slider itself is the canonical element (id
            // extra-param-${p.key}, with data-extra-key/data-extra-type)
            // -- getExtraParamsOpts()'s generic numeric fallback
            // (parseFloat on this element's own .value) and
            // renderExtraParams()'s own preserveValues bookkeeping both
            // read/restore through it unchanged, exactly like the plain
            // type:'number' branch below. The paired value box is a pure
            // UI mirror with no data-extra-key of its own, matching how
            // clock-period-value sits entirely outside the generic
            // extraParams accounting.
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `extra-param-${p.key}`;
            slider.className = 'slider';
            slider.dataset.extraKey = p.key;
            slider.dataset.extraType = 'slider';
            if (p.min !== undefined) slider.min = p.min;
            if (p.max !== undefined) slider.max = p.max;
            if (p.step !== undefined) slider.step = p.step;
            slider.value = (preserveValues && prevValues[p.key] !== undefined) ? prevValues[p.key] : p.default;

            const valueBox = document.createElement('input');
            valueBox.type = 'text';
            valueBox.inputMode = 'numeric';
            valueBox.pattern = '[0-9]*';
            valueBox.id = `extra-param-${p.key}-value`;
            valueBox.className = 'slider-value';
            if (p.min !== undefined) valueBox.min = p.min;
            if (p.max !== undefined) valueBox.max = p.max;
            if (p.step !== undefined) valueBox.step = p.step;
            valueBox.value = slider.value;

            sliderContainer.appendChild(slider);
            sliderContainer.appendChild(valueBox);
            group.appendChild(label);
            group.appendChild(sliderContainer);

            // TASK 4dg: matches the clock-period slider's own update
            // mechanism exactly -- dragging the slider or committing the
            // typed box mutates the live decoder's own p.key property
            // directly (no reload), rather than going through
            // onExtraParamChange()'s deferred-control path every other
            // extraParam type uses below. Chosen so "exactly like clock
            // period" holds for behaviour, not just styling -- qs is read
            // fresh every step (this.stepCount % this.qs), so live-
            // mutating it is exactly as safe as live-mutating clockPeriod
            // already is, and avoids resetting an in-progress run just to
            // retune the splitting cadence.
            // TASK 4dm: applyConstraint() applies the current decoder
            // config's own optional cross-control constraint (e.g.
            // surface2's q/q_s inequality) -- a no-op for every config
            // without one, so unconditionally safe here for every tab
            // this control type is ever used on.
            slider.addEventListener('input', (e) => {
                clearStepRedo();
                const newVal = applyConstraint(p.key, parseInt(e.target.value, 10), slider, valueBox);
                valueBox.value = newVal;
                if (currentDecoder && currentDecoder[p.key] !== undefined) {
                    currentDecoder[p.key] = newVal;
                }
            });
            wireCommitOnlyNumericInput(valueBox, slider, (newVal) => {
                newVal = applyConstraint(p.key, newVal, slider, valueBox);
                if (currentDecoder && currentDecoder[p.key] !== undefined) {
                    currentDecoder[p.key] = newVal;
                }
            });

            targetContainer.appendChild(group);
            return;
        }

        const isBool = p.type === 'bool';
        const input = document.createElement('input');
        input.id = `extra-param-${p.key}`;
        input.dataset.extraKey = p.key;
        input.dataset.extraType = isBool ? 'bool' : 'number';

        if (isBool) {
            group.className = 'control-group checkbox-group';
            input.type = 'checkbox';
            input.checked = (preserveValues && prevValues[p.key] !== undefined) ? !!prevValues[p.key] : !!p.default;

            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const span = document.createElement('span');
            span.textContent = p.label;
            label.appendChild(input);
            label.appendChild(span);
            group.appendChild(label);
        } else {
            group.className = 'control-group';
            input.type = 'number';
            input.className = 'control-input';
            if (p.min !== undefined) input.min = p.min;
            if (p.max !== undefined) input.max = p.max;
            if (p.step !== undefined) input.step = p.step;
            // TASK 4eh: clamped even for the initial value -- a preserved
            // value can carry over from a different decoder's own range
            // for the same key, so this control must never display (or
            // hand a decoder) a value outside its own declared [min, max]
            // even before any commit. dataset.lastCommitted seeds
            // wireCommitOnlyNumericInput/clampNumericInput's own no-slider
            // fallback below (see those functions' comments) so an Escape
            // press before any edit has a valid value to revert to.
            const rawValue = (preserveValues && prevValues[p.key] !== undefined) ? prevValues[p.key] : p.default;
            const initialValue = clampExtraParamValue(p, rawValue);
            // Keep valid preserved text too (e.g. "0.10"), not just its number.
            input.value = initialValue === parseFloat(rawValue) ? rawValue : initialValue;
            input.dataset.lastCommitted = input.value;

            const label = document.createElement('label');
            label.className = 'control-label';
            label.setAttribute('for', `extra-param-${p.key}`);
            label.textContent = p.label;
            group.appendChild(label);
            group.appendChild(input);
        }

        if (isBool) {
            input.addEventListener('change', () => onExtraParamChange(p, input));
        } else if (isIntegerStepParam(p)) {
            // TASK 4eh: exactly the clock-period/animation-speed boxes'
            // own commit-only, digits-only, round-and-clamp treatment --
            // this control has no paired slider, which
            // wireCommitOnlyNumericInput/clampNumericInput now both
            // tolerate (null sliderEl).
            wireCommitOnlyNumericInput(input, null, () => onExtraParamChange(p, input), true);
        } else {
            // TASK 4eh: a decimal-stepped generic param (e.g. pMeas,
            // step:0.001) must not go through digits-only filtering (it
            // would strip the decimal point) or be rounded to a whole
            // number -- clamp its magnitude only. Wired on both 'blur'
            // and 'change' directly, exactly like error-prob's own
            // established commitErrorProb pattern just above (not
            // 'change' alone): wireEnterBlurEscape's Enter handler first
            // calls inputEl.blur(), and a browser only fires a NATIVE
            // 'change' from that blur when its own dirty-tracking
            // considers the value genuinely edited since focus (true for
            // a real keystroke-typed edit, but not guaranteed for a value
            // set programmatically) -- a direct 'blur' listener fires
            // unconditionally instead, so commit isn't at the mercy of
            // that tracking. Firing both for one edit just re-clamps an
            // already-clamped value a second time; harmless and already this codebase's own
            // pattern (see wireCommitOnlyNumericInput's identical note).
            const commit = () => {
                if (p.key === 'pMeas') syncProbabilityInputs(config);
                else input.value = clampExtraParamValue(p, input.value);
                input.dataset.lastCommitted = input.value;
                onExtraParamChange(p, input);
            };
            input.addEventListener('change', commit);
            input.addEventListener('blur', commit);
            wireEnterBlurEscape(input);
        }

        targetContainer.appendChild(group);
    });

    syncProbabilityInputs(config);
    updateSectionDividers();
}

function getExtraParamsOpts(config) {
    const opts = { ...config.opts };
    if (!config.extraParams) return opts;
    config.extraParams.forEach((p) => {
        const input = document.getElementById(`extra-param-${p.key}`);
        if (!input) return;
        if (p.type === 'bool') {
            opts[p.key] = input.checked;
        } else if (p.type === 'select' || p.type === 'textarea') {
            opts[p.key] = input.value;
        } else {
            // TASK 4eh: clamp here too, not just at each control's own
            // commit-time wiring in renderExtraParams() above -- this
            // function is the one place every entry point funnels through
            // right before a decoder is constructed (a URL parameter or a
            // value preserved across a reload can land in the input's own
            // .value without ever going through that control's own commit
            // handler), so this is the actual guarantee that an
            // out-of-range value can never reach a decoder regardless of
            // how it got into the DOM.
            opts[p.key] = clampExtraParamValue(p, p.key === 'pMeas' ? probabilityInputValue(input) : input.value);
        }
    });
    return opts;
}

// TASK 4dm: applies a decoder config's own optional
// constrain(key, value, currentValues, maxClockPeriod) hook -- e.g. surface2's own
// 1/q + 2/q_s < 1 -- to a value that was just set on `key` (either
// 'clockPeriod' or an extraParam's own key), called from both the clock-
// period control's wiring and the generic 'slider' extraParam wiring
// below. Fixed clocks are enforced even without a constrain() hook.
// Otherwise a config without a hook leaves `value` untouched. `currentValues` is
// built generically -- clockPeriod plus every extraParam, read fresh
// from the DOM via getExtraParamsOpts() -- so a config's own constrain()
// can read whatever OTHER control it needs by name without this shared
// code hardcoding any decoder-specific key; `key` is included too, set
// to `value` itself, for a constrain() that wants to read it generically
// rather than via the separate `value` parameter. The result is either
// a scalar for `key`, or a map of values including `key` and any peers
// that must follow it. Sync peer sliders, boxes, and live properties as
// a direct edit would; return `key`'s final value for the caller to apply.
function applyConstraint(key, value, sliderEl, valueEl) {
    const config = getCurrentDecoderConfig();
    if (!config) return value;
    if (key === 'clockPeriod' && config.fixedClockPeriod !== undefined) {
        value = config.fixedClockPeriod;
        setControlValue(sliderEl, value);
        setControlValue(valueEl, value);
    }
    if (typeof config.constrain !== 'function') return value;
    const clockPeriodEl = document.getElementById('clock-period');
    const currentValues = Object.assign(
        { clockPeriod: config.fixedClockPeriod ?? (clockPeriodEl ? parseInt(clockPeriodEl.value, 10) : undefined) },
        getExtraParamsOpts(config)
    );
    currentValues[key] = value; // the control actually being changed, at its just-set value
    const result = config.constrain(key, value, currentValues, config.maxClockPeriod);
    const updates = typeof result === 'number' ? { [key]: result } : result;
    for (const [updatedKey, updatedValue] of Object.entries(updates)) {
        if (updatedKey === key) {
            setControlValue(sliderEl, updatedValue);
            setControlValue(valueEl, updatedValue);
        } else {
            const id = updatedKey === 'clockPeriod' ? 'clock-period' : `extra-param-${updatedKey}`;
            setControlValue(document.getElementById(id), updatedValue);
            setControlValue(document.getElementById(`${id}-value`), updatedValue);
            if (currentDecoder && currentDecoder[updatedKey] !== undefined) {
                currentDecoder[updatedKey] = updatedValue;
            }
        }
    }
    syncProbabilityInputs(config);
    return updates[key];
}

async function loadDecoder(decoderType, preserveSize = false, { seed = null, initialize = false } = {}) {
    const loadToken = ++decoderLoadToken;
    clearStepHistory();

    // Stop any running animation
    if (isPlaying) {
        stopPlayback();
    }

    // TASK 4ej: a manual-mode paint/defect-drag gesture left "active" on
    // the previous decoder (activePointerId non-null, canvas.
    // setPointerCapture still held from that decoder's own
    // handleCanvasPointerDown) must not persist across a switch -- the
    // canvas element itself is the same one throughout, so a stuck
    // capture would otherwise survive into the new decoder and silently
    // reject its very first pointerdown (handleCanvasPointerMove/Down's
    // own activePointerId guards below), with no visible symptom
    // pointing at why. Declared further down in this file (activePointerId,
    // near handleCanvasPointerDown) but safe to reference here: this
    // function only ever runs later, from an event handler or
    // DOMContentLoaded, never during the module's own top-level
    // execution, by which point that declaration has already run.
    if (activePointerId !== null) {
        if (canvas) { try { canvas.releasePointerCapture(activePointerId); } catch (e) { /* ignore */ } }
        activePointerId = null;
    }

    // Clean up previous decoder if it has a dispose method
    if (currentDecoder && typeof currentDecoder.dispose === 'function') {
        currentDecoder.dispose();
    }
    currentDecoder = null;
    currentDecoderType = null;
    currentLoadedModule = null;
    updateNoiseButton();

    // Clear the canvas so stale content doesn't flash during async load
    if (ctx && canvas) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const config = decoderConfigs[decoderType];
    if (!config) {
        console.error(`Unknown decoder type: ${decoderType}`);
        return;
    }

    // TASK 4ek: pure DOM restructuring (moves the description card
    // in/out of the right-hand overlay stack and widens/unwidens the
    // three cards accordingly), independent of the decoder instance
    // itself -- run early, before renderExtraParams()/the eventual
    // applyCanvasSize()+render() below, so computeOverlayRects() and the
    // decoder's own _layout() already see the correct, final card
    // geometry for this tab on their very first read rather than a stale
    // one from whatever tab was active before.
    //
    // TASK 4ew: skipped entirely under the three-pillar layout -- this
    // function's whole job is choosing which OVERLAY wrapper
    // (.description-stack vs. .overlay-stack) the description card
    // lives in, and repositioning/resizing the three cards to match; none
    // of that applies any more once the card permanently lives in
    // #right-pillar instead (moved there once, at startup, by
    // setupThreePillarLayout()), regardless of which decoder's config
    // this is. Left running completely unchanged for the flag-off case.
    if (!LAYOUT_THREE_PILLARS) applyDescriptionPlacement(config);

    // Show/hide the uncoordinated checkbox based on whether this decoder
    // supports it -- TASK 4do: also gated on ASYNC_MODE_ENABLED, so the
    // "mode" section stays hidden on every tab regardless of
    // config.uncoordVariant while async mode is disabled site-wide.
    const uncoordRow = document.getElementById('uncoordinated-row');
    const uncoordCheck = document.getElementById('uncoordinated');

    // Show/hide the splitting period (q') slider
    const splitPeriodRow = document.getElementById('split-period-row');
    if (splitPeriodRow) splitPeriodRow.style.display = config.hasSplitPeriod ? '' : 'none';
    if (uncoordRow) uncoordRow.style.display = (ASYNC_MODE_ENABLED && config.uncoordVariant) ? '' : 'none';

    // TASK 4bb: a decoder can name Display checkboxes that are meaningless
    // for it (config.hideDisplayOptions, a list of logical option names --
    // repetition2 always draws its defects, making that checkbox a no-op
    // toggle) -- hide that checkbox's whole label and force its underlying
    // value on, and show every other decoder's checkboxes again, so this
    // never "sticks" across a tab switch. render()'s existing
    // `?.checked ?? true` reads for these options need no changes: forcing
    // the checkbox's own .checked here is what actually drives them.
    const DISPLAY_OPTION_IDS = { syndromes: 'show-syndrome', errors: 'show-errors', messages: 'show-messages', grid: 'show-grid' };
    const hiddenDisplayOptions = new Set(config.hideDisplayOptions || []);
    // Disabled options stay visible and retain their checked state;
    // assign every option on each load so disabling never survives a tab switch.
    const disabledDisplayOptions = new Set(config.disabledDisplayOptions || []);
    for (const [name, checkboxId] of Object.entries(DISPLAY_OPTION_IDS)) {
        const labelEl = document.getElementById(`${checkboxId}-label`);
        const checkboxEl = document.getElementById(checkboxId);
        const hidden = hiddenDisplayOptions.has(name);
        if (labelEl) labelEl.style.display = hidden ? 'none' : '';
        if (checkboxEl) checkboxEl.disabled = disabledDisplayOptions.has(name);
        if (!preserveSize && hidden && checkboxEl) checkboxEl.checked = true;
    }

    // TASK 4al: general_cc's toggleErrorAtPosition() is a documented no-op
    // (a general code's Pauli components at a clicked cell have no single
    // canonical choice to toggle) -- disable the "manual" init-mode radio
    // for such a decoder rather than leaving a control that silently does
    // nothing, forcing the mode back to "random" first if it was selected.
    // TASK 4ej: also hide its whole label (not just grey out the input)
    // for a decoder with no pointer-gesture protocol at all (the
    // surface_streaming_3d and surface_cg_streaming decoders have no pointerDown/
    // Move/Up of their own, unlike general_cc, which at least has a
    // (documented no-op) toggleErrorAtPosition() click fallback to leave
    // visibly disabled). The "initial errors" heading, its own divider,
    // and the "random" option are untouched. TASK 4eu: the manual
    // option's own label (input + text) now STAYS VISIBLE, greyed out via
    // the disabled input alone (see .radio-label:has(input:disabled) in
    // styles.css) -- reverting TASK 4ej's own display:none, per the
    // user's own preference for a visibly-present-but-unselectable option
    // over a hidden one. A disabled <input> already can't be checked or
    // clicked into by the user (native browser behaviour), so nothing
    // else is needed to make "clicking the greyed option does nothing"
    // hold.
    const manualRadio = document.querySelector('input[name="init-mode"][value="manual"]');
    if (manualRadio) {
        manualRadio.disabled = !!config.noManualPlacement;
        if (!preserveSize && config.noManualPlacement && manualRadio.checked) {
            const randomRadio = document.querySelector('input[name="init-mode"][value="random"]');
            if (randomRadio) randomRadio.checked = true;
        }
    }

    const activeModule = config.module;

    // Update UI
    const decoderName = document.getElementById('decoder-name');
    const decoderDescription = document.getElementById('decoder-description');
    const sizeInput = document.getElementById('size-input');
    const errorProbInputEl = document.getElementById('error-prob');
    const errorProbLabel = document.querySelector('label[for="error-prob"]');
    if (errorProbLabel) errorProbLabel.textContent = config.errorProbLabel ?? 'error probability';

    // TASK 4bj: the decoder title heading uses a dedicated config.title
    // ("repetition code decoder for code-capacity noise", etc.) instead of
    // config.name -- the selector's option labels and config.name itself
    // are unchanged, still used wherever they already were.
    // TASK 4bn: no more "(asynchronous)" suffix -- the mode is already
    // visible via the asynchronous checkbox, so the title is now always
    // exactly config.title (the uncoordinated-checkbox local this used to
    // read, isUncoord, had no other use and is removed with it -- the
    // checkbox's real effect on stepping is read fresh from the DOM at
    // step time, see stepSimulation()).
    if (decoderName) decoderName.textContent = config.title;
    // TASK 4cj: innerHTML instead of textContent so repetition2's
    // description can use real <sub> markup for Z_i Z_{i+1} rather than
    // underscores -- every config.description is authored in this file,
    // never derived from user input, so this is safe; every other config
    // still renders identically since none of their text contains
    // <, >, or & characters that innerHTML would otherwise reinterpret.
    if (decoderDescription) {
        decoderDescription.innerHTML = config.description;
        // TASK 4hj: keep each mixed-style math span in one client rect.
        if (decoderType === 'repetition_streaming') {
            decoderDescription.querySelectorAll('.nobreak').forEach((span) => {
                span.style.display = 'inline-block';
            });
        }
        decoderDescription.style.lineHeight = String(DESCRIPTION_LINE_HEIGHT);
    }

    // Apply per-decoder size constraints
    if (sizeInput) {
        sizeInput.min = config.minSize ?? 3;
        sizeInput.max = config.maxSize ?? 100;
    }

    // TASK 4bl: per-decoder error-probability step (native spinner
    // granularity). Every tab shares this one <input type="number"> field;
    // config.pStep lets a low-p tab opt into a finer step than the 0.01
    // default without any other tab's behaviour changing. Applied
    // unconditionally, like size's min/max above, so it stays current even
    // on a preserveSize=true reload.
    if (errorProbInputEl) {
        errorProbInputEl.step = config.pStep ?? '0.01';
    }

    // TASK 4ap: apply per-decoder clock-period constraints (e.g.
    // repetition2's minimum of 2) to both the slider and its paired
    // numeric input, unconditionally -- like size's min/max just above,
    // this must stay current even on a preserveSize=true reload (a
    // preserved URL or mode reload), not just on an actual
    // decoder switch.
    const clockPeriodSliderEl = document.getElementById('clock-period');
    const clockPeriodValueEl = document.getElementById('clock-period-value');
    const clockPeriodGroup = clockPeriodSliderEl?.closest('.control-group');
    if (clockPeriodGroup) clockPeriodGroup.style.display = config.fixedClockPeriod !== undefined ? 'none' : '';
    const clockMin = config.minClockPeriod ?? 1;
    const clockMax = config.maxClockPeriod ?? 60;
    if (clockPeriodSliderEl) { clockPeriodSliderEl.min = clockMin; clockPeriodSliderEl.max = clockMax; }
    if (clockPeriodValueEl) { clockPeriodValueEl.min = clockMin; clockPeriodValueEl.max = clockMax; }
    if (!preserveSize && clockPeriodSliderEl && parseInt(clockPeriodSliderEl.value) < clockMin) {
        // The previously loaded decoder's clock period is now below this
        // one's minimum (e.g. switching to repetition2 while q=1 was set)
        // -- clamp up rather than leaving an out-of-range slider value.
        clockPeriodSliderEl.value = clockMin;
        if (clockPeriodValueEl) clockPeriodValueEl.value = clockMin;
    }

    if (!preserveSize) restoreDecoderDefaults(config);

    // Render this decoder's extra parameter inputs (empty/hidden for
    // decoders without any). preserveSize also governs whether existing
    // extra-param values are kept across the reload, mirroring how it
    // governs size/error-probability/clock-period above.
    renderExtraParams(config, preserveSize);

    try {
        // Dynamically import the decoder module with cache busting
        // Always reload to ensure latest version
        const cacheBuster = Date.now();
        const module = await import(`${activeModule}?v=${cacheBuster}`);
        if (loadToken !== decoderLoadToken) return;
        // Apply to this module instance, including cache-busted memory imports.
        module.setHTreeCondensingBoundaryStyle?.(requestedBoundaryStyle);
        const decoder = decoderFromControls(config, seed, module);
        // Build asynchronous viewers locally. A newer selection cancels
        // their work before either shared state or viewer DOM is committed.
        if (config.webglStage) {
            await enableDecoder3DView(decoder, loadToken);
            if (loadToken !== decoderLoadToken) return;
        }

        // TASK 4bf: update the legend after the module import (not
        // before, as this used to run) so a decoder needing its own
        // colour constants for the legend (module.COLOR_MSG_FILL etc.,
        // read from whatever it exports -- undefined and unused for every
        // decoder that doesn't) can pass them straight through, rather
        // than duplicating hex values in main.js.
        currentLoadedModule = module;
        hierarchicalLegendK = null;
        // TASK 4jt: defer hierarchical rows until updateStats() has the
        // constructed decoder's actual K, including URL overrides.
        if (!isHierarchicalPresentation(decoderType)) updateLegend(decoderType, module);

        currentDecoder = decoder;
        currentDecoderType = decoderType;
        watchLogicalData(currentDecoder, loadToken);
        // Loading starts at step zero with empty decoder state. Streaming
        // constructors also prepare their future noisy environment.
        advanceRequested = false;
        noiseStoppedAtStep = null;

        // Sync the slider (and its label) to the decoder's actual clock period
        const clockSlider = document.getElementById('clock-period');
        const clockLabel = document.getElementById('clock-period-value');
        if (!preserveSize && clockSlider && currentDecoder.clockPeriod !== undefined) {
            clockSlider.value = currentDecoder.clockPeriod;
            if (clockLabel) clockLabel.value = currentDecoder.clockPeriod;
        }

        // Sync the q' slider if the decoder supports it
        const splitSlider = document.getElementById('split-period');
        const splitLabel = document.getElementById('split-period-value');
        if (config.hasSplitPeriod && splitSlider && currentDecoder.qPrime !== undefined) {
            if (preserveSize) {
                currentDecoder.qPrime = parseInt(splitSlider.value, 10);
            } else {
                splitSlider.value = currentDecoder.qPrime;
                if (splitLabel) splitLabel.textContent = currentDecoder.qPrime;
            }
        }

        // WebGL stages auto-enable on load and use the shared display controls.
        const toggle3DBtn = document.getElementById('toggle-3d-btn');
        if (toggle3DBtn) toggle3DBtn.style.display = 'none';

        // Initial render -- TASK 4ec supplement: updateStats() must run
        // BEFORE render() here, not after (the order this used to be in).
        // render() reads the state/legend cards' current DOM sizes via
        // computeOverlayRects() (TASK 4dy, feeding surface_streaming_3d's
        // own adaptive margins), but updateStats() is what actually
        // finishes settling those cards for THIS decoder -- toggling
        // residual-defects/clock row visibility and (at its
        // own end) syncing the legend's width to the state card's --
        // updateLegend() above already rebuilt the legend's own ITEMS, but
        // not yet its width. Rendering first meant that very first frame
        // after a decoder switch read the PREVIOUS decoder's row set/
        // widths (e.g. missing a residual-defects row this new decoder
        // needs), producing exactly the layout TASK 4ec's own
        // ResizeObserver safety net then had to correct a frame or two
        // later -- visible to the user as a brief jump. Swapping the order
        // means render()'s first-ever read already sees this decoder's
        // true sizing, so there's nothing left for the safety net to fix.
        //
        // TASK 4eg: applyCanvasSize() likewise inserted between the two --
        // this function is the ONLY path (besides an actual window resize)
        // that switches which decoder cssWidth/cssHeight belong to, so
        // without this call here, switching to or from a module with its
        // own getPreferredCanvasHeight() via the dropdown (as opposed to
        // navigating to a fresh URL, which runs initializeCanvas()'s own
        // resizeCanvas() call fresh) would leave the canvas at whatever
        // height the PREVIOUS decoder left it at, until the next resize or
        // card-size event happened to fire. After updateStats() for the
        // same reason as above (this decoder's own overlay cards need to
        // be fully settled first), before render() so that first frame
        // already draws onto the correctly-sized canvas.
        updateStats();
        applyCanvasSize();
        render();
        // One decision for every opening path, immediately after the first
        // draw and before yielding to paint. Font/card relayouts only draw
        // the resulting state; explicit init=1 cannot initialize it twice.
        if (PREINITIALIZE_ON_LOAD || initialize) {
            const randomRadio = document.querySelector('input[name="init-mode"][value="random"]');
            if (randomRadio) randomRadio.checked = true;
            await initializeErrors({ seed, loadToken });
            if (loadToken !== decoderLoadToken) return;
        }
        window.scrollTo(0, 0);
    } catch (error) {
        if (loadToken !== decoderLoadToken) return;
        console.error(`Error loading decoder ${decoderType}:`, error);
    }
}

function updateLegend(decoderType, moduleColors) {
    // Hide the HTML overlay legend for 2D codes that draw their own legend on the canvas
    const legendEl = document.querySelector('.legend');
    // Hidden for every decoder whose own module draws a canvas legend
    // (the floating HTML overlay would otherwise duplicate it). surface2
    // draws no canvas legend of its own, so it stays out of this set.
    // TASK 4bf: repetition2 removed -- it no longer draws its own canvas
    // legend, using this shared HTML one instead (getLegendItems()'s own
    // repetition2 case, with the glyphs matched to its module's colours).
    // TASK 4cz: repetition_streaming removed too, for the identical
    // reason -- its render() never actually drew an on-canvas legend (this
    // entry looks to have been stale even before this task), and it now
    // has real HTML legend entries of its own (getLegendItems()'s
    // repetition_streaming case) that this set was silently hiding.
    // TASK 4ds: surface_cg_streaming removed for the same reason as
    // surface_streaming_3d in TASK 4dr -- its own on-canvas legend is
    // gone, replaced by real HTML legend entries below.
    const hiddenForCodes = new Set();
    if (legendEl) legendEl.style.display = hiddenForCodes.has(decoderType) ? 'none' : '';

    const legendContent = document.getElementById('legend-content');
    if (!legendContent) return;

    legendContent.innerHTML = '';

    const legendItems = getLegendItems(decoderType, moduleColors);
    legendItems.forEach(item => {
        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';

        const colorBox = document.createElement('div');
        // Apply shape class if specified
        const shape = item.shape || 'square';
        colorBox.className = `legend-color ${shape === 'comet' ? 'hline comet'
            : shape === 'condensing-boundary' ? 'hline condensing-boundary' : shape}`;
        colorBox.style.backgroundColor = item.color;
        // TASK 4bf: an explicit edge colour (repetition2's message square
        // and defect orb both have one distinct from the generic faint
        // default border) and, for the 'hline' error-string shape, its
        // own structurally-matched thickness.
        if (item.edgeColor) colorBox.style.borderColor = item.edgeColor;
        if (item.lineWidth) colorBox.style.height = `${item.lineWidth}px`;
        if (item.dash) colorBox.style.background = `repeating-linear-gradient(to right, ${item.color} 0 ${item.dash[0]}px, transparent ${item.dash[0]}px ${item.dash[0] + item.dash[1]}px)`;

        if (shape === 'diamond') colorBox.style.clipPath = 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)';

        if (shape === 'htree-site' || shape === 'condensing-boundary') {
            // Reuse the canvas glyphs without changing the swatch's existing
            // box or label spacing. The boundary uses the session's style.
            const width = shape === 'htree-site' ? 11 : 14;
            const height = 11;
            const pixelRatio = globalThis.devicePixelRatio || 1;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(width * pixelRatio);
            canvas.height = Math.round(height * pixelRatio);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            canvas.style.position = 'absolute';
            canvas.style.left = '0';
            canvas.style.top = '50%';
            canvas.style.transform = 'translateY(-50%)';
            canvas.setAttribute('aria-hidden', 'true');
            colorBox.style.position = 'relative';
            colorBox.style.backgroundColor = 'transparent';
            colorBox.style.border = 'none';
            const context = canvas.getContext('2d');
            context.scale(pixelRatio, pixelRatio);
            if (shape === 'htree-site') {
                // The shared glyph also honours HTREE_INNER_SQUARE for swatches.
                moduleColors.drawSiteGlyph(context, width / 2, height / 2, width - 1,
                    item.glyphColors);
            } else {
                const scale = moduleColors.HTREE_BOUNDARY_LEGEND_SCALE;
                context.scale(scale, scale);
                moduleColors.drawCondensingBoundary(context, 0, height / (2 * scale),
                    width / scale, height / (2 * scale),
                    width, 0, 1, undefined, item.bothSides === true);
            }
            colorBox.appendChild(canvas);
        }

        if (shape === 'comet') {
            // Keep the original line box and label spacing. The SVG's round
            // head stays at its right edge; the fading tail uses the card padding.
            colorBox.style.backgroundColor = 'transparent';
            const diameter = item.lineWidth * HTREE_LEGEND_TRANSIT_HEAD_WIDTH_FACTOR;
            const radius = diameter / 2;
            const tailLength = diameter * HTREE_LEGEND_TRANSIT_TAIL_HEAD_RATIO;
            const svgElement = (tag, attributes) => {
                const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
                for (const [name, value] of Object.entries(attributes)) {
                    element.setAttribute(name, value);
                }
                return element;
            };
            const svg = svgElement('svg', {
                width: tailLength + radius, height: diameter,
                viewBox: `0 0 ${tailLength + radius} ${diameter}`,
                'aria-hidden': 'true', focusable: 'false'
            });
            const defs = svgElement('defs', {});
            const gradient = svgElement('linearGradient', {
                id: 'legend-transit-gradient', x1: 0, y1: 0, x2: 1, y2: 0
            });
            for (const opacity of [0, 1]) {
                gradient.appendChild(svgElement('stop', {
                    offset: opacity, 'stop-color': item.color, 'stop-opacity': opacity
                }));
            }
            defs.appendChild(gradient);
            svg.appendChild(defs);
            svg.appendChild(svgElement('rect', {
                x: 0, y: 0, width: tailLength, height: diameter,
                fill: 'url(#legend-transit-gradient)'
            }));
            svg.appendChild(svgElement('circle', {
                cx: tailLength, cy: radius, r: radius, fill: item.color
            }));
            colorBox.appendChild(svg);
        }

        // For cross shapes, color the pseudo-elements via CSS custom property
        if (shape === 'cross') {
            colorBox.style.setProperty('--cross-color', item.color);
            colorBox.style.backgroundColor = 'transparent';
            // Apply color to pseudo-elements inline
            const style = document.createElement('style');
            const id = 'cross-' + Math.random().toString(36).slice(2, 8);
            colorBox.id = id;
            style.textContent = `#${id}::before, #${id}::after { background: ${item.color}; }`;
            legendItem.appendChild(style);
        }

        // TASK 4dz: 'legend-label' lets the CSS give this span its own
        // min-width:0, overriding a flex item's default min-width:auto
        // (which equals its content's own single-line width, and so
        // otherwise makes it refuse to shrink and wrap at all) -- needed
        // once "condensing boundary" (longer than "rough boundary") could
        // no longer always fit on one line at the legend card's own
        // width, which stays synced to the state card's and must not grow
        // to accommodate a longer label (see syncLegendWidthToInfoPanel()).
        const label = document.createElement('span');
        label.className = 'legend-label';
        label.textContent = item.label;

        legendItem.appendChild(colorBox);
        legendItem.appendChild(label);
        legendContent.appendChild(legendItem);
    });

    syncLegendWidthToInfoPanel();
}

// TASK 4bg: the legend card must be exactly as wide as the stats card
// (.info-panel) on whichever tab shows both, matching by explicit pixel
// width rather than trying to make their independent CSS happen to agree
// -- the stats card's own width is per-tab (max-content label column, see
// its own comment above), so this reads its *rendered* width and applies
// it directly. Called from updateLegend() (every decoder load and grid
// toggle) and updateStats() (guaranteed to run after the *new* decoder's
// row visibility is finalized -- updateLegend() can run slightly before
// that during loadDecoder(), so relying on it alone could catch a stale,
// still-previous-decoder width for one frame) and on resize, per the
// task's own suggested integration points; a no-op when the legend is
// hidden (nothing to match).
function syncLegendWidthToInfoPanel() {
    // TASK 4fe: both cards stretch to the pillar width in this layout.
    if (document.body.classList.contains('layout-three-pillars')) return;
    const infoPanel = document.querySelector('.info-panel');
    const legendEl = document.querySelector('.legend');
    if (!infoPanel || !legendEl) return;
    if (getComputedStyle(legendEl).display === 'none') return;
    // getBoundingClientRect(), not offsetWidth -- offsetWidth rounds to a
    // whole pixel, which then compares unequal to the info panel's own
    // (unrounded) rect width when both are read back for verification.
    const targetWidth = infoPanel.getBoundingClientRect().width;
    // TASK 4ec: skip the write entirely when it wouldn't actually change
    // anything -- .legend is one of the three elements
    // watchOverlayCardSizes() below observes for resize, so writing this
    // element's width is exactly the kind of self-triggered size change
    // that function's own comment warns about; comparing first means a
    // relayout pass that finds nothing to change here doesn't re-fire that
    // observer on .legend at all, rather than relying only on the browser
    // not renotifying for a numerically-identical size (which held in
    // testing, but isn't a guarantee worth depending on for loop safety).
    const currentWidth = legendEl.getBoundingClientRect().width;
    if (Math.abs(currentWidth - targetWidth) < 0.01) return;
    legendEl.style.width = `${targetWidth}px`;
}

// TASK 4ek: repetition2's own descriptionPlacement:'right' config flag (a
// static per-tab trial value, not a user-tweakable extraParam -- see
// config.descriptionPlacement in decoderConfigs and the opts passed to
// the decoder's own constructor in loadDecoder()) moves the description
// card's own inner .description-panel into the right-hand .overlay-stack,
// below .legend, instead of its own default left-hand .description-stack
// -- getting "the same vertical gap the state and legend cards have
// between them" and "right-aligned with them, same right inset" for free
// from .overlay-stack's own existing flex column + gap + align-items:
// flex-end, rather than needing separate positioning rules of its own.
// Also widens .info-panel (and, via syncLegendWidthToInfoPanel()'s own
// existing match-the-info-panel's-rendered-width logic, .legend along
// with it) and the moved .description-panel itself to the description
// card's own former max-width (180px) so all three share the same left
// and right edges. Each state row shares that width between its own
// label and value.
//
// Called on every loadDecoder() (idempotent either way, and cheap when
// there's nothing to change -- the parentElement checks below skip the
// actual DOM move on every call after the first for a given placement)
// so switching decoders always leaves the DOM and these three cards' own
// widths in the state the newly active tab's own config calls for,
// regardless of what the previously active one left behind.
// TASK 4et: repetition2's own 'right'-placement variant only -- the
// description card, stacked directly under the legend by .overlay-stack's
// own `gap` (8px, shared uniformly between every pair of stacked cards),
// read as glued to it. Applied as a margin-top on the description panel
// specifically (below), which ADDS to that shared gap rather than
// replacing it -- the legend-to-description gap becomes 8 + 12 = 20px,
// while the (unrelated) info-panel-to-legend gap above it is untouched.
const DESCRIPTION_STACK_EXTRA_GAP = 12;

function applyDescriptionPlacement(config) {
    const descriptionStack = document.querySelector('.description-stack');
    const descriptionPanel = document.querySelector('.description-panel');
    const overlayStack = document.querySelector('.overlay-stack');
    const infoPanel = document.querySelector('.info-panel');
    if (!descriptionStack || !descriptionPanel || !overlayStack || !infoPanel) return;

    const placeRight = config.descriptionPlacement === 'right';

    if (placeRight) {
        // .description-panel itself, not the outer .description-stack
        // wrapper -- that wrapper's own position:absolute/top/left/
        // max-width must NOT apply once this card is a normal flex item
        // of .overlay-stack instead; left empty (and so naturally
        // zero-sized, needing no explicit hiding), it's harmless either
        // way. Appended after .legend (already .overlay-stack's last
        // child today), landing it below as the stack's own new third
        // child.
        if (descriptionPanel.parentElement !== overlayStack) {
            overlayStack.appendChild(descriptionPanel);
        }
        // TASK 4el: state/legend return to their own natural (fit-content)
        // width -- only the description card, the widest of the three,
        // keeps an explicit 180px. TASK 4er: .overlay-stack's own
        // align-items goes back to its default (flex-end, cleared here
        // rather than hard-coded, matching the non-'right' branch below)
        // -- reverting TASK 4el's own flex-start, which had shared the
        // three cards' LEFT edges instead. With align-items back to
        // flex-end, the *stack* -- still sized to its own widest child,
        // the 180px description -- keeps ending at its own right:28px
        // inset as before, and now every card's own RIGHT edge lands
        // there too, so the narrower (~136px) state/legend cards fall
        // 180-136=44px short of that inset on their LEFT side instead of
        // their right. repetition2.js's own graphic centring (_layout(),
        // TASK 4eq) reads overlayRects.infoPanel.left, the state card's
        // own LEFT edge -- unaffected by this switch, since flex-end only
        // moves the state/legend cards horizontally, not the (unchanged)
        // description card that still defines the stack's own left edge.
        infoPanel.style.width = '';
        descriptionPanel.style.width = '180px';
        overlayStack.style.alignItems = '';
        // TASK 4et: see DESCRIPTION_STACK_EXTRA_GAP's own comment above.
        descriptionPanel.style.marginTop = `${DESCRIPTION_STACK_EXTRA_GAP}px`;
    } else {
        if (descriptionPanel.parentElement !== descriptionStack) {
            descriptionStack.appendChild(descriptionPanel);
        }
        infoPanel.style.width = '';
        descriptionPanel.style.width = '';
        overlayStack.style.alignItems = '';
        // TASK 4et: cleared for the default placement -- .description-stack
        // positions this card via its own absolute top/left, not a flex
        // gap, so an inherited margin-top here would just shift it down
        // unnecessarily.
        descriptionPanel.style.marginTop = '';
    }
}

function getLegendItems(decoderType, moduleColors) {
    // Common items with distinct shapes to avoid color collisions
    const errorItem = { color: '#f87171', label: 'error', shape: 'cross' };
    const syndromeItem = { color: '#fbbf24', label: 'syndrome', shape: 'circle' };

    switch (decoderType) {
        case 'toric2': {
            // TASK 4cx: matches repetition2's legend style/order (message
            // row(s), defect orb, error segment; no 'syndrome' row, no ✕
            // cross icon) instead of the generic errorItem/syndromeItem
            // placeholders above -- one message row per toric colour,
            // reading this module's own exported colour constants
            // (moduleColors, from the freshly import()ed module in
            // loadDecoder()) the same way repetition2's own case reads its
            // COLOR_MSG_FILL/EDGE. Legend message swatches keep the shared
            // rounded 1px border; canvas message cells have no outline.
            const c = moduleColors || {};
            // Same swatch-size-based thickness formula as repetition2's
            // own legend case, now that toric2's real error-string width
            // uses the identical wBlue/stringWidth rule (TASK 4cx item 4).
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            // TASK 4db: reordered to defect, error, message(s).
            return [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: 'defect', shape: 'orb' },
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG00_FILL, edgeColor: c.COLOR_MSG00_EDGE, label: 'blue message', shape: 'tile' },
                { color: c.COLOR_MSG01_FILL, edgeColor: c.COLOR_MSG01_EDGE, label: 'red message', shape: 'tile' },
                { color: c.COLOR_MSG10_FILL, edgeColor: c.COLOR_MSG10_EDGE, label: 'green message', shape: 'tile' }
            ];
        }
        case 'surface2': {
            // TASK 4cy: matches repetition2's/toric2's legend style/order
            // exactly (see toric2's own case for the full rationale) --
            // dropping the previous errorItem/syndromeItem placeholders
            // and the (sw)/(nw)/(se) corner suffixes (toric2's own
            // equivalent rows read just "blue/red/green message", and the
            // two decoders share identical solid/striped cell geometry
            // and colours, so keeping the wording identical too
            // keeps them consistent).
            const c = moduleColors || {};
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            // TASK 4db: reordered to defect, error, message(s).
            // TASK 4df: "rough boundary" (renamed "condensing boundary" in
            // TASK 4dz -- see updateLegend()'s own comment on the label
            // span/CSS wrap support that renaming needed) appended last,
            // matching its position (also last) in the surface code
            // (phenomenological) module's own on-canvas legend -- surface2
            // has no analogue of that tab's separate "residual"/"residual
            // syndrome" rows, so appending after the message rows is the
            // closest equivalent to "last" in a legend with a different,
            // shorter row set.
            return [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: 'defect', shape: 'orb' },
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG00_FILL, edgeColor: c.COLOR_MSG00_EDGE, label: 'blue message', shape: 'tile' },
                { color: c.COLOR_MSG01_FILL, edgeColor: c.COLOR_MSG01_EDGE, label: 'red message', shape: 'tile' },
                { color: c.COLOR_MSG10_FILL, edgeColor: c.COLOR_MSG10_EDGE, label: 'green message', shape: 'tile' },
                { color: c.ROUGH_BOUNDARY_COLOR, label: 'condensing boundary', shape: 'hline', lineWidth: c.ROUGH_BOUNDARY_WIDTH }
            ];
        }
        case 'surface_streaming_3d': {
            // TASK 4dr: restyled to match surface2's own legend order/style
            // exactly (see that case's own comment for the full
            // rationale). TASK 4ed: the "detector event" row (a transient
            // "just measured this round" marker on slice 0) is removed
            // entirely, per the user's own request -- this tab no longer
            // draws that glyph at all, so condensing boundary is last now.
            const c = moduleColors || {};
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            return [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: 'defect', shape: 'orb' },
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG00_FILL, edgeColor: c.COLOR_MSG00_EDGE, label: 'blue message', shape: 'tile' },
                { color: c.COLOR_MSG01_FILL, edgeColor: c.COLOR_MSG01_EDGE, label: 'red message', shape: 'tile' },
                { color: c.COLOR_MSG10_FILL, edgeColor: c.COLOR_MSG10_EDGE, label: 'green message', shape: 'tile' },
                { color: c.ROUGH_BOUNDARY_COLOR, label: 'condensing boundary', shape: 'hline', lineWidth: c.ROUGH_BOUNDARY_WIDTH }
            ];
        }
        case 'repetition2': {
            // TASK 4bf: this module no longer draws its own canvas legend
            // -- these three entries reproduce its actual glyphs (not the
            // generic placeholder colours the other cases above use),
            // reading its own exported colour constants (moduleColors,
            // from the freshly `import()`ed module in loadDecoder())
            // rather than duplicating hex values here. Structurally
            // matches the site row's own error-string width formula
            // (repetition2.js's wBlue/stringWidth), evaluated at this
            // swatch's own reference size instead of a live cell size --
            // the same approach that module's own (now-removed) canvas
            // legend used.
            const c = moduleColors || {};
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            // The legend keeps its channel edge independently of the grid.
            // TASK 4db: reordered to defect, error, message.
            return [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: 'defect', shape: 'orb' },
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG_FILL, edgeColor: c.COLOR_MSG_EDGE, label: 'message' }
            ];
        }
        case 'repetition_streaming': {
            // TASK 4cz: matches repetition2's legend style/order exactly --
            // this module's message/defect/error glyphs are now drawn
            // with repetition2's own imported constants (moduleColors,
            // re-exported from repetition_streaming.js the same way
            // repetition2 itself exports them), so "defect" already covers
            // slice/residual defects AND future-panel detector events
            // (unified into the same anyon-orb glyph by this task), and
            // "error" already covers the residual/future error strings
            // (all drawn in the one shared COLOR_ERROR). "residual"/
            // "k = N"/"back wall" have no distinct glyph of their own
            // (see repetition_streaming.js's own render() comment) and
            // stay as on-canvas row labels instead of legend rows.
            const c = moduleColors || {};
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            // TASK 4db: reordered to defect, error, message, matching
            // repetition2's own reorder for consistency (not explicitly
            // named in 4db's own task text, which only called out
            // repetition2/toric2/surface2, but this module was modelled
            // directly on repetition2's legend in TASK 4cz, so leaving it
            // in the old order would read as an inconsistency).
            return [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: 'defect', shape: 'orb' },
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG_FILL, edgeColor: c.COLOR_MSG_EDGE, label: 'message' }
            ];
        }
        case 'surface_cg_streaming':
        case 'surface_cg_htree':
        case 'surface_cg_surgery_x':
        case 'surface_cg_prep':
        case 'surface_cg_inject':
        case 'surface_cg_surgery_z': {
            // The H-tree shows turquoise comets on the left and red
            // residual strings on the right. Level rows use the live K/n.
            const c = moduleColors || {};
            const swatchSize = 14;
            const wBlue = Math.max(2, Math.round(swatchSize / 9));
            const errLineWidth = Math.max(1, 1.05 * wBlue);
            const protocolSector = decoderType === 'surface_cg_prep' || decoderType === 'surface_cg_inject';
            const htree = isHierarchicalPresentation(decoderType);
            const items = [
                { color: c.COLOR_ORB_RIM, edgeColor: '#000000', label: protocolSector ? 'X-check defect' : 'defect', shape: 'orb' },
                ...(isHierarchicalPresentation(decoderType) ? [
                    { color: c.HTREE_TRANSIT_COLOR, label: 'defect in transit', shape: 'comet', lineWidth: errLineWidth }
                ] : []),
                { color: c.COLOR_ERROR, label: 'error', shape: 'hline', lineWidth: errLineWidth },
                { color: c.COLOR_MSG00_FILL, edgeColor: c.COLOR_MSG00_EDGE, label: 'blue message', shape: 'tile' },
                { color: c.COLOR_MSG01_FILL, edgeColor: c.COLOR_MSG01_EDGE, label: 'red message', shape: 'tile' },
                { color: c.COLOR_MSG10_FILL, edgeColor: c.COLOR_MSG10_EDGE, label: 'green message', shape: 'tile' },
                { color: c.ROUGH_BOUNDARY_COLOR, label: 'condensing boundary',
                    shape: htree ? 'condensing-boundary' : 'hline', lineWidth: c.ROUGH_BOUNDARY_WIDTH }
            ];
            if (decoderType === 'surface_cg_prep' || decoderType === 'surface_cg_inject') {
                items.push({ color: c.PROTOCOL_ABSORBING_FILL, edgeColor: c.PROTOCOL_ABSORBING_EDGE,
                    label: 'absorbing site' });
                if (decoderType === 'surface_cg_inject') items.push(
                    { color: c.INJECTION_FRAME_SHADE, label: 'absorbing frame region' },
                    { color: c.INJECTION_QSTAR_COLOR, edgeColor: c.INJECTION_QSTAR_COLOR,
                        label: 'injection qubit q⋆', shape: 'diamond' });
            }
            const levelColors = c.LEVEL_COLORS || [];
            const K = currentDecoder?.K ?? 3;
            const n = currentDecoder?.n ?? 2;
            // H-tree also gives level 0 its own coloured streets and glyphs.
            for (let k = isHierarchicalPresentation(decoderType) ? 0 : 1; k < K; k++) {
                if (htree && c.glyphColors) {
                    const colors = c.glyphColors(levelColors[k % levelColors.length]);
                    items.push({ color: colors.fill, edgeColor: colors.edge, glyphColors: colors,
                        label: `slice-${k} site`, shape: 'htree-site' });
                    continue;
                }
                items.push({
                    color: 'transparent',
                    edgeColor: levelColors[k % levelColors.length],
                    label: isHierarchicalPresentation(decoderType)
                        ? `slice-${k} site`
                        : `level ${k} (block n=${Math.pow(n, k)})`
                });
            }
            return items;
        }
        case 'xcube_lineon': {
            const c = moduleColors || {};
            return [
                { color: c.COLOR_LINEON_X, edgeColor: c.COLOR_LINEON_X_RIM, label: 'x-type lineon' },
                { color: c.COLOR_LINEON_Y, edgeColor: c.COLOR_LINEON_Y_RIM, label: 'y-type lineon' },
                { color: c.COLOR_LINEON_Z, edgeColor: c.COLOR_LINEON_Z_RIM, label: 'z-type lineon' },
                { color: c.COLOR_ERROR_QUBIT, edgeColor: c.COLOR_ERROR_RIM, label: 'error' }
            ];
        }
        case 'xcube_fracton':
        case 'haah_streaming':
        case 'haah': {
            // Match the 3D fills and silhouette rims, using the same
            // rounded, bordered swatches as the site's message entries.
            const c = moduleColors || {};
            return [
                { color: c.COLOR_DEFECT, edgeColor: c.COLOR_DEFECT_RIM, label: 'defect' },
                { color: c.COLOR_ERROR_QUBIT, edgeColor: c.COLOR_ERROR_RIM, label: 'error' }
            ];
        }
        default:
            return [errorItem, syndromeItem];
    }
}

function updateDecoderDetails(decoderType) {
    const detailsContainer = document.getElementById('decoder-details');
    if (!detailsContainer) return;

    detailsContainer.innerHTML = '';

    const details = getDecoderDetails(decoderType);
    details.forEach(detail => {
        const card = document.createElement('div');
        card.className = 'detail-card';

        const title = document.createElement('h4');
        title.textContent = detail.title;

        const content = document.createElement('p');
        content.textContent = detail.content;

        card.appendChild(title);
        card.appendChild(content);
        detailsContainer.appendChild(card);
    });
}

function getDecoderDetails(decoderType) {
    const config = decoderConfigs[decoderType];
    const common = [
        { title: 'Dimension', content: config.is3D ? '3D' : (config.is1D ? '1D' : '2D') },
        { title: 'Recommended Size', content: `L = ${config.defaultSize}` }
    ];

    switch (decoderType) {
        case 'repetition2':
            return [
                ...common,
                { title: 'Rule Source', content: 'repca/reference.py, Algorithm 1' },
                { title: 'Clock Period', content: 'q = 2 (default)' },
                { title: 'Errors', content: 'Red strings joining the two defects that bound an error run' },
                { title: 'History', content: 'Scrolls after N rows' }
            ];
        case 'repetition_streaming':
            return [
                ...common,
                { title: 'Rule Source', content: 'main.tex Alg. layered-defect/message-update' },
                { title: 'Slices', content: 'K stacked, timers t_k = t0 n^k' },
                { title: 'Noise', content: 'Phenomenological: p_phys, p_meas per round' },
                { title: 'Output', content: 'Residual weight and majority-flip indicator' }
            ];
        case 'surface_streaming_3d': // identical dynamics/details to (unregistered) surface_streaming -- only the renderer differs
            return [
                ...common,
                { title: 'Rule Source', content: 'main.tex Alg. layered-toric-defect/message-update' },
                { title: 'Boundaries', content: 'Rough (open) left/right, splitting period q_s' },
                { title: 'Noise', content: 'Phenomenological: p_phys, p_meas per round' },
                { title: 'Output', content: 'Residual patch and row-0 winding parity' }
            ];
        default:
            return common;
    }
}

async function enableDecoder3DView(decoder, loadToken = decoderLoadToken) {
    if (typeof decoder.enable3DMode !== 'function') return;
    await decoder.enable3DMode(() => loadToken === decoderLoadToken);
    if (loadToken !== decoderLoadToken) return;
    const combinedView = document.getElementById('combined-view');
    const title = document.querySelector('.viz-title');
    const container = document.querySelector('.visualization-container');
    if (combinedView && title && container && getComputedStyle(combinedView).position === 'absolute') {
        const borderTop = parseFloat(getComputedStyle(container).borderTopWidth) || 0;
        combinedView.style.top = `${title.getBoundingClientRect().bottom - container.getBoundingClientRect().top - borderTop}px`;
    }
}

// Initialize applies pending decoder parameters and samples a fresh run.
// The existing controls, labels, and description stay in place.
async function initializeErrors({ seed = null, loadToken = decoderLoadToken } = {}) {
    if (loadToken !== decoderLoadToken || !currentDecoder || !currentLoadedModule) return;
    clearStepHistory();
    if (isPlaying) stopPlayback();
    if (activePointerId !== null) {
        currentDecoder.pointerUp?.();
        if (canvas) { try { canvas.releasePointerCapture(activePointerId); } catch (e) { /* ignore */ } }
        activePointerId = null;
    }
    const config = getCurrentDecoderConfig();
    const previous = currentDecoder;
    const runSeed = seed ?? freshRandomSeed();
    const fresh = decoderFromControls(config, runSeed);
    const had3DView = previous.is3DMode;
    const reuse3DView = had3DView && typeof previous.reinitialize3D === 'function';
    if (reuse3DView) {
        // Initialize the new state before synchronously rebuilding the live
        // viewer. Its canvas stays attached and retains the previous frame.
        currentDecoder = fresh;
    } else if (had3DView && previous.L === fresh.L) {
        // Haah's scene and event callbacks belong to its existing instance.
        // Replace the lattice state while preserving that live viewer.
        for (const key of ['L', 'clockPeriod', 'stepCount', 'clock', 'qubitsA', 'qubitsB', 'syndrome', 'messages']) {
            previous[key] = fresh[key];
        }
    } else {
        previous.dispose?.();
        currentDecoder = fresh;
    }
    advanceRequested = false;
    noiseStoppedAtStep = null;
    lastAnimationTime = 0;
    const mode = document.querySelector('input[name="init-mode"]:checked')?.value || 'random';
    const p = probabilityInputValue(document.getElementById('error-prob'));
    const rng = mulberry32(runSeed);
    if (mode === 'manual' && currentDecoderType === 'repetition_streaming') {
        currentDecoder.initializeClear();
    } else if (currentDecoder.pPhys !== undefined || mode === 'random') {
        currentDecoder.initializeRandomErrors(p, rng);
    } else if (typeof currentDecoder.initializeClear === 'function') {
        currentDecoder.initializeClear();
    } else {
        currentDecoder.initializeRandomErrors(0, rng);
    }
    if (reuse3DView) {
        previous.reinitialize3D(fresh);
        currentDecoder = previous;
    }
    currentDecoder.setNoiseEnabled?.(!isManualStreamingRun());
    if (currentDecoder !== previous) watchLogicalData(currentDecoder, loadToken);
    updateStats();
    applyCanvasSize();
    render();
    if (had3DView && currentDecoder === fresh) {
        // A changed 3D size needs new geometry, but never new controls.
        await enableDecoder3DView(fresh, loadToken);
        if (loadToken !== decoderLoadToken || currentDecoder !== fresh) return;
        render();
    }
}

// Logical data can arrive after a quiescent run has stopped stepping.
// Refresh only the still-current instance, including its state card.
function watchLogicalData(decoder, loadToken) {
    decoder.logicalDataReady?.then(loaded => {
        const state = logicalDataState(decoder);
        state.loaded = loaded !== false;
        state.failed = loaded === false;
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        if (loadToken !== decoderLoadToken || decoder !== currentDecoder) return;
        if (isPlaying && isRunOver()) stopPlayback();
        updateStats();
        render();
    });
}

function logicalDataState(decoder) {
    if (!logicalDataStates.has(decoder)) {
        logicalDataStates.set(decoder, { loaded: false, failed: false, expired: false, timer: null });
    }
    return logicalDataStates.get(decoder);
}

function getRunLogicalCheck(decoder) {
    const check = decoder.checkLogicalError?.() ?? { hasError: false };
    if (!check.pending) return check;
    const state = logicalDataState(decoder);
    if (state.failed || state.expired) return { unavailable: true, hasError: false };
    if (advanceRequested && isDecoderQuiescent(decoder) && state.timer === null) {
        const loadToken = decoderLoadToken;
        state.timer = setTimeout(() => {
            state.timer = null;
            state.expired = true;
            decoder.retryLogicalData?.();
            if (loadToken !== decoderLoadToken || decoder !== currentDecoder) return;
            updateStats();
            render();
        }, LOGICAL_DATA_WAIT_MS);
    }
    return check;
}

// Each decoder defines its stopping condition through isQuiescent().
// Most require no defects or messages; Haah and X-cube ignore messages.
// For a decoder without this method, fall back to "no defects" alone.
function isDecoderQuiescent(decoder) {
    if (!decoder) return false;
    if (typeof decoder.isQuiescent === 'function') return decoder.isQuiescent();
    if (typeof decoder.getSyndromeCount === 'function') return decoder.getSyndromeCount() === 0;
    return false;
}

// Decoder state and host verdict/drain bookkeeping move together. Snapshots
// never include DOM, WebGL resources, or the playback scheduler.
function captureStepState() {
    return {
        decoder: captureDecoderState(currentDecoder),
        advanceRequested,
        noiseStoppedAtStep,
    };
}

function clearStepRedo() {
    redoHistory.length = 0;
}

function clearStepHistory() {
    stepHistory.length = 0;
    clearStepRedo();
}

function pushStepHistory(snapshot) {
    stepHistory.push(snapshot);
    if (stepHistory.length > STEP_HISTORY_MAX) stepHistory.shift();
}

function restoreStepState(snapshot, fromPlayback = false, replay = false) {
    restoreDecoderState(currentDecoder, snapshot.decoder, replay ? {
        replay: true, stepIntervalMs: isPlaying ? animationStepIntervalMs() : undefined,
    } : undefined);
    advanceRequested = snapshot.advanceRequested;
    noiseStoppedAtStep = snapshot.noiseStoppedAtStep;
    // These sliders edit the rule immediately, so they must reflect the
    // restored rule too. Deferred Initialize inputs keep their pending values.
    if (Number.isFinite(currentDecoder.clockPeriod)) {
        setControlValue(document.getElementById('clock-period'), currentDecoder.clockPeriod);
        setControlValue(document.getElementById('clock-period-value'), currentDecoder.clockPeriod);
    }
    for (const param of getCurrentDecoderConfig()?.extraParams || []) {
        if (param.type !== 'slider' || currentDecoder[param.key] === undefined) continue;
        setControlValue(document.getElementById(`extra-param-${param.key}`), currentDecoder[param.key]);
        setControlValue(document.getElementById(`extra-param-${param.key}-value`), currentDecoder[param.key]);
    }
    if (!fromPlayback) lastAnimationTime = 0;
    if (transientAnimationId !== null) {
        cancelAnimationFrame(transientAnimationId);
        transientAnimationId = null;
    }
    updateStats();
    if (!fromPlayback) render();
}

function stepBackOnce(fromPlayback = false) {
    if (stopForSurgeryRejection()) return false;
    if (!currentDecoder || stepHistory.length === 0) return false;
    finishInitialErrorsPointerGesture();
    redoHistory.push(captureStepState());
    restoreStepState(stepHistory.pop(), fromPlayback);
    return true;
}

function stepBackSimulation() {
    if (stopForSurgeryRejection()) return;
    if (!currentDecoder || stepHistory.length === 0) return;
    if (isPlaying) stopPlayback();
    return stepBackOnce();
}

function handleStepKeydown(event) {
    if (event.target?.closest?.('#controls-toggle')) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    // Preserve caret navigation, native range/select keys, and editable text.
    if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== ' ') return;
    event.preventDefault();
    let acted;
    if (event.key === ' ') acted = togglePlayback();
    else if (event.key === 'ArrowLeft') {
        acted = event.shiftKey ? togglePlayBack() : stepBackSimulation();
    } else acted = event.shiftKey ? playForward() : stepSimulation();
    // Impossible shortcuts keep focus and state untouched, just like clicks.
    if (!acted) return;
    // Successful shortcuts clear the last clicked control's focus.
    if (document.activeElement?.matches?.('.control-panel .button-group button')
        || document.activeElement?.matches?.('#transport-controls button')) {
        document.activeElement.blur();
    }
}

// TASK 4dl: split out of the old stepSimulation() (renamed here, kept as
// a thin wrapper below) so animate()'s new multi-step-per-frame loop can
// call the actual stepping/quiescence/timeout/status logic several times
// per frame while rendering only once at the end. Returns true if the
// caller should keep stepping this frame, false the instant a
// terminating condition (quiescence or the maxSteps cap) is hit -- so a
// run that converges mid-frame stops on exactly the terminating step
// (this same call already updated stats/status for it) instead of the
// loop calling it again needlessly, and so stopPlayback()'s own stop
// happens exactly once, from the call that actually detected it.
function stepOnce() {
    if (!currentDecoder) {
        console.error("No decoder loaded!");
        return false;
    }

    if (stopForSurgeryRejection()) return false;
    finishInitialErrorsPointerGesture();
    // An already displayed verdict is today's STEP no-op. The first
    // request on a quiescent step-zero state still reveals its verdict,
    // and keeps the preceding paused state available to Back.
    if (isRunOver()) {
        if (isPlaying) stopPlayback();
        updateStats();
        return false;
    }
    pushStepHistory(captureStepState());

    // TASK 4dc: set unconditionally, before either early-return below --
    // a Step click (or a play-loop tick) reaching this function at all
    // means the user asked this configuration to advance, regardless of
    // whether isDecoderQuiescent()/maxSteps then decide there's nothing
    // left to actually do.
    advanceRequested = true;

    if (isDecoderQuiescent(currentDecoder)) {
        // Stop the clock: don't step, don't advance any counter, and stop
        // playback if it's running instead of spinning forever.
        if (isPlaying) stopPlayback();
        updateStats();
        return false;
    }

    // TASK 4bc: a per-config step cap -- once reached without quiescing,
    // stop exactly like quiescence does (both the play loop and the Step
    // button ultimately call this same function, so one check covers
    // both), but updateStatusRow() reports "fail (timeout)" instead of
    // success/failure.
    if (hasReachedStepLimit()) {
        if (isPlaying) stopPlayback();
        updateStats();
        return false;
    }

    // TASK 4do: gated on ASYNC_MODE_ENABLED -- the checkbox's own .checked
    // state is treated as unchecked (every step goes through the
    // synchronous currentDecoder.step() below) while async mode is
    // disabled site-wide, regardless of how the checkbox itself got
    // checked (it's hidden, so a normal user can't, but this makes the
    // guarantee independent of that).
    const uncoord = ASYNC_MODE_ENABLED && document.getElementById('uncoordinated')?.checked;
    if (uncoord && typeof currentDecoder.stepUncoord === 'function') {
        currentDecoder.stepUncoord();
    } else if (isHierarchicalPresentation(currentDecoderType) && isPlaying) {
        // Snapshot the live Play interval for this batch's travelling pulses.
        currentDecoder.step(animationStepIntervalMs());
    } else {
        currentDecoder.step();
    }
    if (stopForSurgeryRejection()) return false;
    if (isRunOver()) {
        if (isPlaying) stopPlayback();
        updateStats();
        return false;
    }
    updateStats();
    return true;
}

// Both forward controls replay saved states before computing a fresh tick.
// Timer ticks leave rendering and the scheduler clock to animate().
function stepForwardOnce(fromPlayback = false) {
    if (!currentDecoder || stopForSurgeryRejection()) return false;
    finishInitialErrorsPointerGesture();
    if (redoHistory.length > 0) {
        pushStepHistory(captureStepState());
        restoreStepState(redoHistory.pop(), fromPlayback, true);
        if (stopForSurgeryRejection()) return false;
        if (isPlaying && isRunOver()) stopPlayback();
        return !isRunOver();
    }
    const keepStepping = stepOnce();
    if (!fromPlayback) render();
    return keepStepping;
}

function stepSimulation() {
    if (stopForSurgeryRejection()) return;
    if (!currentDecoder || (redoHistory.length === 0 && isRunOver())) return;
    if (isPlaying && playDirection === 'backward') stopPlayback();
    stepForwardOnce();
    return true;
}

function shouldRestartStoppedNoiseRun() {
    return !isSurgeryRejectionTerminal() && supportsNoiseStop() && !currentDecoder.isNoiseEnabled()
        && ((advanceRequested && isDecoderQuiescent(currentDecoder)) || hasReachedStepLimit());
}

// Transport controls always stay enabled. Their action guards handle
// unavailable requests; only a real play/pause transition changes the DOM.
function updatePlayButtons() {
    const center = document.getElementById('play-btn');
    const centerGlyph = isPlaying ? '❚❚' : '▶';
    const centerLabel = isPlaying ? 'pause' : 'play';
    if (center && center.textContent !== centerGlyph) center.textContent = centerGlyph;
    if (center && center.getAttribute('aria-label') !== centerLabel) center.setAttribute('aria-label', centerLabel);
    if (center && center.title !== centerLabel) center.title = centerLabel;
}

function stopPlayback() {
    if (!isPlaying) return;
    isPlaying = false;
    if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    updatePlayButtons();
    updateStatusRow();
    return true;
}

function togglePlayBack() {
    return togglePlay('backward');
}

function togglePlayback() {
    if (stopForSurgeryRejection()) return;
    if (isPlaying) return stopPlayback();
    return togglePlay();
}

function playForward() {
    if (stopForSurgeryRejection()) return;
    if (isPlaying && playDirection === 'forward') return;
    return togglePlay();
}

function togglePlay(direction = 'forward') {
    if (!currentDecoder || stopForSurgeryRejection()) return;
    // Guard before stopping the other direction or writing any DOM state.
    if (direction === 'backward' && stepHistory.length === 0) return;
    if (isPlaying && playDirection === direction) {
        return stopPlayback();
    }
    if (direction === 'forward' && isRunOver() && redoHistory.length === 0
        && !shouldRestartStoppedNoiseRun()) return;

    // Switch the scheduler without an intermediate pair of idle labels.
    if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    isPlaying = false;
    finishInitialErrorsPointerGesture();
    if (direction === 'forward') {
        // Only an explicit Play on a finished run restarts stopped noise.
        // Redo ticks themselves stop at their saved verdict.
        if (redoHistory.length === 0 && shouldRestartStoppedNoiseRun()) initializeErrors();
        if (redoHistory.length === 0) {
            // Preserve Play's reversible, zero-step verdict on a clear start.
            if (!advanceRequested && isDecoderQuiescent(currentDecoder)) {
                pushStepHistory(captureStepState());
            }
            advanceRequested = true;
            if (isDecoderQuiescent(currentDecoder) || hasReachedStepLimit()) {
                updateStats();
                render();
                return;
            }
        }
    }
    playDirection = direction;
    isPlaying = true;
    lastAnimationTime = 0;
    updatePlayButtons();
    animate(performance.now());
    updateStatusRow();
    return true;
}

// The "Status" row is always shown (fixed position in the stats panel):
// "running" during forward play; reverse uses the same status as manual
// Back (including "paused" and "noise stopped"). Once
// the user has actually asked to advance and quiescence was reached,
// "success" -- or "failure" if checkLogicalError() reports a logical error
// on the now-quiescent decoder, so a failed decode is never labelled a
// success (TASK 4y; TASK 4bc delta briefly tried "logical error", reverted
// in TASK 4bg). No step count is shown in any state. A freshly loaded or
// just-initialized decoder is often trivially quiescent too, but reset/
// initialize must show "paused" rather than immediately claiming success,
// hence gating on the advanceRequested flag (TASK 4dc) rather than on
// stepCount itself: stepCount alone under-reported this, since
// stepSimulation() bails out before incrementing it whenever the
// configuration was *already* quiescent when a Step/Play was requested
// (p=0, p=1, or an untouched manual lattice), which used to mean such a
// configuration could never show a verdict at all. Called both from
// updateStats() (every step) and directly from togglePlay() (so clicking
// Play/Pause updates it immediately, without waiting for the next step).
// TASK 4bc: a decoder config may set maxSteps (repetition2's own 20000,
// a runaway-safety valve for configurations -- e.g. p=0.5 -- that never
// quiesce at all); every other decoder stays uncapped unless it sets its
// own. Shared by updateStatusRow() (to report "fail (timeout)") and
// stepSimulation() (to actually stop stepping there).
function getCurrentDecoderConfig() {
    // URL-only decoders have no selected dropdown option.
    const decoderType = document.getElementById('decoder-select')?.value || currentDecoderType;
    return decoderConfigs[decoderType];
}

// TASK 4fo (updates 4fm-b): share the cap between stepping and status. A
// stopped-noise drain gets its own budget starting at the stop click's step.
// Once capped, Step cannot change the decoder or flip the verdict.
function hasReachedStepLimit() {
    const config = getCurrentDecoderConfig();
    const stepsTaken = currentDecoder?.stepCount || 0;
    // Manual events can be edited at any paused step, so ask the decoder
    // for the last event's consumption step instead of fixing this at init.
    const drainStartStep = isManualStreamingRun()
        ? currentDecoder.getDrainStartStep() : noiseStoppedAtStep;
    return !!((config?.maxSteps && stepsTaken >= config.maxSteps)
        || (config?.drainTimeoutSteps && drainStartStep !== null
            && stepsTaken - drainStartStep >= config.drainTimeoutSteps));
}

function isManualStreamingRun() {
    return currentDecoderType === 'repetition_streaming' && !!currentDecoder?.manualMode;
}

function isSurgeryRejectionTerminal() {
    return SURGERY_REJECTION_IS_TERMINAL && !!getCurrentDecoderConfig()?.surgery
        && !!currentDecoder && (!!currentDecoder.rejected || terminalSurgeryRejections.has(currentDecoder));
}

function stopForSurgeryRejection() {
    if (!isSurgeryRejectionTerminal()) return false;
    if (!terminalSurgeryRejections.has(currentDecoder)) {
        terminalSurgeryRejections.add(currentDecoder);
        if (currentDecoder.isNoiseEnabled?.()) {
            currentDecoder.setNoiseEnabled(false);
            noiseStoppedAtStep = currentDecoder.stepCount || 0;
        }
        stopPlayback();
        updateStats();
        render();
    }
    return true;
}

// Stop physical decoding at quiescence even while the logical verdict is
// pending. watchLogicalData resolves that verdict without another step.
function isRunOver() {
    return !!currentDecoder && (isSurgeryRejectionTerminal() || (advanceRequested && isDecoderQuiescent(currentDecoder))
        || hasReachedStepLimit());
}

function handleInitModeChange() {
    // The radio is only a preference, including after a verdict. Initialize
    // reads it explicitly; the first valid edit prepares a finished run.
}

// A finished configuration becomes the next editable initial condition.
// Keep its decoder, errors, messages, and controls; only restart run bookkeeping.
function resetFinishedRunForManualEditing() {
    clearStepHistory();
    if (isPlaying) stopPlayback();
    finishInitialErrorsPointerGesture();
    if (currentDecoderType === 'repetition_streaming') {
        currentDecoder.resetForManualEditing();
    } else {
        currentDecoder.stepCount = 0;
        if (currentDecoderType === 'repetition2') {
            currentDecoder.clockGrid.fill(0);
            currentDecoder._resetHistory();
        } else if (currentDecoderType === 'toric2') {
            for (const row of currentDecoder.c) row.fill(0);
        } else {
            currentDecoder.clock = 0;
        }
    }
    advanceRequested = false;
    noiseStoppedAtStep = null;
    lastAnimationTime = 0;
    updateStats();
    render();
}

function supportsNoiseStop() {
    return LAYOUT_THREE_PILLARS && !!getCurrentDecoderConfig()?.noiseStop
        && typeof currentDecoder?.setNoiseEnabled === 'function'
        && typeof currentDecoder?.isNoiseEnabled === 'function';
}

function updateNoiseButton() {
    const noiseBtn = document.getElementById('noise-btn');
    if (!noiseBtn) return;
    const available = supportsNoiseStop();
    const display = available ? '' : 'none';
    const disabled = !available || !currentDecoder.isNoiseEnabled();
    if (noiseBtn.style.display !== display) noiseBtn.style.display = display;
    if (noiseBtn.disabled !== disabled) noiseBtn.disabled = disabled;
    if (noiseBtn.textContent !== 'stop noise') noiseBtn.textContent = 'stop noise';
}

function updateSurgeryControls() {
    const available = !!getCurrentDecoderConfig()?.surgery && !!currentDecoder;
    for (const kind of ['merge', 'split']) {
        const button = document.getElementById(`${kind}-btn`);
        if (!button) continue;
        button.style.display = available ? '' : 'none';
        button.disabled = !available || isSurgeryRejectionTerminal()
            || !currentDecoder[kind === 'merge' ? 'canMerge' : 'canSplit']?.();
    }
    const xSector = available && currentDecoder.sector === 'x';
    const row = (key, visible, value) => {
        const element = document.getElementById(`${key}-row`);
        if (element) element.style.display = visible ? 'flex' : 'none';
        if (visible) updateStatText(document.getElementById(`${key}-value`), value);
    };
    const state = currentDecoder?.seamState || 'split';
    const introducing = state === 'merging' || state === 'splitting';
    row('seam-state', available, introducing
        ? `${state} (${currentDecoder.switchedSliceCount} of ${currentDecoder.K} slices switched)` : state);
    row('seam-frame', available && !xSector, currentDecoder?.seamFrameCommitted
        ? 'seam frame committed' : 'not committed');
    row('surgery-outcome', xSector, currentDecoder?.surgeryOutcome ?? 'pending');
    const decodedOutcome = currentDecoder?.rejected || isSurgeryRejectionTerminal() ? 'indeterminate'
        : currentDecoder?.outcomeCheck == null ? 'pending' : currentDecoder.outcomeCheck ? 'agrees' : 'disagrees';
    row('outcome-check', xSector, decodedOutcome);
    const outcomeValue = document.getElementById('outcome-check-value');
    outcomeValue?.classList.toggle('state-ok', xSector && decodedOutcome === 'agrees');
    outcomeValue?.classList.toggle('state-bad', xSector && (decodedOutcome === 'disagrees' || decodedOutcome === 'indeterminate'));
    // Surgery legend channels change only with the decoder and slice count.
    if (available) {
        const signature = `${currentDecoderType}:${currentDecoder.K}`;
        if (surgeryLegendSignature !== signature) {
            updateLegend(currentDecoderType, currentLoadedModule);
            surgeryLegendSignature = signature;
            hierarchicalLegendK = currentDecoder.K;
        }
    }
}

function updateProtocolStateRows() {
    const available = typeof currentDecoder?.getProtocolState === 'function';
    const state = available ? currentDecoder.getProtocolState() : null;
    const verdict = available ? currentDecoder.getProtocolVerdict() : null;
    const injection = currentDecoder?.protocolKind === 'inject';
    const rows = [
        ['protocol-wall', injection ? 'region' : 'wall', available, state?.wallPosition],
        ['protocol-frame-flips', 'frame flips', available, state?.frameFlips],
        ['protocol-frame-committed', 'frame committed', available,
            state?.frameCommitted ? `yes, step ${state.frameCommitStep}` : 'no'],
        ['protocol-attempts', 'attempts', available && injection, state?.attempts],
        ['protocol-rejection', 'rejection', available && injection,
            state?.rejected ? `rejected (${state.rejectionCount}); ${state.frameCommitted ? 'retry committed' : 'retrying'}` : 'no'],
        ['protocol-frame-consistency', 'frame consistency', available && !!verdict?.drained,
            verdict?.frameConsistent ? 'consistent' : 'inconsistent'],
        ['protocol-logical', 'X̄ proxy', available && !!verdict?.drained,
            verdict?.logicalEven ? '+1 (even)' : '−1 (odd)'],
    ];
    for (const [key, label, visible, value] of rows) {
        // Avoid creating hidden protocol nodes on an ordinary page load.
        let row = document.getElementById(`${key}-row`);
        if (available && !row) row = ensureStateCardRow(`${key}-row`, label, `${key}-value`);
        if (!row) continue;
        row.style.display = visible ? 'flex' : 'none';
        if (row.firstElementChild) row.firstElementChild.textContent = `${label}:`;
        if (visible) {
            const target = document.getElementById(`${key}-value`);
            updateStatText(target, value ?? 'pending');
            if (target) target.style.whiteSpace = 'normal';
        }
    }
}

function startSurgery(kind) {
    if (stopForSurgeryRejection()) return;
    if (!getCurrentDecoderConfig()?.surgery || !currentDecoder) return;
    if (!currentDecoder[kind === 'merge' ? 'canMerge' : 'canSplit']()) return;
    // Keep the previous checkpoint; the next forward step captures the
    // operation as part of decoder state, so reverse/replay crosses it intact.
    pushStepHistory(captureStepState());
    clearStepRedo();
    currentDecoder[kind]();
    advanceRequested = false;
    updateStats();
    render();
}

// TASK 4fo (updates 4fm): stop once per initialization. The existing
// Initialize, Reset, and decoder-load paths restore noise and the button.
function stopNoise() {
    if (!supportsNoiseStop() || !currentDecoder.isNoiseEnabled()) return;
    clearStepRedo();
    currentDecoder.setNoiseEnabled(false);
    noiseStoppedAtStep = currentDecoder.stepCount || 0;
    updateStats();
    render();
}

function updateStatusRow() {
    const statusValue = document.getElementById('status-value');
    if (!statusValue || !currentDecoder) return;
    updatePlayButtons();

    const rejectedRun = isSurgeryRejectionTerminal();
    const quiescentRun = !rejectedRun && advanceRequested && isDecoderQuiescent(currentDecoder);
    const check = quiescentRun || currentDecoder.logicalDataReady
        ? getRunLogicalCheck(currentDecoder) : { hasError: false };
    const data = logicalDataState(currentDecoder);
    const logicalText = check.unavailable || data.failed || (data.expired && !data.loaded)
        ? 'data could not be loaded' : currentDecoder.logicalDataReady && !data.loaded
            ? 'loading…' : '';
    // Ready data needs no state-card row; retain it only for loading or failure.
    const logicalRow = document.getElementById('logical-check-row');
    if (logicalRow) logicalRow.style.display = currentDecoder.logicalDataReady && logicalText ? 'flex' : 'none';
    updateStatText(document.getElementById('logical-check-value'), logicalText);
    const logicalCheck = quiescentRun ? check : null;
    // The unavailable verdict must wrap beside its label, including
    // under the three-pillar stylesheet's normally unwrapped status rule.
    statusValue.style.whiteSpace = logicalCheck?.unavailable ? 'normal' : '';
    statusValue.style.minWidth = logicalCheck?.unavailable ? '0' : '';
    if (rejectedRun) {
        currentDecoder.finishRunPresentation?.(animationStepIntervalMs());
        updateStatText(statusValue, 'failure');
        statusValue.style.color = '#f87171';
        statusValue.style.fontWeight = '600';
        statusValue.style.width = '';
        statusValue.style.justifySelf = '';
    } else if (logicalCheck) {
        const hasLogicalError = !!logicalCheck.hasError;
        // TASK 4bg: back to "failure" (TASK 4bc delta had tried "logical
        // error"; reverted by user's choice).
        // Finish in-flight presentation on its own clock once stepping ends.
        currentDecoder.finishRunPresentation?.(animationStepIntervalMs());
        updateStatText(statusValue, logicalCheck.pending ? 'pending data'
            : logicalCheck.unavailable ? 'success (logical check unavailable)'
                : hasLogicalError ? 'failure' : 'success');
        statusValue.style.color = logicalCheck.pending ? '' : hasLogicalError ? '#f87171' : '#34d399';
        statusValue.style.fontWeight = logicalCheck.pending ? '' : '600';
        statusValue.style.width = '';
        statusValue.style.justifySelf = '';
    } else if (hasReachedStepLimit()) {
        // Both step caps report a failed timeout with the failure verdict's style.
        currentDecoder.finishRunPresentation?.(animationStepIntervalMs());
        updateStatText(statusValue, 'fail (timeout)');
        statusValue.style.color = '#f87171';
        statusValue.style.fontWeight = '600';
        // Size the longer verdict to its text; the row keeps it at the
        // shared right edge using the free space beside its own label.
        statusValue.style.width = 'max-content';
        statusValue.style.justifySelf = 'end';
    } else {
        updateStatText(statusValue, supportsNoiseStop() && !isManualStreamingRun() && !currentDecoder.isNoiseEnabled()
            && !isDecoderQuiescent(currentDecoder) ? 'noise stopped' : isPlaying && playDirection === 'forward' ? 'running' : 'paused');
        statusValue.style.color = '';
        statusValue.style.fontWeight = '';
        statusValue.style.width = '';
        statusValue.style.justifySelf = '';
    }
}

let lastAnimationTime = 0;

// TASK 4dl: rolling estimate of the healthy per-frame gap (seeded at a
// 60Hz assumption, corrected toward whatever the real display delivers
// within the first handful of frames via the EMA below), used only to
// recognise an actual STALL -- a backgrounded tab, a long GC pause, the
// debugger, or simply resuming Play a while after Pause -- without
// hardcoding any particular refresh rate. A frame is judged "not a
// stall" against the PRIOR estimate before that estimate is updated, so
// a genuine stall never corrupts it.
let lastFrameInterval = 1000 / 60;

const MAX_STEPS_PER_FRAME = 50; // TASK 4dl: hard safety-valve cap, independent of speed or the stall clamp below

// TASK 4dl: the old design (TASK 4r/4aj, replaced here) ran at most one
// step per displayed frame, capping the achievable rate at
// min(animationSpeed, refresh rate) -- correct up to the refresh rate,
// but unable to honour a speed setting above it (e.g. 100 on a 60Hz
// display topped out around 60). The user now wants speed honoured above
// the refresh rate, accepting that not every step gets its own render.
// Each frame now computes an "owed steps" accumulator -- elapsed time
// (since the last frame that actually consumed some) times speed,
// floored -- and runs that many stepOnce() calls before rendering once,
// instead of the old single conditional step.
//
// This still gives exactly one step per frame whenever speed is at or
// below the frame rate: delta (a single frame's real gap) is then always
// smaller than stepInterval except on the one frame where the
// accumulated fractional remainder finally crosses it, so
// floor(delta / stepInterval) is 0 on every other frame and 1 on that
// one -- never more -- reproducing the old cadence exactly (e.g. speed
// 30 on a 60Hz display: one step every other frame, never two). Only
// once speed genuinely exceeds the frame rate does a single frame's real
// gap exceed stepInterval enough to floor to 2 or more.
//
// TASK 4aj's original stall clamp is generalised, not dropped: a raw gap
// more than 3x the healthy-frame estimate is treated as at most one
// healthy frame's worth of elapsed time instead of the raw (possibly
// multi-second) gap, so the owed-steps computation below can never see
// more debt than one normal frame would accumulate. This is what
// actually prevents a burst -- merely capping steps-per-frame at
// MAX_STEPS_PER_FRAME would still leave the rest of a large gap's debt
// to be worked through, at the cap, over however many more frames it
// takes; discarding the excess up front means there is no leftover debt
// to work through at all. MAX_STEPS_PER_FRAME itself is a separate,
// always-active ceiling (e.g. an absurdly high speed with no stall
// involved), never bypassed by the stall clamp.
//
function animationStepIntervalMs() {
    return 1000 / animationSpeed;
}

// The shared forward/back helpers are called directly in the loop below
// so rendering happens once per frame regardless of how many steps ran;
// it returns false the instant quiescence or the maxSteps cap is hit
// (checked after every single step, not just after the batch), so a run
// that converges mid-frame stops on exactly the terminating step and
// that exact state is what gets rendered, rather than the loop calling
// stepOnce() again on an already-finished decoder or rendering a state
// that isn't actually the terminating one.
function animate(currentTime) {
    if (!isPlaying || !currentDecoder) return;
    if (stopForSurgeryRejection()) return;

    if (!lastAnimationTime) {
        // First frame of this Play session (or the very first ever): no
        // time has elapsed to owe anything yet -- just seed the clock and
        // wait for the next real frame, exactly as before.
        lastAnimationTime = currentTime;
        animationId = requestAnimationFrame(animate);
        return;
    }

    const rawDelta = currentTime - lastAnimationTime;
    const stepInterval = animationStepIntervalMs(); // speed is directly steps/second, read live every frame

    if (rawDelta < 3 * lastFrameInterval) {
        lastFrameInterval = lastFrameInterval * 0.9 + rawDelta * 0.1;
    }
    const delta = (rawDelta > 3 * lastFrameInterval) ? lastFrameInterval : rawDelta;

    const owedSteps = Math.min(Math.floor(delta / stepInterval), MAX_STEPS_PER_FRAME);

    if (owedSteps > 0) {
        for (let i = 0; i < owedSteps; i++) {
            if (playDirection === 'backward') {
                stepBackOnce(true);
                if (stepHistory.length === 0) {
                    stopPlayback();
                    break;
                }
            } else if (!stepForwardOnce(true)) break;
        }
        render(); // once per frame, regardless of how many steps just ran
    }

    // Resync relative to currentTime (not the possibly-stale old
    // lastAnimationTime), leaving only the fractional remainder within
    // one stepInterval as debt for the next frame. Algebraically
    // equivalent to the old `lastAnimationTime += owedSteps * stepInterval`
    // when delta === rawDelta (no stall), but also correctly re-anchors
    // to "now" -- rather than a stale pre-stall timestamp -- whenever the
    // clamp above did fire, which is what actually discards the excess
    // instead of merely deferring it to later frames.
    lastAnimationTime = currentTime - (delta - owedSteps * stepInterval);

    if (isPlaying) animationId = requestAnimationFrame(animate);
}

// Reset = decoder defaults + Initialize. Speed, display, and init mode persist.
function resetSimulation() {
    if (!currentDecoder) return;
    restoreDecoderDefaults(getCurrentDecoderConfig());
    return initializeErrors();
}

// Keep each stat's text node in place; a run update must not rebuild DOM.
function updateStatText(element, value) {
    if (!element) return;
    const text = String(value);
    if (element.textContent === text) return;
    if (element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE) {
        element.firstChild.nodeValue = text;
    } else {
        element.textContent = text;
    }
}

// Keep optional state rows in the host so the shared static markup and
// styles stay unchanged. Once created, their text nodes survive updates.
function ensureStateCardRow(id, label, valueId) {
    let row = document.getElementById(id);
    const statusRow = document.getElementById('status-row');
    if (!row && statusRow?.parentNode) {
        row = document.createElement('div');
        row.id = id;
        row.className = 'stat-row';
        const name = document.createElement('span');
        name.textContent = `${label}:`;
        const value = document.createElement('span');
        value.id = valueId;
        row.appendChild(name);
        row.appendChild(value);
        statusRow.parentNode.insertBefore(row, statusRow);
    }
    return row;
}

function updateStats() {
    if (!currentDecoder) return;
    updateNoiseButton();
    updateSurgeryControls();
    updateProtocolStateRows();

    const stepCount = document.getElementById('step-count');
    const clockRow = document.getElementById('clock-row');
    const clockValue = document.getElementById('clock-value');
    const defectsRow = document.getElementById('defects-row');
    const syndromeCount = document.getElementById('syndrome-count');
    const decoderDefectsRow = document.getElementById('decoder-defects-row');
    const decoderDefectsCount = document.getElementById('decoder-defects-count');
    const systemDefectsRow = document.getElementById('system-defects-row');
    const systemDefectsCount = document.getElementById('system-defects-count');

    updateStatText(stepCount, currentDecoder.stepCount || 0);
    // TASK 4ay: the "clock" row is meaningless in two cases, checked
    // generically rather than by decoder name -- (a) uncoordinated/
    // asynchronous mode, where sites update one at a time with no global
    // clock at all (the checkbox is only ever checked when the current
    // decoder actually supports that mode, and gets reset on every
    // decoder switch, so no separate config lookup is needed here), and
    // (b) any decoder whose `.clock` isn't a real number in the first
    // place. Re-evaluated on every stats update, which already runs on
    // every decoder load and on the checkbox's own change handler
    // (it reloads the decoder), so both of the task's required triggers
    // are covered without a separate listener.
    // TASK 4do: gated on ASYNC_MODE_ENABLED -- the clock-period row is
    // never hidden for async reasons while async mode is disabled site-
    // wide (it can still be hidden for the OTHER reason, an unmeaningful
    // .clock value, independent of this flag).
    const asyncActive = ASYNC_MODE_ENABLED && !!document.getElementById('uncoordinated')?.checked;
    const hasMeaningfulClock = Number.isFinite(currentDecoder.clock);
    if (clockRow) clockRow.style.display = (asyncActive || !hasMeaningfulClock) ? 'none' : 'flex';
    // Hierarchical streaming starts its internal time at -1, before the
    // first round. Show a fresh system's clock as 0 without changing that
    // dynamics sentinel; subsequent steps use the decoder's own clock.
    updateStatText(clockValue, currentDecoder.stepCount === 0 ? 0 : currentDecoder.clock || 0);
    const decoderDefects = currentDecoder.getSyndromeCount();
    updateStatText(syndromeCount, decoderDefects);
    const errorsRow = document.getElementById('errors-row');
    const showErrorCount = !!getCurrentDecoderConfig()?.showErrorCount;
    if (errorsRow) errorsRow.style.display = showErrorCount ? 'flex' : 'none';
    if (showErrorCount) updateStatText(document.getElementById('error-count'), currentDecoder.getErrorCount());

    const messagesRow = ensureStateCardRow('messages-row', 'messages', 'messages-count');
    const showMessages = ['xcube_lineon', 'xcube_fracton', 'haah_streaming'].includes(currentDecoderType);
    if (messagesRow) messagesRow.style.display = showMessages ? 'flex' : 'none';
    if (showMessages) updateStatText(document.getElementById('messages-count'), currentDecoder.getMemoryCount());

    ensureStateCardRow('logical-check-row', 'logical check', 'logical-check-value');
    const logicalValue = document.getElementById('logical-check-value');
    if (logicalValue) logicalValue.style.whiteSpace = 'normal';

    // Streaming cards distinguish live decoder-slice defects from the
    // corrected physical system's syndrome; preparation/injection getters
    // measure that syndrome relative to psi. Other cards keep one row.
    const hasSystemDefects = typeof currentDecoder.getSystemDefectCount === 'function';
    if (defectsRow) defectsRow.style.display = hasSystemDefects ? 'none' : 'flex';
    if (decoderDefectsRow) decoderDefectsRow.style.display = hasSystemDefects ? 'flex' : 'none';
    if (systemDefectsRow) systemDefectsRow.style.display = hasSystemDefects ? 'flex' : 'none';
    if (systemDefectsRow) systemDefectsRow.title = typeof currentDecoder.getProtocolState === 'function'
        ? `Residual syndrome relative to the ${currentDecoder.frameCommitted ? 'committed' : 'current'} frame ψ`
        : '';
    if (hasSystemDefects) {
        updateStatText(decoderDefectsCount, decoderDefects);
        updateStatText(systemDefectsCount, currentDecoder.getSystemDefectCount());
    }

    updateStatusRow();

    // TASK 4jt: load, Initialize (also Slices Enter/Reset), and history
    // restoration all update stats before rendering. Rebuild only when
    // the applied K changes, leaving legend nodes intact on ordinary steps.
    if (isHierarchicalPresentation(currentDecoderType) && hierarchicalLegendK !== currentDecoder.K) {
        updateLegend(currentDecoderType, currentLoadedModule);
        hierarchicalLegendK = currentDecoder.K;
    }

    // TASK 4bg: row visibility (defects/clock) for
    // *this* decoder is only fully settled by this point in the function,
    // so this is the reliable place to keep the legend card's width in
    // sync with the stats card's own (see syncLegendWidthToInfoPanel()).
    syncLegendWidthToInfoPanel();
}

function render() {
    if (!currentDecoder) return;
    // DPR can change without a resize event (for example between displays).
    // Resize the backing store before applying this frame's drawing scale.
    if (canvasPixelRatio !== (window.devicePixelRatio || 1)) applyCanvasSize();

    // TASK 4ew: bypassed under the three-pillar layout -- this only ever
    // positions .description-stack (the WRAPPER)'s own inline `top`, and
    // that wrapper is both empty (its card moved into #right-pillar at
    // startup) and hidden (styles.css's own body.layout-three-pillars
    // rule) under the flag, so the position it computes would have no
    // visible effect either way; skipped rather than left as dead work
    // since a module's own getDescriptionAnchor() has no reason to expect
    // calls once its card no longer lives where that anchor targets.
    if (!LAYOUT_THREE_PILLARS) updateDescriptionCardPosition();

    // TASK 4dy: computed once here and threaded through both the title
    // positioning call and the decoder's own render() options, so a
    // module that wants to adapt its own layout to how much room these
    // cards actually leave (surface_streaming_3d.js, so far) and the
    // title-centring call that depends on that same adapted layout both
    // see identical rects from one measurement, not two that could
    // disagree if read a frame apart.
    const overlayRects = computeOverlayRects();
    updateTitlePosition(overlayRects);

    const showSyndrome = document.getElementById('show-syndrome')?.checked ?? true;
    const showErrors = document.getElementById('show-errors')?.checked ?? true;
    const showMessages = document.getElementById('show-messages')?.checked ?? true;
    const showGrid = document.getElementById('show-grid')?.checked ?? true;
    const options = { showSyndrome, showErrors, showMessages, showGrid, overlayRects };

    try {
        if (currentDecoder.is3DMode) {
            // Combined mode: Three.js runs its own RAF loop; just refresh the slice panel
            currentDecoder.render(null, 0, 0, options);
            return;
        }
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        currentDecoder.render(ctx, cssWidth, cssHeight, options);
        // Presentation can outlive a Step click or a slow Play tick. Repaint
        // through the same render path, including one frame after expiry to
        // clear the last highlight, without advancing the simulation.
        if (currentDecoder.needsAnimationFrame?.() && transientAnimationId === null) {
            transientAnimationId = requestAnimationFrame(() => {
                transientAnimationId = null;
                render();
            });
        }
    } catch (error) {
        console.error("Error during render:", error);
    }
}

// TASK 4cq: a module can optionally provide
// getDescriptionAnchor(cssWidth, cssHeight) -> { bottom } (canvas-local CSS
// px, same coordinate system as the module's own _layout()) to pin the
// description card's bottom edge to some feature of its own drawn graphic
// -- repetition2 anchors it to the site-row strip's bottom -- instead of
// the fixed 184px CSS top every other tab still uses. Called from the top
// of render() itself, which is already the one shared choke-point every
// trigger the task calls out funnels through: loadDecoder() (initial load,
// decoder switch), initializeErrors(), and resizeCanvas() (window resize)
// both call render() directly, and the step/play controls call it via
// updateStats()'s own callers -- so one hook here covers all of them
// without separate listeners. A module without the method (or returning
// something non-finite) has its card's inline top cleared, releasing it
// back to the CSS rule's fixed value -- so switching from repetition2 to
// any other tab doesn't leave a stale dynamic position behind.
function updateDescriptionCardPosition() {
    const card = document.querySelector('.description-stack');
    if (!card || !canvas) return;
    // TASK 4de: a decoder with no getDescriptionAnchor() of its own now
    // defaults to the SAME { top: DESCRIPTION_TOP_CSS } anchor every other
    // module without a bottom-tracking box already opts into explicitly
    // (TASK 4da/4cz-b), instead of clearing the inline style and falling
    // back to the old fixed CSS top (364.5px) -- so a module only needs its
    // own getDescriptionAnchor() when it wants something OTHER than the
    // shared default (repetition2's own bottom-of-history-box tracking is
    // still the one deliberate exception). Affects surface_streaming_3d,
    // surface_cg_streaming and haah.js, the three modules with no
    // getDescriptionAnchor method at all.
    const anchor = (currentDecoder && typeof currentDecoder.getDescriptionAnchor === 'function')
        ? currentDecoder.getDescriptionAnchor(cssWidth, cssHeight)
        : { top: DESCRIPTION_TOP_CSS };
    if (!anchor) {
        card.style.top = '';
        return;
    }
    // TASK 4da: a module can anchor by { top } instead of { bottom } --
    // toric2/surface2 use this to match repetition2's own card top exactly
    // (repetition2.js's own exported DESCRIPTION_TOP_CSS), rather than
    // tracking their own box's bottom edge, which would land their cards
    // much higher up than repetition2's (their lattices are far shorter
    // than repetition2's own history box at the same canvas size).
    if (Number.isFinite(anchor.top)) {
        card.style.top = `${Math.round(canvas.offsetTop + anchor.top)}px`;
        return;
    }
    if (!Number.isFinite(anchor.bottom)) {
        card.style.top = '';
        return;
    }
    const targetBottom = canvas.offsetTop + anchor.bottom;
    // TASK 4cz: clamped to 0 -- found via repetition_streaming, whose
    // anchor box (the future panel) sits much higher up the canvas than
    // repetition2's/toric2's/surface2's own (their boxes grow to fill most
    // of the available canvas height; this module's boxes are a handful
    // of fixed-row-count panels near the top regardless of canvas size),
    // while its own description text is long enough to need a much taller
    // card than those modules'. Without this clamp, `targetBottom -
    // card.offsetHeight` went negative, pushing the card's top above the
    // canvas-area entirely -- confirmed via a live screenshot showing it
    // overlapping the page title. Clamping to 0 lands the card flush with
    // the top of .canvas-area instead (same level as the canvas/title)
    // whenever it's too tall to end exactly at the target while starting
    // from a sane position; every other module's own anchor value is
    // comfortably positive already, so this is a no-op for them.
    card.style.top = `${Math.max(0, Math.round(targetBottom - card.offsetHeight))}px`;
}

// TASK 4dy: canvas CSS-relative rects (left/right/top/bottom, canvas-local
// CSS px -- the same coordinate system every module's own _layout() and
// getTitleAnchor()/getDescriptionAnchor() already use) for the three
// overlay cards that can sit over a decoder's drawn content, computed
// fresh on every render() call. Lets a module derive its own margins from
// where these cards actually are instead of a fixed worst-case constant
// (surface_streaming_3d.js, so far, via its own _layout()'s overlayRects
// parameter) -- a card's own entry is null if it isn't found in the DOM
// (shouldn't happen given index.html always renders all three, but
// defensive) or the canvas itself isn't ready yet.
function computeOverlayRects() {
    if (!canvas) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const relRect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            left: r.left - canvasRect.left, right: r.right - canvasRect.left,
            top: r.top - canvasRect.top, bottom: r.bottom - canvasRect.top,
        };
    };
    // TASK 4ew: under the three-pillar layout, none of these four cards
    // sit over the canvas any more (they live in #right-pillar instead,
    // moved there once at startup by setupThreePillarLayout()) -- every
    // module's own margin/centring logic already treats a null card rect
    // here as "this card isn't relevant to my layout" (the same
    // Number.isFinite(...) guards that handle a canvas not being ready
    // yet, or a Node test harness calling _layout() with no overlayRects
    // at all), so returning null for all four unconditionally falls every
    // module back to its own existing plain-centring path with no new
    // branch needed in most of them. `noOverlayCards` is an explicit,
    // separate signal (not just "these four are null") for the two
    // modules whose own fallback constants (surface_streaming_3d.js,
    // surface_cg_streaming.js) assume a WORST-CASE card footprint when
    // overlayRects is merely absent (a direct Node-harness call) --
    // that's still the right conservative guess in that case, but wrong
    // (needlessly small) once this flag guarantees no card exists
    // anywhere on the page; see those two files' own _layout() comments.
    const cardsHidden = LAYOUT_THREE_PILLARS;
    return {
        description: cardsHidden ? null : relRect(document.querySelector('.description-stack')),
        infoPanel: cardsHidden ? null : relRect(document.querySelector('.info-panel')),
        legend: cardsHidden ? null : relRect(document.querySelector('.legend')),
        // TASK 4er: .description-panel's OWN rect, distinct from
        // `description` above (.description-stack, the default-placement
        // WRAPPER -- empty once the card has moved into .overlay-stack for
        // the 'right' variant, so it can't answer "where does the
        // description card itself sit" for that variant). Added so a
        // consumer can find the true leftmost edge among all three
        // right-hand cards regardless of .overlay-stack's own
        // align-items: under flex-start every card shares one left edge
        // (any of them will do), but under flex-end (TASK 4er) the widest
        // card (description, 180px) is the one that actually extends
        // furthest left -- infoPanel/legend, right-aligned to the same
        // edge at their own narrower ~136px, fall short of it.
        descriptionPanel: cardsHidden ? null : relRect(document.querySelector('.description-panel')),
        // TASK 4eq: .visualization-container's own rect, canvas-relative
        // like every other field here -- panel.left is negative (the
        // panel's own left border sits before the canvas's), so a
        // consumer wanting the canvas's own offset FROM the panel's left
        // border (a positive px value) reads -panel.left. Added for
        // repetition2.js's own panel-relative box centring; harmless for
        // every other module, which doesn't read this field. Computed
        // regardless of LAYOUT_THREE_PILLARS -- it describes the panel
        // itself, not a floating card, and repetition2.js's own
        // haveRightPlacementGeometry already requires the (now-null)
        // card fields above too, so this alone can never wrongly enable
        // its cards-aware branch.
        panel: relRect(document.querySelector('.visualization-container')),
        // TASK 4ew: see the comment above -- true only when the flag is on,
        // read by surface_streaming_3d.js/surface_cg_streaming.js's own
        // _layout() to choose a zero (rather than worst-case) fallback
        // margin.
        noOverlayCards: cardsHidden,
        narrowLayout: isNarrowLayout(),
    };
}

// TASK 4ec: the actual "the cards changed size, re-lay-out the canvas"
// work -- render() itself already recomputes overlayRects (via
// computeOverlayRects() above) and repositions the title/description card
// on every call; syncLegendWidthToInfoPanel() is the one other card-size-
// dependent side effect that ISN'T part of render() proper (it lives in
// updateStats() normally), so it's called here explicitly rather than
// pulling in the rest of updateStats()'s own step-count/clock/syndrome
// work, which has nothing to do with card sizing. TASK 4ec supplement:
// ordered before render() (was after) for the same reason loadDecoder()'s
// own initial render/updateStats() pair was reordered -- render() reads
// .legend's current width via computeOverlayRects(), so syncing it first
// means that read is never one step behind whatever just triggered this
// (this specific case is usually harmless either way, since surface_
// streaming_3d's own rightMargin already takes the min() of the state/
// legend cards' left edges and .info-panel is always the true driver, but
// ordering it correctly removes the edge case rather than relying on that).
// TASK 4eg: applyCanvasSize() now sits between those two calls, for the
// same reason -- a module's own getPreferredCanvasHeight() can depend on
// the very same card rects (e.g. surface_streaming_3d's own rightMargin,
// reused inside it via _layout()), so it needs the legend already synced
// too, and needs to run before render() so a card-driven change (a font
// swapping in, most notably -- see watchOverlayCardSizes() below) that
// changes the preferred height is picked up immediately rather than
// waiting for the next actual window resize.
function relayoutForCardResize() {
    syncLegendWidthToInfoPanel();
    applyCanvasSize();
    render();
}

// TASK 4ec: true while a relayout is already queued for the next
// animation frame -- lets scheduleCardResizeRelayout() below coalesce any
// number of resize notifications arriving before that frame fires into
// exactly one relayoutForCardResize() call.
let cardResizeRafPending = false;

// TASK 4ec: schedules relayoutForCardResize() for the next animation
// frame -- called both after document.fonts.ready resolves and from the
// ResizeObserver in watchOverlayCardSizes() below, so a font swap, a
// status-text-driven width change, or a window resize all re-lay-out the
// canvas immediately instead of waiting for the next user action (the bug
// this task fixes: previously nothing re-rendered when the font arrived,
// so the surface_streaming_3d stack -- the only module currently reading
// overlayRects -- stayed laid out against the fallback font's narrower
// cards until Initialize forced the next render).
//
// Two safeguards: (a) coalescing via cardResizeRafPending, so N
// notifications in the same tick/frame (e.g. all three watched elements
// resizing together on one font swap) produce one relayout, not N; (b) a
// no-op whenever a Play loop is already running (isPlaying) -- animate()
// already calls render() every single frame in that case, so a card
// resize during Play needs no separate scheduling at all, and skipping it
// here avoids a redundant extra render on top of the loop's own.
function scheduleCardResizeRelayout() {
    if (cardResizeRafPending || isPlaying) return;
    cardResizeRafPending = true;
    requestAnimationFrame(() => {
        cardResizeRafPending = false;
        if (isPlaying) return; // Play may have started while this frame was pending
        relayoutForCardResize();
    });
}

// TASK 4ec: wires up both triggers that can leave the canvas laid out
// against stale card sizes -- called once from the DOMContentLoaded
// handler below (the three watched elements are static, page-lifetime
// nodes per index.html, never recreated on decoder switch, so a single
// one-time ResizeObserver/font hook covers the whole page's lifetime).
//
// (1) document.fonts.ready: resolves once every web font either loads or
// fails AND at least one layout pass has happened -- exactly the moment
// the state/legend cards can jump from their fallback-font width (~136px)
// to JetBrains Mono's own (~196px). If the page's very first render (from
// loadDecoder()/applyUrlParamsAndLoad(), unblocked and unchanged by this
// task) happened before that -- the normal case whenever the font is
// fetched over the network, as on the user's own laptop -- this is what
// catches the resulting size change instead of leaving it stale until the
// next user action.
//
// (2) ResizeObserver on .description-stack/.info-panel/.legend: covers
// every OTHER way these cards' sizes can change after the fact --
// window resize, or status text long/short enough to change .info-panel's
// own max-content column width (which is itself a legitimate, expected
// trigger here, not a bug: see syncLegendWidthToInfoPanel()'s own
// "compare before writing" guard for why this settles in at most two
// passes rather than looping when THAT card-size change is the .legend
// write this same relayout just made).
function watchOverlayCardSizes() {
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => scheduleCardResizeRelayout());
        for (const selector of ['.description-stack', '.info-panel', '.legend']) {
            const el = document.querySelector(selector);
            if (el) observer.observe(el);
        }
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => scheduleCardResizeRelayout());
    }
}

// TASK 4cw: a module can optionally provide getTitleAnchor(cssWidth,
// cssHeight) -> { centerX } (canvas-local CSS px, same coordinate system as
// getDescriptionAnchor/_layout()) to horizontally re-centre the decoder
// title on some feature of its own drawn graphic -- repetition2 centres it
// on the spacetime history box's own outline, since the box sits ~15px
// off the panel's centre (the "t" label's reserved gutter only exists on
// its left). Vertical position is never touched. Uses transform:
// translateX (not position:relative + left) since .viz-title needs no
// extra `position` override for that to work, and it doesn't affect the
// element's own layout box during the "reset and re-measure" step below.
// Called from the same render() hook as updateDescriptionCardPosition, so
// it covers every trigger that function's own comment already lists.
// TASK 4dy: takes the same overlayRects render() itself now computes and
// passes to the decoder's own render() options, so a module whose
// getTitleAnchor() needs them (to centre on an adaptive-margin layout)
// sees the identical rects both calls were computed from.
function updateTitlePosition(overlayRects) {
    const title = document.getElementById('decoder-name');
    if (!title) return;
    if (isNarrowLayout() || !currentDecoder || typeof currentDecoder.getTitleAnchor !== 'function') {
        title.style.transform = '';
        return;
    }
    // Subtract our existing translation when measuring the natural centre.
    // Clearing and reapplying it would mutate the title on every quiet restart.
    const previousShift = parseFloat(title.style.transform.match(/translateX\(([-\d.]+)px\)/)?.[1]) || 0;
    const anchor = currentDecoder.getTitleAnchor(cssWidth, cssHeight, overlayRects);
    if (!anchor || !Number.isFinite(anchor.centerX) || !canvas) {
        title.style.transform = '';
        return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const boxCenterPage = canvasRect.left + anchor.centerX;
    const naturalRect = title.getBoundingClientRect();
    const naturalCenter = (naturalRect.left + naturalRect.right) / 2 - previousShift;
    const shift = Math.round(boxCenterPage - naturalCenter);
    const transform = shift !== 0 ? `translateX(${shift}px)` : '';
    if (title.style.transform !== transform) title.style.transform = transform;
}

// Map a mouse/pointer event's screen coordinates to canvas-local CSS
// coordinates, through the bounding rect's own (CSS-scaled) size rather
// than canvas.width/height (the DPR-scaled backing store), so positions
// stay correct both under devicePixelRatio scaling and if the CSS
// max-width rule ever shrinks the element below its own style.width/height.
function canvasEventToLocal(event) {
    const rect = canvas.getBoundingClientRect();
    return [
        (event.clientX - rect.left) * cssWidth / rect.width,
        (event.clientY - rect.top) * cssHeight / rect.height,
    ];
}

function isCodeCapacityDecoder(decoderType) {
    return ['repetition2', 'toric2', 'surface2', 'haah', 'xcube_lineon', 'xcube_fracton'].includes(decoderType);
}

// Streaming retains its paused future-window rule; its module checks rows.
export function canEditInitialErrorsForRun({ stepCount, isOver, isPlaying, mode,
    isCurrentDecoder = true, decoderType }) {
    return isCurrentDecoder && mode === 'manual' && !isPlaying
        && (!isCodeCapacityDecoder(decoderType) || stepCount === 0 || isOver);
}

function canEditInitialErrors(decoder = currentDecoder) {
    return canEditInitialErrorsForRun({
        stepCount: decoder?.stepCount, isOver: isRunOver(), isPlaying,
        mode: document.querySelector('input[name="init-mode"]:checked')?.value,
        isCurrentDecoder: !!decoder && decoder === currentDecoder,
        decoderType: currentDecoderType,
    });
}

// Clear a finished run's bookkeeping before applying the first edit to its
// existing configuration, including edits made through Haah's live viewer.
function prepareInitialErrorsEdit(decoder = currentDecoder) {
    if (!canEditInitialErrors(decoder)) return null;
    clearStepRedo();
    if (isRunOver()) resetFinishedRunForManualEditing();
    return currentDecoder;
}

function handleCanvasClick(event) {
    if (!canEditInitialErrors()) return;
    // TASK 4ar: a decoder with its own pointerDown/pointerMove/pointerUp
    // drag protocol (below) handles a plain click itself -- pointerdown
    // then pointerup with no intervening move is exactly a zero-length
    // drag, which pointerDown() alone already resolves into a single
    // toggle. Falling through to toggleErrorAtPosition() here too would
    // double-toggle the same qubit right back off, since a real click also
    // synthesizes this 'click' event after its own pointerdown/pointerup
    // pair. Decoders without pointerDown (the streaming modules' no-ops,
    // general_cc, haah, etc.) are untouched and keep working exactly as
    // before, through this click-only path.
    if (typeof currentDecoder.pointerDown === 'function') return;

    if (!prepareInitialErrorsEdit()) return;

    // TASK 4dc: a manual edit is a new configuration the user hasn't yet
    // asked to advance, exactly like a fresh Initialize -- clear here so a
    // stale success/failure verdict from before this click can't persist
    // (or, worse, an immediately-re-evaluated one from a configuration the
    // user never actually asked to step).
    advanceRequested = false;
    const [x, y] = canvasEventToLocal(event);
    currentDecoder.toggleErrorAtPosition(x, y, cssWidth, cssHeight);

    updateStats();
    render();
}

// TASK 4ar: pointer-drag protocol for manual error placement (paint /
// defect-drag gestures, currently implemented by repetition2.js). Active
// only in "manual" initial-errors mode and only while paused -- dragging
// while playing would be editing a decoder that's also stepping itself,
// which isn't well defined. Pointer capture is used so a drag that leaves
// the canvas bounds still reliably delivers its pointermove/pointerup
// events to this element instead of getting lost; pointercancel and
// pointerleave are also wired to the same cleanup as pointerup as a safety
// net against a gesture ever getting stuck "active" (both are effectively
// no-ops during a normal captured drag, since capture keeps move/up
// targeted here regardless of where the pointer actually is on screen).
let activePointerId = null;

function handleCanvasPointerDown(event) {
    if (!canEditInitialErrors()) return;
    if (typeof currentDecoder.pointerDown !== 'function') return;
    if (event.button !== 0 || activePointerId !== null) return;

    const [x, y] = canvasEventToLocal(event);
    const pointerAccepted = currentDecoder.canStartPointer?.(x, y, cssWidth, cssHeight);
    if (pointerAccepted === false) return;
    if (!prepareInitialErrorsEdit()) return;

    if (currentDecoder.pointerDown(x, y, cssWidth, cssHeight) === false) return;
    activePointerId = event.pointerId;
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    event.preventDefault();

    // TASK 4dc: same reasoning as handleCanvasClick() -- a new gesture
    // starting is a new edit to the configuration.
    advanceRequested = false;
    updateStats();
    render();
}

function handleCanvasPointerMove(event) {
    if (activePointerId === null || event.pointerId !== activePointerId || !currentDecoder) return;
    if (typeof currentDecoder.pointerMove !== 'function') return;
    event.preventDefault();
    const [x, y] = canvasEventToLocal(event);
    currentDecoder.pointerMove(x, y, cssWidth, cssHeight);
    updateStats();
    render();
}

function handleCanvasPointerUp(event) {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    if (currentDecoder && typeof currentDecoder.pointerUp === 'function') {
        currentDecoder.pointerUp();
        updateStats();
        render();
    }
}

// Finish edits before time advances. Later pointer events cannot change
// a decoding initial condition or a streaming round already consumed.
function finishInitialErrorsPointerGesture() {
    if (activePointerId === null || !currentDecoder) return;
    const pointerId = activePointerId;
    activePointerId = null;
    currentDecoder.pointerUp();
    try { canvas.releasePointerCapture(pointerId); } catch (e) { /* ignore */ }
    updateStats();
    render();
}
