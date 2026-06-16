// Per-batch port reservations so parallel batches never collide.
//
// Each batch gets a base port and may use base..base+9 for worker
// spread (playwright workers within one batch share a server, but if a
// spec needs a second instance — e.g. multi-user — it can take base+1).
//
// Default Luker dev server is 8000. Skills-UI / iter-studio legacy
// suites in tests/frontend + tests/skills-ui/playwright also target 8000
// via PLAYWRIGHT_BASE_URL or default. The expanded e2e suite starts at
// 8451 to leave a wide gap.

export const PORT_RANGES = {
    chat:           { base: 8451, count: 4 },  // Batch 1
    character:      { base: 8461, count: 4 },  // Batch 2
    worldinfo:      { base: 8471, count: 4 },  // Batch 3
    preset:         { base: 8481, count: 4 },  // Batch 4
    server:         { base: 8491, count: 6 },  // Batch 5 (multi-user needs 2+)
    memorygraph:    { base: 8501, count: 4 },  // Batch 6
    varops:         { base: 8511, count: 4 },  // Batch 7
    orchestrator:   { base: 8521, count: 4 },  // Batch 8
    iterstudio:     { base: 8531, count: 4 },  // Batch 9
    groups:         { base: 8541, count: 4 },  // Batch 10
    extensions:     { base: 8551, count: 4 },  // Batch 11
    personas:       { base: 8561, count: 6 },  // Batch 12 (multi-user)
    regression:     { base: 8571, count: 4 },  // Batch 13
    storage:        { base: 8581, count: 6 },  // Batch 14 (migration round-trips need 2+)
};

let nextOffsetByBatch = new Map();

// Seed the per-worker offset from playwright's TEST_WORKER_INDEX so two
// parallel workers don't both reserve port `base+0` and crash on bind.
// Each worker's first reservation lands on `base + (TEST_WORKER_INDEX % count)`,
// which spreads the workers across the reserved slice. Workers that need a
// second instance within one spec just bump from there.
const WORKER_SEED = (() => {
    const raw = Number(process.env.TEST_WORKER_INDEX);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
})();

/**
 * Reserve a port from the batch's range. Round-robins within the batch's
 * reserved slice so a worker that needs a second server can grab base+1.
 *
 * @param {string} batchKey one of the keys in PORT_RANGES
 * @returns {number}
 */
export function reservePort(batchKey) {
    const range = PORT_RANGES[batchKey];
    if (!range) throw new Error(`unknown batchKey: ${batchKey}`);
    if (!nextOffsetByBatch.has(batchKey)) {
        // First call from this worker — start at the worker-seeded slot.
        nextOffsetByBatch.set(batchKey, WORKER_SEED);
    }
    const used = nextOffsetByBatch.get(batchKey);
    const port = range.base + (used % range.count);
    nextOffsetByBatch.set(batchKey, used + 1);
    return port;
}
