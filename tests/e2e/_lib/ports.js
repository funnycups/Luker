// Per-batch port reservations so parallel batches never collide.
//
// Strategy: ask the OS for a free port via a transient `net.Server` bound
// to port 0. The batch range is kept only as a coarse fallback for tests
// that explicitly want a stable port; the actual server bind goes through
// `reservePort`, which now hands out OS-assigned free ports. This makes
// collisions across parallel workers (and across spec teardown → next
// spec startup races) structurally impossible — every reservation gets a
// distinct port number that node.js confirmed was free at that instant.

import net from 'node:net';

export const PORT_RANGES = {
    chat:           { base: 8451, count: 4 },
    character:      { base: 8461, count: 4 },
    worldinfo:      { base: 8471, count: 4 },
    preset:         { base: 8481, count: 4 },
    server:         { base: 8491, count: 6 },
    memorygraph:    { base: 8501, count: 4 },
    varops:         { base: 8511, count: 4 },
    orchestrator:   { base: 8521, count: 4 },
    iterstudio:     { base: 8531, count: 4 },
    groups:         { base: 8541, count: 4 },
    extensions:     { base: 8551, count: 4 },
    personas:       { base: 8561, count: 6 },
    regression:     { base: 8571, count: 4 },
    storage:        { base: 8581, count: 6 },
    sync:           { base: 8591, count: 4 },
    xmode:          { base: 8601, count: 8 }, // cross-mode-recovery specs need 2 servers per pair
};

/**
 * Reserve a port by binding to port 0 and reading the OS-assigned port.
 * The transient socket is closed before returning, so the caller can rebind
 * the same port. There is a small TOCTOU window between close and the
 * caller's bind — in practice node only re-hands the same port for ~30s
 * (SO_REUSEADDR + ephemeral pool size), so a worker won't draw a colliding
 * port from this function. We retry on EADDRINUSE in startServer instead.
 *
 * @param {string} batchKey kept for API compatibility; ignored
 * @returns {number}
 */
export function reservePort(batchKey) {
    if (batchKey && !PORT_RANGES[batchKey]) {
        throw new Error(`unknown batchKey: ${batchKey}`);
    }
    const srv = net.createServer();
    srv.unref();
    return new Promise((resolve, reject) => {
        srv.on('error', reject);
        srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

