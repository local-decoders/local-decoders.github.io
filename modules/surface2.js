// Surface code 2 -- literal JS port of anim/surface_cc.py, the open-boundary
// ("planar patch") surface-code CA decoder, code-capacity setting.
//
// Geometry, channels, and the two update mechanisms (the ordinary interior
// CA step and the periodic "splitting step") are exactly as documented in
// anim/surface_cc.py's module docstring; read that file for the full
// derivation (especially of the splitting step's qx/qy shift rule, which
// is not spelled out mechanically in the paper and had to be derived from
// self-consistency with the syndrome). Summary:
//
//   qx[x][y]  x = 0..Lx (Lx+1 columns), left edge of stabilizer column x
//             (so qx[0] / qx[Lx] are the two rough-boundary columns).
//   qy[x][y]  x = 0..Lx-1, y = 0..Ly-1; row y=0 is always false (no qubit
//             below row 0 -- smooth boundary).
//   m00/m01/m10  x = 0..Lx-1, y = 0..Ly-1, the three message channels.
//   clock (c) and stepCount (t): c starts at 0 and advances by +1 mod q
//             every step, unconditionally and uniformly, so c === t % q
//             always (see anim/surface_cc.py: this is why a *scalar*
//             clock suffices instead of a per-site array).
//
// syndrome[x][y] = qx[x][y] ^ qx[x+1][y] ^ qy[x][y] ^ (qy[x][y+1] if
//                  y+1 <= Ly-1 else 0), always derived, never stored.
//
// The interior step takes the same movementGated/growthWindow options as
// anim/surface_cc.py's step_sync/simulate (== torca.reference.step_sync's
// own movement_gated/growth_window, same semantics): a defect may move iff
// !movementGated || c===0; a message may grow iff c < growthWindow. Two
// variants matter: the default here, movementGated=false, growthWindow=1
// (movement every step, growth only at c=0 -- the faster numerics/
// reproduction rule, and the module default in anim/surface_cc.py too),
// and movementGated=true, growthWindow=q-1 (the "formal" open-boundary
// rule required by the paper's own stated conditions, main.tex:2818-2819).
// Both are verified against the corresponding torca.reference.step_sync
// call in website/tests/test_surface_cc.py part (a). The splitting step
// fires whenever stepCount % qs === 0 and stepCount > 0, identically
// either way -- only the interior update reads movementGated/growthWindow.
//
// checkLogicalError uses the column-parity invariant (fix a qx column x0,
// sum over y, mod 2 -- NOT summing over x at fixed y, which is not
// gauge-invariant here; see anim/surface_cc.py's logical_error_from_qx
// docstring for the full derivation of why).
//
// Splitting-step deviation: the paper's unconditional message copy at the
// two centre sites (main.tex:2312-2314) leaves a lone centre-site
// defect's own message behind after its syndrome is translated away,
// which the newly-arrived defect then reads back as a left-neighbor
// partner and moves straight back -- a permanent period-qs oscillation.
// _shiftRetention below skips the copy only at rows whose defect is being
// evacuated by that exact split; see its own docstring,
// anim/surface_cc.py's `_shift_retention` docstring, and
// website/tests/test_surface_cc.py's `test_center_defect_evacuates` for
// the full mechanism and the regression test.
//
// TASK 4cy: restyled to match repetition2.js's conventions, the same way
// TASK 4cx did for toric2.js -- see that module's own header comment for
// the full rationale. Only _layout()'s geometry formula and render()'s
// drawing code change; _interiorStep/_splitStep/_shiftRetention/
// checkLogicalError/etc. (the verified dynamics, check_surface2.mjs's own
// oracle comparison) are untouched. Rendering and _pointerToLattice now
// share snapped cell edges and site centres. Two genuine, disclosed
// differences from toric2 the open boundary forces: the rough (left/
// right) boundaries are marked with a solid purple line (TASK 4df: the
// same ROUGH_BOUNDARY_COLOR/WIDTH the surface code (phenomenological)
// module uses for the identical purpose, imported from
// surface_streaming_3d.js -- was a thicker dashed red-brown marking
// before this task) instead of a plain black line on those two sides (see
// render()'s own comment on how this combines with the black top/bottom
// edges), and
// qx's boundary columns (x=0, x=Lx) keep their single half-piece error
// strings (there is no wraparound to draw a second half against, unlike
// toric2's periodic qx[0,y]).
//
// The three message colours are toric2.js's own COLOR_MSG00/01/10_FILL/
// EDGE, imported rather than re-declared -- surface2's message base hues
// were already byte-identical to toric2's before this task.
import {
    FONT_SERIF, AXIS_LABEL_CLEARANCE, AXIS_ARROW_INK_GAP,
    T_LABEL_EXTRA_CLEARANCE as Y_LABEL_EXTRA_CLEARANCE, X_LABEL_EXTRA_CLEARANCE,
    TLABEL_FONT_SIZE, TLABEL_GLYPH_W,
    COLOR_GRID, COLOR_ERROR, COLOR_ORB_RIM,
    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE, drawOrb,
    fillBoldGlyph, anchorForLeftEdge, anchorForRightEdge, inkRightEdge,
    DESCRIPTION_TOP_CSS,
} from './repetition2.js';
import {
    CODE_CAP_GRAPHIC_SHIFT_DOWN,
    CODE_CAP_X_LABEL_INK_HEIGHT,
    CODE_CAP_NARROW_EDGE_MARGIN,
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    drawMessageCell, createSnappedAxis, drawSnappedGrid,
} from './toric2.js';
// TASK 4df: the surface code (phenomenological) module's own rough-
// boundary colour/width (see that file's own comment on these two
// exports) -- imported directly rather than retyping the same literals,
// so this tab and the phenomenological one can never drift apart on this
// specific styling choice. Importing this class-defining module for two
// plain constants is cheap and side-effect-free (no top-level fetch/await
// in it or in surface_streaming.js, which it itself imports; the browser's
// module cache also means it's only ever evaluated once regardless of how
// many modules import from it).
import {
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH,
} from './surface_streaming_3d.js';

// Re-exported so main.js's getLegendItems() can read them off this
// module's own namespace object -- see toric2.js's identical comment on
// its own re-export for why (loadDecoder() passes the whole freshly
// import()ed module through as moduleColors).
export {
    CODE_CAP_GRAPHIC_SHIFT_DOWN,
    CODE_CAP_X_LABEL_INK_HEIGHT,
    CODE_CAP_NARROW_EDGE_MARGIN,
    COLOR_ORB_RIM, COLOR_ERROR,
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH,
};

// Space outside the frame paths for the full, centred boundary stroke.
export const BOUNDARY_STROKE_PADDING = ROUGH_BOUNDARY_WIDTH / 2;
export const SMOOTH_BOUNDARY_WIDTH = 1.3;
// Preserve the installed L=48 height while allowing fractional cell sizes.
export const CODE_CAP_HEIGHT_RESERVE = 8;

// Pointer-gesture thresholds (cell units), matching the rendered orb
// radius (cell * 0.3, see render()) and "about 0.3 cell" from an edge's
// midpoint respectively -- see pointerDown's docstring.
const DEFECT_GRAB_RADIUS = 0.3;
const EDGE_PAINT_TOLERANCE = 0.3;

function makeArray(nx, ny, fill) {
    const out = new Array(nx);
    for (let x = 0; x < nx; x++) {
        out[x] = new Array(ny).fill(fill);
    }
    return out;
}

function cloneArray(a) {
    return a.map((col) => col.slice());
}

