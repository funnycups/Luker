import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { runSyncCycle } from '../../../src/sync/pipeline/cycle.js';
import { readSqlRecordValue, writeSqlRecordValue } from '../../../src/sync/materialize.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { BACKEND_ID, makeRemote, remoteHead } from '../_lib/devices.js';
import { orderLocalHead } from '../_lib/merge-roles.js';
import { withNestedDirs } from '../_lib/nested-dirs.js';

const doc = content => ({ entries: { 0: { content, keys: ['k'] } }, extensions: { depth: 4 } });

describe.each(CONTRACT_HARNESSES)('runSyncCycle with engine records — $name', ({ make }) => {
    let remote;
    const harnesses = [];

    async function device() {
        const h = withNestedDirs(await make());
        harnesses.push(h);
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        fs.mkdirSync(h.dirs.characters, { recursive: true });
        const userRoot = h.dirs.root;
        const ctx = {
            userRoot,
            handle: h.handle,
            directories: h.dirs,
            backendId: BACKEND_ID,
            categories: ['worlds', 'characters'],
            engine: h.engine,
            backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot }),
        };
        const worlds = new WorldInfoRepo({ engine: h.engine });
        return { h, ctx, worlds };
    }

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.cleanup();
        remote.cleanup();
    });

    // Two fresh databases and six cycles; MySQL needs well over the default
    // test timeout while the full suite runs in parallel.
    test('engine records and disk files travel both ways', async () => {
        const A = await device();
        await A.worlds.save(A.h.handle, 'Lore', doc('from A'));
        fs.writeFileSync(path.join(A.h.dirs.characters, 'a.png'), 'A');
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('pairing-push');

        const B = await device();
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('pairing-pull');
        expect(await B.worlds.get(B.h.handle, 'Lore')).toEqual(doc('from A'));
        expect(fs.readFileSync(path.join(B.h.dirs.characters, 'a.png'), 'utf8')).toBe('A');

        await B.worlds.save(B.h.handle, 'Lore', doc('from B'));
        expect(await runSyncCycle(B.ctx)).toMatchObject({ status: 'synced', mergeCase: 'ahead', pushed: true });
        expect(await runSyncCycle(A.ctx)).toMatchObject({ status: 'synced', mergeCase: 'fast-forward' });
        expect(await A.worlds.get(A.h.handle, 'Lore')).toEqual(doc('from B'));

        await A.worlds.delete(A.h.handle, 'Lore');
        await runSyncCycle(A.ctx);
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome.reconcile.deleted).toEqual(['worlds/Lore.json']);
        expect(await B.worlds.exists(B.h.handle, 'Lore')).toBe(false);
    }, 60_000);
});

describe.each(CONTRACT_HARNESSES.filter(h => h.name !== 'FsEngine'))('state companion merge — $name', ({ make }) => {
    let remote;
    const harnesses = [];

    async function device() {
        const h = withNestedDirs(await make());
        harnesses.push(h);
        fs.mkdirSync(h.dirs.chats, { recursive: true });
        const userRoot = h.dirs.root;
        const ctx = {
            userRoot,
            handle: h.handle,
            directories: h.dirs,
            backendId: BACKEND_ID,
            categories: ['chats'],
            engine: h.engine,
            backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot }),
        };
        return { h, ctx };
    }

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.cleanup();
        remote.cleanup();
    });

    test('a merge that keeps a state companion converges without a rerun', async () => {
        const A = await device();
        const B = await device();
        const chat = { header: { user_name: 'U', character_name: 'Seraphina', chat_metadata: {} }, body: [{ name: 'U', is_user: true, mes: 'hi' }] };
        await A.h.engine.withTransaction(A.h.handle, tx => writeSqlRecordValue(tx, A.h.handle, { kind: 'chat', charDir: 'Seraphina', name: 'c1', isGroup: false }, chat));
        await A.h.engine.withTransaction(A.h.handle, tx => writeSqlRecordValue(tx, A.h.handle, { kind: 'chat-state', charDir: 'Seraphina', name: 'c1', isGroup: false, namespace: 'mg' }, { v: 0 }));
        await runSyncCycle(A.ctx);
        await runSyncCycle(B.ctx);
        await B.h.engine.withTransaction(B.h.handle, tx => writeSqlRecordValue(tx, B.h.handle, { kind: 'chat-state', charDir: 'Seraphina', name: 'c1', isGroup: false, namespace: 'mg' }, { v: 1 }));
        await A.h.engine.withTransaction(A.h.handle, tx => writeSqlRecordValue(tx, A.h.handle, { kind: 'chat', charDir: 'Seraphina', name: 'c1', isGroup: false }, null));
        await runSyncCycle(A.ctx);
        // B keeps its companion provisionally only as ours.
        await orderLocalHead(B.ctx, await remoteHead(remote.remoteDir), true);
        const outcome = await runSyncCycle(B.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'merged' });
        expect(await B.h.engine.withTransaction(B.h.handle, tx => readSqlRecordValue(tx, B.h.handle, { kind: 'chat', charDir: 'Seraphina', name: 'c1', isGroup: false }))).not.toBeNull();
    }, 60_000);
});
