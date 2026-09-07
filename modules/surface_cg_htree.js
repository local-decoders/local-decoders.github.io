// Glyph presentation of the hierarchical surface decoder. All
// simulation state and updates are inherited from SurfaceCGStreamingDecoder.
import {
    SurfaceCGStreamingDecoder, LEVEL_COLORS as ORIGINAL_LEVEL_COLORS,
    COLOR_ERROR, COLOR_CORRECTION, ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH, syndromeOpen,
} from './surface_cg_streaming.js';
import {
    drawOrb, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE, COLOR_GRID,
    CAPTION_SCALE, TLABEL_FONT_SIZE, anchorForCenteredInk,
} from './repetition2.js';
import { drawMessageCell } from './toric2.js';

// Match the original hierarchy palette. The HTML legend reads this alias.
export const HTREE_LEVEL_COLORS = [...ORIGINAL_LEVEL_COLORS];
export { HTREE_LEVEL_COLORS as LEVEL_COLORS };
export {
    COLOR_ORB_RIM, COLOR_ERROR, COLOR_CORRECTION,
    COLOR_MSG00_FILL, COLOR_MSG00_EDGE,
    COLOR_MSG01_FILL, COLOR_MSG01_EDGE,
    COLOR_MSG10_FILL, COLOR_MSG10_EDGE,
    ROUGH_BOUNDARY_COLOR, ROUGH_BOUNDARY_WIDTH,
} from './surface_cg_streaming.js';

export const HTREE_GLYPH_SIDE_RATIO = 0.42;
export const HTREE_CORNER_RADIUS_RATIO = 0.08;
export const HTREE_GLYPH_EDGE_WIDTH = 0.8;
// Lattice edges coincide with boundary stroke centres, keeping the full
// condensing stroke inside the unchanged panel rectangle.
export const HTREE_BOUNDARY_INSET = ROUGH_BOUNDARY_WIDTH / 2;
export const HTREE_SMOOTH_BOUNDARY_WIDTH = 1.3;
export const HTREE_FILL_TINT = 0.08;
export const HTREE_EDGE_COLOR_FACTOR = 1;
export const HTREE_STREET_OPACITY = 0.42;
export const HTREE_STREET_WIDTH = 0.85;
// Preserve the base renderer's residual string weights in CSS pixels.
export const HTREE_RESIDUAL_STRING_MIN_WIDTH = 2.1;
export const HTREE_RESIDUAL_STRING_PITCH_DIVISOR = 9;
export const HTREE_RESIDUAL_STRING_WIDTH_FACTOR = 1.05;
export const HTREE_FUNNEL_OPACITY = 0.42;
export const HTREE_FUNNEL_WIDTH = 1.2;
export const HTREE_PULSE_MIN_MS = 40;
export const HTREE_PULSE_MAX_MS = 350;
// Streets and condensations travel until the next level update, including
// one step at level 0. Disable to restore one wall-clock interval at every level.
export const HTREE_STREET_PULSE_STEPS_PER_LEVEL = true;
// A splitting slice shifts outward before streets and departures from shifted sites.
export const HTREE_SPLIT_PHASE_FRACTION = 0.5;
// Compatibility alias for the paused/manual duration.
export const HTREE_MOVE_HIGHLIGHT_MS = HTREE_PULSE_MAX_MS;
// Compatibility export only; all hierarchy movement uses correction green.
export const HTREE_MOVE_HIGHLIGHT_COLOR = 'rgb(175,55,55)';
export const HTREE_MOVE_HIGHLIGHT_COLOR_POSITIVE = COLOR_CORRECTION;
export const HTREE_MOVE_NEUTRAL_COLOR = COLOR_GRID;
export const HTREE_MOVE_HIGHLIGHT_WIDTH_FACTOR = 2.5;
// The comet occupies the trailing fraction of its source-to-target path.
export const HTREE_PULSE_HEAD_FRACTION = 0.45;
// Contract the tail into the destination over the final nominal tail length.
export const HTREE_PULSE_ABSORB = true;
export const HTREE_PULSE_WIDTH_FACTOR = 2.4;
// Change shown occupancy when the comet lands; opt in to waiting for the rule update.
export const HTREE_ARRIVAL_AT_STEP = false;
// Compatibility export: the old miniature landing remnant stays disabled.
export const HTREE_PULSE_LANDING_RADIUS_FACTOR = 0;
// Retain the original canvas height and its side-by-side/stacked choice.
export const HTREE_PREFERRED_CANVAS_HEIGHT = 650;
export const HTREE_PANEL_SHIFT_DOWN = 70;
export const HTREE_CAPTION_GAP = 14;
// Narrow panels reserve the unchanged caption ink below each boundary.
export const HTREE_NARROW_CAPTION_HEIGHT = 20;
export const HTREE_NARROW_PANEL_GAP = 40;
export const HTREE_NARROW_EDGE_MARGIN = 4;

let panelCaptionStyle;
function drawPanelCaptions(ctx, panels) {
    // Match repetition2's gutter font and colour, including its DOM-free
    // fallbacks; its full gutter helper also draws a two-line history block.
    if (!panelCaptionStyle) {
        const css = typeof document !== 'undefined' && typeof getComputedStyle === 'function'
            ? getComputedStyle(document.documentElement) : null;
        panelCaptionStyle = {
            font: css?.getPropertyValue('--font-mono').trim()
                || '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
            color: css?.getPropertyValue('--text-dim').trim() || '#6b7280',
        };
    }
    ctx.save();
    ctx.font = `${CAPTION_SCALE * TLABEL_FONT_SIZE}px ${panelCaptionStyle.font}`;
    ctx.fillStyle = panelCaptionStyle.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const [index, text] of ['decoder', 'system'].entries()) {
        const panel = panels[index];
        const metrics = ctx.measureText(text);
        const inkBottom = panel.top + panel.h - HTREE_BOUNDARY_INSET
            + HTREE_SMOOTH_BOUNDARY_WIDTH / 2;
        ctx.fillText(text, anchorForCenteredInk(panel.left + panel.w / 2, metrics),
            inkBottom + HTREE_CAPTION_GAP + metrics.actualBoundingBoxAscent);
    }
    ctx.restore();
}

