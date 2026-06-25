// Each of the 8 incremental chat-mutation endpoints must trigger
// getBackupFunction(handle), creating a chat_<sanitized_name>_<ts>.jsonl file
// in request.user.directories.backups (== harness.dirs.backups).
//
// Pre-Stage-3 only POST /save invoked the backup throttle — every other
// mutation path (append, patch, meta/patch, state/patch, plus the four group
// twins) silently bypassed it, so users on db modes who never hit the legacy
// /save route (e.g. branch-only workflows, state-only sidecar writes) got
// zero backup history. Spec §6.2 lists all 8 endpoints; we assert one per
// endpoint per engine.
//
// Throttle note: getBackupFunction memoizes a 10s `{leading:true, trailing:
// true}` throttle per handle in a module-scoped Map. Across tests in the
// same describe block the throttle stays warm, so call #2 onward in the
// 10s window would only schedule a trailing fire that lands after the test
// asserted. To keep each test deterministic we reset the throttle map in
// beforeEach via the dedicated test-only export.

import fs from 'node:fs';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter, _resetChatBackupThrottlesForTests } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi' },
    { name: 'Alice', is_user: false, mes: 'hello' },
];

function listBackupFiles(harness, prefix) {
    const dir = harness.dirs.backups;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.startsWith(`chat_${prefix.toLowerCase()}_`) && n.endsWith('.jsonl'));
}

describe.each(ENDPOINT_HARNESSES)('chat incremental backup on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        _resetChatBackupThrottlesForTests();
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/chats', chatsRouter); },
        });
        // The harness already pre-creates backups/, but be explicit:
        // some endpoints check for the directory before writing.
        fs.mkdirSync(harness.dirs.backups, { recursive: true });
        // Pre-seed a solo chat so /append, /patch, /meta/patch, and /state/patch
        // (solo branch) have something to mutate.
        await getChatRepo().save(harness.handle, 'Alice', 'c1', HEADER, MESSAGES, null);
    });

    afterEach(async () => {
        _resetChatBackupThrottlesForTests();
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: solo /append triggers chat backup', async () => {
        const fetched = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        const res = await request(harness.app)
            .post('/api/chats/append')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'c1',
                integrity: fetched.integrity,
                messages: [{ name: 'Alice', mes: 'a fresh reply' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'alice').length).toBeGreaterThan(0);
    });

    test('REGRESSION: solo /patch triggers chat backup', async () => {
        const fetched = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        const res = await request(harness.app)
            .post('/api/chats/patch')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'c1',
                integrity: fetched.integrity,
                operations: [{ op: 'replace', path: '/0/mes', value: 'edited via patch' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'alice').length).toBeGreaterThan(0);
    });

    test('REGRESSION: solo /meta/patch triggers chat backup', async () => {
        const fetched = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        const res = await request(harness.app)
            .post('/api/chats/meta/patch')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'c1',
                integrity: fetched.integrity,
                operations: [{ op: 'add', path: '/theme', value: 'noir' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'alice').length).toBeGreaterThan(0);
    });

    test('REGRESSION: solo /state/patch triggers chat backup', async () => {
        const res = await request(harness.app)
            .post('/api/chats/state/patch')
            .send({
                avatar_url: 'Alice.png',
                file_name: 'c1',
                namespace: 'demo',
                operations: [{ op: 'add', path: '/k', value: 'v' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'alice').length).toBeGreaterThan(0);
    });

    test('REGRESSION: group /append triggers chat backup', async () => {
        const gid = 'gappend';
        await getChatRepo().save(harness.handle, '', gid, HEADER, MESSAGES, null,
            { isGroup: true, groupId: gid });
        const res = await request(harness.app)
            .post('/api/chats/group/append')
            .send({ id: gid, messages: [{ name: 'Bot', mes: 'group reply' }] });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'gappend').length).toBeGreaterThan(0);
    });

    test('REGRESSION: group /patch triggers chat backup', async () => {
        const gid = 'gpatch';
        await getChatRepo().save(harness.handle, '', gid, HEADER, MESSAGES, null,
            { isGroup: true, groupId: gid });
        const fetched = await getChatRepo().get(harness.handle, '', gid, { isGroup: true, groupId: gid });
        const res = await request(harness.app)
            .post('/api/chats/group/patch')
            .send({
                id: gid,
                integrity: fetched.integrity,
                operations: [{ op: 'replace', path: '/body/0/mes', value: 'group edit' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'gpatch').length).toBeGreaterThan(0);
    });

    test('REGRESSION: group /meta/patch triggers chat backup', async () => {
        const gid = 'gmeta';
        await getChatRepo().save(harness.handle, '', gid, HEADER, MESSAGES, null,
            { isGroup: true, groupId: gid });
        const fetched = await getChatRepo().get(harness.handle, '', gid, { isGroup: true, groupId: gid });
        const res = await request(harness.app)
            .post('/api/chats/group/meta/patch')
            .send({
                id: gid,
                integrity: fetched.integrity,
                operations: [{ op: 'add', path: '/theme', value: 'sunset' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'gmeta').length).toBeGreaterThan(0);
    });

    test('REGRESSION: group /state/patch triggers chat backup', async () => {
        const gid = 'gstate';
        await getChatRepo().save(harness.handle, '', gid, HEADER, MESSAGES, null,
            { isGroup: true, groupId: gid });
        const res = await request(harness.app)
            .post('/api/chats/state/patch')
            .send({
                is_group: true,
                id: gid,
                namespace: 'demo',
                operations: [{ op: 'add', path: '/k', value: 'v' }],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'gstate').length).toBeGreaterThan(0);
    });
});
