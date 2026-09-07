// A dataset is shared by decoder instances, independently of rule snapshots.
export const LOGICAL_DATA_RETRY_COUNT = 1;

export function loadLogicalData(url) {
    let settleReady, attempts = 0, pending = 0;
    const data = { cache: new Map(), status: 'loading',
        ready: new Promise(resolve => { settleReady = resolve; }), retry: request };
    // The host may spend the one retry on a stalled request after its bounded
    // verdict wait. Either request can still supply the eventual logical check.
    function request() {
        if (data.status === 'ready' || attempts > LOGICAL_DATA_RETRY_COUNT) return data.ready;
        attempts++;
        pending++;
        (async () => {
            let failure, failed = false;
            try {
                const response = await fetch(url);
                if (response.ok === false) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                const entries = Object.entries(json).map(([size, rows]) =>
                    [Number(size), rows.map(row => new Uint32Array(row))]);
                if (data.status !== 'ready') {
                    for (const [size, rows] of entries) data.cache.set(size, rows);
                    data.status = 'ready';
                    settleReady(true);
                }
            } catch (error) {
                failed = true;
                failure = error;
            } finally {
                pending--;
            }
            if (failed && data.status !== 'ready') {
                if (attempts <= LOGICAL_DATA_RETRY_COUNT) request();
                else if (pending === 0) {
                    data.status = 'unavailable';
                    console.warn(`Failed to load ${new URL(url).pathname.split('/').pop()}:`, failure);
                    settleReady(false);
                }
            }
        })();
        return data.ready;
    }
    request();
    return data;
}

// A failed request or a loaded file without this size cannot become ready by
// stepping the decoder. Report that distinction without inventing a parity.
export function missingLogicalDataResult(data) {
    return data?.status === 'loading' || !data
        ? { pending: true, hasError: false }
        : { unavailable: true, hasError: false };
}
