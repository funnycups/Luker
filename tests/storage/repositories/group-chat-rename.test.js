/* eslint jest/no-conditional-expect: off -- Observed native inode identity determines the complete alias and distinct-name contracts. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { ConflictError, NotFoundError } from '../../../src/storage/errors.js';
import { CONTRACT_HARNESSES, makeTempFsEngineHarness, makeTempSqliteEngineHarness } from '../harness/contract-harness.js';
import { groupOptions as opts, seed, seedNative, ADMITTED_HEADERS, NATIVE_STATE_SPELLINGS, sameNativeEntry, capture, expectMoved, disk, rawResources, chatPath, statePath, corruptDocument, onAsyncEntry, recordPayload, HEADER, MESSAGES, STATES } from '../harness/group-rename-fixtures.js';
import { createRealFilesystemFixture } from '../../sync/_lib/real-filesystems.js';

test('required rename engine rows are enabled in the actual runtime', () => {
    expect(CONTRACT_HARNESSES.map(h => h.name)).toEqual(['FsEngine', 'SqliteEngine', 'MysqlEngine', 'PgEngine']);
    expect(process.execArgv.includes('--jitless')).toBe(process.env.LUKER_FORCE_JITLESS === '1');
});

describe.each(CONTRACT_HARNESSES)('group rename repository on $name', ({ make }) => {
    let h, repo;
    beforeEach(async () => { h = await make(); repo = new ChatRepo({ engine: h.engine }); await h.engine.ping(h.handle); });
    afterEach(async () => { if (h) await h.cleanup(); });

    test.each(ADMITTED_HEADERS)('native %s header is copied exactly without ordinary save normalization', async (_label, header) => {
        const original = await seedNative(repo, h, header);
        await repo.rename(h.handle, '', 'old', 'new', opts('old'));
        expect(await repo.get(h.handle, '', 'old', opts('old'))).toBeNull();
        expect(await repo.listStateNamespaces(h.handle, '', 'old', opts('old'))).toEqual([]);
        expectMoved(await capture(repo, h, 'new'), original, h.kind);
        expect((await repo.listAllGroupChats(h.handle)).map(entry => entry.key)).toEqual([
            expect.objectContaining({ name: 'new', groupId: 'new' }),
        ]);
        repo = new ChatRepo({ engine: h.engine });
        expectMoved(await capture(repo, h, 'new'), original, h.kind);
    });

    test('ordinary save append patch and metadata writes continue inserting and rotating integrity', async () => {
        const saved = await repo.save(h.handle, '', 'old', { retained: true }, MESSAGES, null, opts('old'));
        const appended = await repo.append(h.handle, '', 'old', [{ mes: 'tail' }], saved.integrity, opts('old'));
        const patched = await repo.patch(h.handle, '', 'old', [{ op: 'add', path: '/header/extra', value: 'retained' }], appended.integrity, opts('old'));
        const metadata = await repo.updateChatMetadata(h.handle, '', 'old', { note: 'retained' }, patched.integrity, opts('old'));
        expect(new Set([saved.integrity, appended.integrity, patched.integrity, metadata.integrity]).size).toBe(4);
        const actual = await repo.get(h.handle, '', 'old', opts('old'));
        expect(actual.header).toEqual({ retained: true, extra: 'retained', chat_metadata: { integrity: metadata.integrity, note: 'retained' } });
        expect(actual.integrity).toBe(metadata.integrity);
        expect(actual.body).toEqual([...MESSAGES, { mes: 'tail' }]);
    });

    test.each(['explicit', 'omitted'])('%s source routing moves full conversation and all JSON namespace values', async routing => {
        const original = await seed(repo, h);
        await repo.rename(h.handle, '', 'old', 'new', routing === 'explicit' ? opts('old') : { isGroup: true });
        expect(await repo.get(h.handle, '', 'old', opts('old'))).toBeNull();
        expect(await repo.listStateNamespaces(h.handle, '', 'old', opts('old'))).toEqual([]);
        expectMoved(await capture(repo, h, 'new'), original, h.kind);
        const inventory = await repo.listAllGroupChats(h.handle);
        expect(inventory.map(e => ({ name: e.key.name, groupId: e.key.groupId }))).toEqual([{ name: 'new', groupId: 'new' }]);
        repo = new ChatRepo({ engine: h.engine });
        expectMoved(await capture(repo, h, 'new'), original, h.kind);
    });

    test('source routing is independent of source display name and never attached to destination', async () => {
        const original = await seed(repo, h, 'label', opts('source-route'));
        await repo.rename(h.handle, '', 'label', 'new', opts('source-route'));
        expect(await repo.get(h.handle, '', 'label', opts('source-route'))).toBeNull();
        expectMoved(await capture(repo, h, 'new'), original, h.kind);
        expect((await repo.listAllGroupChats(h.handle)).map(e => e.key.groupId)).toEqual(['new']);
    });

    test('missing source is NotFound and does not claim any destination', async () => {
        await expect(repo.rename(h.handle, '', 'missing', 'new', opts('missing'))).rejects.toThrow(NotFoundError);
        expect(await repo.listAllGroupChats(h.handle)).toEqual([]);
    });

    test.each(['old', 'occupied'])('structurally occupied %s refuses without modifying either full resource', async destination => {
        await seed(repo, h);
        if (destination !== 'old') await seed(repo, h, destination);
        const before = await capture(repo, h, 'old'), target = await capture(repo, h, destination), bytes = disk(h);
        await expect(repo.rename(h.handle, '', 'old', destination, opts('old'))).rejects.toThrow(ConflictError);
        expect(await capture(repo, h, 'old')).toEqual(before);
        expect(await capture(repo, h, destination)).toEqual(target);
        expect(disk(h)).toEqual(bytes);
    });

    test('malformed occupied destination is structural presence, never overwrite authority', async () => {
        await seed(repo, h); await seed(repo, h, 'new'); await corruptDocument(h, 'new');
        const original = await capture(repo, h, 'old'), bytes = await rawResources(h);
        expect(await repo.exists(h.handle, '', 'new', opts('new'))).toBe(true);
        await expect(repo.rename(h.handle, '', 'old', 'new', opts('old'))).rejects.toThrow(ConflictError);
        expect(await capture(repo, h, 'old')).toEqual(original);
        expect(await rawResources(h)).toEqual(bytes);
    });

    test('occupied unreadable source errors explicitly without claiming the destination', async () => {
        await seed(repo, h); await corruptDocument(h, 'old'); const bytes = await rawResources(h);
        expect(await repo.exists(h.handle, '', 'old', opts('old'))).toBe(true);
        const error = await repo.rename(h.handle, '', 'old', 'new', opts('old')).then(() => null, e => e);
        expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(NotFoundError);
        expect(error.message).not.toContain('PRIVATE_PAYLOAD'); expect(error.cause).toBeUndefined();
        expect((await repo.listAllGroupChats(h.handle)).map(e => e.key.name)).toEqual(['old']);
        expect(await rawResources(h)).toEqual(bytes);
    });

    test('new identity remains writable with rotated integrity and complete state after edits', async () => {
        const original = await seed(repo, h);
        await repo.rename(h.handle, '', 'old', 'new', opts('old'));
        const edited = { ...MESSAGES[0], mes: 'Edited after rename', extra: { ...MESSAGES[0].extra, edited: true } };
        const patch = await repo.patch(h.handle, '', 'new', [{ op: 'replace', path: '/body/0', value: edited }], original.chat.integrity, opts('new'));
        const tail = { name: 'User', is_user: true, mes: 'Append after rename', extra: { gen_id: 'new-generation' } };
        await repo.append(h.handle, '', 'new', [tail], patch.integrity, opts('new'));
        const after = await capture(repo, h, 'new');
        expect(after.chat.body).toEqual([edited, MESSAGES[1], tail]);
        expect(after.chat.header.unknown_header).toEqual(HEADER.unknown_header);
        expect(after.chat.integrity).not.toBe(patch.integrity); expect(after.states).toEqual(original.states);
    });

    test('all namespace records round-trip without scalar coercion or prototype aliases', async () => {
        await seed(repo, h);
        expect((await capture(repo, h, 'old')).states).toEqual([...STATES].sort(([a], [b]) => a < b ? -1 : 1));
    });

    test('conditional publication cannot replace a structurally occupied invalid document', async () => {
        const original = await seed(repo, h), key = { kind: 'chat', handle: h.handle, charDir: '', name: 'new', ...opts('new') };
        expect(await repo.exists(h.handle, '', 'new', opts('new'))).toBe(false);
        await seed(repo, h, 'new'); await corruptDocument(h, 'new'); const before = await rawResources(h);
        expect(await h.engine.withTransaction(h.handle, tx => tx.putResourceIfMatch(key, null, original.chat))).toEqual({ updated: false });
        expect(await rawResources(h)).toEqual(before);
        await expect(repo.get(h.handle, '', 'new', opts('new'))).rejects.toThrow();
        expect(await capture(repo, h, 'old')).toEqual(original);
    });

    test('conditional namespace publication retains the occupied value instead of upserting', async () => {
        await seed(repo, h); const before = await capture(repo, h, 'old'), bytes = disk(h);
        const key = { kind: 'chat', handle: h.handle, charDir: '', name: 'old', ...opts('old') };
        await expect(h.engine.withTransaction(h.handle, tx => tx.putChatState(key, 'null-state', { replacement: true }, { ifAbsent: true }))).rejects.toThrow(ConflictError);
        expect(await capture(repo, h, 'old')).toEqual(before); expect(disk(h)).toEqual(bytes);
    });
});

describe('filesystem group rename unsafe/occupied entry family', () => {
    let h, repo;
    beforeEach(async () => { h = await makeTempFsEngineHarness(); repo = new ChatRepo({ engine: h.engine }); await seed(repo, h); });
    afterEach(async () => h.cleanup());

    test.each(['malformed', 'null-header', 'empty', 'malformed-body', 'directory', 'symlink', 'dangling-link'])('rejects %s source with safe diagnostics before mutation', async kind => {
        const source = chatPath(h, 'old'), outside = path.join(h.dataRoot, 'outside.jsonl');
        fs.copyFileSync(source, outside);
        if (kind === 'malformed') fs.writeFileSync(source, '{"private":"PRIVATE_PAYLOAD",');
        if (kind === 'null-header') fs.writeFileSync(source, 'null\n');
        if (kind === 'empty') fs.writeFileSync(source, '');
        if (kind === 'malformed-body') fs.appendFileSync(source, '{"private":"PRIVATE_PAYLOAD",\n');
        if (['directory', 'symlink', 'dangling-link'].includes(kind)) {
            fs.unlinkSync(source);
            if (kind === 'directory') fs.mkdirSync(source);
            else fs.symlinkSync(kind === 'symlink' ? outside : `${outside}-missing`, source);
        }
        const before = disk(h), external = fs.readFileSync(outside);
        const error = await repo.rename(h.handle, '', 'old', 'new', { isGroup: true }).then(() => null, e => e);
        expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(NotFoundError);
        expect(error.message).toContain('old.jsonl'); expect(error.message).not.toContain('PRIVATE_PAYLOAD'); expect(error.cause).toBeUndefined();
        expect(disk(h)).toEqual(before); expect(fs.readFileSync(outside)).toEqual(external);
    });

    test.each(['malformed', 'directory', 'symlink', 'dangling-link'])('validates all source namespaces including %s state before writes', async kind => {
        const file = statePath(h, 'old', 'zz-last'), outside = path.join(h.dataRoot, 'external-state.json');
        fs.writeFileSync(outside, '{"private":"PRIVATE_PAYLOAD"}');
        if (kind === 'malformed') fs.writeFileSync(file, '{"private":"PRIVATE_PAYLOAD",');
        if (kind === 'directory') fs.mkdirSync(file);
        if (kind.includes('link')) fs.symlinkSync(kind === 'symlink' ? outside : `${outside}-missing`, file);
        const before = disk(h);
        const error = await repo.rename(h.handle, '', 'old', 'new', { isGroup: true }).then(() => null, e => e);
        expect(error).toBeInstanceOf(Error); expect(error.message).toContain('zz-last');
        expect(error.message).not.toContain('PRIVATE_PAYLOAD'); expect(error.cause).toBeUndefined(); expect(disk(h)).toEqual(before);
    });

    test.each(['directory', 'symlink', 'dangling-link', 'orphan-state', 'orphan-malformed-state', 'orphan-state-directory'])('refuses %s destination without reading or overwriting it', async kind => {
        const target = chatPath(h, 'new');
        if (kind === 'directory') fs.mkdirSync(target);
        if (kind.includes('link')) fs.symlinkSync(kind === 'symlink' ? chatPath(h, 'old') : `${target}-missing`, target);
        if (kind.startsWith('orphan')) {
            const file = statePath(h, 'new', 'unrelated');
            if (kind.endsWith('directory')) fs.mkdirSync(file);
            else fs.writeFileSync(file, kind === 'orphan-state' ? 'null' : '{"private":"PRIVATE_PAYLOAD",');
        }
        const before = disk(h);
        await expect(repo.rename(h.handle, '', 'old', 'new', { isGroup: true })).rejects.toThrow(ConflictError);
        expect(disk(h)).toEqual(before);
    });

    test('native parent identity determines alias refusal or distinct-name success', async () => {
        const alias = sameNativeEntry(chatPath(h, 'old'), chatPath(h, 'OLD'));
        const before = disk(h), original = await capture(repo, h, 'old');
        if (alias) {
            await expect(repo.rename(h.handle, '', 'old', 'OLD', opts('old'))).rejects.toThrow(ConflictError);
            expect(disk(h)).toEqual(before);
            expect(await capture(repo, h, 'old')).toEqual(original);
        } else {
            await repo.rename(h.handle, '', 'old', 'OLD', opts('old'));
            expectMoved(await capture(repo, h, 'OLD'), original, 'fs');
            expect(await repo.get(h.handle, '', 'old', opts('old'))).toBeNull();
            expect((await repo.listAllGroupChats(h.handle)).map(entry => entry.key.name)).toEqual(['OLD']);
        }
    });

    test('orphan state base aliases are occupied through native lookup without changing spelling', async () => {
        const file = statePath(h, 'NEW', 'unrelated');
        fs.writeFileSync(file, 'null'); const before = disk(h), original = await capture(repo, h, 'old');
        if (sameNativeEntry(file, statePath(h, 'new', 'unrelated'))) {
            await expect(repo.rename(h.handle, '', 'old', 'new', opts('old'))).rejects.toThrow(ConflictError);
            expect(disk(h)).toEqual(before);
        } else {
            await repo.rename(h.handle, '', 'old', 'new', opts('old'));
            expectMoved(await capture(repo, h, 'new'), original, 'fs');
            expect(disk(h)[path.basename(file)]).toEqual(before[path.basename(file)]);
            expect(await repo.getState(h.handle, '', 'new', 'unrelated', opts('new'))).toBeNull();
        }
    });

    test('non-ENOENT structural I/O error is visible instead of absent', async () => {
        const nonDirectory = path.join(h.dirs.chats, 'not-directory'); fs.writeFileSync(nonDirectory, 'retained');
        await expect(repo.exists(h.handle, 'not-directory', 'new')).rejects.toThrow();
        expect(fs.readFileSync(nonDirectory, 'utf8')).toBe('retained');
    });

    test('unreadable owned state preserves every source byte before any writes', async () => {
        const file = statePath(h, 'old', 'memory_graph'), before = disk(h);
        fs.chmodSync(file, 0o000);
        try { await expect(repo.rename(h.handle, '', 'old', 'new', { isGroup: true })).rejects.toThrow(/memory_graph/); }
        finally { fs.chmodSync(file, 0o600); }
        expect(disk(h)).toEqual(before);
    });

    test('real publication I/O failure stays visible and never deletes the intact source', async () => {
        const original = await capture(repo, h, 'old'), before = disk(h);
        fs.chmodSync(h.dirs.groupChats, 0o500);
        try { await expect(repo.rename(h.handle, '', 'old', 'new', { isGroup: true })).rejects.toThrow(); }
        finally { fs.chmodSync(h.dirs.groupChats, 0o700); }
        expect(await capture(repo, h, 'old')).toEqual(original); expect(disk(h)).toEqual(before);
    });

    test('linked ancestor cannot authorize a source read outside its chat location', async () => {
        const outside = path.join(h.dataRoot, 'external-chats'); fs.mkdirSync(outside);
        const original = fs.readFileSync(chatPath(h, 'old')); fs.writeFileSync(path.join(outside, 'source.jsonl'), original);
        fs.symlinkSync(outside, path.join(h.dirs.chats, 'linked'));
        await expect(repo.rename(h.handle, 'linked', 'source', 'new')).rejects.toThrow(/symbolic links/);
        expect(fs.readFileSync(path.join(outside, 'source.jsonl'))).toEqual(original); expect(fs.existsSync(path.join(outside, 'new.jsonl'))).toBe(false);
    });

    test('actual parent publication refuses a destination created after the final structural check', async () => {
        const original = await capture(repo, h, 'old'), before = disk(h);
        const settle = onAsyncEntry('FsTransaction.publishChatMove', () => fs.writeFileSync(chatPath(h, 'new'), 'late occupied PRIVATE_PAYLOAD'));
        try { await expect(repo.rename(h.handle, '', 'old', 'new', opts('old'))).rejects.toThrow(ConflictError); }
        finally { await settle(); }
        expect(await capture(repo, h, 'old')).toEqual(original);
        expect(fs.readFileSync(chatPath(h, 'new'), 'utf8')).toBe('late occupied PRIVATE_PAYLOAD');
        expect(Object.fromEntries(Object.entries(disk(h)).filter(([name]) => name !== 'new.jsonl'))).toEqual(before);
    });

    test.each(['memory_graph', 'late-unrelated'])('late %s orphan refuses parent publication and retains complete resources', async namespace => {
        const original = await capture(repo, h, 'old');
        let beforePublication;
        const settle = onAsyncEntry('FsTransaction.publishChatMove', () => {
            fs.mkdirSync(statePath(h, 'new', namespace));
            beforePublication = disk(h);
        });
        try { await expect(repo.rename(h.handle, '', 'old', 'new', opts('old'))).rejects.toThrow(ConflictError); }
        finally { await settle(); }
        expect(await capture(repo, h, 'old')).toEqual(original);
        expect(disk(h)).toEqual(beforePublication);
        expect(await repo.exists(h.handle, '', 'new', opts('new'))).toBe(false);
    });

    test('JSON null remains a value distinct from malformed state', async () => {
        expect(await repo.getState(h.handle, '', 'old', 'null-state', opts('old'))).toBeNull();
        for (const [ns, value] of STATES) expect(await repo.getState(h.handle, '', 'old', ns, opts('old'))).toEqual(value);
    });

    test('native namespace proposals preserve unrelated representable long filenames', async () => {
        const source = 's'.repeat(180), original = await seed(repo, h, source);
        const file = statePath(h, 'independent', 'n'.repeat(220));
        fs.writeFileSync(file, JSON.stringify({ retained: ['渡口', null, false] }));
        const before = disk(h), neighbor = await capture(repo, h, 'old');
        await repo.rename(h.handle, '', source, 'new', opts(source));
        expectMoved(await capture(repo, h, 'new'), original, 'fs');
        expect(disk(h)[path.basename(file)]).toEqual(before[path.basename(file)]);
        expect(await capture(repo, h, 'old')).toEqual(neighbor);
        expect(await repo.get(h.handle, '', source, opts(source))).toBeNull();
    });

    test('unrepresentable selected namespace lookup remains an explicit I/O failure', async () => {
        const before = disk(h);
        await expect(repo.getState(h.handle, '', 'old', 'n'.repeat(300), opts('old'))).rejects.toThrow(/ENAMETOOLONG/);
        expect(disk(h)).toEqual(before);
    });

    test('dotted source with hard-linked state retains every independently selected namespace', async () => {
        const source = 'a.b', original = await seed(repo, h, source);
        const value = { retained: ['渡口', null, false], nested: { revision: 7 } };
        fs.writeFileSync(statePath(h, source, 'one'), JSON.stringify(value));
        fs.linkSync(statePath(h, source, 'one'), statePath(h, source, 'e.one'));
        expect(sameNativeEntry(statePath(h, source, 'one'), statePath(h, source, 'e.one'))).toBe(true);
        for (const namespace of ['one', 'e.one']) expect(await repo.getState(h.handle, '', source, namespace, opts(source))).toEqual(value);
        const expected = { ...original, states: [...original.states, ['one', value], ['e.one', value]].sort(([a], [b]) => a < b ? -1 : 1) };
        const neighbor = await capture(repo, h, 'old');
        await repo.rename(h.handle, '', source, 'new', opts(source));
        expectMoved(await capture(repo, h, 'new'), expected, 'fs');
        expect(await repo.listStateNamespaces(h.handle, '', source, opts(source))).toEqual([]);
        expect(await repo.get(h.handle, '', source, opts(source))).toBeNull();
        expect(await capture(repo, h, 'old')).toEqual(neighbor);
        expect(fs.readdirSync(h.dirs.groupChats).filter(name => name.startsWith(`${source}.`))).toEqual([]);
    });

    test.each([
        ['case', 'one', 'ONE'],
        ['normalization', 'café', 'cafe\u0301'],
    ])('neighboring hard link cannot duplicate a selected namespace through %s aliases', async (_label, namespace, spelling) => {
        const value = { retained: ['渡口', null, false], nested: { revision: 7 } };
        const original = await capture(repo, h, 'old');
        const first = statePath(h, 'old', namespace), second = statePath(h, 'old', spelling);
        fs.writeFileSync(first, JSON.stringify(value));
        const alias = sameNativeEntry(first, second);
        if (!alias) fs.linkSync(first, second);
        const neighbor = path.join(h.dirs.groupChats, `neighbor.luker-state.${spelling}.JSON`);
        fs.linkSync(first, neighbor);
        const before = disk(h);
        const selected = [first, second, neighbor].map(file => ({ file, selected: fs.realpathSync.native(file), ino: String(fs.lstatSync(file, { bigint: true }).ino) }));
        recordPayload(h, 'alias and independent hardlink selection', { alias, selected });
        expect(selected[0].ino).toBe(selected[1].ino);
        expect(selected[0].selected === selected[1].selected).toBe(alias);
        expect(selected[0].selected).not.toBe(selected[2].selected);
        const namespaces = alias ? [namespace] : [namespace, spelling];
        const expected = { ...original, states: [...original.states, ...namespaces.map(ns => [ns, value])].sort(([a], [b]) => a < b ? -1 : 1) };
        const outcome = await repo.rename(h.handle, '', 'old', 'new', opts('old')).then(() => ({ ok: true }), error => ({ error: { name: error.name, code: error.code, message: error.message } }));
        recordPayload(h, 'combined alias move result', { outcome, before, after: disk(h) });
        expect(outcome).toEqual({ ok: true });
        expectMoved(await capture(repo, h, 'new'), expected, 'fs');
        for (const ns of [namespace, spelling]) expect(await repo.getState(h.handle, '', 'new', ns, opts('new'))).toEqual(value);
        expect(await repo.get(h.handle, '', 'old', opts('old'))).toBeNull();
        expect(await repo.listStateNamespaces(h.handle, '', 'old', opts('old'))).toEqual([]);
        expect(disk(h)[path.basename(neighbor)]).toEqual(before[path.basename(neighbor)]);
        expect(fs.existsSync(first)).toBe(false); expect(fs.existsSync(second)).toBe(false);
    });

    test('an unrepresentable complete state mapping refuses before claiming a valid parent path', async () => {
        const destination = 'n'.repeat(235), before = disk(h), original = await capture(repo, h, 'old');
        const failure = await repo.rename(h.handle, '', 'old', destination, opts('old')).then(() => null, error => error);
        recordPayload(h, 'unpublishable state mapping', { code: failure?.code, message: failure?.message, before, after: disk(h) });
        expect(failure).toEqual(expect.objectContaining({ message: expect.any(String), code: expect.any(String) }));
        expect(fs.existsSync(chatPath(h, destination))).toBe(false);
        expect(disk(h)).toEqual(before);
        expect(await capture(repo, h, 'old')).toEqual(original);
    });
});

test('independent source entries that alias at the native destination refuse before parent publication', async () => {
    const h = await makeTempFsEngineHarness(), fixtures = [], failures = [];
    const parent = fs.mkdtempSync(path.join(process.env.LUKER_RENAME_NATIVE_PROBE_PARENT || os.tmpdir(), 'rename-native-mapping-'));
    try {
        for (const semantics of ['case-sensitive', 'case-insensitive']) fixtures.push(await createRealFilesystemFixture({ parent, semantics, artifactDir: process.env.LUKER_RENAME_NATIVE_PROBE_EVIDENCE }));
        h.dirs.root = parent;
        h.dirs.groupChats = fixtures[0].root;
        h.dirs.chats = fixtures[1].root;
        fs.mkdirSync(path.join(h.dirs.chats, 'destination'));
        const repo = new ChatRepo({ engine: h.engine }), original = await seed(repo, h);
        const value = { retained: ['渡口', null, false] };
        fs.writeFileSync(statePath(h, 'old', 'one'), JSON.stringify(value));
        fs.linkSync(statePath(h, 'old', 'one'), statePath(h, 'old', 'ONE'));
        const before = disk(h);
        const failure = await h.engine.withTransaction(h.handle, async tx => {
            const snapshot = await tx.captureChatMove({ kind: 'chat', handle: h.handle, charDir: '', name: 'old', ...opts('old') });
            return tx.publishChatMove({ kind: 'chat', handle: h.handle, charDir: 'destination', name: 'new', isGroup: false }, snapshot);
        }).then(() => null, error => error);
        const destination = fs.readdirSync(path.join(h.dirs.chats, 'destination'));
        recordPayload(h, 'cross-native unpublishable alias mapping', { source: before, after: disk(h), destination, error: { name: failure?.name, code: failure?.code, message: failure?.message } });
        expect(failure).toBeInstanceOf(ConflictError);
        expect(failure.code).toBe('rename_target_exists');
        expect(destination).toEqual([]);
        expect(disk(h)).toEqual(before);
        expect((await capture(repo, h, 'old')).chat).toEqual(original.chat);
        for (const ns of ['one', 'ONE']) expect(await repo.getState(h.handle, '', 'old', ns, opts('old'))).toEqual(value);
    } catch (error) { failures.push(error); }
    const results = await Promise.allSettled(fixtures.reverse().map(fixture => fixture.cleanup()));
    try { await h.cleanup(); } catch (error) { failures.push(error); }
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    failures.push(...errors);
    if (errors.length === 0) {
        try { fs.rmdirSync(parent); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Native mapping control and cleanup failed');
});

describe('filesystem native namespace selected-read identity', () => {
    let h, repo, original;
    const source = 'café', destination = 'résumé', namespace = 'native-state';
    const value = { retained: ['渡口', null, false], nested: { revision: 7 } };
    const kinds = ['valid', 'corrupt', 'directory', 'symlink', 'dangling-link'];
    beforeEach(async () => {
        h = await makeTempFsEngineHarness(); repo = new ChatRepo({ engine: h.engine });
        original = await seed(repo, h, source);
    });
    afterEach(async () => h.cleanup());

    function install(file, kind) {
        if (kind === 'directory') fs.mkdirSync(file);
        else if (kind.includes('link')) {
            const outside = path.join(h.dataRoot, 'external-state.json');
            fs.writeFileSync(outside, JSON.stringify(value));
            fs.symlinkSync(kind === 'symlink' ? outside : `${outside}-missing`, file);
        } else fs.writeFileSync(file, kind === 'valid' ? JSON.stringify(value) : '{"private":"PRIVATE_PAYLOAD",');
    }

    describe.each(NATIVE_STATE_SPELLINGS)('%s', (_label, spelling) => {
        test.each(kinds)('%s source state follows native selection and preserves independent spellings', async kind => {
            const file = path.join(h.dirs.groupChats, spelling(source, namespace));
            install(file, kind);
            const alias = sameNativeEntry(file, statePath(h, source, namespace)), before = disk(h);
            if (alias && kind !== 'valid') {
                const error = await repo.rename(h.handle, '', source, destination, opts(source)).then(() => null, error => error);
                expect(error).toBeInstanceOf(Error); expect(error.message).toContain(namespace);
                expect(error.message).not.toContain('PRIVATE_PAYLOAD'); expect(error.cause).toBeUndefined();
                expect(disk(h)).toEqual(before);
                repo = new ChatRepo({ engine: h.engine });
                expect(await repo.get(h.handle, '', source, opts(source))).toEqual(original.chat);
                expect(await repo.exists(h.handle, '', destination, opts(destination))).toBe(false);
            } else {
                const expected = { ...original, states: [...original.states, ...(alias ? [[namespace, value]] : [])].sort(([a], [b]) => a < b ? -1 : 1) };
                await repo.rename(h.handle, '', source, destination, opts(source));
                repo = new ChatRepo({ engine: h.engine });
                expectMoved(await capture(repo, h, destination), expected, 'fs');
                expect(await repo.get(h.handle, '', source, opts(source))).toBeNull();
                expect(await repo.listStateNamespaces(h.handle, '', source, opts(source))).toEqual([]);
                if (alias) expect(fs.existsSync(file)).toBe(false);
                else expect(disk(h)[path.basename(file)]).toEqual(before[path.basename(file)]);
            }
        });

        test.each(kinds)('%s destination state refuses only when native selected paths alias', async kind => {
            const file = path.join(h.dirs.groupChats, spelling(destination, namespace));
            install(file, kind);
            const alias = sameNativeEntry(file, statePath(h, destination, namespace)), before = disk(h);
            if (alias) {
                await expect(repo.rename(h.handle, '', source, destination, opts(source))).rejects.toThrow(ConflictError);
                expect(disk(h)).toEqual(before);
                repo = new ChatRepo({ engine: h.engine });
                expect(await capture(repo, h, source)).toEqual(original);
                expect(await repo.exists(h.handle, '', destination, opts(destination))).toBe(false);
            } else {
                await repo.rename(h.handle, '', source, destination, opts(source));
                repo = new ChatRepo({ engine: h.engine });
                expectMoved(await capture(repo, h, destination), original, 'fs');
                expect(disk(h)[path.basename(file)]).toEqual(before[path.basename(file)]);
                expect(await repo.getState(h.handle, '', destination, namespace, opts(destination))).toBeNull();
            }
        });
    });
});

test('SQLite malformed owned state refuses before namespace copying or deletion', async () => {
    const h = await makeTempSqliteEngineHarness(), repo = new ChatRepo({ engine: h.engine });
    try {
        await seed(repo, h);
        await h.engine.withTransaction(h.handle, tx => tx._db.prepare('UPDATE chat_states SET doc=? WHERE handle=? AND namespace=?').run('{"private":"PRIVATE_PAYLOAD",', h.handle, 'memory_graph'));
        const resources = await rawResources(h);
        const inventory = await repo.listAllGroupChats(h.handle), parent = await repo.get(h.handle, '', 'old', opts('old'));
        const error = await repo.rename(h.handle, '', 'old', 'new', { isGroup: true }).then(() => null, error => error);
        expect(error).toBeInstanceOf(Error); expect(error.message).toContain('memory_graph'); expect(error.message).not.toContain('PRIVATE_PAYLOAD'); expect(error.cause).toBeUndefined();
        expect(await repo.listAllGroupChats(h.handle)).toEqual(inventory); expect(await repo.get(h.handle, '', 'old', opts('old'))).toEqual(parent);
        expect(await rawResources(h)).toEqual(resources);
        await h.engine.withTransaction(h.handle, tx => expect(tx._db.prepare('SELECT doc FROM chat_states WHERE handle=? AND namespace=?').get(h.handle, 'memory_graph').doc).toBe('{"private":"PRIVATE_PAYLOAD",'));
    } finally { await h.cleanup(); }
});
