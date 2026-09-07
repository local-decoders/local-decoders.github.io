// Surface Code CA Decoder with Splitting Dynamics
// Translates surface_ca_split.py to JavaScript for website visualization.
//
// No ml/mr boundary messages. Instead, at every q'-th step, a splitting step
// translates messages outward from the center and shifts syndromes via lr_qubit flips.

export class SurfaceCodeSplitDecoder {
    constructor(L, clockPeriod = 6) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;
        this.qPrime = 13; // splitting period (q'), exposed for the UI slider

        // Initialize qubits
        // tb_qubits: (L-1) x (L+1) with padding columns 0 and L zeroed
        this.tbQubits = new Array(L - 1).fill(null).map(() => new Array(L + 1).fill(false));
        // lr_qubits: L x L
        this.lrQubits = new Array(L).fill(null).map(() => new Array(L).fill(false));

        // Message grids (L+1 x L) — only b, r, g (no ml/mr)
        this.bGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.rGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.gGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

        // Syndrome (L+1 x L)
        this.syndrome = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
    }

    initializeRandomErrors(p) {
        // tb_qubits: columns 0 and L stay false (padding)
        for (let i = 0; i < this.L - 1; i++) {
            for (let j = 1; j < this.L; j++) {
                this.tbQubits[i][j] = Math.random() < p;
            }
        }
        // lr_qubits
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                this.lrQubits[i][j] = Math.random() < p;
            }
        }
        // Reset messages
        const L = this.L;
        this.bGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.rGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.gGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.clock = 0;
        this.stepCount = 0;
        this.calculateSyndrome();
    }

    initializeClear() {
        const L = this.L;
        this.tbQubits = new Array(L - 1).fill(null).map(() => new Array(L + 1).fill(false));
        this.lrQubits = new Array(L).fill(null).map(() => new Array(L).fill(false));
        this.bGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.rGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.gGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.syndrome = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.clock = 0;
        this.stepCount = 0;
    }

    calculateSyndrome() {
        const L = this.L;
        // Interior stabilizers: i = 1..L-1
        for (let i = 1; i < L; i++) {
            for (let j = 0; j < L; j++) {
                // s = lr[i-1][j] ^ lr[i][j] ^ tb[i-1][j+1] ^ tb[i-1][j]
                // (Python: syndrome = lr[:-1] ^ lr[1:] ^ tb[:, 1:] ^ tb[:, :-1])
                const lr_left = this.lrQubits[i - 1][j];
                const lr_right = this.lrQubits[i][j];
                const tb_top = (j < L - 1) ? this.tbQubits[i - 1][j + 1] : false;
                const tb_bot = (j > 0) ? this.tbQubits[i - 1][j] : false;
                // IMPORTANT: ^ returns numbers (0/1), coerce to boolean with !!
                // so that !== works correctly as XOR elsewhere in the code
                this.syndrome[i][j] = !!(lr_left ^ lr_right ^ tb_top ^ tb_bot);
            }
        }
        // Boundary stabilizers are always 0
        for (let j = 0; j < L; j++) {
            this.syndrome[0][j] = false;
            this.syndrome[L][j] = false;
        }
    }

    // Standard RGB CA step (no ml/mr), matching step_ca in surface_ca_split.py
    // Uses vectorized approach: compute all updates from OLD state, then apply.
    stepCA() {
        this.calculateSyndrome();
        const L = this.L;
        const s = this.syndrome;
        const b = this.bGrid, r = this.rGrid, g = this.gGrid;
        const isC0 = this.clock === 0;

        // Helper: read from grid with erasure boundary (out-of-bounds = false)
        const at = (grid, i, j) => (i >= 0 && i < grid.length && j >= 0 && j < grid[0].length) ? grid[i][j] : false;

        // --- Pass 1: compute corrections (applied to qubit copies) ---
        const corrLr = new Array(L).fill(null).map(() => new Array(L).fill(false));
        const corrTb = new Array(L - 1).fill(null).map(() => new Array(L + 1).fill(false));

        for (let i = 0; i <= L; i++) {
            for (let j = 0; j < L; j++) {
                if (!s[i][j]) continue;

                const leftActive = at(b, i - 1, j) || at(r, i - 1, j);
                const doLeft = leftActive;
                const doDown = !doLeft && at(g, i, j - 1);

                if (doLeft && i >= 1 && i <= L) {
                    corrLr[i - 1][j] = !corrLr[i - 1][j];  // XOR toggle
                }
                if (doDown && i >= 1 && i < L && j >= 1) {
                    corrTb[i - 1][j] = !corrTb[i - 1][j];
                }
            }
        }

        // Apply corrections
        const newLr = this.lrQubits.map(row => [...row]);
        const newTb = this.tbQubits.map(row => [...row]);
        for (let i = 0; i < L; i++)
            for (let j = 0; j < L; j++)
                if (corrLr[i][j]) newLr[i][j] = !newLr[i][j];
        for (let i = 0; i < L - 1; i++)
            for (let j = 0; j < L + 1; j++)
                if (corrTb[i][j]) newTb[i][j] = !newTb[i][j];

        // --- Pass 2: compute new messages from OLD state ---
        const newB = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newR = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newG = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

        // Pre-compute blue majority for use in R/G updates (from OLD b only)
        const bMaj = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        for (let i = 0; i <= L; i++) {
            for (let j = 0; j < L; j++) {
                const bl = at(b, i - 1, j);
                const bd = at(b, i, j - 1);
                const bs = b[i][j];
                bMaj[i][j] = ((bl ? 1 : 0) + (bd ? 1 : 0) + (bs ? 1 : 0)) >= 2;
            }
        }

        for (let i = 0; i <= L; i++) {
            for (let j = 0; j < L; j++) {
                const si = s[i][j];

                if (si) {
                    // Syndrome present → all messages on
                    newB[i][j] = true;
                    newR[i][j] = true;
                    newG[i][j] = true;
                    continue;
                }

                // No syndrome — check incoming syndrome
                const sRight = at(s, i + 1, j);
                const sUp = at(s, i, j + 1);
                const ils = sRight && (b[i][j] || r[i][j]);
                const rLeftUp = at(r, i - 1, j + 1);
                const bLeftUp = at(b, i - 1, j + 1);
                const ids = sUp && g[i][j] && !rLeftUp && !bLeftUp;
                const isFlag = ils || ids;

                if (isFlag) {
                    newB[i][j] = true;
                    newR[i][j] = true;
                    newG[i][j] = true;
                    continue;
                }

                // else: growth + majority from OLD values
                const bl = at(b, i - 1, j);
                const bd = at(b, i, j - 1);
                const rl = at(r, i - 1, j);
                const ru = at(r, i, j + 1);
                const gr = at(g, i + 1, j);
                const gd = at(g, i, j - 1);

                // --- Blue ---
                if (isC0 && !b[i][j]) {
                    // Growth: adopt from neighbors
                    newB[i][j] = bd || bl;
                } else if (b[i][j]) {
                    // Majority (applied regardless of clock, matching Python mask_else & b)
                    newB[i][j] = bMaj[i][j];
                }
                // else: stays false

                // --- Red ---
                const rm = ((rl ? 1 : 0) + (ru ? 1 : 0) + (r[i][j] ? 1 : 0)) >= 2;
                if (isC0 && !r[i][j]) {
                    newR[i][j] = ru || rl;
                } else if (r[i][j]) {
                    newR[i][j] = rm || (bMaj[i][j] && b[i][j]);
                }

                // --- Green ---
                const gm = ((gr ? 1 : 0) + (gd ? 1 : 0) + (g[i][j] ? 1 : 0)) >= 2;
                if (isC0 && !g[i][j]) {
                    newG[i][j] = gd || gr;
                } else if (g[i][j]) {
                    newG[i][j] = gm || (bMaj[i][j] && b[i][j]);
                }
            }
        }

        this.bGrid = newB;
        this.rGrid = newR;
        this.gGrid = newG;
        this.tbQubits = newTb;
        this.lrQubits = newLr;

        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;
    }

    // Splitting step: translate messages outward from center, shift syndromes
    // Matches splitting_step() in surface_ca_split.py exactly.
    // Uses new arrays (not in-place) to match Python's immutable JAX semantics.
    splittingStep() {
        const L = this.L;
        const mid = Math.floor(L / 2);

        // --- Syndrome shift via lr_qubit flips ---
        this.calculateSyndrome();
        const oldSyndrome = this.syndrome.map(row => [...row]); // snapshot

        // Count syndromes before
        let synBefore = 0;
        for (let i = 1; i < L; i++)
            for (let j = 0; j < L; j++)
                if (oldSyndrome[i][j]) synBefore++;

        // Build new lr_qubits from old values (matching Python: new_lr = lr ^ ...)
        const newLr = this.lrQubits.map(row => [...row]);

        // Left half: new_lr[i] = old_lr[i] XOR old_syndrome[i+1]  for i = 0..mid-1
        for (let i = 0; i < mid; i++) {
            for (let j = 0; j < L; j++) {
                newLr[i][j] = this.lrQubits[i][j] !== oldSyndrome[i + 1][j];
            }
        }
        // Center (i=mid): unchanged — newLr[mid] already equals lrQubits[mid]

        // Right half: new_lr[i] = old_lr[i] XOR old_syndrome[i]  for i = mid+1..L-1
        for (let i = mid + 1; i < L; i++) {
            for (let j = 0; j < L; j++) {
                newLr[i][j] = this.lrQubits[i][j] !== oldSyndrome[i][j];
            }
        }

        this.lrQubits = newLr;

        // Count syndromes after
        this.calculateSyndrome();
        let synAfter = 0;
        for (let i = 1; i < L; i++)
            for (let j = 0; j < L; j++)
                if (this.syndrome[i][j]) synAfter++;

        console.log(`[SPLIT] step=${this.stepCount}, mid=${mid}, syndromes: ${synBefore} → ${synAfter} (delta=${synAfter - synBefore})`);
        if (synAfter > synBefore) {
            // Log positions of new syndromes for debugging
            for (let i = 1; i < L; i++) {
                for (let j = 0; j < L; j++) {
                    if (this.syndrome[i][j] && !oldSyndrome[i][j]) {
                        console.log(`  NEW syndrome at (${i}, ${j})`);
                    }
                }
            }
        }

        // --- Message shift: translate outward from center ---
        const shiftOutward = (msg) => {
            const newMsg = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

            // Regular left-half: x=1..mid-1 → 0..mid-2
            if (mid >= 2) {
                for (let x = 0; x < mid - 1; x++) {
                    for (let j = 0; j < L; j++) {
                        newMsg[x][j] = msg[x + 1][j];
                    }
                }
            }

            // Center x=mid: copy outward to mid-1 AND keep at mid
            if (mid >= 1) {
                for (let j = 0; j < L; j++) {
                    newMsg[mid - 1][j] = newMsg[mid - 1][j] || msg[mid][j];
                }
            }
            for (let j = 0; j < L; j++) {
                newMsg[mid][j] = msg[mid][j];
            }

            // Center x=mid+1: keep at mid+1 AND copy outward to mid+2
            for (let j = 0; j < L; j++) {
                newMsg[mid + 1][j] = msg[mid + 1][j];
            }
            if (mid + 2 <= L) {
                for (let j = 0; j < L; j++) {
                    newMsg[mid + 2][j] = newMsg[mid + 2][j] || msg[mid + 1][j];
                }
            }

            // Regular right-half: x=mid+2..L-1 → mid+3..L
            if (mid + 2 <= L - 1) {
                for (let x = mid + 3; x <= L; x++) {
                    for (let j = 0; j < L; j++) {
                        newMsg[x][j] = msg[x - 1][j];
                    }
                }
            }

            return newMsg;
        };

        this.bGrid = shiftOutward(this.bGrid);
        this.rGrid = shiftOutward(this.rGrid);
        this.gGrid = shiftOutward(this.gGrid);

        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;
    }

    // Main step: splitting at multiples of q', CA otherwise
    step() {
        if (this.stepCount % this.qPrime === 0 && this.stepCount > 0) {
            this.splittingStep();
        } else {
            this.stepCA();
        }
    }

    getSyndromeCount() {
        this.calculateSyndrome();
        let count = 0;
        for (let i = 1; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.syndrome[i][j]) count++;
            }
        }
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let i = 0; i < this.L - 1; i++) {
            for (let j = 1; j < this.L; j++) {
                if (this.tbQubits[i][j]) count++;
            }
        }
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.lrQubits[i][j]) count++;
            }
        }
        return count;
    }

    hasMessages() {
        for (let i = 0; i <= this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.bGrid[i][j] || this.rGrid[i][j] || this.gGrid[i][j]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        // Winding number at midRow, matching Python: jnp.sum(lr_qubits[L//2, :]) % 2
        const midRow = Math.floor(this.L / 2);
        let winding = 0;
        for (let j = 0; j < this.L; j++) {
            if (this.lrQubits[midRow][j]) winding++;
        }
        const hasLogicalError = (winding % 2) !== 0;
        return {
            hasError: hasLogicalError,
            horizontal: hasLogicalError,
            vertical: false
        };
    }

    render(ctx, canvasWidth, canvasHeight, options) {
        const L = this.L;
        const mid = Math.floor(L / 2);
        const padding = 20;
        const availableWidth = canvasWidth - 2 * padding;
        const availableHeight = canvasHeight - 2 * padding;

        const cellSize = Math.min(availableWidth / (L + 2), availableHeight / (L + 1));
        const totalW = cellSize * (L + 2);
        const totalH = cellSize * (L + 1);
        const offsetX = (canvasWidth - totalW) / 2;
        const offsetY = (canvasHeight - totalH) / 2;

        const px = (gx) => offsetX + (gx + 0.5) * cellSize;
        const py = (gy) => offsetY + (L + 0.5 - gy) * cellSize;
        const h = cellSize / 2;

        // Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // 1. X-plaquette diamond backgrounds
        for (let i = 0; i < L; i++) {
            for (let j = 0; j <= L; j++) {
                const cx = px(i + 1), cy = py(j);
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.beginPath();
                ctx.moveTo(cx - h, cy);
                ctx.lineTo(cx, cy - h);
                ctx.lineTo(cx + h, cy);
                ctx.lineTo(cx, cy + h);
                ctx.closePath();
                ctx.fill();
            }
        }

        // 2. Z-stabilizers
        this.calculateSyndrome();
        for (let i = 0; i <= L; i++) {
            for (let j = 0; j < L; j++) {
                const cx = offsetX + (i + 1) * cellSize;
                const cy = offsetY + (L - j) * cellSize;
                const alpha = (i === 0 || i === L) ? 0.2 : 1.0;

                ctx.fillStyle = `rgba(151,187,255,${alpha})`;
                ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.5})`;
                ctx.lineWidth = 0.5;

                ctx.beginPath();
                if (j === 0) {
                    ctx.moveTo(cx - h, cy); ctx.lineTo(cx + h, cy); ctx.lineTo(cx, cy - h);
                } else if (j === L - 1) {
                    ctx.moveTo(cx - h, cy); ctx.lineTo(cx + h, cy); ctx.lineTo(cx, cy + h);
                } else {
                    ctx.moveTo(cx - h, cy); ctx.lineTo(cx, cy + h);
                    ctx.lineTo(cx + h, cy); ctx.lineTo(cx, cy - h);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }

        // Center partition line
        const partX = offsetX + (mid + 1) * cellSize;
        ctx.save();
        ctx.strokeStyle = 'rgba(128,128,128,0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(partX, offsetY);
        ctx.lineTo(partX, offsetY + totalH);
        ctx.stroke();
        ctx.restore();

        // 3. Defect circles (syndromes)
        if (options.showSyndrome) {
            for (let i = 0; i <= L; i++) {
                for (let j = 0; j < L; j++) {
                    if (this.syndrome[i][j]) {
                        const cx = offsetX + (i + 1) * cellSize;
                        const cy = offsetY + (L - j) * cellSize;
                        ctx.fillStyle = '#fbbf24';
                        ctx.strokeStyle = 'black';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.arc(cx, cy, cellSize * 0.15, 0, 2 * Math.PI);
                        ctx.fill();
                        ctx.stroke();
                    }
                }
            }
        }

        // 4. Message wedges (3 segments: B, R, G — no ml/mr)
        if (options.showMessages) {
            const msgRadius = cellSize * 0.3;
            const nSeg = 3;
            const anglePerSeg = (2 * Math.PI) / nSeg;
            const msgColors = [
                'rgba(96,165,250,0.55)',   // Blue (SW)
                'rgba(248,113,113,0.55)',  // Red (NW)
                'rgba(52,211,153,0.55)',   // Green (SE)
            ];

            for (let i = 0; i <= L; i++) {
                for (let j = 0; j < L; j++) {
                    const cx = offsetX + (i + 1) * cellSize;
                    const cy = offsetY + (L - j) * cellSize;
                    const msgs = [this.bGrid[i][j], this.rGrid[i][j], this.gGrid[i][j]];

                    for (let s = 0; s < nSeg; s++) {
                        if (msgs[s]) {
                            const startAngle = s * anglePerSeg - Math.PI / 2;
                            const endAngle = (s + 1) * anglePerSeg - Math.PI / 2;
                            ctx.fillStyle = msgColors[s];
                            ctx.beginPath();
                            ctx.moveTo(cx, cy);
                            ctx.arc(cx, cy, msgRadius, startAngle, endAngle);
                            ctx.closePath();
                            ctx.fill();
                        }
                    }
                }
            }
        }

        // 5. Qubits
        if (options.showErrors) {
            for (let i = 0; i < L; i++) {
                for (let j = 0; j < L; j++) {
                    const cx = offsetX + (i + 1.5) * cellSize;
                    const cy = offsetY + (L - j) * cellSize;
                    const hasError = this.lrQubits[i][j];
                    ctx.fillStyle = hasError ? '#dc2626' : 'black';
                    ctx.beginPath();
                    ctx.arc(cx, cy, hasError ? cellSize * 0.1 : cellSize * 0.05, 0, 2 * Math.PI);
                    ctx.fill();
                }
            }
            for (let i = 0; i < L - 1; i++) {
                for (let j = 1; j < L; j++) {
                    const cx = offsetX + (i + 2) * cellSize;
                    const cy = offsetY + (L + 0.5 - j) * cellSize;
                    const hasError = this.tbQubits[i][j];
                    ctx.fillStyle = hasError ? '#dc2626' : 'black';
                    ctx.beginPath();
                    ctx.arc(cx, cy, hasError ? cellSize * 0.1 : cellSize * 0.05, 0, 2 * Math.PI);
                    ctx.fill();
                }
            }
        }

        // Title
        const syndromeCount = this.getSyndromeCount();
        const isSplit = (this.stepCount > 0) && ((this.stepCount - 1) % this.qPrime === 0);
        const stepType = isSplit ? 'SPLIT' : 'CA';
        ctx.fillStyle = '#64748b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(
            `T=${this.stepCount} [${stepType}] | Defects: ${syndromeCount} | Clock: ${this.clock} | q'=${this.qPrime}`,
            canvasWidth / 2, offsetY - 5
        );
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const L = this.L;
        const padding = 20;
        const cellSize = Math.min((canvasWidth - 2 * padding) / (L + 2), (canvasHeight - 2 * padding) / (L + 1));
        const offsetX = (canvasWidth - cellSize * (L + 2)) / 2;
        const offsetY = (canvasHeight - cellSize * (L + 1)) / 2;

        let minDist = Infinity;
        let toggleType = null, toggleI = -1, toggleJ = -1;

        for (let i = 0; i < L; i++) {
            for (let j = 0; j < L; j++) {
                const cx = offsetX + (i + 1.5) * cellSize;
                const cy = offsetY + (L - j) * cellSize;
                const d = Math.hypot(x - cx, y - cy);
                if (d < minDist) { minDist = d; toggleType = 'lr'; toggleI = i; toggleJ = j; }
            }
        }
        for (let i = 0; i < L - 1; i++) {
            for (let j = 1; j < L; j++) {
                const cx = offsetX + (i + 2) * cellSize;
                const cy = offsetY + (L + 0.5 - j) * cellSize;
                const d = Math.hypot(x - cx, y - cy);
                if (d < minDist) { minDist = d; toggleType = 'tb'; toggleI = i; toggleJ = j; }
            }
        }

        if (minDist < cellSize * 0.4) {
            if (toggleType === 'lr') {
                this.lrQubits[toggleI][toggleJ] = !this.lrQubits[toggleI][toggleJ];
            } else if (toggleType === 'tb') {
                this.tbQubits[toggleI][toggleJ] = !this.tbQubits[toggleI][toggleJ];
            }
            this.calculateSyndrome();
        }
    }
}
