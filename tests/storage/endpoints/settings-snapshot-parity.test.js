// Coverage for the settings snapshot endpoints. Previously these read/wrote
// `<root>/settings.json` directly via fs.* — in db mode that file is empty
// (the data lives in SettingsRepo), so make-snapshot captured nothing and
// restore-snapshot was a silent no-op.
//
// Snapshot operations now route through SettingsRepo. Disk backups
// stay on fs (they're admin artifacts and deliberately fs-visible) but their
// contents reflect the live SettingsRepo state.

import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createHook } from 'node:async_hooks';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as settingsRouter, flushSettingsBackups } from '../../../src/endpoints/settings.js';
import { getSettingsRepo, getWorldInfoRepo, setReadOnly } from '../../../src/storage/index.js';
import { currentScopeForResources } from '../../harness/storage-scope.js';

async function observeAutosaveTimers(body) {
    const timers = [];
    const hook = createHook({ init(_id, type, _trigger, resource) {
        if (type === 'Timeout' && resource._idleTimeout === 10 * 60 * 1000) timers.push(resource);
    } });
    hook.enable();
    try { return await body(timers); }
    finally {
        hook.disable();
        for (const timer of timers) clearTimeout(timer);
    }
}

const backupDocuments = directory => fs.readdirSync(directory).filter(name => name.startsWith('settings_')).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));

