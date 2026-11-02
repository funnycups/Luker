import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import git from 'isomorphic-git';

import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { runSyncCycle, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { readSqlRecordValue, writeSqlRecordValue } from '../../../src/sync/materialize.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { BACKEND_ID, makeRemote } from '../_lib/devices.js';
import { withNestedDirs } from '../_lib/nested-dirs.js';

const CATEGORIES = ['worlds', 'chats', 'settings', 'stats', 'openai-presets', 'themes'];

// Keys deliberately out of the order MySQL JSON and Postgres JSONB store
// them in: both sort object keys by length, then bytewise.
const RECORDS = [
    [{ kind: 'world', name: 'Eldoria' }, {
        name: 'Eldoria',
        entries: { 0: { uid: 0, key: ['harbor'], keysecondary: [], comment: 'Harbor', content: 'Ships arrive at dawn.', constant: false, order: 100, depth: 4 } },
        extensions: { depth: 4 },
    }],
    [{ kind: 'settings' }, { power_user: { font_scale: 1.1, theme: 'dark' }, username: 'U', active_character: 'Seraphina.png' }],
    [{ kind: 'preset', dirKey: 'openAI_Settings', name: 'Creative' }, { temperature: 0.7, top_p: 0.95, frequency_penalty: 0.1 }],
    [{ kind: 'preset-state', dirKey: 'openAI_Settings', name: 'Creative', namespace: 'iter_lib' }, { nodes: ['n1'], cursor: 1 }],
    [{ kind: 'named-doc', bucket: 'themes', name: 'Midnight' }, { name: 'Midnight', main_text_color: '#fff', blur_strength: 10 }],
    [{ kind: 'stats' }, { 'Seraphina.png': { user_msg_count: 7, total_gen_time: 1234, char_msg_count: 9 }, timestamp: 1760000000 }],
    [{ kind: 'group', id: 'grp-1' }, { name: 'Crew', id: 'grp-1', members: ['Seraphina.png'], chats: ['gc-1'], chat_id: 'gc-1', avatar_url: '' }],
    [{ kind: 'chat', charDir: null, name: 'gc-1', isGroup: true }, {
        header: { user_name: 'U', create_date: '2026-10-14', chat_metadata: { variables: { round: 1 }, integrity: 'group-integrity' } },
        body: [{ name: 'Seraphina', is_user: false, send_date: '2026-10-14', mes: 'The crew gathers.' }],
    }],
];

const CHAT = { kind: 'chat', charDir: 'Seraphina', name: 'Seraphina - 2026-10-14', isGroup: false };
const CHAT_VALUE = {
    header: { user_name: 'U', character_name: 'Seraphina', create_date: '2026-10-14', chat_metadata: { variables: { mood: 'calm' }, integrity: 'seed-integrity' } },
    body: [
        { name: 'Seraphina', is_user: false, send_date: '2026-10-14', mes: 'Welcome to the glade.', extra: { gen_id: 'g1', model: 'opus' } },
        { name: 'U', is_user: true, send_date: '2026-10-14', mes: 'Thank you.' },
    ],
};
const CHAT_STATE = { ...CHAT, kind: 'chat-state', namespace: 'memory_graph' };

const byName = name => CONTRACT_HARNESSES.find(h => h.name === name);
const sqlServers = ['MysqlEngine', 'PgEngine'];
const pairs = sqlServers.flatMap(server => ['FsEngine', 'SqliteEngine'].flatMap(local => [[local, server], [server, local]]));

describe.each(pairs)('cross-engine sync %s ↔ %s', (nameA, nameB) => {
    let remote;
    const harnesses = [];

    async function device(name) {
        const h = withNestedDirs(await byName(name).make());
        harnesses.push(h);
        for (const key of ['worlds', 'chats', 'groups', 'groupChats', 'openAI_Settings', 'themes']) fs.mkdirSync(h.dirs[key], { recursive: true });
        const userRoot = h.dirs.root;
        const ctx = {
            userRoot,
            handle: h.handle,
            directories: h.dirs,
            backendId: BACKEND_ID,
            categories: CATEGORIES,
            engine: h.engine,
            backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot }),
        };
        const gitdir = getShadowPaths({ userRoot, peerId: BACKEND_ID }).gitDir;
        const main = () => git.resolveRef({ fs: atomicFs, gitdir, ref: MAIN_REF });
        const write = (record, value) => h.engine.withTransaction(h.handle, tx => writeSqlRecordValue(tx, h.handle, record, value));
        const read = record => h.engine.withTransaction(h.handle, tx => readSqlRecordValue(tx, h.handle, record));
        return { h, ctx, main, write, read };
    }

    async function seed(d, { chat }) {
        for (const [record, value] of RECORDS) {
            if (record.kind === 'preset-state') continue;
            await d.write(record, value);
        }
        for (const [record, value] of RECORDS) {
            if (record.kind === 'preset-state') await d.write(record, value);
        }
        if (chat) {
            await d.write(CHAT, CHAT_VALUE);
            await d.write(CHAT_STATE, { nodes: [{ id: 'root', label: 'Glade' }], edges: [] });
        }
    }

    // A cycle that only snapshots must leave main where it was.
    async function expectStable(d) {
        const before = await d.main();
        const outcome = await runSyncCycle(d.ctx);
        expect(outcome).toMatchObject({ status: 'synced', mergeCase: 'equal', conflicts: [] });
        expect(await d.main()).toBe(before);
    }

    beforeEach(async () => {
        _resetGateForTests();
        remote = await makeRemote();
    });
    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.cleanup();
        remote.cleanup();
    });

    // cap-ok: Jest test timeout. A fresh database per device and several
    // cycles take well over the default while the suite runs in parallel.
    test('a device pulling the other engine\'s records commits nothing afterwards', async () => {
        const A = await device(nameA);
        await seed(A, { chat: true });
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('pairing-push');
        const B = await device(nameB);
        expect((await runSyncCycle(B.ctx)).mergeCase).toBe('pairing-pull');
        for (const [record, value] of RECORDS) expect(await B.read(record)).toEqual(value);
        expect(await B.read(CHAT)).toEqual(CHAT_VALUE);
        await expectStable(B);
        await expectStable(A);
    }, 120_000);

    test('identical records seeded on both devices pair without conflicts', async () => {
        const A = await device(nameA);
        const B = await device(nameB);
        await seed(A, { chat: true });
        await seed(B, { chat: true });
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('pairing-push');
        const paired = await runSyncCycle(B.ctx);
        expect(paired).toMatchObject({ status: 'synced', mergeCase: 'merged-unrelated', conflicts: [] });
        expect((await runSyncCycle(A.ctx)).mergeCase).toBe('fast-forward');
        expect(await A.main()).toBe(await B.main());
        for (const d of [A, B]) {
            for (const [record, value] of RECORDS) expect(await d.read(record)).toEqual(value);
            expect(await d.read(CHAT)).toEqual(CHAT_VALUE);
            const chats = await d.h.engine.withTransaction(d.h.handle, tx => tx.listResources({ kind: 'chat', handle: d.h.handle, isGroup: false }));
            expect(chats.map(entry => entry.key.name)).toEqual([CHAT.name]);
        }
        await expectStable(A);
        await expectStable(B);
    }, 120_000);
});
