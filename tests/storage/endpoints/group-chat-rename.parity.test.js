/* eslint jest/no-conditional-expect: off -- Engine-specific inactive filesystem controls retain their complete oracles. */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter, invalidateRecentChatIndex, _resetChatBackupThrottlesForTests } from '../../../src/endpoints/chats.js';
import { router as groupsRouter } from '../../../src/endpoints/groups.js';
import { getChatRepo, getGroupRepo } from '../../../src/storage/index.js';
import { groupOptions as opts, seed, seedNative, ADMITTED_HEADERS, NATIVE_NUMBERS, insertNativeParent, insertNativeState, nativeSelected, numericPredicates, recordPayload, capture, expectMoved, disk, rawResources, chatPath, statePath, corruptDocument, onAsyncEntry, MESSAGES, HEADER } from '../harness/group-rename-fixtures.js';

test('required route engine rows are enabled', () => {
    expect(ENDPOINT_HARNESSES.map(h => h.mode)).toEqual(['fs', 'sqlite', 'mysql', 'postgres']);
    expect(process.execArgv.includes('--jitless')).toBe(process.env.LUKER_FORCE_JITLESS === '1');
});

describe.each(ENDPOINT_HARNESSES)('group rename route on $name', ({ mode }) => {
    let h;
    const rename = (old = 'old.jsonl', destination = 'new.jsonl') => request(h.server).post('/api/chats/rename').send({ is_group: true, original_file: old, renamed_file: destination });
    const get = id => {
        const token = randomUUID();
        return request(h.server).post('/api/chats/group/get').set('X-Rename-Fixture-Request', token).send({ id }).on('response', response => {
            recordPayload(h, 'selected route client response', { token, id, status: response.status, body: response.body, text: response.text, url: response.request.url });
        });
    };
    const recent = () => request(h.server).post('/api/chats/recent').send({});
    beforeEach(async () => {
        h = await makeEndpointHarness({ mode, mount: app => {
            app.use((req, res, next) => {
                res.once('finish', () => recordPayload(h, 'selected route server completion', { token: req.get('X-Rename-Fixture-Request'), url: req.originalUrl, status: res.statusCode, localPort: req.socket.localPort }));
                next();
            });
            app.use('/api/chats', chatsRouter); app.use('/api/groups', groupsRouter);
        } });
    });
    afterEach(async () => { _resetChatBackupThrottlesForTests(); if (h) await h.cleanup(); });

    test.each(NATIVE_NUMBERS)('route moves admitted %s native parent and state without JSON re-encoding after reopen', async (label, literal) => {
        const admitted = mode === 'mysql' && literal === '1e400' ? '7' : literal;
        await insertNativeParent(h, admitted);
        if (admitted !== literal) await expect(insertNativeState(h, 'overflow', literal)).rejects.toHaveProperty('code', 'ER_INVALID_JSON_TEXT');
        await insertNativeState(h, 'nested', `{ "number":${admitted}, "retained":[null,false,"渡口 🌙"] }\n`);
        await insertNativeState(h, 'root-number', admitted);
        const original = await capture(getChatRepo(), h, 'old'), native = await nativeSelected(h, 'old'), flags = numericPredicates(original);
        const selectedResponse = (await get('old').expect(200)).body;
        recordPayload(h, 'route native number capture', { label, literal, admitted, native, flags });
        expect((await rename().expect(200)).body).toEqual({ ok: true, sanitizedFileName: 'new' });
        const server = h.server, address = server.address();
        await h.reopenEngine();
        expect(h.server).toBe(server); expect(server.address()).toEqual(address);
        const actual = await capture(getChatRepo(), h, 'new'), moved = await nativeSelected(h, 'new'), movedFlags = numericPredicates(actual);
        recordPayload(h, 'route native number after reopen', { label, native: moved, flags: movedFlags, address });
        expect(moved).toEqual(native); expect(movedFlags).toEqual(flags); expectMoved(actual, original, mode);
        expect(await getChatRepo().get(h.handle, '', 'old', opts('old'))).toBeNull();
        expect(await getChatRepo().listStateNamespaces(h.handle, '', 'old', opts('old'))).toEqual([]);
        expect((await get('old').expect(200)).body).toEqual([]);
        expect((await get('new').expect(200)).body).toEqual(selectedResponse);
    });

    test.each(ADMITTED_HEADERS)('rename route preserves native %s header after actual engine reopen', async (_label, header) => {
        const original = await seedNative(getChatRepo(), h, header);
        const selectedBefore = (await get('old').expect(200)).body;
        expect((await rename().expect(200)).body).toEqual({ ok: true, sanitizedFileName: 'new' });
        await h.reopenEngine();
        expectMoved(await capture(getChatRepo(), h, 'new'), original, mode);
        expect((await get('new').expect(200)).body).toEqual(selectedBefore);
        expect((await get('old').expect(200)).body).toEqual([]);
        expect(await getChatRepo().listStateNamespaces(h.handle, '', 'old', opts('old'))).toEqual([]);
        expect((await getChatRepo().listAllGroupChats(h.handle)).map(entry => ({ name: entry.key.name, groupId: entry.key.groupId }))).toEqual([{ name: 'new', groupId: 'new' }]);
    });

    test('acknowledged rename resolves new address after reopen with complete payload and namespaces', async () => {
        const original = await seed(getChatRepo(), h);
        const response = await rename().expect(200);
        expect(response.body).toEqual({ ok: true, sanitizedFileName: 'new' });
        await h.reopenEngine();
        expect((await get('old').expect(200)).body).toEqual([]);
        expect((await get('new').expect(200)).body).toEqual([original.chat.header, ...original.chat.body]);
        expectMoved(await capture(getChatRepo(), h, 'new'), original, mode);
        expect((await getChatRepo().listAllGroupChats(h.handle)).map(e => ({ name: e.key.name, groupId: e.key.groupId }))).toEqual([{ name: 'new', groupId: 'new' }]);
    });

    test('warm and cold recent/history lookup keep UI owner separate from conversation routing', async () => {
        const original = await seed(getChatRepo(), h);
        const group = { id: 'definition', name: 'Ford Watch', members: [], chats: ['old'], chat_id: 'old', unknown: { kept: true } };
        await getGroupRepo().save(h.handle, group.id, group);
        expect((await recent().expect(200)).body).toEqual(expect.arrayContaining([expect.objectContaining({ file_id: 'old', group: group.id })]));
        await rename().expect(200);
        const warm = (await recent().expect(200)).body;
        expect(warm.map(e => e.file_id)).toEqual(['new']); expect(warm[0].group).toBe(group.id);
        // This is the real acknowledged frontend consumer's next route, not a repository repair of definition IDs.
        await request(h.server).post('/api/groups/edit').send({ ...group, chats: ['new'], chat_id: 'new' }).expect(200);
        await h.reopenEngine();
        expect((await request(h.server).post('/api/chats/group/info').send({ id: 'new' }).expect(200)).body.file_name).toBe('new.jsonl');
        const history = (await request(h.server).post('/api/chats/search').send({ group_id: group.id, query: '' }).expect(200)).body;
        expect(history.map(e => e.file_name)).toEqual(['new.jsonl']);
        const loaded = await getGroupRepo().get(h.handle, group.id);
        expect(loaded).toMatchObject({ ...group, chats: ['new'], chat_id: 'new' });
        expectMoved(await capture(getChatRepo(), h, 'new'), original, mode);
        await invalidateRecentChatIndex({ user: { profile: { handle: h.handle }, directories: h.dirs } });
        const cold = await request(h.server).post('/api/chats/recent').send({});
        expect(cold.body.map(e => e.file_id)).toEqual(['new']);
    });

    test.each([
        ['old.jsonl.jsonl', 'new.jsonl.jsonl', 'new'],
        ['old', 'v1.2', 'v1.2'],
        ['old.jsonl', 'new?name.jsonl', 'newname'],
    ])('sanitizes %s → %s without changing payload', async (source, destination, actual) => {
        const original = await seed(getChatRepo(), h);
        expect((await rename(source, destination).expect(200)).body.sanitizedFileName).toBe(actual);
        expectMoved(await capture(getChatRepo(), h, actual), original, mode);
    });

    test.each(['old.jsonl', 'o?ld.jsonl', 'occupied.jsonl'])('refused %s preserves complete source/destination and namespaces', async destination => {
        await seed(getChatRepo(), h); await seed(getChatRepo(), h, 'occupied');
        const before = await capture(getChatRepo(), h, 'old'), other = await capture(getChatRepo(), h, 'occupied'), bytes = disk(h);
        await rename('old.jsonl', destination).expect(400);
        expect(await capture(getChatRepo(), h, 'old')).toEqual(before); expect(await capture(getChatRepo(), h, 'occupied')).toEqual(other); expect(disk(h)).toEqual(bytes);
    });

    test('missing source remains the existing missing contract', async () => {
        await rename().expect(400);
        expect(await getChatRepo().listAllGroupChats(h.handle)).toEqual([]);
    });

    test('malformed destination remains occupied and is never overwritten', async () => {
        await seed(getChatRepo(), h); await seed(getChatRepo(), h, 'new'); await corruptDocument(h, 'new');
        const before = await capture(getChatRepo(), h, 'old'), bytes = await rawResources(h);
        await rename().expect(400);
        expect(await capture(getChatRepo(), h, 'old')).toEqual(before); expect(await rawResources(h)).toEqual(bytes);
    });

    test('malformed source is explicit HTTP500 rather than missing or successful copy', async () => {
        await seed(getChatRepo(), h); await corruptDocument(h, 'old'); const bytes = await rawResources(h);
        await rename().expect(500);
        expect((await getChatRepo().listAllGroupChats(h.handle)).map(e => e.key.name)).toEqual(['old']); expect(await rawResources(h)).toEqual(bytes);
    });

    test('genuine destination created after route preflight refuses transaction and retains source', async () => {
        const original = await seed(getChatRepo(), h);
        // No core method is mocked: observe entry and issue a real concurrent engine write.
        const settle = onAsyncEntry('ChatRepo.rename', () => getChatRepo().save(h.handle, '', 'new', { ...HEADER, competing: true }, MESSAGES, null, opts('new')));
        try { await rename().expect(409); } finally { await settle(); }
        expect(await capture(getChatRepo(), h, 'old')).toEqual(original);
        const target = await getChatRepo().get(h.handle, '', 'new', opts('new'));
        expect(target.header).toEqual({ ...HEADER, competing: true, chat_metadata: { ...HEADER.chat_metadata, integrity: target.integrity } });
        expect(target.body).toEqual(MESSAGES);
    });

    test('new-address append and snapshot consumers preserve full conversation and namespaces', async () => {
        const original = await seed(getChatRepo(), h);
        await rename().expect(200);
        const tail = { name: 'User', is_user: true, mes: 'After the rename: 渡口 🌙', extra: { gen_id: 'tail' } };
        const response = await request(h.server).post('/api/chats/group/append').send({ id: 'new', messages: [tail], integrity: original.chat.integrity }).expect(200);
        const after = await capture(getChatRepo(), h, 'new');
        expect(after.chat.body).toEqual([...MESSAGES, tail]); expect(after.states).toEqual(original.states);
        expect(after.chat.integrity).toBe(response.body.integrity);
        expect((await get('new').expect(200)).body).toEqual([after.chat.header, ...after.chat.body]);
    });

    test('SQL rename never moves inactive filesystem-era sidecars', async () => {
        const original = await seed(getChatRepo(), h);
        if (mode !== 'fs') fs.writeFileSync(statePath(h, 'old', 'inactive'), '{"preserved":"inactive"}');
        const inactive = mode === 'fs' ? null : fs.readFileSync(statePath(h, 'old', 'inactive'));
        await rename().expect(200);
        expectMoved(await capture(getChatRepo(), h, 'new'), original, mode);
        if (mode !== 'fs') {
            expect(fs.readFileSync(statePath(h, 'old', 'inactive'))).toEqual(inactive);
            expect(fs.existsSync(statePath(h, 'new', 'inactive'))).toBe(false);
        }
    });
});

