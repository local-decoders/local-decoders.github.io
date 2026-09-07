// Repetition Code Decoder Module
export class RepetitionCodeDecoder {
    constructor(L) {
        this.L = L;
        this.stepCount = 0;
        this.clock = 0; // For compatibility

        // Initialize qubits and messages
        this.qubits = new Array(L).fill(false);
        this.mGrid = new Array(L).fill(false);
        this.syndrome = new Array(L).fill(false);
    }

    initializeRandomErrors(p) {
        for (let i = 0; i < this.L; i++) {
            this.qubits[i] = Math.random() < p;
        }
        this.calculateSyndrome();
    }

    calculateSyndrome() {
        for (let i = 0; i < this.L; i++) {
            // s[i] = qubits[i-1] XOR qubits[i] (periodic boundaries)
            const leftQ = this.qubits[(i - 1 + this.L) % this.L];
            this.syndrome[i] = leftQ ^ this.qubits[i];
        }
    }

    step() {
        this.calculateSyndrome();

        const nextM = new Array(this.L).fill(false);

        for (let i = 0; i < this.L; i++) {
            if (this.syndrome[i]) {
                // Rule 1: If syndrome present, set message
                nextM[i] = true;

                // Perform correction if message from left
                const mLeft = this.mGrid[(i - 1 + this.L) % this.L];
                if (mLeft) {
                    // Flip qubit to the left
                    this.qubits[(i - 1 + this.L) % this.L] = !this.qubits[(i - 1 + this.L) % this.L];
                }
            } else {
                // Rule 2: Propagation logic when no syndrome
                const mLeft1 = this.mGrid[(i - 1 + this.L) % this.L];
                const mLeft2 = this.mGrid[(i - 2 + this.L) % this.L];
                const sLeft1 = this.syndrome[(i - 1 + this.L) % this.L];
                const sLeft2 = this.syndrome[(i - 2 + this.L) % this.L];
                const sRight1 = this.syndrome[(i + 1) % this.L];

                // Propagation terms
                const term1 = mLeft1 && mLeft2;
                const term2 = sLeft1 && (mLeft1 || this.mGrid[i]);
                const term3 = sLeft2 && (mLeft1 && this.mGrid[i]);
                const term4 = this.mGrid[i] && sRight1;

                nextM[i] = term1 || term2 || term3 || term4;
            }
        }

        this.mGrid = nextM;
        this.stepCount++;
        this.calculateSyndrome();
    }

    stepUncoord() {
        this.calculateSyndrome();
        const i = Math.floor(Math.random() * this.L);
        const nextM = [...this.mGrid];
        if (this.syndrome[i]) {
            nextM[i] = true;
            const mLeft = this.mGrid[(i - 1 + this.L) % this.L];
            if (mLeft) this.qubits[(i - 1 + this.L) % this.L] ^= true;
        } else {
            const mLeft1 = this.mGrid[(i - 1 + this.L) % this.L];
            const mLeft2 = this.mGrid[(i - 2 + this.L) % this.L];
            const sLeft1 = this.syndrome[(i - 1 + this.L) % this.L];
            const sLeft2 = this.syndrome[(i - 2 + this.L) % this.L];
            const sRight1 = this.syndrome[(i + 1) % this.L];
            nextM[i] = (mLeft1 && mLeft2) || (sLeft1 && (mLeft1 || this.mGrid[i]))
                || (sLeft2 && (mLeft1 && this.mGrid[i])) || (this.mGrid[i] && sRight1);
        }
        this.mGrid = nextM;
        this.stepCount++;
        this.calculateSyndrome();
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

    checkLogicalError() {
        // For repetition code with periodic boundaries,
        // logical error is detected by checking the first qubit
        // (errors come in pairs, so if q[0] == 1, there's a logical error)
        const hasLogicalError = this.qubits[0];

        return {
            hasError: hasLogicalError,
            vertical: false,
            horizontal: hasLogicalError  // 1D code, so we call it "horizontal"
        };
    }

    render(ctx, canvasWidth, canvasHeight, options) {
        const padding = 80;
        const availableWidth = canvasWidth - 2 * padding;

        // Calculate cell dimensions (matching Python's aspect ratio)
        const cellWidth = Math.min(availableWidth / this.L, 60);
        const cellHeight = Math.min(cellWidth, 60); // Square cells

        const totalWidth = cellWidth * this.L;
        const offsetX = (canvasWidth - totalWidth) / 2;
        const offsetY = canvasHeight / 2 - cellHeight / 2;

        // Colors matching Python code
        const colorMessage = '#acccea';
        const colorError = '#f87171';
        const colorDefect = '#000000';

        // Clear canvas
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        // Draw grid background and cells
        if (options.showGrid) {
            ctx.strokeStyle = 'gray';
            ctx.lineWidth = 1.0;
            ctx.globalAlpha = 0.5;

            // Draw vertical grid lines
            for (let i = 0; i <= this.L; i++) {
                const x = offsetX + i * cellWidth;
                ctx.beginPath();
                ctx.moveTo(x, offsetY);
                ctx.lineTo(x, offsetY + cellHeight);
                ctx.stroke();
            }

            // Draw horizontal grid lines
            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY);
            ctx.lineTo(offsetX + totalWidth, offsetY);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(offsetX, offsetY + cellHeight);
            ctx.lineTo(offsetX + totalWidth, offsetY + cellHeight);
            ctx.stroke();

            ctx.globalAlpha = 1.0;
        }

        // Draw message backgrounds (green rectangles)
        // Draw them slightly inset so grid lines remain visible
        if (options.showMessages) {
            const inset = 1; // Pixels to inset from grid lines
            for (let i = 0; i < this.L; i++) {
                if (this.mGrid[i]) {
                    ctx.fillStyle = colorMessage;
                    ctx.fillRect(
                        offsetX + i * cellWidth + inset,
                        offsetY + inset,
                        cellWidth - inset,
                        cellHeight - 2 * inset
                    );
                }
            }
        }

        // Draw qubit errors (vertical red lines between cells)
        if (options.showErrors) {
            for (let i = 0; i < this.L; i++) {
                if (this.qubits[i]) {
                    const x = offsetX + (i + 1) * cellWidth; // Right edge of cell i
                    ctx.strokeStyle = colorError;
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.moveTo(x, offsetY);
                    ctx.lineTo(x, offsetY + cellHeight);
                    ctx.stroke();
                }
            }
        }

        // Draw syndromes as black circles (on top of everything)
        if (options.showSyndrome) {
            for (let i = 0; i < this.L; i++) {
                if (this.syndrome[i]) {
                    const x = offsetX + i * cellWidth + cellWidth / 2;
                    const y = offsetY + cellHeight / 2;
                    const radius = Math.min(cellWidth * 0.15, cellHeight * 0.15);

                    ctx.fillStyle = colorDefect;
                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, 2 * Math.PI);
                    ctx.fill();
                }
            }
        }