// Presentation data stays outside the inherited simulation state. Coarse
// batches retain their step deadlines; each step snapshots its interpolation interval.
const movementPresentation = new WeakMap();
// Verdicts release the frozen step timeline without advancing decoder state.
// Keep this clock out of history so Back/redo can restore normal interpolation.
const finishedPresentation = new WeakMap();
// Back displays true occupancy, but a subsequent history capture must retain
// the forward presentation, including flights fired before the restored step.
const rewoundPresentation = new WeakMap();
const siteKey = ({ level, rx, ry }) => `${level}:${rx}:${ry}`;

function stepFraction(presentation, now, finished) {
    if (finished) return finished.fraction
        + Math.max(0, now - finished.startedAt) / finished.durationMs;
    return presentation?.startedAt === undefined
        || now >= presentation.startedAt + presentation.durationMs ? 1
        : Math.max(0, Math.min(1,
            (now - presentation.startedAt) / presentation.durationMs));
}

function movePending(move, step, now) {
    return move.arrivalStep === undefined ? now < move.expiresAt : step < move.arrivalStep;
}

// Arrivals finish on the clock unless site arrivals opt in to waiting for a
// rule update. Splits, boundaries, and verdict completion always use the clock.
function arrivalCoordinate(move, step, fraction, finished) {
    return step + (!HTREE_ARRIVAL_AT_STEP || finished || move.kind === 'split'
        || move.kind === 'boundary' || move.to.boundary ? fraction : 0);
}

// Compatibility helper for callers matching coarse occupancy changes.
// Travelling promotion pulses now come directly from the pending queue.
export function matchHTreePromotions(previousMaps, currentMaps, promotionArrivals = []) {
    const moves = [];
    const promotionGroups = new Map();
    for (const move of promotionArrivals) {
        const key = siteKey(move.to);
        if (!promotionGroups.has(key)) promotionGroups.set(key, []);
        promotionGroups.get(key).push(move);
    }
    for (const group of promotionGroups.values()) {
        const { from, to } = group[0];
        if (group.length % 2 === 1
            && !previousMaps[to.level][to.rx][to.ry]
            && currentMaps[to.level][to.rx][to.ry]) {
            moves.push({ from: { ...from }, to: { ...to }, kind: 'promotion' });
        }
    }
    return moves;
}

function mixColor(hex, factor, background = 0) {
    const rgb = hex.slice(1).match(/../g).map(channel =>
        Math.round(parseInt(channel, 16) * factor + background * (1 - factor)));
    return `rgb(${rgb.join(',')})`;
}

function glyphColors(color) {
    return { fill: mixColor(color, HTREE_FILL_TINT, 255),
        edge: mixColor(color, HTREE_EDGE_COLOR_FACTOR) };
}

function drawSiteGlyph(ctx, x, y, side, colors, mask = 0) {
    const left = x - side / 2, top = y - side / 2;
    ctx.beginPath();
    ctx.roundRect(left, top, side, side, side * HTREE_CORNER_RADIUS_RATIO);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    if (mask) {
        // Integer local bounds keep message tiles flush with the site fill.
        ctx.save();
        ctx.clip();
        ctx.translate(left, top);
        ctx.scale(side, side);
        drawMessageCell(ctx, 0, 0, 1, 1, mask);
        ctx.restore();
    }
    // The message helper changes the current path; rebuild the edge.
    ctx.beginPath();
    ctx.roundRect(left, top, side, side, side * HTREE_CORNER_RADIUS_RATIO);
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = HTREE_GLYPH_EDGE_WIDTH;
    ctx.stroke();
}

function latticeBounds(panel) {
    const inset = HTREE_BOUNDARY_INSET;
    return { left: inset, top: inset, right: panel.w - inset, bottom: panel.h - inset,
        w: panel.w - 2 * inset, h: panel.h - 2 * inset };
}

function drawLevelStreets(ctx, lattice, cellW, cellH, scale, columns, rows, color) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let rx = 0; rx < columns; rx++) {
        const x = lattice.left + scale * (rx + 0.5) * cellW;
        ctx.moveTo(x, lattice.top); ctx.lineTo(x, lattice.bottom);
    }
    for (let ry = 0; ry < rows; ry++) {
        const y = lattice.bottom - scale * (ry + 0.5) * cellH;
        ctx.moveTo(lattice.left, y); ctx.lineTo(lattice.right, y);
    }
    ctx.stroke();
}

// Ordered half-cell coordinates for each travelling pulse.
export function htreeMovePath({ from, to, kind }, n) {
    const point = ({ level, rx, ry }) => {
        const scale = n ** level;
        // Boundary targets sit half a level pitch beyond their source site.
        return [scale * (2 * rx + 1), scale * (2 * ry + 1)];
    };
    const start = point(from), end = point(to);
    return kind === 'promotion' ? [start, [end[0], start[1]], end] : [start, end];
}

