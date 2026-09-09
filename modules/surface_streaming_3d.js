// 3D-stack rendering for the surface-code streaming decoder. Reuses
// SurfaceStreamingDecoder's dynamics completely unchanged (subclassing: no
// rule code is duplicated here) and replaces only render(), drawing the K
// slices (plus the residual as an extra bottom layer) as an oblique/
// isometric stack of 2D parallelogram lattices instead of a left-to-right
// row of flat panels.
//
// Layout: slice 0 sits at the bottom of the stack, the back wall (slice
// K-1) at the top, and the residual is an extra layer below slice 0 (the
// nearest, frontmost layer) -- chosen over a separate side panel so the
// whole picture reads as one continuous stack rather than a stack plus an
// unrelated flat inset. Each layer is projected as a parallelogram (grid
// x-axis stays horizontal; grid y-axis is sheared up-and-right at a fixed
// angle), all layers share one cell size, and layers are spaced vertically
// so every one stays fully visible. Layers are drawn back-to-front (back
// wall first, residual last) so nearer layers correctly overlay farther
// ones where they overlap on screen.
//
// TASK 4dr: restyled to match surface2.js's/toric2.js's/repetition2.js's
// own shared visual language, the same way TASK 4cx/4cy did for
// toric2.js/surface2.js themselves -- the oblique projection, depth
// scale, layer spacing, layer order, each layer's own opaque backing
// fill, and the left-hand per-layer labels are all UNCHANGED (this
// task's own instruction); what changed is every glyph/colour/line-
// weight choice, which now reuses the shared constants/helpers imported
// below instead of this module's own previously-local ones, and the
// removal of every on-canvas caption/stats-line/legend (the HTML legend
// and state card carry that information now, exactly like every other
// restyled tab). No dynamics changed at all -- this file has none; it
// only ever subclasses SurfaceStreamingDecoder to replace render().
//
// Layer separation: the grid y-axis (the sheared "depth" axis) is drawn at
// `depthScale` of the width axis's scale (a "cabinet oblique" convention),
// and the vertical spacing between layer origins is tied directly to one
// layer's own projected height at that depth scale, so consecutive layers
// never overlap regardless of cell size -- shrinking the stack to fit the
// canvas shrinks `cell` uniformly, which shrinks the spacing and each
// layer's height together and so preserves the separation; the gaps are
// never independently reduced to force a fit. Each layer is additionally
// drawn with a thin outline (now the shared black outline weight) and a
// very light opaque fill (before its grid lines and glyphs) so its extent
// reads clearly even where projected bounding boxes still come close.
// Gutter captions identify the decoder slices as one bracketed group and
// the bottom panel as the system.

import { SurfaceStreamingDecoder } from './surface_streaming.js';
import {
    COLOR_GRID, COLOR_ERROR, COLOR_ORB_RIM,
    DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE,
    CAPTION_SCALE, TLABEL_FONT_SIZE, anchorForCenteredInk,
} from './repetition2.js';
import {
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    drawMessageCell,
} from './toric2.js';

// TASK 4df: this is "the surface code (phenomenological) module"'s own
// rough-boundary colour/width (main.js's decoderConfigs names this tab
// exactly that) -- exported so surface2.js can import these two values
// directly instead of retyping the same literals, so the code-capacity and
// phenomenological surface tabs can never drift apart on this specific
// styling choice again. Un-exported before TASK 4df, only ever used as
// inline literals in drawRoughBoundaries()/the legend below.
export const ROUGH_BOUNDARY_COLOR = '#8764b9';
// TASK 4di: 2.5 -> 4 -- the line read as too thin. TASK 4hs trims only
// its ends at the horizontal frame edges, preserving the full normal width.
export const ROUGH_BOUNDARY_WIDTH = 4;
export const STACK_SMOOTH_BOUNDARY_WIDTH = 1.3;

// Scale the established snapped grid width equally at every lattice size.
export const STACK_GRID_LINE_SCALE = 0.7;
export const STACK_GRID_LINE_MIN = 0.7;

// Fixed-height stack geometry. Fit the largest displayed stack at one
// shared scale, so changing K only changes the stack height and position.
export const STACK_WIDTH_SCALE = 0.8;
export const LAYER_SPACING_FACTOR = 1.35;
export const RESIDUAL_EXTRA_DROP = 0.4;
export const REFERENCE_NLAYERS = 4; // K=3, including the residual
export const STACK_FIT_NLAYERS = 5; // K=4, including the residual
export const STACK_TOP_GAP = 13;
export const STACK_BOTTOM_MARGIN = 14;
export const STACK_LABEL_HEADROOM = 16; // retain the established stack fit/centres

