// Repetition Code Decoder Module (2) -- the paper's verified CA rule.
//
// This is a literal port of the oracle at
// local-comp-numerics/repca/reference.py (State.qub = err0 xor e,
// syndrome s(x) = qub(x) xor qub(x+1), step_sync/step_async implementing
// Algorithm 1's three parts: defect dynamics, message dynamics, defect
// arrival). `err0` and `e` are never needed separately -- only their xor,
// so this module tracks that xor directly as `qubits` and flips it in
// place wherever the oracle flips `e`.
//
// Rendering follows anim/repcode_sync.py's conventions: a scrolling
// spacetime history box above a live site row, message cells filled
// light blue, defects drawn as shaded orbs, and qubit errors drawn as
// red links on the bond between the two sites they touch.
//
// TASK 4cx: several of the layout/style constants and rendering helpers
// below are exported purely so toric2.js can share them by import instead
// of duplicating numbers (axis-label clearances, the "t"/"x" font, the
// defect-orb glyph, snapPixel). None of this file's own dynamics, gesture
// handling, or _layout()/render() behaviour changes as a result -- these
// are additive `export` keywords on existing declarations only.

export const FONT_SERIF = '"Latin Modern Roman", "CMU Serif", "Times New Roman", serif';

// TASK 4ey: the "spacetime"/"history"/"system" gutter captions read the
// site's own UI mono font and muted card-label colour from the
// stylesheet itself (:root's --font-mono, and --text-dim -- the exact
// value .stat-row span:first-child, the "step:"/"clock:"/... labels,
// already use), read once and cached rather than hard-coded, so a future
// change to either CSS custom property is picked up automatically. Falls
// back to today's actual values only when there's no DOM at all (this
// file's own Node test harness, which never exercises canvas text
// rendering) -- never reached in a real render.
const _cachedCssVars = {};
function readCssVar(name, fallback) {
    if (name in _cachedCssVars) return _cachedCssVars[name];
    let value = fallback;
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
        const read = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        if (read) value = read;
    }
    _cachedCssVars[name] = value;
    return value;
}
function getMonoFontFamily() {
    return readCssVar('--font-mono', '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace');
}
function getMutedTextColor() {
    return readCssVar('--text-dim', '#6b7280');
}
// TASK 4bf: exported so main.js's shared HTML legend mechanism can read
// these directly (getLegendItems()'s repetition2 case) instead of
// duplicating the hex values, now that this module no longer draws its
// own canvas legend.
export const COLOR_MSG_FILL = 'rgb(200,210,248)';
export const COLOR_MSG_EDGE = 'rgb(120,135,220)';
export const COLOR_GRID = 'rgb(128,128,128)';
export const COLOR_ERROR = 'rgb(175,55,55)';
const LEGEND_FONT_SIZE = 13; // TASK 4bf: only a font-size scaling basis now (TLABEL_FONT_SIZE below) -- the legend itself moved to HTML/main.js
export const TLABEL_FONT_SIZE = LEGEND_FONT_SIZE * 1.3; // "up-arrow / t" and "x ->" labels
// Conservative single-glyph width estimate at TLABEL_FONT_SIZE, used only to
// size the reserved left margin in the pure layout math below (no canvas
// measureText there, so this cannot depend on a live context). A single
// serif/symbol glyph is essentially never wider than its own font size, so
// this over-reserves slightly rather than risking clipping against the box.
export const TLABEL_GLYPH_W = TLABEL_FONT_SIZE;
export const COLOR_ORB_RIM = 'rgb(82,82,82)';

// TASK 4ez: the "spacetime"/"history"/"system" gutter captions (not "t"/
// "x", which stay at TLABEL_FONT_SIZE unchanged) are smaller than the
// axis-variable labels by this fixed fraction -- the reference/cap size
// their own off-canvas shrink-to-fit check starts from and, failing
// that, settles at. 0.78 x TLABEL_FONT_SIZE = 13.182px today.
export const CAPTION_SCALE = 0.78;
// TASK 4fa: both captions' right ink edge -- "spacetime" (and so the
// centred "history") and "system" -- now sits this many px further left
// than tInkRight itself; "t"'s own column is untouched, only where the
// captions target relative to it. The off-canvas shrink-to-fit check
// (boxLabelAvailableWidth below) uses this same shifted edge, not
// tInkRight directly, so a caption still never runs off the canvas on
// the left even after the shift eats into its margin there.
// TASK 4fb: 6 -> 9. TASK 4fd: 9 -> 5 (moves all three captions --
// "system" centres on blockCenterX, which is derived from "spacetime"'s
// own right edge here -- 4px right together).
export const CAPTION_SHIFT_LEFT = 5;
// TASK 4fc: replaces CAPTION_BLOCK_GAP_ABOVE_SYSTEM (TASK 4fb) -- the
// "spacetime"/"history" block moves back to the top of the gutter
// (lower than TASK 4fa's own boxTop + 4, but anchored downward from
// boxTop again, not upward from "system"): "spacetime"'s own ink top
// (baseline - actualBoundingBoxAscent) sits at boxTop + this many px,
// with "history" one line height below as before. "t"'s own label/
// arrow, "system"'s own vertical centring, and "spacetime"'s own right
// edge (still tInkRight - CAPTION_SHIFT_LEFT, so blockCenterX derived
// from it is unchanged) do not move -- this only repositions the
// two-line block's vertical anchor.
export const CAPTION_BLOCK_TOP_OFFSET = 40;
// Minimum clearance from the canvas's left edge when captions shrink to fit.
export const CAPTION_EDGE_MARGIN = 2;

// TASK 4e: the horizontal clearance from the "t" label's right ink edge to
// the history box's left line must equal the vertical clearance from the
// site row's bottom line to the "x" label's top ink edge -- both are
// defined as exactly this one constant (see render()), so they can never
// drift apart under different fonts/browsers.
// TASK 4ah: raised ~50% (6 -> 9) for more breathing room around both
// labels/arrows; _layout()'s labelGutter and xLabelGap both reference this
// same constant directly (rather than a separately-hardcoded matching
// literal) so the two nominal layout budgets stay exactly equal by
// construction too, not just the real ink-level gaps computed in render().
// TASK 4be: raised again, 9 -> 11 -- the extra 2px comes out of the
// margins in the existing cell-solve budget (see _layout() below), not
// the cell size, exactly as the 4ah increase already did.
export const AXIS_LABEL_CLEARANCE = 11;
// TASK 4e/4h: gap from the "x" glyph's right ink edge to its rightward
// arrow's left ink edge (the "t" label no longer has an arrow at all).
export const AXIS_ARROW_INK_GAP = 6;

// TASK 4cr: each axis's own extra clearance from its box edge, added only
// at the ink-level rendering step below (never fed into _layout()'s
// box-size/cell-size budget, unlike AXIS_LABEL_CLEARANCE itself) -- so
// nudging one axis's label+arrow pair further out doesn't perturb the
// cell-size solve, the other axis, or the arrow's own gap from its label
// (AXIS_ARROW_INK_GAP, untouched -- the arrow is positioned relative to
// the label's own ink, so the whole pair rigidly shifts together).
export const T_LABEL_EXTRA_CLEARANCE = 2; // "t" label + arrow, further left
export const X_LABEL_EXTRA_CLEARANCE = 2; // "x" label + arrow, further down

// TASK 4eo/4eo-b/4ep-b (all superseded by TASK 4eq, see _layout() below):
// this branch's boxLeft went through a "centre in the free width, then
// shift left by a fixed amount" phase (4eo/4eo-b), then a fixed
// panel-relative offset (4ep-b's own BOX_LEFT_CSS = 32, applied with no
// further adjustment), before landing on TASK 4eq's own panel-relative
// CENTRING (equal whitespace either side of the box, between the panel's
// left border and the cards' left edge) -- kept only as this comment for
// the history; none of those constants or the machinery that used them
// remain.

// TASK 4ep-c: repetition2 only, 'right'-placement branch -- corrects TASK
// 4ep-b, which let the cell-size solve grow into the extra room TASK
// 4ep's own panel-widening opened up on the cards' side (cell went from
// 10 to 11). The user's own intent for TASK 4ep was narrower: only the
// cards move; the history box keeps its exact pre-4ep size (cell 10,
// boxWidth 640). Subtracting this constant -- exactly the 40px TASK 4ep
// widened the panel by -- from the cell solve's own right bound
// (cardsLeft - 8 below) cancels that growth precisely, reproducing
// today's pre-4ep cell/boxWidth exactly, while leaving the extra 40px as
// unused gap between the box's own right edge and the cards (which really
// did move the full 40px in canvas-relative terms, per TASK 4ep-b's own
// panel-relative verification) instead of the box eating into it.
//
// TASK 4es-b: changed to 91 (a panel-relative-solved value, derived below)
// to survive widening the canvas to fill .canvas-area's own inner width
// in main.js's applyCanvasSize() (this constant's own 40px calibration
// implicitly baked in the OLD canvasOffsetInPanel produced by the
// previous, narrower 940px cap -- see cellRightBound's own comment below
// for why a naive re-derivation silently reproduced the broken pre-4es-b
// formula the first time this was attempted). This value is this task's
// own flag-independent, permanent baseline now (TASK 4ew's three-pillar
// layout builds on top of it rather than reverting it -- team-lead's
// TASK 4ew-b correction, after an earlier, mistaken revert-then-rebuild
// pass on this file).
export const EXTRA_RIGHT_GAP = 91;

