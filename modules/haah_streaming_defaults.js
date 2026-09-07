// Host and standalone-decoder defaults share these tuning knobs. Keeping
// them separate lets the host retain lazy rule/stage/logical-data loading.
export const HAAH_STREAMING_DEFAULT_SIZE = 20;
export const HAAH_STREAMING_MIN_SIZE = 3;
export const HAAH_STREAMING_MAX_SIZE = 20;
export const HAAH_STREAMING_DEFAULT_SLICES = 4;
export const HAAH_STREAMING_MIN_SLICES = 1;
export const HAAH_STREAMING_MAX_SLICES = 4;
export const HAAH_STREAMING_DEFAULT_P = 0.0003;
export const HAAH_STREAMING_FIXED_CLOCK_PERIOD = 8;
export const HAAH_STREAMING_DEFAULT_ERASURE_MOVES = 4;
export const HAAH_STREAMING_DEFAULT_TIMER_BASE = 2;
export const HAAH_STREAMING_DEFAULT_TIMER_GROWTH = 2;
export const HAAH_STREAMING_DEFAULT_P_MEAS = 0.0003;
