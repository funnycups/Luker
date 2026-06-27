// gcScratch — startup sweep of stale cross-mode-restore scratch dirs.
//
// The cross-mode-restore orchestrator drops per-run scratch directories
// under `<dataRoot>/_storage-migrations/_xrestore_<id>/` and cleans them
// up in its `finally` block. If the Node process is SIGKILL'd mid-run
// (oom-killer, deploy kill, host reboot) the scratch dir survives.
//
// On every server boot we sweep the migrations root: any `_xrestore_*`
// entry whose mtime is older than `maxAgeMs` is removed. The default
// (24h) is generous enough that an admin debugging an in-flight failure
// has a forensic window, while still bounding disk leakage.
//
// Mysql/pg scratch HANDLES (rows in the operator's DB) are NOT swept by
// this function — that DB is operator-owned and we have no business
// pruning their data. User docs include the manual SQL to clean orphaned
// scratch rows.

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { SCRATCH_HANDLE_PREFIX } from '../engine-backup-entries.js';

const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Sweep stale scratch dirs out of `<dataRoot>/_storage-migrations/`.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {number} [opts.maxAgeMs=24h]
 * @returns {Promise<{ scanned: number, removed: number, kept: number, errors: number }>}
 *   Counts for telemetry / logging. Never throws — best-effort sweep so a
 *   permission error on one dir doesn't block server boot.
 */
export async function gcScratch({ dataRoot, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    const counts = { scanned: 0, removed: 0, kept: 0, errors: 0 };
    if (!dataRoot) return counts;
    const root = path.join(dataRoot, '_storage-migrations');
    if (!fs.existsSync(root)) return counts;

    let entries;
    try {
        entries = await fsPromises.readdir(root);
    } catch (err) {
        counts.errors += 1;
        return counts;
    }

    const now = Date.now();
    for (const entry of entries) {
        if (!entry.startsWith(SCRATCH_HANDLE_PREFIX)) continue;
        counts.scanned += 1;
        const full = path.join(root, entry);
        let stat;
        try {
            stat = await fsPromises.stat(full);
        } catch {
            counts.errors += 1;
            continue;
        }
        const ageMs = now - stat.mtimeMs;
        if (ageMs > maxAgeMs) {
            try {
                await fsPromises.rm(full, { recursive: true, force: true });
                counts.removed += 1;
            } catch {
                counts.errors += 1;
            }
        } else {
            counts.kept += 1;
        }
    }
    return counts;
}
