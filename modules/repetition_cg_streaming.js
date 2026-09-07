// Repetition Code Streaming Decoder Module (Coarse-Grained / Hierarchical)
//
// Literal JS port of anim/cg_streaming_rep.py, itself a literal
// transcription of the paper's hierarchical repetition-code streaming
// decoder (local-comp-numerics/reference/paper/main.tex, Sec.
// "Constant-resource-density streaming decoders", 4516-4627, and Sec.
// "Hierarchical repetition-code decoder", 4628-4891):
//   - Algorithm alg:cm-rep-defect-record-intake (4726-4759) -> defectRecordIntake
//   - Algorithm alg:cm-rep-defect-update        (4769-4848) -> defectUpdate
//   - Algorithm alg:cm-rep-message-update        (4849-4891) -> messageUpdate
// See anim/cg_streaming_rep.py's module docstring for full context,
// including the base rule it reduces to at K=1 (Algorithm alg:rep-code,
// main.tex 2128-2195; oracle: local-comp-numerics/repca/reference.py) and
// the two places the paper leaves a choice open (the "fixed correction
// string" tie-break in `shorterArc`, and the t0=8/q=2 numeric defaults).
//
// This module never imports numpy-side code; it is a from-scratch,
// self-contained port using the *same* variable names and update order as
// the Python reference, so the two can be checked step-by-step against
// each other by feeding both the exact same phi history (see
// `setPhiHistoryForTesting` below and website/tests/check_cg_streaming_rep.mjs) --
// a live mulberry32 stream and numpy's default_rng can never be made to
// agree bit-for-bit, so cross-checking is done on phi as the shared input,
// not on the noise generators themselves.
//
// Rendering follows website/modules/repetition2.js's conventions (serif
// font stack, message/defect/error colors, orb + grid-line helpers), drawn
// as the paper's Fig. "coarse-grained-hierarchy": slice 0 (full physical
// resolution) at the bottom of a pyramid, coarser slices stacked above it
// with proportionally wider cells, then a separator, the residual row, and
// a FUTURE panel of pre-generated upcoming detector rounds peeling upward
// into the decoder as steps are taken.

const FONT_SERIF = '"Latin Modern Roman", "CMU Serif", "Times New Roman", serif';
const COLOR_MSG_FILL = 'rgb(200,210,248)';
const COLOR_MSG_EDGE = 'rgb(120,135,220)';
const COLOR_GRID = 'rgb(128,128,128)';
const COLOR_ERROR = 'rgb(175,55,55)';
const COLOR_ORB_RIM = 'rgb(82,82,82)';
const COLOR_TIMER_ARC = 'rgb(205,120,35)';
const COLOR_GUIDE = 'rgb(170,170,170)';
const LEGEND_FONT_SIZE = 13;

// ---------------------------------------------------------------------------
// Seeded PRNG (same mulberry32 as website/js/main.js's `&seed=` support).
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mod(a, m) {
    return ((a % m) + m) % m;
}

// ---------------------------------------------------------------------------
// Physical-noise-to-detector-event computation: pure function, exported
// standalone (not just inlined in _generateRound) so it can be exercised
// directly against a raw (not phi-injected) dataFlip/measFlip history for
// cross-language testing (website/tests/check_cg_streaming_rep.mjs). This
// is the exact formula from the task's noise model: b_t(x) = b_{t-1}(x)
// xor dataFlip_t(x) (cumulative data-qubit bit flips), stilde_t(x) =
// b_t(x) xor b_t(x+1) xor measFlip_t(x) (fresh per round), phi_t(x) =
// stilde_t(x) xor stilde_{t-1}(x). Every cross-language check up to now
// injected a pre-computed phi history directly (setPhiHistoryForTesting),
// which never exercised this function at all -- a wrong term here (e.g.
// the wrong neighbor, or omitting measFlip) would go undetected by any of
// those checks, exactly the failure mode this function's own dedicated
// check (in check_cg_streaming_rep.mjs) targets.
function advanceNoise(prevB, prevSTilde, dataFlip, measFlip, L) {
    const b = new Array(L);
    for (let x = 0; x < L; x++) b[x] = prevB[x] ^ dataFlip[x];
    const sTilde = new Array(L);
    for (let x = 0; x < L; x++) sTilde[x] = b[x] ^ b[(x + 1) % L] ^ measFlip[x];
    const phi = new Array(L);
    for (let x = 0; x < L; x++) phi[x] = sTilde[x] ^ prevSTilde[x];
    return { b, sTilde, phi };
}

// ---------------------------------------------------------------------------
// Geometry: Lambda_0, ..., Lambda_{K-1}, the identification psi_k, and the
// fixed physical-qubit correction strings (main.tex 4628-4680). Literal
// port of anim.cg_streaming_rep.{shorterArc,build_geometry}.
// ---------------------------------------------------------------------------

function shorterArc(p1, p2, L) {
    const lo = Math.min(p1, p2);
    const hi = Math.max(p1, p2);
    const fwd = hi - lo;
    const bwd = L - fwd;
    const arc = [];
    if (fwd <= bwd) {
        for (let j = 0; j < fwd; j++) arc.push((lo + 1 + j) % L);
    } else {
        for (let j = 0; j < bwd; j++) arc.push((hi + 1 + j) % L);
    }
    return arc;
}