// Use rendered pixel coordinates here so rectangular cells still give a
// constant speed through a funnel bend. Degenerate segments take no time.
export function htreePulsePosition(path, elapsedMs, durationMs = HTREE_PULSE_MAX_MS) {
    const progress = Math.max(0, Math.min(1, elapsedMs / durationMs));
    const lengths = path.slice(1).map((point, i) =>
        Math.hypot(point[0] - path[i][0], point[1] - path[i][1]));
    const length = lengths.reduce((sum, segment) => sum + segment, 0);
    const distance = progress * length;
    let remaining = distance;
    for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] > 0 && remaining <= lengths[i]) {
            const fraction = remaining / lengths[i];
            return { progress, distance, length, point: path[i].map((value, axis) =>
                value + fraction * (path[i + 1][axis] - value)) };
        }
        remaining -= lengths[i];
    }
    return { progress, distance, length, point: path.length ? [...path.at(-1)] : null };
}

function drawMovePulse(ctx, path, elapsedMs, durationMs) {
    const head = htreePulsePosition(path, elapsedMs, durationMs);
    if (!head.length || !head.point || head.progress >= 1) return;
    const nominalTailLength = head.length * HTREE_PULSE_HEAD_FRACTION;
    const tailLength = HTREE_PULSE_ABSORB
        ? Math.min(nominalTailLength, head.length - head.distance) : nominalTailLength;
    // Clip emergence at the source. On arrival the tail advances twice as
    // fast as the head, meeting it as the destination occupancy changes.
    const tailDistance = Math.max(0, head.distance - tailLength);
    let traversed = 0;
    ctx.lineCap = 'butt';
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const start = Math.max(tailDistance, traversed);
        const end = Math.min(head.distance, traversed + length);
        if (length > 0 && end > start) {
            const pointAt = distance => a.map((value, axis) =>
                value + (b[axis] - value) * (distance - traversed) / length);
            // Project the full tail onto each segment's axis; its opacity
            // stays continuous through bends, fading into the exposed wire.
            const gradient = ctx.createLinearGradient(...pointAt(tailDistance), ...pointAt(head.distance));
            gradient.addColorStop(0, `${COLOR_CORRECTION}00`);
            gradient.addColorStop(1, COLOR_CORRECTION);
            ctx.strokeStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(...pointAt(start)); ctx.lineTo(...pointAt(end));
            ctx.stroke();
        }
        traversed += length;
    }
    // During contraction the same head is drawn above the glyphs, below orbs,
    // keeping it visible until the exact instant the occupancy changes.
    if (HTREE_PULSE_ABSORB && head.progress >= 1 - HTREE_PULSE_HEAD_FRACTION) return;
    // A full-opacity round tip stays legible at the fine glyph pitch.
    ctx.fillStyle = COLOR_CORRECTION;
    ctx.beginPath();
    ctx.arc(...head.point, ctx.lineWidth / 2, 0, 2 * Math.PI);
    ctx.fill();
}

function drawPulseArrivalHead(ctx, path, elapsedMs, durationMs, landed = false) {
    const head = htreePulsePosition(path, elapsedMs, durationMs);
    if (!head.point || !head.length || (head.progress >= 1 && !landed)
        || (!landed && (!HTREE_PULSE_ABSORB
            || head.progress < 1 - HTREE_PULSE_HEAD_FRACTION))) return;
    ctx.fillStyle = COLOR_CORRECTION;
    ctx.beginPath();
    ctx.arc(...head.point, HTREE_STREET_WIDTH * HTREE_MOVE_HIGHLIGHT_WIDTH_FACTOR
        * HTREE_PULSE_WIDTH_FACTOR / 2, 0, 2 * Math.PI);
    ctx.fill();
}

// The rule has already applied these arrivals. XOR back each destination whose
// presentation has not reached its arrival coordinate yet, so
// every other true-state change, including source noise, appears immediately.
// Undo a delayed phase-2 departure until the split lands;
// the exact handoff displays the intermediate site before its next pulse leaves.
// Keep the unused first argument for existing callers.
export function htreeVisualDefectMaps(_previousMaps, currentMaps, moves, now, firedStep = now) {
    const visual = currentMaps.map(map => map.map(column => column.slice()));
    for (const move of moves) {
        const arrival = move.arrivalStep ?? move.expiresAt
            ?? move.startedAt + (move.durationMs ?? HTREE_PULSE_MAX_MS);
        const arrivalNow = move.kind === 'split' ? now : firedStep;
        if (arrivalNow < arrival && move.retainTo !== false
            && move.kind !== 'boundary' && !move.to.boundary) {
            const { level, rx, ry } = move.to;
            visual[level][rx][ry] = !visual[level][rx][ry];
        }
        const departure = move.departureStep ?? move.startedAt;
        if (move.deferDeparture && now <= departure) {
            const { level, rx, ry } = move.from;
            visual[level][rx][ry] = !visual[level][rx][ry];
        }
    }
    return visual;
}

// Intake is already at the parent even when its coarse rule has not fired.
// Display the buffered parity there without changing either rule field.
function intakeDefectMaps(slices) {
    return slices.map(slice => slice.rho
        ? slice.s.map((column, rx) => column.map((occupied, ry) => occupied !== slice.rho[rx][ry]))
        : slice.s);
}

function promotionFromRecord([level, rx, ry, ax, ay], arrivalT, n) {
    return {
        from: { level: level - 1, rx: rx * n + ax, ry: ry * n + ay },
        to: { level, rx, ry }, kind: 'promotion',
        departureT: arrivalT - n ** level - 1, arrivalT,
    };
}