// TASK 4cu: which edge getDescriptionAnchor() (below) pins the HTML
// description card's bottom to -- the user has gone back and forth
// between the two (TASK 4cq introduced 'strip', TASK 4ct tried 'box'),
// so this is a single named switch rather than editing the method body
// each time. 'strip' = the site-row strip's bottom edge (layout.siteRowBottom,
// the one-row box below the spacetime history). 'box' = the spacetime
// history box's own bottom outline edge (layout.boxBottom).
const DESCRIPTION_ANCHOR = 'box';

// TASK 4da: this module's own description card's top edge, measured live
// via CDP at 1600x1100 (canvas.offsetTop was 0 in that measurement, so
// this is directly card.getBoundingClientRect().top -
// canvas.getBoundingClientRect().top, in the same canvas-local CSS-pixel
// coordinate system every other _layout()/anchor value here uses).
// Exported so toric2.js/surface2.js can anchor their OWN description
// cards' *top* to this exact value instead of their own (much shorter)
// box's bottom edge, so all three cards start at the same height
// regardless of how tall each decoder's own lattice happens to be. This
// module's own getDescriptionAnchor() below does NOT use this constant --
// repetition2 keeps anchoring its card's bottom to its own history box, as
// before. Must be re-measured (and this constant updated) if the
// repetition2 description text or its layout ever changes enough to move
// where its card naturally lands.
export const DESCRIPTION_TOP_CSS = 201;

// radiusFactor/outlineFactor default to the legend swatch's own size
// (unchanged); the live/history defect orbs pass DEFECT_ORB_RADIUS/
// DEFECT_ORB_OUTLINE explicitly (anim/repcode_sync.py's ORB_RADIUS: three
// successive 10% shrinks of the original 0.42, i.e. 0.42 * 0.9^3).
export function drawOrb(ctx, cx, cy, s, radiusFactor = 0.42, outlineFactor = 0.06) {
    const r = radiusFactor * s;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, COLOR_ORB_RIM);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.lineWidth = Math.max(1, outlineFactor * s);
    ctx.strokeStyle = '#000000';
    ctx.stroke();
}

export const DEFECT_ORB_RADIUS = 0.30618; // ORB_RADIUS in anim/repcode_sync.py
export const DEFECT_ORB_OUTLINE = 0.06 * 0.81; // outline scaled by 0.9*0.9 = 0.81

// Literal port of anim/repcode_sync.py's error_strings(): the
// (leftDefect, rightDefect) site-index pairs bounding each maximal cyclic
// run of errored qubits. For a run of errored qubits x=a..b (qubits(a-1)
// and qubits(b+1) both false), s(x) = qub(x) xor qub(x+1) puts the run's
// two domain-wall defects at (a-1) mod L and b. Runs are found on the
// periodic lattice, so a run spanning the L-1/0 seam (including one that
// simply starts at qubit 0, whose left defect is then L-1) is reported
// correctly as one run. Returns [] if every qubit is errored, since s is
// then all-zero -- there are no defects to bound anything.
export function errorStrings(qubits, L) {
    if (qubits.every(Boolean)) return [];
    const starts = [];
    for (let x = 0; x < L; x++) {
        if (qubits[x] && !qubits[(x - 1 + L) % L]) starts.push(x);
    }
    const pairs = [];
    for (const a of starts) {
        let b = a;
        while (qubits[(b + 1) % L]) b = (b + 1) % L;
        pairs.push([(a - 1 + L) % L, b]);
    }
    return pairs;
}

