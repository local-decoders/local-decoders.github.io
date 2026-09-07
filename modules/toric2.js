// Toric code 2 -- literal JS port of torca.reference (local-comp-numerics),
// the periodic-lattice toric-code CA decoder, code-capacity setting. Built
// in the style of surface2.js (same constructor/API shape, same rendering
// language), but for the closed L x L torus: no splitting step, no
// boundaries, and (see "Per-site clock" below) a genuine per-site clock
// array rather than a scalar.
//
// Geometry (torca/CONVENTIONS.md): qx, qy, m00, m01, m10, c all have shape
// L x L, axis 0 is x and axis 1 is y, both periodic (mod L). Flipping
// qx(r) moves a defect from r to r-x; flipping qy(r) moves it from r to
// r-y. The three messages are m00 propagating (+x,+y), m01 propagating
// (+x,-y), and m10 propagating (-x,+y) (paper section 3,
// mathcal{M}_2 = {0,1}^2 \ {(1,1)}).
//
// syndrome[x][y] = qx[x][y] ^ qx[(x+1)%L][y] ^ qy[x][y] ^ qy[x][(y+1)%L],
// always derived, never stored (torca.reference.syndrome).
//
// Interior update (step()): the same movementGated/growthWindow options as
// anim/surface_cc.py and surface2.js (== torca.reference.step_sync's own
// movement_gated/growth_window, identical semantics): a defect may move
// iff !movementGated || c(r)===0; a message may grow iff c(r) < growthWindow.
// Default here is movementGated=false, growthWindow=1 (movement every
// step, growth only at c=0 -- the faster numerics/reproduction rule,
// torca.reference.DEFAULT_MOVEMENT_GATED/DEFAULT_GROWTH_WINDOW); pass
// movementGated=true, growthWindow=q-1 for the formal rule used in
// Algorithm alg:toric-code's own stated definitions. No splitting step
// exists on the closed torus -- an unpaired defect can only ever
// disappear by meeting another defect, which is why the torus requires
// even global charge (unlike the open patch's rough-boundary condensation).
//
// Per-site clock (deviation from surface2.js): surface2.js and
// anim/surface_cc.py track a single scalar clock because every step there
// is a full synchronous sweep, so every site's clock is always at the
// same phase (c === t % q, provably, see anim/surface_cc.py's module
// docstring). That invariant breaks the moment a *single-site*
// asynchronous update exists (stepUncoord below): torca.reference.step_async
// advances only the selected site's clock, so different sites' clocks can
// genuinely diverge under a mix of sync and async steps. `this.c` is
// therefore a full L x L array here, read and written per-site by both
// step() and stepUncoord(), exactly like torca.reference's own `c` channel
// -- not an optimization away from it.
//
// stepUncoord(): a literal port of torca.reference.step_async /
// torca.uncoord's single-site kernel (_step_site_with_delta_impl): one
// site's complete local rule (defect movement with SetAll, or message
// growth/erasure), reading only the pre-update state, with the arrival
// SetAll at the movement target applied in the same micro-update. Only
// the selected site's clock advances. The site is either passed in
// explicitly (a flat index or [x,y] pair, letting a test harness replay
// an exact recorded sequence) or, if omitted, drawn uniformly from the
// stored rng set by initializeRandomErrors (Math.random by default) --
// this is why initializeRandomErrors stores its rng rather than using it
// once and discarding it. See website/tests/check_toric2.mjs for the
// bit-for-bit check against torca.reference.step_async.
//
// checkLogicalError() returns both winding parities (torca.reference.
// winding_parities): horizontal = winding_x = parity of qx[0,:] summed
// over y (a horizontally-running non-contractible loop, wrapping around
// the x-direction); vertical = winding_y = parity of qy[:,0] summed over
// x. hasError is their OR, matching torca.reference.RunResult's
// logical_failure = converged and (winding_x or winding_y).
//
// Rendering follows surface2.js's style (grid, orb glyph, message
// tinting, status line) with the post-string-piece-update error
// convention from the start: each error is a red string piece joining
// the centres of the two cells it separates (crossing the shared edge at
// its midpoint), drawn under the defect orbs. There are no rough
// boundaries on a torus; qx[0,y] and qy[x,0] wrap around, so each is
// drawn as two half-pieces to the panel's borders (exactly like
// anim/toric_sync.py's ToricLatticeRenderer) rather than a single line
// spanning the whole row/column.
//
// TASK 4cx: restyled to match repetition2.js's conventions as closely as
// this decoder's own 2D-torus geometry allows -- no on-canvas caption
// (the state card already carries it), a single black-outlined square
// lattice box (the 2D analogue of repetition2's history box) with grey
// interior grid lines of the same colour/width formula, "x"+arrow below
// and "y"+arrow to the left of the box (same italic font, arrow glyph
// style, and axis-label clearance constants as repetition2's "x"/"t"),
// the same anyon-orb glyph and radius for defects, and the same
// error-string thickness rule. None of this touches _interiorStep/
// stepUncoord/_computeSyndrome/etc. (the verified dynamics,
// check_toric2.mjs's own bit-exact oracle comparison) or the gesture
// state machine. Drawing and pointer conversion share the snapped
// geometry supplied by _layout().
//
// Colour/constant/helper values that are literally shared with
// repetition2 (axis-label clearances, the axis-label font, the defect-orb
// glyph and its radius/outline, the grid colour, the error colour) are
// imported from it rather than duplicated; the three toric message
// colours themselves are toric2's own (repetition2 has only one message
// channel), shared with surface2's solid/striped message cells.
import {
    FONT_SERIF, AXIS_LABEL_CLEARANCE, AXIS_ARROW_INK_GAP,
    T_LABEL_EXTRA_CLEARANCE as Y_LABEL_EXTRA_CLEARANCE, X_LABEL_EXTRA_CLEARANCE,
    TLABEL_FONT_SIZE, TLABEL_GLYPH_W,
    COLOR_GRID, COLOR_ERROR, COLOR_ORB_RIM,
    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE, drawOrb,
    fillBoldGlyph, anchorForLeftEdge, anchorForRightEdge, inkRightEdge,
    DESCRIPTION_TOP_CSS,
} from './repetition2.js';

// TASK 4cx: re-exported (not just imported) so main.js's getLegendItems()
// can read them off this module's own namespace object the same way it
// already reads repetition2's COLOR_MSG_FILL/EDGE/COLOR_ORB_RIM/
// COLOR_ERROR for that decoder's legend -- loadDecoder() passes the whole
// freshly-import()ed module object through as `moduleColors`, so only
// this module's OWN exports (imported-then-re-exported counts) are
// visible there, not anything it merely imports for its own use.
export { COLOR_ORB_RIM, COLOR_ERROR };