export class SurfaceCGHTreeDecoder extends SurfaceCGStreamingDecoder {
    // Preserve the movement timeline separately from rule state. Occupancy
    // comes from restored true maps; promotions come from the restored queue.
    captureStepPresentation() {
        if (rewoundPresentation.has(this)) return rewoundPresentation.get(this);
        const presentation = movementPresentation.get(this);
        const record = move => ({ ...move, level: move.from.level,
            tFire: move.kind === 'promotion' ? move.departureT : move.step,
            durationSteps: move.durationSteps ?? (move.kind === 'promotion'
                ? move.arrivalT - move.departureT - 1 : 1),
        });
        return {
            startedAt: presentation?.startedAt, durationMs: presentation?.durationMs,
            arrivedPromotions: (presentation?.arrivedPromotions || []).map(record),
            splitPromotions: (presentation?.splitPromotions || []).map(record),
            highlights: (presentation?.highlights || []).map(record),
            batches: (presentation?.batches || []).map(batch => ({ ...batch,
                moves: batch.moves.map(record),
            })),
        };
    }

    restoreStepPresentation(presentation, { replay = false, stepIntervalMs = HTREE_PULSE_MAX_MS } = {}) {
        finishedPresentation.delete(this);
        if (!replay || presentation?.startedAt === undefined) {
            rewoundPresentation.set(this, presentation);
            movementPresentation.set(this, {
                arrivedPromotions: presentation?.arrivedPromotions || [], highlights: [], batches: [],
                splitPromotions: presentation?.splitPromotions || [],
            });
            return;
        }
        rewoundPresentation.delete(this);
        const now = performance.now();
        const durationMs = Math.max(HTREE_PULSE_MIN_MS, Math.min(HTREE_PULSE_MAX_MS, stepIntervalMs));
        // Step deadlines stay absolute. Rebase wall-clock events together so
        // overlapping fine moves keep their progress at this step's start.
        // Each old move has its own interval if speed changed between fires.
        const rearm = move => {
            if (move.startedAt === undefined) return { ...move };
            const moveDurationMs = move.arrivalStep === undefined
                ? durationMs * (move.phaseFraction ?? 1) : durationMs;
            const startedAt = move.arrivalStep === undefined
                ? now + (move.startedAt - presentation.startedAt) * moveDurationMs / move.durationMs : now;
            return { ...move, startedAt, durationMs: moveDurationMs,
                ...(move.expiresAt === undefined ? {} : {
                    expiresAt: startedAt + moveDurationMs,
                }),
            };
        };
        movementPresentation.set(this, {
            arrivedPromotions: presentation.arrivedPromotions || [],
            splitPromotions: presentation.splitPromotions || [],
            startedAt: now, durationMs,
            highlights: (presentation.highlights || []).map(rearm),
            batches: (presentation.batches || []).map(batch => ({ ...batch,
                moves: batch.moves.map(rearm),
            })),
        });
    }

    reset() {
        super.reset();
        movementPresentation.delete(this);
        rewoundPresentation.delete(this);
        finishedPresentation.delete(this);
    }

    finishRunPresentation(stepIntervalMs = HTREE_PULSE_MAX_MS, now = performance.now()) {
        if (finishedPresentation.has(this)) return;
        const presentation = movementPresentation.get(this) || { highlights: [], batches: [] };
        movementPresentation.set(this, presentation);
        finishedPresentation.set(this, {
            startedAt: now,
            fraction: stepFraction(presentation, now),
            durationMs: Math.max(HTREE_PULSE_MIN_MS, Math.min(HTREE_PULSE_MAX_MS, stepIntervalMs)),
        });
    }

    // Protocol presentations may supply a different model while retaining
    // this exact movement timeline. Ordinary instances still call the
    // same streaming update with the same observer.
    _advanceDecoder(onMove) {
        return super.step(onMove);
    }

