// Decoder-only checkpoints. The host separately owns verdict/playback state.
// Keep rule fields explicit so a checkpoint never traverses a canvas, DOM node,
// Three.js scene, layout cache, or an event-handler closure.
const POINTER_FIELDS = [
    '_pointerMode', '_paintVertex', '_paintMoved', '_paintInitialEdge',
    '_paintVisited', '_paintValue', '_dragCell', '_dragPath',
    '_lastPaintIndex', '_dragDefectIndex', '_dragDefectPath',
];
const CAPACITY_FIELDS = ['L', 'Lx', 'Ly', 'q', 'qs', 'clockPeriod',
    'movementGated', 'growthWindow', 'clock', 'stepCount'];
const SURFACE_STREAM_FIELDS = ['L', 'Lx', 'Ly', 'q', 'growthWindow',
    'movementGated', 'erasureMoves', 'K', 't0', 'n', 'qs', 'pPhys', 'pMeas',
    '_pMeasOverridden', 'seed', 'x0', '_testPhiQueue', '_noiseEnabled',
    '_lastMeasurementHasError', 'slices', 'bx', 'by', '_prevTildeS', 't',
    'stepCount', 'lastPhi', '_lastPhi', 'lastPromotions', 'lastCondensations',
    'lastDidSplit', 'residualX', 'residualY', 'residualSyndrome', 'pending'];
const PROTOCOL_FIELDS = [...SURFACE_STREAM_FIELDS, 'protocolSchedule', 'frame',
    'committedFrame', 'frameCommitted', 'frameCommitStep', 'frameFlips', 'frameFlipMask',
    'rejected', 'rejectionStep', 'initialBx',
    'initialBy', 'initialTildeS', 'qStar', 'lastProtocolStages', 'lastAbsorptions',
    '_rejectionThisStep'];
const SURGERY_FIELDS = [...SURFACE_STREAM_FIELDS, 'sector', '_initiallyMerged',
    'surgery', '_stableSeamState', 'lastSurgeryStep', 'geometrySwitchLog',
    '_sliceGeometry', 'seamFrameCommitted', 'surgeryOutcome', 'outcomeCheck',
    'rejected', '_patchNoiseEnabled', 'seamFrame'];
const SURGERY_Z_FIELDS = [...SURGERY_FIELDS, '_rngBState', '_seamQubitsPresent',
    '_seamFrameBaseline', '_splitMeasurements', '_seamFirstRound', '_seamEverMerged'];
const SURGERY_X_FIELDS = [...SURGERY_FIELDS, 'patchL', '_seamHidden',
    '_seamPrevious', '_seamChi', '_preMergeSupport', '_seamMeasured',
    '_seamLeft', '_seamRight', '_seamChild', 'trueSurgeryOutcome',
    '_firstMergeMeasurement', '_resetFinalTimers', '_seamPresent'];