// Canvas-local shift shared with surface2; the HTML title stays in place.
export const CODE_CAP_GRAPHIC_SHIFT_DOWN = 16;

// Rounded-up "x" ink height (7.666px at the shared 16.9px font); the
// outlined arrow ends above it. Keep the pure layout's bottom budget
// tied to the ink instead of reserving an entire text line.
export const CODE_CAP_X_LABEL_INK_HEIGHT = 8;

// Preserve the installed L=48 box's bottom edge while allowing smaller,
// fractional cells to fill that same height at larger system sizes.
export const CODE_CAP_HEIGHT_RESERVE = 10;

// Narrow layouts share a small canvas-edge margin, without desktop card space.
export const CODE_CAP_NARROW_EDGE_MARGIN = 4;

// Notebook pastels, retaining the site's m00/m01/m10 = blue/red/green
// assignment. Legacy edge exports remain for other modules that import
// them; these code-capacity tiles and their legend have no message edge.
export const COLOR_MSG00_FILL = 'rgb(205,222,250)'; // m00, blue (-x,-y)
export const COLOR_MSG00_EDGE = 'rgb(96,165,250)';
export const COLOR_MSG01_FILL = 'rgb(252,205,205)'; // m01, red/pink (-x,+y)
export const COLOR_MSG01_EDGE = 'rgb(248,113,113)';
export const COLOR_MSG10_FILL = 'rgb(200,240,225)'; // m10, green (+x,-y)
export const COLOR_MSG10_EDGE = 'rgb(52,211,153)';

export const N_PAIR_STRIPES = 4;
export const N_TRIPLE_STRIPES = 3;

/** One pixel-snapped cell axis, shared by drawing and pointer conversion. */
export function createSnappedAxis(origin, cell, count) {
    const edges = Array.from({ length: count + 1 }, (_, i) => Math.round(origin + i * cell));
    const sites = edges.slice(0, -1).map((edge, i) => (edge + edges[i + 1]) / 2);
    // Coordinate i is a site; i +/- 0.5 are its cell edges. Extend the
    // outer cell spacing into the margins for wrapping/condensing drags.
    const toPixel = (index) => {
        const position = index + 0.5;
        const i = Math.max(0, Math.min(count - 1, Math.floor(position)));
        return edges[i] + (position - i) * (edges[i + 1] - edges[i]);
    };
    const toLattice = (pixel) => {
        let lo = 0, hi = count;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (edges[mid] <= pixel) lo = mid + 1;
            else hi = mid;
        }
        const i = Math.max(0, Math.min(count - 1, lo - 1));
        return i - 0.5 + (pixel - edges[i]) / (edges[i + 1] - edges[i]);
    };
    return { edges, sites, toPixel, toLattice };
}

/** Draw each interior grid line once, with its stroke edges on pixels. */
export function drawSnappedGrid(ctx, xEdges, yEdges, gridLineWidth) {
    const align = (gridLineWidth % 2) / 2;
    ctx.strokeStyle = COLOR_GRID;
    ctx.lineWidth = gridLineWidth;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const x of xEdges.slice(1, -1)) {
        ctx.moveTo(x + align, yEdges[0]);
        ctx.lineTo(x + align, yEdges[yEdges.length - 1]);
    }
    for (const y of yEdges.slice(1, -1)) {
        ctx.moveTo(xEdges[0], y + align);
        ctx.lineTo(xEdges[xEdges.length - 1], y + align);
    }
    ctx.stroke();
}

// Colours in screen order, from the top-left band to the bottom-right.
const messageColorsByMask = [
    [],
    [COLOR_MSG00_FILL],
    [COLOR_MSG01_FILL],
    [COLOR_MSG01_FILL, COLOR_MSG00_FILL],
    [COLOR_MSG10_FILL],
    [COLOR_MSG10_FILL, COLOR_MSG00_FILL],
    [COLOR_MSG10_FILL, COLOR_MSG01_FILL],
    [COLOR_MSG10_FILL, COLOR_MSG00_FILL, COLOR_MSG01_FILL],
];
const messageStripePolysBySize = new Map();

// Sutherland-Hodgman clipping against a*x + b*y <= c, as in the
// notebook. Unit-square screen coordinates (u,v) map its band coordinate
// s=-x+y to s=1-u-v: constant-s stripes run bottom-left to top-right.
function clipMessageHalfPlane(poly, a, b, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const dp = a * p[0] + b * p[1] - c;
        const dq = a * q[0] + b * q[1] - c;
        if (dp <= 0) out.push(p);
        if ((dp <= 0) !== (dq <= 0)) {
            const t = dp / (dp - dq);
            out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
    }
    return out;
}

function makeMessageStripePolys(width, height, count) {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const bands = [];
    // Paint nested half-planes from the full square down to the first
    // band. Each later fill covers the preceding band's hidden area,
    // leaving exactly equal bands without a transparent antialias seam.
    // This opaque underpainting avoids widening or stroking any band.
    for (let k = count - 1; k >= 0; k--) {
        const upper = -1 + 2 * (k + 1) / count;
        const poly = clipMessageHalfPlane(square, -1, -1, upper - 1);
        bands.push({ band: k, poly: poly.map(([u, v]) => [u * width, v * height]) });
    }
    return bands;
}

/** Draw one solid/striped message tile; mask bits are m00, m01, m10. */
export function drawMessageCell(ctx, left, top, right, bottom, mask) {
    const colors = messageColorsByMask[mask];
    if (!colors.length) return;
    left = Math.round(left);
    top = Math.round(top);
    right = Math.round(right);
    bottom = Math.round(bottom);
    const width = right - left, height = bottom - top;
    if (colors.length === 1) {
        ctx.fillStyle = colors[0];
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.fill();
        return;
    }
    const key = `${width},${height}`;
    let stripes = messageStripePolysBySize.get(key);
    if (!stripes) {
        stripes = {
            pair: makeMessageStripePolys(width, height, N_PAIR_STRIPES),
            triple: makeMessageStripePolys(width, height, N_TRIPLE_STRIPES),
        };
        messageStripePolysBySize.set(key, stripes);
    }
    const bands = colors.length === 2 ? stripes.pair : stripes.triple;
    for (const { band, poly } of bands) {
        // The clipping coordinate increases opposite to the screen order.
        ctx.fillStyle = colors[(bands.length - 1 - band) % colors.length];
        ctx.beginPath();
        ctx.moveTo(left + poly[0][0], top + poly[0][1]);
        for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(left + poly[i][0], top + poly[i][1]);
        }
        ctx.closePath();
        ctx.fill();
    }
}

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

function mod(n, L) {
    return ((n % L) + L) % L;
}