// Draw one error string from the centre of its left defect cell to the
// centre of its right defect cell; a run whose left defect index exceeds
// its right (it wraps the periodic boundary, including the case where the
// run starts at qubit 0 and so its left defect sits at L-1) is drawn as
// two segments reaching the row's left and right edges instead.
export function drawErrorString(ctx, leftDefect, rightDefect, rowLeft, rowWidth, cell, midY) {
    const cxLeft = rowLeft + leftDefect * cell + cell / 2;
    const cxRight = rowLeft + rightDefect * cell + cell / 2;
    if (leftDefect <= rightDefect) {
        ctx.beginPath();
        ctx.moveTo(cxLeft, midY);
        ctx.lineTo(cxRight, midY);
        ctx.stroke();
    } else {
        ctx.beginPath();
        ctx.moveTo(cxLeft, midY);
        ctx.lineTo(rowLeft + rowWidth, midY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(rowLeft, midY);
        ctx.lineTo(cxRight, midY);
        ctx.stroke();
    }
}

export function snapPixel(px, width) {
    // Keep 1px (odd-width) strokes crisp by centring them on a half pixel;
    // even widths just round to the nearest integer boundary.
    return (width % 2 === 1) ? Math.floor(px) + 0.5 : Math.round(px);
}

// Some serif font stacks have no meaningfully bolder glyph for the Unicode
// arrow characters even at font-weight bold (letters embolden, arrows
// often don't), so the letters stay a plain bold fillText but the arrows
// additionally get a thin same-colour outline -- a font-independent way to
// thicken a glyph regardless of whether the active font's "bold" face
// actually has a heavier arrow. Respects the caller's current textAlign/
// textBaseline/fillStyle (strokeText honours the same alignment as fillText).
export function fillBoldGlyph(ctx, text, x, y, strokeWidth = 0.9) {
    ctx.fillText(text, x, y);
    const prevStroke = ctx.strokeStyle;
    const prevWidth = ctx.lineWidth;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = strokeWidth;
    ctx.strokeText(text, x, y);
    ctx.strokeStyle = prevStroke;
    ctx.lineWidth = prevWidth;
}

// Universal ink-edge <-> anchor conversions. Per the Canvas 2D spec,
// TextMetrics.actualBoundingBoxLeft/Right are always defined relative to
// wherever the CURRENT textAlign places the anchor point (positive = that
// far in that direction from the anchor), so these hold for any textAlign
// as long as `m` was measured with that same textAlign active:
//   inkLeftEdge  = anchorX - m.actualBoundingBoxLeft
//   inkRightEdge = anchorX + m.actualBoundingBoxRight
// and solving each for anchorX gives the two functions below -- used
// throughout render() to place glyphs by their ink edges instead of by
// trial-and-error offsets from the alignment anchor.
export function anchorForLeftEdge(targetLeftEdge, m) {
    return targetLeftEdge + m.actualBoundingBoxLeft;
}
export function anchorForRightEdge(targetRightEdge, m) {
    return targetRightEdge - m.actualBoundingBoxRight;
}
export function inkRightEdge(anchorX, m) {
    return anchorX + m.actualBoundingBoxRight;
}
// TASK 4ey: same family as the two above -- inkCenterX = anchorX +
// (actualBoundingBoxRight - actualBoundingBoxLeft) / 2 (the ink's own
// midpoint, not the alignment anchor itself, since actualBoundingBoxLeft
// and actualBoundingBoxRight need not be equal for an asymmetric glyph
// run), solved for anchorX.
export function anchorForCenteredInk(targetCenterX, m) {
    return targetCenterX - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
}

// Shared gutter captions for both repetition tabs. Always fit and position
// the column using "spacetime", even when the visible block has other words.
// The default lines retain repetition2's original measurements and anchors.
export function drawGutterCaptions(ctx, {
    tInkRight, boxTop, systemMidY,
    blockLines = ['spacetime', 'history'], decoderMidY,
}) {
    const boxLabelRightEdge = tInkRight - CAPTION_SHIFT_LEFT;
    const boxLabelAvailableWidth = boxLabelRightEdge - CAPTION_EDGE_MARGIN;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const monoFontFamily = getMonoFontFamily();
    ctx.fillStyle = getMutedTextColor();
    const captionFullSize = CAPTION_SCALE * TLABEL_FONT_SIZE;
    ctx.font = `${captionFullSize}px ${monoFontFamily}`;
    const spacetimeMetricsMonoFull = ctx.measureText('spacetime');
    const spacetimeInkWidthMonoFull = spacetimeMetricsMonoFull.actualBoundingBoxLeft + spacetimeMetricsMonoFull.actualBoundingBoxRight;
    const boxLabelFontSize = spacetimeInkWidthMonoFull > boxLabelAvailableWidth
        ? captionFullSize * (boxLabelAvailableWidth / spacetimeInkWidthMonoFull)
        : captionFullSize;

    ctx.font = `${boxLabelFontSize}px ${monoFontFamily}`;
    const spacetimeMetrics = ctx.measureText('spacetime');
    const blockCenterX = boxLabelRightEdge
        - (spacetimeMetrics.actualBoundingBoxLeft + spacetimeMetrics.actualBoundingBoxRight) / 2;
    const m1 = blockLines[0] === 'spacetime' ? spacetimeMetrics : ctx.measureText(blockLines[0]);
    const baselineY1 = (boxTop + CAPTION_BLOCK_TOP_OFFSET) + m1.actualBoundingBoxAscent;
    const lineHeight = m1.fontBoundingBoxAscent + m1.fontBoundingBoxDescent;
    const baselineY2 = baselineY1 + lineHeight;
    const m2 = ctx.measureText(blockLines[1]);
    ctx.fillText(blockLines[0], blockLines[0] === 'spacetime'
        ? anchorForRightEdge(boxLabelRightEdge, m1)
        : anchorForCenteredInk(blockCenterX, m1), baselineY1);
    ctx.fillText(blockLines[1], anchorForCenteredInk(blockCenterX, m2), baselineY2);

    ctx.textBaseline = 'middle';
    if (Number.isFinite(decoderMidY)) {
        const decoderMetrics = ctx.measureText('decoder');
        // "middle" centres the font's em box; centre this word's actual ink
        // on the stack, since it has no descenders like "system" does.
        const decoderBaselineY = decoderMidY
            + (decoderMetrics.actualBoundingBoxAscent - decoderMetrics.actualBoundingBoxDescent) / 2;
        ctx.fillText('decoder', anchorForCenteredInk(blockCenterX, decoderMetrics), decoderBaselineY);
    }
    const systemMetrics = ctx.measureText('system');
    ctx.fillText('system', anchorForCenteredInk(blockCenterX, systemMetrics), systemMidY);
    ctx.textBaseline = 'alphabetic';
}

// Shared grid renderer for both the scrolling history box and the live
// site row: `messageAt(row, col)` (row 0 = topmost displayed row) decides
// cell fills and, for every cell boundary, whether that boundary is
// "blue" (a message cell touches it) or "grey" (it doesn't) -- drawn as
// two full passes (grey, then blue) so blue always wins at a corner where
// a message block's edge meets a plain grid line, exactly as in the
// Python renderer's analytic build_history_image.
export function drawCaGridLines(ctx, { left, top, cell, cols, rows, messageAt, showGrid, showMessages }) {
    // TASK 4aa: message-cell (blue) boundary lines share ONE stroke width
    // with the plain grey grid lines -- previously blue (Math.max(2,
    // Math.round(cell/9))) was visibly thicker than grey (Math.max(1,
    // Math.round(cell/18))); now both passes below use this single value,
    // so a message cell's edge reads as the same grid line, just recoloured.
    const width = Math.max(1, Math.round(cell / 18));

    if (showMessages) {
        ctx.fillStyle = COLOR_MSG_FILL;
        for (let i = 0; i < rows; i++) {
            for (let c = 0; c < cols; c++) {
                if (messageAt(i, c)) {
                    ctx.fillRect(left + c * cell, top + i * cell, cell, cell);
                }
            }
        }
    }

    // Square (projecting) caps, matching matplotlib's default line cap used
    // by the Python renderer's analytic boundary lines: this closes the w/2
    // notch at a message block's corners (grey drawn first, blue drawn on
    // top so it wins there) without any visible doubling, since two opaque
    // strokes overlapping by w/2 along a shared run are indistinguishable
    // from one. Reset to the canvas default afterward so nothing else in
    // this module's render() is affected.
    ctx.lineCap = 'square';

    const drawVertical = (width, color, wantBlue) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (let x = 0; x <= cols; x++) {
            for (let i = 0; i < rows; i++) {
                const leftM = x > 0 ? messageAt(i, x - 1) : false;
                const rightM = x < cols ? messageAt(i, x) : false;
                const isBlue = showMessages && (leftM || rightM);
                if (isBlue !== wantBlue) continue;
                const xPix = snapPixel(left + x * cell, width);
                ctx.beginPath();
                ctx.moveTo(xPix, top + i * cell);
                ctx.lineTo(xPix, top + (i + 1) * cell);
                ctx.stroke();
            }
        }
    };
    // Each cell's OWN span only (left + c*cell to left + (c+1)*cell) -- a
    // previous version stroked the whole row width (left to
    // left + cols*cell) for every matching cell, so a single message cell
    // anywhere in a row turned that row's entire top/bottom boundary blue.
    const drawHorizontal = (width, color, wantBlue) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (let i = 0; i <= rows; i++) {
            for (let c = 0; c < cols; c++) {
                const aboveM = i > 0 ? messageAt(i - 1, c) : false;
                const belowM = i < rows ? messageAt(i, c) : false;
                const isBlue = showMessages && (aboveM || belowM);
                if (isBlue !== wantBlue) continue;
                const yPix = snapPixel(top + i * cell, width);
                ctx.beginPath();
                ctx.moveTo(left + c * cell, yPix);
                ctx.lineTo(left + (c + 1) * cell, yPix);
                ctx.stroke();
            }
        }
    };

    if (showGrid) {
        drawVertical(width, COLOR_GRID, false);
        drawHorizontal(width, COLOR_GRID, false);
    }
    // TASK 4bd: the blue message-edge pass used to run whenever
    // showMessages was on, regardless of showGrid -- so turning "grid"
    // off only hid the plain grey lines, leaving message cells still
    // outlined in blue. Gated on showGrid too now, so with grid off a
    // message cell is a plain fill with no boundary line at all (the
    // fill pass above, and the black box/site-row outlines drawn
    // separately in render(), are unaffected either way).
    if (showMessages && showGrid) {
        drawVertical(width, COLOR_MSG_EDGE, true);
        drawHorizontal(width, COLOR_MSG_EDGE, true);
    }

    ctx.lineCap = 'butt'; // restore the canvas default
}

