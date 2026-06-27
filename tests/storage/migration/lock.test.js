// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Cross-process migration lock — spec §C item 6 / §4.5.
//
// The migration tooling has two entry points (admin route + CLI) that can
// both run on the same dataRoot; without a shared lock they'd race on the
// engine swap and corrupt user state. We use a single fs lockfile at
// `<dataRoot>/_migration.lock` because:
//
//   * sqlite has no `_storage_meta` table, fs has no DB at all — the lock
//     must live somewhere uniform across all four engines.
//   * A file gives us free cross-process visibility (any process that can
//     see the dataRoot can see the lock) and survives crashes (TTL eviction).
//
// These tests pin the documented contract: acquire creates the file, a
// second holder blocks while it's valid, expired locks are auto-evicted,
// release is conditional ("only if we hold it"), and the same holder may
// re-acquire to refresh TTL during a long-running migration heartbeat.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    acquireMigrationLock,
    releaseMigrationLock,
    makeHolderId,
} from '../../../src/storage/migration/lock.js';

describe('migration lock', () => {
    let dataRoot;

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-lock-test-'));
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('makeHolderId returns a host:pid:nonce string with a non-empty nonce', () => {
        const id = makeHolderId();
        expect(typeof id).toBe('string');
        // host:pid:hex — three colon-separated fields. We don't pin the host
        // string but we do require the nonce to be present so two acquires in
        // the same process don't collide.
        const parts = id.split(':');
        expect(parts.length).toBeGreaterThanOrEqual(3);
        expect(parts[1]).toBe(String(process.pid));
        expect(parts[parts.length - 1].length).toBeGreaterThan(0);
    });

    test('two makeHolderId calls produce different ids (nonce uniqueness)', () => {
        // Within one process the host+pid prefix is identical; the random
        // suffix is the only thing keeping two concurrent migrations on the
        // same host from colliding.
        expect(makeHolderId()).not.toBe(makeHolderId());
    });

    test('acquire creates the lock file at <dataRoot>/_migration.lock', async () => {
        const holderId = makeHolderId();
        const result = await acquireMigrationLock({ dataRoot, holderId });
        expect(result.holderId).toBe(holderId);
        expect(result.expiresAt).toBeInstanceOf(Date);
        expect(fs.existsSync(path.join(dataRoot, '_migration.lock'))).toBe(true);
    });

    test('lock file content includes holderId, host, pid, acquiredAt, expiresAt', async () => {
        const holderId = makeHolderId();
        await acquireMigrationLock({ dataRoot, holderId, ttlMs: 60_000 });
        const raw = fs.readFileSync(path.join(dataRoot, '_migration.lock'), 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.holderId).toBe(holderId);
        expect(typeof parsed.host).toBe('string');
        expect(parsed.host.length).toBeGreaterThan(0);
        expect(parsed.pid).toBe(process.pid);
        expect(typeof parsed.acquiredAt).toBe('string');
        expect(typeof parsed.expiresAt).toBe('string');
        // expiresAt strictly after acquiredAt
        expect(new Date(parsed.expiresAt).getTime())
            .toBeGreaterThan(new Date(parsed.acquiredAt).getTime());
    });

    test('second acquire by different holder while non-expired throws', async () => {
        await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        await expect(acquireMigrationLock({ dataRoot, holderId: 'holderB' }))
            .rejects.toThrow(/another holder is migrating/);
    });

    test('rejection message names the competing holder so operators can find it', async () => {
        // The whole point of the lock contention error is to tell the admin
        // who's currently migrating. If we just said "locked" they'd have to
        // open the file by hand.
        await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        await expect(acquireMigrationLock({ dataRoot, holderId: 'holderB' }))
            .rejects.toThrow(/holderA/);
    });

    test('expired lock is overwritten by next acquirer', async () => {
        // 50ms TTL, sleep 150ms — well past expiry on any reasonable host.
        await acquireMigrationLock({ dataRoot, holderId: 'holderA', ttlMs: 50 });
        await new Promise(r => setTimeout(r, 150));
        const result = await acquireMigrationLock({ dataRoot, holderId: 'holderB' });
        expect(result.holderId).toBe('holderB');
        const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, '_migration.lock'), 'utf8'));
        expect(parsed.holderId).toBe('holderB');
    });

    test('release removes lock when held by us', async () => {
        await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        await releaseMigrationLock({ dataRoot, holderId: 'holderA' });
        expect(fs.existsSync(path.join(dataRoot, '_migration.lock'))).toBe(false);
    });

    test('release by wrong holder is a no-op (lock survives)', async () => {
        // This is the safety invariant: a stale release call from a crashed
        // sibling process must never strip the lock out from under the real
        // holder.
        await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        await releaseMigrationLock({ dataRoot, holderId: 'holderB' });
        expect(fs.existsSync(path.join(dataRoot, '_migration.lock'))).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, '_migration.lock'), 'utf8'));
        expect(parsed.holderId).toBe('holderA');
    });

    test('release when no lock file exists is a no-op (no throw)', async () => {
        // CLI/finally paths call release unconditionally; if acquire failed
        // upstream the lock file may never have been written. We don't want
        // a spurious crash in cleanup to mask the original error.
        await expect(releaseMigrationLock({ dataRoot, holderId: 'holderA' }))
            .resolves.toBeUndefined();
    });

    test('release tolerates a corrupt lock file (no throw, no removal)', async () => {
        // Defensive: if some other tool wrote garbage to the lock file, we
        // shouldn't crash the migration's finally block. We also shouldn't
        // delete the garbage — that's not ours to clean up.
        fs.writeFileSync(path.join(dataRoot, '_migration.lock'), 'not json {');
        await expect(releaseMigrationLock({ dataRoot, holderId: 'holderA' }))
            .resolves.toBeUndefined();
        expect(fs.existsSync(path.join(dataRoot, '_migration.lock'))).toBe(true);
    });

    test('same holder can re-acquire to refresh TTL (heartbeat)', async () => {
        // Heartbeat refresh — long-running migrations
        // call acquire on a schedule to push the expiry forward. Two acquires
        // by the same holder must succeed.
        const holderId = makeHolderId();
        const first = await acquireMigrationLock({ dataRoot, holderId, ttlMs: 1_000 });
        const second = await acquireMigrationLock({ dataRoot, holderId, ttlMs: 60_000 });
        expect(second.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
        expect(fs.existsSync(path.join(dataRoot, '_migration.lock'))).toBe(true);
    });

    test('corrupt lock file is overwritten by a new acquirer', async () => {
        // If a previous process crashed mid-write or some other tool stomped
        // on the file, the next legitimate acquirer should be able to recover.
        // Anything else would brick the data root.
        fs.writeFileSync(path.join(dataRoot, '_migration.lock'), 'not json {');
        const result = await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        expect(result.holderId).toBe('holderA');
        const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, '_migration.lock'), 'utf8'));
        expect(parsed.holderId).toBe('holderA');
    });

    test('acquire without dataRoot throws', async () => {
        await expect(acquireMigrationLock({ holderId: 'h' }))
            .rejects.toThrow(/dataRoot/);
    });

    test('acquire without holderId throws', async () => {
        await expect(acquireMigrationLock({ dataRoot }))
            .rejects.toThrow(/holderId/);
    });

    test('default TTL is 60s when ttlMs is omitted', async () => {
        // A casual caller (e.g. the admin route) shouldn't have to think
        // about the TTL — 60s gives plenty of head room for a single-user
        // migration and is short enough for the eviction case to kick in
        // when the holder really did crash.
        const before = Date.now();
        await acquireMigrationLock({ dataRoot, holderId: 'holderA' });
        const after = Date.now();
        const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, '_migration.lock'), 'utf8'));
        const expiresAt = new Date(parsed.expiresAt).getTime();
        const acquiredAt = new Date(parsed.acquiredAt).getTime();
        // Lock should expire 60s after acquisition (allow ±50ms wall-clock skew).
        expect(expiresAt - acquiredAt).toBeGreaterThanOrEqual(60_000 - 50);
        expect(expiresAt - acquiredAt).toBeLessThanOrEqual(60_000 + 50);
        expect(acquiredAt).toBeGreaterThanOrEqual(before);
        expect(acquiredAt).toBeLessThanOrEqual(after);
    });
});
