// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Migration lock heartbeat — spec §4.5 "调用方持续 heartbeat 续期".
//
// The default lock TTL is 60s but real migrations can take much longer
// (multi-user dataRoots, large worldbooks). Without a refresh loop the
// lock would expire mid-migration and a competing acquirer could evict
// us. `startHeartbeat` arms a setInterval that re-runs `acquireMigrationLock`
// against the same holderId — the lock module already treats same-holder
// re-acquire as a TTL refresh (see lock.js writeLockFileOverwrite comments).
//
// These tests pin the documented contract: a running heartbeat keeps the
// lock past its initial TTL, and `stopHeartbeat` is null-safe so callers
// can put it in a `finally` without first checking whether `startHeartbeat`
// even ran.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    acquireMigrationLock,
    releaseMigrationLock,
    startHeartbeat,
    stopHeartbeat,
    makeHolderId,
} from '../../../src/storage/migration/lock.js';

describe('migration lock heartbeat', () => {
    let dataRoot;

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-lock-heartbeat-'));
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('heartbeat refreshes TTL while running', async () => {
        const holderId = makeHolderId();
        // Short TTL (500ms) + frequent heartbeat (100ms) so the test fits in
        // ~1.5s. We then wait > TTL to prove the heartbeat actually fired and
        // pushed `expiresAt` forward — without it the lockfile would either be
        // gone or carry the original (now-past) expiresAt.
        await acquireMigrationLock({ dataRoot, holderId, ttlMs: 500 });
        const hb = startHeartbeat({ dataRoot, holderId, intervalMs: 100, ttlMs: 500 });
        try {
            await new Promise(r => setTimeout(r, 1100));
            const lockPath = path.join(dataRoot, '_migration.lock');
            const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            expect(data.holderId).toBe(holderId);
            expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
        } finally {
            stopHeartbeat(hb);
            await releaseMigrationLock({ dataRoot, holderId });
        }
    });

    test('stopHeartbeat is safe with null/undefined', () => {
        // Callers wire this into `finally` and may reach it before
        // `startHeartbeat` was ever called (e.g. early failure between
        // acquire and start). Null-safety keeps the cleanup path one-shot.
        expect(() => stopHeartbeat(null)).not.toThrow();
        expect(() => stopHeartbeat(undefined)).not.toThrow();
    });

    test('startHeartbeat rejects intervalMs >= ttlMs', () => {
        // The docblock says "intervalMs must be < ttlMs" — if the heartbeat
        // ticks slower than the TTL, the refresh acquire happens AFTER the
        // previous expiresAt and a competitor can legally evict us in between,
        // making the heartbeat useless. Catching at arm time turns this
        // misconfiguration into a noisy startup error instead of a mysterious
        // mid-run "another holder is migrating" failure.
        const holderId = makeHolderId();
        expect(() => startHeartbeat({ dataRoot, holderId, intervalMs: 5_000, ttlMs: 1_000 }))
            .toThrow(/intervalMs must be < ttlMs/);
        // Equal values are also disallowed: even if the refresh syscall took
        // 0ms, the window for eviction is non-empty (a competitor with even
        // a 1ms head-start lands inside it).
        expect(() => startHeartbeat({ dataRoot, holderId, intervalMs: 1_000, ttlMs: 1_000 }))
            .toThrow(/intervalMs must be < ttlMs/);
    });

    test('heartbeat does not throw when lock is stolen mid-run', async () => {
        // If a competitor evicts us (e.g. TTL elapsed before the next tick
        // fired, then someone else acquired), the next heartbeat acquire
        // would reject with "another holder is migrating". The heartbeat
        // must swallow that — the migration body is what should observe and
        // react to lock loss, not the background timer.
        const holderId = makeHolderId();
        const otherHolderId = makeHolderId();
        await acquireMigrationLock({ dataRoot, holderId, ttlMs: 200 });
        const hb = startHeartbeat({ dataRoot, holderId, intervalMs: 50, ttlMs: 200 });
        try {
            // Let our heartbeat run a couple of cycles to prove the happy path
            // works under contention pressure, then evict ourselves and let a
            // competitor grab the lock. Subsequent heartbeat ticks should log
            // but not throw — `unhandledRejection` would fail the test.
            await new Promise(r => setTimeout(r, 120));
            const lockPath = path.join(dataRoot, '_migration.lock');
            fs.rmSync(lockPath, { force: true });
            await acquireMigrationLock({ dataRoot, holderId: otherHolderId, ttlMs: 5_000 });
            // Wait long enough for several failing heartbeat ticks to land.
            await new Promise(r => setTimeout(r, 250));
            // Lock is still the competitor's, proving our heartbeat didn't
            // succeed in re-acquiring (and also didn't crash trying).
            const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            expect(data.holderId).toBe(otherHolderId);
        } finally {
            stopHeartbeat(hb);
            await releaseMigrationLock({ dataRoot, holderId: otherHolderId });
        }
    });
});
