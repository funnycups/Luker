// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Cross-process migration lock.
//
// Two entry points (admin route + CLI) can target the same dataRoot at the
// same time. Without a shared lock they'd race on the source→dest copy and
// the engine swap; the result would be at best a duplicate-write storm and
// at worst silent data loss when one process swaps config.yaml out from
// under the other.
//
// We use a single fs lockfile at `<dataRoot>/_migration.lock` rather than a
// per-engine row because sqlite has no `_storage_meta` table and fs has no
// DB at all — the lock must live somewhere visible to all four engines
// before any of them are even constructed.
//
// Acquisition is atomic: `fs.openSync(path, 'wx')` either creates the file
// or throws EEXIST in one syscall, so two concurrent acquirers can't both
// claim a fresh lock. The "lock already exists but is expired/corrupt"
// recovery path falls back to a non-atomic overwrite — that's fine because
// by definition the prior holder is either dead (TTL elapsed) or never wrote
// a valid file (corrupt). Same-holder re-acquire (heartbeat) is also an
// overwrite, which is safe by construction since we're racing with ourselves.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const LOCK_FILENAME = '_migration.lock';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Build a holder identifier suitable for `acquireMigrationLock`. The id
 * encodes host + pid so a cross-host lock collision points at the right
 * machine, plus a random nonce so two concurrent acquires from the same
 * process (e.g. an admin route fired twice in flight) don't collide.
 */
