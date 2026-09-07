// Toric Code RGB Decoder Module - Properly Implemented
export class ToricRGBDecoder {
    constructor(L, clockPeriod = 6) {
        this.L = L;
        this.clockPeriod = clockPeriod;
        this.clock = 0;
        this.stepCount = 0;

        // Initialize qubits and messages
        this.hQubits = this.create2DArray(L, false); // horizontal qubits
        this.vQubits = this.create2DArray(L, false); // vertical qubits

        // Message grids
        this.bGrid = this.create2DArray(L, false); // blue messages
        this.rGrid = this.create2DArray(L, false); // red messages
        this.gGrid = this.create2DArray(L, false); // green messages

        // Syndrome
        this.syndrome = this.create2DArray(L, false);
        // Per-site clock for uncoordinated mode
        this.cellPhase = this.create2DArray(L, 0);
    }

    create2DArray(size, fillValue) {
        // Create array[row][col] where row=0 is top, col=0 is left (standard canvas/screen coords)
        return new Array(size).fill(null).map(() => new Array(size).fill(fillValue));
    }

    initializeRandomErrors(p) {
        for (let row = 0; row < this.L; row++) {
            for (let col = 0; col < this.L; col++) {
                this.hQubits[row][col] = Math.random() < p;
                this.vQubits[row][col] = Math.random() < p;
            }
        }
        this.calculateSyndrome();
    }

    mod(n, m) {
        return ((n % m) + m) % m;
    }