export function drawCaDefects(ctx, { left, top, cell, cols, rows, defectAt }) {
    for (let i = 0; i < rows; i++) {
        for (let c = 0; c < cols; c++) {
            if (defectAt(i, c)) {
                drawOrb(ctx, left + c * cell + cell / 2, top + i * cell + cell / 2, cell,
                    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
            }
        }
    }
}

export class RepetitionCode2Decoder {
    // TASK 4ek: opts.descriptionPlacement is a config-level trial flag
    // (decoderConfigs['repetition2'].descriptionPlacement in main.js, NOT
    // a user-tweakable extraParam) -- 'right' moves the on-canvas graphic
    // left to make room for the description card in the right-hand
    // overlay stack instead of its own default, left-hand placement; see
    // _layout()'s own comment for the geometry and getDescriptionAnchor()/
    // getTitleAnchor() for the two duck-typed hooks this also affects.
    // undefined (every other caller, including every existing Node
    // harness call with no third argument at all) keeps today's layout
    // exactly, by construction (see _layout()).
    constructor(L, clockPeriod = 2, opts = {}) {
        this.L = L;
        this.clockPeriod = (Number.isFinite(clockPeriod) && clockPeriod >= 1)
            ? Math.round(clockPeriod)
            : 2;
        this.descriptionPlacement = opts.descriptionPlacement;
        this.stepCount = 0;

        // qubits[x] = current qubit value (err0 xor e); err0 never changes
        // after init, so tracking only the xor is exact and sufficient.
        this.qubits = new Array(L).fill(false);
        this.mGrid = new Array(L).fill(false);   // messages m(x)
        this.clockGrid = new Array(L).fill(0);   // per-site clock c(x)
        this.syndrome = new Array(L).fill(false); // derived: s(x) = qub(x) xor qub(x+1)

        this.history = []; // [{s: Uint8Array, m: Uint8Array}, ...] indexed by time t, FULL history, never truncated
        // TASK 4l: scroll view into that full history. _viewOffset counts
        // rows back from the newest (0 = following the newest row); it is
        // reset to 0 by _pushHistory() itself (so every step -- manual or
        // played -- re-follows the newest row) and clamped for the
        // *current* N (rows visible in the box, which depends on canvas
        // size) at render() time, since N is not known here. _lastN caches
        // the most recently rendered N so scrollHistory() -- called from
        // main.js between renders -- has a clamp to work with immediately.
        this._viewOffset = 0;
        this._lastN = 1;
        // TASK 4ar: pointer-drag gesture state (see pointerDown() below).
        // null whenever no gesture is in progress.
        this._pointerMode = null;      // null | 'paint' | 'defect'
        this._lastPaintIndex = null;   // last qubit boundary toggled by the current paint drag
        // TASK 4cd: the value this paint stroke sets every qubit to (decided
        // once at pointerDown, from that qubit's own state) -- painting SETS
        // to this value rather than toggling, so retracing already-painted
        // qubits within one stroke is a no-op instead of undoing them.
        this._paintValue = null;
        this._dragDefectIndex = null;  // current site index of the defect being dragged
        // TASK 4cd: stack of site indices visited by the current defect drag
        // (path[0] is where the defect started, before any flips). Lets
        // pointerMove() detect "the pointer has returned to where it just
        // came from" and pop (undo) rather than always recomputing a fresh
        // shortest arc, which can pick the *other* way around at/near a
        // ring's antipodal point and fail to retrace exactly.
        this._dragDefectPath = null;
        this._computeSyndrome();
        this._pushHistory();
    }

    // For the stats panel (matches the other decoders' `clock` field).
    get clock() {
        return this.clockGrid[0];
    }

    _computeSyndrome() {
        const L = this.L;
        for (let x = 0; x < L; x++) {
            this.syndrome[x] = this.qubits[x] !== this.qubits[(x + 1) % L];
        }
    }

    _pushHistory() {
        const L = this.L;
        const s = new Uint8Array(L);
        const m = new Uint8Array(L);
        for (let x = 0; x < L; x++) {
            s[x] = this.syndrome[x] ? 1 : 0;
            m[x] = this.mGrid[x] ? 1 : 0;
        }
        this.history.push({ s, m });
        this._viewOffset = 0; // every new row (manual step, played step, or a reset) re-follows the newest row
    }

    // TASK 4l: scroll the view by `deltaRows` whole rows (positive = back
    // toward older rows, i.e. down the box; negative = toward the newest).
    // Clamped to [0, total - _lastN] -- _lastN is last render()'s N, kept
    // current enough for a wheel handler firing between renders; render()
    // itself re-clamps against the *actual* current N regardless, so an
    // out-of-date _lastN (e.g. right after a canvas resize) never shows an
    // invalid window, just possibly one wheel tick of slightly stale range.
    scrollHistory(deltaRows) {
        const total = this.history.length;
        const maxOffset = Math.max(0, total - this._lastN);
        this._viewOffset = Math.max(0, Math.min(maxOffset, this._viewOffset + Math.round(deltaRows)));
    }

    _resetHistory() {
        this.history = [];
        this._pushHistory();
    }

    initializeRandomErrors(p, rng = Math.random) {
        for (let x = 0; x < this.L; x++) {
            this.qubits[x] = rng() < p;
            this.mGrid[x] = false;
            this.clockGrid[x] = 0;
        }
        this.stepCount = 0;
        this._computeSyndrome();
        this._resetHistory();
    }

    // Literal port of repca.reference.step_sync (Algorithm 1), applied to
    // the whole lattice at once: every quantity on the right-hand side is
    // read from the snapshot at time t, never from a value already updated
    // this step.
    step() {
        this._computeSyndrome(); // s(x,t) is always recomputed fresh from qub, never cached
        const L = this.L;
        const q = this.clockPeriod;
        const sT = this.syndrome.slice();
        const mT = this.mGrid.slice();
        const cT = this.clockGrid.slice();

        const mNext = new Array(L).fill(false);
        const cNext = new Array(L);
        const sInc = new Set();

        for (let x = 0; x < L; x++) {
            const xLeft = (x - 1 + L) % L;
            mNext[x] = false;

            if (sT[x]) {
                // Part 1: defect dynamics.
                mNext[x] = true;
                if (mT[xLeft]) {
                    // Flipping qub(x) is exactly Algorithm 1's e(x) <- e(x) xor 1;
                    // this is what moves the defect from x to x-1.
                    this.qubits[x] = !this.qubits[x];
                    sInc.add(xLeft);
                }
            } else {
                // Part 2: message dynamics.
                if (!mT[x] && cT[x] === 0 && mT[xLeft]) {
                    mNext[x] = true; // growth
                } else if (mT[x]) {
                    mNext[x] = mT[xLeft]; // persistence / erasure
                }
            }

            cNext[x] = (cT[x] + 1) % q;
        }

        // Part 3: defect arrival.
        for (const xPrime of sInc) {
            mNext[xPrime] = true;
        }

        this.mGrid = mNext;
        this.clockGrid = cNext;
        this.stepCount++;
        this._computeSyndrome();
        this._pushHistory();
    }

    // Literal port of repca.reference.step_async (Algorithm 1) evaluated at
    // one selected site; only that site's clock advances.
    stepUncoord(site) {
        this._computeSyndrome();
        const L = this.L;
        const q = this.clockPeriod;
        const x = (site === undefined || site === null)
            ? Math.floor(Math.random() * L)
            : (((Math.trunc(site) % L) + L) % L);
        const xLeft = (x - 1 + L) % L;

        const sX = this.syndrome[x];
        const mXLeft = this.mGrid[xLeft];
        const mX = this.mGrid[x];
        const cX = this.clockGrid[x];

        let mNextX = false;
        let arrivalAtLeft = false;

        if (sX) {
            mNextX = true;
            if (mXLeft) {
                this.qubits[x] = !this.qubits[x];
                arrivalAtLeft = true;
            }
        } else {
            if (!mX && cX === 0 && mXLeft) {
                mNextX = true;
            } else if (mX) {
                mNextX = mXLeft;
            }
        }

        this.mGrid[x] = mNextX;
        this.clockGrid[x] = (cX + 1) % q;
        if (arrivalAtLeft) {
            this.mGrid[xLeft] = true;
        }

        this.stepCount++;
        this._computeSyndrome();
        this._pushHistory();
    }

    getSyndromeCount() {
        let count = 0;
        for (let x = 0; x < this.L; x++) if (this.syndrome[x]) count++;
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let x = 0; x < this.L; x++) if (this.qubits[x]) count++;
        return count;
    }

    hasMessages() {
        return this.mGrid.some(m => m);
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        const converged = this.syndrome.every(s => !s);
        const hasError = !!(converged && this.qubits[0]);
        const result = { hasError, horizontal: hasError, vertical: false };
        // TASK 4af: kept short so it sits on one line next to the "logical
        // error" label in the stats panel (was the much longer 'converged
        // to the all-ones codeword', which wrapped into the label column).
        // Even the shorter 'all-ones codeword' measured 122px against a
        // 99px-wide value column in the actual sidebar -- still overflowed
        // -- so this drops "codeword" too; "all-ones" alone is unambiguous
        // next to the "logical error" label for this decoder.
        if (hasError) result.description = 'all-ones';
        return result;
    }

    // Pure geometry (no ctx) -- callable directly from Node for a layout
    // trace, and shared by render() and toggleErrorAtPosition() so they can
    // never disagree about where things are. The exact ink-level placement
    // of the "t"/"x" labels and the legend (which needs real font metrics)
    // is done in render() itself, using AXIS_LABEL_CLEARANCE etc.; the
    // values returned here are the geometry those glyphs are placed
    // relative to (box/grid/site-row edges), plus generous nominal budgets
    // (xLabelH, labelGutter) sized to comfortably contain that ink-level
    // placement without needing real font metrics up front.
    //
    // The "t" label sits in the reserved strip left of the box; its font is
    // fixed-size (TLABEL_FONT_SIZE, independent of cell size), so the strip
    // needs a fixed glyph-width component (TLABEL_GLYPH_W) plus a gutter
    // that must separate the label from the box. TASK 4ah: that gutter is
    // now AXIS_LABEL_CLEARANCE itself (the same constant render() uses for
    // the real ink-level gap) plus a small residual cell-proportional
    // cushion (0.2 * cell) for glyph-width-estimate slop only -- previously
    // the whole gutter was 0.8 * cell, a proportional stand-in for the
    // clearance that would have silently shrunk the reserved room (and so
    // the achievable cell size) every time the clearance constant grew.
    // Pulling the clearance out as a fixed term means raising it comes out
    // of the margins, not the cell-size solve, for any reasonably-sized L.
    // Both terms are folded into the cell-size solve itself (not just into
    // where the box sits) so a small canvas never lets the label and box
    // overlap:
    //   cell*L + TLABEL_GLYPH_W + AXIS_LABEL_CLEARANCE + 0.2*cell <= canvasWidth - 120
    //   cell <= (canvasWidth - 120 - TLABEL_GLYPH_W - AXIS_LABEL_CLEARANCE) / (L + 0.2)
    // TASK 4ek: overlayRects (canvas CSS-relative rects for the three
    // overlay cards, computed once per render() by main.js's
    // computeOverlayRects() and threaded through render()'s own options
    // and getTitleAnchor() below, the same convention surface_streaming_3d.js
    // already established) is optional, and only ever changes anything
    // when this.descriptionPlacement === 'right' (set at construction from
    // config.descriptionPlacement in main.js -- see the constructor's own
    // comment) -- every other decoder, and this one with the flag unset or
    // called with no overlayRects at all (every existing Node harness call,
    // and this module's own pointer/click methods below, none of which
    // pass a third argument), gets today's layout exactly, unchanged.
    // Cached on `this` as a side effect specifically so those pointer/click
    // methods -- which only ever call _layout(canvasWidth, canvasHeight)
    // with two arguments, matching every call site that predates this
    // task -- still see the *current* shifted geometry for hit-testing a
    // real click against the *drawn* (shifted) box, without needing their
    // own signatures (or main.js's handleCanvasClick/PointerDown/Move)
    // touched at all: render() and getTitleAnchor() below are always
    // called well before any click could land on what they just drew, so
    // the cache is never more than one render "behind", which is to say
    // never behind at all in practice (nothing here changes mid-gesture).
    _layout(canvasWidth, canvasHeight, overlayRects) {
        if (overlayRects !== undefined) this._lastOverlayRects = overlayRects;
        const effectiveOverlayRects = overlayRects !== undefined ? overlayRects : this._lastOverlayRects;

        const L = this.L;
        // TASK 4em fix: cardsLeft/freeRight (needed below for centering)
        // is computed one step earlier, because cell itself now needs it
        // too. Before this fix, cell always used a flat "canvasWidth -
        // 120" guess regardless of descriptionPlacement -- a reasonable
        // stand-in for the default (non-'right') cards' own rough width,
        // but for the 'right' variant TASK 4em's own change (capping
        // .visualization-container's width) moved those cards' real left
        // edge (cardsLeft) closer to the canvas than that flat guess
        // assumed, so boxWidth (cell * L) came out wider than the
        // freeWidth computed below and the box's own right edge drew a
        // couple of px into the cards. Sizing cell against the SAME
        // cardsLeft - 8 boundary the centering math below already uses
        // keeps the two consistent by construction: with cell derived
        // from floor(min(28, (bound - labelReserve-ish)/(L+0.2))), boxWidth
        // = cell*L is algebraically guaranteed <= freeWidth = freeRight -
        // labelReserve whenever cellRightBound === freeRight (floor/min
        // only ever round cell down, never up). The default branch's
        // "-120" guess is untouched.
        // TASK 4ep-b: freeRight (below) stays bounded by the cards' real,
        // live left edge exactly as TASK 4em first set up -- unchanged,
        // and only still relevant to boxLeftCentered further down (a
        // value the 'right' branch itself no longer uses for its own
        // boxLeft, see TASK 4eq's own comment below, but which the
        // default branch and this method's own diagnostic return value
        // still do).
        // TASK 4ep-c: the cell-size solve's own bound (cellRightBound)
        // is NOT the same as freeRight any more -- see EXTRA_RIGHT_GAP's
        // own comment for why cell must NOT grow into the room TASK 4ep's
        // panel-widening opened up, unlike freeRight/boxLeftCentered.
        // TASK 4er: cardsLeft is the MINIMUM of all three cards' own left
        // edges, not just .info-panel's -- until this task .overlay-stack
        // used align-items:flex-start, so every card shared one left edge
        // and reading any single one of them (.info-panel's, chosen
        // arbitrarily back in TASK 4em) was equivalent to reading the
        // true leftmost edge. TASK 4er switches that stack to flex-end,
        // right-aligning all three cards instead -- the widest one
        // (.description-panel, 180px) now extends furthest left, with
        // .info-panel/.legend (their own narrower ~136px, right-aligned
        // to the SAME edge) falling short of it. Using just .info-panel's
        // own left edge here would have let the box drift right into
        // the room .description-panel's own true (further-left) edge
        // still leaves clear, silently breaking this task's own
        // "box's gaps unchanged" requirement -- caught by testing this
        // switch live before relying on it, not just by inspection.
        const cardsLeft = (() => {
            const edges = [
                effectiveOverlayRects?.infoPanel?.left,
                effectiveOverlayRects?.legend?.left,
                effectiveOverlayRects?.descriptionPanel?.left,
            ].filter(Number.isFinite);
            return edges.length > 0 ? Math.min(...edges) : undefined;
        })();
        // TASK 4eq's own canvasOffsetInPanel (the canvas's own left edge,
        // in px, measured from the panel's own left border -- see that
        // task's own comment at boxLeft below) is needed here too, one
        // step earlier, purely because haveRightPlacementGeometry (used by
        // both cellRightBound and boxLeft) folds it in.
        const canvasOffsetInPanel = Number.isFinite(effectiveOverlayRects?.panel?.left)
            ? -effectiveOverlayRects.panel.left
            : undefined;
        const haveRightPlacementGeometry = this.descriptionPlacement === 'right'
            && Number.isFinite(cardsLeft) && Number.isFinite(canvasOffsetInPanel);
        const freeRight = haveRightPlacementGeometry ? cardsLeft - 8 : canvasWidth;
        // TASK 4es-b: cellRightBound is solved panel-relative (cardsLeft +
        // canvasOffsetInPanel is the cards' left edge measured from the
        // panel's own left border, a stable quantity independent of the
        // canvas's own width), then read directly as a canvas-relative
        // bound WITHOUT converting back via "- canvasOffsetInPanel" --
        // that back-conversion looks natural (freeRight itself is
        // canvas-relative) but silently cancels the whole point of doing
        // this panel-relative in the first place, reproducing the exact
        // pre-4es-b numbers again once canvasOffsetInPanel changes (caught
        // only by testing live, not by re-checking the algebra on paper --
        // see EXTRA_RIGHT_GAP's own comment for the calibration this
        // depends on).
        const cellRightBound = haveRightPlacementGeometry
            ? (cardsLeft + canvasOffsetInPanel - 8 - EXTRA_RIGHT_GAP)
            : canvasWidth - 120;
        const cell = Math.max(1, Math.floor(Math.min(28, (cellRightBound - TLABEL_GLYPH_W - AXIS_LABEL_CLEARANCE) / (L + 0.2))));

        // Nominal clear space between the "t" label and the box -- see the
        // derivation above.
        const labelGutter = AXIS_LABEL_CLEARANCE + 0.2 * cell;
        const labelReserve = TLABEL_GLYPH_W + labelGutter;
        const boxWidth = cell * L;
        // TASK 4ek: the panel (label + box) is centred within [0,
        // canvasWidth] by default (freeRight = canvasWidth), exactly as
        // before -- but with descriptionPlacement === 'right' and the
        // state/legend cards' own real left edge known (they've moved to
        // share the description card's own width and right inset, see
        // main.js), it instead centres within [labelReserve, cards' own
        // left edge - 8], i.e. the graphic's own free width once the
        // cards' new left edge is treated as the canvas's own right edge
        // for this purpose. Reduces to the unshifted formula exactly when
        // freeRight = canvasWidth (worked through algebraically: boxLeft
        // below then simplifies to the original panelLeft + labelReserve),
        // so this single formula covers both cases without a separate
        // branch for each.
        const freeWidth = freeRight - labelReserve;
        const boxLeftCentered = labelReserve + (freeWidth - boxWidth) / 2;
        // TASK 4eq: the 'right'-placement branch centres the box+strip
        // between the PANEL's own left border and the cards' left edge --
        // equal whitespace on both sides -- rather than TASK 4ep-b's fixed
        // offset (BOX_LEFT_CSS) or any canvas-relative centring. Since
        // this module's own coordinates are canvas-local but the
        // invariant is panel-relative (TASK 4ep-b's own correction),
        // canvasOffsetInPanel (the canvas's own left edge, in px, measured
        // from the panel's left border) converts between the two: it's
        // read from overlayRects.panel (added to computeOverlayRects() in
        // main.js for this task) rather than hard-coded, since it isn't
        // fixed in general (e.g. it already differs below the panel's own
        // width cap, TASK 4em). overlayRects.panel.left is
        // .visualization-container's own left edge minus the canvas's, so
        // it's <= 0 by construction; negating it gives the canvas's own
        // offset from the panel as a positive px value.
        //
        // Derivation: let g1 = panel-left-border-to-boxLeft (panel-
        // relative) = canvasOffsetInPanel + boxLeft, and g2 =
        // boxRight-to-cardsLeft (panel-relative) = (canvasOffsetInPanel +
        // cardsLeft) - (canvasOffsetInPanel + boxLeft + boxWidth) =
        // cardsLeft - boxLeft - boxWidth (the offsets cancel, since both
        // ends are canvas-relative-plus-the-same-offset). Setting g1 = g2
        // and solving for boxLeft gives (cardsLeft - boxWidth -
        // canvasOffsetInPanel) / 2, algebraically identical to the
        // (cardsLeft + canvasOffsetInPanel - boxWidth) / 2 -
        // canvasOffsetInPanel form used below. Falls back to
        // boxLeftCentered (as if this task didn't exist) whenever the live
        // panel rect isn't available, matching every other cards-aware
        // formula in this branch; every non-'right' use of this file
        // (every Node harness call, and this module's own pointer/click
        // methods) is unaffected either way, since they never take this
        // branch at all. canvasOffsetInPanel itself is computed earlier
        // now (TASK 4es-b), alongside cardsLeft, since the cell-size
        // solve above needs it too.
        const boxLeft = haveRightPlacementGeometry
            ? (cardsLeft + canvasOffsetInPanel - boxWidth) / 2 - canvasOffsetInPanel
            : boxLeftCentered;
        const panelLeft = boxLeft - labelReserve;
        const panelWidth = boxWidth + labelReserve; // unchanged formula; kept in the return value below even though nothing in this file reads it back, in case anything outside it does

        // TASK 4ap delta: the "t = N" caption that used to sit above the box
        // is gone (the step count is already shown in the stats box), so
        // topGap is simply the box's own top margin. TASK 4cc: dropped
        // from 8 to 2 so the box's own top line sits close under the
        // decoder title above the canvas (paired with .overlay-stack's own
        // `top` in styles.css, moved to the same target -- not a
        // canvas-area margin, which would also drag this box itself).
        // TASK 4cf: raised back up a little, 2 to 8, moving the box down
        // 6px in lockstep with .overlay-stack's own +6px, so both keep
        // landing at the same height under the title. TASK 4cg: another
        // +3px (8 to 11), again in lockstep with .overlay-stack's own top.
        // TASK 4cl: another +2px (11 to 13), again in lockstep.
        const topGap = 13;
        const histGap = 14;     // gap between box and site row
        const siteRowH = cell;  // site row is one cell tall
        // TASK 4ah: references AXIS_LABEL_CLEARANCE directly (was a
        // separately-hardcoded literal 6, only coincidentally equal to it)
        // so this and labelGutter above stay equal by construction.
        const xLabelGap = AXIS_LABEL_CLEARANCE;
        // Nominal budget for the "x" line: one line of text plus its
        // AXIS_LABEL_CLEARANCE from the site row above it; the real
        // baseline render() computes from ink metrics always fits inside
        // this (it's already a generous over-estimate of ascent+descent).
        const xLabelH = Math.ceil(TLABEL_FONT_SIZE * 1.2);
        // TASK 4bf: legendGap/legendH are gone along with the on-canvas
        // legend itself (moved to an HTML overlay card in main.js) --
        // bottomMargin now sits directly below the "x" label instead of
        // below the legend, and the freed vertical room is given back to
        // the layout budget below (rawBoxHeight grows, so the box moves
        // up and/or the cells can grow), same pattern as the TASK 4ap
        // delta's "t = N" caption removal above.
        const bottomMargin = 14;

        const fixedH = topGap + histGap + siteRowH + xLabelGap + xLabelH + bottomMargin;
        const rawBoxHeight = Math.max(cell, canvasHeight - fixedH);
        const N = Math.max(1, Math.floor(rawBoxHeight / cell));
        // TASK 4g: the box must hug the grid exactly -- no partial row.
        // boxHeight is forced to N*cell; any leftover from the raw budget
        // used to go above the box (increasing the top margin) -- TASK
        // 4cc reverses that: the box should sit at the top of the canvas,
        // so the leftover is simply left unused as blank canvas space
        // below everything else instead (nothing needs to explicitly
        // consume it: xLabelTop+xLabelH already lands wherever it lands,
        // and whatever canvasHeight leaves over below that was already
        // unused space by construction -- the *only* change needed is not
        // adding this leftover to boxTop any more).
        const boxHeight = N * cell;

        const boxTop = topGap;
        const boxBottom = boxTop + boxHeight;
        const gridTop = boxTop; // box top line === first grid line, exactly
        const siteRowTop = boxBottom + histGap;
        const siteRowBottom = siteRowTop + siteRowH;
        const xLabelTop = siteRowBottom + xLabelGap;
        const tLabelMidY = boxTop + boxHeight / 2;

        return {
            L, cell, panelLeft, panelWidth, labelReserve, labelGutter,
            tLabelFontSize: TLABEL_FONT_SIZE, xLabelFontSize: TLABEL_FONT_SIZE, tLabelMidY,
            boxLeft, boxWidth, boxTop, boxHeight, boxBottom, gridTop, N,
            topGap,
            siteRowTop, siteRowBottom, siteRowLeft: boxLeft, siteRowH,
            xLabelTop, xLabelH,
            // Exposed for verification/reporting, not read elsewhere in
            // this file -- what boxLeft would be under the default
            // (non-'right') centred formula, i.e. what it actually is
            // whenever descriptionPlacement !== 'right'.
            boxLeftCentered
        };
    }

    // TASK 4cq: lets main.js pin the HTML description card's own bottom
    // edge to a feature of the drawn graphic instead of a fixed CSS top --
    // so the card tracks the graphic as it resizes or the system size
    // changes. Returned in the same canvas-local CSS-pixel coordinate
    // system _layout() itself uses (i.e. relative to the canvas element's
    // own top edge, not the page). Duck-typed by main.js: any module can
    // opt in by providing this same method; one not providing it keeps the
    // old fixed top. TASK 4cu: which edge is read from DESCRIPTION_ANCHOR
    // above, so flipping between the two tried options is a one-word change.
    // TASK 4ek: returns null (rather than the usual { bottom }) when
    // descriptionPlacement === 'right' -- the card's own position then
    // comes entirely from its place in the right-hand overlay stack
    // (main.js moves the DOM node itself there), not from this anchor at
    // all. main.js's own updateDescriptionCardPosition() already treats a
    // null/falsy return as "clear any inline top and do nothing further"
    // (its existing behaviour for any module without this method), so
    // this needs no changes there -- returning null here is sufficient.
    getDescriptionAnchor(canvasWidth, canvasHeight) {
        if (this.descriptionPlacement === 'right') return null;
        const layout = this._layout(canvasWidth, canvasHeight);
        const bottom = DESCRIPTION_ANCHOR === 'box' ? layout.boxBottom : layout.siteRowBottom;
        return { bottom };
    }

    // TASK 4cw: lets main.js re-centre the decoder title (normally centred
    // on the whole right panel) on the spacetime history box's own outline
    // instead -- the box sits off-centre in the panel because the "t"
    // label's reserved gutter (labelReserve) only exists on its left side,
    // so panel-centre and box-centre are ~15px apart. Same canvas-local
    // CSS-pixel coordinate system _layout() itself uses. Duck-typed like
    // getDescriptionAnchor: a module without this method leaves the title
    // exactly where it already is (centred on the panel).
    // TASK 4ek: accepts the same overlayRects main.js's own
    // updateTitlePosition() already passes to every module's
    // getTitleAnchor(), so the title stays centred on the box's real,
    // possibly-shifted centre instead of the one _layout() would fall
    // back to computing without it.
    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        const layout = this._layout(canvasWidth, canvasHeight, overlayRects);
        return { centerX: layout.boxLeft + layout.boxWidth / 2 };
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;
        const showMessages = options.showMessages !== false;
        const showGrid = options.showGrid !== false;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const L = this.L;
        const layout = this._layout(canvasWidth, canvasHeight, options.overlayRects);
        const {
            cell, boxLeft, boxWidth, boxTop, boxHeight, gridTop, N,
            siteRowTop, siteRowBottom, siteRowLeft, siteRowH,
            tLabelFontSize, tLabelMidY, xLabelFontSize
        } = layout;

        // History rows in display order: index 0 = topmost row shown, N-1 = bottom.
        // TASK 4l: tBase follows _viewOffset (0 = newest row at the top,
        // matching the original always-follow behaviour exactly when
        // _viewOffset is 0) instead of being pinned to the newest N rows.
        // _lastN and the offset itself are (re-)clamped here against the
        // *current* N, since N depends on canvas size and can change
        // between scrollHistory() calls (made from main.js) and renders.
        const total = this.history.length;
        this._lastN = N;
        const maxOffset = Math.max(0, total - N);
        if (this._viewOffset > maxOffset) this._viewOffset = maxOffset;
        if (this._viewOffset < 0) this._viewOffset = 0;
        const viewEnd = total - 1 - this._viewOffset; // newest row index shown at the box's top
        const tBase = Math.max(0, viewEnd - N + 1);
        const rowsData = new Array(N);
        for (let i = 0; i < N; i++) {
            const r = N - 1 - i;
            const t = tBase + r;
            rowsData[i] = (t >= 0 && t < total) ? this.history[t] : null;
        }
        const histMessageAt = (i, c) => rowsData[i] ? !!rowsData[i].m[c] : false;
        const histDefectAt = (i, c) => rowsData[i] ? !!rowsData[i].s[c] : false;

        // TASK 4ap delta: the "t = N" caption that used to be drawn here is
        // gone -- the step count is already shown in the stats box.

        // Box contents, clipped to the box's own rectangle (TASK 4z) so the
        // wide blue message-boundary strokes -- and the grey grid lines,
        // fills, defect orbs -- can never bleed past the box's outer edge by
        // more than the outline stroke's own half-width. The outline itself
        // is drawn AFTER, on top of this clipped content, so it always
        // reads as a clean frame regardless of what's inside.
        ctx.save();
        ctx.beginPath();
        ctx.rect(boxLeft, boxTop, boxWidth, boxHeight);
        ctx.clip();
        drawCaGridLines(ctx, {
            left: boxLeft, top: gridTop, cell, cols: L, rows: N,
            messageAt: histMessageAt, showGrid, showMessages
        });
        if (showSyndrome) {
            drawCaDefects(ctx, { left: boxLeft, top: gridTop, cell, cols: L, rows: N, defectAt: histDefectAt });
        }
        ctx.restore();

        // Box border -- always drawn regardless of the grid display option,
        // and always on top of the clipped interior content above.
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3;
        ctx.strokeRect(boxLeft, boxTop, boxWidth, boxHeight);

        // "t" label to the left of the box, with its bold upward arrow
        // (TASK 4x: restored -- 4h's removal was based on a misreading of
        // the original request). Centred vertically on the box
        // (textBaseline='middle' at tLabelMidY) with its right ink edge
        // AXIS_LABEL_CLEARANCE + T_LABEL_EXTRA_CLEARANCE from the box's
        // left line -- measured from real font metrics so it holds
        // regardless of font/browser (TASK 4e(1); TASK 4cr added the extra
        // per-axis term, moving the whole label+arrow pair 2px further
        // left without touching the shared clearance _layout() budgets
        // against). The arrow above it is horizontally centred on "t"'s
        // own ink centre, with the vertical gap between the arrow's bottom
        // ink edge and "t"'s top ink edge equal to AXIS_ARROW_INK_GAP -- the
        // SAME named constant used below for "x"'s own rightward-arrow gap
        // (TASK 4e(2)/(3)'s original pairing, restored).
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `italic ${tLabelFontSize}px ${FONT_SERIF}`;
        const tMetrics = ctx.measureText('t');
        const tAnchorX = anchorForRightEdge(boxLeft - AXIS_LABEL_CLEARANCE - T_LABEL_EXTRA_CLEARANCE, tMetrics);
        ctx.fillText('t', tAnchorX, tLabelMidY);

        const tInkLeft = tAnchorX - tMetrics.actualBoundingBoxLeft;
        const tInkRight = boxLeft - AXIS_LABEL_CLEARANCE - T_LABEL_EXTRA_CLEARANCE; // by construction
        const tInkCenterX = (tInkLeft + tInkRight) / 2;
        const tInkTopY = tLabelMidY - tMetrics.actualBoundingBoxAscent;

        ctx.font = `bold ${tLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const tArrowMetrics = ctx.measureText('↑');
        const tArrowAnchorX = tInkCenterX - (tArrowMetrics.actualBoundingBoxRight - tArrowMetrics.actualBoundingBoxLeft) / 2;
        const tArrowBaselineY = tInkTopY - AXIS_ARROW_INK_GAP - tArrowMetrics.actualBoundingBoxDescent;
        fillBoldGlyph(ctx, '↑', tArrowAnchorX, tArrowBaselineY);
        ctx.textBaseline = 'alphabetic';

        drawGutterCaptions(ctx, {
            tInkRight, boxTop,
            systemMidY: (siteRowTop + siteRowBottom) / 2,
        });

        // Site row (current state) -- clipped to its own rectangle and
        // outlined the same way as the history box (TASK 4z): the outline
        // is now always drawn regardless of the grid display option
        // (previously the site row had no outline of its own, only the
        // incidental appearance of one from the grid lines' own border
        // segments, which vanished whenever "grid" was unchecked), and
        // interior content (fills, grid/message boundary lines, error
        // strings, defect orbs) is clipped so none of it can bleed past
        // that outline. The TASK 4l scroll-position indicator that used to
        // sit here (on the box's inside right edge) has been removed
        // entirely per the 4l delta -- the history stays scrollable by
        // mouse wheel, just with nothing drawn to indicate scroll position.
        ctx.save();
        ctx.beginPath();
        ctx.rect(siteRowLeft, siteRowTop, boxWidth, siteRowH);
        ctx.clip();
        const siteMessageAt = (_i, c) => !!this.mGrid[c];
        const siteDefectAt = (_i, c) => !!this.syndrome[c];
        drawCaGridLines(ctx, {
            left: siteRowLeft, top: siteRowTop, cell, cols: L, rows: 1,
            messageAt: siteMessageAt, showGrid, showMessages
        });
        if (showErrors) {
            const wBlue = Math.max(2, Math.round(cell / 9));
            // TASK 4ba: was 1.5x wBlue; thinned to 1.3x (about 15% less).
            // TASK 4bf: thinned again, 1.3x -> 1.05x (about a further 20%
            // less), with an explicit 1px floor -- matched structurally in
            // the legend's own error swatch (now HTML/inline-canvas, see
            // ERROR_SWATCH_STROKE_FACTOR), evaluated at that swatch's own
            // reference size instead of a live cell size.
            const stringWidth = Math.max(1, 1.05 * wBlue);
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            const siteMidY = siteRowTop + cell / 2;
            if (this.qubits.every(Boolean)) {
                // TASK 4bc: the all-ones configuration (the logical
                // codeword -- every qubit errored, no defects at all) has
                // no defect pair for errorStrings() to bound a run
                // between (it returns [] here by design), so the error
                // visually vanished exactly when a logical error
                // occurred. Draw one continuous string across the whole
                // row instead, edge to edge -- no endpoint orbs, since
                // there's nothing to anchor them to (drawCaDefects()
                // below already draws none here regardless, since the
                // syndrome is empty).
                ctx.beginPath();
                ctx.moveTo(siteRowLeft, siteMidY);
                ctx.lineTo(siteRowLeft + boxWidth, siteMidY);
                ctx.stroke();
            } else {
                for (const [leftDefect, rightDefect] of errorStrings(this.qubits, L)) {
                    drawErrorString(ctx, leftDefect, rightDefect, siteRowLeft, boxWidth, cell, siteMidY);
                }
            }
        }
        if (showSyndrome) {
            drawCaDefects(ctx, { left: siteRowLeft, top: siteRowTop, cell, cols: L, rows: 1, defectAt: siteDefectAt });
        }
        ctx.restore();

        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.3;
        ctx.strokeRect(siteRowLeft, siteRowTop, boxWidth, siteRowH);

        // "x ->" label: the italic "x" is centred horizontally on the panel
        // on its own (not as part of a combined x+arrow bounding box).
        // Vertically, its top ink edge sits AXIS_LABEL_CLEARANCE +
        // X_LABEL_EXTRA_CLEARANCE below the site row's bottom line -- the
        // shared constant is the same one used above for "t" (TASK 4e); the
        // extra per-axis term (TASK 4cr) moves the whole label+arrow pair
        // 2px further down without touching that shared clearance or the
        // "t" label. The baseline is solved from measured ascent rather
        // than a fixed heuristic offset.
        const cx = boxLeft + boxWidth / 2;
        ctx.fillStyle = '#000000';
        ctx.font = `italic ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        // measureText's ascent/right-edge metrics depend only on the
        // current font/textAlign/text, not on where it is actually drawn,
        // so both the baseline (from ascent) and the ink-right edge (from
        // actualBoundingBoxRight) come from this one measurement.
        const xMetrics = ctx.measureText('x');
        const xBaseline = siteRowBottom + AXIS_LABEL_CLEARANCE + X_LABEL_EXTRA_CLEARANCE + xMetrics.actualBoundingBoxAscent;
        const xInkRight = inkRightEdge(cx, xMetrics);
        ctx.fillText('x', cx, xBaseline);

        // Rightward arrow: its left ink edge sits AXIS_ARROW_INK_GAP to the
        // right of "x"'s own right ink edge (TASK 4e/4h).
        ctx.font = `bold ${xLabelFontSize}px ${FONT_SERIF}`;
        ctx.textAlign = 'left';
        const arrowMetrics = ctx.measureText('→');
        const arrowAnchorX = anchorForLeftEdge(xInkRight + AXIS_ARROW_INK_GAP, arrowMetrics);
        fillBoldGlyph(ctx, '→', arrowAnchorX, xBaseline);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const layout = this._layout(canvasWidth, canvasHeight);
        if (y < layout.siteRowTop || y > layout.siteRowBottom) return;
        const L = this.L;
        const b = (((Math.round((x - layout.siteRowLeft) / layout.cell)) % L) + L) % L;
        this.qubits[b] = !this.qubits[b];
        this.stepCount = 0;
        this._computeSyndrome();
        this._resetHistory();
    }

    // Let the host reject history-panel presses before clearing a finished run.
    canStartPointer(x, y, canvasWidth, canvasHeight) {
        const layout = this._layout(canvasWidth, canvasHeight);
        return y >= layout.siteRowTop && y <= layout.siteRowBottom;
    }

    // TASK 4ar: pointer-drag protocol for manual error placement, driven by
    // main.js's generic pointerdown/pointermove/pointerup wiring (active
    // only in "manual" initial-errors mode, only while paused). Two
    // gestures, disambiguated by what's under the pointer at pointerDown()
    // time:
    //   - paint: anywhere in the site row that isn't a *lit* defect's orb
    //     paints the nearest qubit boundary. TASK 4cd: the stroke decides
    //     its own value V once, at the first touch (the opposite of that
    //     qubit's current state), and every qubit touched for the rest of
    //     the drag is SET to V -- never toggled -- so retracing already-
    //     painted qubits within one stroke is a no-op rather than undoing
    //     them, and a stroke can never partially erase itself. A new
    //     stroke starting on an already-painted qubit naturally paints the
    //     opposite value, since V is recomputed fresh each pointerDown. A
    //     plain click (pointerdown/pointerup with no intervening move)
    //     still reproduces toggleErrorAtPosition() exactly (both are a
    //     single toggle of one qubit). Dragging walks, one qubit at a
    //     time, from the last-touched boundary to the new one (the
    //     shorter way around the ring), so a fast move still paints a
    //     contiguous run with no gaps, and a jittery pointer landing back
    //     on the same boundary touches nothing further (tracked via
    //     _lastPaintIndex).
    //   - defect drag: pointerdown within DEFECT_ORB_RADIUS of a lit
    //     defect's centre instead moves that defect toward wherever the
    //     pointer currently is, one ring-step at a time, by flipping the
    //     qubit at the boundary being crossed. Since
    //     syndrome[x] = qub(x) xor qub(x+1), flipping qub(x+1) always
    //     clears syndrome[x] and toggles syndrome[x+1] (moving the defect
    //     forward); flipping qub(x) itself does the same moving backward
    //     (see the asymmetric qubitToFlip choice in pointerMove() below).
    //     TASK 4cd: _dragDefectPath records every site index visited this
    //     drag, oldest first. At each step, if undoing back toward the
    //     previous path entry is at least as good as (or better than) the
    //     alternative single-step neighbour, that's preferred over a fresh
    //     shortest-arc recompute -- a stateless recompute can pick the
    //     *other* way around at or near a ring's antipodal point and fail
    //     to retrace the exact same qubits, which is the bug this fixes.
    //     Reversing direction thus always re-flips exactly the qubits that
    //     were flipped to get here, making a full there-and-back drag an
    //     exact inverse. If the moving defect reaches a site already
    //     occupied by another defect, the two annihilate and the drag ends
    //     early with nothing left to follow the pointer.
    // Neither gesture records history beyond the existing _resetHistory()
    // every toggle already triggers (manual edits are time-0 edits, never
    // recorded as steps), and the syndrome is recomputed after every single
    // qubit flip so the stats panel stays live throughout a drag.
    pointerDown(x, y, canvasWidth, canvasHeight, prevalidated = false) {
        this._pointerMode = null;
        this._lastPaintIndex = null;
        this._paintValue = null;
        this._dragDefectIndex = null;
        this._dragDefectPath = null;
        // The host may have accepted this press before a quiet rebuild
        // applied a pending size and moved the live row.
        if (!prevalidated && !this.canStartPointer(x, y, canvasWidth, canvasHeight)) return false;
        const layout = this._layout(canvasWidth, canvasHeight);
        const L = this.L;
        const cell = layout.cell;

        // Defect orbs take priority over a paint toggle: check the nearest
        // cell and its immediate ring-neighbours (the orb's radius reaches
        // just past its own cell) for a lit defect within that radius.
        const cy = layout.siteRowTop + cell / 2;
        const cNearest = Math.floor((x - layout.siteRowLeft) / cell);
        const orbRadius = DEFECT_ORB_RADIUS * cell;
        for (let dc = -1; dc <= 1; dc++) {
            const c = (((cNearest + dc) % L) + L) % L;
            if (!this.syndrome[c]) continue;
            const cx = layout.siteRowLeft + c * cell + cell / 2;
            const dist = Math.hypot(x - cx, y - cy);
            if (dist <= orbRadius) {
                this._pointerMode = 'defect';
                this._dragDefectIndex = c;
                this._dragDefectPath = [c];
                return;
            }
        }

        this._pointerMode = 'paint';
        const b = (((Math.round((x - layout.siteRowLeft) / cell)) % L) + L) % L;
        const V = !this.qubits[b];
        this._paintValue = V;
        this.qubits[b] = V;
        this._lastPaintIndex = b;
        this.stepCount = 0;
        this._computeSyndrome();
        this._resetHistory();
    }

    pointerMove(x, y, canvasWidth, canvasHeight) {
        if (this._pointerMode === null) return;
        const layout = this._layout(canvasWidth, canvasHeight);
        const L = this.L;
        const cell = layout.cell;

        if (this._pointerMode === 'paint') {
            const bNew = (((Math.round((x - layout.siteRowLeft) / cell)) % L) + L) % L;
            if (bNew === this._lastPaintIndex) return;
            const fwd = (bNew - this._lastPaintIndex + L) % L;
            const bwd = (this._lastPaintIndex - bNew + L) % L;
            const step = (fwd <= bwd) ? 1 : -1;
            let idx = this._lastPaintIndex;
            const V = this._paintValue;
            while (idx !== bNew) {
                idx = ((idx + step) % L + L) % L;
                this.qubits[idx] = V; // TASK 4cd: set, not toggle -- see pointerDown()'s comment
            }
            this._lastPaintIndex = bNew;
            this.stepCount = 0;
            this._computeSyndrome();
            this._resetHistory();
            return;
        }

        // 'defect' mode: walk the dragged defect toward whatever cell the
        // pointer is over now, one ring-step at a time. TASK 4cd: prefer
        // retracing _dragDefectPath (undoing back toward the entry right
        // before the current one) whenever that's at least as good a move
        // as the alternative neighbour, rather than always recomputing a
        // fresh shortest arc -- see the class-level comment above
        // pointerDown() for why a stateless recompute can fail to retrace
        // exactly near a ring's antipodal point.
        if (this._dragDefectIndex === null) return;
        const target = (((Math.floor((x - layout.siteRowLeft) / cell)) % L) + L) % L;
        let cur = this._dragDefectIndex;
        const path = this._dragDefectPath;

        const ringDist = (a, b) => Math.min((b - a + L) % L, (a - b + L) % L);

        while (cur !== target) {
            const fwdNeighbor = (cur + 1) % L;
            const bwdNeighbor = (cur - 1 + L) % L;
            const prev = path.length >= 2 ? path[path.length - 2] : null;

            let next;
            if (prev !== null) {
                const other = (prev === fwdNeighbor) ? bwdNeighbor : fwdNeighbor;
                next = (ringDist(prev, target) <= ringDist(other, target)) ? prev : other;
            } else {
                const fwdDist = (target - cur + L) % L;
                const bwdDist = (cur - target + L) % L;
                next = (fwdDist <= bwdDist) ? fwdNeighbor : bwdNeighbor;
            }

            const isRetrace = (next === prev);
            const isForward = (next === fwdNeighbor);
            const qubitToFlip = isForward ? next : cur;
            this.qubits[qubitToFlip] = !this.qubits[qubitToFlip];
            this._computeSyndrome();

            if (isRetrace) path.pop();
            else path.push(next);

            if (!this.syndrome[next]) {
                cur = null; // annihilated with a defect already at `next`
                break;
            }
            cur = next;
        }

        this._dragDefectIndex = cur;
        if (cur === null) { this._pointerMode = null; this._dragDefectPath = null; } // condensed; nothing left to drag
        this.stepCount = 0;
        this._resetHistory();
    }

    pointerUp() {
        this._pointerMode = null;
        this._lastPaintIndex = null;
        this._paintValue = null;
        this._dragDefectIndex = null;
        this._dragDefectPath = null;
    }
}

