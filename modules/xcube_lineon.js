// X-Cube Lineon Decoder Module
export class XCubeLineonDecoder {
    constructor(L) {
        this.L = L;
        this.clockPeriod = 10;
        this.clock = 0;
        this.stepCount = 0;

        // 3D link variables [x/y/z edges]
        this.links = [
            this.create3DArray(L, false), // x-links
            this.create3DArray(L, false), // y-links
            this.create3DArray(L, false)  // z-links
        ];

        // Syndromes and lineons
        this.syndrome = this.create3DArray(L, false);
        this.ell1 = this.create3DArray(L, false); // x-lineon
        this.ell2 = this.create3DArray(L, false); // y-lineon
        this.ell3 = this.create3DArray(L, false); // z-lineon

        // Memory fields (8 fields per vertex)
        this.memory = new Array(2).fill(null).map(() =>
            new Array(2).fill(null).map(() =>
                new Array(2).fill(null).map(() =>
                    this.create3DArray(L, false)
                )
            )
        );
    }

    create3DArray(size, fillValue) {
        return new Array(size).fill(null).map(() =>
            new Array(size).fill(null).map(() =>
                new Array(size).fill(fillValue)
            )
        );
    }

    initializeRandomErrors(p) {
        for (let dir = 0; dir < 3; dir++) {
            for (let i = 0; i < this.L; i++) {
                for (let j = 0; j < this.L; j++) {
                    for (let k = 0; k < this.L; k++) {
                        this.links[dir][i][j][k] = Math.random() < p;
                    }
                }
            }
        }
        this.calculateSyndrome();
    }

