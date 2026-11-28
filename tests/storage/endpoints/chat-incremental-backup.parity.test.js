// Incremental chat mutations create real backup files in the owner's directory.
// Closing the endpoint fixture drains pending backups before releasing its data.

import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';
import { currentScopeForResources } from '../../harness/storage-scope.js';

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

    test('fixture cleanup writes the latest pending backup before releasing its data root', async () => {
        const directory = await currentScopeForResources().directory('retained chat backup observation');
        harness.dirs.backups = directory.path;
        for (const message of ['leading lifecycle reply', 'pending lifecycle reply']) {
            const current = await getChatRepo().get(harness.handle, 'Alice', 'c1');
            await request(harness.server).post('/api/chats/append').send({
                avatar_url: 'Alice.png', file_name: 'c1', integrity: current.integrity,
                messages: [{ name: 'Alice', mes: message }],
            }).expect(200);
        }
        const backupBytes = () => listBackupFiles(harness, 'alice').map(name => fs.readFileSync(path.join(directory.path, name), 'utf8')).join('\n');
        expect(backupBytes()).toContain('leading lifecycle reply');
        expect(backupBytes()).not.toContain('pending lifecycle reply');
        await harness.cleanup();
        expect(backupBytes()).toContain('pending lifecycle reply');
        expect(fs.existsSync(harness.dataRoot)).toBe(false);
    });

    test('REGRESSION: solo /append triggers chat backup', async () => {
        const fetched = await getChatRepo().get(harness.handle, 'Alice', 'c1');
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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

    test('REGRESSION: group /save triggers chat backup', async () => {
        const gid = 'gsave';
        const res = await request(harness.server)
            .post('/api/chats/group/save')
            .send({
                id: gid,
                chat: [HEADER, ...MESSAGES],
            });
        expect(res.status).toBe(200);
        expect(listBackupFiles(harness, 'gsave').length).toBeGreaterThan(0);
    });

    test('REGRESSION: group /append triggers chat backup', async () => {
        const gid = 'gappend';
        await getChatRepo().save(harness.handle, '', gid, HEADER, MESSAGES, null,
            { isGroup: true, groupId: gid });
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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
        const res = await request(harness.server)
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
