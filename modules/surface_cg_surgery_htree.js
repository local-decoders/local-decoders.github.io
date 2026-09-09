// Two per-patch H trees, with the operation's geometry drawn independently
// at every scale. The simulation remains in surface_cg_surgery.js.
import { SurfaceCGSurgeryXDecoder, SurfaceCGSurgeryZDecoder } from './surface_cg_surgery.js';
import { SurfaceCGHTreeDecoder, HTREE_LEVEL_COLORS, HTREE_FUNNEL_COLORS, HTREE_BOUNDARY_INSET,
    HTREE_GLYPH_SIDE_RATIO, HTREE_STREET_OPACITY, HTREE_STREET_WIDTH, HTREE_TRANSIT_COLOR,
    HTREE_FUNNEL_OPACITY, HTREE_FUNNEL_WIDTH, HTREE_PULSE_MIN_MS,
    HTREE_PULSE_MAX_MS, HTREE_PULSE_HEAD_FRACTION, HTREE_MOVE_HIGHLIGHT_WIDTH_FACTOR,
    HTREE_PULSE_WIDTH_FACTOR, HTREE_SPLIT_PHASE_FRACTION, HTREE_CAPTION_GAP, HTREE_NARROW_CAPTION_HEIGHT,
    HTREE_NARROW_EDGE_MARGIN, HTREE_NARROW_PANEL_GAP, HTREE_SMOOTH_BOUNDARY_WIDTH,
    htreePulsePosition, htreeVisualDefectMaps, glyphColors, drawSiteGlyph, drawCondensingBoundary,
} from './surface_cg_htree.js';
import { syndromeOpen, COLOR_ERROR,
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH } from './surface_cg_streaming.js';
import { drawOrb, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE,
    CAPTION_SCALE, TLABEL_FONT_SIZE, anchorForCenteredInk } from './repetition2.js';

export * from './surface_cg_htree.js';
export { SURGERY_DEFAULT_SIZE, SURGERY_MAX_SIZE, SURGERY_SPACING_STEPS_PER_L,
    SURGERY_CONDENSING_M } from './surface_cg_surgery.js';
export const SURGERY_OPEN_SEAM_COLOR = '#8a9099';
export const SURGERY_OPEN_SEAM_WIDTH = 1.3;
export const SURGERY_OPEN_SEAM_DASH = 5;
export const SURGERY_OPEN_SEAM_GAP = 4;
export const SURGERY_SEAM_LEVEL_OFFSET_PX = 4;
export const SURGERY_PANEL_GAP = 18;
export const SURGERY_SEAM_SINGLE_LINE = true;
export const SURGERY_X_DRAW_JOINED_SEAM = false;
export const SURGERY_Z_DRAW_JOINED_SEAM = false;
export const SURGERY_Z_ROTATE_PRESENTATION = true;

const presentations = new WeakMap();
const pointKey = point => `${point.level}:${point.rx}:${point.ry}`;