// CSS-pixel gutter geometry. The inset clears the outermost rough-boundary
// ink; ticks point toward the stack, and the caption gap clears the spine.
export const STACK_BRACKET_INSET = 20;
export const STACK_BRACKET_TICK_LENGTH = 7;
export const STACK_CAPTION_GAP = 10;
export const STACK_BRACKET_WIDTH = 1;
// Keep the full-size captions and bracket inside a phone's canvas.
export const STACK_NARROW_CAPTION_GUTTER = 100;
export const STACK_NARROW_EDGE_MARGIN = 4;

// Orb radius in lattice units, before the disc's affine projection.
export const STACK_ORB_SCALE = 0.6;
export const STACK_ORB_STYLE = 'disc'; // 'disc' | 'sphere'; URL preview overrides per instance
export const STACK_ORB_SHADOW_OPACITY = 0.28;
export const STACK_ERROR_STRING_SCALE = 0.33;

let stackCaptionStyle;
function drawStackGutterCaptions(ctx, layout) {
    // drawGutterCaptions also requires a two-line history/future block.
    // Use its shared size and ink-anchor helper for this two-caption stack,
    // reading the same CSS variables and DOM-free fallbacks as repetition2.
    if (!stackCaptionStyle) {
        const css = typeof document !== 'undefined' && typeof getComputedStyle === 'function'
            ? getComputedStyle(document.documentElement) : null;
        stackCaptionStyle = {
            font: css?.getPropertyValue('--font-mono').trim()
                || '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
            color: css?.getPropertyValue('--text-dim').trim() || '#6b7280',
        };
    }
    const { bracketX, captionRightX, decoderInkTop, decoderInkBottom,
        systemInkTop, systemInkBottom } = layout;
    ctx.save();
    ctx.fillStyle = stackCaptionStyle.color;
    ctx.strokeStyle = stackCaptionStyle.color;
    ctx.font = `${CAPTION_SCALE * TLABEL_FONT_SIZE}px ${stackCaptionStyle.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const captions = [
        { text: 'decoder', midY: (decoderInkTop + decoderInkBottom) / 2 },
        { text: 'system', midY: (systemInkTop + systemInkBottom) / 2 },
    ].map(caption => ({ ...caption, metrics: ctx.measureText(caption.text) }));
    const columnWidth = Math.max(...captions.map(({ metrics }) =>
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight));
    const centerX = captionRightX - columnWidth / 2;
    for (const { text, midY, metrics } of captions) {
        const baseline = midY
            + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
        ctx.fillText(text, anchorForCenteredInk(centerX, metrics), baseline);
    }
    ctx.lineWidth = STACK_BRACKET_WIDTH;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(bracketX + STACK_BRACKET_TICK_LENGTH, decoderInkTop);
    ctx.lineTo(bracketX, decoderInkTop);
    ctx.lineTo(bracketX, decoderInkBottom);
    ctx.lineTo(bracketX + STACK_BRACKET_TICK_LENGTH, decoderInkBottom);
    ctx.stroke();
    ctx.restore();
}

function drawStackOrb(ctx, px, py, cell, depthX, depthY, style) {
    const radius = DEFECT_ORB_RADIUS * STACK_ORB_SCALE * cell;
    ctx.save();
    if (style === 'sphere') {
        // The contact shadow uses the disc's exact plane projection and
        // fades to transparent at its edge, with no outline.
        ctx.save();
        ctx.transform(1, 0, depthX, depthY, px, py);
        const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        shadow.addColorStop(0, `rgba(0, 0, 0, ${STACK_ORB_SHADOW_OPACITY})`);
        shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.fillStyle = shadow;
        ctx.fill();
        ctx.restore();
    }
    // Both styles share the white-to-rim gradient. Discs follow the slice
    // plane; spheres stay circular and rest one radius above the site.
    // Canvas paths retain this map after restore().
    ctx.save();
    if (style === 'sphere') ctx.transform(1, 0, 0, 1, px, py - radius);
    else ctx.transform(1, 0, depthX, depthY, px, py);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, COLOR_ORB_RIM);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    // Stroke without the slice transform, retaining only the caller's
    // CSS-to-device scale, so the existing rim stays crisp and uniform.
    ctx.lineWidth = Math.max(1, DEFECT_ORB_OUTLINE * cell) * STACK_ORB_SCALE;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.restore();
}

// TASK 4ed: DETECTOR_EVENT_COLOR (the transient "just measured this round"
// cross marker on slice 0, this.lastPhi) removed entirely, per the user's
// own request -- this tab and surface_cg_streaming.js no longer draw that
// glyph at all, and its legend row is gone from both (see main.js's own
// getLegendItems() cases). this.lastPhi itself is untouched (it's core
// dynamics state from the base SurfaceStreamingDecoder class, still read
// by surface_streaming.js's own flat 2D renderer, out of this task's
// drawing-only scope) -- only the drawing code that read it here is gone.

// TASK 4dr: re-exported so main.js's getLegendItems() can read them off
// this module's own namespace object -- same pattern as toric2.js's/
// surface2.js's own re-exports (loadDecoder() passes the whole freshly
// import()ed module through as moduleColors).
export {
    COLOR_ORB_RIM, COLOR_ERROR,
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
};

export class SurfaceStreaming3DDecoder extends SurfaceStreamingDecoder {
    constructor(L, q, opts = {}) {
        super(L, q, opts);
        this.orbStyle = opts.orbStyle === 'disc' || opts.orbStyle === 'sphere'
            ? opts.orbStyle : STACK_ORB_STYLE;
    }

    // TASK 4dr: for the state card's own "clock" row (main.js hides that
    // row generically whenever `.clock` isn't a finite number, which is
    // what happened here before this getter existed -- the parent class,
    // whose own dynamics this task leaves untouched, exposes `t` (the
    // step counter) and `q`/`clockPeriod` but no single representative
    // clock value). Mirrors repetition_streaming.js's own identical
    // `get clock() { return this.stepCount % this.clockPeriod; }` -- this
    // decoder's own clock is likewise uniform across the whole lattice
    // (advances by 1 every step, unconditionally), so one representative
    // value suffices. A pure accessor, not part of step()/stepUncoord()'s
    // own rule logic, so this doesn't touch this module's dynamics.
    get clock() {
        return this.t % this.q;
    }

    // Pure geometry (no ctx), shared by render() and getTitleAnchor().
    // The standard top/bottom margins include the labels and outer ink;
    // the projection and all spacing proportions scale with one cell.
    _layout(canvasWidth, canvasHeight, overlayRects) {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        // TASK 4dr: leftMargin widened from the original symmetric 20px
        // sideMargin -- this stack is tall enough (500+ CSS px, spanning
        // well past canvas-local y=201) to share the same vertical band
        // as the HTML description card, which sits at a fixed
        // `left: 8px, max-width: 180px` within .canvas-area independent
        // of this module's own canvas-local layout; in the worst case
        // (canvas flush against .canvas-area's own left edge, reachable
        // at some viewport widths), the card's own right edge lands at
        // canvas-local x = 8 + 180 = 188. Found live via pixel scan: at
        // the old 20px margin, the leftmost layer's own rough-boundary
        // line (which -- unlike the layers' own axis-aligned outline --
        // slants rightward with the oblique shear, so its leftmost point
        // isn't at a fixed x) had a few pixels of anti-aliased ink
        // landing under the card's rect. 200px clears the worst case
        // (188) plus a small buffer, matching the +8px convention other
        // modules use for the same reason.
        //
        // TASK 4dv: rightMargin widened the same way leftMargin was
        // (TASK 4dr, above) -- the state/legend overlay cards
        // (.overlay-stack, right:28px inside .canvas-area) sit on THIS
        // side, and this stack's own back layer/residual panel were
        // found (live pixel scan) running under both cards' rects at
        // realistic viewport widths (content out to canvas-local x~900
        // vs. the cards starting around x~797-789 depending on viewport).
        // Same worst-case reasoning as leftMargin: measured live,
        // .info-panel/.legend are both 196.25px wide (not the ~136px
        // rough estimate) and right-inset 28px inside .canvas-area, so in
        // the worst case (canvas-area's own margin around the canvas
        // shrinks toward zero, reachable at some viewport widths, exactly
        // as leftMargin's own comment describes for the description
        // card), the cards' combined footprint reaches all the way to
        // canvas-local x = canvasWidth - (28 + 197) measured from the
        // right edge -- i.e. a 225px reserve -- plus the same +8px buffer
        // convention leftMargin uses, rounded to 233.
        //
        // TASK 4dy: both margins above were the worst case (canvas-area's
        // own margin around the canvas shrunk to ~zero) baked in as fixed
        // constants -- correct, but far more conservative than the real
        // room these cards leave at any actual window width (e.g. at
        // 1600px wide the description card's own right edge is only
        // ~67px into the canvas, and the state/legend cards start
        // ~797px in -- nowhere near either worst case), so the stack came
        // out needlessly small. `overlayRects` (canvas CSS-relative
        // rects for .description-stack/.info-panel/.legend, computed once
        // by main.js's render() and threaded through render()'s own
        // options and getTitleAnchor() below) lets this module measure
        // the cards' REAL edges instead and reserve only what they
        // actually need, plus the same +8px buffer convention: leftMargin
        // = the description card's own right edge + 8, rightMargin =
        // canvasWidth minus whichever of the state/legend cards' own left
        // edges is smaller (i.e. starts first), + 8. Falls back to the
        // worst-case 200/233 constants above whenever overlayRects (or a
        // specific card's rect within it) is absent -- every Node harness
        // call, which only ever passes the original 2 args, and any
        // future caller that hasn't wired the hook through -- so this
        // module can never regress to overlapping a card it has no way to
        // see.
        // TASK 4ew: the 200/233 worst-case constants below assume SOME
        // card might be floating over the canvas whose real position this
        // call just doesn't know (overlayRects absent, or missing this
        // specific field) -- correct for a direct Node-harness call, but
        // needlessly conservative once main.js's own computeOverlayRects()
        // reports overlayRects.noOverlayCards (the three-pillar layout: no
        // card exists anywhere on the page, not merely one this call can't
        // see), where the right answer is no reserve at all.
        const descRight = overlayRects?.description?.right;
        const leftMargin = Math.max(
            Number.isFinite(descRight) ? Math.max(0, descRight) + 8 : (overlayRects?.noOverlayCards ? 0 : 200),
            overlayRects?.narrowLayout ? STACK_NARROW_CAPTION_GUTTER : 0);
        const cardLeftEdges = [overlayRects?.infoPanel?.left, overlayRects?.legend?.left].filter(Number.isFinite);
        const rightMargin = cardLeftEdges.length > 0 ? (canvasWidth - Math.min(...cardLeftEdges)) + 8 : (overlayRects?.noOverlayCards ? 0 : 233);
        const availW = canvasWidth - leftMargin - rightMargin;
        const availH = canvasHeight - STACK_TOP_GAP - STACK_BOTTOM_MARGIN;

        // Oblique projection: grid x-axis stays horizontal; grid y-axis is
        // sheared up-and-right at `angle` from horizontal, giving each
        // layer's Lx x Ly grid a parallelogram outline. `nLayers` = K
        // slices + 1 (the residual, an extra bottom layer).
        const angle = Math.PI / 6; // 30 degrees (within the requested 30-35 degree range)
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const depthScale = 0.45; // y-axis (depth) drawn at 0.45x the width axis's scale
        const nLayers = K + 1;

        // One layer's own projected height, in cell units, at this depth
        // scale -- tying the spacing factors to layerHeightCellUnits (plus
        // a fixed headroom multiplier) guarantees zero overlap at any cell
        // size, since both scale together with `cell`.
        const layerHeightCellUnits = Ly * depthScale * sinA;
        // TASK 4eb: renamed from spacingHeadroom (which was 1.15) per the
        // user's own feedback that the slices read as too close together --
        // governs the gap between every pair of adjacent DECODER SLICES
        // (li=1..K), i.e. excluding the residual-to-slice-0 gap, which
        // gets its own additional RESIDUAL_EXTRA_DROP just below.
        const regularSpacingFactor = layerHeightCellUnits * LAYER_SPACING_FACTOR; // slice-to-slice spacing, in cell units
        // TASK 4eb: the residual layer (li=0) sits this many EXTRA layer
        // heights below slice 0 (li=1), on top of the regular spacing
        // above -- so the residual-to-slice-0 gap reads as visibly larger
        // than any slice-to-slice gap, setting the residual apart as its
        // own distinct structural level rather than just one more slice.
        const residualGapFactor = layerHeightCellUnits * (LAYER_SPACING_FACTOR + RESIDUAL_EXTRA_DROP); // residual-to-slice-0 spacing, in cell units

        // Solve for the largest cell size (in px) whose fitting stack
        // fits availW x availH, then centre the resulting bounding box. If the
        // stack does not fit, this shrinks `cell` -- and with it, both the
        // spacing and each layer's height together -- rather than ever
        // reducing the spacing-to-height ratio itself.
        //
        // TASK 4ea: STACK_WIDTH_SCALE shrinks the stack's own maximum
        // width by 20% -- applied only to the WIDTH term feeding this
        // solve (availW itself, used below for centring via originX/
        // stackCenterX, is untouched), so cell (and with it layer spacing,
        // each layer's own height, and the depth offset -- everything
        // derived from cell below) all shrink together in the same
        // proportion, and the stack still centres within the FULL free
        // width between the cards exactly as before, just with more
        // blank margin now on both sides of a narrower stack.
        const widthPerCell = Lx + Ly * depthScale * cosA;
        // TASK 4gj: the shared 650px canvas supplies the height budget.
        // K=1..4 all use the scale that fits K=4 plus its residual; larger
        // programmatic K values still shrink to fit their actual height.
        const fitNLayers = overlayRects?.narrowLayout ? nLayers
            : Math.max(nLayers, STACK_FIT_NLAYERS, REFERENCE_NLAYERS);
        const heightPerCell = layerHeightCellUnits + residualGapFactor + (fitNLayers - 2) * regularSpacingFactor;
        // Visible ink extends beyond the parallelograms: rough-boundary
        // stroke, or an edge-row orb with its proportionately scaled rim.
        // Retain the circular-orb reserve as a conservative bound for the
        // flatter projected discs, preserving the existing scale/centres.
        const inkOverhangs = [
            { factor: 0, fixed: ROUGH_BOUNDARY_WIDTH * cosA / 2 },
            { factor: DEFECT_ORB_RADIUS * STACK_ORB_SCALE - depthScale * sinA / 2, fixed: 0.5 * STACK_ORB_SCALE },
            { factor: (DEFECT_ORB_RADIUS + DEFECT_ORB_OUTLINE / 2) * STACK_ORB_SCALE - depthScale * sinA / 2, fixed: 0 },
        ];
        // Top padding is max(label headroom, ink overhang); bottom padding
        // is the ink overhang. Solving both cases for every possible edge
        // leaves the standard margins clear even when boundary orbs light.
        const cellByHeight = Math.min(...inkOverhangs.flatMap(({ factor, fixed }) => [
            (availH - STACK_LABEL_HEADROOM - fixed) / (heightPerCell + factor),
            (availH - 2 * fixed) / (heightPerCell + 2 * factor),
        ]));
        // Narrow stages use their whole width, reserving the oblique rough
        // stroke's actual horizontal overhang instead of the desktop shrink.
        const horizontalInkOverhang = STACK_SMOOTH_BOUNDARY_WIDTH / 2 * cosA / sinA
            + ROUGH_BOUNDARY_WIDTH / (2 * sinA);
        const widthBudget = overlayRects?.narrowLayout
            ? availW - 2 * (horizontalInkOverhang + STACK_NARROW_EDGE_MARGIN)
            : availW * STACK_WIDTH_SCALE;
        let cell = Math.min(widthBudget / widthPerCell, cellByHeight);
        // At larger lattice sizes, the desktop 3px floor can defeat the
        // width/height solve on phones; keep the fitting result there.
        if (!overlayRects?.narrowLayout) cell = Math.max(3, cell);
        const regularSpacing = cell * regularSpacingFactor; // px, between adjacent slices
        const residualGap = cell * residualGapFactor; // px, between the residual and slice 0

        // Layer index 0 = residual (bottom, nearest); index K = back wall
        // (top, farthest). TASK 4eb: layerYOffset(li) replaces the old
        // uniform -li*layerSpacing -- the residual (li=0) sits residualGap
        // below slice 0 (li=1), then each further slice steps up by the
        // same regularSpacing. Project grid point (x, y) of layer `li`
        // relative to an arbitrary reference origin; the whole stack is
        // translated afterward to centre it.
        const layerYOffset = (li) => (li === 0 ? 0 : -(residualGap + (li - 1) * regularSpacing));
        const projRaw = (li, x, y) => [
            x * cell + y * cell * depthScale * cosA,
            layerYOffset(li) - y * cell * depthScale * sinA,
        ];

        // Unpadded corner bounds of every layer, including the residual.
        // Vertical placement below also accounts for labels and outer ink.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let li = 0; li < nLayers; li++) {
            for (const [cx, cy] of [[-0.5, -0.5], [Lx - 0.5, -0.5], [-0.5, Ly - 0.5], [Lx - 0.5, Ly - 0.5]]) {
                const [px, py] = projRaw(li, cx, cy);
                minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                minY = Math.min(minY, py); maxY = Math.max(maxY, py);
            }
        }
        const stackW = maxX - minX;
        const originX = leftMargin + (availW - stackW) / 2 - minX;
        const inkOverhang = Math.max(...inkOverhangs.map(({ factor, fixed }) => factor * cell + fixed));
        const topPadding = Math.max(STACK_LABEL_HEADROOM, inkOverhang);
        const minTopPosition = STACK_TOP_GAP + topPadding;
        const actualHeight = maxY - minY;

        // Centre the whole padded drawing on the canvas, including the
        // back-wall label and residual's outer ink. Retain both existing
        // margin limits; the height-filling K=4 stack therefore stays at
        // its original top gap. Every glyph uses this same projection.
        const desiredTop = (canvasHeight - actualHeight + topPadding - inkOverhang) / 2;
        const maxTopPosition = canvasHeight - STACK_BOTTOM_MARGIN - inkOverhang - actualHeight;
        const finalTop = Math.max(minTopPosition, Math.min(desiredTop, maxTopPosition));
        const originY = finalTop - minY;

        const proj = (li, x, y) => {
            // Preserve the raw projection's arithmetic order while returning
            // only the final pair, without an intermediate coordinate array.
            return [
                originX + (x * cell + y * cell * depthScale * cosA),
                originY + (layerYOffset(li) - y * cell * depthScale * sinA),
            ];
        };

        // The rough strokes are clipped at the horizontal frame's outer
        // edges. Account for both their width and the slanted extension
        // to that clip when finding the stack's leftmost visible point.
        const frameHalfWidth = STACK_SMOOTH_BOUNDARY_WIDTH / 2;
        const stackInkLeft = originX + minX
            - frameHalfWidth * cosA / sinA - ROUGH_BOUNDARY_WIDTH / (2 * sinA);
        const bracketX = stackInkLeft - STACK_BRACKET_INSET - STACK_BRACKET_TICK_LENGTH;
        const decoderInkTop = proj(K, -0.5, Ly - 0.5)[1] - frameHalfWidth;
        const decoderInkBottom = proj(1, -0.5, -0.5)[1] + frameHalfWidth;
        const systemInkTop = proj(0, -0.5, Ly - 0.5)[1] - frameHalfWidth;
        const systemInkBottom = proj(0, -0.5, -0.5)[1] + frameHalfWidth;

        // Layer index -> kind and (for slices) the underlying SliceState.
        const layerInfo = [{ kind: 'residual' }];
        for (let k = 0; k < K; k++) {
            layerInfo.push({ kind: 'slice', k });
        }
        // layerInfo[li] matches projection layer index li (0=residual, ..., K=back wall).

        return {
            cell, nLayers, layerInfo, proj,
            stackInkLeft, bracketX,
            captionRightX: bracketX - STACK_BRACKET_WIDTH / 2 - STACK_CAPTION_GAP,
            decoderInkTop, decoderInkBottom, systemInkTop, systemInkBottom,
            // TASK 4dr: the stack is centred within availW by construction
            // (originX offsets the bounding box so it's centred inside
            // [leftMargin, leftMargin+availW]), which reduces to
            // leftMargin + availW/2 independent of the stack's own
            // width -- what getTitleAnchor() below needs. leftMargin !=
            // rightMargin now (see its own comment above), so the stack
            // (and the title following it) sits left of true canvas
            // centre, clearing the description card on that side.
            stackCenterX: leftMargin + availW / 2,
        };
    }

    // TASK 4dr: centres the decoder title on the stack's own horizontal
    // centre (matching getTitleAnchor()'s role in every other restyled
    // module) -- canvas-local CSS-pixel coordinate system, same as
    // _layout() itself uses. getDescriptionAnchor() is deliberately NOT
    // defined here: main.js's own default for a decoder without one
    // ({ top: DESCRIPTION_TOP_CSS }, TASK 4de) already applies, matching
    // every other restyled tab's card start height -- this task's own
    // instruction is to leave that as the shared default.
    // TASK 4dy: accepts the same overlayRects main.js now threads through
    // render()'s own options (see that file's computeOverlayRects()), so
    // the title stays centred on the stack's REAL adaptive extent instead
    // of the one _layout() would fall back to computing without them.
    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        const layout = this._layout(canvasWidth, canvasHeight, overlayRects);
        return { centerX: layout.stackCenterX };
    }

    // TASK 4gj: no preferred-height override. main.js supplies the same
    // 650px canvas used by the other 2D-rendered tabs; _layout fits it.

    // TASK 4dr: no more on-canvas caption ("t = N"), stats line, or
    // legend -- the state card and HTML legend (main.js) carry that
    // information now, exactly like every other restyled tab. Every
    // layer's own outline/grid/rough-boundary/message/defect/error-string
    // styling now reuses the shared constants/helpers imported above
    // instead of this module's own previously-local colours/widths; the
    // oblique projection, layer order, opaque backing fill, and left-hand
    // per-layer labels are all otherwise unchanged (this task's own
    // instruction). TASK 4ed: the "detector event" cross marker on slice 0
    // (this.lastPhi) that used to be drawn here is removed entirely, per
    // the user's own request -- see drawSliceLayer()'s own comment below.
    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const Lx = this.Lx, Ly = this.Ly, K = this.K;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const showMessages = !!options.showMessages;
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;
        const showGrid = options.showGrid !== false;

        // TASK 4dy: forwards options.overlayRects (main.js's own
        // computeOverlayRects(), undefined for every Node harness call)
        // so the adaptive-margin derivation in _layout() above can see
        // the real cards' rects when they're available.
        const layout = this._layout(canvasWidth, canvasHeight, options.overlayRects);
        const { cell, proj } = layout;
        // Derive the disc's depth vector from the same projection as the
        // grid, avoiding a second angle or foreshortening tuning knob.
        const origin = proj(0, 0, 0), depth = proj(0, 0, 1);
        const depthX = (depth[0] - origin[0]) / cell;
        const depthY = (depth[1] - origin[1]) / cell;
        // Keep the shared error-string weight and reduce the established
        // rounded grid width by 30% on every slice and the system panel.
        // Lines remain in canvas space so the oblique projection does not
        // stretch their widths.
        const wBlue = Math.max(2, Math.round(cell / 9));
        const stringWidth = Math.max(1, 1.05 * wBlue * STACK_ERROR_STRING_SCALE);
        const gridLineWidth = Math.max(STACK_GRID_LINE_MIN,
            STACK_GRID_LINE_SCALE * Math.round(cell / 18));

        // Full-extent opaque backing and black horizontal smooth edges;
        // the purple rough boundaries complete the oblique outline below.
        // Filled rectangles preserve the smooth stroke's exact width while
        // matching its outer-edge antialiasing to the purple endpoint clip.
        // The fill covers any farther layer in the back-to-front pass.
        const drawLayerBacking = (li) => {
            const corners = [
                proj(li, -0.5, -0.5), proj(li, Lx - 0.5, -0.5),
                proj(li, Lx - 0.5, Ly - 0.5), proj(li, -0.5, Ly - 0.5),
            ];
            ctx.fillStyle = '#f8fafc';
            ctx.beginPath();
            ctx.moveTo(corners[0][0], corners[0][1]);
            for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = '#000000';
            for (const [start, end] of [[corners[0], corners[1]], [corners[3], corners[2]]]) {
                ctx.fillRect(start[0], start[1] - STACK_SMOOTH_BOUNDARY_WIDTH / 2,
                    end[0] - start[0], STACK_SMOOTH_BOUNDARY_WIDTH);
            }
        };

        // Integer (x,y) are vertices of the error graph. The displayed
        // grid bounds their site-centred cells at half-integers, so orbs
        // belong at cell centres; error strings join those same sites.
        // Interior grid lines only -- gated on showGrid, same as every
        // other restyled module (the layer's own outline above is always
        // drawn regardless).
        const drawLayerGrid = (li) => {
            if (!showGrid) return;
            ctx.strokeStyle = COLOR_GRID;
            ctx.lineWidth = gridLineWidth;
            for (let x = 0; x <= Lx; x++) {
                const [x0, y0] = proj(li, x - 0.5, -0.5);
                const [x1, y1] = proj(li, x - 0.5, Ly - 0.5);
                ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            }
            for (let y = 0; y <= Ly; y++) {
                const [x0, y0] = proj(li, -0.5, y - 0.5);
                const [x1, y1] = proj(li, Lx - 0.5, y - 0.5);
                ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            }
        };

        // Oblique butt caps otherwise leave one side short of each corner
        // while the other overshoots. Extend the strokes past both ends,
        // then trim them at the horizontal frame's exact outer edges.
        const drawRoughBoundaries = (li) => {
            const frameHalfWidth = STACK_SMOOTH_BOUNDARY_WIDTH / 2;
            const top = proj(li, -0.5, Ly - 0.5)[1] - frameHalfWidth;
            const bottom = proj(li, -0.5, -0.5)[1] + frameHalfWidth;
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, top, canvasWidth, bottom - top);
            ctx.clip();
            ctx.strokeStyle = ROUGH_BOUNDARY_COLOR;
            ctx.lineWidth = ROUGH_BOUNDARY_WIDTH;
            ctx.lineCap = 'butt';
            for (const xEdge of [-0.5, Lx - 0.5]) {
                const [x0, y0] = proj(li, xEdge, -0.5);
                const [x1, y1] = proj(li, xEdge, Ly - 0.5);
                const dx = x1 - x0, dy = y1 - y0;
                const capHalfHeight = ROUGH_BOUNDARY_WIDTH * Math.abs(dx) / (2 * Math.hypot(dx, dy));
                const extension = (frameHalfWidth + capHalfHeight) / Math.abs(dy);
                ctx.beginPath();
                ctx.moveTo(x0 - dx * extension, y0 - dy * extension);
                ctx.lineTo(x1 + dx * extension, y1 + dy * extension);
                ctx.stroke();
            }
            ctx.restore();
        };

        const drawSliceLayer = (li, sl) => {
            drawLayerBacking(li);
            if (showMessages) {
                // The shared tile helper uses screen-down coordinates.
                // Map integer tile bounds into this slice's affine plane;
                // its pixel snapping then preserves exact cell corners,
                // and every band's polygon receives the same projection.
                const origin = proj(li, -0.5, Ly - 0.5);
                const across = proj(li, 0.5, Ly - 0.5);
                const down = proj(li, -0.5, Ly - 1.5);
                ctx.save();
                ctx.transform(
                    across[0] - origin[0], across[1] - origin[1],
                    down[0] - origin[0], down[1] - origin[1],
                    origin[0], origin[1]
                );
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        const mask = (sl.m['00'][x][y] ? 1 : 0)
                            | (sl.m['01'][x][y] ? 2 : 0) | (sl.m['10'][x][y] ? 4 : 0);
                        if (!mask) continue;
                        drawMessageCell(ctx, x, Ly - y - 1, x + 1, Ly - y, mask);
                    }
                }
                ctx.restore();
            }
            drawLayerGrid(li);
            drawRoughBoundaries(li);
            if (showSyndrome) {
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!sl.s[x][y]) continue;
                        const [px, py] = proj(li, x, y);
                        drawStackOrb(ctx, px, py, cell, depthX, depthY, this.orbStyle);
                    }
                }
            }
            // TASK 4ed: the "detector event" cross marker on slice 0
            // (this.lastPhi) used to be drawn here -- removed entirely,
            // along with the isSlice0 parameter this was the only user of.
        };

        const drawResidualLayer = (li) => {
            drawLayerBacking(li);
            drawLayerGrid(li);
            if (showErrors) {
                ctx.strokeStyle = COLOR_ERROR;
                ctx.lineWidth = stringWidth;
                ctx.lineCap = 'round';
                for (let x = 0; x <= Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!this.residualX[x][y]) continue;
                        let p0, p1;
                        if (x === 0) { p0 = proj(li, 0, y); p1 = proj(li, -0.5, y); }
                        else if (x === Lx) { p0 = proj(li, Lx - 1, y); p1 = proj(li, Lx - 0.5, y); }
                        else { p0 = proj(li, x - 1, y); p1 = proj(li, x, y); }
                        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
                    }
                }
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!this.residualY[x][y]) continue;
                        const p0 = proj(li, x, y - 1), p1 = proj(li, x, y);
                        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
                    }
                }
                ctx.lineCap = 'butt';
            }
            // Error strings end beneath the boundaries; defects stay on top.
            drawRoughBoundaries(li);
            if (showSyndrome) {
                for (let x = 0; x < Lx; x++) {
                    for (let y = 0; y < Ly; y++) {
                        if (!this.residualSyndrome[x][y]) continue;
                        const [px, py] = proj(li, x, y);
                        drawStackOrb(ctx, px, py, cell, depthX, depthY, this.orbStyle);
                    }
                }
            }
        };

        // Back-to-front: back wall (li=K, farthest) first, down to the
        // residual (li=0, nearest) last, so nearer layers overlay farther
        // ones wherever they overlap on screen.
        for (let li = K; li >= 1; li--) {
            const k = li - 1;
            drawSliceLayer(li, this.slices[k]);
        }
        drawResidualLayer(0);
        drawStackGutterCaptions(ctx, layout);
    }
}