    step(stepIntervalMs = HTREE_PULSE_MAX_MS) {
        finishedPresentation.delete(this);
        rewoundPresentation.delete(this);
        const presentation = movementPresentation.get(this) || { highlights: [], batches: [] };
        const due = this.pending.get(this.t + 1) || [];
        const arrivals = due.map(record => promotionFromRecord(record, this.t + 1, this.n));
        const splitLevels = new Set();
        if (this.t > 0 && this.t % this.qs === 0) {
            for (let level = 0; level < this.K; level++) {
                if (this.t % (this.n ** level) === 0) splitLevels.add(level);
            }
        }
        // Observe the base rule's actual candidates, including splitting.
        // A final map diff loses moves whose endpoints are replaced by noise,
        // annihilate, or move again within this same update.
        const moves = [];
        const result = this._advanceDecoder(move => moves.push(move));
        // Keep every endpoint for this intake step, including even-parity
        // arrivals. These never replay a child-to-parent within-step move.
        presentation.arrivedPromotions = arrivals;
        const now = performance.now();
        const durationMs = Math.max(HTREE_PULSE_MIN_MS, Math.min(HTREE_PULSE_MAX_MS, stepIntervalMs));
        presentation.startedAt = now;
        presentation.durationMs = durationMs;
        const shiftedSites = new Set(moves.filter(move => move.kind === 'split')
            .map(move => siteKey(move.to)));
        // Preserve the queued intake deadline, but a newly shifted child cannot
        // leave through its parent funnel until the split reaches that child.
        presentation.splitPromotions = (presentation.splitPromotions || [])
            .filter(move => this.t < move.arrivalT);
        for (const [arrivalT, records] of this.pending) {
            for (const record of records) {
                const promotion = promotionFromRecord(record, arrivalT, this.n);
                if (promotion.departureT === this.t - 1 && shiftedSites.has(siteKey(promotion.from))) {
                    presentation.splitPromotions.push({ ...promotion,
                        delaySteps: (HTREE_STREET_PULSE_STEPS_PER_LEVEL
                            ? this.n ** promotion.from.level : 1) * HTREE_SPLIT_PHASE_FRACTION });
                }
            }
        }
        const batchMoves = moves.map(move => {
            const windowSteps = HTREE_STREET_PULSE_STEPS_PER_LEVEL ? this.n ** move.from.level : 1;
            const delayed = (move.kind === 'street' && splitLevels.has(move.from.level))
                || (move.kind === 'boundary' && shiftedSites.has(siteKey(move.from)));
            const phaseOffset = delayed ? HTREE_SPLIT_PHASE_FRACTION : 0;
            const phaseFraction = move.kind === 'split' ? HTREE_SPLIT_PHASE_FRACTION
                : delayed ? 1 - HTREE_SPLIT_PHASE_FRACTION : 1;
            const durationSteps = windowSteps * phaseFraction;
            return { ...move, step: this.stepCount,
                // Boundary records consume the pre-split edge occupant. A
                // different defect may shift into that same site, so delaying
                // its boundary head must not undo another source departure.
                ...(delayed && move.kind === 'street' ? { deferDeparture: true } : {}),
                ...(HTREE_STREET_PULSE_STEPS_PER_LEVEL
                    ? { startedAt: now, durationMs, durationSteps,
                        departureStep: this.stepCount + windowSteps * phaseOffset,
                        arrivalStep: this.stepCount + windowSteps * (phaseOffset + phaseFraction) }
                    : { startedAt: now + durationMs * phaseOffset,
                        durationMs: durationMs * phaseFraction, phaseFraction,
                        expiresAt: now + durationMs * (phaseOffset + phaseFraction) }) };
        });
        presentation.highlights = presentation.highlights.filter(move => movePending(move, this.stepCount, now))
            .concat(batchMoves);
        // Only arrivals still pending in the presentation affect shown parity. Old
        // occupancy snapshots and delivered-intake events are unnecessary: the live rule maps
        // already include noise, subsequent departures, and buffered intake.
        presentation.batches = presentation.batches.map(batch => ({ ...batch,
            moves: batch.moves.filter(move => movePending(move, this.stepCount, now)),
        })).filter(batch => batch.moves.length);
        if (batchMoves.length) presentation.batches.push({ moves: batchMoves });
        movementPresentation.set(this, presentation);
        return result;
    }

    getMoveHighlights(now = performance.now()) {
        const presentation = movementPresentation.get(this);
        const finished = finishedPresentation.get(this);
        const fraction = stepFraction(presentation, now, finished);
        return (presentation?.highlights || []).flatMap(move => {
            if (move.arrivalStep === undefined) {
                return now >= move.startedAt && now < move.expiresAt ? [move] : [];
            }
            if (this.stepCount + fraction < move.departureStep
                || arrivalCoordinate(move, this.stepCount, fraction, finished) >= move.arrivalStep) return [];
            return [{ ...move,
                progress: Math.max(0, Math.min(1,
                    (this.stepCount - move.departureStep + fraction) / move.durationSteps)),
                opacity: 1 }];
        });
    }

    getPromotionPulses(now = performance.now()) {
        const presentation = movementPresentation.get(this);
        // A paused step advances one segment and then holds it. Restores
        // start settled, so a checkpoint renders the same paused position.
        const finished = finishedPresentation.get(this);
        const fraction = stepFraction(presentation, now, finished);
        const pulses = [];
        for (const [arrivalT, records] of this.pending) {
            for (const record of records) {
                const move = promotionFromRecord(record, arrivalT, this.n);
                // departureT is the base rule's pre-update t; this.t is
                // already departureT + 1 when that update has returned.
                // Start at the source then; absorption finishes at the end
                // of the interval immediately before the rule's intake update.
                if (this.t <= move.departureT || this.t >= arrivalT) continue;
                if ((!HTREE_ARRIVAL_AT_STEP || finished) && this.t + fraction >= arrivalT) continue;
                const delaySteps = presentation?.splitPromotions?.find(promotion =>
                    promotion.arrivalT === arrivalT && siteKey(promotion.from) === siteKey(move.from))
                    ?.delaySteps || 0;
                const elapsed = this.t - move.departureT - 1 + fraction - delaySteps;
                if (elapsed < 0) continue;
                const progress = Math.max(0, Math.min(1,
                    elapsed / (arrivalT - move.departureT - 1 - delaySteps)));
                pulses.push({ ...move, progress });
            }
        }
        return pulses;
    }