/** Signed shortest displacement (in (-L/2, L/2]) from `from` to `to` around a period-`L` torus -- e.g. lets a caller compare |dx| to |dy| to decide which axis moved "more", not just which way each one wraps. */
function shortestDelta(from, to, L) {
    let diff = mod(to - from, L);
    if (diff > L / 2) diff -= L;
    return diff;
}

/** Shortest signed step direction (-1, 0, +1) from `from` to `to` around a period-`L` torus. */
function shortestDir(from, to, L) {
    const diff = shortestDelta(from, to, L);
    return diff === 0 ? 0 : (diff > 0 ? 1 : -1);
}

// Pointer-gesture thresholds (cell units), matching the rendered orb
// radius (cell * 0.3, see render()) and "about 0.3 cell" from an edge's
// midpoint respectively -- see pointerDown's docstring.
const DEFECT_GRAB_RADIUS = 0.3;
const EDGE_PAINT_TOLERANCE = 0.3;

export class ToricCode2Decoder {
    /**
     * @param {number} L - torus side length
     * @param {number} clockPeriod - q, the CA clock period (default 6)
     * @param {object} opts - { movementGated: gate movement to c(r)===0
     *   (default false, i.e. movement every step -- the numerics/
     *   reproduction rule; pass true for the formal rule), growthWindow:
     *   growth allowed when c(r) < growthWindow (default 1, matching the
     *   numerics rule; pass q-1 for the formal rule) }. Same two variants
     *   and defaults as anim/surface_cc.py / surface2.js.
     */
    constructor(L, clockPeriod = 6, opts = {}) {
        this.L = L;
        this.q = clockPeriod;
        this.movementGated = (opts.movementGated !== undefined) ? opts.movementGated : false;
        this.growthWindow = (opts.growthWindow !== undefined) ? opts.growthWindow : 1;

        this.stepCount = 0;
        this._rng = Math.random;

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

        this.qx = makeArray(L, L, false);
        this.qy = makeArray(L, L, false);
        this.m00 = makeArray(L, L, false);
        this.m01 = makeArray(L, L, false);
        this.m10 = makeArray(L, L, false);
        this.c = makeArray(L, L, 0);
    }

    /** Alias for `q` (the CA clock period), matching other decoders' constructor-argument name. */
    get clockPeriod() { return this.q; }
    set clockPeriod(v) { this.q = v; }

    // TASK 4cx-b: for the stats panel, matching how repetition2/
    // repetition_streaming expose `clock`. In synchronous mode every
    // site's clock is provably equal (c(x,y,t) = t mod q, since step()
    // advances every site uniformly), so site (0,0) is exactly as
    // representative as any other. In asynchronous mode this value is
    // meaningless (sites genuinely diverge -- see the module header
    // comment) but is never read: main.js's generic clock-row logic
    // already hides the row whenever the "asynchronous" checkbox is
    // checked, independent of whatever `.clock` itself returns.
    get clock() { return this.c[0][0]; }

    // -- initialization ------------------------------------------------