function buildGeometry(L, K, n) {
    if (L % (n ** K) !== 0) {
        throw new Error(`L=${L} must be divisible by n**K=${n ** K}`);
    }
    const size = [];
    for (let k = 0; k < K; k++) size.push(L / (n ** k));

    const psi = [];
    for (let k = 0; k < K; k++) {
        const block = n ** k;
        const row = new Array(size[k]);
        for (let x = 0; x < size[k]; x++) row[x] = mod(block * x + Math.floor(block / 2), L);
        psi.push(row);
    }

    const arcSame = [];
    for (let k = 0; k < K; k++) {
        const sk = size[k];
        const row = [];
        for (let x = 0; x < sk; x++) {
            const xLeft = mod(x - 1, sk);
            row.push(shorterArc(psi[k][xLeft], psi[k][x], L));
        }
        arcSame.push(row);
    }

    const arcVec = new Array(K).fill(null);
    for (let k = 1; k < K; k++) {
        const sk = size[k];
        const rows = [];
        for (let x = 0; x < sk; x++) {
            const perChild = [];
            for (let a = 0; a < n; a++) {
                const child = n * x + a; // chi_{k,a}(x) in Lambda_{k-1}
                perChild.push(shorterArc(psi[k - 1][child], psi[k][x], L));
            }
            rows.push(perChild);
        }
        arcVec[k] = rows;
    }

    return { L, K, n, size, psi, arcSame, arcVec };
}

function makeSlice(k, size, timed, hasChildren, n) {
    return {
        k, size, timed, hasChildren,
        e: new Array(size).fill(0),
        s: new Array(size).fill(0),
        tau: new Array(size).fill(0),
        m: new Array(size).fill(0),
        c: new Array(size).fill(0),
        theta: new Array(size).fill(0),
        evec: hasChildren ? Array.from({ length: size }, () => new Array(n).fill(0)) : null,
        rho: hasChildren ? new Array(size).fill(0) : null,
    };
}

// ---------------------------------------------------------------------------
// Algorithm alg:cm-rep-defect-record-intake, main.tex 4726-4759.
// ---------------------------------------------------------------------------

function defectRecordIntake(dec, phiRound) {
    const producing = dec.t + 1;
    const K = dec.params.K;
    const I = [];
    for (let k = 0; k < K; k++) {
        const size = dec.slices[k].size;
        const row = new Array(size);
        for (let x = 0; x < size; x++) row[x] = [];
        I.push(row);
    }

    for (let x = 0; x < dec.slices[0].size; x++) {
        if (phiRound[x]) I[0][x].push(['env', 0]);
    }

    const pending = dec.pendingUp.get(producing);
    if (pending) {
        for (const [k, y, a] of pending) {
            const sl = dec.slices[k];
            sl.evec[y][a] ^= 1; // child-to-parent frame update
            sl.rho[y] ^= 1; // toggle child-arrival parity
        }
        dec.pendingUp.delete(producing);
    }
    return I;
}

// ---------------------------------------------------------------------------
// Algorithm alg:cm-rep-defect-update, main.tex 4769-4848.
// lambda_k(x,t) = m_k(x-1,t) ("the indicator that the base repetition-code
// decoder moves a defect at x one step to the left", main.tex 4762-4764).
// ---------------------------------------------------------------------------

function defectUpdate(dec, I) {
    const { K, n, t0 } = dec.params;
    const t = dec.t;
    const A = [];
    for (let k = 0; k < K; k++) {
        const size = dec.slices[k].size;
        const row = new Array(size);
        for (let x = 0; x < size; x++) row[x] = [];
        A.push(row);
    }

    for (let k = 0; k < K; k++) {
        if (mod(t, n ** k) !== 0) continue; // slice k does not fire this transition

        const sl = dec.slices[k];
        const size = sl.size;
        const Ak = A[k];

        for (let x = 0; x < size; x++) {
            for (const cand of I[k][x]) Ak[x].push(cand);
        }

        if (sl.hasChildren) {
            for (let x = 0; x < size; x++) {
                if (sl.rho[x] === 1) {
                    Ak[x].push(sl.timed ? ['up', 0] : ['up', null]);
                }
                sl.rho[x] = 0;
            }
        }

        const sOld = sl.s.slice();
        const tauOld = sl.tau.slice();
        for (let x = 0; x < size; x++) {
            if (sOld[x] !== 1) continue;
            const xLeft = mod(x - 1, size);
            const lam = !!sl.m[xLeft];

            if (sl.timed) {
                const tauPlus = tauOld[x] + 1;
                if (tauPlus === t0) {
                    // Vertical promotion: leaves slice k with no spatial
                    // candidate; arrives at the parent delayed until
                    // t + n**(k+1) + 1 (main.tex 4796-4801).
                    const y = Math.floor(x / n);
                    const b = x % n;
                    const arrival = t + (n ** (k + 1)) + 1;
                    if (!dec.pendingUp.has(arrival)) dec.pendingUp.set(arrival, []);
                    dec.pendingUp.get(arrival).push([k + 1, y, b]);
                    continue;
                }
                if (lam) {
                    sl.e[x] ^= 1;
                    Ak[xLeft].push(['move', tauPlus]);
                } else {
                    Ak[x].push(['stay', tauPlus]);
                }
            } else {
                // Final (untimed, back-wall) slice: no timer check at all.
                if (lam) {
                    sl.e[x] ^= 1;
                    Ak[xLeft].push(['move', null]);
                } else {
                    Ak[x].push(['stay', null]);
                }
            }
        }

        for (let x = 0; x < size; x++) {
            const cands = Ak[x];
            if (cands.length % 2 === 0) {
                sl.s[x] = 0;
                if (sl.timed) sl.tau[x] = 0;
            } else {
                sl.s[x] = 1;
                if (sl.timed) {
                    let m = Infinity;
                    for (const c of cands) if (c[1] < m) m = c[1];
                    sl.tau[x] = m;
                }
            }
        }
    }
    return A;
}

