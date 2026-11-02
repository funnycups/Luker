/* eslint jest/no-conditional-expect: off -- Native admission is qualified per actual engine before the rename oracle. */
import fs from 'node:fs';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { ConflictError } from '../../../src/storage/errors.js';
import { CONTRACT_HARNESSES, makeTempFsEngineHarness } from '../harness/contract-harness.js';
import { groupOptions, NATIVE_NUMBERS, insertNativeParent, insertNativeState, nativeSelected, numericPredicates, capture, expectMoved, recordPayload, onAsyncEntry, seed, disk, chatPath, statePath } from '../harness/group-rename-fixtures.js';

const key = (h, name) => ({ kind: 'chat', handle: h.handle, charDir: '', name, ...groupOptions(name) });

describe.each(CONTRACT_HARNESSES)('native chat move on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => { h = await make(); repo = new ChatRepo({ engine: h.engine }); await h.engine.ping(h.handle); });
    afterEach(async () => { if (h) await h.cleanup(); });

    test.each(NATIVE_NUMBERS)('%s parent and namespace values retain their admitted native representation', async (label, literal) => {
        const rejection = await insertNativeParent(h, literal).then(() => null, error => error);
        recordPayload(h, 'native parent admission', { label, literal, rejection: rejection && { code: rejection.code, errno: rejection.errno } });
        if (h.engine.kind === 'mysql' && literal === '1e400') {
            expect(rejection?.code).toBe('ER_INVALID_JSON_TEXT');
            expect(await repo.exists(h.handle, '', 'old', groupOptions('old'))).toBe(false);
            await insertNativeParent(h, '7');
            const before = await nativeSelected(h, 'old');
            const stateRejection = await insertNativeState(h, 'overflow', literal).then(() => null, error => error);
            recordPayload(h, 'native state admission', { label, literal, rejection: stateRejection && { code: stateRejection.code, errno: stateRejection.errno } });
            expect(stateRejection?.code).toBe('ER_INVALID_JSON_TEXT');
            expect(await nativeSelected(h, 'old')).toEqual(before);
            return;
        }
        expect(rejection).toBeNull();
        await insertNativeState(h, 'nested', `{ "number":${literal}, "retained":[null,false,"渡口 🌙"], "duplicate":"discarded", "duplicate":"selected" }\n`);
        await insertNativeState(h, 'root-number', `${literal}\n`);
        const original = await capture(repo, h, 'old'), native = await nativeSelected(h, 'old'), flags = numericPredicates(original);
        recordPayload(h, 'native admitted number oracle', { label, literal, native, flags });
        const negativeZero = literal === '-0' && ['fs', 'sqlite'].includes(h.engine.kind);
        const positiveInfinity = literal === '1e400';
        for (const observed of [flags.header, flags.metadata, flags.message, ...flags.states.map(([, value]) => value)]) {
            expect(observed.negativeZero).toBe(negativeZero);
            expect(observed.positiveInfinity).toBe(positiveInfinity);
            expect(observed.type).toBe('number');
        }
        await repo.rename(h.handle, '', 'old', 'new', groupOptions('old'));
        const actual = await capture(repo, h, 'new'), movedNative = await nativeSelected(h, 'new'), movedFlags = numericPredicates(actual);
        recordPayload(h, 'native moved number oracle', { label, literal, native: movedNative, flags: movedFlags });
        expect(movedNative).toEqual(native);
        expect(movedFlags).toEqual(flags);
        expectMoved(actual, original, h.engine.kind);
        expect(await repo.get(h.handle, '', 'old', groupOptions('old'))).toBeNull();
        expect(await repo.listStateNamespaces(h.handle, '', 'old', groupOptions('old'))).toEqual([]);
        expect(Reflect.ownKeys(actual.chat).sort()).toEqual(['body', 'createdAt', 'header', 'integrity', 'key', 'updatedAt']);
    });

    test.each(['parent', 'state', 'added namespace', 'removed namespace'])('source deletion refuses an uncopied same-transaction %s change', async mutation => {
        const original = await seed(repo, h);
        await h.engine.withTransaction(h.handle, async tx => {
            const snapshot = await tx.captureChatMove(key(h, 'old'));
            expect(Reflect.ownKeys(snapshot)).toEqual([]);
            expect(Object.isFrozen(snapshot)).toBe(true);
            expect(await tx.publishChatMove(key(h, 'new'), snapshot)).toEqual({ updated: true });
            if (mutation === 'parent') await tx.putResource(key(h, 'old'), { ...original.chat, body: [...original.chat.body, { mes: 'uncopied parent content' }] });
            if (mutation === 'state') await tx.putChatState(key(h, 'old'), 'memory_graph', { retained: 'uncopied replacement state' });
            if (mutation === 'added namespace') await tx.putChatState(key(h, 'old'), 'late-source-state', { retained: 'uncopied new state' });
            if (mutation === 'removed namespace') await tx.deleteChatState(key(h, 'old'), 'memory_graph');
            await expect(tx.deleteChatMoveSource(snapshot)).rejects.toThrow(ConflictError);
            expect(await tx.hasChatResource(key(h, 'old'))).toBe(true);
        });
        const source = await capture(repo, h, 'old');
        expectMoved(await capture(repo, h, 'new'), original, h.engine.kind);
        if (mutation === 'parent') expect(source.chat.body).toEqual([...original.chat.body, { mes: 'uncopied parent content' }]);
        if (mutation === 'state') expect(source.states).toContainEqual(['memory_graph', { retained: 'uncopied replacement state' }]);
        if (mutation === 'added namespace') expect(source.states).toContainEqual(['late-source-state', { retained: 'uncopied new state' }]);
        if (mutation === 'removed namespace') expect(source.states.map(([ns]) => ns)).not.toContain('memory_graph');
    });
});