    /**
     * Independent Bernoulli(p) errors on every qubit. `rng`, if given, is
     * a callable returning a uniform value in [0,1) each call (like
     * Math.random, the default); it is *stored* (not just used once) so
     * stepUncoord can keep drawing from the same stream for its random
     * site selection. Drawn qx-in-full-then-qy-in-full, mirroring
     * anim.toric_sync.iid_errors's convention. Resets messages and the
     * per-site clock/step count to zero, matching torca.reference.initial_state.
     */
    initializeRandomErrors(p, rng) {
        this._rng = rng || Math.random;
        const L = this.L;

        this.qx = makeArray(L, L, false);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                this.qx[x][y] = this._rng() < p;
            }
        }
        this.qy = makeArray(L, L, false);
        for (let x = 0; x < L; x++) {
            for (let y = 0; y < L; y++) {
                this.qy[x][y] = this._rng() < p;
            }
        }
        this.m00 = makeArray(L, L, false);
        this.m01 = makeArray(L, L, false);
        this.m10 = makeArray(L, L, false);
        this.c = makeArray(L, L, 0);
        this.stepCount = 0;
        this._pointerMode = null;
        this._paintVertex = null;
        this._paintMoved = false;
        this._paintInitialEdge = null;
        this._paintVisited = [];
        this._paintValue = null;
        this._dragCell = null;
        this._dragPath = [];
    }

    // -- core dynamics ---------------------------------------------------

    _computeSyndrome() {
        const L = this.L;
        const qx = this.qx, qy = this.qy;
        const s = makeArray(L, L, false);
        for (let x = 0; x < L; x++) {
            const xp = (x + 1) % L;
            for (let y = 0; y < L; y++) {
                const yp = (y + 1) % L;
                s[x][y] = (qx[x][y] !== qx[xp][y]) !== (qy[x][y] !== qy[x][yp]);
            }
        }
        return s;
    }

    _msgRead(msg, x, y) {
        const L = this.L;
        return msg[mod(x, L)][mod(y, L)];
    }

    _toomVote(msg, i, j, x, y) {
        const dx = (i === 0) ? -1 : 1;
        const dy = (j === 0) ? -1 : 1;
        const read = (xx, yy) => this._msgRead(msg, xx, yy) ? 1 : 0;
        const votes = read(x, y) + read(x + dx, y) + read(x, y + dy);
        return votes >= 2;
    }

    /**
     * One synchronous CA update over the whole torus: torca.reference.step_sync.
     * A defect may move iff `!this.movementGated || c(r)===0`; a
     * non-defect message may grow iff `c(r) < this.growthWindow`.
     */
    _interiorStep() {
        const L = this.L;
        const growthWindow = this.growthWindow;
        const movementGated = this.movementGated;

        const sT = this._computeSyndrome();
        const qxNext = cloneArray(this.qx);
        const qyNext = cloneArray(this.qy);
        const m00Next = cloneArray(this.m00);
        const m01Next = cloneArray(this.m01);
        const m10Next = cloneArray(this.m10);
        const cNext = cloneArray(this.c);

        const sInc = [];

        for (let x = 0; x < L; x++) {
            const xLeft = mod(x - 1, L);
            for (let y = 0; y < L; y++) {
                const yDown = mod(y - 1, L);
                const cxy = this.c[x][y];

                if (sT[x][y]) {
                    // Condition (i): defect persistence sets all three messages.
                    m00Next[x][y] = true;
                    m01Next[x][y] = true;
                    m10Next[x][y] = true;

                    const movementAllowed = (!movementGated) || (cxy === 0);
                    if (movementAllowed) {
                        // Paper priority: a qualifying left move preempts down.
                        if (this.m00[xLeft][y] || this.m01[xLeft][y]) {
                            qxNext[x][y] = !this.qx[x][y];
                            sInc.push([xLeft, y]);
                        } else if (this.m00[x][yDown] || this.m10[x][yDown]) {
                            qyNext[x][y] = !this.qy[x][y];
                            sInc.push([x, yDown]);
                        }
                    }
                } else {
                    const vote00 = this._toomVote(this.m00, 0, 0, x, y);

                    if (!this.m00[x][y]) {
                        m00Next[x][y] = (cxy < growthWindow) && (this.m00[xLeft][y] || this.m00[x][yDown]);
                    } else {
                        m00Next[x][y] = vote00;
                    }

                    if (!this.m01[x][y]) {
                        const yUp = mod(y + 1, L);
                        m01Next[x][y] = (cxy < growthWindow) && (this.m01[xLeft][y] || this.m01[x][yUp]);
                    } else {
                        const ownVote = this._toomVote(this.m01, 0, 1, x, y);
                        m01Next[x][y] = ownVote || (this.m00[x][y] && vote00);
                    }

                    if (!this.m10[x][y]) {
                        const xRight = mod(x + 1, L);
                        m10Next[x][y] = (cxy < growthWindow) && (this.m10[xRight][y] || this.m10[x][yDown]);
                    } else {
                        const ownVote = this._toomVote(this.m10, 1, 0, x, y);
                        m10Next[x][y] = ownVote || (this.m00[x][y] && vote00);
                    }
                }

                cNext[x][y] = (cxy + 1) % this.q;
            }
        }

        // Part 3: arrival overwrite (every target is a valid periodic index).
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
        this.c = cNext;
        this.stepCount += 1;
    }

    step() {
        this._interiorStep();
    }

    /**
     * One literal single-site asynchronous micro-update: torca.reference.
     * step_async / torca.uncoord's kernel. `site`, if given, is a flat
     * row-major index (x*L+y) or an [x,y] pair; if omitted, a site is
     * drawn uniformly from the stored rng (see initializeRandomErrors).
     * Every read is from the pre-update state; the arrival SetAll at the
     * movement target (if any) is part of this same micro-update. Only
     * the selected site's clock advances -- see the module header comment
     * on why `this.c` is a full array.
     */
    stepUncoord(site) {
        const L = this.L;
        let x, y;
        if (site === undefined) {
            const flat = Math.floor(this._rng() * L * L);
            x = Math.floor(flat / L);
            y = flat % L;
        } else if (Array.isArray(site)) {
            [x, y] = site;
        } else {
            x = Math.floor(site / L);
            y = site % L;
        }

        const xLeft = mod(x - 1, L);
        const yDown = mod(y - 1, L);
        const xRight = mod(x + 1, L);
        const yUp = mod(y + 1, L);
        const cxy = this.c[x][y];

        const sxy = this._computeSyndromeAt(x, y);
        let arrival = null;

        if (sxy) {
            this.m00[x][y] = true;
            this.m01[x][y] = true;
            this.m10[x][y] = true;

            const movementAllowed = (!this.movementGated) || (cxy === 0);
            if (movementAllowed) {
                if (this.m00[xLeft][y] || this.m01[xLeft][y]) {
                    this.qx[x][y] = !this.qx[x][y];
                    arrival = [xLeft, y];
                } else if (this.m00[x][yDown] || this.m10[x][yDown]) {
                    this.qy[x][y] = !this.qy[x][y];
                    arrival = [x, yDown];
                }
            }
        } else {
            const vote00 = this._toomVote(this.m00, 0, 0, x, y);
            const m00Center = this.m00[x][y];
            const m01Center = this.m01[x][y];
            const m10Center = this.m10[x][y];

            const m00New = m00Center ? vote00
                : (cxy < this.growthWindow) && (this.m00[xLeft][y] || this.m00[x][yDown]);
            const m01New = m01Center ? (this._toomVote(this.m01, 0, 1, x, y) || (m00Center && vote00))
                : (cxy < this.growthWindow) && (this.m01[xLeft][y] || this.m01[x][yUp]);
            const m10New = m10Center ? (this._toomVote(this.m10, 1, 0, x, y) || (m00Center && vote00))
                : (cxy < this.growthWindow) && (this.m10[xRight][y] || this.m10[x][yDown]);

            this.m00[x][y] = m00New;
            this.m01[x][y] = m01New;
            this.m10[x][y] = m10New;
        }

        this.c[x][y] = (cxy + 1) % this.q;

        if (arrival !== null) {
            const [xt, yt] = arrival;
            this.m00[xt][yt] = true;
            this.m01[xt][yt] = true;
            this.m10[xt][yt] = true;
        }

        this.stepCount += 1;
    }

    _computeSyndromeAt(x, y) {
        const L = this.L;
        const xp = mod(x + 1, L), yp = mod(y + 1, L);
        return (this.qx[x][y] !== this.qx[xp][y]) !== (this.qy[x][y] !== this.qy[x][yp]);
    }

    // -- queries -----------------------------------------------------------

    getSyndromeCount() {
        const s = this._computeSyndrome();
        let count = 0;
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) if (s[x][y]) count++;
        }
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                if (this.qx[x][y]) count++;
                if (this.qy[x][y]) count++;
            }
        }
        return count;
    }

    hasMessages() {
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                if (this.m00[x][y] || this.m01[x][y] || this.m10[x][y]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    /**
     * Both winding parities (torca.reference.winding_parities): horizontal
     * = winding_x = parity of qx[0,:] summed over y; vertical = winding_y
     * = parity of qy[:,0] summed over x. hasError is their OR, matching
     * torca.reference.RunResult.logical_failure.
     */
    checkLogicalError() {
        const L = this.L;
        let windingX = 0;
        for (let y = 0; y < L; y++) if (this.qx[0][y]) windingX ^= 1;
        let windingY = 0;
        for (let x = 0; x < L; x++) if (this.qy[x][0]) windingY ^= 1;
        const horizontal = windingX === 1;
        const vertical = windingY === 1;
        return { hasError: horizontal || vertical, horizontal, vertical };
    }

    // -- layout shared by render() and toggleErrorAtPosition() -------------

    // TASK 4cx: rebuilt to match repetition2.js's own _layout() -- a fixed
    // topGap under the decoder title (13px, the same value repetition2
    // uses for its own history box), a "y" label reserved on the left
    // exactly like repetition2's "t" label (same TLABEL_GLYPH_W/
    // AXIS_LABEL_CLEARANCE-based gutter, same whole-block horizontal
    // centring), and an "x" label budget below exactly like repetition2's
    // own "x". The one structural difference from repetition2's 1D ring:
    // this lattice is a genuinely 2D LxL square, so `cell` must satisfy a
    // WIDTH cap (fitting L columns plus the left gutter) AND a HEIGHT cap
    // (fitting L rows plus the fixed top/bottom budgets) simultaneously --
    // repetition2 only ever caps cell by width, since its history box's
    // ROW COUNT (not cell size) is what flexes with available height.
    // The snapped edges and their cell midpoints are shared by drawing,
    // anchors and pointer conversion, including fractional cell sizes.
    _layout(canvasWidth, canvasHeight, overlayRects) {
        if (overlayRects !== undefined) this._lastOverlayRects = overlayRects;
        const effectiveOverlayRects = overlayRects !== undefined ? overlayRects : this._lastOverlayRects;
        const narrowLayout = effectiveOverlayRects?.narrowLayout === true;
        const L = this.L;
        const xLabelGap = AXIS_LABEL_CLEARANCE;
        const xLabelH = X_LABEL_EXTRA_CLEARANCE + CODE_CAP_X_LABEL_INK_HEIGHT;
        // Include the shift in the height budget to preserve bottom-label clearance.
        const topGap = 13 + CODE_CAP_GRAPHIC_SHIFT_DOWN;
        const bottomMargin = 14; // same as repetition2's own bottomMargin

        // TASK 4em fix: cellByWidth/panelLeft used to size against a flat
        // "canvasWidth - 120" guess for the right-hand info/legend cards'
        // width and centre the panel within the FULL canvasWidth,
        // ignoring the left-hand description card entirely -- the same
        // pattern repetition_streaming.js had, and fixed the same way
        // (see that file's own longer comment for the full mechanism:
        // TASK 4em capping .visualization-container's width moved both
        // cards relative to the canvas, shrinking the margin this flat
        // guess relied on). At this module's typical L the height cap
        // (cellByHeight below) usually binds before the width guess would
        // even matter, which is why this was a narrow miss here (a few px
        // right at the description card's own edge) rather than the
        // broad overlap repetition_streaming.js had -- but the same fix
        // applies: size/centre against the real span between both cards
        // when overlayRects is available, falling back to the original
        // flat guess/full-canvasWidth centring when it isn't (this file's
        // own Node test harness and its own toggleErrorAtPosition/
        // _pointerToLattice, which call _layout() with no third argument
        // and rely on the this._lastOverlayRects cache above for hit-
        // testing against whatever was last actually drawn).
        const cardsLeft = effectiveOverlayRects?.infoPanel?.left;
        const descStackRight = effectiveOverlayRects?.description?.right;
        const haveOverlay = Number.isFinite(cardsLeft) && Number.isFinite(descStackRight);
        const freeLeft = narrowLayout ? CODE_CAP_NARROW_EDGE_MARGIN
            : haveOverlay ? (descStackRight + 8) : 0;
        const freeRight = narrowLayout ? canvasWidth - CODE_CAP_NARROW_EDGE_MARGIN
            : haveOverlay ? (cardsLeft - 8) : canvasWidth;
        const widthSizingSpan = narrowLayout || haveOverlay
            ? (freeRight - freeLeft) : (canvasWidth - 120);
        // Width cap: labelReserve (below) plus cell*L must fit within
        // widthSizingSpan (the real span between both cards, or the same
        // flat guess as before when that isn't available).
        const availableCellWidth = (widthSizingSpan - TLABEL_GLYPH_W - AXIS_LABEL_CLEARANCE) / (L + 0.2);
        const cellByWidth = narrowLayout ? availableCellWidth : Math.min(28, availableCellWidth);
        // Height cap: topGap + cell*L (no separate row-count budget here,
        // unlike repetition2's scrollable history -- L is fixed, so the
        // whole square must fit) + the "x" label's own budget + bottom margin.
        const heightBudget = canvasHeight - topGap - xLabelGap - xLabelH - bottomMargin;
        const cellByHeight = heightBudget / L;
        // Narrow cells use the full fitted extent. Desktop retains integer
        // width/cap sizing and its existing height reserve.
        const cell = Math.max(1, narrowLayout ? Math.min(cellByWidth, cellByHeight)
            : cellByHeight < cellByWidth
            ? (heightBudget - CODE_CAP_HEIGHT_RESERVE) / L
            : Math.floor(cellByWidth));

        const labelGutter = AXIS_LABEL_CLEARANCE + 0.2 * cell;
        const labelReserve = TLABEL_GLYPH_W + labelGutter;
        const panelWidth = cell * L + labelReserve;
        const panelLeft = freeLeft + (freeRight - freeLeft - panelWidth) / 2;
        const xAxis = createSnappedAxis(Math.round(panelLeft + labelReserve), cell, L);
        const yAxis = createSnappedAxis(topGap, cell, L);
        const xEdges = xAxis.edges, yEdges = yAxis.edges;
        const boxLeft = xEdges[0], boxTop = yEdges[0];
        const boxWidth = xEdges[L] - boxLeft;
        const boxBottom = yEdges[L];
        const boxHeight = boxBottom - boxTop;
        const yLabelMidY = boxTop + boxHeight / 2; // matches repetition2's tLabelMidY role
        const xLabelTop = boxBottom + xLabelGap;

        // Keep the box-origin aliases for callers inspecting the layout.
        const offsetX = boxLeft;
        const offsetY = boxTop;

        return {
            L, cell, offsetX, offsetY,
            xAxis, yAxis, xEdges, yEdges, siteX: xAxis.sites, siteY: yAxis.sites,
            X: xAxis.toPixel, Y: (ly) => yAxis.toPixel(L - 1 - ly),
            boxLeft, boxTop, boxWidth, boxHeight, boxBottom,
            panelLeft, panelWidth, labelReserve, labelGutter,
            yLabelFontSize: TLABEL_FONT_SIZE, xLabelFontSize: TLABEL_FONT_SIZE, yLabelMidY,
            xLabelTop, xLabelH
        };
    }

    // -- rendering -----------------------------------------------------

    // TASK 4cq/4cw analogues: expose the decoder title's horizontal centre
    // in the same canvas-local CSS-pixel coordinate system _layout()
    // itself uses, so main.js's generic updateTitlePosition() hook
    // (already duck-typed against repetition2's identical method) pins
    // the decoder title to this module's own lattice too.
    // TASK 4da: getDescriptionAnchor uses a fixed { top } instead of this
    // module's own { bottom: layout.boxBottom } (TASK 4cq/4cw's original
    // approach) -- this lattice is far shorter than repetition2's own
    // history box at the same canvas size, so anchoring to *this* box's
    // bottom landed the card much higher up than repetition2's own card.
    // DESCRIPTION_TOP_CSS (repetition2.js's own measured card-top value)
    // makes all three modules' cards start at the same height regardless
    // of lattice size.
    getDescriptionAnchor(canvasWidth, canvasHeight) {
        return { top: DESCRIPTION_TOP_CSS };
    }

    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        const layout = this._layout(canvasWidth, canvasHeight, overlayRects);
        return { centerX: layout.boxLeft + layout.boxWidth / 2 };
    }

    /**
     * Draw the torus: grey grid, red string-piece links between cell
     * centres for errors (wraparound qubits as two half-pieces to the
     * panel border), orbs on defects, message tinting. No rough
     * boundaries (there are none on a torus). TASK 4cx: restyled to match
     * repetition2.js's own render() as closely as the 2D torus geometry
     * allows -- see the module header comment for the full rationale and
     * what does/doesn't change.
     */
    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const opts = {
            showSyndrome: true, showErrors: true, showMessages: true, showGrid: true,
            ...options,
        };
        const L = this.L;
        const layout = this._layout(canvasWidth, canvasHeight, opts.overlayRects);
        const {
            cell, X, Y, xEdges, yEdges, boxLeft, boxTop, boxWidth, boxHeight, boxBottom,
            yLabelFontSize, yLabelMidY, xLabelFontSize, xLabelTop,
        } = layout;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Everything inside the lattice (fills, grid lines,
        // error strings, defect orbs) is clipped to the box's own
        // rectangle -- TASK 4cx, matching repetition2's box/site-row
        // clipping so nothing can bleed past the outline drawn after.
        ctx.save();
        ctx.beginPath();
        ctx.rect(boxLeft, boxTop, boxWidth, boxHeight);
        ctx.clip();

        // Full-cell message tiles share their geometry and palette with
        // the other code-capacity tab; grid, errors and orbs draw on top.
        if (opts.showMessages) {
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    const mask = (this.m00[x][y] ? 1 : 0)
                        | (this.m01[x][y] ? 2 : 0) | (this.m10[x][y] ? 4 : 0);
                    if (!mask) continue;
                    const row = L - 1 - y;
                    drawMessageCell(ctx, xEdges[x], yEdges[row], xEdges[x + 1], yEdges[row + 1], mask);
                }
            }
        }

        // Grey grid, same colour and grid-line-width formula as
        // repetition2's drawCaGridLines, drawn over the message fills.
        const gridLineWidth = Math.max(1, Math.round(cell / 18));
        if (opts.showGrid) {
            drawSnappedGrid(ctx, xEdges, yEdges, gridLineWidth);
        }

        // Qubit errors as red string pieces joining the centres of the two
        // cells the qubit separates (crossing the shared edge at its
        // midpoint), drawn here (before the defect orbs below) so a chain
        // of errors reads as one continuous string between its endpoint
        // defects. qx[x,y] joins cells (x-1,y) and (x,y) for x=1..L-1;
        // qx[0,y] wraps around (joins (L-1,y) and (0,y) through the
        // periodic boundary), so it is drawn as two half-pieces to the
        // panel's left and right borders instead of one line spanning the
        // whole row. qy[x,y] joins (x,y-1) and (x,y) for y=1..L-1, with
        // qy[x,0] handled the same way at the bottom/top borders. Round
        // caps so consecutive pieces (e.g. a chain turning a corner) join
        // cleanly with no gap and no doubled-up overlap. TASK 4cx: colour
        // and thickness now come from the same COLOR_ERROR constant and
        // wBlue/stringWidth formula as repetition2's own error strings
        // (Math.max(1, 1.05 * Math.max(2, Math.round(cell/9)))), replacing
        // this module's previous Math.max(1.5, cell*0.12).
        if (opts.showErrors) {
            const wBlue = Math.max(2, Math.round(cell / 9));
            const stringWidth = Math.max(1, 1.05 * wBlue);
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            ctx.lineCap = 'round';
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    if (!this.qx[x][y]) continue;
                    const py = Y(y);
                    if (x === 0) {
                        ctx.beginPath();
                        ctx.moveTo(X(0), py);
                        ctx.lineTo(X(-0.5), py);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(X(L - 1), py);
                        ctx.lineTo(X(L - 0.5), py);
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(X(x - 1), py);
                        ctx.lineTo(X(x), py);
                        ctx.stroke();
                    }
                }
            }
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    if (!this.qy[x][y]) continue;
                    const px = X(x);
                    if (y === 0) {
                        ctx.beginPath();
                        ctx.moveTo(px, Y(0));
                        ctx.lineTo(px, Y(-0.5));
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(px, Y(L - 1));
                        ctx.lineTo(px, Y(L - 0.5));
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(px, Y(y - 1));
                        ctx.lineTo(px, Y(y));
                        ctx.stroke();
                    }
                }
            }
        }

        // Defects as shaded orbs -- TASK 4cx: now drawOrb() imported
        // directly from repetition2.js, called with its own
        // DEFECT_ORB_RADIUS/DEFECT_ORB_OUTLINE constants (0.30618/0.0486),
        // replacing this module's previous ad hoc r = cell*0.3 gradient
        // drawn inline. drawCaDefects() itself isn't used here since it
        // assumes a row/col top-down grid iteration repetition2's own
        // scrolling history needs -- toric2 already iterates (x,y) via its
        // own X()/Y(), so calling the shared drawOrb() primitive directly
        // is the natural fit; the glyph itself is identical either way.
        if (opts.showSyndrome) {
            const s = this._computeSyndrome();
            for (let x = 0; x < L; x++) {
                for (let y = 0; y < L; y++) {
                    if (!s[x][y]) continue;
                    const row = L - 1 - y;
                    const siteCell = Math.min(xEdges[x + 1] - xEdges[x], yEdges[row + 1] - yEdges[row]);
                    drawOrb(ctx, X(x), Y(y), siteCell, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
            }
        }

        ctx.restore();

        // Box border -- always drawn regardless of the grid display
        // option, always on top of the clipped interior content above
        // (TASK 4cx, matching repetition2's box/site-row outlines exactly:
        // same colour, same 1.3 lineWidth).
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3;
        ctx.strokeRect(boxLeft + 0.5, boxTop + 0.5, boxWidth, boxHeight);

        // "y" label to the left of the box, with its bold upward arrow --
        // TASK 4cx: the 2D analogue of repetition2's own "t" label, using
        // the identical font, arrow glyph/style, AXIS_LABEL_CLEARANCE, and
        // extra per-axis clearance value (T_LABEL_EXTRA_CLEARANCE,
        // imported as Y_LABEL_EXTRA_CLEARANCE) -- see repetition2.js's own
        // comment on this same code for the ink-measurement rationale.
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

        // "x ->" label below the box -- TASK 4cx: identical to
        // repetition2's own "x" label code (same font, arrow ink gap,
        // extra clearance), just anchored on this module's boxBottom
        // instead of repetition2's siteRowBottom.
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
        const latticeY = this.L - 1 - yAxis.toLattice(y);
        return [latticeX, latticeY];
    }

    /**
     * Nearest edge qubit (qx or qy) to a lattice-space point, wrapping
     * around the torus, with its (unwrapped) distance -- shared by
     * toggleErrorAtPosition (no tolerance) and the paint gesture below
     * (which does apply a tolerance at pointerdown).
     */
    _nearestEdge(latticeX, latticeY) {
        const L = this.L;

        // qx candidate: nearest integer column (unwrapped, so a click just
        // past either border still measures a small distance to the
        // qx[0,y] wraparound qubit), then wrapped to a valid array index.
        const qxXRaw = Math.round(latticeX + 0.5);
        const qxX = mod(qxXRaw, L);
        const qxYRaw = Math.round(latticeY);
        const qxY = mod(qxYRaw, L);
        const dQx = Math.hypot(latticeX - (qxXRaw - 0.5), latticeY - qxYRaw);

        const qyYRaw = Math.round(latticeY + 0.5);
        const qyY = mod(qyYRaw, L);
        const qyXRaw = Math.round(latticeX);
        const qyX = mod(qyXRaw, L);
        const dQy = Math.hypot(latticeX - qyXRaw, latticeY - (qyYRaw - 0.5));

        return (dQx <= dQy) ? { kind: 'qx', x: qxX, y: qxY, dist: dQx }
                            : { kind: 'qy', x: qyX, y: qyY, dist: dQy };
    }

    /** Toggle whichever edge qubit (qx or qy) is nearest the click, wrapping around the torus. */
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
     *    path for a diagonal jump; each axis takes the shorter way around
     *    the torus), flipping the qubit shared by each consecutive pair of
     *    cells. The path wraps around the torus in either axis; moving
     *    onto a cell that already has another defect annihilates both
     *    (the shared edge still flips) and ends the drag, since there is
     *    no longer a defect here to keep dragging.
     *  - Paint (TASK 4ei: now a vertex-to-vertex walk, not a per-sample
     *    nearest-edge toggle -- a fast or diagonal drag used to skip edges
     *    between coarse pointer samples, leaving scattered single-edge
     *    errors instead of one contiguous string): pointerdown within
     *    EDGE_PAINT_TOLERANCE of an edge qubit's midpoint decides the
     *    stroke's value V = NOT(that edge's current value) -- unchanged
     *    semantics from before this task -- and remembers both that edge
     *    (_paintInitialEdge) and the nearest VERTEX (_paintVertex, the
     *    same wrapped-and-rounded point _computeSyndromeAt's own (x,y)
     *    space uses, where a defect can actually sit). Each subsequent
     *    pointerMove finds the nearest vertex under the pointer, and if it
     *    differs from _paintVertex, walks (_walkPaintTo) every edge along
     *    a shortest lattice path from the old vertex to the new one to V,
     *    then updates _paintVertex -- so a drag from vertex A to vertex B
     *    along any route sets every edge crossed along the way, not just
     *    whichever single edge happened to be nearest each individual
     *    pointermove sample. _paintInitialEdge itself is deliberately NOT
     *    painted here at pointerdown: since it's chosen from the raw click
     *    position rather than the walk's own A-to-B path, painting it
     *    unconditionally could leave a spurious extra edge disconnected
     *    from that path (e.g. clicking near vertex A's own west edge, then
     *    dragging east, would otherwise flip that west edge as a stray
     *    third defect on top of the intended pair at A and the drag's own
     *    end point) -- pointerUp below paints it instead, but only as a
     *    fallback if the vertex never actually changed during this
     *    gesture (_paintMoved stays false), which is exactly a plain click
     *    and restores that case's old one-edge-toggle behaviour exactly.
     *    Since setting an edge to V (not toggling it) is idempotent,
     *    retracing the same ground mid-stroke is harmless -- unlike the
     *    defect drag above, no path/undo bookkeeping is needed for paint
     *    at all. A new stroke (a fresh pointerDown) on an already-painted
     *    edge paints the opposite value, since V is recomputed from that
     *    edge's current state each time.
     *
     * Away from either zone, paint still starts at the nearest vertex,
     * but V is deferred until the walk touches its first edge. That edge's
     * current state decides V for the whole stroke. With no initial edge,
     * a plain click that never moves changes nothing.
     */
    pointerDown(x, y, cssW, cssH) {
        const L = this.L;
        const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
        const cellX = mod(Math.round(latticeX), L);
        const cellY = mod(Math.round(latticeY), L);
        const dist = Math.hypot(latticeX - Math.round(latticeX), latticeY - Math.round(latticeY));

        if (dist <= DEFECT_GRAB_RADIUS && this._computeSyndromeAt(cellX, cellY)) {
            this._pointerMode = 'defect';
            this._dragCell = [cellX, cellY];
            this._dragPath = [[cellX, cellY]];
            return;
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
     * wrapped-Manhattan distance between them if and only if that
     * recorded stretch is itself monotonic in both axes -- exactly the
     * condition under which a fresh walk between the same two endpoints
     * (same |dx|/|dy| magnitudes either direction, so the same
     * axis-first rule) is guaranteed to retrace it exactly. A shorter
     * fresh distance means a genuine shortcut exists (the loop-closing
     * case), so that's walked as new ground instead, appending whatever
     * it actually passes through.
     *
     * When the retrace check does apply, _paintVisited is truncated back
     * to (and including) the rediscovered vertex, matching
     * _dragDefectTo's own "retracing pops back to that point in the path"
     * convention -- vertices beyond it were only ever reachable via the
     * segment now abandoned, so they no longer describe the stroke's own
     * current path. A genuinely new vertex still walks as before, and
     * every intermediate vertex that walk actually passes through (not
     * just the final one) is appended to _paintVisited, so a later jump
     * back to any of them is also recognised as a retrace, not new ground.
     */
    pointerMove(x, y, cssW, cssH) {
        if (this._pointerMode === 'paint') {
            const L = this.L;
            const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
            const vx = mod(Math.round(latticeX), L);
            const vy = mod(Math.round(latticeY), L);
            if (vx !== this._paintVertex[0] || vy !== this._paintVertex[1]) {
                const visitedIdx = this._paintVisited.findIndex(([px, py]) => px === vx && py === vy);
                const recordedDistance = visitedIdx === -1 ? -1 : this._paintVisited.length - 1 - visitedIdx;
                const freshDistance = Math.abs(shortestDelta(this._paintVertex[0], vx, L)) + Math.abs(shortestDelta(this._paintVertex[1], vy, L));
                if (visitedIdx !== -1 && recordedDistance === freshDistance) {
                    this._paintVisited = this._paintVisited.slice(0, visitedIdx + 1);
                } else {
                    const path = this._walkPaintTo(this._paintVertex, [vx, vy], this._paintValue);
                    this._paintVisited.push(...path);
                }
                this._paintVertex = [vx, vy];
                this._paintMoved = true;
            }
        } else if (this._pointerMode === 'defect' && this._dragCell !== null) {
            const L = this.L;
            const [latticeX, latticeY] = this._pointerToLattice(x, y, cssW, cssH);
            const targetX = mod(Math.round(latticeX), L);
            const targetY = mod(Math.round(latticeY), L);
            this._dragDefectTo(targetX, targetY);
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

    /** Flip the qubit shared by two 4-connected-adjacent cells (adjacency may wrap around the torus); used both to extend the drag path forward and, called again on the same pair, to undo that exact step while retracing. */
    _flipEdgeBetween(a, b) {
        const L = this.L;
        if (a[1] === b[1]) {
            const x = (mod(a[0] + 1, L) === b[0]) ? b[0] : a[0];
            this.qx[x][a[1]] = !this.qx[x][a[1]];
        } else {
            const y = (mod(a[1] + 1, L) === b[1]) ? b[1] : a[1];
            this.qy[a[0]][y] = !this.qy[a[0]][y];
        }
    }

    /**
     * TASK 4ei: paint's own analogue of _flipEdgeBetween just above -- SET
     * (not flip) the qubit shared by two 4-connected-adjacent cells
     * (adjacency may wrap around the torus) to `value`. Identical index
     * arithmetic to _flipEdgeBetween (kept as a separate method rather
     * than parameterising that one with an operation, matching this
     * module's existing style of small, single-purpose gesture helpers).
     */
    _setEdgeBetween(a, b, value) {
        const L = this.L;
        if (a[1] === b[1]) {
            const x = (mod(a[0] + 1, L) === b[0]) ? b[0] : a[0];
            this._setPaintEdge('qx', x, a[1], value);
        } else {
            const y = (mod(a[1] + 1, L) === b[1]) ? b[1] : a[1];
            this._setPaintEdge('qy', a[0], y, value);
        }
    }

    /** Resolve a deferred stroke value on its first edge, then reuse it. */
    _setPaintEdge(kind, x, y, value) {
        if (value === null) {
            if (this._paintValue === null) this._paintValue = !this[kind][x][y];
            value = this._paintValue;
        }
        this[kind][x][y] = value;
    }

    /**
     * TASK 4ei: set to `value` every edge along a shortest lattice path
     * from vertex `from` to vertex `to` (wrapping around the torus in
     * either axis), one 4-connected step at a time -- the paint stroke's
     * own walk between two consecutive pointermove samples, so a fast or
     * diagonal drag no longer skips edges the way a per-sample
     * nearest-edge toggle did. Setting an edge to `value` (not toggling
     * it) is already idempotent, so walking over already-painted ground
     * just re-sets the same edges to the same value, harmlessly -- unlike
     * _dragDefectTo, this itself needs no retrace/undo bookkeeping of its
     * own to stay correct. TASK 4ei-b: pointerMove is what actually avoids
     * calling this at all for a direct jump back to a vertex the stroke
     * has already visited, since axis order below is decided per-segment
     * (see just below) and so isn't guaranteed to retrace the same
     * corner -- this method itself has no notion of "the stroke so far",
     * only ever walking the one segment it's given; see pointerMove's own
     * comment for the full reasoning. Returns every vertex actually
     * passed through, in order (excluding `from`, including `to`), so
     * pointerMove can extend its own visited-vertex record with all of
     * them, not just the final endpoint.
     *
     * Axis order follows this segment's own direction of travel -- x
     * first when the shortest (wrapped) displacement moved more in x
     * (|dx| >= |dy|), y first otherwise -- rather than _dragDefectTo's
     * fixed x-then-y order, so an L-shaped hop for a diagonal segment
     * reads as "mostly horizontal with a short vertical jog" (or vice
     * versa) matching the pointer's own actual direction, instead of
     * always cornering the same way regardless of it.
     */
    _walkPaintTo(from, to, value) {
        const L = this.L;
        const dx = shortestDelta(from[0], to[0], L);
        const dy = shortestDelta(from[1], to[1], L);
        let [cx, cy] = from;
        // TASK 4ei-b: every vertex this walk actually passes through, in
        // order (excluding `from`, including `to`) -- pointerMove appends
        // this to _paintVisited so a later direct jump back to any of
        // them (not just the final `to`) is recognised as a retrace
        // rather than new ground.
        const path = [];

        const stepX = () => {
            const dirX = dx >= 0 ? 1 : -1;
            while (cx !== to[0]) {
                const nx = mod(cx + dirX, L);
                this._setEdgeBetween([cx, cy], [nx, cy], value);
                cx = nx;
                path.push([cx, cy]);
            }
        };
        const stepY = () => {
            const dirY = dy >= 0 ? 1 : -1;
            while (cy !== to[1]) {
                const ny = mod(cy + dirY, L);
                this._setEdgeBetween([cx, cy], [cx, ny], value);
                cy = ny;
                path.push([cx, cy]);
            }
        };

        if (Math.abs(dx) >= Math.abs(dy)) { stepX(); stepY(); } else { stepY(); stepX(); }
        return path;
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
     * then y (each axis taking the shorter way around the torus), exactly
     * as before. A cell that already has a defect annihilates with the
     * dragged one on arrival (ending the drag, _dragCell/_dragPath reset
     * to empty) since there is nothing left to keep dragging.
     */
    _dragDefectTo(targetX, targetY) {
        const L = this.L;

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

        const dirX = shortestDir(cx, targetX, L);
        while (cx !== targetX) {
            const nx = mod(cx + dirX, L);
            this._flipEdgeBetween([cx, cy], [nx, cy]);
            cx = nx;
            this._dragPath.push([cx, cy]);
            this._dragCell = [cx, cy];
            if (!this._computeSyndromeAt(cx, cy)) {
                // The step just annihilated with a pre-existing defect here.
                this._dragCell = null;
                this._dragPath = [];
                return;
            }
        }

        const dirY = shortestDir(cy, targetY, L);
        while (cy !== targetY) {
            const ny = mod(cy + dirY, L);
            this._flipEdgeBetween([cx, cy], [cx, ny]);
            cy = ny;
            this._dragPath.push([cx, cy]);
            this._dragCell = [cx, cy];
            if (!this._computeSyndromeAt(cx, cy)) {
                this._dragCell = null;
                this._dragPath = [];
                return;
            }
        }
    }
}