export class SurfaceCode2Decoder {
    /**
     * @param {number} Lx_or_L - patch width (and, if `opts.Ly` is omitted, height too)
     * @param {number} clockPeriod - q, the CA clock period (default 6)
     * @param {object} opts - { qs: splitting period (default 16), Ly: patch height
     *   (default = Lx_or_L), movementGated: gate movement to clock===0 (default
     *   false, i.e. movement every step -- the numerics/reproduction rule; pass
     *   true for the formal open-boundary-proof rule), growthWindow: growth
     *   allowed when clock < growthWindow (default 1, matching the numerics
     *   rule; pass q-1 for the formal rule) }. Same two variants and defaults
     *   as anim/surface_cc.py's step_sync/simulate -- see that module's
     *   docstring, "Movement gating and growth window".
     */
    constructor(Lx_or_L, clockPeriod = 6, opts = {}) {
        this.Lx = Lx_or_L;
        this.Ly = (opts.Ly !== undefined) ? opts.Ly : Lx_or_L;
        this.q = clockPeriod;
        this.qs = (opts.qs !== undefined) ? opts.qs : 16;
        this.movementGated = (opts.movementGated !== undefined) ? opts.movementGated : false;
        this.growthWindow = (opts.growthWindow !== undefined) ? opts.growthWindow : 1;

        this.clock = 0;
        this.stepCount = 0;

        // Pointer-drag gesture state (see pointerDown/pointerMove/pointerUp).
        this._pointerMode = null;      // null | 'paint' | 'defect'
        // TASK 4ei: paint is now a vertex-to-vertex walk (_walkPaintTo)
        // rather than a per-sample nearest-edge toggle, so _lastPaintedEdge
        // (which only ever de-duplicated same-edge writes across samples)
        // is retired in favour of _paintVertex/_paintMoved/_paintInitialEdge.
        this._paintVertex = null;      // [x, y] of the vertex the walk last reached, or null
        this._paintMoved = false;      // true once any walk-step has actually happened this gesture
        this._paintInitialEdge = null; // the edge pointerDown decided V from; painted on pointerUp ONLY if the gesture never moved (preserves plain-click-toggles-one-edge)
        // TASK 4ei-b: every vertex visited so far this stroke, in order
        // (including the starting one) -- lets pointerMove tell "genuinely
        // new ground" from "a direct jump back to somewhere this stroke
        // already painted through", so retracing that way doesn't walk (and
        // so paint) a second, possibly differently-cornered route between
        // the same two vertices. See pointerMove's own comment.
        this._paintVisited = [];
        this._dragCell = null;         // [x, y] of the defect currently being dragged, or null

        this.qx = makeArray(this.Lx + 1, this.Ly, false);
        this.qy = makeArray(this.Lx, this.Ly, false);
        this.m00 = makeArray(this.Lx, this.Ly, false);
        this.m01 = makeArray(this.Lx, this.Ly, false);
        this.m10 = makeArray(this.Lx, this.Ly, false);
    }

    // TASK 4dm: alias for `q` (the CA clock period), matching toric2.js's
    // own identical getter/setter (same internal `this.q` convention) --
    // discovered missing here while wiring the clock-period slider's live
    // decoder update through applyConstraint()/main.js: that shared code
    // has always checked `currentDecoder.clockPeriod !== undefined`
    // before live-mutating it (toric2/repetition2/repetition_streaming
    // all expose that name already, toric2 via this exact same shim), so
    // without it, dragging surface2's clock-period slider silently never
    // reached the running decoder at all -- only a full reload (e.g.
    // Initialize) picked up a changed value, since loadDecoder() reads
    // the slider fresh into the constructor's own `clockPeriod` argument
    // either way. Purely additive; every existing internal use of
    // `this.q` elsewhere in this file is completely unaffected.
    get clockPeriod() { return this.q; }
    set clockPeriod(v) { this.q = v; }

    // Shared splitting-period name; qs remains the rule's source of truth.
    get qPrime() { return this.qs; }
    set qPrime(v) { this.qs = v; }

    // -- initialization ------------------------------------------------

