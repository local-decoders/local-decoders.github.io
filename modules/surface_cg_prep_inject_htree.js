// The state-preparation and state-injection models use the ordinary H-tree
// presentation and its movement/history clock. Only absorbing geometry and
// the distinguished injection qubit add paint. See main.tex:3708-3740 and
// 5548: the wall/region is implemented on each coarse lattice itself.
import { SurfaceCGPrepDecoder, SurfaceCGInjectDecoder } from './surface_cg_prep_inject.js';
import {
    SurfaceCGHTreeDecoder, HTREE_LEVEL_COLORS, HTREE_FUNNEL_COLORS, HTREE_PULSE_MAX_MS,
    HTREE_STREET_OPACITY, HTREE_STREET_WIDTH,
    HTREE_FUNNEL_OPACITY, HTREE_FUNNEL_WIDTH,
} from './surface_cg_htree.js';

export * from './surface_cg_htree.js';
export { PREP_WALL_M, INJECTION_DRIFT_PERIOD, INJECTION_CORNER,
    INJECTION_FRAME_OUTCOME_PROBABILITY } from './surface_cg_prep_inject.js';

export const PROTOCOL_ABSORBING_EDGE = '#9197a1';
export const PROTOCOL_ABSORBING_FILL = '#edf0f3';
export const PREPARATION_WALL_OPACITY = 0.10;
export const INJECTION_FRAME_SHADE = '#b8c8da';
export const INJECTION_FRAME_OPACITY = 0.16;
// A small gap exposes each absorbing site's own coarse-lattice footprint.
export const PREP_INJECT_REGION_CELL_RATIO = 0.94;
export const INJECTION_QSTAR_COLOR = '#b7791f';
export const INJECTION_QSTAR_RADIUS = 4;
export const INJECTION_QSTAR_OUTLINE_WIDTH = 1;

const moveObservers = new WeakMap();

function protocolPresentation(Model, injection) {
    class ProtocolHTreePresentation extends Model {
        reset() {
            super.reset();
            SurfaceCGHTreeDecoder.prototype.restoreStepPresentation.call(this, null);
        }

        step(intervalOrObserver = HTREE_PULSE_MAX_MS) {
            const observer = typeof intervalOrObserver === 'function' ? intervalOrObserver : null;
            const attempts = this.attempts;
            if (observer) moveObservers.set(this, observer);
            try {
                const result = SurfaceCGHTreeDecoder.prototype.step.call(this,
                    observer ? HTREE_PULSE_MAX_MS : intervalOrObserver);
                // A rejected attempt resets the model during its update.
                // Its outgoing flights must not repaint the fresh slices.
                if (this.attempts !== attempts) this.restoreStepPresentation(null);
                return result;
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
                const extent = INJECTION_QSTAR_RADIUS + INJECTION_QSTAR_OUTLINE_WIDTH / 2;
                const leftShift = panel => Math.max(0, extent - panel.left - layout.lattice.left);
                if (layout.panels.some(panel => panel.left + panel.w + leftShift(panel) > width)) {
                    // If a full-width panel has no room for the marker,
                    // obtain the same H-tree layout with the required gutter.
                    const gutter = Math.max(...layout.panels.map(leftShift));
                    layout = SurfaceCGHTreeDecoder.prototype._layout.call(this,
                        width - gutter, height, overlayRects);
                    layout.panels = layout.panels.map(panel => ({ ...panel, left: panel.left + gutter }));
                    layout.stackCenterX += gutter;
                } else {
                    // Usually only the desktop decoder panel touches x=0.
                    // Translate it by 2.5px: qstar stays on its true boundary,
                    // while the full 4px diamond and 1px outline remain visible.
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
            layout.qStarPoints = injection ? layout.panels.map(panel => ({
                x: panel.left + lattice.left,
                y: panel.top + lattice.bottom - (this.qStar.y + 0.5) * cellH,
                radius: INJECTION_QSTAR_RADIUS,
            })) : [];
            return layout;
        }

        // Read-only numerical geometry for canvas/browser checks. All boxes
        // are absolute canvas coordinates; no DOM or drawing state is read.
        getProtocolRenderGeometry(width, height, overlayRects) {
            const layout = this._layout(width, height, overlayRects);
            const panel = layout.panels[0];
            return {
                panels: layout.panels,
                absorbingSites: layout.absorbingSites.map(sites => sites.map(site => ({
                    ...site, x: panel.left + site.x, y: panel.top + site.y,
                    left: panel.left + site.left, top: panel.top + site.top,
                }))),
                qStarPoints: layout.qStarPoints,
            };
        }

        _getProtocolGlyphColors(level, rx, ry) {
            return this.isAbsorbingSite(level, rx, ry)
                ? { fill: PROTOCOL_ABSORBING_FILL, edge: PROTOCOL_ABSORBING_EDGE } : null;
        }

        _drawProtocolRegions(ctx, layout) {
            if (!layout.absorbingSites.some(sites => sites.length)) return;
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, layout.panels[0].w, layout.panels[0].h); ctx.clip();
            ctx.fillStyle = injection ? INJECTION_FRAME_SHADE : PROTOCOL_ABSORBING_EDGE;
            ctx.globalAlpha = injection ? INJECTION_FRAME_OPACITY : PREPARATION_WALL_OPACITY;
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
            const { residualX, residualY } = this.getSystemResidual();
            // Reuse the shared glyphs, strings and boundaries with a read-only
            // view of the frame-relative residual. Never temporarily replace
            // the decoder's raw bits or correction channels during a render.
            const view = Object.create(this);
            view.bx = residualX;
            view.by = residualY;
            view.expandCorrection = () => ({
                Ex: residualX.map(column => column.map(() => false)),
                Ey: residualY.map(column => column.map(() => false)),
            });
            SurfaceCGHTreeDecoder.prototype._drawResidualPanel.call(view,
                ctx, panel, showSyndrome, showErrors, showGrid);
        }

        render(ctx, width, height, options = {}) {
            SurfaceCGHTreeDecoder.prototype.render.call(this, ctx, width, height, options);
            if (!injection) return;
            const { qStarPoints } = this._layout(width, height, options.overlayRects);
            ctx.save();
            ctx.fillStyle = INJECTION_QSTAR_COLOR;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = INJECTION_QSTAR_OUTLINE_WIDTH;
            for (const { x, y, radius } of qStarPoints) {
                ctx.beginPath();
                ctx.moveTo(x, y - radius); ctx.lineTo(x + radius, y);
                ctx.lineTo(x, y + radius); ctx.lineTo(x - radius, y); ctx.closePath();
                ctx.fill(); ctx.stroke();
            }
            ctx.restore();
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
