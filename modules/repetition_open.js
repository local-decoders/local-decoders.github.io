// Repetition Code with Open Boundary Conditions Decoder Module
export class RepetitionCodeOpenDecoder {
    constructor(L) {
        this.L = L;
        this.stepCount = 0;
        this.clock = 0;

        this.qubits = new Array(L).fill(false);
        this.mGrid = new Array(L).fill(false);
        this.syndrome = new Array(L).fill(false);
    }

    initializeRandomErrors(p, rng = Math.random) {
        for (let i = 0; i < this.L; i++) {
            this.qubits[i] = rng() < p;
        }
        this.calculateSyndrome();
    }

    calculateSyndrome() {
        // Open boundary conditions - no syndrome at boundaries
        this.syndrome[0] = false;
        for (let i = 1; i < this.L; i++) {
            this.syndrome[i] = this.qubits[i - 1] ^ this.qubits[i];
        }
    }

    step() {
        this.calculateSyndrome();
        const nextM = new Array(this.L).fill(false);

        for (let i = 0; i < this.L; i++) {
            if (this.syndrome[i]) {
                nextM[i] = true;
                if (i > 0 && this.mGrid[i - 1]) {
                    this.qubits[i - 1] = !this.qubits[i - 1];
                }
            } else {
                // Propagation with boundary awareness
                if (i > 1 && i < this.L - 1) {
                    const mLeft1 = this.mGrid[i - 1];
                    const mLeft2 = this.mGrid[i - 2];
                    const sLeft1 = this.syndrome[i - 1];
                    const sRight1 = i < this.L - 1 ? this.syndrome[i + 1] : false;

                    nextM[i] = (mLeft1 && mLeft2) ||
                              (sLeft1 && (mLeft1 || this.mGrid[i])) ||
                              (this.mGrid[i] && sRight1);
                }
            }
        }

        this.mGrid = nextM;
        this.stepCount++;
    }

    stepUncoord() {
        this.calculateSyndrome();
        const i = Math.floor(Math.random() * this.L);
        const nextM = [...this.mGrid];
        if (this.syndrome[i]) {
            nextM[i] = true;
            if (i > 0 && this.mGrid[i - 1]) this.qubits[i - 1] ^= true;
        } else if (i > 1 && i < this.L - 1) {
            const mLeft1 = this.mGrid[i - 1];
            const mLeft2 = this.mGrid[i - 2];
            const sLeft1 = this.syndrome[i - 1];
            const sRight1 = this.syndrome[i + 1];
            nextM[i] = (mLeft1 && mLeft2) || (sLeft1 && (mLeft1 || this.mGrid[i]))
                || (this.mGrid[i] && sRight1);
        }
        this.mGrid = nextM;
        this.stepCount++;
    }

    getSyndromeCount() {
        return this.syndrome.filter(s => s).length;
    }

    getErrorCount() {
        return this.qubits.filter(q => q).length;
    }

    hasMessages() {
        return this.mGrid.some(m => m);
    }

    isQuiescent() {
        return this.getSyndromeCount() === 0 && !this.hasMessages();
    }

    render(ctx, canvasWidth, canvasHeight, options) {
        const padding = 40;
        const cellWidth = Math.min((canvasWidth - 2 * padding) / this.L, 60);
        const totalWidth = cellWidth * this.L;
        const offsetX = (canvasWidth - totalWidth) / 2;
        const offsetY = canvasHeight / 2;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Draw chain with open boundaries
        if (options.showGrid) {
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY);
            ctx.lineTo(offsetX + totalWidth, offsetY);
            ctx.stroke();

            // Draw boundary indicators
            ctx.strokeStyle = '#a78bfa';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(offsetX - 10, offsetY - 10);
            ctx.lineTo(offsetX - 10, offsetY + 10);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(offsetX + totalWidth + 10, offsetY - 10);
            ctx.lineTo(offsetX + totalWidth + 10, offsetY + 10);
            ctx.stroke();
        }

        // Draw vertices and errors
        for (let i = 0; i < this.L; i++) {
            const x = offsetX + i * cellWidth + cellWidth / 2;

            ctx.fillStyle = options.showSyndrome && this.syndrome[i] ? '#fbbf24' : '#e2e8f0';
            ctx.beginPath();
            ctx.arc(x, offsetY, 8, 0, 2 * Math.PI);
            ctx.fill();
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1;
            ctx.stroke();

            if (options.showErrors && this.qubits[i]) {
                ctx.strokeStyle = '#f87171';
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(x + 8, offsetY);
                ctx.lineTo(x + cellWidth - 8, offsetY);
                ctx.stroke();
            }

            if (options.showMessages && this.mGrid[i]) {
                ctx.fillStyle = '#818cf8';
                ctx.fillRect(x - 4, offsetY - 20, 8, 12);
            }
        }

        // Draw title at the top (consistent format)
        const syndromeCount = this.getSyndromeCount();
        ctx.fillStyle = '#64748b';
        ctx.font = '13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const titleText = `T=${this.stepCount} | Defects: ${syndromeCount}`;
        ctx.fillText(titleText, canvasWidth / 2, offsetY - 40);

        // Add small note about open boundaries
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillText('(Open Boundaries)', canvasWidth / 2, offsetY - 25);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const padding = 40;
        const cellWidth = Math.min((canvasWidth - 2 * padding) / this.L, 60);
        const totalWidth = cellWidth * this.L;
        const offsetX = (canvasWidth - totalWidth) / 2;
        const offsetY = canvasHeight / 2;

        if (Math.abs(y - offsetY) < 30) {
            const index = Math.floor((x - offsetX) / cellWidth);
            if (index >= 0 && index < this.L) {
                this.qubits[index] = !this.qubits[index];
                this.calculateSyndrome();
            }
        }
    }
}
