// The state-preparation and state-injection models use the ordinary H-tree
// presentation and its movement/history clock. Absorbing geometry and
// the distinguished injection qubit add paint. See main.tex:3708-3740 and
// 5548: the wall/region is implemented on each coarse lattice itself.
import { SurfaceCGPrepDecoder, SurfaceCGInjectDecoder } from './surface_cg_prep_inject.js';
import { syndromeOpen } from './surface_cg_streaming.js';
import { drawOrb, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE } from './repetition2.js';
import {
    SurfaceCGHTreeDecoder, HTREE_LEVEL_COLORS, HTREE_FUNNEL_COLORS, HTREE_PULSE_MAX_MS,
    HTREE_BOUNDARY_INSET, HTREE_GLYPH_SIDE_RATIO,
    HTREE_STREET_OPACITY, HTREE_STREET_WIDTH,
    HTREE_FUNNEL_OPACITY, HTREE_FUNNEL_WIDTH,
    ROUGH_BOUNDARY_COLOR, glyphColors,
} from './surface_cg_htree.js';

export * from './surface_cg_htree.js';
export { PREP_WALL_M, INJECTION_DRIFT_PERIOD, INJECTION_CORNER,
    INJECTION_FRAME_OUTCOME_PROBABILITY } from './surface_cg_prep_inject.js';

export const PROTOCOL_ABSORBING_EDGE = ROUGH_BOUNDARY_COLOR;
export const PROTOCOL_ABSORBING_FILL = glyphColors(ROUGH_BOUNDARY_COLOR).fill;
// Dash lengths scale with the square, including the shared legend swatch.
export const PROTOCOL_ABSORBING_DASH_RATIO = 0.20;
export const PROTOCOL_ABSORBING_GAP_RATIO = 0.15;
export const PROTOCOL_ABSORBING_GLYPH_COLORS = Object.freeze({
    fill: PROTOCOL_ABSORBING_FILL,
    edge: PROTOCOL_ABSORBING_EDGE,
    dashRatios: Object.freeze([PROTOCOL_ABSORBING_DASH_RATIO, PROTOCOL_ABSORBING_GAP_RATIO]),
});
export const PROTOCOL_ABSORBING_WASH_OPACITY = 0.10;
// A small gap exposes each absorbing site's own coarse-lattice footprint.
export const PREP_INJECT_REGION_CELL_RATIO = 0.94;
// Orange is reserved for frame flips; use golden yellow for the injected qubit.
export const INJECTED_QUBIT_COLOR = '#f5c518';
// Diameter equals glyphSide: radius = 0.21 cell, while the nearest check
// square starts 0.29 cell from the boundary centre (inset cancels), leaving
// 0.08 cell before outlines.
export const INJECTED_QUBIT_RADIUS_FACTOR = 0.5;
export const INJECTED_QUBIT_OUTLINE_COLOR = 'rgb(70,70,70)';
export const INJECTED_QUBIT_OUTLINE_WIDTH = 1;
export const FRAME_DEFECT_COLOR = 'rgb(224,138,30)';