    getVisualDefectMaps(now = performance.now()) {
        const currentMaps = intakeDefectMaps(this.slices);
        const presentation = movementPresentation.get(this);
        const finished = finishedPresentation.get(this);
        const fraction = stepFraction(presentation, now, finished);
        const step = this.stepCount + fraction;
        // Pending intake has not changed the rule fields yet. Show its parity
        // at landing unless site arrivals opt in to waiting for the rule update.
        // Back still displays true occupancy; replay rearms the forward clock.
        const arrived = [];
        const deferred = [];
        if (presentation?.startedAt !== undefined || finished) {
            for (const [arrivalT, records] of this.pending) {
                if ((!HTREE_ARRIVAL_AT_STEP || finished) && this.t + fraction >= arrivalT) {
                    arrived.push(...records);
                }
            }
            for (const move of presentation?.splitPromotions || []) {
                if (this.t + fraction <= move.departureT + 1 + move.delaySteps) deferred.push(move.from);
            }
        }
        const showArrivals = visual => {
            if (!arrived.length && !deferred.length) return visual;
            const shown = visual.map(map => map.map(column => column.slice()));
            for (const [level, rx, ry] of arrived) shown[level][rx][ry] = !shown[level][rx][ry];
            for (const { level, rx, ry } of deferred) shown[level][rx][ry] = !shown[level][rx][ry];
            return shown;
        };
        const batches = presentation?.batches || [];
        if (!batches.some(batch => batch.moves.some(move =>
            movePending(move, arrivalCoordinate(move, this.stepCount, fraction, finished), now)))) {
            return showArrivals(currentMaps);
        }
        const moves = batches.flatMap(batch => batch.moves);
        const wallMoves = moves.filter(move => move.arrivalStep === undefined);
        const stepMoves = moves.filter(move => move.arrivalStep !== undefined);
        // Wall-clock events are used only when step scaling is disabled;
        // otherwise every level uses the same simulation-step timeline.
        const visual = htreeVisualDefectMaps(null, currentMaps, wallMoves, now);
        return showArrivals(htreeVisualDefectMaps(null, visual, stepMoves, step,
            HTREE_ARRIVAL_AT_STEP && !finished ? this.stepCount : step));
    }

    needsAnimationFrame(now = performance.now()) {
        // A render can straddle its deadline. If it painted a live pulse,
        // the shared scheduler still owes a frame that clears that paint.
        const presentation = movementPresentation.get(this);
        if (finishedPresentation.has(this)) return !!presentation?.paintedHighlights
            || this.getMoveHighlights(now).length > 0 || this.getPromotionPulses(now).length > 0;
        return !!presentation?.paintedHighlights
            || this.getMoveHighlights(now).some(move => move.arrivalStep === undefined
                || now < presentation.startedAt + presentation.durationMs)
            || (this.pending.size > 0 && presentation?.startedAt !== undefined
                && now < presentation.startedAt + presentation.durationMs);
    }

    _layout(canvasWidth, canvasHeight, overlayRects) {
        const layout = super._layout(canvasWidth, canvasHeight, overlayRects);
        if (overlayRects?.narrowLayout) {
            // The title is outside the narrow canvas, so its panels need
            // only the edge margin and the unchanged captions between them.
            const { panelGap } = SurfaceCGStreamingDecoder._CHROME;
            const topGap = HTREE_NARROW_EDGE_MARGIN;
            const aspect = this.Ly / this.Lx;
            const availW = canvasWidth - 2 * HTREE_NARROW_EDGE_MARGIN;
            const availH = canvasHeight - 2 * HTREE_NARROW_EDGE_MARGIN
                - HTREE_CAPTION_GAP - HTREE_NARROW_CAPTION_HEIGHT;
            const sideBySideW = Math.min((availW - panelGap) / 2, availH / aspect);
            const stackedW = Math.min(availW,
                (availH - HTREE_NARROW_PANEL_GAP) / (2 * aspect));
            const stacked = stackedW > sideBySideW;
            const w = stacked ? stackedW : sideBySideW;
            const h = w * aspect;
            const totalW = stacked ? w : 2 * w + panelGap;
            const left = (canvasWidth - totalW) / 2;
            layout.panels = [
                { left, top: topGap, w, h },
                { left: stacked ? left : left + w + panelGap,
                    top: stacked ? topGap + h + HTREE_NARROW_PANEL_GAP : topGap, w, h },
            ];
            layout.stackCenterX = canvasWidth / 2;
        } else {
            // Desktop retains its exact panel translation and local scale.
            layout.panels = layout.panels.map(panel => ({ ...panel,
                top: panel.top + HTREE_PANEL_SHIFT_DOWN }));
        }
        const panel = layout.panels[0];
        const lattice = latticeBounds(panel);
        const cellW = lattice.w / this.Lx, cellH = lattice.h / this.Ly;
        const levels = this.slices.map((slice, k) => {
            const scale = this.n ** k;
            const sites = [];
            for (let rx = 0; rx < slice.Lx; rx++) {
                for (let ry = 0; ry < slice.Ly; ry++) {
                    // Continuous block centres from fig:toric-coarse-grained-layout,
                    // with physical y increasing upward as in the original panel.
                    sites.push({ rx, ry,
                        x: lattice.left + scale * (rx + 0.5) * cellW,
                        y: lattice.bottom - scale * (ry + 0.5) * cellH });
                }
            }
            return { scale, columns: slice.Lx, rows: slice.Ly, sites };
        });
        return { ...layout, lattice, cellW, cellH,
            glyphSide: Math.min(cellW, cellH) * HTREE_GLYPH_SIDE_RATIO, levels };
    }

    getTitleAnchor(canvasWidth, canvasHeight, overlayRects) {
        return { centerX: this._layout(canvasWidth, canvasHeight, overlayRects).stackCenterX };
    }

    getPreferredCanvasHeight() {
        return HTREE_PREFERRED_CANVAS_HEIGHT;
    }

    getPreferredNarrowCanvasHeight(canvasWidth, maxHeight) {
        const { panels } = this._layout(canvasWidth, maxHeight,
            { noOverlayCards: true, narrowLayout: true });
        return Math.max(...panels.map(panel => panel.top + panel.h))
            + HTREE_CAPTION_GAP + HTREE_NARROW_CAPTION_HEIGHT + HTREE_NARROW_EDGE_MARGIN;
    }

    _drawPanelOutline(ctx, panel) {
        const lattice = latticeBounds(panel);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = HTREE_SMOOTH_BOUNDARY_WIDTH;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(0, lattice.top); ctx.lineTo(panel.w, lattice.top);
        ctx.moveTo(0, lattice.bottom); ctx.lineTo(panel.w, lattice.bottom);
        ctx.stroke();
    }

