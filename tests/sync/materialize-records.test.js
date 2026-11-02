import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CONTRACT_HARNESSES } from './_lib/required-engines.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import {
    materializeUserDataIntoWorkdir,
    describeSqlRecordPath,
    readSqlRecordValue,
    parseSqlRecordBlob,
    writeSqlRecordValue,
} from '../../src/sync/materialize.js';
import { withNestedDirs } from './_lib/nested-dirs.js';
import { runSyncCycle } from '../../src/sync/pipeline/cycle.js';
import { createConflictPolicy } from '../../src/sync/pipeline/conflict-policy.js';
import { DirectoryBackend } from './_lib/directory-backend.js';
import { makeRemote, BACKEND_ID } from './_lib/devices.js';

const SQL_HARNESSES = CONTRACT_HARNESSES.filter(h => h.name !== 'FsEngine');

const CATEGORIES = ['settings', 'worlds', 'chats', 'openai-presets', 'themes'];

function walkFiles(root, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walkFiles(root, rel));
        else out.push(rel);
    }
    return out;
}

async function seed(h) {
    const { engine, handle } = h;
    for (const k of ['worlds', 'groups', 'groupChats', 'themes', 'openAI_Settings']) fs.mkdirSync(h.dirs[k], { recursive: true });
    await new SettingsRepo({ engine }).save(handle, { theme: 'dark' });
    await new WorldInfoRepo({ engine }).save(handle, 'Lore', { entries: { 0: { content: 'old' } } });
    await new PresetRepo({ engine }).save(handle, 'openai', 'creative', { temperature: 0.7 });
    await new NamedDocRepo({ engine }).save(handle, 'themes', 'Night', { name: 'Night' });
    await new ChatRepo({ engine }).save(handle, 'Alice', 'c1', { user_name: 'u', character_name: 'Alice', chat_metadata: {} }, [{ mes: 'hi' }], null);
    await new GroupRepo({ engine }).save(handle, 'g1', { id: 'g1', chats: ['gc1'] });
    await engine.withTransaction(handle, async (tx) => {
        await tx.putResource({ kind: 'chat', handle, charDir: null, name: 'gc1', isGroup: true, groupId: 'gc1' }, { header: { chat_metadata: { integrity: 'x' } }, body: [], integrity: 'x' });
        await tx.putChatState({ kind: 'chat', handle, charDir: 'Alice', name: 'c1', isGroup: false }, 'notes', { v: 1 });
        await tx.putPresetState({ kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'creative' }, 'iter', { n: 1 });
    });
}