    calculateSyndrome() {
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                for (let k = 0; k < this.L; k++) {
                    // X-cube lineon stabilizers
                    const lx = this.links[0][i][j][k];
                    const ly = this.links[1][i][j][k];
                    const lz = this.links[2][i][j][k];

                    const lxm1 = this.links[0][(i - 1 + this.L) % this.L][j][k];
                    const lym1 = this.links[1][i][(j - 1 + this.L) % this.L][k];
                    const lzm1 = this.links[2][i][j][(k - 1 + this.L) % this.L];

                    // Raw violations
                    const raw3 = lx ^ lxm1 ^ ly ^ lym1; // z-lineon
                    const raw2 = lx ^ lxm1 ^ lz ^ lzm1; // y-lineon
                    const raw1 = ly ^ lym1 ^ lz ^ lzm1; // x-lineon

                    // Single-third reduction
                    this.ell1[i][j][k] = raw2 && raw3;
                    this.ell2[i][j][k] = raw1 && raw3;
                    this.ell3[i][j][k] = raw1 && raw2;

                    this.syndrome[i][j][k] = this.ell1[i][j][k] || this.ell2[i][j][k] || this.ell3[i][j][k];
                }
            }
        }
    }

    step() {
        this.calculateSyndrome();

        // Update memory fields based on syndrome
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                for (let k = 0; k < this.L; k++) {
                    if (this.syndrome[i][j][k]) {
                        // Set all memory fields to true at syndrome sites
                        for (let mi = 0; mi < 2; mi++) {
                            for (let mj = 0; mj < 2; mj++) {
                                for (let mk = 0; mk < 2; mk++) {
                                    this.memory[mi][mj][mk][i][j][k] = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Perform moves based on clock and memory
        if (this.clock === 0 || this.clock === 5) {
            // Apply corrections based on memory and lineon types
            for (let i = 0; i < this.L; i++) {
                for (let j = 0; j < this.L; j++) {
                    for (let k = 0; k < this.L; k++) {
                        // Simple correction rule for demonstration
                        if (this.ell1[i][j][k] && this.memory[0][0][0][i][j][k]) {
                            this.links[0][i][j][k] = !this.links[0][i][j][k];
                        }
                        if (this.ell2[i][j][k] && this.memory[0][1][0][i][j][k]) {
                            this.links[1][i][j][k] = !this.links[1][i][j][k];
                        }
                        if (this.ell3[i][j][k] && this.memory[0][0][1][i][j][k]) {
                            this.links[2][i][j][k] = !this.links[2][i][j][k];
                        }
                    }
                }
            }
        }

        this.clock = (this.clock + 1) % this.clockPeriod;
        this.stepCount++;
    }

    getSyndromeCount() {
        let count = 0;
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                for (let k = 0; k < this.L; k++) {
                    if (this.syndrome[i][j][k]) count++;
                }
            }
        }
        return count;
    }

    getErrorCount() {
        let count = 0;
        for (let dir = 0; dir < 3; dir++) {
            for (let i = 0; i < this.L; i++) {
                for (let j = 0; j < this.L; j++) {
                    for (let k = 0; k < this.L; k++) {
                        if (this.links[dir][i][j][k]) count++;
                    }
                }
            }
        }
        return count;
    }

    hasMessages() {
        for (let mi = 0; mi < 2; mi++)
            for (let mj = 0; mj < 2; mj++)
                for (let mk = 0; mk < 2; mk++)
                    for (let i = 0; i < this.L; i++)
                        for (let j = 0; j < this.L; j++)
                            for (let k = 0; k < this.L; k++)
                                if (this.memory[mi][mj][mk][i][j][k]) return true;
        return false;
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    render(ctx, canvasWidth, canvasHeight, options) {
        // 3D visualization - show a slice
        const padding = 40;
        const slice = Math.floor(this.L / 2); // Middle slice
        const cellSize = Math.min((canvasWidth - 2 * padding) / this.L,
                                 (canvasHeight - 2 * padding) / this.L);

        const offsetX = (canvasWidth - cellSize * this.L) / 2;
        const offsetY = (canvasHeight - cellSize * this.L) / 2;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Draw grid
        if (options.showGrid) {
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;

            for (let i = 0; i <= this.L; i++) {
                ctx.beginPath();
                ctx.moveTo(offsetX + i * cellSize, offsetY);
                ctx.lineTo(offsetX + i * cellSize, offsetY + this.L * cellSize);
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(offsetX, offsetY + i * cellSize);
                ctx.lineTo(offsetX + this.L * cellSize, offsetY + i * cellSize);
                ctx.stroke();
            }
        }

        // Draw z-slice
        for (let i = 0; i < this.L; i++) {
            for (let j = 0; j < this.L; j++) {
                const cx = offsetX + i * cellSize + cellSize / 2;
                const cy = offsetY + j * cellSize + cellSize / 2;

                // Draw syndrome
                if (options.showSyndrome && this.syndrome[i][j][slice]) {
                    ctx.fillStyle = '#fbbf24';
                    ctx.beginPath();
                    ctx.arc(cx, cy, cellSize * 0.25, 0, 2 * Math.PI);
                    ctx.fill();
                }

                // Draw lineons
                if (options.showMessages) {
                    if (this.ell1[i][j][slice]) {
                        ctx.strokeStyle = '#3b82f6';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(cx - cellSize * 0.3, cy);
                        ctx.lineTo(cx + cellSize * 0.3, cy);
                        ctx.stroke();
                    }
                    if (this.ell2[i][j][slice]) {
                        ctx.strokeStyle = '#ef4444';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(cx, cy - cellSize * 0.3);
                        ctx.lineTo(cx, cy + cellSize * 0.3);
                        ctx.stroke();
                    }
                    if (this.ell3[i][j][slice]) {
                        ctx.strokeStyle = '#10b981';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.arc(cx, cy, cellSize * 0.2, 0, 2 * Math.PI);
                        ctx.stroke();
                    }
                }

                // Draw errors on links
                if (options.showErrors) {
                    if (this.links[0][i][j][slice]) {
                        ctx.fillStyle = '#dc2626';
                        ctx.fillRect(cx + cellSize * 0.2, cy - 3, cellSize * 0.3, 6);
                    }
                    if (this.links[1][i][j][slice]) {
                        ctx.fillStyle = '#dc2626';
                        ctx.fillRect(cx - 3, cy + cellSize * 0.2, 6, cellSize * 0.3);
                    }
                }
            }
        }

        ctx.fillStyle = '#1e293b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.fillText(`X-Cube Lineon (z-slice ${slice}) | Clock: ${this.clock}/${this.clockPeriod - 1}`,
                    offsetX, offsetY - 10);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const padding = 40;
        const slice = Math.floor(this.L / 2);
        const cellSize = Math.min((canvasWidth - 2 * padding) / this.L,
                                 (canvasHeight - 2 * padding) / this.L);

        const offsetX = (canvasWidth - cellSize * this.L) / 2;
        const offsetY = (canvasHeight - cellSize * this.L) / 2;

        const gridX = Math.floor((x - offsetX) / cellSize);
        const gridY = Math.floor((y - offsetY) / cellSize);

        if (gridX >= 0 && gridX < this.L && gridY >= 0 && gridY < this.L) {
            // Toggle x or y link on the current slice
            const cellX = (x - offsetX) % cellSize;
            const cellY = (y - offsetY) % cellSize;

            if (Math.abs(cellX - cellSize / 2) > Math.abs(cellY - cellSize / 2)) {
                this.links[1][gridX][gridY][slice] = !this.links[1][gridX][gridY][slice];
            } else {
                this.links[0][gridX][gridY][slice] = !this.links[0][gridX][gridY][slice];
            }

            this.calculateSyndrome();
        }
    }
}