    _drawRoughBoundaries(ctx, panel) {
        const lattice = latticeBounds(panel);
        // Butt caps meet the smooth frame's outer edges without extending
        // beyond them. Both panels share these inset lattice bounds.
        const top = lattice.top - HTREE_SMOOTH_BOUNDARY_WIDTH / 2;
        const bottom = lattice.bottom + HTREE_SMOOTH_BOUNDARY_WIDTH / 2;
        ctx.strokeStyle = ROUGH_BOUNDARY_COLOR;
        ctx.lineWidth = ROUGH_BOUNDARY_WIDTH;
        ctx.lineCap = 'butt';
        for (const x of [lattice.left, lattice.right]) {
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        }
    }

    _drawLevel0Strings(ctx, panel, { Ex, Ey }) {
        const { Lx, Ly } = this;
        const lattice = latticeBounds(panel);
        const cellW = lattice.w / Lx, cellH = lattice.h / Ly;
        const centerX = x => lattice.left + (x + 0.5) * cellW;
        const centerY = y => lattice.bottom - (y + 0.5) * cellH;
        const edgeColor = (error, correction) => error !== correction ? COLOR_ERROR : null;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, panel.w, panel.h); ctx.clip();
        ctx.lineWidth = Math.max(HTREE_RESIDUAL_STRING_MIN_WIDTH,
            HTREE_RESIDUAL_STRING_WIDTH_FACTOR * Math.round(
                Math.min(cellW, cellH) / HTREE_RESIDUAL_STRING_PITCH_DIVISOR));
        ctx.lineCap = 'round';
        // Residual strings follow the level-0 streets, including the
        // boundary half streets. Corrected errors leave no string.
        for (let x = 0; x <= Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                const color = edgeColor(this.bx[x][y], Ex[x][y]);
                if (!color) continue;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(x === 0 ? lattice.left : centerX(x - 1), centerY(y));
                ctx.lineTo(x === Lx ? lattice.right : centerX(x), centerY(y));
                ctx.stroke();
            }
        }
        for (let x = 0; x < Lx; x++) {
            for (let y = 1; y < Ly; y++) {
                const color = edgeColor(this.by[x][y], Ey[x][y]);
                if (!color) continue;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(centerX(x), centerY(y - 1));
                ctx.lineTo(centerX(x), centerY(y));
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showMessages = options.showMessages === true;
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;
        const showGrid = options.showGrid !== false;
        const layout = this._layout(canvasWidth, canvasHeight, options.overlayRects);
        const { panels, lattice, cellW, cellH, glyphSide, levels } = layout;
        const panel = panels[0];
        const now = performance.now();
        const highlights = showSyndrome ? this.getMoveHighlights(now) : [];
        const promotions = showSyndrome ? this.getPromotionPulses(now) : [];
        const wirePoint = ([x, y]) => [lattice.left + x * cellW / 2, lattice.bottom - y * cellH / 2];

        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.save();
        ctx.translate(panel.left, panel.top);

        this._drawProtocolRegions?.(ctx, layout);

        if (showGrid && !this._drawProtocolGrid?.(ctx, layout)) {
            // Streets cross every site row and column, clipped to the full patch.
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, panel.w, panel.h); ctx.clip();
            ctx.globalAlpha = HTREE_STREET_OPACITY;
            ctx.lineWidth = HTREE_STREET_WIDTH;
            for (let k = 0; k < levels.length; k++) {
                const { scale, columns, rows } = levels[k];
                drawLevelStreets(ctx, lattice, cellW, cellH, scale, columns, rows,
                    HTREE_LEVEL_COLORS[k % HTREE_LEVEL_COLORS.length]);
            }

            // Each parent sits on a vertical bar spanning its n child rows.
            // Horizontal child-to-bar stubs form H funnels when n = 2.
            ctx.globalAlpha = HTREE_FUNNEL_OPACITY;
            ctx.lineWidth = HTREE_FUNNEL_WIDTH;
            for (let k = 1; k < levels.length; k++) {
                const childScale = levels[k - 1].scale;
                ctx.strokeStyle = HTREE_LEVEL_COLORS[(k - 1) % HTREE_LEVEL_COLORS.length];
                ctx.beginPath();
                for (const parent of levels[k].sites) {
                    const childY = ay => lattice.bottom -
                        childScale * (parent.ry * this.n + ay + 0.5) * cellH;
                    ctx.moveTo(parent.x, childY(0));
                    ctx.lineTo(parent.x, childY(this.n - 1));
                    for (let ay = 0; ay < this.n; ay++) {
                        for (let ax = 0; ax < this.n; ax++) {
                            const x = lattice.left + childScale * (parent.rx * this.n + ax + 0.5) * cellW;
                            const y = childY(ay);
                            ctx.moveTo(x, y); ctx.lineTo(parent.x, y);
                        }
                    }
                }
                ctx.stroke();
            }
            ctx.restore();
        }

        // Comets overlap as drawn; there is no static path or wire parity.
        // Opaque glyph fills keep the pulse on the exposed wires.
        if (highlights.length || promotions.length) {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, panel.w, panel.h); ctx.clip();
            ctx.globalAlpha = 1;
            ctx.lineWidth = HTREE_STREET_WIDTH * HTREE_MOVE_HIGHLIGHT_WIDTH_FACTOR * HTREE_PULSE_WIDTH_FACTOR;
            for (const move of highlights) {
                ctx.globalAlpha = move.opacity ?? 1;
                drawMovePulse(ctx, htreeMovePath(move, this.n).map(wirePoint),
                    move.progress ?? now - move.startedAt, move.progress === undefined ? move.durationMs : 1);
            }
            ctx.globalAlpha = 1;
            for (const move of promotions) {
                drawMovePulse(ctx, htreeMovePath(move, this.n).map(wirePoint), move.progress, 1);
            }
            ctx.restore();
        }

        for (let k = 0; k < levels.length; k++) {
            const color = HTREE_LEVEL_COLORS[k % HTREE_LEVEL_COLORS.length];
            const colors = glyphColors(color);
            const sl = this.slices[k];
            for (const { x, y, rx, ry } of levels[k].sites) {
                const mask = (sl.m[0][rx][ry] ? 1 : 0)
                    | (sl.m[1][rx][ry] ? 2 : 0) | (sl.m[2][rx][ry] ? 4 : 0);
                drawSiteGlyph(ctx, x, y, glyphSide,
                    this._getProtocolGlyphColors?.(k, rx, ry) ?? colors, showMessages ? mask : 0);
            }
        }

        // All wiring and message glyphs stay behind the boundaries.
        // Orbs get a separate final pass so neither a
        // boundary nor a later level's glyph can paint over a defect.
        this._drawPanelOutline(ctx, panel);
        // Keep the condensing colour continuous through the smooth corners.
        this._drawRoughBoundaries(ctx, panel);

        // Arriving heads cover the glyph fill, but a defect already shown
        // at the receiver stays on top until arrival clears both. Boundary
        // contacts have no orb; clip their heads at the absorbing panel edge.
        // Only the optional arrival-at-step mode holds a landed head until intake.
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, panel.w, panel.h); ctx.clip();
        for (const move of [...highlights, ...promotions]) {
            ctx.globalAlpha = move.opacity ?? 1;
            drawPulseArrivalHead(ctx, htreeMovePath(move, this.n).map(wirePoint),
                move.progress ?? now - move.startedAt, move.progress === undefined ? move.durationMs : 1,
                HTREE_ARRIVAL_AT_STEP && !finishedPresentation.has(this) && move.progress === 1
                    && move.kind !== 'split' && move.kind !== 'boundary' && !move.to.boundary);
        }
        ctx.restore();

        if (showSyndrome) {
            const visualMaps = this.getVisualDefectMaps(now);
            for (let k = 0; k < levels.length; k++) {
                for (const { x, y, rx, ry } of levels[k].sites) {
                    if (!visualMaps[k][rx][ry]) continue;
                    drawOrb(ctx, x, y, glyphSide, DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                }
            }
        }

        ctx.restore();
        this._drawResidualPanel(ctx, panels[1], showSyndrome, showErrors, showGrid);
        drawPanelCaptions(ctx, panels);
        ctx.restore();
        const presentation = movementPresentation.get(this);
        if (presentation) presentation.paintedHighlights = finishedPresentation.has(this)
            ? highlights.length > 0 || promotions.length > 0
            : highlights.some(move => move.arrivalStep === undefined
            || now < presentation.startedAt + presentation.durationMs)
            || (promotions.length > 0 && this.pending.size > 0 && presentation.startedAt !== undefined
                && now < presentation.startedAt + presentation.durationMs);
    }

    _drawResidualPanel(ctx, panel, showSyndrome, showErrors, showGrid) {
        const { Lx, Ly } = this;
        const lattice = latticeBounds(panel);
        const cellW = lattice.w / Lx, cellH = lattice.h / Ly;
        const cellMin = Math.min(cellW, cellH);
        const glyphSide = cellMin * HTREE_GLYPH_SIDE_RATIO;
        const color = HTREE_LEVEL_COLORS[0];
        const colors = glyphColors(color);
        const { Ex, Ey } = this.expandCorrection();
        const residualX = this.bx.map((column, x) => column.map((error, y) => error !== Ex[x][y]));
        const residualY = this.by.map((column, x) => column.map((error, y) => error !== Ey[x][y]));
        const residualSyndrome = syndromeOpen(residualX, residualY, Lx, Ly);
        const centerX = x => lattice.left + (x + 0.5) * cellW;
        const centerY = y => lattice.bottom - (y + 0.5) * cellH;

        ctx.save();
        ctx.translate(panel.left, panel.top);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, panel.w, panel.h); ctx.clip();
        if (showGrid) {
            ctx.save();
            ctx.globalAlpha = HTREE_STREET_OPACITY;
            ctx.lineWidth = HTREE_STREET_WIDTH;
            drawLevelStreets(ctx, lattice, cellW, cellH, 1, Lx, Ly, color);
            ctx.restore();
        }
        if (showErrors) this._drawLevel0Strings(ctx, panel, { Ex, Ey });
        ctx.restore();

        for (let x = 0; x < Lx; x++) {
            for (let y = 0; y < Ly; y++) {
                drawSiteGlyph(ctx, centerX(x), centerY(y), glyphSide, colors);
            }
        }
        // Match the hierarchy's layer order: wiring, glyphs, boundaries,
        // then defects. Residual sites have no coarse levels or timers.
        this._drawPanelOutline(ctx, panel);
        this._drawRoughBoundaries(ctx, panel);
        if (showSyndrome) {
            for (let x = 0; x < Lx; x++) {
                for (let y = 0; y < Ly; y++) {
                    if (residualSyndrome[x][y]) {
                        drawOrb(ctx, centerX(x), centerY(y), glyphSide,
                            DEFECT_ORB_RADIUS, DEFECT_ORB_OUTLINE);
                    }
                }
            }
        }
        ctx.restore();
    }
}