export function makeHolderId() {
    return `${os.hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

function buildLockPayload(holderId, ttlMs, now) {
    return {
        holderId,
        host: os.hostname(),
        pid: process.pid,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
    };
}

function writeLockFileAtomic(lockPath, payload) {
    // 'wx' = create + exclusive: throws EEXIST if the file already exists.
    // This is the only syscall that gives us true single-winner semantics
    // across processes on the same host (POSIX guarantees + Node's docs).
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(payload, null, 2));
    } finally {
        fs.closeSync(fd);
    }
}

function writeLockFileOverwrite(lockPath, payload) {
    // Used for two recovery paths only: (1) prior holder's TTL expired or
    // file was corrupt, (2) same holder is refreshing TTL (heartbeat). Both
    // are by-construction safe to overwrite; the atomic 'wx' path is reserved
    // for the fresh-acquire case where another process might be racing us.
    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * Acquire a cross-process migration lock by writing a JSON
 * lockfile at `<dataRoot>/_migration.lock`. Refuses if a valid (non-expired)
 * lock from a different holder exists. Auto-evicts expired locks and corrupt
 * lockfiles (recovery from a crashed prior holder).
 *
 * @param {object} opts
 * @param {string} opts.dataRoot — base data directory (server bootstrap or CLI `bootstrap()`).
 * @param {string} opts.holderId — id produced by `makeHolderId()`.
 * @param {number} [opts.ttlMs=60_000] — milliseconds until lock auto-expires.
 * @returns {Promise<{holderId: string, expiresAt: Date}>}
 * @throws Error if another (live) holder is currently migrating.
 */
export async function acquireMigrationLock({ dataRoot, holderId, ttlMs = DEFAULT_TTL_MS }) {
    if (!dataRoot) throw new Error('acquireMigrationLock: dataRoot required');
    if (!holderId) throw new Error('acquireMigrationLock: holderId required');
    const lockPath = path.join(dataRoot, LOCK_FILENAME);
    const now = Date.now();
    const payload = buildLockPayload(holderId, ttlMs, now);

    // Fast path: nothing there, atomic create wins.
    try {
        writeLockFileAtomic(lockPath, payload);
        return { holderId, expiresAt: new Date(payload.expiresAt) };
    } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
    }

    // Slow path: a file is already there. Inspect it and decide whether
    // we're allowed to overwrite (same-holder refresh / expired / corrupt)
    // or must refuse (different holder, still live).
    let existing = null;
    try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        // Corrupt or unreadable lockfile — fall through to overwrite. This
        // is the same recovery class as TTL expiry: by definition no valid
        // holder is here.
    }

    if (existing && typeof existing === 'object') {
        const existingExpiresAt = new Date(existing.expiresAt).getTime();
        const sameHolder = existing.holderId === holderId;
        const stillLive = Number.isFinite(existingExpiresAt) && existingExpiresAt > now;
        if (!sameHolder && stillLive) {
            throw new Error(
                `acquireMigrationLock: another holder is migrating: ${existing.holderId}`
                + ` (expires ${existing.expiresAt})`,
            );
        }
        // Else: same holder (heartbeat refresh) OR expired (evict) — both
        // safe to overwrite.
    }

    writeLockFileOverwrite(lockPath, payload);
    return { holderId, expiresAt: new Date(payload.expiresAt) };
}

/**
 * Release the lock IFF currently held by us. No-op if the
 * file is missing, corrupt, or held by a different holder. Callers wire
 * this into `finally` so a thrown migration error never leaks the lock.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} opts.holderId
 */
export async function releaseMigrationLock({ dataRoot, holderId }) {
    if (!dataRoot) return;
    const lockPath = path.join(dataRoot, LOCK_FILENAME);
    if (!fs.existsSync(lockPath)) return;
    let existing = null;
    try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        // Corrupt file — leave it alone. Not ours to clean up, and the
        // next acquirer will recover it via the corrupt-evict path.
        return;
    }
    if (existing?.holderId === holderId) {
        try {
            fs.rmSync(lockPath, { force: true });
        } catch {
            // Best-effort cleanup; failure here is not a migration error.
        }
    }
}

/**
 * Heartbeat-driven TTL refresh: arm a background timer that
 * re-acquires the lock with the same holderId on a fixed interval. Same-holder
 * re-acquire is treated as a TTL refresh by `acquireMigrationLock` (see the
 * `sameHolder` branch), so each tick simply pushes `expiresAt` forward.
 *
 * Heartbeat failures are intentionally swallowed (logged, not thrown). The
 * migration body is the authority on lock loss — if a competitor evicts us
 * between ticks, the next acquire here will reject, but throwing from a
 * background timer would surface as an `unhandledRejection` and tear down
 * the process mid-migration, which is worse than letting the migration
 * keep running and hit its own failure at the next per-user step.
 *
 * Callers MUST invoke `stopHeartbeat` on every exit path (`finally`) to
 * clear the interval — an orphaned heartbeat would keep writing to a
 * released lock and prevent the process from exiting cleanly.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} opts.holderId — the same id passed to `acquireMigrationLock`.
 * @param {number} [opts.intervalMs=20_000] — heartbeat period; must be < ttlMs.
 * @param {number} [opts.ttlMs=60_000] — TTL written on each refresh.
 * @returns {ReturnType<typeof setInterval>} handle to pass to `stopHeartbeat`.
 */
export function startHeartbeat({
    dataRoot,
    holderId,
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    ttlMs = DEFAULT_TTL_MS,
}) {
    if (!dataRoot) throw new Error('startHeartbeat: dataRoot required');
    if (!holderId) throw new Error('startHeartbeat: holderId required');
    // Guard against the documented misconfiguration: if the heartbeat ticks
    // slower than (or equal to) the TTL, every refresh acquire would land
    // AFTER the previous expiresAt — meaning a competitor could legally
    // evict us in between, defeating the heartbeat's purpose. Caught at
    // arm time so the misconfiguration surfaces in tests / dev runs rather
    // than as a mysterious "lock stolen" failure mid-migration.
    if (intervalMs >= ttlMs) {
        throw new Error('startHeartbeat: intervalMs must be < ttlMs');
    }
    return setInterval(async () => {
        try {
            await acquireMigrationLock({ dataRoot, holderId, ttlMs });
        } catch (err) {
            // Don't rethrow — see function docblock. A warn is enough so an
            // operator chasing a stuck migration can see the lock-refresh
            // failure pattern (typically disk-full or a competitor steal).
            console.warn(`migration lock heartbeat failed: ${err?.message || String(err)}`);
        }
    }, intervalMs);
}

/**
 * Clear a heartbeat timer started by `startHeartbeat`. Safe to call with
 * `null`/`undefined` so a `finally` block can unconditionally tear down
 * without first checking whether `startHeartbeat` ran (e.g. an early throw
 * between acquire and start).
 *
 * @param {ReturnType<typeof setInterval>|null|undefined} handle
 */
export function stopHeartbeat(handle) {
    if (handle) clearInterval(handle);
}