const FIELDS = {
    RepetitionCode2Decoder: [...CAPACITY_FIELDS, ...POINTER_FIELDS,
        'qubits', 'mGrid', 'clockGrid', 'syndrome', 'history', '_viewOffset'],
    RepetitionCodeOpenDecoder: [...CAPACITY_FIELDS, 'qubits', 'mGrid', 'syndrome'],
    ToricCode2Decoder: [...CAPACITY_FIELDS, ...POINTER_FIELDS,
        'qx', 'qy', 'm00', 'm01', 'm10', 'c'],
    SurfaceCode2Decoder: [...CAPACITY_FIELDS, ...POINTER_FIELDS,
        'qx', 'qy', 'm00', 'm01', 'm10'],
    RepetitionStreamingDecoder: ['L', 'clockPeriod', 'K', 't0', 'n', 'pPhys',
        '_pMeasOverridden', 'pMeas', '_noiseEnabled', '_noiseStopCutIndex',
        'manualMode', 'lastRoundWithEvents', '_visibleFutureRows', 'seed',
        'TFuture', 'erasureMoves', 'stepCount', '_bPrev', '_sTildePrev',
        '_bCurrent', '_manualInitialB', '_env', '_explicitPhi', '_explicitNoise',
        'e', 's', 'tau', 'm', 'theta', 'c', ...POINTER_FIELDS],
    SurfaceStreamingDecoder: SURFACE_STREAM_FIELDS,
    SurfaceStreaming3DDecoder: SURFACE_STREAM_FIELDS,
    SurfaceCGStreamingDecoder: SURFACE_STREAM_FIELDS,
    SurfaceCGHTreeDecoder: SURFACE_STREAM_FIELDS,
    SurfaceCGPrepDecoder: PROTOCOL_FIELDS,
    SurfaceCGInjectDecoder: PROTOCOL_FIELDS,
    SurfaceCGPrepHTreeDecoder: PROTOCOL_FIELDS,
    SurfaceCGInjectHTreeDecoder: PROTOCOL_FIELDS,
    SurfaceCGSurgeryDecoder: SURGERY_FIELDS,
    SurfaceCGSurgeryZDecoder: SURGERY_Z_FIELDS,
    SurfaceCGSurgeryXDecoder: SURGERY_X_FIELDS,
    SurfaceCGSurgeryZHTreeDecoder: SURGERY_Z_FIELDS,
    SurfaceCGSurgeryXHTreeDecoder: SURGERY_X_FIELDS,
    HaahCodeDecoder: ['L', 'clockPeriod', 'stepCount', 'clock',
        'qubitsA', 'qubitsB', 'syndrome', 'messages'],
    HaahStreamingDecoder: ['L', 'q', 'clockPeriod', 'clock', 'K', 't0', 'n',
        'pPhys', 'pMeas', 'erasureMoves', 'seed', 'finalSliceTimed', 'slices',
        'physicalA', 'physicalB', 'residualA', 'residualB', 'residualSyndrome',
        '_prevTildeS', '_noiseEnabled', '_lastMeasurementHasError', '_testPhiQueue',
        'stepCount', 't', 'lastPhi', 'lastPromotions'],
    XCubeFracton2Decoder: ['L', 'clockPeriod', 'stepCount', 'clock',
        'links', 'syndrome', 'memory'],
    XCubeLineon2Decoder: ['L', 'clockPeriod', 'stepCount', 'clock',
        'links', 'syndrome', 'ell1', 'ell2', 'ell3', 'memory'],
};

// Each row is created once and never mutated by the decoder. Copy its payload
// once, then share that private copy across checkpoints. The outer sequence is
// copied each time because the live decoder appends/truncates it. Weak caches
// release old branches once both their live rows and checkpoints are gone.
const capturedRows = new WeakMap();
const restoredRows = new WeakMap();
const PACKED_ARRAY = Symbol('packed decoder array');

function packDenseArray(value) {
    const shape = [];
    let leaf = value;
    while (Array.isArray(leaf) && leaf.length) {
        shape.push(leaf.length);
        leaf = leaf[0];
    }
    const kind = typeof leaf;
    if (kind !== 'boolean' && kind !== 'number') return null;
    const length = shape.reduce((product, size) => product * size, 1);
    let values = kind === 'boolean' ? new Uint8Array(length) : new Float64Array(length);
    let cursor = 0;
    let byteIntegers = kind === 'number';
    function copy(row, depth) {
        if (!Array.isArray(row) || row.length !== shape[depth]) return false;
        if (depth === shape.length - 1) {
            for (const item of row) {
                if (typeof item !== kind) return false;
                values[cursor++] = item;
                if (byteIntegers && (!Number.isInteger(item) || item < 0 || item > 255 || Object.is(item, -0))) {
                    byteIntegers = false;
                }
            }
        } else {
            for (const child of row) if (!copy(child, depth + 1)) return false;
        }
        return true;
    }
    if (!copy(value, 0)) return null;
    // Timers, clocks and detector-event bits usually fit in one byte. Keep
    // arbitrary numeric arrays lossless by retaining Float64 when they do not.
    if (byteIntegers) values = new Uint8Array(values);
    return { [PACKED_ARRAY]: true, shape, kind, values };
}

function captureValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return value.slice();
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (Array.isArray(value)) return packDenseArray(value) || value.map(captureValue);
    if (value instanceof Map) return new Map([...value].map(([key, item]) =>
        [captureValue(key), captureValue(item)]));
    if (value instanceof Set) return new Set([...value].map(captureValue));
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'function') result[key] = captureValue(item);
    }
    return result;
}

function restoreValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (value[PACKED_ARRAY]) {
        let cursor = 0;
        function unpack(depth) {
            const result = new Array(value.shape[depth]);
            for (let i = 0; i < result.length; i++) {
                result[i] = depth < value.shape.length - 1 ? unpack(depth + 1)
                    : value.kind === 'boolean' ? !!value.values[cursor++] : value.values[cursor++];
            }
            return result;
        }
        return unpack(0);
    }
    if (ArrayBuffer.isView(value)) return value.slice();
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (Array.isArray(value)) return value.map(restoreValue);
    if (value instanceof Map) return new Map([...value].map(([key, item]) =>
        [restoreValue(key), restoreValue(item)]));
    if (value instanceof Set) return new Set([...value].map(restoreValue));
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = restoreValue(item);
    return result;
}

function captureRows(rows) {
    return rows.map(row => {
        let saved = capturedRows.get(row);
        if (!saved) {
            saved = captureValue(row);
            capturedRows.set(row, saved);
        }
        return saved;
    });
}

function restoreRows(rows) {
    return rows.map(row => {
        let restored = restoredRows.get(row);
        if (!restored) {
            restored = restoreValue(row);
            restoredRows.set(row, restored);
            capturedRows.set(restored, row);
        }
        return restored;
    });
}

export function captureDecoderState(decoder) {
    const fields = {};
    const keys = FIELDS[decoder.constructor?.name] || Object.keys(decoder);
    for (const key of keys) {
        if (!Object.hasOwn(decoder, key) || typeof decoder[key] === 'function') continue;
        fields[key] = key === 'history' || key === '_env'
            ? captureRows(decoder[key]) : captureValue(decoder[key]);
    }
    const snapshot = { fields };
    if (typeof decoder._rng?.getState === 'function') {
        snapshot.rng = { source: decoder._rng, state: captureValue(decoder._rng.getState()) };
    }
    // The independent second patch must replay its own noise stream too.
    if (typeof decoder._rngB?.getState === 'function') {
        snapshot.rngB = { source: decoder._rngB, state: captureValue(decoder._rngB.getState()) };
    }
    if (typeof decoder.captureStepPresentation === 'function') {
        snapshot.presentation = captureValue(decoder.captureStepPresentation());
    }
    return snapshot;
}

// Forward replay opts into a fresh presentation clock; ordinary restoration
// remains a settled back-step. Decoders without presentation hooks ignore it.
export function restoreDecoderState(decoder, snapshot, presentationOptions) {
    const keys = FIELDS[decoder.constructor?.name] || Object.keys(decoder);
    for (const key of keys) {
        if (Object.hasOwn(decoder, key) && !Object.hasOwn(snapshot.fields, key)
            && typeof decoder[key] !== 'function') delete decoder[key];
    }
    for (const [key, value] of Object.entries(snapshot.fields)) {
        decoder[key] = key === 'history' || key === '_env'
            ? restoreRows(value) : restoreValue(value);
    }
    if (snapshot.rng) {
        decoder._rng = snapshot.rng.source;
        decoder._rng.setState(restoreValue(snapshot.rng.state));
    }
    if (snapshot.rngB) {
        decoder._rngB = snapshot.rngB.source;
        decoder._rngB.setState(restoreValue(snapshot.rngB.state));
    }
    decoder.restoreStepPresentation?.(restoreValue(snapshot.presentation), presentationOptions);
    if (decoder.is3DMode && typeof decoder._update3D === 'function') decoder._update3D();
}

// Count stored scalar/typed-array payload, excluding engine-dependent object
// headers, references and interned property names. Shared rows count once per
// measurement. Pass an array of snapshots to account for sharing across a stack.
export function decoderSnapshotBytes(snapshot) {
    const seen = new Set();
    function bytes(value) {
        if (typeof value === 'number') return Float64Array.BYTES_PER_ELEMENT;
        if (typeof value === 'boolean') return Uint8Array.BYTES_PER_ELEMENT;
        if (typeof value === 'string') return value.length * Uint16Array.BYTES_PER_ELEMENT;
        if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
        seen.add(value);
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
        if (value instanceof Map) return [...value].reduce((sum, [key, item]) => sum + bytes(key) + bytes(item), 0);
        if (value instanceof Set) return [...value].reduce((sum, item) => sum + bytes(item), 0);
        return Object.values(value).reduce((sum, item) => sum + bytes(item), 0);
    }
    return bytes(snapshot);
}