    /**
     * Independent Bernoulli(p) errors on every real qubit. `rng`, if given,
     * is a callable returning a uniform value in [0,1) each call (like
     * Math.random, the default) -- drawn qx-in-full-then-qy-for-y=1..Ly-1,
     * mirroring anim.surface_cc.iid_errors's convention. Resets messages
     * and the clock/step count to zero, matching anim.surface_cc.initial_state.
     */
    initializeRandomErrors(p, rng) {
        const rand = rng || Math.random;
        const Lx = this.Lx, Ly = this.Ly;

        this.qx = makeArray(Lx + 1, Ly, false);
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                this.qx[x][y] = rand() < p;
            }
        }
        this.qy = makeArray(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 1; y < Ly; y++) {
                this.qy[x][y] = rand() < p;
            }
        }
        this.m00 = makeArray(Lx, Ly, false);
        this.m01 = makeArray(Lx, Ly, false);
        this.m10 = makeArray(Lx, Ly, false);
        this.clock = 0;
        this.stepCount = 0;
        this._pointerMode = null;
        this._paintVertex = null;
        this._paintMoved = false;
        this._paintInitialEdge = null;
        this._paintVisited = [];
        this._paintValue = null;
        this._dragCell = null;
    }

    // -- core dynamics ---------------------------------------------------

    _computeSyndrome() {
        const Lx = this.Lx, Ly = this.Ly;
        const qx = this.qx, qy = this.qy;
        const s = makeArray(Lx, Ly, false);
        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                const below = qy[x][y];
                const above = (y + 1 <= Ly - 1) ? qy[x][y + 1] : false;
                s[x][y] = (qx[x][y] !== qx[x + 1][y]) !== (below !== above);
            }
        }
        return s;
    }

    _msgRead(msg, x, y) {
        return (x >= 0 && x < this.Lx && y >= 0 && y < this.Ly) ? msg[x][y] : false;
    }

    _toomVote(msg, i, j, x, y) {
        const dx = (i === 0) ? -1 : 1;
        const dy = (j === 0) ? -1 : 1;
        const read = (xx, yy) => this._msgRead(msg, xx, yy) ? 1 : 0;
        const votes = read(x, y) + read(x + dx, y) + read(x, y + dy);
        return votes >= 2;
    }

    /**
     * One base CA update: a defect may move iff `!this.movementGated ||
     * c===0`; a non-defect message may grow iff `c < this.growthWindow`.
     * Same semantics as anim/surface_cc.py's `_step_interior` /
     * `torca.reference.step_sync`'s own `movement_gated`/`growth_window`.
     */
    _interiorStep() {
        const Lx = this.Lx, Ly = this.Ly, c = this.clock;
        const q = this.q;
        const growthWindow = this.growthWindow;
        const movementAllowed = (!this.movementGated) || (c === 0);

        const sT = this._computeSyndrome();
        const qxNext = cloneArray(this.qx);
        const qyNext = cloneArray(this.qy);
        const m00Next = cloneArray(this.m00);
        const m01Next = cloneArray(this.m01);
        const m10Next = cloneArray(this.m10);

        const sInc = [];

        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                if (sT[x][y]) {
                    // Condition (i): defect persistence sets all three messages.
                    m00Next[x][y] = true;
                    m01Next[x][y] = true;
                    m10Next[x][y] = true;

                    if (movementAllowed) {
                        // Paper priority: a qualifying left move preempts down.
                        if (this._msgRead(this.m00, x - 1, y) || this._msgRead(this.m01, x - 1, y)) {
                            qxNext[x][y] = !this.qx[x][y];
                            sInc.push([x - 1, y]);
                        } else if (this._msgRead(this.m00, x, y - 1) || this._msgRead(this.m10, x, y - 1)) {
                            qyNext[x][y] = !this.qy[x][y];
                            sInc.push([x, y - 1]);
                        }
                    }
                } else {
                    const vote00 = this._toomVote(this.m00, 0, 0, x, y);

                    if (!this.m00[x][y]) {
                        m00Next[x][y] = (c < growthWindow) &&
                            (this._msgRead(this.m00, x - 1, y) || this._msgRead(this.m00, x, y - 1));
                    } else {
                        m00Next[x][y] = vote00;
                    }

                    if (!this.m01[x][y]) {
                        m01Next[x][y] = (c < growthWindow) &&
                            (this._msgRead(this.m01, x - 1, y) || this._msgRead(this.m01, x, y + 1));
                    } else {
                        const ownVote = this._toomVote(this.m01, 0, 1, x, y);
                        m01Next[x][y] = ownVote || (this.m00[x][y] && vote00);
                    }

                    if (!this.m10[x][y]) {
                        m10Next[x][y] = (c < growthWindow) &&
                            (this._msgRead(this.m10, x + 1, y) || this._msgRead(this.m10, x, y - 1));
                    } else {
                        const ownVote = this._toomVote(this.m10, 1, 0, x, y);
                        m10Next[x][y] = ownVote || (this.m00[x][y] && vote00);
                    }
                }
            }
        }

        // Part 3: arrival overwrite (every target is within bounds; see
        // anim/surface_cc.py's module docstring for why a left/down move
        // out of the patch never triggers).
        for (const [xp, yp] of sInc) {
            m00Next[xp][yp] = true;
            m01Next[xp][yp] = true;
            m10Next[xp][yp] = true;
        }

        this.qx = qxNext;
        this.qy = qyNext;
        this.m00 = m00Next;
        this.m01 = m01Next;
        this.m10 = m10Next;
        this.clock = (c + 1) % q;
        this.stepCount += 1;
    }

    _splitHalves() {
        const Lx = this.Lx;
        const xL = Math.floor(Lx / 2) - 1;
        const xR = Math.floor(Lx / 2);
        return [xL, xR];
    }

    /** Outward shift with columns xL, xR vacated (used for qy). */
    _shiftNoRetention(field, xL, xR, nx, ny) {
        const out = makeArray(nx, ny, false);
        for (let x = 0; x < xL; x++) {
            for (let y = 0; y < ny; y++) out[x][y] = field[x + 1][y];
        }
        for (let x = xR + 1; x < nx; x++) {
            for (let y = 0; y < ny; y++) out[x][y] = field[x - 1][y];
        }
        return out;
    }

    /**
     * Outward shift with columns xL, xR retaining (and copying outward)
     * their own value (messages) -- except at rows where
     * evacuatingXL[y]/evacuatingXR[y] is true, matching
     * anim/surface_cc.py's `_shift_retention`.
     *
     * Deviation from a literal reading of the paper (main.tex:2312-2314):
     * a lone defect sitting exactly on a centre site sources its own
     * messages, so an unconditional copy at that row leaves a copy of the
     * departing defect's own message behind at the site its syndrome was
     * just translated away from. On the very same synchronous step, the
     * newly-arrived defect reads that leftover copy as a qualifying
     * left-neighbor partner and immediately moves back -- a permanent
     * period-qs oscillation that never reaches a boundary (found by the
     * coarse-grained surface sibling in its own splitting step; see
     * anim/surface_cc.py's `_shift_retention` docstring and
     * website/tests/test_surface_cc.py's `test_center_defect_evacuates`
     * for the full mechanism, the fix, and the regression test). The
     * paper's copy rule is for *bridging* messages merely passing through
     * the centre from some other, more distant defect; it is not meant to
     * preserve a message whose own sourcing defect is being evacuated by
     * this exact split. The fix: skip retention only at rows where a
     * defect is present at that centre column in the pre-split state
     * (evacuatingXL/evacuatingXR); a centre-column row with messages but
     * no defect there is untouched and still copied.
     */
    _shiftRetention(field, xL, xR, nx, ny, evacuatingXL, evacuatingXR) {
        const out = this._shiftNoRetention(field, xL, xR, nx, ny);
        for (let y = 0; y < ny; y++) {
            out[xL][y] = (evacuatingXL && evacuatingXL[y]) ? false : field[xL][y];
            out[xR][y] = (evacuatingXR && evacuatingXR[y]) ? false : field[xR][y];
        }
        return out;
    }

    /** Outward shift of qx (Lx+1 columns) with the shared cut edge at column xR frozen in place. */
    _shiftQxFrozenCut(qx, xL, xR, Lx, Ly) {
        const out = makeArray(Lx + 1, Ly, false);
        for (let x = 0; x <= xL; x++) {
            for (let y = 0; y < Ly; y++) out[x][y] = qx[x + 1][y];
        }
        for (let y = 0; y < Ly; y++) out[xR][y] = qx[xR][y];
        for (let x = xR + 1; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) out[x][y] = qx[x - 1][y];
        }
        return out;
    }

    _splitStep() {
        const [xL, xR] = this._splitHalves();
        const Lx = this.Lx, Ly = this.Ly;
        // Pre-split syndrome, used only to decide which centre-column rows
        // are evacuating a defect this split (see _shiftRetention's doc).
        const sBefore = this._computeSyndrome();
        const evacuatingXL = sBefore[xL];
        const evacuatingXR = sBefore[xR];
        this.qx = this._shiftQxFrozenCut(this.qx, xL, xR, Lx, Ly);
        this.qy = this._shiftNoRetention(this.qy, xL, xR, Lx, Ly);
        this.m00 = this._shiftRetention(this.m00, xL, xR, Lx, Ly, evacuatingXL, evacuatingXR);
        this.m01 = this._shiftRetention(this.m01, xL, xR, Lx, Ly, evacuatingXL, evacuatingXR);
        this.m10 = this._shiftRetention(this.m10, xL, xR, Lx, Ly, evacuatingXL, evacuatingXR);
    }

    /** A splitting step (if triggered: stepCount % qs === 0 && stepCount > 0), then the base update. */
    step() {
        if (this.stepCount % this.qs === 0 && this.stepCount > 0) {
            this._splitStep();
        }
        this._interiorStep();
    }

    // -- queries -----------------------------------------------------------

    getSyndromeCount() {
        const s = this._computeSyndrome();
        let count = 0;
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) if (s[x][y]) count++;
        }
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let x = 0; x <= this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) if (this.qx[x][y]) count++;
        }
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 1; y < this.Ly; y++) if (this.qy[x][y]) count++;
        }
        return count;
    }

    hasMessages() {
        for (let x = 0; x < this.Lx; x++) {
            for (let y = 0; y < this.Ly; y++) {
                if (this.m00[x][y] || this.m01[x][y] || this.m10[x][y]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    /**
     * Column-parity logical-error check (see the module header comment and
     * anim.surface_cc.logical_error_from_qx's docstring for the full
     * derivation of why this -- not a row/fixed-y sum -- is the
     * gauge-invariant quantity). Returns the same shape as
     * surface_split.js's checkLogicalError.
     */
    checkLogicalError() {
        const Lx = this.Lx, Ly = this.Ly;
        const parities = [];
        for (let x = 0; x <= Lx; x++) {
            let count = 0;
            for (let y = 0; y < Ly; y++) if (this.qx[x][y]) count++;
            parities.push(count % 2);
        }
        const hasError = parities[0] === 1;
        return { hasError, horizontal: hasError, vertical: false };
    }

    // -- layout shared by render() and toggleErrorAtPosition() -------------

    // TASK 4cy: rebuilt to match repetition2.js's/toric2.js's own
    // _layout() -- fixed 13px topGap, a left "y"-label gutter and bottom
    // "x"-label budget with the same constants, `cell` capped by both
    // width (Lx columns + the left gutter) and height (Ly rows + the
    // fixed top/bottom budgets) since this patch is a fixed Lx-by-Ly
    // rectangle, not a scrollable 1-wide history. `offsetX`/`offsetY` keep
    // their field names/semantics (the lattice's own left/top pixel edges).
    // Per-index snapped edges and their midpoints are shared by rendering
    // and pointer mapping when the height budget gives fractional cells.
    _layout(canvasWidth, canvasHeight, overlayRects) {
        if (overlayRects !== undefined) this._lastOverlayRects = overlayRects;
        const effectiveOverlayRects = overlayRects !== undefined ? overlayRects : this._lastOverlayRects;
        const narrowLayout = effectiveOverlayRects?.narrowLayout === true;
        const Lx = this.Lx, Ly = this.Ly;
        const xLabelGap = AXIS_LABEL_CLEARANCE;
        const xLabelH = X_LABEL_EXTRA_CLEARANCE + CODE_CAP_X_LABEL_INK_HEIGHT;
        // Include the shift in the height budget to preserve bottom-label clearance.
        const topGap = 13 + CODE_CAP_GRAPHIC_SHIFT_DOWN;
        const bottomMargin = 14;

        // TASK 4em fix: same fix as toric2.js's own identical formula --
        // see that file's longer comment (and repetition_streaming.js's,
        // for the full mechanism) for why the flat "canvasWidth - 120"
        // guess/full-canvasWidth centring stopped being safe once TASK
        // 4em capped .visualization-container's width, and why sizing/
        // centring against the real span between both cards (when
        // overlayRects is available) fixes it while reducing to exactly
        // today's numbers when it isn't (this file's own Node test
        // harness and its own toggleErrorAtPosition/_pointerToLattice,
        // via the this._lastOverlayRects cache above).
        const cardsLeft = effectiveOverlayRects?.infoPanel?.left;
        const descStackRight = effectiveOverlayRects?.description?.right;
        const haveOverlay = Number.isFinite(cardsLeft) && Number.isFinite(descStackRight);
        const freeLeft = narrowLayout ? CODE_CAP_NARROW_EDGE_MARGIN
            : haveOverlay ? (descStackRight + 8) : 0;
        const freeRight = narrowLayout ? canvasWidth - CODE_CAP_NARROW_EDGE_MARGIN
            : haveOverlay ? (cardsLeft - 8) : canvasWidth;
        const widthSizingSpan = narrowLayout || haveOverlay
            ? (freeRight - freeLeft) : (canvasWidth - 120);
        const strokeReserve = 2 * BOUNDARY_STROKE_PADDING;
        const availableCellWidth = (widthSizingSpan - TLABEL_GLYPH_W - AXIS_LABEL_CLEARANCE - strokeReserve) / (Lx + 0.2);
        const cellByWidth = narrowLayout ? availableCellWidth : Math.min(28, availableCellWidth);
        // boxTop adds the top stroke padding; the bottom stroke already
        // fits inside xLabelGap, so it needs no second padding reserve.
        const heightBudget = canvasHeight - topGap - xLabelGap - xLabelH - bottomMargin - BOUNDARY_STROKE_PADDING;
        const cellByHeight = heightBudget / Ly;
        // Narrow cells use the full fitted extent. Desktop retains its
        // height reserve and integer width/cap branch on short canvases.
        const cell = Math.max(1, narrowLayout ? Math.min(cellByWidth, cellByHeight)
            : cellByHeight < cellByWidth
            ? (heightBudget - CODE_CAP_HEIGHT_RESERVE) / Ly
            : Math.floor(cellByWidth));

        const labelGutter = AXIS_LABEL_CLEARANCE + 0.2 * cell;
        const labelReserve = TLABEL_GLYPH_W + labelGutter;
        const panelWidth = cell * Lx + labelReserve + strokeReserve;
        const panelLeft = freeLeft + (freeRight - freeLeft - panelWidth) / 2;
        const boxLeft = Math.round(panelLeft + labelReserve + BOUNDARY_STROKE_PADDING);
        const boxTop = Math.round(topGap + BOUNDARY_STROKE_PADDING);
        const xAxis = createSnappedAxis(boxLeft, cell, Lx);
        const yAxis = createSnappedAxis(boxTop, cell, Ly);
        const xEdges = xAxis.edges, yEdges = yAxis.edges;
        const siteX = xAxis.sites, siteY = yAxis.sites;
        const boxWidth = xEdges[Lx] - boxLeft;
        const boxHeight = yEdges[Ly] - boxTop;
        const boxBottom = yEdges[Ly];
        const X = (lx) => xAxis.toPixel(lx);
        const Y = (ly) => yAxis.toPixel(Ly - 1 - ly);
        const yLabelMidY = boxTop + boxHeight / 2;
        const xLabelTop = boxBottom + xLabelGap;

        const offsetX = boxLeft;
        const offsetY = boxTop;

        return {
            Lx, Ly, cell, offsetX, offsetY,
            boxLeft, boxTop, boxWidth, boxHeight, boxBottom,
            xAxis, yAxis, xEdges, yEdges, siteX, siteY, X, Y,
            panelLeft, panelWidth, labelReserve, labelGutter,
            yLabelFontSize: TLABEL_FONT_SIZE, xLabelFontSize: TLABEL_FONT_SIZE, yLabelMidY,
            xLabelTop, xLabelH
        };
    }

    // -- rendering -----------------------------------------------------

    // TASK 4cq/4cw analogues, same as toric2.js's own (see its comment).
    // TASK 4da: getDescriptionAnchor uses the same fixed { top:
    // DESCRIPTION_TOP_CSS } as toric2.js now, for the identical reason --
    // see toric2.js's own comment on this method.
    getDescriptionAnchor(canvasWidth, canvasHeight) {
        return { top: DESCRIPTION_TOP_CSS };
    }

    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        const layout = this._layout(canvasWidth, canvasHeight, overlayRects);
        return { centerX: layout.boxLeft + layout.boxWidth / 2 };
    }

    /**
     * Draw the patch: grey grid, red links on error edges, orbs on
     * defects, rough (left/right) boundaries marked with a solid purple
     * border (TASK 4df), smooth (top/bottom) boundaries a plain black line.
     * Messages are tinted only when options.showMessages (default true
     * here, since the website's own Messages checkbox controls it).
     * TASK 4cy: restyled to match repetition2.js's/toric2.js's own
     * render() -- see the module header comment for what changes and
     * what (the dynamics, the gesture methods) doesn't.
     */
    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const opts = {
            showSyndrome: true, showErrors: true, showMessages: true, showGrid: true,
            ...options,
        };
        const Lx = this.Lx, Ly = this.Ly;
        const layout = this._layout(canvasWidth, canvasHeight, opts.overlayRects);
        const {
            cell, boxLeft, boxTop, boxWidth, boxHeight, boxBottom,
            xEdges, yEdges, X, Y,
            yLabelFontSize, yLabelMidY, xLabelFontSize, xLabelTop,
        } = layout;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Clip fills, grid, strings and orbs to the patch. Boundary strokes
        // are drawn outside this clip, with their full width reserved by
        // _layout(), so their centres stay half a cell from the outer sites.
        ctx.save();
        ctx.beginPath();
        ctx.rect(boxLeft, boxTop, boxWidth, boxHeight);
        ctx.clip();

        // Full-cell message tiles share their geometry and palette with
        // the other code-capacity tab; grid, errors and orbs draw on top.
        if (opts.showMessages) {
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    const mask = (this.m00[x][y] ? 1 : 0)
                        | (this.m01[x][y] ? 2 : 0) | (this.m10[x][y] ? 4 : 0);
                    if (!mask) continue;
                    const row = Ly - 1 - y;
                    drawMessageCell(ctx, xEdges[x], yEdges[row], xEdges[x + 1], yEdges[row + 1], mask);
                }
            }
        }

        // Grey grid, same colour/width formula as repetition2's
        // drawCaGridLines (TASK 4cy, matching toric2.js's own render()).
        const gridLineWidth = Math.max(1, Math.round(cell / 18));
        if (opts.showGrid) {
            ctx.strokeStyle = COLOR_GRID;
            ctx.lineWidth = gridLineWidth;
            drawSnappedGrid(ctx, xEdges, yEdges, gridLineWidth);
        }

        // Qubit errors as red string pieces joining the centres of the two
        // cells the qubit separates (crossing the shared edge at its
        // midpoint), drawn here (before the defect orbs below) so a chain
        // of errors reads as one continuous string between its endpoint
        // defects, exactly like repetition2's own strings. qx[x,y] joins
        // cells (x-1,y) and (x,y) for x=1..Lx-1; qx[0,y] and qx[Lx,y] are
        // the rough-boundary qubits, each drawn as a single half-piece
        // from its one real cell centre out to the rough boundary line
        // instead of to a second cell -- TASK 4cy keeps this exactly (the
        // open boundary has no wraparound to draw a second half against,
        // unlike toric2's periodic qx[0,y]). qy[x,y] joins (x,y-1) and
        // (x,y) for y=1..Ly-1 only; qy has no boundary qubits at all, so
        // nothing is ever drawn at the smooth y=0/y=Ly-1 boundaries.
        // Colour and thickness now come from the shared COLOR_ERROR/
        // wBlue/stringWidth formula (TASK 4cy, matching toric2.js and
        // repetition2.js), replacing this module's previous
        // Math.max(1.5, cell*0.12).
        if (opts.showErrors) {
            const wBlue = Math.max(2, Math.round(cell / 9));
            const stringWidth = Math.max(1, 1.05 * wBlue);
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            ctx.lineCap = 'round';
            for (let x = 0; x <= Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!this.qx[x][y]) continue;
                    let lx0, lx1;
                    if (x === 0) { lx0 = -0.5; lx1 = 0; }
                    else if (x === Lx) { lx0 = Lx - 1; lx1 = Lx - 0.5; }
                    else { lx0 = x - 1; lx1 = x; }
                    const py = Y(y);
                    ctx.beginPath();
                    ctx.moveTo(X(lx0), py);
                    ctx.lineTo(X(lx1), py);
                    ctx.stroke();
                }
            }
            for (let x = 0; x < Lx; x++) {
                for (let y = 1; y < Ly; y++) {
                    if (!this.qy[x][y]) continue;
                    const px = X(x);
                    ctx.beginPath();
                    ctx.moveTo(px, Y(y - 1));
                    ctx.lineTo(px, Y(y));
                    ctx.stroke();
                }
            }
        }

        ctx.restore(); // end of the message/grid/string clip

        // TASK 4gy: all four frame paths sit half a cell beyond the outer
        // site centres. Removing the old inward rough-stroke inset and
        // drawing outside the clip preserves all 4 px. TASK 4hb: boundaries
        // cover error strings, while defect orbs are drawn on top below.
        // The snapped frame edges sit exactly half the outer snapped cell
        // width from its site centre, including the reserved stroke margin.
        // Draw the smooth frame first so it cannot cover the purple tips.
        ctx.save();
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = SMOOTH_BOUNDARY_WIDTH;
        ctx.lineCap = 'butt';
        const smoothTop = boxTop + 0.5;
        const smoothBottom = boxBottom + 0.5;
        ctx.beginPath();
        ctx.moveTo(boxLeft, smoothTop);
        ctx.lineTo(boxLeft + boxWidth, smoothTop);
        ctx.moveTo(boxLeft, smoothBottom);
        ctx.lineTo(boxLeft + boxWidth, smoothBottom);
        ctx.stroke();

        // Butt caps reach exactly the smooth frame's outer edges, including
        // the corner pixels, with no extension beyond the frame.
        ctx.strokeStyle = ROUGH_BOUNDARY_COLOR;
        ctx.lineWidth = ROUGH_BOUNDARY_WIDTH;
        for (const px of [boxLeft, boxLeft + boxWidth]) {
            ctx.beginPath();
            ctx.moveTo(px, smoothTop - SMOOTH_BOUNDARY_WIDTH / 2);
            ctx.lineTo(px, smoothBottom + SMOOTH_BOUNDARY_WIDTH / 2);
            ctx.stroke();
        }
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.rect(boxLeft, boxTop, boxWidth, boxHeight);
        ctx.clip();

        // Defects as shaded orbs -- TASK 4cy: drawOrb() imported from
        // repetition2.js with its own DEFECT_ORB_RADIUS/DEFECT_ORB_OUTLINE
        // (0.30618/0.0486), same as toric2.js's own render() and for the
        // same reason (this module already iterates (x,y) via its own
        // X()/Y(), so the shared drawOrb() primitive is the natural fit
        // over repetition2's row/col drawCaDefects() wrapper).
        if (opts.showSyndrome) {
            const s = this._computeSyndrome();
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (!s[x][y]) continue;
                    const row = Ly - 1 - y;
                    const siteCell = Math.min(xEdges[x + 1] - xEdges[x], yEdges[row + 1] - yEdges[row]);
                    drawOrb(ctx, X(x), Y(y), siteCell, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
            }
        }

        ctx.restore(); // end of the orb clip

        // "y" label to the left of the box, with its bold upward arrow --
        // identical to toric2.js's own "y" label code.
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `italic ${yLabelFontSize}px ${FONT_SERIF}`;
        const yMetrics = ctx.measureText('y');
        const yAnchorX = anchorForRightEdge(boxLeft - AXIS_LABEL_CLEARANCE - Y_LABEL_EXTRA_CLEARANCE, yMetrics);
        ctx.fillText('y', yAnchorX, yLabelMidY);

        const yInkLeft = yAnchorX - yMetrics.actualBoundingBoxLeft;
        const yInkRight = boxLeft - AXIS_LABEL_CLEARANCE - Y_LABEL_EXTRA_CLEARANCE; // by construction
        const yInkCenterX = (yInkLeft + yInkRight) / 2;
        const yInkTopY = yLabelMidY - yMetrics.actualBoundingBoxAscent;

        ctx.font = `bold ${yLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const yArrowMetrics = ctx.measureText('↑');
        const yArrowAnchorX = yInkCenterX - (yArrowMetrics.actualBoundingBoxRight - yArrowMetrics.actualBoundingBoxLeft) / 2;
        const yArrowBaselineY = yInkTopY - AXIS_ARROW_INK_GAP - yArrowMetrics.actualBoundingBoxDescent;
        fillBoldGlyph(ctx, '↑', yArrowAnchorX, yArrowBaselineY);
        ctx.textBaseline = 'alphabetic';

        // "x ->" label below the box -- identical to toric2.js's own "x" label code.
        const cx = boxLeft + boxWidth / 2;
        ctx.fillStyle = '#000000';
        ctx.font = `italic ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const xMetrics = ctx.measureText('x');
        const xBaseline = boxBottom + AXIS_LABEL_CLEARANCE + X_LABEL_EXTRA_CLEARANCE + xMetrics.actualBoundingBoxAscent;
        const xInkRight = inkRightEdge(cx, xMetrics);
        ctx.fillText('x', cx, xBaseline);

        ctx.font = `bold ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'left';
        const arrowMetrics = ctx.measureText('→');
        const arrowAnchorX = anchorForLeftEdge(xInkRight + AXIS_ARROW_INK_GAP, arrowMetrics);
        fillBoldGlyph(ctx, '→', arrowAnchorX, xBaseline);
    }

    /** Pixel -> lattice coordinates, shared by every pointer/click entry point. */
    _pointerToLattice(x, y, canvasWidth, canvasHeight) {
        const { xAxis, yAxis } = this._layout(canvasWidth, canvasHeight);
        const latticeX = xAxis.toLattice(x);
        const latticeY = this.Ly - 1 - yAxis.toLattice(y);
        return [latticeX, latticeY];
    }

    /**
     * Nearest real edge qubit (qx or qy) to a lattice-space point, with its
     * distance -- shared by toggleErrorAtPosition (no tolerance) and the
     * paint gesture below (which does apply a tolerance at pointerdown).
     */
    _nearestEdge(latticeX, latticeY) {
        const Lx = this.Lx, Ly = this.Ly;

        const qxX = Math.max(0, Math.min(Lx, Math.round(latticeX + 0.5)));
        const qxY = Math.max(0, Math.min(Ly - 1, Math.round(latticeY)));
        const dQx = Math.hypot(latticeX - (qxX - 0.5), latticeY - qxY);

        let dQy = Infinity, qyX = 0, qyY = 1;
        if (Ly >= 2) {
            qyX = Math.max(0, Math.min(Lx - 1, Math.round(latticeX)));
            qyY = Math.max(1, Math.min(Ly - 1, Math.round(latticeY + 0.5)));
            dQy = Math.hypot(latticeX - qyX, latticeY - (qyY - 0.5));
        }

        return (dQx <= dQy) ? { kind: 'qx', x: qxX, y: qxY, dist: dQx }
                            : { kind: 'qy', x: qyX, y: qyY, dist: dQy };
    }

    /** Syndrome at one site, without recomputing the whole grid. */
    _syndromeAt(x, y) {
        const Ly = this.Ly;
        const below = this.qy[x][y];
        const above = (y + 1 <= Ly - 1) ? this.qy[x][y + 1] : false;
        return (this.qx[x][y] !== this.qx[x + 1][y]) !== (below !== above);
    }

    /** Toggle whichever real edge qubit (qx or qy) is nearest the click. */
    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const [latticeX, latticeY] = this._pointerToLattice(x, y, canvasWidth, canvasHeight);
        const edge = this._nearestEdge(latticeX, latticeY);
        this[edge.kind][edge.x][edge.y] = !this[edge.kind][edge.x][edge.y];
    }

    /**
     * Begin a manual-error drag gesture (used only in "manual" initial-error
     * mode while not playing; the syndrome is always freshly derived, so
     * there is nothing to explicitly "recompute" after either gesture).
     * Two gestures, distinguished by what is under the pointer right now:
     *
     *  - Defect drag: pointerdown within DEFECT_GRAB_RADIUS (in cell units,
     *    matching the rendered orb radius) of a site that currently has a
     *    defect enters drag mode, recording the grabbed cell as a
     *    single-cell path (_dragPath). Each subsequent pointerMove either
     *    retraces (if the pointer's target cell is already somewhere on
     *    that path, in which case every step back to it is *undone* --
     *    each edge flip is its own inverse, so this restores exactly
     *    whatever was there before, not just the defect's position -- see
     *    _dragDefectTo's own docstring for why a naive "walk from current
     *    to target" is not enough) or extends the path forward, one
     *    4-connected step at a time (x-axis steps first, then y -- an L
     *    path for a diagonal jump), flipping the qubit shared by each
     *    consecutive pair of cells. Off the right/left rough boundary this
     *    flips the boundary qubit and the defect condenses (drag ends);
     *    off the top/bottom smooth boundary nothing happens (the path
     *    just stops extending in that direction); moving onto a cell that
     *    already has another defect annihilates both (the shared edge
     *    still flips) and ends the drag, since there is no longer a
     *    defect here to keep dragging.
     *  - Paint (TASK 4ei: now a vertex-to-vertex walk, not a per-sample
     *    nearest-edge toggle -- a fast or diagonal drag used to skip edges
     *    between coarse pointer samples, leaving scattered single-edge
     *    errors instead of one contiguous string): pointerdown within
     *    EDGE_PAINT_TOLERANCE of an edge qubit's midpoint decides the
     *    stroke's value V = NOT(that edge's current value) -- unchanged
     *    semantics from before this task -- and remembers both that edge
     *    (_paintInitialEdge) and the nearest VERTEX (_paintVertex, the
     *    same rounded point _syndromeAt's own (x,y) space uses, where a
     *    defect can actually sit -- not clamped to the grid, matching
     *    _dragDefectTo's own target convention, since a walk that reaches
     *    past the grid's own edge needs to know that to apply the open-
     *    boundary rules below). Each subsequent pointerMove finds the
     *    nearest vertex under the pointer, and if it differs from
     *    _paintVertex, walks (_walkPaintTo) every edge along a shortest
     *    lattice path from the old vertex to the new one to V, then
     *    updates _paintVertex to wherever the walk actually reached --
     *    which can differ from the requested target the same two ways
     *    _dragDefectTo's own walk can: off the rough (x) boundary, the
     *    boundary qx edge is set to V and the whole gesture ends (nothing
     *    to keep walking a path between, once off the grid on that side);
     *    off the smooth (y) boundary, nothing is set and the walk simply
     *    stops extending that way, but the gesture continues. Unlike
     *    _dragDefectTo, no retrace/undo bookkeeping exists for paint at
     *    all: setting an edge to V (not toggling it) is already
     *    idempotent, so walking back over already-painted ground mid-
     *    stroke just re-sets the same edges to the same value, harmlessly.
     *    _paintInitialEdge itself is deliberately NOT painted here at
     *    pointerdown: since it's chosen from the raw click position
     *    rather than the walk's own A-to-B path, painting it
     *    unconditionally could leave a spurious extra edge disconnected
     *    from that path (e.g. clicking near vertex A's own west edge,
     *    then dragging east, would otherwise flip that west edge as a
     *    stray third defect on top of the intended pair at A and the
     *    drag's own end point) -- pointerUp below paints it instead, but
     *    only as a fallback if the vertex never actually changed during
     *    this gesture (_paintMoved stays false), which is exactly a plain
     *    click and restores that case's old one-edge-toggle behaviour
     *    exactly. A new stroke (a fresh pointerDown) on an already-
     *    painted edge paints the opposite value, since V is recomputed
     *    from that edge's current state each time.
     *
     * Away from either zone, paint still starts at the nearest vertex,
     * but V is deferred until the walk touches its first edge. That edge's
     * current state decides V for the whole stroke. With no initial edge,
     * a plain click that never moves changes nothing.
     */
    pointerDown(x, y, cssW, cssH) {
        const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
        const cellX = Math.round(latticeX), cellY = Math.round(latticeY);

        if (cellX >= 0 && cellX < this.Lx && cellY >= 0 && cellY < this.Ly) {
            const dist = Math.hypot(latticeX - cellX, latticeY - cellY);
            if (dist <= DEFECT_GRAB_RADIUS && this._syndromeAt(cellX, cellY)) {
                this._pointerMode = 'defect';
                this._dragCell = [cellX, cellY];
                this._dragPath = [[cellX, cellY]];
                return;
            }
        }

        const edge = this._nearestEdge(latticeX, latticeY);
        if (edge.dist <= EDGE_PAINT_TOLERANCE) {
            this._pointerMode = 'paint';
            this._paintValue = !this[edge.kind][edge.x][edge.y];
            this._paintInitialEdge = edge;
            this._paintVertex = [cellX, cellY];
            this._paintVisited = [[cellX, cellY]];
            this._paintMoved = false;
            return;
        }

        this._pointerMode = 'paint';
        this._paintValue = null;
        this._paintInitialEdge = null;
        this._paintVertex = [cellX, cellY];
        this._paintVisited = [[cellX, cellY]];
        this._paintMoved = false;
    }

    /**
     * Continue whichever gesture pointerDown started; a no-op when no
     * gesture is active. TASK 4ei-b: a direct jump back to a vertex this stroke has
     * already visited (found in _paintVisited, which records every
     * lattice-step vertex touched so far, one entry per step) just moves
     * the anchor there -- it must NOT re-walk a path, since every edge
     * between here and there is already at V from the forward leg, and a
     * fresh walk could corner at a different vertex than that leg did
     * (axis order is decided per-segment from that segment's own
     * direction, so the reverse segment's own (negated) dx/dy need not
     * pick the same corner), painting a second, redundant L-shaped route
     * instead of re-confirming the one already there.
     *
     * Finding the vertex in _paintVisited is necessary but NOT sufficient
     * on its own, though: a vertex can also reappear because the stroke
     * has looped back around to somewhere near its own start via a
     * DIFFERENT, longer route (e.g. the four corners of a closed square,
     * back to the first corner) -- there, "every edge between them" is
     * true only along that longer recorded route, not along the direct,
     * short path actually needed to close the loop, which is brand new
     * ground. The two cases are told apart by comparing distances: since
     * every entry in _paintVisited is exactly one lattice step from its
     * neighbours, the recorded distance back to a candidate (its own
     * index gap from the current tail) equals the vertex-to-vertex
     * Manhattan distance between them if and only if that recorded
     * stretch is itself monotonic in both axes -- exactly the condition
     * under which a fresh walk between the same two endpoints (same
     * |dx|/|dy| magnitudes either direction, so the same axis-first rule)
     * is guaranteed to retrace it exactly. A shorter fresh distance means
     * a genuine shortcut exists (the loop-closing case), so that's walked
     * as new ground instead, appending whatever it actually passes
     * through.
     *
     * When the retrace check does apply, _paintVisited is truncated back
     * to (and including) the rediscovered vertex, matching
     * _dragDefectTo's own "retracing pops back to that point in the path"
     * convention -- vertices beyond it were only ever reachable via the
     * segment now abandoned, so they no longer describe the stroke's own
     * current path. A genuinely new vertex still walks as before, and
     * every intermediate vertex that walk actually passes through (not
     * just the final one, which can itself differ from the requested
     * target at an open boundary) is appended to _paintVisited, so a
     * later jump back to any of them is also recognised as a retrace.
     */
    pointerMove(x, y, cssW, cssH) {
        if (this._pointerMode === 'paint') {
            const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
            const vx = Math.round(latticeX), vy = Math.round(latticeY);
            if (vx !== this._paintVertex[0] || vy !== this._paintVertex[1]) {
                const visitedIdx = this._paintVisited.findIndex(([px, py]) => px === vx && py === vy);
                const recordedDistance = visitedIdx === -1 ? -1 : this._paintVisited.length - 1 - visitedIdx;
                const freshDistance = Math.abs(vx - this._paintVertex[0]) + Math.abs(vy - this._paintVertex[1]);
                if (visitedIdx !== -1 && recordedDistance === freshDistance) {
                    this._paintVisited = this._paintVisited.slice(0, visitedIdx + 1);
                    this._paintVertex = [vx, vy];
                } else {
                    const { vertex, ended, path } = this._walkPaintTo(this._paintVertex, [vx, vy], this._paintValue);
                    this._paintVisited.push(...path);
                    this._paintVertex = vertex;
                    if (ended) this._pointerMode = null; // condensed at the rough boundary; nothing left to keep painting a path between
                }
                this._paintMoved = true;
            }
        } else if (this._pointerMode === 'defect' && this._dragCell !== null) {
            const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
            this._dragDefectTo(Math.round(latticeX), Math.round(latticeY));
        }
    }

    /** End the current gesture -- see pointerDown's own docstring for why a still-unmoved paint stroke paints its initial edge only here, as a fallback. */
    pointerUp() {
        if (this._pointerMode === 'paint' && !this._paintMoved && this._paintInitialEdge) {
            const edge = this._paintInitialEdge;
            this[edge.kind][edge.x][edge.y] = this._paintValue;
        }
        this._pointerMode = null;
        this._paintVertex = null;
        this._paintMoved = false;
        this._paintInitialEdge = null;
        this._paintVisited = [];
        this._paintValue = null;
        this._dragCell = null;
        this._dragPath = [];
    }

    /** Flip the qubit shared by two 4-connected-adjacent cells; used both to extend the drag path forward and, called again on the same pair, to undo that exact step while retracing. */
    _flipEdgeBetween(a, b) {
        if (a[1] === b[1]) {
            const x = Math.max(a[0], b[0]);
            this.qx[x][a[1]] = !this.qx[x][a[1]];
        } else {
            const y = Math.max(a[1], b[1]);
            this.qy[a[0]][y] = !this.qy[a[0]][y];
        }
    }

    /**
     * TASK 4ei: paint's own analogue of _flipEdgeBetween just above -- SET
     * (not flip) the qubit shared by two 4-connected-adjacent cells to
     * `value`. Identical index arithmetic to _flipEdgeBetween (kept as a
     * separate method rather than parameterising that one with an
     * operation, matching this module's existing style of small,
     * single-purpose gesture helpers). Both cells must be real, in-grid
     * vertices -- a step that would leave the grid is the boundary cases
     * _walkPaintTo below handles itself, never by calling this with an
     * out-of-range cell.
     */
    _setEdgeBetween(a, b, value) {
        if (a[1] === b[1]) {
            const x = Math.max(a[0], b[0]);
            this._setPaintEdge('qx', x, a[1], value);
        } else {
            const y = Math.max(a[1], b[1]);
            this._setPaintEdge('qy', a[0], y, value);
        }
    }

    /** Resolve a deferred stroke value on its first edge, then reuse it. */
    _setPaintEdge(kind, x, y, value) {
        // Exterior starts may walk through positions with no real qubit.
        if (!this[kind][x] || y < 0 || y >= this.Ly || (kind === 'qy' && y === 0)) return;
        if (value === null) {
            if (this._paintValue === null) this._paintValue = !this[kind][x][y];
            value = this._paintValue;
        }
        this[kind][x][y] = value;
    }

    /**
     * TASK 4ei: set to `value` every edge along a shortest lattice path
     * from vertex `from` to vertex `to`, one 4-connected step at a time --
     * the paint stroke's own walk between two consecutive pointermove
     * samples, so a fast or diagonal drag no longer skips edges the way a
     * per-sample nearest-edge toggle did. `to` need not be a real, in-grid
     * vertex (the pointer can be beyond the grid's own edge); this then
     * runs into the same two open-boundary rules _dragDefectTo already
     * uses on this module: crossing the rough (x) boundary sets that
     * boundary qx edge (x=0 or x=Lx) to `value` and stops the walk there
     * entirely (ended: true -- there is no vertex beyond it to keep
     * walking a path between, so pointerMove's own caller ends the whole
     * gesture, matching _dragDefectTo's "defect condenses, drag ends");
     * crossing the smooth (y) boundary sets nothing and just stops
     * extending that way (ended: false -- "nothing happens", matching
     * _dragDefectTo's own identical rule for it). Setting an edge to
     * `value` (not toggling it) is already idempotent, so walking over
     * already-painted ground just re-sets the same edges to the same
     * value, harmlessly -- unlike _dragDefectTo, this itself needs no
     * retrace/undo bookkeeping of its own to stay correct. TASK 4ei-b:
     * pointerMove is what actually avoids calling this at all for a
     * direct jump back to a vertex the stroke has already visited, since
     * axis order below is decided per-segment and so isn't guaranteed to
     * retrace the same corner -- this method itself has no notion of "the
     * stroke so far", only ever walking the one segment it's given; see
     * pointerMove's own comment for the full reasoning.
     *
     * Axis order follows this segment's own direction of travel -- x
     * first when |dx| >= |dy|, y first otherwise -- rather than
     * _dragDefectTo's fixed x-then-y order, so an L-shaped hop for a
     * diagonal segment reads as "mostly horizontal with a short vertical
     * jog" (or vice versa) matching the pointer's own actual direction,
     * instead of always cornering the same way regardless of it. If the
     * x-portion hits the rough boundary first, the y-portion never runs
     * at all (mirroring _dragDefectTo returning immediately once
     * condensed) -- there is no vertex left to walk a further path from.
     *
     * Returns { vertex, ended, path }: vertex is wherever the walk
     * actually reached (equal to `to` unless a boundary was crossed);
     * ended is true only for the rough-boundary case above; path is
     * every vertex actually passed through, in order (excluding `from`,
     * including the final `vertex`), for pointerMove to extend its own
     * visited-vertex record with all of them, not just the endpoint.
     */
    _walkPaintTo(from, to, value) {
        const Lx = this.Lx, Ly = this.Ly;
        let [cx, cy] = from;
        const dx = to[0] - from[0], dy = to[1] - from[1];
        let ended = false;
        // TASK 4ei-b: every vertex this walk actually passes through, in
        // order (excluding `from`, including wherever it actually ends up
        // -- which can differ from `to` at an open boundary). pointerMove
        // appends this to _paintVisited so a later direct jump back to
        // any of them (not just the final endpoint) is recognised as a
        // retrace rather than new ground.
        const path = [];

        const stepX = () => {
            const dir = dx >= 0 ? 1 : -1;
            while (cx !== to[0]) {
                const nx = cx + dir;
                // A deferred stroke may start outside the patch. Reach the
                // first real edge before applying the boundary-exit rules.
                if (this._paintInitialEdge === null && (cx < 0 || cx >= Lx || cy < 0 || cy >= Ly)) {
                    this._setPaintEdge('qx', Math.max(cx, nx), cy, value);
                    cx = nx;
                    path.push([cx, cy]);
                    continue;
                }
                if (nx < 0 || nx > Lx - 1) {
                    const boundaryCol = dir > 0 ? Lx : 0;
                    this._setPaintEdge('qx', boundaryCol, cy, value);
                    ended = true;
                    return false;
                }
                this._setEdgeBetween([cx, cy], [nx, cy], value);
                cx = nx;
                path.push([cx, cy]);
            }
            return true;
        };
        const stepY = () => {
            const dir = dy >= 0 ? 1 : -1;
            while (cy !== to[1]) {
                const ny = cy + dir;
                if (this._paintInitialEdge === null && (cx < 0 || cx >= Lx || cy < 0 || cy >= Ly)) {
                    this._setPaintEdge('qy', cx, Math.max(cy, ny), value);
                    cy = ny;
                    path.push([cx, cy]);
                    continue;
                }
                if (ny < 0 || ny > Ly - 1) return false; // smooth boundary: nothing to set, just stop extending this way
                this._setEdgeBetween([cx, cy], [cx, ny], value);
                cy = ny;
                path.push([cx, cy]);
            }
            return true;
        };

        if (Math.abs(dx) >= Math.abs(dy)) { if (stepX()) stepY(); } else { if (stepY()) stepX(); }

        return { vertex: [cx, cy], ended, path };
    }

    /**
     * Move the dragged defect to (targetX, targetY). A naive "walk from
     * the current cell to the target, x first then y" is *not* reversible
     * on its own: dragging (0,0) to (2,3) crosses the corner (2,0), while
     * dragging straight back from (2,3) to (0,0) crosses the *other*
     * corner (0,3) -- same x-first-then-y rule, but the two corners differ
     * whenever both x and y change, so "there and back" leaves a spurious
     * residual loop of flipped edges instead of exactly restoring the
     * qubit arrays (confirmed directly before this fix: dragging (2,2) to
     * (5,5) and back left 11 edges flipped instead of the original 1).
     *
     * The fix tracks the *entire* path taken since pointerDown
     * (_dragPath) rather than just the current cell. If the requested
     * target is already somewhere on that path, this pops back to it,
     * undoing each intermediate step's edge flip exactly (in reverse
     * order) -- so retracing, however far back, restores exactly whatever
     * was there before those steps, not just the defect's position.
     * Otherwise it extends the path forward from the current tip, x first
     * then y, exactly as before. A cell that already has a defect
     * annihilates with the dragged one on arrival (ending the drag,
     * _dragCell/_dragPath reset to empty) since there is nothing left to
     * keep dragging; a rough boundary condenses the same way, a smooth
     * boundary simply stops the path from extending further that way.
     */
    _dragDefectTo(targetX, targetY) {
        const Lx = this.Lx, Ly = this.Ly;

        for (let i = this._dragPath.length - 1; i >= 0; i--) {
            const [px, py] = this._dragPath[i];
            if (px === targetX && py === targetY) {
                while (this._dragPath.length - 1 > i) {
                    const tip = this._dragPath.pop();
                    this._flipEdgeBetween(tip, this._dragPath[this._dragPath.length - 1]);
                }
                this._dragCell = [targetX, targetY];
                return;
            }
        }

        let [cx, cy] = this._dragCell;

        while (cx !== targetX) {
            const dir = targetX > cx ? 1 : -1;
            const nx = cx + dir;
            if (nx < 0 || nx > Lx - 1) {
                // Rough boundary: flip the boundary qx edge, defect condenses.
                const boundaryCol = dir > 0 ? Lx : 0;
                this.qx[boundaryCol][cy] = !this.qx[boundaryCol][cy];
                this._dragCell = null;
                this._dragPath = [];
                return;
            }
            this._flipEdgeBetween([cx, cy], [nx, cy]);
            cx = nx;
            this._dragPath.push([cx, cy]);
            this._dragCell = [cx, cy];
            if (!this._syndromeAt(cx, cy)) {
                // The step just annihilated with a pre-existing defect here.
                this._dragCell = null;
                this._dragPath = [];
                return;
            }
        }

        while (cy !== targetY) {
            const dir = targetY > cy ? 1 : -1;
            const ny = cy + dir;
            if (ny < 0 || ny > Ly - 1) {
                // Smooth boundary: nothing happens; the drag just stops here.
                return;
            }
            this._flipEdgeBetween([cx, cy], [cx, ny]);
            cy = ny;
            this._dragPath.push([cx, cy]);
            this._dragCell = [cx, cy];
            if (!this._syndromeAt(cx, cy)) {
                this._dragCell = null;
                this._dragPath = [];
                return;
            }
        }
    }
}