        // Check for logical errors
        const syndromeCount = this.getSyndromeCount();
        const logicalError = this.checkLogicalError();

        // Draw title text at the top
        ctx.fillStyle = '#64748b';
        ctx.font = '500 13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const titleText = `T=${this.stepCount} | Defects: ${syndromeCount}`;
        ctx.fillText(titleText, canvasWidth / 2, offsetY - 20);

        // Draw logical error or success message when simulation is complete
        if (syndromeCount === 0 && !this.mGrid.some(m => m)) {
            const statusText = logicalError.hasError ? '[FAIL]' : '[SUCCESS]';
            ctx.font = '13px JetBrains Mono, monospace';
            ctx.fillStyle = logicalError.hasError ? '#f87171' : '#34d399';
            ctx.fillText(statusText, canvasWidth / 2 + 100, offsetY - 20);
        }

        // Draw legend at the bottom (matching Python code)
        const legendY = offsetY + cellHeight + 50;
        const legendSpacing = 180;
        const legendSpacingDefect = 100;
        const legendStartX = canvasWidth / 2 - legendSpacing / 1.5 - legendSpacingDefect / 2;

        ctx.font = '500 12px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#374151';

        // Defect legend (circle)
        ctx.fillStyle = colorDefect;
        ctx.beginPath();
        ctx.arc(legendStartX, legendY, 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#374151';
        ctx.fillText('Defect', legendStartX + 15, legendY + 4);

        // Message legend (green rectangle)
        const msgX = legendStartX + legendSpacingDefect;
        ctx.fillStyle = colorMessage;
        ctx.fillRect(msgX - 8, legendY - 8, 16, 16);
        ctx.fillStyle = '#374151';
        ctx.fillText('Move-Left Message', msgX + 15, legendY + 4);

        // Error legend (red line)
        const errX = legendStartX + legendSpacingDefect + legendSpacing;
        ctx.strokeStyle = colorError;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(errX - 10, legendY);
        ctx.lineTo(errX + 10, legendY);
        ctx.stroke();
        ctx.fillStyle = '#374151';
        ctx.fillText('Error (Qubit)', errX + 15, legendY + 4);
    }

    toggleErrorAtPosition(x, y, canvasWidth, canvasHeight) {
        const padding = 40;
        const availableWidth = canvasWidth - 2 * padding;
        const cellWidth = Math.min(availableWidth / this.L, 60);

        const totalWidth = cellWidth * this.L;
        const offsetX = (canvasWidth - totalWidth) / 2;
        const offsetY = canvasHeight / 2;

        // Check if click is near the chain
        if (Math.abs(y - offsetY) < 30) {
            const index = Math.floor((x - offsetX) / cellWidth);
            if (index >= 0 && index < this.L) {
                this.qubits[index] = !this.qubits[index];
                this.calculateSyndrome();
            }
        }
    }
}