// Message-persistence term shared by messageUpdate (a real firing,
// increment=true) and erasureSubstep (a frozen-timer extra sub-step,
// increment=false): a message at x persists only if a message is still
// present at x-1 (main.tex message-update B_k formula, 3rd bullet). With
// increment, the candidate is theta(x)+1, gated by theta(x) < t0-1 so it
// can never leave the fixed timer range. Without it, timers are frozen:
// the candidate is simply theta(x) itself (already in range, no gate
// needed). Returns null when the persistence condition does not hold.
function persistenceCandidate(m, theta, x, xLeft, t0, increment) {
    if (!(m[x] === 1 && m[xLeft] === 1)) return null;
    if (increment) {
        return (theta[x] < t0 - 1) ? theta[x] + 1 : null;
    }
    return theta[x];
}

// Untimed-slice analogue (no theta at all on the back wall): a message
// at x persists iff one is still present at x-1.
function persistsUntimed(m, x, xLeft) {
    return m[x] === 1 && m[xLeft] === 1;
}

// ---------------------------------------------------------------------------
// Algorithm alg:cm-rep-message-update, main.tex 4849-4891. Must run after
// defectUpdate: sl.s/sl.tau already hold time-(t+1) values, sOldAll/tauOldAll
// (snapshotted by the caller before defectUpdate) hold time-t values, and
// sl.m/sl.c/sl.theta still hold time-t values since defectUpdate never
// touches the message sector.
// ---------------------------------------------------------------------------

function messageUpdate(dec, sOldAll, tauOldAll) {
    const { K, n, t0, q } = dec.params;
    const t = dec.t;

    for (let k = 0; k < K; k++) {
        if (mod(t, n ** k) !== 0) continue;

        const sl = dec.slices[k];
        const size = sl.size;
        const mOld = sl.m.slice();
        const thetaOld = sl.theta.slice();
        const cOld = sl.c.slice();
        const sPrev = sOldAll[k];
        const tauPrev = tauOldAll[k];

        if (sl.timed) {
            const mNew = new Array(size).fill(0);
            const thetaNew = new Array(size).fill(0);
            for (let x = 0; x < size; x++) {
                const xLeft = mod(x - 1, size);
                const B = new Set();
                if (sl.s[x] === 1) B.add(sl.tau[x]);
                if (sPrev[x] === 1 && tauPrev[x] + 1 < t0) B.add(tauPrev[x] + 1);
                const persistCand = persistenceCandidate(mOld, thetaOld, x, xLeft, t0, true);
                if (persistCand !== null) B.add(persistCand);
                if (mOld[xLeft] === 1 && cOld[x] === 0 && thetaOld[xLeft] < t0 - 1) B.add(thetaOld[xLeft] + 1);
                if (B.size > 0) {
                    mNew[x] = 1;
                    thetaNew[x] = Math.min(...B);
                } else {
                    mNew[x] = 0;
                    thetaNew[x] = 0;
                }
            }
            sl.m = mNew;
            sl.theta = thetaNew;
        } else {
            const mNew = new Array(size).fill(0);
            for (let x = 0; x < size; x++) {
                const xLeft = mod(x - 1, size);
                const on = (sl.s[x] === 1) || (sPrev[x] === 1) ||
                    persistsUntimed(mOld, x, xLeft) ||
                    (mOld[xLeft] === 1 && cOld[x] === 0);
                mNew[x] = on ? 1 : 0;
            }
            sl.m = mNew;
        }

        const cNew = new Array(size);
        for (let x = 0; x < size; x++) cNew[x] = (cOld[x] + 1) % q;
        sl.c = cNew;
    }
}

// ---------------------------------------------------------------------------
// Extra erasure sub-step (params.erasureMoves): not a paper mechanism -- an
// all-slices, unconditional, growth-disabled, timer-frozen application of
// ONLY the message sector's persistence/erosion rule, for manually
// accelerating erosion relative to growth as a numerical-exploration knob.
// Literal port of anim.cg_streaming_rep.erasure_substep.
// ---------------------------------------------------------------------------