describe('filesystem selected snapshot lifetime', () => {
    let h, repo;
    beforeEach(async () => { h = await makeTempFsEngineHarness(); repo = new ChatRepo({ engine: h.engine }); await seed(repo, h); });
    afterEach(async () => h.cleanup());

    test.each(['parent', 'state', 'added namespace', 'removed namespace'])('repository snapshot deletion refuses a late uncopied %s change', async mutation => {
        let beforeDeletion;
        const settle = onAsyncEntry('FsTransaction.deleteChatMoveSource', () => {
            if (mutation === 'parent') fs.appendFileSync(chatPath(h, 'old'), '{"mes":"uncopied parent"}\n');
            if (mutation === 'state') fs.writeFileSync(statePath(h, 'old', 'memory_graph'), '{"uncopied":"state"}');
            if (mutation === 'added namespace') fs.writeFileSync(statePath(h, 'old', 'late-source-state'), '{"uncopied":"namespace"}');
            if (mutation === 'removed namespace') fs.unlinkSync(statePath(h, 'old', 'memory_graph'));
            beforeDeletion = disk(h);
        });
        try { await expect(repo.rename(h.handle, '', 'old', 'new', groupOptions('old'))).rejects.toThrow(ConflictError); }
        finally { await settle(); }
        expect(disk(h)).toEqual(beforeDeletion);
        expect(await repo.exists(h.handle, '', 'old', groupOptions('old'))).toBe(true);
    });

    test.each(['parent bytes', 'parent identity', 'state bytes', 'state identity', 'added namespace', 'removed namespace'])('%s change before publication cannot authorize a move', async mutation => {
        await h.engine.withTransaction(h.handle, async tx => {
            const snapshot = await tx.captureChatMove(key(h, 'old'));
            if (mutation === 'parent bytes') fs.appendFileSync(chatPath(h, 'old'), '{"mes":"uncopied"}\n');
            if (mutation === 'state bytes') fs.writeFileSync(statePath(h, 'old', 'memory_graph'), '{"uncopied":true}');
            if (mutation.endsWith('identity')) {
                const file = mutation.startsWith('parent') ? chatPath(h, 'old') : statePath(h, 'old', 'memory_graph');
                fs.writeFileSync(`${file}.replacement`, fs.readFileSync(file)); fs.renameSync(`${file}.replacement`, file);
            }
            if (mutation === 'added namespace') fs.writeFileSync(statePath(h, 'old', 'late-source'), '{"uncopied":true}');
            if (mutation === 'removed namespace') fs.unlinkSync(statePath(h, 'old', 'memory_graph'));
            const before = disk(h);
            await expect(tx.publishChatMove(key(h, 'new'), snapshot)).rejects.toThrow(ConflictError);
            expect(disk(h)).toEqual(before);
            expect(await tx.hasChatResource(key(h, 'new'))).toBe(false);
        });
    });

    test('unrepresentable native namespace mapping retains the source without claiming a parent', async () => {
        const original = await capture(repo, h, 'old');
        await h.engine.withTransaction(h.handle, async tx => {
            const snapshot = await tx.captureChatMove(key(h, 'old'));
            // Both selected source namespaces fit; the requested destination state does not.
            const destination = 'n'.repeat(240);
            await expect(tx.publishChatMove(key(h, destination), snapshot)).rejects.toThrow();
        });
        expect(await capture(repo, h, 'old')).toEqual(original);
        expect(fs.existsSync(chatPath(h, 'n'.repeat(240)))).toBe(false);
    });
});
