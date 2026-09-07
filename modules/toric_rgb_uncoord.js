// Toric Code RGB Uncoordinated Decoder Module
export class ToricRGBUncoordDecoder {
    constructor(L, clockPeriod = 6) {
        this.L = L;
        this.stepCount = 0;
        this.clock = 0; // Not used in uncoordinated version
        this.clockPeriod = clockPeriod; // Not used but kept for API consistency

        // Initialize qubits and messages (same as coordinated version)
        this.hQubits = new Array(L).fill(null).map(() => new Array(L).fill(false));
        this.vQubits = new Array(L).fill(null).map(() => new Array(L).fill(false));

        // Message grids - same as coordinated version
        this.bGrid = new Array(L).fill(null).map(() => new Array(L).fill(false)); // blue messages
        this.rGrid = new Array(L).fill(null).map(() => new Array(L).fill(false)); // red messages
        this.gGrid = new Array(L).fill(null).map(() => new Array(L).fill(false)); // green messages

        // Syndrome
        this.syndrome = new Array(L).fill(null).map(() => new Array(L).fill(false));

        // Per-site clock (starts at 0 for all sites)
        this.cellPhase = new Array(L).fill(null).map(() =>
            new Array(L).fill(0)
        );
    }

    initializeRandomErrors(p) {
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                this.hQubits[i][j] = Math.random() < p;
                this.vQubits[i][j] = Math.random() < p;
            }
        }
        this.calculateSyndrome();
    }

    calculateSyndrome() {
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                const vRight = this.vQubits[(x + 1) % this.L][y];
                const hTop = this.hQubits[x][(y + 1) % this.L];
                this.syndrome[x][y] = this.vQubits[x][y] ^ vRight ^ this.hQubits[x][y] ^ hTop;
            }
        }
    }

    step() {
        this.calculateSyndrome();

        // UNCOORDINATED: Only update one random site per step
        const x = Math.floor(Math.random() * this.L);
        const y = Math.floor(Math.random() * this.L);

        // Get current clock value for this site (before incrementing)
        const isC0 = (this.cellPhase[x][y] === 0);

        // Get neighbors using same convention as coordinated version
        const bLeft = this.bGrid[(x - 1 + this.L) % this.L][y];
        const bDown = this.bGrid[x][(y - 1 + this.L) % this.L];

        const rLeft = this.rGrid[(x - 1 + this.L) % this.L][y];
        const rUp = this.rGrid[x][(y + 1) % this.L];

        const gDown = this.gGrid[x][(y - 1 + this.L) % this.L];
        const gRight = this.gGrid[(x + 1) % this.L][y];

        const sRight = this.syndrome[(x + 1) % this.L][y];
        const sUp = this.syndrome[x][(y + 1) % this.L];

        if (this.syndrome[x][y]) {
            // === Case 1: s(x,y) == 1 ===
            this.bGrid[x][y] = true;
            this.rGrid[x][y] = true;
            this.gGrid[x][y] = true;

            // Perform corrections ONLY when syndrome is present
            const condLeft = bLeft || rLeft;
            const doLeft = condLeft;

            const condDown = gDown;
            const doDown = !doLeft && condDown;

            if (doLeft) {
                this.vQubits[x][y] = !this.vQubits[x][y];
            }
            if (doDown) {
                this.hQubits[x][y] = !this.hQubits[x][y];
            }
        } else {
            // === Case 2: s(x,y) == 0 ===
            // NO CORRECTIONS in this case!

            // Check for incoming syndrome
            const ils = sRight && (this.bGrid[x][y] || this.rGrid[x][y]);

            // For ids, need r(x-1, y+1) and b(x-1, y+1)
            const rLeftUp = this.rGrid[(x - 1 + this.L) % this.L][(y + 1) % this.L];
            const bLeftUp = this.bGrid[(x - 1 + this.L) % this.L][(y + 1) % this.L];
            const ids = sUp && this.gGrid[x][y] && !rLeftUp && !bLeftUp;

            const isFlag = ils || ids;

            if (isFlag) {
                // Incoming syndrome detected
                this.bGrid[x][y] = true;
                this.rGrid[x][y] = true;
                this.gGrid[x][y] = true;
            } else {
                // No incoming syndrome - apply growth AND majority logic

                // Growth phase (c == 0 AND message is 0)
                if (isC0) {
                    if (!this.bGrid[x][y]) {
                        this.bGrid[x][y] = bDown || bLeft;
                    }

                    if (!this.rGrid[x][y]) {
                        this.rGrid[x][y] = rUp || rLeft;
                    }

                    if (!this.gGrid[x][y]) {
                        this.gGrid[x][y] = gDown || gRight;
                    }
                }

                // Majority voting - applies when message is 1 (regardless of clock)
                // Store original values before any updates
                const bOriginal = this.bGrid[x][y];
                const rOriginal = this.rGrid[x][y];
                const gOriginal = this.gGrid[x][y];

                // Count neighbors for majority
                const sumB = (bLeft ? 1 : 0) + (bDown ? 1 : 0) + (bOriginal ? 1 : 0);
                const bm = sumB >= 2;

                const sumR = (rLeft ? 1 : 0) + (rUp ? 1 : 0) + (rOriginal ? 1 : 0);
                const rm = sumR >= 2;

                const sumG = (gRight ? 1 : 0) + (gDown ? 1 : 0) + (gOriginal ? 1 : 0);
                const gm = sumG >= 2;

                // Only update if message is currently 1
                if (bOriginal) {
                    this.bGrid[x][y] = bm;
                }

                if (rOriginal) {
                    this.rGrid[x][y] = rm || (bm && bOriginal);
                }

                if (gOriginal) {
                    this.gGrid[x][y] = gm || (bm && bOriginal);
                }
            }
        }

        // Increment the clock for this site AFTER the update
        this.cellPhase[x][y] = (this.cellPhase[x][y] + 1) % this.clockPeriod;

        this.stepCount++;
    }

    getSyndromeCount() {
        let count = 0;
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.syndrome[i][j]) count++;
            }
        }
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.hQubits[i][j]) count++;
                if (this.vQubits[i][j]) count++;
            }
        }
        return count;
    }

    hasMessages() {
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                if (this.bGrid[i][j] || this.rGrid[i][j] || this.gGrid[i][j]) return true;
            }
        }
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        // Default options if not provided
        const showGrid = options.showGrid !== undefined ? options.showGrid : true;
        const showErrors = options.showErrors !== undefined ? options.showErrors : true;
        const showMessages = options.showMessages !== undefined ? options.showMessages : true;
        const showSyndrome = options.showSyndrome !== undefined ? options.showSyndrome : true;

        // Calculate grid size to match matplotlib style (same as coordinated version)
        const padding = 80;
        const availableSize = Math.min(canvasWidth - 2 * padding, canvasHeight - 2 * padding - 60); // Extra space for legend
        const cellSize = Math.floor(availableSize / this.L);

        const totalSize = cellSize * this.L;
        const offsetX = Math.floor((canvasWidth - totalSize) / 2);
        const offsetY = Math.floor((canvasHeight - totalSize - 60) / 2); // Account for legend at bottom

        // Vibrant colors for better visibility (same as coordinated version)
        const colorB = 'rgba(37, 99, 235, 0.7)'; // Bright blue
        const colorR = 'rgba(220, 38, 38, 0.7)'; // Bright red
        const colorG = 'rgba(22, 163, 74, 0.7)'; // Bright green

        // Clear canvas
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Draw grid lines
        if (showGrid) {
            ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
            ctx.lineWidth = 1;
            ctx.setLineDash([]); // Solid lines

            // Draw vertical lines
            for (let i = 0; i <= this.L; i++) {
                ctx.beginPath();
                ctx.moveTo(offsetX + i * cellSize + 0.5, offsetY + 0.5);
                ctx.lineTo(offsetX + i * cellSize + 0.5, offsetY + totalSize + 0.5);
                ctx.stroke();
            }

            // Draw horizontal lines
            for (let i = 0; i <= this.L; i++) {
                ctx.beginPath();
                ctx.moveTo(offsetX + 0.5, offsetY + i * cellSize + 0.5);
                ctx.lineTo(offsetX + totalSize + 0.5, offsetY + i * cellSize + 0.5);
                ctx.stroke();
            }
        }

        // Draw physical errors on edges (qubits) - same as coordinated
        if (showErrors) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) {
                    // Flip y-coordinate to match matplotlib convention (y increases upward)
                    const visualY = this.L - 1 - y;

                    // Horizontal qubit h[x][y] is at BOTTOM edge of cell (x,y) in data coords
                    if (this.hQubits[x][y]) {
                        const qx = offsetX + x * cellSize + cellSize / 2;
                        const qy = offsetY + (visualY + 1) * cellSize;  // Bottom edge

                        ctx.strokeStyle = '#dc2626'; // Red color for errors
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(qx - cellSize * 0.3, qy);
                        ctx.lineTo(qx + cellSize * 0.3, qy);
                        ctx.stroke();
                    }

                    // Vertical qubit error (on vertical edge at left of cell)
                    if (this.vQubits[x][y]) {
                        const qx = offsetX + x * cellSize;
                        const qy = offsetY + visualY * cellSize + cellSize / 2;

                        ctx.strokeStyle = '#dc2626'; // Red color for errors
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(qx, qy - cellSize * 0.3);
                        ctx.lineTo(qx, qy + cellSize * 0.3);
                        ctx.stroke();
                    }
                }
            }
        }

        // Draw messages (b, r, g) as circles with wedges - same as coordinated
        if (showMessages) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) {
                    // Flip y-coordinate to match matplotlib convention (y increases upward)
                    const visualY = this.L - 1 - y;

                    const hasB = this.bGrid[x][y];
                    const hasR = this.rGrid[x][y];
                    const hasG = this.gGrid[x][y];

                    const activeColors = [];
                    if (hasB) activeColors.push(colorB);
                    if (hasR) activeColors.push(colorR);
                    if (hasG) activeColors.push(colorG);

                    if (activeColors.length === 0) continue;

                    const cx = offsetX + x * cellSize + cellSize / 2;
                    const cy = offsetY + visualY * cellSize + cellSize / 2;
                    const radius = cellSize * 0.45; // Matching Python: 0.45

                    if (activeColors.length === 1) {
                        // Single color: draw full circle
                        ctx.fillStyle = activeColors[0];
                        ctx.beginPath();
                        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
                        ctx.fill();
                    } else {
                        // Multiple colors: split into wedges
                        const anglePerWedge = (2 * Math.PI) / activeColors.length;
                        let startAngle = Math.PI / 2; // Start at top (90 degrees)

                        for (let i = 0; i < activeColors.length; i++) {
                            const endAngle = startAngle + anglePerWedge;
                            ctx.fillStyle = activeColors[i];
                            ctx.beginPath();
                            ctx.moveTo(cx, cy);
                            ctx.arc(cx, cy, radius, startAngle, endAngle);
                            ctx.closePath();
                            ctx.fill();
                            startAngle = endAngle;
                        }
                    }
                }
            }
        }

        // Draw syndromes (defects) as black dots - on top of everything else
        if (showSyndrome) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) {
                    // Flip y-coordinate to match matplotlib convention (y increases upward)
                    const visualY = this.L - 1 - y;

                    if (this.syndrome[x][y]) {
                        const cx = offsetX + x * cellSize + cellSize / 2;
                        const cy = offsetY + visualY * cellSize + cellSize / 2;

                        // Draw black circle for syndrome
                        ctx.fillStyle = 'black';
                        ctx.beginPath();
                        ctx.arc(cx, cy, cellSize * 0.15, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                }
            }
        }

        // Draw title at the top (consistent styling)
        const syndromeCount = this.getSyndromeCount();
        ctx.fillStyle = '#64748b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const titleText = `T=${this.stepCount} | Defects: ${syndromeCount}`;
        ctx.fillText(titleText, canvasWidth / 2, offsetY - 20);

        // Add small note that this is uncoordinated version
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillText('(Uncoordinated)', canvasWidth / 2, offsetY - 5);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const padding = 40;
        const availableWidth = canvasWidth - 2 * padding;
        const availableHeight = canvasHeight - 2 * padding;
        const cellSize = Math.min(availableWidth / this.L, availableHeight / this.L);

        const offsetX = (canvasWidth - cellSize * this.L) / 2;
        const offsetY = (canvasHeight - cellSize * this.L) / 2;

        const gridX = Math.floor((x - offsetX) / cellSize);
        const gridY = Math.floor((y - offsetY) / cellSize);

        if (gridX >= 0 && gridX < this.L && gridY >= 0 && gridY < this.L) {
            const cellX = (x - offsetX) % cellSize;
            const cellY = (y - offsetY) % cellSize;

            if (Math.abs(cellX - cellSize / 2) > Math.abs(cellY - cellSize / 2)) {
                if (cellX > cellSize / 2 && gridX < this.L - 1) {
                    this.vQubits[gridX + 1][gridY] = !this.vQubits[gridX + 1][gridY];
                } else if (cellX <= cellSize / 2) {
                    this.vQubits[gridX][gridY] = !this.vQubits[gridX][gridY];
                }
            } else {
                if (cellY > cellSize / 2 && gridY < this.L - 1) {
                    this.hQubits[gridX][gridY + 1] = !this.hQubits[gridX][gridY + 1];
                } else if (cellY <= cellSize / 2) {
                    this.hQubits[gridX][gridY] = !this.hQubits[gridX][gridY];
                }
            }

            this.calculateSyndrome();
        }
    }
}