function erasureSubstep(dec) {
    const t0 = dec.params.t0;

    for (const sl of dec.slices) {
        const size = sl.size;
        const sCur = sl.s;
        const tauCur = sl.tau;
        const mCur = sl.m.slice();
        const thetaCur = sl.theta.slice();

        if (sl.timed) {
            const mNew = new Array(size).fill(0);
            const thetaNew = new Array(size).fill(0);
            for (let x = 0; x < size; x++) {
                const xLeft = mod(x - 1, size);
                const B = new Set();
                if (sCur[x] === 1) B.add(tauCur[x]); // defect sourcing, kept, frozen (no increment)
                const cand = persistenceCandidate(mCur, thetaCur, x, xLeft, t0, false);
                if (cand !== null) B.add(cand);
                // No growth term at all.
                if (B.size > 0) {
                    mNew[x] = 1;
                    thetaNew[x] = Math.min(...B);
                } else {
                    mNew[x] = 0;
                    thetaNew[x] = 0;
                }
            }
            sl.m = mNew;
            sl.theta = thetaNew;
        } else {
            const mNew = new Array(size).fill(0);
            for (let x = 0; x < size; x++) {
                const xLeft = mod(x - 1, size);
                const on = (sCur[x] === 1) || persistsUntimed(mCur, x, xLeft);
                mNew[x] = on ? 1 : 0;
            }
            sl.m = mNew;
        }
        // e, s, tau, c, evec, rho untouched; dec.t untouched (caller's concern).
    }
}

// ---------------------------------------------------------------------------
// Physical correction: expand e_k / e_k^vec via their fixed strings and sum
// mod 2 (main.tex ~4675).
// ---------------------------------------------------------------------------

function physicalCorrection(dec) {
    const L = dec.geom.L;
    const E = new Array(L).fill(0);
    for (let k = 0; k < dec.params.K; k++) {
        const sl = dec.slices[k];
        const arcSame = dec.geom.arcSame[k];
        for (let x = 0; x < sl.size; x++) {
            if (sl.e[x]) {
                for (const q of arcSame[x]) E[q] ^= 1;
            }
        }
        if (sl.hasChildren) {
            const arcVec = dec.geom.arcVec[k];
            for (let x = 0; x < sl.size; x++) {
                for (let a = 0; a < dec.params.n; a++) {
                    if (sl.evec[x][a]) {
                        for (const q of arcVec[x][a]) E[q] ^= 1;
                    }
                }
            }
        }
    }
    return E;
}

// ---------------------------------------------------------------------------
// Rendering helpers (conventions shared with website/modules/repetition2.js).
// ---------------------------------------------------------------------------

