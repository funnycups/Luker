// Startup fail-fast probe for the storage layer.
//
// When the operator opts in via `storage.failFast: true` in config.yaml, the
// boot chain awaits a single engine.ping() before request routing is enabled.
// If the engine is unreachable (DB down, credentials wrong, schema migration
// rejected) the server exits with code 1 instead of swallowing the error and
// limping along until the first user request hits a broken route.
//
// Default is false: the engine connects lazily on first request, matching the
// pre-Stage-0 behavior. Operators who want crash-on-boot semantics flip the
// flag explicitly.

import { logEngineError } from './engine-logger.js';

/**
 * Probe the engine at boot time and exit on failure when failFast=true.
 *
 * @param {{ kind: string, ping: (handle?: string) => Promise<void> }} engine
 *        A storage engine instance with a transport-level ping. Called with no
 *        handle — engines that need a handle for per-tenant DBs (sqlite)
 *        should treat the no-handle case as a transport-only check.
 * @param {boolean} failFast When false, this is a no-op.
 * @returns {Promise<void>}
 */
export async function maybeFailFast(engine, failFast) {
    if (!failFast) return;
    try {
        await engine.ping();
    } catch (err) {
        logEngineError(engine.kind, 'startup-ping', null, err);
        process.exit(1);
    }
}