export function drawInjectedQubit(ctx, x, y, glyphSide) {
    ctx.save();
    ctx.fillStyle = INJECTED_QUBIT_COLOR;
    ctx.strokeStyle = INJECTED_QUBIT_OUTLINE_COLOR;
    ctx.lineWidth = INJECTED_QUBIT_OUTLINE_WIDTH;
    ctx.beginPath();
    ctx.arc(x, y, INJECTED_QUBIT_RADIUS_FACTOR * glyphSide, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

export function drawFrameDefect(ctx, x, y, glyphSide) {
    const radius = DEFECT_ORB_RADIUS * glyphSide;
    ctx.save();
    ctx.strokeStyle = FRAME_DEFECT_COLOR;
    ctx.lineWidth = Math.max(1, DEFECT_ORB_OUTLINE * glyphSide);
    ctx.beginPath();
    ctx.rect(x - radius, y - radius, 2 * radius, 2 * radius);
    ctx.stroke();
    ctx.restore();
}

function systemCheckGeometry(decoder, panel) {
    const inset = HTREE_BOUNDARY_INSET;
    const cellW = (panel.w - 2 * inset) / decoder.Lx;
    const cellH = (panel.h - 2 * inset) / decoder.Ly;
    return {
        glyphSide: Math.min(cellW, cellH) * HTREE_GLYPH_SIDE_RATIO,
        centerX: x => inset + (x + 0.5) * cellW,
        centerY: y => panel.h - inset - (y + 0.5) * cellH,
    };
}

const moveObservers = new WeakMap();

function protocolPresentation(Model, injection) {
    class ProtocolHTreePresentation extends Model {
        reset() {
            super.reset();
            SurfaceCGHTreeDecoder.prototype.restoreStepPresentation.call(this, null);
        }

        step(intervalOrObserver = HTREE_PULSE_MAX_MS) {
            const observer = typeof intervalOrObserver === 'function' ? intervalOrObserver : null;
            if (this.rejected) return;
            if (observer) moveObservers.set(this, observer);
            try {
                return SurfaceCGHTreeDecoder.prototype.step.call(this,
                    observer ? HTREE_PULSE_MAX_MS : intervalOrObserver);
            } finally {
                moveObservers.delete(this);
            }
        }

        _advanceDecoder(onMove) {
            return super.step(move => {
                onMove(move);
                moveObservers.get(this)?.(move);
            });
        }

        _layout(width, height, overlayRects) {
            let layout = SurfaceCGHTreeDecoder.prototype._layout.call(this, width, height, overlayRects);
            if (injection) {
                const leftShift = panel => {
                    const { glyphSide } = systemCheckGeometry(this, panel);
                    const extent = INJECTED_QUBIT_RADIUS_FACTOR * glyphSide
                        + INJECTED_QUBIT_OUTLINE_WIDTH / 2;
                    return Math.max(0, extent - panel.left - layout.lattice.left);
                };
                const [decoderPanel, systemPanel] = layout.panels;
                const systemRadius = INJECTED_QUBIT_RADIUS_FACTOR
                    * systemCheckGeometry(this, systemPanel).glyphSide;
                const overlapsSystemMarker = decoderPanel.top === systemPanel.top
                    && decoderPanel.left + decoderPanel.w + leftShift(decoderPanel)
                        > systemPanel.left + HTREE_BOUNDARY_INSET + leftShift(systemPanel)
                            - systemRadius - INJECTED_QUBIT_OUTLINE_WIDTH / 2;
                if (overlapsSystemMarker
                    || layout.panels.some(panel => panel.left + panel.w + leftShift(panel) > width)) {
                    // Reserve a shared gutter if translating a panel would
                    // clip a marker or consume the space around its neighbor.
                    const gutter = Math.max(...layout.panels.map(leftShift));
                    // A shared translation alone cannot enlarge the inter-panel gap.
                    // Reserve the system marker's excess extent before recomputing.
                    const extraGap = decoderPanel.top === systemPanel.top
                        ? Math.max(0, systemRadius + INJECTED_QUBIT_OUTLINE_WIDTH / 2
                            - HTREE_BOUNDARY_INSET
                            - (systemPanel.left - decoderPanel.left - decoderPanel.w)) : 0;
                    layout = SurfaceCGHTreeDecoder.prototype._layout.call(this,
                        width - gutter - extraGap, height, overlayRects);
                    const sideBySide = layout.panels[0].top === layout.panels[1].top;
                    layout.panels = layout.panels.map((panel, index) => ({ ...panel,
                        left: Math.min(width - panel.w,
                            panel.left + gutter + (sideBySide && index === 1 ? extraGap : 0)) }));
                    layout.stackCenterX += gutter;
                } else {
                    // Usually only the desktop decoder panel touches x=0.
                    // Translate it just enough to expose the complete circle
                    // and outline while keeping its center on the boundary.
                    layout.panels = layout.panels.map(panel => ({ ...panel, left: panel.left + leftShift(panel) }));
                }
            }
            const { lattice, cellW, cellH } = layout;
            // The model classifies each coarse site's physical block center:
            // top-left A_fr has x+y>=Ly-1, bottom-left A_fr has y<=x.
            // Shade and glyphs share that predicate, with diagonal qubits in
            // Q_X. Rectangles are local to the decoder panel's glyph sites.
            layout.absorbingSites = layout.levels.map((level, k) => level.sites
                .filter(site => this.isAbsorbingSite(k, site.rx, site.ry))
                .map(site => ({ ...site, level: k,
                    left: site.x - level.scale * cellW * PREP_INJECT_REGION_CELL_RATIO / 2,
                    top: site.y - level.scale * cellH * PREP_INJECT_REGION_CELL_RATIO / 2,
                    w: level.scale * cellW * PREP_INJECT_REGION_CELL_RATIO,
                    h: level.scale * cellH * PREP_INJECT_REGION_CELL_RATIO,
                })));
            // q_star is the left boundary qubit at the center of its check
            // row: top-left by default, bottom-left for the mirrored fixture.
            layout.qStarPoints = injection ? layout.panels.map(panel => {
                const { glyphSide, centerY } = systemCheckGeometry(this, panel);
                return {
                    x: panel.left + HTREE_BOUNDARY_INSET,
                    y: panel.top + centerY(this.qStar.y),
                    radius: INJECTED_QUBIT_RADIUS_FACTOR * glyphSide,
                    glyphSide,
                };
            }) : [];
            return layout;
        }

        // Read-only numerical geometry for canvas/browser checks. All boxes
        // are absolute canvas coordinates; no DOM or drawing state is read.
        getProtocolRenderGeometry(width, height, overlayRects) {
            const layout = this._layout(width, height, overlayRects);
            const panel = layout.panels[0];
            const system = layout.panels[1];
            const { glyphSide, centerX, centerY } = systemCheckGeometry(this, system);
            const frameFlipPoints = [];
            const frameDefectPoints = [];
            const psi = this.frameCommitted ? this.committedFrame : this.frame;
            const initialSyndrome = syndromeOpen(this.initialBx, this.initialBy, this.Lx, this.Ly);
            for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
                if (this.frameFlipMask[x][y]) frameFlipPoints.push({
                    physicalX: x, physicalY: y,
                    x: system.left + centerX(x), y: system.top + centerY(y),
                    radius: DEFECT_ORB_RADIUS * glyphSide,
                });
                if (psi[x][y] !== initialSyndrome[x][y]) frameDefectPoints.push({
                    physicalX: x, physicalY: y,
                    x: system.left + centerX(x), y: system.top + centerY(y),
                    radius: DEFECT_ORB_RADIUS * glyphSide,
                });
            }
            return {
                panels: layout.panels,
                frameFlipPoints,
                frameDefectPoints,
                absorbingSites: layout.absorbingSites.map(sites => sites.map(site => ({
                    ...site, x: panel.left + site.x, y: panel.top + site.y,
                    left: panel.left + site.left, top: panel.top + site.top,
                }))),
                qStarPoints: layout.qStarPoints,
            };
        }

        _getProtocolGlyphColors(level, rx, ry) {
            return this.isAbsorbingSite(level, rx, ry)
                ? PROTOCOL_ABSORBING_GLYPH_COLORS : null;
        }

        _drawProtocolRegions(ctx, layout) {
            if (!layout.absorbingSites.some(sites => sites.length)) return;
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, layout.panels[0].w, layout.panels[0].h); ctx.clip();
            ctx.fillStyle = PROTOCOL_ABSORBING_EDGE;
            ctx.globalAlpha = PROTOCOL_ABSORBING_WASH_OPACITY;
            for (const sites of layout.absorbingSites) {
                for (const site of sites) ctx.fillRect(site.left, site.top, site.w, site.h);
            }
            ctx.restore();
        }

        _drawProtocolGrid(ctx, layout) {
            // After the absorber is removed, use the original H-tree grid
            // verbatim. During the protocol, only streets touching an
            // absorbing site and funnels landing there change color.
            if (!layout.absorbingSites.some(sites => sites.length)) return false;
            const { lattice, cellW, cellH, levels, panels } = layout;
            const point = (level, rx, ry) => {
                const scale = this.n ** level;
                return [lattice.left + scale * (rx + 0.5) * cellW,
                    lattice.bottom - scale * (ry + 0.5) * cellH];
            };
            const line = (a, b) => { ctx.moveTo(...a); ctx.lineTo(...b); };
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, panels[0].w, panels[0].h); ctx.clip();
            ctx.globalAlpha = HTREE_STREET_OPACITY;
            ctx.lineWidth = HTREE_STREET_WIDTH;
            for (let k = 0; k < levels.length; k++) {
                const { sites, columns, rows } = levels[k];
                for (const absorbing of [false, true]) {
                    ctx.strokeStyle = absorbing ? PROTOCOL_ABSORBING_EDGE
                        : HTREE_LEVEL_COLORS[k % HTREE_LEVEL_COLORS.length];
                    ctx.beginPath();
                    for (const { x, y, rx, ry } of sites) {
                        const here = this.isAbsorbingSite(k, rx, ry);
                        if (rx + 1 < columns
                            && (here || this.isAbsorbingSite(k, rx + 1, ry)) === absorbing) {
                            line([x, y], point(k, rx + 1, ry));
                        }
                        if (ry + 1 < rows
                            && (here || this.isAbsorbingSite(k, rx, ry + 1)) === absorbing) {
                            line([x, y], point(k, rx, ry + 1));
                        }
                        if (here !== absorbing) continue;
                        if (rx === 0) line([lattice.left, y], [x, y]);
                        if (rx === columns - 1) line([x, y], [lattice.right, y]);
                        if (ry === 0) line([x, y], [x, lattice.bottom]);
                        if (ry === rows - 1) line([x, lattice.top], [x, y]);
                    }
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = HTREE_FUNNEL_OPACITY;
            ctx.lineWidth = HTREE_FUNNEL_WIDTH;
            for (let k = 1; k < levels.length; k++) {
                for (const absorbing of [false, true]) {
                    ctx.strokeStyle = absorbing ? PROTOCOL_ABSORBING_EDGE
                        : HTREE_FUNNEL_COLORS[(k - 1) % HTREE_FUNNEL_COLORS.length];
                    ctx.beginPath();
                    for (const parent of levels[k].sites) {
                        if (this.isAbsorbingSite(k, parent.rx, parent.ry) !== absorbing) continue;
                        const childY = ay => point(k - 1, 0, parent.ry * this.n + ay)[1];
                        line([parent.x, childY(0)], [parent.x, childY(this.n - 1)]);
                        for (let ay = 0; ay < this.n; ay++) {
                            for (let ax = 0; ax < this.n; ax++) {
                                const child = point(k - 1, parent.rx * this.n + ax, parent.ry * this.n + ay);
                                line(child, [parent.x, child[1]]);
                            }
                        }
                    }
                    ctx.stroke();
                }
            }
            ctx.restore();
            return true;
        }

        _drawResidualPanel(ctx, panel, showSyndrome, showErrors, showGrid) {
            const { residualX, residualY, syndrome } = this.getRawSystemResidual();
            // Draw b XOR E XOR b_0, including after a successful drain.
            // initialBx/initialBy retain the only first-round reference,
            // including after rejection. Keep the raw syndrome for defects below.
            const view = Object.create(this);
            view.bx = residualX.map((column, x) => column.map((bit, y) => bit !== this.initialBx[x][y]));
            view.by = residualY.map((column, x) => column.map((bit, y) => bit !== this.initialBy[x][y]));
            view.expandCorrection = () => ({
                Ex: residualX.map(column => column.map(() => false)),
                Ey: residualY.map(column => column.map(() => false)),
            });
            SurfaceCGHTreeDecoder.prototype._drawResidualPanel.call(view,
                ctx, panel, false, showErrors, showGrid);
            if (!showSyndrome) return;
            // Defects mean syndrome != psi. Frame defects mark where that
            // reference differs from the b_0-relative picture, including
            // first-round measurement errors before any wall absorption.
            const psi = this.frameCommitted ? this.committedFrame : this.frame;
            const initialSyndrome = syndromeOpen(this.initialBx, this.initialBy, this.Lx, this.Ly);
            const { glyphSide, centerX, centerY } = systemCheckGeometry(this, panel);
            ctx.save();
            ctx.translate(panel.left, panel.top);
            for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
                const cx = centerX(x), cy = centerY(y);
                if (syndrome[x][y] !== psi[x][y]) {
                    drawOrb(ctx, cx, cy, glyphSide, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
                if (psi[x][y] !== initialSyndrome[x][y]) drawFrameDefect(ctx, cx, cy, glyphSide);
            }
            ctx.restore();
        }

        render(ctx, width, height, options = {}) {
            SurfaceCGHTreeDecoder.prototype.render.call(this, ctx, width, height, options);
            if (!injection) return;
            const { qStarPoints } = this._layout(width, height, options.overlayRects);
            for (const { x, y, glyphSide } of qStarPoints) {
                drawInjectedQubit(ctx, x, y, glyphSide);
            }
        }
    }

    // Model methods retain their own superclass. Presentation methods with
    // no protocol override are the original methods, including the complete
    // move clock, pending-promotion pulses and history interpolation. The
    // _advanceDecoder hook above dispatches to this protocol's model step.
    for (const name of Object.getOwnPropertyNames(SurfaceCGHTreeDecoder.prototype)) {
        if (Object.hasOwn(ProtocolHTreePresentation.prototype, name)) continue;
        Object.defineProperty(ProtocolHTreePresentation.prototype, name,
            Object.getOwnPropertyDescriptor(SurfaceCGHTreeDecoder.prototype, name));
    }
    return ProtocolHTreePresentation;
}

export class SurfaceCGPrepHTreeDecoder extends protocolPresentation(SurfaceCGPrepDecoder, false) {}
export class SurfaceCGInjectHTreeDecoder extends protocolPresentation(SurfaceCGInjectDecoder, true) {}