// radiusFactor/outlineFactor default to the pyramid/future-panel orb size
// (unchanged); the residual row passes RESIDUAL_ORB_RADIUS/
// RESIDUAL_ORB_OUTLINE explicitly, matching repetition2.js's and
// repetition_streaming.js's current convention (anim/repcode_sync.py's
// ORB_RADIUS: three successive 10% shrinks of the original 0.42, i.e.
// 0.42 * 0.9^3).
function drawOrb(ctx, cx, cy, s, radiusFactor = 0.42, outlineFactor = 0.06) {
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

const RESIDUAL_ORB_RADIUS = 0.30618;
const RESIDUAL_ORB_OUTLINE = 0.06 * 0.81;

// Every maximal run of true/1 entries in a periodic 0/1 (or boolean) array,
// as {a, b} (inclusive qubit indices, a..b possibly wrapping past the
// end). A run that covers the entire array has no bracketing defects at
// all (its own syndrome is then all-zero), so it draws nothing -- matching
// repetition2.js's errorStrings() convention exactly. Literal port of
// repetition_streaming.js's findRuns().
function findRuns(residual) {
    const L = residual.length;
    if (residual.every((v) => v)) return [];
    if (!residual.some((v) => v)) return [];
    let start = 0;
    while (residual[start]) start++; // a zero is guaranteed to exist here
    const runs = [];
    let i = 0;
    while (i < L) {
        const x = (start + i) % L;
        if (residual[x]) {
            const a = x;
            let len = 0;
            while (i < L && residual[(start + i) % L]) { i++; len++; }
            const b = (a + len - 1) % L;
            runs.push({ a, b });
        } else {
            i++;
        }
    }
    return runs;
}

// Draw one run {a, b} as a single string from the centre of its left
// defect cell (a-1) to the centre of its right defect cell (b), splitting
// into two edge-hugging segments if the run physically wraps past the
// row's right edge (detected as leftDefect > rightDefect). Literal port
// of repetition_streaming.js's drawRunString().
function drawRunString(ctx, run, rowLeft, rowWidth, cell, midY, L) {
    const leftDefect = (run.a - 1 + L) % L;
    const rightDefect = run.b;
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

// Standalone one-row defect-orb drawer (distinct from drawSliceRow's
// built-in defectAt/timerFracAt handling used by the pyramid): used by the
// residual row, which needs custom orb size factors and no timer arcs.
function drawDefects(ctx, { left, top, cell, cols, defectAt, radiusFactor, outlineFactor }) {
    for (let c = 0; c < cols; c++) {
        if (defectAt(c)) {
            drawOrb(ctx, left + c * cell + cell / 2, top + cell / 2, cell, radiusFactor, outlineFactor);
        }
    }
}

// A small filled pie slice inside the orb showing `frac` (0..1) of a
// timer's range elapsed -- "timers shown as a small filled arc inside each
// orb" (task spec). Drawn starting at 12 o'clock, sweeping clockwise.
function drawTimerArc(ctx, cx, cy, s, frac) {
    if (!(frac > 0)) return;
    const r = 0.22 * s;
    const start = -Math.PI / 2;
    const end = start + Math.min(1, frac) * 2 * Math.PI;
    ctx.fillStyle = COLOR_TIMER_ARC;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fill();
}

function snapPixel(px, width) {
    return (width % 2 === 1) ? Math.floor(px) + 0.5 : Math.round(px);
}

// Generic one-row grid renderer: `count` cells of width `cellW` starting at
// `left`, height `rowH` starting at `top`. `messageAt(c)` / `defectAt(c)` /
// `timerFracAt(c)` (optional) decide fills, per repetition2.js's
// grey/blue two-pass boundary convention generalized to non-square cells.
function drawSliceRow(ctx, { left, top, cellW, rowH, count, messageAt, defectAt, timerFracAt, showGrid, showMessages }) {
    const wBlue = Math.max(2, Math.round(Math.min(cellW, rowH) / 9));
    const wGrey = Math.max(1, Math.round(Math.min(cellW, rowH) / 18));

    if (showMessages) {
        ctx.fillStyle = COLOR_MSG_FILL;
        for (let c = 0; c < count; c++) {
            if (messageAt(c)) ctx.fillRect(left + c * cellW, top, cellW, rowH);
        }
    }

    const drawVerticals = (width, color, wantBlue) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (let x = 0; x <= count; x++) {
            const leftM = x > 0 ? messageAt(x - 1) : false;
            const rightM = x < count ? messageAt(x) : false;
            const isBlue = showMessages && (leftM || rightM);
            if (isBlue !== wantBlue) continue;
            const xPix = snapPixel(left + x * cellW, width);
            ctx.beginPath();
            ctx.moveTo(xPix, top);
            ctx.lineTo(xPix, top + rowH);
            ctx.stroke();
        }
    };
    const drawHorizontal = (yValue, width, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        const yPix = snapPixel(yValue, width);
        ctx.beginPath();
        ctx.moveTo(left, yPix);
        ctx.lineTo(left + count * cellW, yPix);
        ctx.stroke();
    };

    if (showGrid) {
        drawVerticals(wGrey, COLOR_GRID, false);
        drawHorizontal(top, wGrey, COLOR_GRID);
        drawHorizontal(top + rowH, wGrey, COLOR_GRID);
    }
    if (showMessages) {
        drawVerticals(wBlue, COLOR_MSG_EDGE, true);
    }

    if (defectAt) {
        for (let c = 0; c < count; c++) {
            if (defectAt(c)) {
                const cx = left + c * cellW + cellW / 2;
                const cy = top + rowH / 2;
                const s = Math.min(cellW, rowH);
                drawOrb(ctx, cx, cy, s);
                if (timerFracAt) drawTimerArc(ctx, cx, cy, s, timerFracAt(c));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The decoder.
// ---------------------------------------------------------------------------

export class RepetitionCGStreamingDecoder {
    constructor(L, clockPeriod = 2, opts = {}) {
        this.L = L;
        const K = (Number.isInteger(opts.K) && opts.K >= 1) ? opts.K : 3;
        const n = (Number.isInteger(opts.n) && opts.n >= 2) ? opts.n : 2;
        const t0 = (Number.isInteger(opts.t0) && opts.t0 >= 1) ? opts.t0 : 8;
        const qFromClock = (Number.isFinite(clockPeriod) && clockPeriod >= 1) ? Math.round(clockPeriod) : 2;
        const q = (Number.isInteger(opts.q) && opts.q >= 1) ? opts.q : qFromClock;
        // Not a paper parameter: after every real step(), erasureMoves extra
        // erasureSubstep calls run (message-sector persistence/erosion
        // only; see erasureSubstep). Zero by default -- unchanged behavior.
        const erasureMoves = (Number.isInteger(opts.erasureMoves) && opts.erasureMoves >= 0) ? opts.erasureMoves : 0;

        this.params = { L, K, n, t0, q, erasureMoves };
        this.geom = buildGeometry(L, K, n);
        this.slices = [];
        for (let k = 0; k < K; k++) {
            this.slices.push(makeSlice(k, this.geom.size[k], k < K - 1, k > 0, n));
        }
        this.t = -1; // source time of the next transition (main.tex 4700-4702)
        this.pendingUp = new Map();
        this.stepCount = 0;

        this.pPhys = Number.isFinite(opts.pPhys) ? opts.pPhys : 0.002;
        // Mirrors website/modules/repetition_streaming.js's convention: the
        // generic error-probability slider (-> initializeRandomErrors(p))
        // drives pPhys and, unless pMeas was explicitly supplied at
        // construction (main.js's extraParams slider always supplies one
        // once touched), also drives pMeas.
        this._pMeasOverridden = opts.pMeas !== undefined;
        this.pMeas = Number.isFinite(opts.pMeas) ? opts.pMeas : this.pPhys;
        this.seed = Number.isInteger(opts.seed) ? opts.seed : 1;
        this.TFuture = (Number.isInteger(opts.T_future) && opts.T_future >= 1) ? opts.T_future : 24;

        this._rng = mulberry32(this.seed >>> 0);
        this.b = new Array(L).fill(0); // real, cumulative physical bit-flip error
        this._projB = this.b.slice(); // lookahead projection used only to precompute future phi
        this._projSTilde = new Array(L).fill(0);
        this.roundIndex = 0;

        this._testPhiQueue = null; // set via setPhiHistoryForTesting

        this.futureBuffer = [];
        this._fillFuture();
    }

    // Compatibility with website/js/main.js's generic clockPeriod slider
    // (`currentDecoder.clockPeriod !== undefined` / direct assignment).
    get clockPeriod() { return this.params.q; }
    set clockPeriod(value) {
        const q = Math.round(value);
        if (Number.isInteger(q) && q >= 1) this.params.q = q;
    }

    get clock() { return this.slices[0].c[0]; }

    _generateRound() {
        const L = this.L;
        const dataFlip = new Array(L);
        const measFlip = new Array(L);
        for (let x = 0; x < L; x++) {
            dataFlip[x] = (this._rng() < this.pPhys) ? 1 : 0;
            measFlip[x] = (this._rng() < this.pMeas) ? 1 : 0;
        }
        const { b, sTilde, phi } = advanceNoise(this._projB, this._projSTilde, dataFlip, measFlip, L);
        this._projB = b;
        this._projSTilde = sTilde;
        return { dataFlip, measFlip, phi };
    }

    _fillFuture() {
        while (this.futureBuffer.length < this.TFuture) {
            this.futureBuffer.push(this._generateRound());
        }
    }

    // Test-only: bypass live noise generation with a fixed phi sequence.
    // A mulberry32 stream and numpy's default_rng can never be made to
    // agree bit-for-bit, so cross-language exactness checks
    // (website/tests/check_cg_streaming_rep.mjs) feed both implementations
    // the *same* phi history rather than trying to match RNGs.
    setPhiHistoryForTesting(phiRounds) {
        this._testPhiQueue = phiRounds.map(row => Array.from(row));
    }

    step() {
        let phi;
        if (this._testPhiQueue && this._testPhiQueue.length > 0) {
            phi = this._testPhiQueue.shift();
        } else {
            if (this.futureBuffer.length === 0) this._fillFuture();
            const round = this.futureBuffer.shift();
            for (let x = 0; x < this.L; x++) this.b[x] ^= round.dataFlip[x];
            phi = round.phi;
            this.roundIndex++;
            this._fillFuture();
        }

        const sOld = this.slices.map(sl => sl.s.slice());
        const tauOld = this.slices.map(sl => sl.tau.slice());
        const I = defectRecordIntake(this, phi);
        defectUpdate(this, I);
        messageUpdate(this, sOld, tauOld);
        this.t += 1;
        this.stepCount += 1;

        for (let i = 0; i < this.params.erasureMoves; i++) {
            erasureSubstep(this);
        }
    }

    getSyndromeCount() {
        let count = 0;
        for (const sl of this.slices) {
            for (let x = 0; x < sl.size; x++) if (sl.s[x]) count++;
        }
        return count;
    }

    getErrorCount() {
        const E = physicalCorrection(this);
        let count = 0;
        for (let x = 0; x < this.L; x++) if (this.b[x] ^ E[x]) count++;
        return count;
    }

    hasMessages() {
        for (const sl of this.slices) {
            for (let x = 0; x < sl.size; x++) if (sl.m[x]) return true;
        }
        return false;
    }

    // False whenever noise is actively running (there is always more
    // syndrome on the way); with no noise at all, quiescent once every
    // slice is defect- and message-free.
    isQuiescent() {
        if (this.pPhys > 0 || this.pMeas > 0) return false;
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        const weight = this.getErrorCount();
        const hasError = weight > this.L / 2;
        const result = { hasError, horizontal: hasError, vertical: false };
        if (hasError) result.description = `residual weight ${weight} > L/2 (majority vote flipped)`;
        return result;
    }

    // Compatibility with website/js/main.js's generic "randomize" action:
    // resets to a fresh streaming run (t=-1, all channels zero) and adopts
    // `p` as both p_phys and p_meas, since the shared UI only exposes one
    // error-rate slider. `rng` becomes the ongoing generator for all later
    // environment generation (_generateRound), exactly as passed in --
    // matching website/modules/repetition_streaming.js's convention. This
    // matters for `?seed=N&init=1` URL reproducibility: main.js passes
    // `rng = mulberry32(seed)` here, and every future round must be drawn
    // from that *same* seeded stream, not from some further-derived seed,
    // for the URL's seed to actually reproduce the run.
    initializeRandomErrors(p, rng = Math.random) {
        if (Number.isFinite(p) && p >= 0) {
            this.pPhys = p;
            if (!this._pMeasOverridden) this.pMeas = p;
        }
        this._rng = rng;
        for (const sl of this.slices) {
            sl.e.fill(0);
            sl.s.fill(0);
            sl.tau.fill(0);
            sl.m.fill(0);
            sl.c.fill(0);
            sl.theta.fill(0);
            if (sl.evec) for (const row of sl.evec) row.fill(0);
            if (sl.rho) sl.rho.fill(0);
        }
        this.t = -1;
        this.pendingUp = new Map();
        this.stepCount = 0;
        this.b.fill(0);
        this._projB.fill(0);
        this._projSTilde.fill(0);
        this.roundIndex = 0;
        this.futureBuffer = [];
        this._fillFuture();
    }

    // --- rendering -----------------------------------------------------

    _layout(canvasWidth, canvasHeight) {
        const L = this.L;
        const K = this.params.K;
        const cell = Math.max(1, Math.floor(Math.min(24, (canvasWidth - 80) / L)));
        const rowW = cell * L;
        const left = (canvasWidth - rowW) / 2;

        const topLabelH = 20;
        const topGap = 6;
        const pyramidH = K * cell;
        const sepGap = 10;
        const residualH = cell;
        const panelGap = 4;
        const legendGap = 10;
        const legendH = 22;
        const bottomMargin = 10;

        const fixedH = topLabelH + topGap + pyramidH + sepGap + residualH + panelGap + legendGap + legendH + bottomMargin;
        const panelH = Math.max(cell, canvasHeight - fixedH);
        const panelRows = Math.max(1, Math.min(this.futureBuffer.length || 1, Math.floor(panelH / cell)));

        const pyramidTop = topLabelH + topGap;
        const pyramidBottom = pyramidTop + pyramidH;
        const sepY = pyramidBottom + sepGap / 2;
        const residualTop = pyramidBottom + sepGap;
        const residualBottom = residualTop + residualH;
        const panelTop = residualBottom + panelGap;
        const legendTop = panelTop + panelRows * cell + legendGap;

        return {
            L, K, cell, left, rowW,
            topLabelH, pyramidTop, pyramidBottom, sepY,
            residualTop, residualBottom,
            panelTop, panelRows,
            legendTop, legendH,
        };
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        const showGrid = options.showGrid !== false;
        const showMessages = options.showMessages !== false;
        const showSyndrome = options.showSyndrome !== false;
        const showErrors = options.showErrors !== false;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const L = this.L;
        const K = this.params.K;
        const layout = this._layout(canvasWidth, canvasHeight);
        const { cell, left, rowW } = layout;

        // Caption.
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `${LEGEND_FONT_SIZE}px ${FONT_SERIF}`;
        ctx.fillText(`t = ${this.roundIndex}`, left + rowW / 2, layout.topLabelH * 0.75);

        // Pyramid: slice K-1 at the top, slice 0 at the bottom, each row
        // spanning the same total width `rowW` with cells of width
        // n^k * cell (Fig. "coarse-grained-hierarchy").
        for (let k = K - 1; k >= 0; k--) {
            const sl = this.slices[k];
            const rowTop = layout.pyramidTop + (K - 1 - k) * cell;
            const cellW = cell * (this.params.n ** k);
            drawSliceRow(ctx, {
                left, top: rowTop, cellW, rowH: cell, count: sl.size,
                messageAt: (c) => !!sl.m[c],
                defectAt: showSyndrome ? (c) => !!sl.s[c] : null,
                timerFracAt: sl.timed ? (c) => sl.tau[c] / this.params.t0 : null,
                showGrid, showMessages,
            });

            // Parent-child guide lines (thin grey), drawn against this
            // slice's own parent one level up.
            if (showGrid && k < K - 1) {
                const parentCellW = cell * (this.params.n ** (k + 1));
                const parentTop = layout.pyramidTop + (K - 1 - (k + 1)) * cell;
                ctx.strokeStyle = COLOR_GUIDE;
                ctx.lineWidth = 0.75;
                for (let x = 0; x < sl.size; x++) {
                    const y = Math.floor(x / this.params.n);
                    const cx1 = left + x * cellW + cellW / 2;
                    const cy1 = rowTop;
                    const cx2 = left + y * parentCellW + parentCellW / 2;
                    const cy2 = parentTop + cell;
                    ctx.beginPath();
                    ctx.moveTo(cx1, cy1);
                    ctx.lineTo(cx2, cy2);
                    ctx.stroke();
                }
            }
        }

        // Separator between the pyramid and the physical world below it.
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(left - 6, layout.sepY);
        ctx.lineTo(left + rowW + 6, layout.sepY);
        ctx.stroke();

        // Residual row: physical qubits, r = b xor E. Drawn like a site row
        // (grey grid), with orbs at the residual's own syndrome
        // s_res(x) = r(x) xor r(x+1), and each maximal run of residual-1
        // qubits as one string from the centre of its left defect cell to
        // the centre of its right defect cell (qubit x sits between sites
        // x-1 and x, so a run a..b has defects at a-1 and b) -- matching
        // repetition2.js's / repetition_streaming.js's current convention
        // (a wrapping run draws as two edge-hugging segments; an all-ones
        // residual has no syndrome at all, so it draws no string).
        const E = physicalCorrection(this);
        const residual = new Array(L);
        for (let x = 0; x < L; x++) residual[x] = this.b[x] ^ E[x];
        const residualSyndrome = new Array(L);
        for (let x = 0; x < L; x++) {
            residualSyndrome[x] = (!!residual[x]) !== (!!residual[(x + 1) % L]);
        }
        const residualMidY = layout.residualTop + cell / 2;
        const wBlueResidual = Math.max(2, Math.round(cell / 9));
        const stringWidth = 1.5 * wBlueResidual;

        drawSliceRow(ctx, {
            left, top: layout.residualTop, cellW: cell, rowH: cell, count: L,
            messageAt: () => false, defectAt: null,
            showGrid, showMessages: false,
        });
        if (showErrors) {
            ctx.strokeStyle = COLOR_ERROR;
            ctx.lineWidth = stringWidth;
            for (const run of findRuns(residual)) {
                drawRunString(ctx, run, left, rowW, cell, residualMidY, L);
            }
        }
        if (showSyndrome) {
            drawDefects(ctx, {
                left, top: layout.residualTop, cell, cols: L, defectAt: (x) => residualSyndrome[x],
                radiusFactor: RESIDUAL_ORB_RADIUS, outlineFactor: RESIDUAL_ORB_OUTLINE,
            });
        }

        // FUTURE panel: pre-generated upcoming rounds, nearest-round at the
        // top (just below the residual row), peeling upward as steps advance.
        for (let i = 0; i < layout.panelRows; i++) {
            const round = this.futureBuffer[i];
            const rowTop = layout.panelTop + i * cell;
            // Base grid (grey cells, no message fill -- this is raw noise,
            // not decoder state).
            drawSliceRow(ctx, {
                left, top: rowTop, cellW: cell, rowH: cell, count: L,
                messageAt: () => false, defectAt: null,
                showGrid, showMessages: false,
            });
            if (!round) continue;
            ctx.strokeStyle = COLOR_ERROR;
            ctx.fillStyle = COLOR_ERROR;
            for (let x = 0; x < L; x++) {
                if (round.dataFlip[x]) {
                    // Horizontal red segment across the qubit cell (between
                    // the two stabilizer/check positions it touches).
                    const yMid = rowTop + cell / 2;
                    ctx.lineWidth = Math.max(2, Math.round(cell / 6));
                    ctx.beginPath();
                    ctx.moveTo(left + x * cell + cell * 0.12, yMid);
                    ctx.lineTo(left + (x + 1) * cell - cell * 0.12, yMid);
                    ctx.stroke();
                }
            }
            for (let x = 0; x < L; x++) {
                const boundaryX = left + (x + 1) * cell; // check position x, between qubit x and x+1
                if (round.measFlip[x]) {
                    ctx.lineWidth = Math.max(1.5, Math.round(cell / 8));
                    ctx.beginPath();
                    ctx.moveTo(boundaryX, rowTop + cell * 0.18);
                    ctx.lineTo(boundaryX, rowTop + cell * 0.82);
                    ctx.stroke();
                }
                if (round.phi[x]) {
                    drawOrb(ctx, boundaryX, rowTop + cell / 2, cell * 0.7);
                }
            }
        }

        this._drawLegend(ctx, layout);
    }

    _drawLegend(ctx, layout) {
        const { left, rowW, legendTop, legendH } = layout;
        const y = legendTop + legendH * 0.6;
        const swatch = 14;
        const gapIconLabel = 6;
        const gapItems = 20;

        ctx.font = `${LEGEND_FONT_SIZE}px ${FONT_SERIF}`;
        const labels = ['message', 'defect (timer arc)', 'residual error', 'detector event', 'meas. error', 'data flip'];
        const labelWidths = labels.map(l => ctx.measureText(l).width);
        let totalW = 0;
        labels.forEach((_l, idx) => {
            totalW += swatch + gapIconLabel + labelWidths[idx];
            if (idx < labels.length - 1) totalW += gapItems;
        });

        let x = left + rowW / 2 - totalW / 2;
        ctx.textAlign = 'left';

        // message swatch
        ctx.fillStyle = COLOR_MSG_FILL;
        ctx.fillRect(x, y - swatch / 2, swatch, swatch);
        ctx.strokeStyle = COLOR_MSG_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y - swatch / 2 + 0.5, swatch - 1, swatch - 1);
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[0], x, y + 4);
        x += labelWidths[0] + gapItems;

        // defect orb + timer arc
        drawOrb(ctx, x + swatch / 2, y, swatch);
        drawTimerArc(ctx, x + swatch / 2, y, swatch, 0.6);
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[1], x, y + 4);
        x += labelWidths[1] + gapItems;

        // residual error string (horizontal, matching the residual row's
        // run strings -- see findRuns/drawRunString)
        ctx.strokeStyle = COLOR_ERROR;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + swatch, y);
        ctx.stroke();
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[2], x, y + 4);
        x += labelWidths[2] + gapItems;

        // detector event orb (future panel)
        drawOrb(ctx, x + swatch / 2, y, swatch * 0.8);
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[3], x, y + 4);
        x += labelWidths[3] + gapItems;

        // measurement error tick
        ctx.strokeStyle = COLOR_ERROR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + swatch / 2, y - swatch / 2);
        ctx.lineTo(x + swatch / 2, y + swatch / 2);
        ctx.stroke();
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[4], x, y + 4);
        x += labelWidths[4] + gapItems;

        // data flip segment
        ctx.strokeStyle = COLOR_ERROR;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + swatch, y);
        ctx.stroke();
        x += swatch + gapIconLabel;
        ctx.fillStyle = '#000000';
        ctx.fillText(labels[5], x, y + 4);
    }

    // Manual error placement: XOR a physical data-bit flip directly into
    // `b` at the clicked qubit (nearest cell in the residual row).
    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const layout = this._layout(canvasWidth, canvasHeight);
        if (y < layout.residualTop || y > layout.residualBottom) return;
        const L = this.L;
        const idx = mod(Math.floor((x - layout.left) / layout.cell), L);
        this.b[idx] ^= 1;
    }
}

export {
    mulberry32, shorterArc, buildGeometry, makeSlice,
    defectRecordIntake, defectUpdate, messageUpdate, physicalCorrection,
    findRuns, drawRunString, advanceNoise,
    erasureSubstep, persistenceCandidate, persistsUntimed,
};