describe('filesystem route prevalidation', () => {
    let h;
    beforeEach(async () => { h = await makeEndpointHarness({ mode: 'fs', mount: app => app.use('/api/chats', chatsRouter) }); await seed(getChatRepo(), h); });
    afterEach(async () => h.cleanup());

    test.each(['memory_graph', 'late-unrelated'])('actual state/patch %s orphan after empty inventory prevents conditional parent publication', async namespace => {
        const repo = getChatRepo(), original = await capture(repo, h, 'old');
        const key = { kind: 'chat', handle: h.handle, charDir: '', name: 'new', ...opts('new') };
        expect(await repo.exists(h.handle, '', 'new', opts('new'))).toBe(false);
        expect(await repo.listStateNamespaces(h.handle, '', 'new', opts('new'))).toEqual([]);
        const value = { retained: ['渡口', null, false], nested: { revision: 7 } };
        const response = await request(h.server).post('/api/chats/state/patch').send({
            is_group: true, id: 'new', namespace, operations: [{ op: 'add', path: '/owned', value }],
        }).expect(200);
        expect(response.body).toEqual({ ok: true, applied: 1, created: true });
        expect(await repo.exists(h.handle, '', 'new', opts('new'))).toBe(false);
        expect(await repo.getState(h.handle, '', 'new', namespace, opts('new'))).toEqual({ owned: value });
        const beforePublication = disk(h);
        expect(await h.engine.withTransaction(h.handle, tx => tx.putResourceIfMatch(key, null, original.chat))).toEqual({ updated: false });
        expect(disk(h)).toEqual(beforePublication);
        await h.reopenEngine();
        expect(await capture(getChatRepo(), h, 'old')).toEqual(original);
        expect(await getChatRepo().exists(h.handle, '', 'new', opts('new'))).toBe(false);
        expect(await getChatRepo().listStateNamespaces(h.handle, '', 'new', opts('new'))).toEqual([namespace]);
        expect(await getChatRepo().getState(h.handle, '', 'new', namespace, opts('new'))).toEqual({ owned: value });
        expect(disk(h)).toEqual(beforePublication);
    });

    test.each(['malformed-state', 'linked-source', 'directory-source', 'orphan-destination-state', 'linked-destination'])('%s retains actual bytes on refusal', async kind => {
        if (kind === 'malformed-state') fs.writeFileSync(statePath(h, 'old', 'zz-corrupt'), '{"private":"PRIVATE_PAYLOAD",');
        if (kind.endsWith('source')) {
            const outside = path.join(h.dataRoot, 'external.jsonl'); fs.copyFileSync(chatPath(h, 'old'), outside); fs.unlinkSync(chatPath(h, 'old'));
            if (kind === 'linked-source') fs.symlinkSync(outside, chatPath(h, 'old')); else fs.mkdirSync(chatPath(h, 'old'));
        }
        if (kind === 'orphan-destination-state') fs.writeFileSync(statePath(h, 'new', 'unrelated'), '{"private":"PRIVATE_PAYLOAD",');
        if (kind === 'linked-destination') fs.symlinkSync(path.join(h.dataRoot, 'missing'), chatPath(h, 'new'));
        const bytes = disk(h);
        const expected = kind === 'linked-destination' ? 400 : kind === 'orphan-destination-state' ? 409 : 500;
        await request(h.server).post('/api/chats/rename').send({ is_group: true, original_file: 'old', renamed_file: 'new' }).expect(expected);
        expect(disk(h)).toEqual(bytes);
    });
});
