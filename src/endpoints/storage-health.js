// Public storage health endpoint.
//
// Mounted at GET /api/storage/health BEFORE the auth middleware so external
// monitors (k8s liveness/readiness, uptime probes, load balancers) can poll
// without credentials.
//
// 200 { ok: true, kind, schemaVersion, latencyMs } when engine.ping() resolves.
// 503 { ok: false, kind, error } when it throws.
//
// The error string is intentionally compact (code/name + message). We do NOT
// surface stack traces over the wire — a public probe should be diagnostic
// enough for operators without leaking call-site detail to drive-by clients.
// The full error (with stack) goes through logEngineError to the server log.

import express from 'express';

import { getStorageEngine } from '../storage/index.js';
import { logEngineError } from '../storage/engine-logger.js';

export const router = express.Router();

router.get('/health', async (_req, res) => {
    const engine = getStorageEngine();
    const kind = engine.kind;
    const start = Date.now();
    try {
        await engine.ping();
        const latencyMs = Date.now() - start;
        let schemaVersion = 0;
        if (typeof engine.getSchemaVersion === 'function') {
            // Best-effort: a failure here doesn't change the headline answer
            // (engine reachable = healthy). Log nothing — the ping already
            // confirmed the transport is up.
            try { schemaVersion = await engine.getSchemaVersion(); } catch { /* tolerate */ }
        }
        res.status(200).json({ ok: true, kind, schemaVersion, latencyMs });
    } catch (err) {
        logEngineError(kind, 'health-ping', null, err);
        const tag = err?.code ?? err?.name ?? 'Error';
        const message = typeof err?.message === 'string' ? err.message : String(err);
        res.status(503).json({ ok: false, kind, error: `${tag}: ${message}` });
    }
});