describe.each(ENDPOINT_HARNESSES)('settings.js snapshot endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/settings', settingsRouter); },
        });
    });

    test.each(['cleanup', 'reopenEngine'])('%s drains the latest acknowledged autosave and its native timer', async operation => {
        await observeAutosaveTimers(async timers => {
            const directory = await currentScopeForResources().directory('settings backup observation');
            harness.dirs.backups = directory.path;
            await request(harness.server).post('/api/settings/save').send({ user_name: 'leading autosave' }).expect(200);
            await request(harness.server).post('/api/settings/save').send({ user_name: 'latest acknowledged autosave' }).expect(200);
            expect(timers).toHaveLength(1);
            expect(timers[0]._destroyed).toBe(false);
            await harness[operation]();
            expect(timers[0]._destroyed).toBe(true);
            expect(backupDocuments(directory.path)).toContainEqual({ user_name: 'latest acknowledged autosave' });
            expect(fs.existsSync(harness.dataRoot)).toBe(operation === 'reopenEngine');
        });
    });

    test('equal account handles retain autosaves in their own data roots', async () => {
        await observeAutosaveTimers(async timers => {
            const scope = currentScopeForResources();
            const first = await scope.directory('first settings backup observation');
            harness.dirs.backups = first.path;
            await request(harness.server).post('/api/settings/save').send({ user_name: 'first account root' }).expect(200);
            await harness.cleanup();
            harness = await makeEndpointHarness({ mode, mount: app => app.use('/api/settings', settingsRouter) });
            const second = await scope.directory('second settings backup observation');
            harness.dirs.backups = second.path;
            await request(harness.server).post('/api/settings/save').send({ user_name: 'second account root' }).expect(200);
            await harness.cleanup();
            expect(timers).toHaveLength(2);
            expect(timers.every(timer => timer._destroyed)).toBe(true);
            expect(backupDocuments(first.path)).toEqual([{ user_name: 'first account root' }]);
            expect(backupDocuments(second.path)).toEqual([{ user_name: 'second account root' }]);
        });
    });

    test('autosave write failure rejects closure without replacing the previous backup', async () => {
        await observeAutosaveTimers(async timers => {
            const directory = await currentScopeForResources().directory('refused settings backup observation');
            harness.dirs.backups = directory.path;
            await getSettingsRepo().save(harness.handle, { user_name: 'retained backup' });
            await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);
            const names = fs.readdirSync(directory.path);
            const before = names.map(name => fs.readFileSync(path.join(directory.path, name)));
            for (const name of names) fs.chmodSync(path.join(directory.path, name), 0o400);
            fs.chmodSync(directory.path, 0o500);
            try {
                await request(harness.server).post('/api/settings/save').send({ user_name: 'saved primary settings' }).expect(200);
                expect(await getSettingsRepo().get(harness.handle)).toEqual({ user_name: 'saved primary settings' });
                await expect(harness.cleanup()).rejects.toMatchObject({ code: 'EACCES' });
                expect(names.map(name => fs.readFileSync(path.join(directory.path, name)))).toEqual(before);
                expect(timers.every(timer => timer._destroyed)).toBe(true);
            } finally {
                fs.chmodSync(directory.path, 0o700);
                for (const name of names) fs.chmodSync(path.join(directory.path, name), 0o600);
            }
        });
    });


    test('REGRESSION: /make-snapshot then /get-snapshots surfaces the snapshot of the live SettingsRepo doc', async () => {
        await getSettingsRepo().save(harness.handle, { user_name: 'pre-snapshot', custom: 'A' });

        await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);

        const listRes = await request(harness.server).post('/api/settings/get-snapshots').send({}).expect(200);
        expect(Array.isArray(listRes.body)).toBe(true);
        expect(listRes.body.length).toBeGreaterThanOrEqual(1);

        const snap = listRes.body[0];
        expect(snap.name).toMatch(/^settings_u_/);

        const loadRes = await request(harness.server)
            .post('/api/settings/load-snapshot')
            .send({ name: snap.name })
            .expect(200);
        // The body comes back as a JSON-string (the raw on-disk snapshot file).
        const parsed = typeof loadRes.body === 'string'
            ? JSON.parse(loadRes.body)
            : (loadRes.text ? JSON.parse(loadRes.text) : loadRes.body);
        // The snapshot must reflect what was in the live SettingsRepo, not
        // the (empty) <root>/settings.json file.
        expect(parsed.user_name).toBe('pre-snapshot');
        expect(parsed.custom).toBe('A');
    });

    test('REGRESSION: /restore-snapshot writes back into SettingsRepo (not just a stale fs file)', async () => {
        // Seed state #1 + snapshot.
        await getSettingsRepo().save(harness.handle, { user_name: 'snapshot-state', preset: 'A' });
        await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);

        // Mutate to state #2.
        await getSettingsRepo().save(harness.handle, { user_name: 'after-snapshot', preset: 'B' });

        // List snapshots to find the one we created.
        const listRes = await request(harness.server).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        // Restore — must roll the LIVE SettingsRepo (not a fs file) back to state #1.
        await request(harness.server)
            .post('/api/settings/restore-snapshot')
            .send({ name: snap.name })
            .expect(204);

        const after = await getSettingsRepo().get(harness.handle);
        expect(after.user_name).toBe('snapshot-state');
        expect(after.preset).toBe('A');
    });

    test('REGRESSION: snapshots persist across engine restart (the user-repro shape)', async () => {
        await getSettingsRepo().save(harness.handle, { user_name: 'persisted', x: 7 });
        await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);

        await harness.reopenEngine();

        const listRes = await request(harness.server).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        const loadRes = await request(harness.server)
            .post('/api/settings/load-snapshot')
            .send({ name: snap.name })
            .expect(200);
        const parsed = typeof loadRes.body === 'string'
            ? JSON.parse(loadRes.body)
            : (loadRes.text ? JSON.parse(loadRes.text) : loadRes.body);
        expect(parsed.user_name).toBe('persisted');
        expect(parsed.x).toBe(7);
    });

    test('REGRESSION: cached settings autosave resolves live SettingsRepo dynamically across storage swap', async () => {
        if (mode === 'fs') return;
        const { initStorage, getStorageEngine } = await import('../../../src/storage/index.js');
        const { flushSettingsBackups } = await import('../../../src/endpoints/settings.js');
        await observeAutosaveTimers(async () => {
            const directory = await currentScopeForResources().directory('settings swap observation');
            harness.dirs.backups = directory.path;
            // Arm the autosave throttle on the initial DB engine and wait for its
            // leading backup to complete while keeping the entry cached in AUTOSAVE_FUNCTIONS.
            await request(harness.server).post('/api/settings/save').send({ user_name: 'before-swap' }).expect(200);
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && !backupDocuments(directory.path).some(doc => doc.user_name === 'before-swap')) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(backupDocuments(directory.path)).toContainEqual({ user_name: 'before-swap' });
            const oldEngine = getStorageEngine();
            // Swap live storage to a new FS engine targeting the same user root while
            // the autosave entry is still cached (simulating live storage migration).
            // Leave oldEngine open for harness.cleanup() so it is closed exactly once;
            // oldEngine retains `{ user_name: 'before-swap' }` while the new live FS
            // engine receives `{ user_name: 'after-swap-live' }`.
            await initStorage({ mode: 'fs', directoriesByHandle: () => harness.dirs });
            // Trigger trailing autosave on the cached entry and flush — must resolve
            // getSettingsRepo() dynamically and read from the NEW live repo, not oldEngine.
            await request(harness.server).post('/api/settings/save').send({ user_name: 'after-swap-live' }).expect(200);
            await flushSettingsBackups(harness.dirs.root);
            expect(backupDocuments(directory.path)).toContainEqual({ user_name: 'after-swap-live' });
            const staleOldDoc = await oldEngine.withTransaction(
                harness.handle,
                tx => tx.getResource({ kind: 'settings', handle: harness.handle }),
            );
            expect(staleOldDoc).toEqual({ user_name: 'before-swap' });
        });
    });

    test('REGRESSION: concurrent /save during flushSettingsBackups does not re-arm timer on retiring entry', async () => {
        await observeAutosaveTimers(async timers => {
            const directory = await currentScopeForResources().directory('concurrent settings flush observation');
            harness.dirs.backups = directory.path;

            // Arm the initial autosave entry and wait for its leading backup to finish.
            await request(harness.server).post('/api/settings/save').send({ user_name: 'leading-v1' }).expect(200);
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && !backupDocuments(directory.path).some(doc => doc.user_name === 'leading-v1')) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(timers).toHaveLength(1);

            // Queue a trailing backup on entry #1.
            await request(harness.server).post('/api/settings/save').send({ user_name: 'trailing-v2' }).expect(200);

            // Pause the real SettingsRepo.get() called inside flushSettingsBackups so
            // a concurrent /save arrives while entry #1 is awaiting finish().
            const repo = getSettingsRepo();
            const originalGet = repo.get.bind(repo);
            let releaseRead;
            let readEntered;
            const readStarted = new Promise(resolve => { readEntered = resolve; });
            const readGate = new Promise(resolve => { releaseRead = resolve; });
            let intercepted = false;
            const getSpy = jest.spyOn(repo, 'get').mockImplementation(async (...args) => {
                if (!intercepted) {
                    intercepted = true;
                    readEntered();
                    await readGate;
                }
                return await originalGet(...args);
            });

            try {
                const flushPromise = flushSettingsBackups(harness.dirs.root);
                await readStarted;

                // Retiring entry #1's timer must already be cancelled and detached.
                expect(timers[0]._destroyed).toBe(true);

                // Concurrent save arrives while flush #1 is in flight — must allocate
                // a NEW tracked entry (timers[1]) rather than re-arming timers[0].
                await request(harness.server).post('/api/settings/save').send({ user_name: 'concurrent-v3' }).expect(200);
                expect(timers).toHaveLength(2);
                expect(timers[0]._destroyed).toBe(true);

                releaseRead();
                await flushPromise;

                // Flushing again drains entry #2 cleanly with zero leaked timers.
                await flushSettingsBackups(harness.dirs.root);
                expect(timers.every(timer => timer._destroyed)).toBe(true);
                expect(backupDocuments(directory.path)).toContainEqual({ user_name: 'concurrent-v3' });
            } finally {
                getSpy.mockRestore();
            }
        });
    });

    test('REGRESSION: /save, /patch, and /restore-snapshot map StorageReadOnlyError to HTTP 503', async () => {
        await getSettingsRepo().save(harness.handle, { user_name: 'readonly-before' });
        await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);
        const listRes = await request(harness.server).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        setReadOnly(true);
        try {
            const saveRes = await request(harness.server)
                .post('/api/settings/save')
                .send({ user_name: 'blocked-save' });
            expect(saveRes.status).toBe(503);
            expect(saveRes.body.error).toBe('storage_read_only');
            expect(typeof saveRes.body.message).toBe('string');

            const patchRes = await request(harness.server)
                .post('/api/settings/patch')
                .send({ operations: [{ op: 'replace', path: '/user_name', value: 'blocked-patch' }] });
            expect(patchRes.status).toBe(503);
            expect(patchRes.body.error).toBe('storage_read_only');
            expect(typeof patchRes.body.message).toBe('string');

            const restoreRes = await request(harness.server)
                .post('/api/settings/restore-snapshot')
                .send({ name: snap.name });
            expect(restoreRes.status).toBe(503);
            expect(restoreRes.body.error).toBe('storage_read_only');
            expect(typeof restoreRes.body.message).toBe('string');
        } finally {
            setReadOnly(false);
        }

        expect(await getSettingsRepo().get(harness.handle)).toEqual({ user_name: 'readonly-before' });
    });

    test('REGRESSION: /restore-snapshot maps ConflictError to HTTP 409', async () => {
        const worlds = getWorldInfoRepo();
        const version = await worlds.save(harness.handle, 'SnapshotWorld', { entries: {} });
        await getSettingsRepo().save(harness.handle, {
            user_name: 'with-world',
            world_info_settings: { world_info: { charLore: [{ name: 'keeper', extraBooks: ['SnapshotWorld'] }] } },
        });
        await request(harness.server).post('/api/settings/make-snapshot').send({}).expect(204);
        const listRes = await request(harness.server).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        // Unbind SnapshotWorld in live settings so conditional deletion can commit.
        await getSettingsRepo().save(harness.handle, {
            user_name: 'without-world',
            world_info_settings: { world_info: { charLore: [] } },
        });

        const repo = getSettingsRepo();
        const originalSave = repo.save.bind(repo);
        let saveEntered;
        const saveStarted = new Promise(resolve => { saveEntered = resolve; });
        const saveSpy = jest.spyOn(repo, 'save').mockImplementationOnce((...args) => {
            const pending = originalSave(...args);
            saveEntered();
            return pending;
        });

        let restorePromise;
        try {
            const deleted = await worlds.delete(harness.handle, 'SnapshotWorld', {
                expectedVersion: version,
                beforeDelete: async () => {
                    // Dispatch restore-snapshot while deletion holds the coordination lock
                    // so the snapshot save waits behind the committed deletion and fails with
                    // ConflictError('world_deleted').
                    restorePromise = new Promise((resolve, reject) => {
                        request(harness.server)
                            .post('/api/settings/restore-snapshot')
                            .send({ name: snap.name })
                            .end((err, res) => (err ? reject(err) : resolve(res)));
                    });
                    await saveStarted;
                },
            });

            expect(deleted).toBe(true);
            const restoreRes = await restorePromise;
            expect(restoreRes.status).toBe(409);
            expect(restoreRes.body.code).toBe('world_deleted');
            expect(restoreRes.body.details).toEqual({ name: 'SnapshotWorld' });
        } finally {
            saveSpy.mockRestore();
        }
    });
});
