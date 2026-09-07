// The Haah decoder's existing bit ordering and parity convention, shared by
// the streaming decoder without importing or changing the capacity decoder.
import { loadLogicalData, missingLogicalDataResult } from './logical_data.js';

export function loadHaahLogicals(url = new URL('../data/haah_logicals.json', import.meta.url)) {
    return loadLogicalData(url);
}

export const haahLogicalData = loadHaahLogicals();

// Qubit bits are A[0..L^3), then B[0..L^3), with z varying fastest.
export function checkHaahLogicalParity(L, qubitsA, qubitsB, cache = haahLogicalData.cache, data = haahLogicalData) {
    const logicals = cache.get(L);
    if (!logicals) return missingLogicalDataResult(data);
    const volume = L ** 3;
    const words = Math.ceil(2 * volume / 32);
    const error = new Uint32Array(words);
    for (let site = 0; site < volume; site++) {
        if (qubitsA[site]) error[site >> 5] ^= 1 << (site & 31);
        if (qubitsB[site]) {
            const bit = volume + site;
            error[bit >> 5] ^= 1 << (bit & 31);
        }
    }
    for (const row of logicals) {
        let parity = 0;
        for (let word = 0; word < words; word++) {
            let value = row[word] & error[word];
            value ^= value >> 16; value ^= value >> 8; value ^= value >> 4;
            value ^= value >> 2; value ^= value >> 1;
            parity ^= value & 1;
        }
        if (parity) return { hasError: true, description: 'logical error' };
    }
    return { hasError: false };
}