    calculateSyndrome() {
        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                // s(x,y) = v(x,y) XOR v(x+1,y) XOR h(x,y) XOR h(x,y+1)
                // We use same convention as Python: array[x][y] where x is horizontal, y is vertical
                // But in our rendering, y=0 is at bottom (to match matplotlib)
                const vRight = this.vQubits[this.mod(x + 1, this.L)][y];
                const hTop = this.hQubits[x][this.mod(y + 1, this.L)];
                this.syndrome[x][y] = this.vQubits[x][y] ^ vRight ^ this.hQubits[x][y] ^ hTop;
            }
        }
    }

    step() {
        this.calculateSyndrome();

        const nextB = this.create2DArray(this.L, false);
        const nextR = this.create2DArray(this.L, false);
        const nextG = this.create2DArray(this.L, false);

        const isC0 = (this.clock === 0);

        for (let x = 0; x < this.L; x++) {
            for (let y = 0; y < this.L; y++) {
                // Get neighbors using same convention as Python
                // array[x][y]: x=horizontal, y=vertical (upward in matplotlib)
                const bLeft = this.bGrid[this.mod(x - 1, this.L)][y];
                const bDown = this.bGrid[x][this.mod(y - 1, this.L)];

                const rLeft = this.rGrid[this.mod(x - 1, this.L)][y];
                const rUp = this.rGrid[x][this.mod(y + 1, this.L)];

                const gDown = this.gGrid[x][this.mod(y - 1, this.L)];
                const gRight = this.gGrid[this.mod(x + 1, this.L)][y];

                const sRight = this.syndrome[this.mod(x + 1, this.L)][y];
                const sUp = this.syndrome[x][this.mod(y + 1, this.L)];

                if (this.syndrome[x][y]) {
                    // === Case 1: s(x,y) == 1 ===
                    nextB[x][y] = true;
                    nextR[x][y] = true;
                    nextG[x][y] = true;

                    // Perform corrections
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

                    // Check for incoming syndrome
                    const ils = sRight && (this.bGrid[x][y] || this.rGrid[x][y]);

                    // For ids, need r(x-1, y+1) and b(x-1, y+1)
                    const rLeftUp = this.rGrid[this.mod(x - 1, this.L)][this.mod(y + 1, this.L)];
                    const bLeftUp = this.bGrid[this.mod(x - 1, this.L)][this.mod(y + 1, this.L)];
                    const ids = sUp && this.gGrid[x][y] && !rLeftUp && !bLeftUp;

                    const isFlag = ils || ids;

                    if (isFlag) {
                        // Incoming syndrome detected
                        nextB[x][y] = true;
                        nextR[x][y] = true;
                        nextG[x][y] = true;
                    } else {
                        // No incoming syndrome
                        if (isC0) {
                            // Growth phase (c == 0)
                            // Blue spreads from bottom-left quadrant (receives from down and left)
                            // This means blue SPREADS to top-right
                            if (!this.bGrid[x][y]) {
                                nextB[x][y] = bDown || bLeft;
                            } else {
                                nextB[x][y] = this.bGrid[x][y];
                            }

                            // Red spreads from top-left quadrant (receives from up and left)
                            // This means red SPREADS to bottom-right
                            if (!this.rGrid[x][y]) {
                                nextR[x][y] = rUp || rLeft;
                            } else {
                                nextR[x][y] = this.rGrid[x][y];
                            }

                            // Green spreads from bottom-right quadrant (receives from down and right)
                            // This means green SPREADS to top-left
                            if (!this.gGrid[x][y]) {
                                nextG[x][y] = gDown || gRight;
                            } else {
                                nextG[x][y] = this.gGrid[x][y];
                            }
                        } else {
                            // Majority voting phase
                            const rRight = this.rGrid[this.mod(x + 1, this.L)][y];

                            // Count neighbors for majority
                            const sumR = (rLeft ? 1 : 0) + (rUp ? 1 : 0) + (this.rGrid[x][y] ? 1 : 0);
                            const rm = sumR >= 2;

                            const sumB = (bLeft ? 1 : 0) + (bDown ? 1 : 0) + (this.bGrid[x][y] ? 1 : 0);
                            const bm = sumB >= 2;

                            const sumG = (gRight ? 1 : 0) + (gDown ? 1 : 0) + (this.gGrid[x][y] ? 1 : 0);
                            const gm = sumG >= 2;

                            if (this.bGrid[x][y]) {
                                nextB[x][y] = bm;
                            } else {
                                nextB[x][y] = false;
                            }

                            if (this.rGrid[x][y]) {
                                nextR[x][y] = rm || (bm && this.bGrid[x][y]);
                            } else {
                                nextR[x][y] = false;
                            }

                            if (this.gGrid[x][y]) {
                                nextG[x][y] = gm || (bm && this.bGrid[x][y]);
                            } else {
                                nextG[x][y] = false;
                            }
                        }
                    }
                }
            }
        }

        this.bGrid = nextB;
        this.rGrid = nextR;
        this.gGrid = nextG;

        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;
    }

    stepUncoord() {
        const x = Math.floor(Math.random() * this.L);
        const y = Math.floor(Math.random() * this.L);
        const isC0 = (this.cellPhase[x][y] === 0);

        const bLeft = this.bGrid[(x - 1 + this.L) % this.L][y];
        const bDown = this.bGrid[x][(y - 1 + this.L) % this.L];
        const rLeft = this.rGrid[(x - 1 + this.L) % this.L][y];
        const rUp = this.rGrid[x][(y + 1) % this.L];
        const gDown = this.gGrid[x][(y - 1 + this.L) % this.L];
        const gRight = this.gGrid[(x + 1) % this.L][y];
        const sRight = this.syndrome[(x + 1) % this.L][y];
        const sUp = this.syndrome[x][(y + 1) % this.L];

        if (this.syndrome[x][y]) {
            this.bGrid[x][y] = true;
            this.rGrid[x][y] = true;
            this.gGrid[x][y] = true;
            const doLeft = bLeft || rLeft;
            const doDown = !doLeft && gDown;
            if (doLeft) this.vQubits[x][y] = !this.vQubits[x][y];
            if (doDown) this.hQubits[x][y] = !this.hQubits[x][y];
        } else {
            const ils = sRight && (this.bGrid[x][y] || this.rGrid[x][y]);
            const rLeftUp = this.rGrid[(x - 1 + this.L) % this.L][(y + 1) % this.L];
            const bLeftUp = this.bGrid[(x - 1 + this.L) % this.L][(y + 1) % this.L];
            const ids = sUp && this.gGrid[x][y] && !rLeftUp && !bLeftUp;

            if (ils || ids) {
                this.bGrid[x][y] = true;
                this.rGrid[x][y] = true;
                this.gGrid[x][y] = true;
            } else {
                if (isC0) {
                    if (!this.bGrid[x][y]) this.bGrid[x][y] = bDown || bLeft;
                    if (!this.rGrid[x][y]) this.rGrid[x][y] = rUp || rLeft;
                    if (!this.gGrid[x][y]) this.gGrid[x][y] = gDown || gRight;
                }
                const bOrig = this.bGrid[x][y], rOrig = this.rGrid[x][y], gOrig = this.gGrid[x][y];
                const bm = ((bLeft ? 1 : 0) + (bDown ? 1 : 0) + (bOrig ? 1 : 0)) >= 2;
                const rm = ((rLeft ? 1 : 0) + (rUp ? 1 : 0) + (rOrig ? 1 : 0)) >= 2;
                const gm = ((gRight ? 1 : 0) + (gDown ? 1 : 0) + (gOrig ? 1 : 0)) >= 2;
                if (bOrig) this.bGrid[x][y] = bm;
                if (rOrig) this.rGrid[x][y] = rm || (bm && bOrig);
                if (gOrig) this.gGrid[x][y] = gm || (bm && bOrig);
            }
        }

        this.calculateSyndrome();
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

    checkLogicalError() {
        // Check for logical error (non-trivial loops)
        // Vertical winding: sum of v[0, :] mod 2
        // Horizontal winding: sum of h[:, 0] mod 2

        let windingV = 0;
        let windingH = 0;

        // Check vertical winding (first column of vertical qubits)
        for (let y = 0; y < this.L; y++) {
            if (this.vQubits[0][y]) windingV++;
        }

        // Check horizontal winding (first row of horizontal qubits)
        for (let x = 0; x < this.L; x++) {
            if (this.hQubits[x][0]) windingH++;
        }

        const hasVerticalLoop = (windingV % 2) !== 0;
        const hasHorizontalLoop = (windingH % 2) !== 0;

        return {
            hasError: hasVerticalLoop || hasHorizontalLoop,
            vertical: hasVerticalLoop,
            horizontal: hasHorizontalLoop
        };
    }

    render(ctx, canvasWidth, canvasHeight, options = {}) {
        // Default options if not provided
        const showGrid = options.showGrid !== undefined ? options.showGrid : true;
        const showErrors = options.showErrors !== undefined ? options.showErrors : true;
        const showMessages = options.showMessages !== undefined ? options.showMessages : true;
        const showSyndrome = options.showSyndrome !== undefined ? options.showSyndrome : true;

        // Calculate grid size to match matplotlib style
        const padding = 80;
        const availableSize = Math.min(canvasWidth - 2 * padding, canvasHeight - 2 * padding - 60); // Extra space for legend
        const cellSize = Math.floor(availableSize / this.L);

        const totalSize = cellSize * this.L;
        const offsetX = Math.floor((canvasWidth - totalSize) / 2);
        const offsetY = Math.floor((canvasHeight - totalSize - 60) / 2); // Account for legend at bottom

        // Vibrant colors for better visibility
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

        // Draw physical errors on edges (qubits)
        if (showErrors) {
            for (let x = 0; x < this.L; x++) {
                for (let y = 0; y < this.L; y++) {
                    // Flip y-coordinate to match matplotlib convention (y increases upward)
                    const visualY = this.L - 1 - y;

                    // Horizontal qubit h[x][y] is at BOTTOM edge of cell (x,y) in data coords
                    // In visual coords, bottom of data cell y is bottom of visual cell visualY
                    if (this.hQubits[x][y]) {
                        const qx = offsetX + x * cellSize + cellSize / 2;
                        const qy = offsetY + (visualY + 1) * cellSize;  // Bottom edge

                        ctx.strokeStyle = '#dc2626';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(qx - cellSize * 0.3, qy);
                        ctx.lineTo(qx + cellSize * 0.3, qy);
                        ctx.stroke();

                        // PBC copy: h[x][0] is also the top boundary of the grid
                        if (y === 0) {
                            ctx.beginPath();
                            ctx.moveTo(qx - cellSize * 0.3, offsetY);
                            ctx.lineTo(qx + cellSize * 0.3, offsetY);
                            ctx.stroke();
                        }
                    }

                    // Vertical qubit error (on vertical edge at left of cell)
                    if (this.vQubits[x][y]) {
                        const qx = offsetX + x * cellSize;
                        const qy = offsetY + visualY * cellSize + cellSize / 2;

                        ctx.strokeStyle = '#dc2626';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(qx, qy - cellSize * 0.3);
                        ctx.lineTo(qx, qy + cellSize * 0.3);
                        ctx.stroke();

                        // PBC copy: v[0][y] is also the right boundary of the grid
                        if (x === 0) {
                            ctx.beginPath();
                            ctx.moveTo(offsetX + totalSize, qy - cellSize * 0.3);
                            ctx.lineTo(offsetX + totalSize, qy + cellSize * 0.3);
                            ctx.stroke();
                        }
                    }
                }
            }
        }

        // Draw messages (b, r, g) as circles with wedges
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

                        // Draw syndrome circle
                        ctx.fillStyle = 'black';
                        ctx.beginPath();
                        ctx.arc(cx, cy, cellSize * 0.15, 0, 2 * Math.PI);
                        ctx.fill();
                    }
                }
            }
        }

        // Check for logical errors
        const logicalError = this.checkLogicalError();
        const syndromeCount = this.getSyndromeCount();

        // Draw title text at the top
        ctx.fillStyle = '#64748b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const titleText = `T=${this.stepCount} | Defects: ${syndromeCount} | Clock: ${this.clock}`;
        ctx.fillText(titleText, canvasWidth / 2, offsetY - 20);
        ctx.textAlign = 'left';

        // Draw logical error or success message when simulation is complete
        if (syndromeCount === 0 && !this.bGrid.some(row => row.some(v => v)) &&
            !this.rGrid.some(row => row.some(v => v)) && !this.gGrid.some(row => row.some(v => v))) {
            ctx.font = 'bold 20px sans-serif';
            const centerX = offsetX + totalSize / 2;
            const centerY = offsetY + totalSize / 2;

            if (logicalError.hasError) {
                // Draw LOGICAL ERROR box
                ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.fillRect(centerX - 120, centerY - 25, 240, 50);
                ctx.strokeStyle = '#dc2626';
                ctx.lineWidth = 2;
                ctx.strokeRect(centerX - 120, centerY - 25, 240, 50);
                ctx.fillStyle = '#dc2626';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('LOGICAL ERROR', centerX, centerY);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
            }
        }

        // Draw legend at the bottom (matching matplotlib layout)
        const legendY = offsetY + totalSize + 40;
        const legendSpacing = 125;
        const legendSpacingAnyon = 80;
        const legendStartX = offsetX + 10 + totalSize / 2 - legendSpacing * 1.5 - legendSpacingAnyon / 2;

        ctx.font = '500 12px JetBrains Mono, monospace';

        // Draw legend background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
        ctx.lineWidth = 1;
        ctx.fillRect(legendStartX - 20, legendY - 20, legendSpacing * 3 + legendSpacingAnyon + 20, 35);
        ctx.strokeRect(legendStartX - 20, legendY - 20, legendSpacing * 3 + legendSpacingAnyon + 20, 35);

        // Defect legend item
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.arc(legendStartX, legendY, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#374151';
        ctx.fillText('Anyon', legendStartX + 12, legendY + 4.5);

        // Blue (b) legend item
        const blueX = legendStartX + legendSpacingAnyon;
        ctx.fillStyle = colorB;
        ctx.fillRect(blueX - 6, legendY - 6, 12, 12);
        ctx.fillStyle = '#374151';
        ctx.fillText('Blue msg', blueX + 10, legendY + 4.5);

        // Red (r) legend item
        const redX = legendStartX + legendSpacingAnyon + legendSpacing;
        ctx.fillStyle = colorR;
        ctx.fillRect(redX - 6, legendY - 6, 12, 12);
        ctx.fillStyle = '#374151';
        ctx.fillText('Red msg', redX + 10, legendY + 4.5);

        // Green (g) legend item
        const greenX = legendStartX + legendSpacingAnyon + legendSpacing * 2;
        ctx.fillStyle = colorG;
        ctx.fillRect(greenX - 6, legendY - 6, 12, 12);
        ctx.fillStyle = '#374151';
        ctx.fillText('Green msg', greenX + 10, legendY + 4.5);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        // Match the same layout calculation as render()
        const padding = 80;
        const availableSize = Math.min(canvasWidth - 2 * padding, canvasHeight - 2 * padding - 60);
        const cellSize = Math.floor(availableSize / this.L);

        const totalSize = cellSize * this.L;
        const offsetX = Math.floor((canvasWidth - totalSize) / 2);
        const offsetY = Math.floor((canvasHeight - totalSize - 60) / 2);

        // Convert click position to grid coordinates
        const relX = x - offsetX;
        const relY = y - offsetY;

        if (relX < 0 || relX > totalSize || relY < 0 || relY > totalSize) return;

        const gridX = Math.floor(relX / cellSize);
        const visualGridY = Math.floor(relY / cellSize);

        // Flip y-coordinate back to data coordinates
        const gridY = this.L - 1 - visualGridY;

        // Determine which edge was clicked
        const cellRelX = relX % cellSize;
        const cellRelY = relY % cellSize;

        // h[x][y] is at BOTTOM of cell (x,y) in data coords = TOP of visual cell
        // v[x][y] is at LEFT of cell (x,y) in both coords

        // Click near top edge of visual cell -> h at the grid line above this cell
        if (cellRelY < cellSize * 0.25) {
            this.hQubits[gridX][this.mod(gridY + 1, this.L)] = !this.hQubits[gridX][this.mod(gridY + 1, this.L)];
        }
        // Click near left edge -> vertical qubit (mod handles right-boundary PBC copy where gridX==L)
        else if (cellRelX < cellSize * 0.25) {
            this.vQubits[this.mod(gridX, this.L)][gridY] = !this.vQubits[this.mod(gridX, this.L)][gridY];
        }
        // Click near bottom edge -> h at the grid line below this cell
        else if (cellRelY > cellSize * 0.75) {
            this.hQubits[gridX][gridY] = !this.hQubits[gridX][gridY];
        }
        // Click near right edge -> vertical qubit of cell to right
        else if (cellRelX > cellSize * 0.75) {
            this.vQubits[this.mod(gridX + 1, this.L)][gridY] = !this.vQubits[this.mod(gridX + 1, this.L)][gridY];
        }

        this.calculateSyndrome();
    }
}