// Surface Code Decoder Module
export class SurfaceCodeDecoder {
    constructor(L, clockPeriod = 6) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;

        // Initialize qubits
        // tb_qubits: Top/Bottom qubits of each plaquette (L-1 x L+1) with padding
        this.tbQubits = new Array(L - 1).fill(null).map(() => new Array(L + 1).fill(false));

        // lr_qubits: Left/Right qubits of each plaquette (L x L)
        this.lrQubits = new Array(L).fill(null).map(() => new Array(L).fill(false));

        // Message grids (L+1 x L) for stabilizers
        this.bGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.rGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.gGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

        // Virtual boundary messages
        this.mlGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        this.mrGrid = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

        // Syndrome (L+1 x L)
        this.syndrome = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
    }

    initializeRandomErrors(p) {
        // Initialize tb_qubits (top/bottom)
        for (let i = 0; i < this.L - 1; i++) {
            for (let j = 1; j < this.L; j++) {
                this.tbQubits[i][j] = Math.random() < p;
            }
        }

        // Initialize lr_qubits (left/right)
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                this.lrQubits[i][j] = Math.random() < p;
            }
        }

        this.calculateSyndrome();
    }

    calculateSyndrome() {
        // Calculate syndrome for Z-stabilizers
        for (let i = 1; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                const leftQubit = this.lrQubits[i - 1][j];
                const rightQubit = this.lrQubits[i][j];
                const topQubit = j < this.L - 1 ? this.tbQubits[i - 1][j + 1] : false;
                const bottomQubit = j > 0 ? this.tbQubits[i - 1][j] : false;

                this.syndrome[i][j] = leftQubit ^ rightQubit ^ topQubit ^ bottomQubit;
            }
        }

        // Virtual stabilizers at boundaries
        this.syndrome[0] = new Array(this.L).fill(false);
        this.syndrome[this.L] = new Array(this.L).fill(false);
    }

    step() {
        this.calculateSyndrome();

        const L = this.L;
        const newB = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newR = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newG = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newMl = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));
        const newMr = new Array(L + 1).fill(null).map(() => new Array(L).fill(false));

        // New qubits after corrections
        const newTbQubits = this.tbQubits.map(row => [...row]);
        const newLrQubits = this.lrQubits.map(row => [...row]);

        // Message propagation for boundaries (ml/mr)
        if (this.clock === 0) {
            // Move Left: Source at left boundary, propagates right
            for (let j = 0; j < L; j++) {
                newMl[0][j] = true;
                for (let i = 1; i <= L; i++) {
                    newMl[i][j] = this.mlGrid[i - 1][j];
                }
            }

            // Move Right: Source at right boundary, propagates left
            for (let j = 0; j < L; j++) {
                newMr[L][j] = true;
                for (let i = 0; i < L; i++) {
                    newMr[i][j] = this.mrGrid[i + 1][j];
                }
            }
        } else {
            // Keep current state
            for (let i = 0; i <= L; i++) {
                for (let j = 0; j < L; j++) {
                    newMl[i][j] = this.mlGrid[i][j];
                    newMr[i][j] = this.mrGrid[i][j];
                }
            }
        }

        // Process each stabilizer position
        for (let i = 0; i <= L; i++) {
            for (let j = 0; j < L; j++) {
                const s = this.syndrome[i][j];

                // Get neighbor values (with boundary handling)
                const bLeft = i > 0 ? this.bGrid[i - 1][j] : false;
                const bDown = j > 0 ? this.bGrid[i][j - 1] : false;

                const rLeft = i > 0 ? this.rGrid[i - 1][j] : false;
                const rUp = j < L - 1 ? this.rGrid[i][j + 1] : false;

                const gRight = i < L ? this.gGrid[i + 1][j] : false;
                const gDown = j > 0 ? this.gGrid[i][j - 1] : false;

                const sRight = i < L ? this.syndrome[i + 1][j] : false;
                const sUp = j < L - 1 ? this.syndrome[i][j + 1] : false;

                const rLeftUp = i > 0 && j < L - 1 ? this.rGrid[i - 1][j + 1] : false;
                const bLeftUp = i > 0 && j < L - 1 ? this.bGrid[i - 1][j + 1] : false;

                const mlLeft = i > 0 ? this.mlGrid[i - 1][j] : false;
                const mrRight = i < L ? this.mrGrid[i + 1][j] : false;

                if (s) {
                    // Syndrome present: set all messages to 1
                    newB[i][j] = true;
                    newR[i][j] = true;
                    newG[i][j] = true;

                    // Apply corrections based on incoming messages
                    const leftActive = bLeft || rLeft || mlLeft;

                    const doRight = s && mrRight;
                    const doLeft = s && leftActive && !doRight;
                    const doDown = s && !doLeft && !doRight && gDown;

                    // Apply corrections to qubits
                    if (doLeft && i > 0) {
                        newLrQubits[i - 1][j] = !newLrQubits[i - 1][j];
                    }
                    if (doRight && i < L) {
                        newLrQubits[i][j] = !newLrQubits[i][j];
                    }
                    if (doDown && i > 0 && i < L && j > 0) {
                        newTbQubits[i - 1][j] = !newTbQubits[i - 1][j];
                    }
                } else {
                    // No syndrome

                    // Check for incoming syndrome
                    const ils = sRight && (this.bGrid[i][j] || this.rGrid[i][j]);
                    const ids = sUp && this.gGrid[i][j] && !rLeftUp && !bLeftUp;
                    const isFlag = ils || ids;

                    if (isFlag) {
                        // Incoming syndrome: set all messages to 1
                        newB[i][j] = true;
                        newR[i][j] = true;
                        newG[i][j] = true;
                    } else {
                        // No syndrome, no incoming syndrome
                        const isC0 = this.clock === 0;

                        if (isC0) {
                            // Growth phase
                            if (!this.bGrid[i][j]) {
                                newB[i][j] = bDown || bLeft;
                            } else {
                                // Majority for blue
                                const sumB = (bLeft ? 1 : 0) + (bDown ? 1 : 0) + (this.bGrid[i][j] ? 1 : 0);
                                newB[i][j] = sumB >= 2;
                            }

                            if (!this.rGrid[i][j]) {
                                newR[i][j] = rUp || rLeft;
                            } else {
                                // Majority for red
                                const sumR = (rLeft ? 1 : 0) + (rUp ? 1 : 0) + (this.rGrid[i][j] ? 1 : 0);
                                const bm = newB[i][j];
                                newR[i][j] = (sumR >= 2) || (bm && this.bGrid[i][j]);
                            }

                            if (!this.gGrid[i][j]) {
                                newG[i][j] = gDown || gRight;
                            } else {
                                // Majority for green
                                const sumG = (gRight ? 1 : 0) + (gDown ? 1 : 0) + (this.gGrid[i][j] ? 1 : 0);
                                const bm = newB[i][j];
                                newG[i][j] = (sumG >= 2) || (bm && this.bGrid[i][j]);
                            }
                        } else {
                            // Not growth phase - apply majority only if message exists
                            if (this.bGrid[i][j]) {
                                const sumB = (bLeft ? 1 : 0) + (bDown ? 1 : 0) + 1;
                                newB[i][j] = sumB >= 2;
                            } else {
                                newB[i][j] = false;
                            }

                            if (this.rGrid[i][j]) {
                                const sumR = (rLeft ? 1 : 0) + (rUp ? 1 : 0) + 1;
                                const bm = newB[i][j];
                                newR[i][j] = (sumR >= 2) || (bm && this.bGrid[i][j]);
                            } else {
                                newR[i][j] = false;
                            }

                            if (this.gGrid[i][j]) {
                                const sumG = (gRight ? 1 : 0) + (gDown ? 1 : 0) + 1;
                                const bm = newB[i][j];
                                newG[i][j] = (sumG >= 2) || (bm && this.bGrid[i][j]);
                            } else {
                                newG[i][j] = false;
                            }
                        }
                    }
                }
            }
        }

        this.bGrid = newB;
        this.rGrid = newR;
        this.gGrid = newG;
        this.mlGrid = newMl;
        this.mrGrid = newMr;
        this.tbQubits = newTbQubits;
        this.lrQubits = newLrQubits;

        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;
    }

    getSyndromeCount() {
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
                if (this.bGrid[i][j] || this.rGrid[i][j] || this.gGrid[i][j] ||
                    this.mlGrid[i][j] || this.mrGrid[i][j]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    checkLogicalError() {
        // For surface code, check for logical Z error
        // This is detected by counting the parity of X errors along a horizontal line
        // The logical operator is a string of X errors connecting left to right boundaries

        // Check the winding number (parity) of errors along the middle row
        // This matches the Python implementation: winding = jnp.sum(lr_qubits[L//2, :]) % 2
        const midRow = Math.floor(this.L / 2);
        let winding = 0;

        for (let j = 0; j < this.L; j++) {
            if (this.lrQubits[midRow][j]) {
                winding++;
            }
        }

        // Logical error if winding number is odd
        const hasLogicalError = (winding % 2) !== 0;

        return {
            hasError: hasLogicalError,
            horizontal: hasLogicalError,
            vertical: false  // Surface code with these boundaries only has horizontal logical
        };
    }

    render(ctx, canvasWidth, canvasHeight, options) {
        const L = this.L;
        const padding = 20;
        const availableWidth = canvasWidth - 2 * padding;
        const availableHeight = canvasHeight - 2 * padding;

        // Python uses xlim=[-0.5, L+1.5] (range L+2) and ylim=[-0.5, L+0.5] (range L+1)
        const cellSize = Math.min(availableWidth / (L + 2), availableHeight / (L + 1));
        const totalW = cellSize * (L + 2);
        const totalH = cellSize * (L + 1);
        const offsetX = (canvasWidth - totalW) / 2;
        const offsetY = (canvasHeight - totalH) / 2;

        // Convert Python grid coords (gx, gy) to canvas coords
        // Python: xlim [-0.5, L+1.5], ylim [-0.5, L+0.5] with y increasing upward
        const px = (gx) => offsetX + (gx + 0.5) * cellSize;
        const py = (gy) => offsetY + (L + 0.5 - gy) * cellSize;

        const h = cellSize / 2;

        // Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // 1. X-plaquette diamond backgrounds: center at (i+1, j) for i=0..L-1, j=0..L
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

        // 2. Z-stabilizers: stabilizer [i][j] has Python center (i+0.5, j+0.5)
        //    Canvas center: (offsetX + (i+1)*cellSize, offsetY + (L-j)*cellSize)
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
                    // Bottom boundary: triangle pointing up (flat bottom, apex at top) - half height
                    ctx.moveTo(cx - h, cy);
                    ctx.lineTo(cx + h, cy);
                    ctx.lineTo(cx, cy - h);
                } else if (j === L - 1) {
                    // Top boundary: triangle pointing down (flat top, apex at bottom) - half height
                    ctx.moveTo(cx - h, cy);
                    ctx.lineTo(cx + h, cy);
                    ctx.lineTo(cx, cy + h);
                } else {
                    // Interior: full diamond
                    ctx.moveTo(cx - h, cy);
                    ctx.lineTo(cx, cy + h);
                    ctx.lineTo(cx + h, cy);
                    ctx.lineTo(cx, cy - h);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }

        // 3. Defect circles (syndromes)
        if (options.showSyndrome) {
            for (let i = 0; i <= L; i++) {
                for (let j = 0; j < L; j++) {
                    if (this.syndrome[i][j]) {
                        const cx = offsetX + (i + 1) * cellSize;
                        const cy = offsetY + (L - j) * cellSize;
                        ctx.fillStyle = 'rgba(230,230,77,1.0)';
                        ctx.strokeStyle = 'black';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.arc(cx, cy, cellSize * 0.22, 0, 2 * Math.PI);
                        ctx.fill();
                        ctx.stroke();
                    }
                }
            }
        }

        // 4. Message wedges (pie chart style, 5 segments: B, R, G, ML, MR)
        if (options.showMessages) {
            const msgRadius = cellSize * 0.3;
            const anglePerSeg = (2 * Math.PI) / 5;
            const msgColors = [
                'rgba(96,165,250,0.55)',   // Blue (SW)
                'rgba(248,113,113,0.55)',  // Red (NW)
                'rgba(52,211,153,0.55)',   // Green (SE)
                'rgba(192,132,252,0.55)',  // Purple (Boundary L)
                'rgba(34,211,238,0.55)',   // Cyan (Boundary R)
            ];

            for (let i = 0; i <= L; i++) {
                for (let j = 0; j < L; j++) {
                    const cx = offsetX + (i + 1) * cellSize;
                    const cy = offsetY + (L - j) * cellSize;

                    const msgs = [
                        this.bGrid[i][j],
                        this.rGrid[i][j],
                        this.gGrid[i][j],
                        this.mlGrid[i][j],
                        this.mrGrid[i][j],
                    ];

                    for (let s = 0; s < 5; s++) {
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

        // 5. Qubits: lr_qubits at (i+1, j+0.5), tb_qubits at (i+1.5, j)
        if (options.showErrors) {
            // lr_qubits: canvas (offsetX + (i+1.5)*cellSize, offsetY + (L-j)*cellSize)
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

            // tb_qubits: canvas (offsetX + (i+2)*cellSize, offsetY + (L+0.5-j)*cellSize), j=1..L-1
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
        ctx.fillStyle = '#64748b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`T=${this.stepCount} | Defects: ${syndromeCount} | Clock: ${this.clock}`,
                     canvasWidth / 2, offsetY - 5);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const L = this.L;
        const padding = 20;
        const cellSize = Math.min((canvasWidth - 2 * padding) / (L + 2), (canvasHeight - 2 * padding) / (L + 1));
        const offsetX = (canvasWidth - cellSize * (L + 2)) / 2;
        const offsetY = (canvasHeight - cellSize * (L + 1)) / 2;

        // Find nearest qubit to click position
        let minDist = Infinity;
        let toggleType = null, toggleI = -1, toggleJ = -1;

        // Check lr_qubits at canvas (offsetX + (i+1.5)*cellSize, offsetY + (L-j)*cellSize)
        for (let i = 0; i < L; i++) {
            for (let j = 0; j < L; j++) {
                const cx = offsetX + (i + 1.5) * cellSize;
                const cy = offsetY + (L - j) * cellSize;
                const d = Math.hypot(x - cx, y - cy);
                if (d < minDist) { minDist = d; toggleType = 'lr'; toggleI = i; toggleJ = j; }
            }
        }

        // Check tb_qubits at canvas (offsetX + (i+2)*cellSize, offsetY + (L+0.5-j)*cellSize), j=1..L-1
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