describe.each(SQL_HARNESSES)('SQL record helpers — $name', ({ make }) => {
    const makeHarness = async () => withNestedDirs(await make());

    test('delimiter documents and both accepted colliding state identities project without overwriting', async () => {
        const h = await makeHarness();
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-preset-identities-'));
        try {
            const repo = new PresetRepo({ engine: h.engine });
            const preset = { temperature: 0.31, prompts: [{ name: 'kept', content: 'PRESET_VALUE' }] };
            await repo.save(h.handle, 'openai', 'A.luker-state.n', preset);
            await repo.setState(h.handle, 'openai', 'A', 'n', { notes: ['STATE_VALUE'] });
            await repo.setState(h.handle, 'openai', 'A.luker-state.n', 'm', { baseState: ['INFIX_BASE'] });
            await repo.setState(h.handle, 'openai', 'A', 'n.luker-state.m', { namespaceState: ['INFIX_NAMESPACE'] });
            await materializeUserDataIntoWorkdir({ handle: h.handle, directories: h.dirs, categories: ['openai-presets'], workdir, engine: h.engine });
            const projected = {};
            for (const rel of walkFiles(workdir)) {
                const record = describeSqlRecordPath(h.dirs, rel);
                const identity = JSON.stringify([record.kind, record.name, ...(record.kind === 'preset-state' ? [record.namespace] : [])]);
                projected[identity] = JSON.parse(fs.readFileSync(path.join(workdir, rel), 'utf8'));
            }
            expect(projected).toEqual({
                '["preset","A.luker-state.n"]': preset,
                '["preset-state","A","n"]': { notes: ['STATE_VALUE'] },
                '["preset-state","A.luker-state.n","m"]': { baseState: ['INFIX_BASE'] },
                '["preset-state","A","n.luker-state.m"]': { namespaceState: ['INFIX_NAMESPACE'] },
            });
            expect(await repo.get(h.handle, 'openai', 'A')).toBeNull();
        } finally { await h.cleanup(); fs.rmSync(workdir, { recursive: true }); }
    });

    test('filesystem source and SQL receiver preserve all preset identities through onward filesystem propagation', async () => {
        const source = withNestedDirs(await CONTRACT_HARNESSES.find(entry => entry.name === 'FsEngine').make());
        const receiver = await makeHarness();
        const onward = withNestedDirs(await CONTRACT_HARNESSES.find(entry => entry.name === 'FsEngine').make());
        const remote = await makeRemote();
        const context = h => ({ userRoot: h.dirs.root, directories: h.dirs, handle: h.handle, engine: h.engine, backendId: BACKEND_ID, categories: ['openai-presets'], backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot: h.dirs.root }), onConflicts: createConflictPolicy({ directories: h.dirs }) });
        const preset = { temperature: 0.31, prompts: [{ name: 'kept', content: 'PRESET_VALUE' }] };
        const states = [['A', 'n', { notes: ['STATE_VALUE'] }], ['A.luker-state.n', 'm', { baseState: ['INFIX_BASE'] }], ['A', 'n.luker-state.m', { namespaceState: ['INFIX_NAMESPACE'] }]];
        try {
            const repo = new PresetRepo({ engine: source.engine });
            await repo.save(source.handle, 'openai', 'A.luker-state.n', preset);
            for (const [name, ns, value] of states) await repo.setState(source.handle, 'openai', name, ns, value);
            await runSyncCycle(context(source));
            await runSyncCycle(context(receiver));
            await runSyncCycle(context(receiver));
            await runSyncCycle(context(onward));
            await runSyncCycle(context(onward));
            await runSyncCycle(context(source));
            for (const h of [source, receiver, onward]) {
                const actual = new PresetRepo({ engine: h.engine });
                expect(await actual.listWithDocs(h.handle, 'openai')).toEqual([{ name: 'A.luker-state.n', doc: preset }]);
                for (const [name, ns, value] of states) expect(await actual.getState(h.handle, 'openai', name, ns)).toEqual(value);
                expect(await actual.get(h.handle, 'openai', 'A')).toBeNull();
            }
        } finally { await source.cleanup(); await receiver.cleanup(); await onward.cleanup(); remote.cleanup(); }
    }, 60_000);

    test('accepted orphan preset state enters SQL projection independently of parents', async () => {
        const h = await makeHarness();
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-orphan-preset-'));
        try {
            const repo = new PresetRepo({ engine: h.engine });
            await repo.setState(h.handle, 'openai', 'missing', 'notes', { recoverable: true });
            await materializeUserDataIntoWorkdir({ handle: h.handle, directories: h.dirs, categories: ['openai-presets'], workdir, engine: h.engine });
            const rel = path.relative(h.dirs.root, path.join(h.dirs.openAI_Settings, 'missing.luker-state.notes.json'));
            expect(JSON.parse(fs.readFileSync(path.join(workdir, rel), 'utf8'))).toEqual({ recoverable: true });
            expect(await repo.get(h.handle, 'openai', 'missing')).toBeNull();
        } finally {
            await h.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('orphan preset state and accepted world names survive fresh snapshots and peer propagation', async () => {
        const h = await makeHarness();
        const peer = await makeHarness();
        const remote = await makeRemote();
        const context = d => ({ userRoot: d.dirs.root, directories: d.dirs, handle: d.handle, engine: d.engine, backendId: BACKEND_ID, categories: ['openai-presets', 'worlds'], backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot: d.dirs.root }), onConflicts: createConflictPolicy({ directories: d.dirs, localDevice: 'local', remoteDevice: 'peer' }) });
        try {
            await new PresetRepo({ engine: h.engine }).setState(h.handle, 'openai', 'missing', 'notes', { recoverable: true });
            for (const name of ['.chapter', 'chapter..draft']) await new WorldInfoRepo({ engine: h.engine }).save(h.handle, name, { entries: {}, name });
            await runSyncCycle(context(h));
            await runSyncCycle(context(peer));
            await runSyncCycle(context(peer));
            await runSyncCycle(context(h));
            for (const d of [h, peer]) {
                expect(await new PresetRepo({ engine: d.engine }).getState(d.handle, 'openai', 'missing', 'notes')).toEqual({ recoverable: true });
                for (const name of ['.chapter', 'chapter..draft']) expect(await new WorldInfoRepo({ engine: d.engine }).get(d.handle, name)).toEqual({ entries: {}, name });
            }
        } finally { await h.cleanup(); await peer.cleanup(); remote.cleanup(); }
    }, 60_000);

    test.each(['.chapter', 'chapter..draft'])('accepted repository name %s remains representable', async name => {
        const h = await makeHarness();
        try {
            await new WorldInfoRepo({ engine: h.engine }).save(h.handle, name, { entries: {} });
            expect(describeSqlRecordPath(h.dirs, `worlds/${name}.json`)).toEqual({ kind: 'world', name });
        } finally { await h.cleanup(); }
    });

    test('describeSqlRecordPath maps materialized paths to records', async () => {
        const h = await makeHarness();
        try {
            const d = h.dirs;
            expect(describeSqlRecordPath(d, 'settings.json')).toEqual({ kind: 'settings' });
            expect(describeSqlRecordPath(d, 'stats.json')).toEqual({ kind: 'stats' });
            expect(describeSqlRecordPath(d, 'worlds/Lore.json')).toEqual({ kind: 'world', name: 'Lore' });
            expect(describeSqlRecordPath(d, 'OpenAI Settings/creative.json')).toEqual({ kind: 'preset', dirKey: 'openAI_Settings', name: 'creative' });
            expect(describeSqlRecordPath(d, 'OpenAI Settings/creative.luker-state.iter.json')).toEqual({ kind: 'preset-state', dirKey: 'openAI_Settings', name: 'creative', namespace: 'iter' });
            expect(describeSqlRecordPath(d, 'themes/Night.json')).toEqual({ kind: 'named-doc', bucket: 'themes', name: 'Night' });
            expect(describeSqlRecordPath(d, 'groups/g1.json')).toEqual({ kind: 'group', id: 'g1' });
            expect(describeSqlRecordPath(d, 'group chats/gc1.jsonl')).toEqual({ kind: 'chat', charDir: null, name: 'gc1', isGroup: true });
            expect(describeSqlRecordPath(d, 'chats/Alice/c1.jsonl')).toEqual({ kind: 'chat', charDir: 'Alice', name: 'c1', isGroup: false });
            expect(describeSqlRecordPath(d, 'chats/Alice/c1.luker-state.notes.json')).toEqual({ kind: 'chat-state', charDir: 'Alice', name: 'c1', isGroup: false, namespace: 'notes' });
            expect(describeSqlRecordPath(d, 'chats/Alice/deep/c1.jsonl')).toBeNull();
            expect(describeSqlRecordPath(d, 'chats/.git/c1.jsonl')).toBeNull();
            expect(describeSqlRecordPath(d, 'worlds/Lore.txt')).toBeNull();
            expect(describeSqlRecordPath(d, 'characters/a.png')).toBeNull();
        } finally {
            await h.cleanup();
        }
    });

    test('every materialized file parses to the value read back from the engine', async () => {
        const h = await makeHarness();
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-records-'));
        try {
            await seed(h);
            await materializeUserDataIntoWorkdir({ handle: h.handle, directories: h.dirs, categories: CATEGORIES, workdir, engine: h.engine });
            const files = walkFiles(workdir);
            expect(files.length).toBeGreaterThanOrEqual(9);
            await h.engine.withTransaction(h.handle, async (tx) => {
                for (const rel of files) {
                    const record = describeSqlRecordPath(h.dirs, rel);
                    expect(record).not.toBeNull();
                    const fromFile = parseSqlRecordBlob(record, fs.readFileSync(path.join(workdir, rel)));
                    expect(isDeepStrictEqual(await readSqlRecordValue(tx, h.handle, record), fromFile)).toBe(true);
                }
            });
        } finally {
            await h.cleanup();
            fs.rmSync(workdir, { recursive: true, force: true });
        }
    });

    test('writeSqlRecordValue puts and deletes every record kind', async () => {
        const h = await makeHarness();
        try {
            await seed(h);
            const cases = [
                [{ kind: 'settings' }, { theme: 'light' }],
                [{ kind: 'world', name: 'New' }, { entries: { 1: { content: 'n' } } }],
                [{ kind: 'preset', dirKey: 'openAI_Settings', name: 'creative' }, { temperature: 1 }],
                [{ kind: 'preset-state', dirKey: 'openAI_Settings', name: 'creative', namespace: 'iter' }, { n: 2 }],
                [{ kind: 'named-doc', bucket: 'themes', name: 'Night' }, { name: 'Night', dim: true }],
                [{ kind: 'group', id: 'g1' }, { id: 'g1', chats: ['gc1'], fav: true }],
                [{ kind: 'chat', charDir: 'Alice', name: 'c1', isGroup: false }, { header: { user_name: 'u', chat_metadata: { integrity: 'abc' } }, body: [{ mes: 'hi' }, { mes: 'there' }] }],
                [{ kind: 'chat-state', charDir: 'Alice', name: 'c1', isGroup: false, namespace: 'notes' }, { v: 2 }],
            ];
            await h.engine.withTransaction(h.handle, async (tx) => {
                for (const [record, value] of cases) {
                    await writeSqlRecordValue(tx, h.handle, record, value);
                    expect(await readSqlRecordValue(tx, h.handle, record)).toEqual(value);
                }
                for (const [record] of [...cases].reverse()) {
                    await writeSqlRecordValue(tx, h.handle, record, null);
                    expect(await readSqlRecordValue(tx, h.handle, record)).toBeNull();
                }
            });
        } finally {
            await h.cleanup();
        }
    });

    test('values written with unsorted keys read back equal to their serialized blob', async () => {
        const h = await makeHarness();
        try {
            await seed(h);
            const unsorted = () => ({ zeta: 1, a: { y: 2, b: 3 }, bb: [] });
            const cases = [
                [{ kind: 'world', name: 'Lore' }, unsorted(), value => JSON.stringify(value, null, 4)],
                [
                    { kind: 'chat', charDir: 'Alice', name: 'c1', isGroup: false },
                    { header: { zeta: 'z', chat_metadata: { zz: 1, integrity: 'abc', a: [] }, a: { y: 2, b: 3 } }, body: [{ mes: 'hi', extra: { y: 1, b: 2 } }] },
                    value => [value.header, ...value.body].map(line => JSON.stringify(line)).join('\n') + '\n',
                ],
                [{ kind: 'chat-state', charDir: 'Alice', name: 'c1', isGroup: false, namespace: 'notes' }, unsorted(), value => JSON.stringify(value, null, 4)],
            ];
            await h.engine.withTransaction(h.handle, async (tx) => {
                for (const [record, original, serialize] of cases) {
                    await writeSqlRecordValue(tx, h.handle, record, original);
                    const fromBlob = parseSqlRecordBlob(record, Buffer.from(serialize(original)));
                    expect(fromBlob).not.toBeUndefined();
                    expect(isDeepStrictEqual(await readSqlRecordValue(tx, h.handle, record), fromBlob)).toBe(true);
                }
            });
        } finally {
            await h.cleanup();
        }
    });
});

describe('parseSqlRecordBlob', () => {
    test('key order differences compare equal and chat blobs without integrity normalize to empty integrity', () => {
        const world = { kind: 'world', name: 'Lore' };
        const a = parseSqlRecordBlob(world, Buffer.from('{"a":1,"b":{"c":2,"d":3}}'));
        const b = parseSqlRecordBlob(world, Buffer.from('{"b":{"d":3,"c":2},"a":1}'));
        expect(isDeepStrictEqual(a, b)).toBe(true);
        const chat = { kind: 'chat', charDir: 'Alice', name: 'c1', isGroup: false };
        expect(parseSqlRecordBlob(chat, Buffer.from('{"user_name":"u"}\n{"mes":"hi"}\n'))).toEqual({ header: { user_name: 'u', chat_metadata: { integrity: '' } }, body: [{ mes: 'hi' }] });
        expect(parseSqlRecordBlob(world, Buffer.from('{not json'))).toBeUndefined();
        expect(parseSqlRecordBlob(chat, Buffer.from(''))).toBeUndefined();
        expect(parseSqlRecordBlob(chat, Buffer.from('"just a string"\n'))).toBeUndefined();
    });
});