function surgeryPresentation(Model) {
    return class extends Model {
        reset() {
            super.reset();
            presentations.delete(this);
        }

        step(intervalOrObserver = HTREE_PULSE_MAX_MS) {
            const observer = typeof intervalOrObserver === 'function' ? intervalOrObserver : null;
            const durationMs = Math.max(HTREE_PULSE_MIN_MS,
                Math.min(HTREE_PULSE_MAX_MS, observer ? HTREE_PULSE_MAX_MS : intervalOrObserver));
            const events = [];
            const result = super.step(move => { events.push(move); observer?.(move); });
            const startedAt = performance.now();
            const old = presentations.get(this);
            const shifted = new Set(events.filter(move => move.kind === 'split').map(move => pointKey(move.to)));
            const moves = (old?.moves || []).filter(move => this.stepCount < move.arrivalStep);
            for (const event of events) {
                const window = this.n ** event.from.level;
                const delayed = event.kind !== 'split' && shifted.has(pointKey(event.from));
                const phase = event.kind === 'split' || delayed ? HTREE_SPLIT_PHASE_FRACTION : 1;
                moves.push({ ...event, startedAt, durationMs,
                    departureStep: this.stepCount + (delayed ? window * phase : 0),
                    arrivalStep: this.stepCount + window,
                    durationSteps: window * phase,
                    ...(delayed && event.kind === 'street' ? { deferDeparture: true } : {}),
                });
            }
            presentations.set(this, { startedAt, durationMs, moves });
            return result;
        }

        captureStepPresentation() {
            const value = presentations.get(this);
            if (value?.rewound) return value.restoredRecord;
            return value ? { ...value, moves: value.moves.map(move => ({ ...move })) } : null;
        }

        restoreStepPresentation(value, { replay = false, stepIntervalMs = HTREE_PULSE_MAX_MS } = {}) {
            if (!value) { presentations.delete(this); return; }
            presentations.set(this, { ...value, moves: replay ? value.moves : [],
                startedAt: performance.now(),
                durationMs: Math.max(HTREE_PULSE_MIN_MS, Math.min(HTREE_PULSE_MAX_MS, stepIntervalMs)),
                rewound: !replay, restoredRecord: replay ? undefined : value,
                finished: false, painted: false });
        }

        finishRunPresentation(interval = HTREE_PULSE_MAX_MS, now = performance.now()) {
            const value = presentations.get(this);
            if (!value || value.finished) return;
            value.finishFraction = this._presentationFraction(now);
            value.startedAt = now; value.durationMs = interval; value.finished = true;
        }

        _presentationFraction(now) {
            const value = presentations.get(this);
            if (!value) return 1;
            const fraction = Math.max(0, (now - value.startedAt) / value.durationMs);
            return value.finished ? value.finishFraction + fraction : Math.min(1, fraction);
        }

        getMoveHighlights(now = performance.now()) {
            const value = presentations.get(this);
            const step = this.stepCount + this._presentationFraction(now);
            return (value?.moves || []).filter(move => step >= move.departureStep && step < move.arrivalStep)
                .map(move => ({ ...move, progress: (step - move.departureStep) / move.durationSteps }));
        }

        getPromotionPulses(now = performance.now()) {
            const fraction = this._presentationFraction(now);
            if (presentations.get(this)?.rewound) return [];
            const pulses = [];
            for (const [arrivalT, records] of this.pending) {
                for (const [level, rx, ry, ax, ay] of records) {
                    const departureT = arrivalT - this.n ** level - 1;
                    if (this.t <= departureT || this.t + fraction >= arrivalT) continue;
                    let childX = rx * this.n + ax;
                    if (this.sector === 'x' && level === 1 && rx >= this.L / this.n) childX++;
                    pulses.push({ from: { level: level - 1, rx: childX, ry: ry * this.n + ay },
                        to: { level, rx, ry }, kind: 'promotion',
                        progress: Math.max(0, (this.t - departureT - 1 + fraction)
                            / (arrivalT - departureT - 1)) });
                }
            }
            return pulses;
        }

        getVisualDefectMaps(now = performance.now()) {
            const maps = this.slices.map(slice => slice.rho
                ? slice.s.map((column, rx) => column.map((value, ry) => value !== slice.rho[rx][ry])) : slice.s);
            return htreeVisualDefectMaps(null, maps, presentations.get(this)?.moves || [],
                this.stepCount + this._presentationFraction(now));
        }

        needsAnimationFrame(now = performance.now()) {
            const value = presentations.get(this);
            if (!value) return false;
            const active = this.getMoveHighlights(now).length || this.getPromotionPulses(now).length;
            return !!value.painted || !!active && (value.finished || now < value.startedAt + value.durationMs);
        }

        // Continuous centers keep the two H trees independent. The extra
        // fine seam column belongs to A's final block when it is promoted.
        _siteCenter(level, rx, ry) {
            const scale = this.n ** level;
            const x = scale * (rx + 0.5)
                + (this.sector === 'x' && level > 0 && rx >= this.L / scale ? 1 : 0);
            return [x, scale * (ry + 0.5)];
        }

        get seamPresent() {
            return this.sector === 'x' ? !!this._seamPresent : !!this._seamQubitsPresent;
        }

        _layout(width, height, overlayRects) {
            const rotated = this.sector === 'z' && SURGERY_Z_ROTATE_PRESENTATION;
            const displayLx = rotated ? this.Ly : this.Lx;
            const displayLy = rotated ? this.Lx : this.Ly;
            // Only the presentation aspect changes. The model's dimensions,
            // slices, seam row and physical correction channels are untouched.
            const layout = SurfaceCGHTreeDecoder.prototype._layout.call({
                Lx: displayLx, Ly: displayLy, n: this.n, slices: this.slices,
            }, width, height, overlayRects);
            const captionReserve = HTREE_CAPTION_GAP + HTREE_NARROW_CAPTION_HEIGHT + HTREE_NARROW_EDGE_MARGIN;
            const panelGap = HTREE_CAPTION_GAP + HTREE_NARROW_CAPTION_HEIGHT + SURGERY_PANEL_GAP;
            if (overlayRects?.narrowLayout) {
                const availWidth = width - 2 * HTREE_NARROW_EDGE_MARGIN;
                const gap = Math.max(HTREE_NARROW_PANEL_GAP, panelGap);
                const availHeight = height - HTREE_NARROW_EDGE_MARGIN - captionReserve - gap;
                const w = Math.min(availWidth, availHeight / 2 * displayLx / displayLy);
                const h = w * displayLy / displayLx;
                layout.panels = [0, 1].map(index => ({ left: (width - w) / 2,
                    top: HTREE_NARROW_EDGE_MARGIN + index * (h + gap), w, h }));
            } else {
                const top = Math.min(...layout.panels.map(panel => panel.top));
                const bottom = Math.max(...layout.panels.map(panel => panel.top + panel.h));
                if (bottom + captionReserve > height) {
                    const ratio = Math.max(0, (height - top - captionReserve) / (bottom - top));
                    layout.panels = layout.panels.map(panel => ({
                        left: layout.stackCenterX + (panel.left - layout.stackCenterX) * ratio,
                        top: top + (panel.top - top) * ratio, w: panel.w * ratio, h: panel.h * ratio }));
                }
                const [decoder, system] = layout.panels;
                if (system.top > decoder.top) {
                    // Spend the unused space above the decoder. Preserve the
                    // system panel, its caption, both scales and canvas size.
                    decoder.top -= Math.max(0, panelGap - (system.top - decoder.top - decoder.h));
                }
            }
            const screenPanel = layout.panels[0], inset = HTREE_BOUNDARY_INSET;
            const panel = { w: rotated ? screenPanel.h : screenPanel.w,
                h: rotated ? screenPanel.w : screenPanel.h };
            const toScreen = ([x, y]) => rotated ? [panel.h - y, x] : [x, y];
            const lattice = { left: inset, top: inset, right: panel.w - inset, bottom: panel.h - inset,
                w: panel.w - 2 * inset, h: panel.h - 2 * inset };
            const cellW = lattice.w / this.Lx, cellH = lattice.h / this.Ly;
            Object.assign(layout, { lattice, cellW, cellH, rotated, drawingPanel: panel, toScreen,
                glyphSide: Math.min(cellW, cellH) * HTREE_GLYPH_SIDE_RATIO });
            layout.levels = this.slices.map((slice, level) => {
                const sites = [];
                for (let rx = 0; rx < slice.Lx; rx++) for (let ry = 0; ry < slice.Ly; ry++) {
                    const [x, y] = this._siteCenter(level, rx, ry);
                    const point = [lattice.left + x * cellW, lattice.bottom - y * cellH];
                    const [screenX, screenY] = toScreen(point);
                    sites.push({ rx, ry, x: point[0], y: point[1], screenX, screenY });
                }
                return { scale: this.n ** level, columns: slice.Lx, rows: slice.Ly, sites };
            });
            layout.seamLines = this.slices.slice(0, SURGERY_SEAM_SINGLE_LINE ? 1 : this.K).map((_, level) => {
                const offset = SURGERY_SEAM_SINGLE_LINE ? 0
                    : (level - (this.K - 1) / 2) * SURGERY_SEAM_LEVEL_OFFSET_PX;
                const geometry = this.seamGeometry(level);
                const vertical = this.sector === 'x';
                const coordinate = vertical ? lattice.left + (this.L + 0.5) * cellW + offset
                    : lattice.bottom - this.L * cellH + offset;
                return { level, geometry, condensing: vertical && geometry === 'split',
                    from: toScreen(vertical ? [coordinate, lattice.top] : [lattice.left, coordinate]),
                    to: toScreen(vertical ? [coordinate, lattice.bottom] : [lattice.right, coordinate]) };
            });
            return layout;
        }

        getTitleAnchor(width, height, overlayRects) {
            return { centerX: this._layout(width, height, overlayRects).stackCenterX };
        }

        getPreferredCanvasHeight() {
            return SurfaceCGHTreeDecoder.prototype.getPreferredCanvasHeight.call(this);
        }

        getPreferredNarrowCanvasHeight(width, height) {
            const { panels } = this._layout(width, height, { noOverlayCards: true, narrowLayout: true });
            return Math.max(...panels.map(panel => panel.top + panel.h))
                + HTREE_CAPTION_GAP + HTREE_NARROW_CAPTION_HEIGHT + HTREE_NARROW_EDGE_MARGIN;
        }

        _drawOuterBoundary(ctx, panel) {
            SurfaceCGHTreeDecoder.prototype._drawPanelOutline.call(this, ctx, panel);
            SurfaceCGHTreeDecoder.prototype._drawRoughBoundaries.call(this, ctx, panel);
        }

        _enterPanel(ctx, layout, index) {
            const panel = layout.panels[index];
            ctx.translate(panel.left, panel.top);
            if (layout.rotated) ctx.transform(0, 1, -1, 0, layout.drawingPanel.h, 0);
        }

        _wirePoint(layout, { level, rx, ry, boundary }) {
            const { lattice, cellW, cellH } = layout;
            const [x, y] = this._siteCenter(level, rx, ry);
            const point = [lattice.left + x * cellW, lattice.bottom - y * cellH];
            if (boundary === 'left') point[0] = lattice.left;
            if (boundary === 'right') point[0] = lattice.right;
            if (boundary === 'seam') {
                if (this.sector === 'x') point[0] = lattice.left + (this.L + 0.5) * cellW;
                else point[1] = lattice.bottom - this.L * cellH;
            }
            return point;
        }

        _boundaryWires(layout, level) {
            const { sites, columns, rows, scale } = layout.levels[level];
            const { lattice } = layout;
            const wires = [];
            for (const site of sites) {
                if (this.sector === 'x' && level === 0 && site.rx === this.L && !this.seamPresent) continue;
                const from = [site.x, site.y];
                for (const [edge, adjacent] of [['left', site.rx === 0], ['right', site.rx === columns - 1],
                    ['seam', this.sector === 'x' && this.seamGeometry(0) === 'split'
                        && (site.rx === this.L / scale - 1 || site.rx === this.L / scale + (level === 0 ? 1 : 0))]]) {
                    if (adjacent) wires.push({ from, to: this._wirePoint(layout,
                        { level, rx: site.rx, ry: site.ry, boundary: edge }), boundary: edge });
                }
                // The hierarchical streets also meet the smooth outer edges.
                if (site.ry === 0) wires.push({ from, to: [site.x, lattice.bottom] });
                if (site.ry === rows - 1) wires.push({ from, to: [site.x, lattice.top] });
            }
            return wires;
        }

        _drawSeam(ctx, layout, level, physical = false) {
            const { lattice, cellW, cellH } = layout;
            const geometry = physical ? (this.seamPresent ? 'merged' : 'split') : this.seamGeometry(level);
            const drawJoinedSeam = this.sector === 'x' ? SURGERY_X_DRAW_JOINED_SEAM : SURGERY_Z_DRAW_JOINED_SEAM;
            if (geometry === 'merged' && !drawJoinedSeam) return;
            const offset = physical || SURGERY_SEAM_SINGLE_LINE ? 0
                : (level - (this.K - 1) / 2) * SURGERY_SEAM_LEVEL_OFFSET_PX;
            const condensing = this.sector === 'x' && geometry === 'split';
            if (condensing) {
                const x = lattice.left + (this.L + 0.5) * cellW + offset;
                // The split seam absorbs into both adjacent patches; share
                // the same inward decoration as their outer boundaries.
                drawCondensingBoundary(ctx, x, lattice.top, x, lattice.bottom,
                    Math.min(cellW, cellH), 1, 0, undefined, true);
                return;
            }
            ctx.save();
            ctx.strokeStyle = condensing ? ROUGH_BOUNDARY_COLOR
                : geometry === 'split' ? '#000000' : SURGERY_OPEN_SEAM_COLOR;
            ctx.lineWidth = condensing ? ROUGH_BOUNDARY_WIDTH
                : geometry === 'split' ? HTREE_SMOOTH_BOUNDARY_WIDTH : SURGERY_OPEN_SEAM_WIDTH;
            ctx.setLineDash(geometry === 'merged' ? [SURGERY_OPEN_SEAM_DASH, SURGERY_OPEN_SEAM_GAP] : []);
            ctx.lineCap = 'butt';
            ctx.beginPath();
            if (this.sector === 'x') {
                const x = lattice.left + (this.L + 0.5) * cellW + offset;
                ctx.moveTo(x, lattice.top); ctx.lineTo(x, lattice.bottom);
            } else {
                const y = lattice.bottom - this.L * cellH + offset;
                ctx.moveTo(lattice.left, y); ctx.lineTo(lattice.right, y);
            }
            ctx.stroke(); ctx.restore();
        }

        _drawPulse(ctx, path, progress) {
            const head = htreePulsePosition(path, progress, 1);
            if (!head.length || progress >= 1) return;
            const tail = Math.max(0, head.distance - Math.min(head.length * HTREE_PULSE_HEAD_FRACTION,
                head.length - head.distance));
            let travelled = 0;
            ctx.lineWidth = HTREE_STREET_WIDTH * HTREE_MOVE_HIGHLIGHT_WIDTH_FACTOR * HTREE_PULSE_WIDTH_FACTOR;
            for (let i = 1; i < path.length; i++) {
                const a = path[i - 1], b = path[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const start = Math.max(tail, travelled), end = Math.min(head.distance, travelled + length);
                if (length && start < end) {
                    const at = distance => a.map((value, axis) => value + (b[axis] - value) * (distance - travelled) / length);
                    const gradient = ctx.createLinearGradient(...at(tail), ...at(head.distance));
                    gradient.addColorStop(0, HTREE_TRANSIT_COLOR.replace('rgb(', 'rgba(').replace(')', ',0)'));
                    gradient.addColorStop(1, HTREE_TRANSIT_COLOR);
                    ctx.strokeStyle = gradient; ctx.beginPath(); ctx.moveTo(...at(start)); ctx.lineTo(...at(end)); ctx.stroke();
                }
                travelled += length;
            }
        }

        render(ctx, width, height, options = {}) {
            const showGrid = options.showGrid !== false, showSyndrome = options.showSyndrome !== false;
            const layout = this._layout(width, height, options.overlayRects);
            const { panels, drawingPanel, glyphSide, levels } = layout;
            const now = performance.now();
            const moves = showSyndrome ? [...this.getMoveHighlights(now), ...this.getPromotionPulses(now)] : [];
            const point = endpoint => this._wirePoint(layout, endpoint);
            ctx.save(); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
            ctx.save(); this._enterPanel(ctx, layout, 0);
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, drawingPanel.w, drawingPanel.h); ctx.clip();
            if (showGrid) {
                for (let k = 0; k < this.K; k++) {
                    const slice = this.slices[k];
                    ctx.globalAlpha = HTREE_STREET_OPACITY; ctx.strokeStyle = HTREE_LEVEL_COLORS[k % HTREE_LEVEL_COLORS.length];
                    ctx.lineWidth = HTREE_STREET_WIDTH; ctx.beginPath();
                    for (const site of levels[k].sites) {
                        if (this.sector === 'x' && k === 0 && site.rx === this.L && !this.seamPresent) continue;
                        for (const [dx, dy] of [[1, 0], [0, 1]]) {
                            const nx = site.rx + dx, ny = site.ry + dy;
                            if (nx >= slice.Lx || ny >= slice.Ly) continue;
                            const crosses = this.sector === 'z' ? dy && ny === this.L / levels[k].scale
                                : dx && (k === 0 ? nx === this.L || nx === this.L + 1 : nx === this.L / levels[k].scale);
                            if (crosses && this.seamGeometry(k) === 'split') continue;
                            ctx.moveTo(site.x, site.y); ctx.lineTo(...point({ level: k, rx: nx, ry: ny }));
                        }
                    }
                    for (const wire of this._boundaryWires(layout, k)) {
                        ctx.moveTo(...wire.from); ctx.lineTo(...wire.to);
                    }
                    ctx.stroke();
                }
                ctx.globalAlpha = HTREE_FUNNEL_OPACITY; ctx.lineWidth = HTREE_FUNNEL_WIDTH;
                for (let k = 1; k < this.K; k++) {
                    ctx.strokeStyle = HTREE_FUNNEL_COLORS[(k - 1) % HTREE_FUNNEL_COLORS.length]; ctx.beginPath();
                    for (const parent of levels[k].sites) {
                        // One parent bar and horizontal child stubs, exactly
                        // as in the hierarchical renderer's H funnels.
                        const childY = ay => point({ level: k - 1, rx: 0, ry: parent.ry * this.n + ay })[1];
                        ctx.moveTo(parent.x, childY(0)); ctx.lineTo(parent.x, childY(this.n - 1));
                        for (let ax = 0; ax < this.n; ax++) for (let ay = 0; ay < this.n; ay++) {
                            let rx = parent.rx * this.n + ax;
                            if (this.sector === 'x' && k === 1 && parent.rx >= this.L / this.n) rx++;
                            const child = point({ level: k - 1, rx, ry: parent.ry * this.n + ay });
                            ctx.moveTo(...child); ctx.lineTo(parent.x, child[1]);
                        }
                        // The new fine seam column is an additional child
                        // of A's last block, as its promotion records specify.
                        if (this.sector === 'x' && k === 1 && this.seamPresent
                            && parent.rx === this.L / this.n - 1) {
                            for (let ay = 0; ay < this.n; ay++) {
                                const child = point({ level: 0, rx: this.L, ry: parent.ry * this.n + ay });
                                ctx.moveTo(...child); ctx.lineTo(parent.x, child[1]);
                            }
                        }
                    }
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;
            // Boundary decoration sits beneath moving defects and glyphs.
            this._drawOuterBoundary(ctx, drawingPanel);
            for (const { level } of layout.seamLines) this._drawSeam(ctx, layout, level);
            for (const move of moves) {
                const from = point(move.from), to = point(move.to);
                this._drawPulse(ctx, move.kind === 'promotion' ? [from, [to[0], from[1]], to] : [from, to], move.progress);
            }
            ctx.restore();
            for (let k = 0; k < this.K; k++) {
                const sl = this.slices[k], colors = glyphColors(HTREE_LEVEL_COLORS[k % HTREE_LEVEL_COLORS.length]);
                for (const { x, y, rx, ry } of levels[k].sites) {
                    if (this.sector === 'x' && k === 0 && rx === this.L && !this.seamPresent) continue;
                    const mask = options.showMessages ? (sl.m[0][rx][ry] ? 1 : 0)
                        | (sl.m[1][rx][ry] ? 2 : 0) | (sl.m[2][rx][ry] ? 4 : 0) : 0;
                    drawSiteGlyph(ctx, x, y, glyphSide, colors, mask);
                }
            }
            if (showSyndrome) {
                const maps = this.getVisualDefectMaps(now);
                for (let k = 0; k < this.K; k++) for (const site of levels[k].sites) {
                    if (maps[k][site.rx][site.ry]) drawOrb(ctx, site.x, site.y, glyphSide, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
            }
            ctx.restore();
            this._drawSurgeryResidual(ctx, layout, options);
            ctx.font = `${CAPTION_SCALE * TLABEL_FONT_SIZE}px "JetBrains Mono", monospace`;
            ctx.fillStyle = '#6b7280'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            for (const [i, caption] of ['decoder', 'system'].entries()) {
                const panel = panels[i], metrics = ctx.measureText(caption);
                ctx.fillText(caption, anchorForCenteredInk(panel.left + panel.w / 2, metrics),
                    panel.top + panel.h - HTREE_BOUNDARY_INSET + HTREE_SMOOTH_BOUNDARY_WIDTH / 2
                    + HTREE_CAPTION_GAP + metrics.actualBoundingBoxAscent);
            }
            ctx.restore();
            const value = presentations.get(this);
            if (value) value.painted = moves.length > 0 && (value.finished || now < value.startedAt + value.durationMs);
        }

        _drawSurgeryResidual(ctx, layout, options) {
            const { lattice, cellW, cellH, glyphSide, drawingPanel: panel } = layout;
            const colors = glyphColors(HTREE_LEVEL_COLORS[0]);
            const corrections = this.expandCorrection();
            const residualX = this.bx.map((column, x) => column.map((bit, y) => bit !== corrections.Ex[x][y]));
            const residualY = this.by.map((column, x) => column.map((bit, y) => bit !== corrections.Ey[x][y]));
            const syndrome = typeof this.getResidualSyndrome === 'function' ? this.getResidualSyndrome()
                : syndromeOpen(residualX, residualY, this.Lx, this.Ly);
            ctx.save(); this._enterPanel(ctx, layout, 1);
            if (options.showGrid !== false) {
                ctx.strokeStyle = HTREE_LEVEL_COLORS[0]; ctx.globalAlpha = HTREE_STREET_OPACITY;
                ctx.lineWidth = HTREE_STREET_WIDTH; ctx.beginPath();
                for (let x = 0; x < this.Lx; x++) {
                    if (this.sector === 'x' && x === this.L && !this.seamPresent) continue;
                    const px = lattice.left + (x + 0.5) * cellW;
                    ctx.moveTo(px, lattice.top); ctx.lineTo(px, lattice.bottom);
                }
                for (let y = 0; y < this.Ly; y++) {
                    const py = lattice.bottom - (y + 0.5) * cellH;
                    ctx.moveTo(lattice.left, py); ctx.lineTo(lattice.right, py);
                }
                ctx.stroke(); ctx.globalAlpha = 1;
            }
            SurfaceCGHTreeDecoder.prototype._drawPanelOutline.call(this, ctx, panel);
            const condensingSeam = this.sector === 'x' && !this.seamPresent;
            if (!condensingSeam) this._drawSeam(ctx, layout, 0, true);
            if (options.showErrors !== false) {
                // Removed seam qubits are absent from the system picture;
                // retained correction channels still contribute to its frame.
                if (!this.seamPresent) {
                    if (this.sector === 'z') for (let x = 0; x < this.L; x++) corrections.Ey[x][this.L] = this.by[x][this.L];
                    else corrections.Ey[this.L] = this.by[this.L].slice();
                }
                SurfaceCGHTreeDecoder.prototype._drawLevel0Strings.call(this, ctx, panel, corrections);
            }
            // Condensing edges and the seam cover residual-string contacts.
            SurfaceCGHTreeDecoder.prototype._drawRoughBoundaries.call(this, ctx, panel);
            if (condensingSeam) this._drawSeam(ctx, layout, 0, true);
            for (let x = 0; x < this.Lx; x++) for (let y = 0; y < this.Ly; y++) {
                if (this.sector === 'x' && x === this.L && !this.seamPresent) continue;
                const px = lattice.left + (x + 0.5) * cellW, py = lattice.bottom - (y + 0.5) * cellH;
                drawSiteGlyph(ctx, px, py, glyphSide, colors, 0);
                if (options.showSyndrome !== false && syndrome[x][y]) drawOrb(ctx, px, py, glyphSide, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
            }
            ctx.restore();
        }
    };
}

export class SurfaceCGSurgeryXHTreeDecoder extends surgeryPresentation(SurfaceCGSurgeryXDecoder) {}
export class SurfaceCGSurgeryZHTreeDecoder extends surgeryPresentation(SurfaceCGSurgeryZDecoder) {}