// TASK 4dt: lets another module (repetition_streaming.js) align a feature
// of its own diagram to this module's site-row strip's own bottom edge, for
// a given canvas size/system size, without duplicating _layout()'s
// cell-size/box-height solve as a second hardcoded formula that could
// silently drift out of sync with this one. _layout() itself only ever
// reads `this.L` (no other instance state), so calling it via .call() on a
// bare {L} object reuses the real computation exactly, with no live
// decoder instance required.
export function siteRowBottomFor(canvasWidth, canvasHeight, L) {
    return RepetitionCode2Decoder.prototype._layout.call({ L }, canvasWidth, canvasHeight).siteRowBottom;
}

// TASK 4dw: same pattern as siteRowBottomFor() above, for the history box's
// own top edge (boxTop) instead of the site row's bottom -- lets
// repetition_streaming.js align its future panel's top edge to this
// module's box top without hardcoding the topGap=13 constant a second
// time (boxTop === topGap by construction in _layout() above, but reading
// it through the real _layout() call, like siteRowBottomFor(), means the
// two can never silently drift apart if that ever changes).
export function boxTopFor(canvasWidth, canvasHeight, L) {
    return RepetitionCode2Decoder.prototype._layout.call({ L }, canvasWidth, canvasHeight).boxTop;
}
