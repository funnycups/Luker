import { describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { withNestedDirs } from '../_lib/nested-dirs.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { materializeUserDataIntoWorkdir } from '../../../src/sync/materialize.js';
import { reconcileLiveCas } from '../../../src/sync/pipeline/live-cas.js';
import { commitFiles, commitTree, writeBlob, writeRawTree } from '../_lib/commits.js';

const SQL_HARNESSES = CONTRACT_HARNESSES.filter(h => h.name !== 'FsEngine');
const CATEGORIES = ['worlds', 'settings', 'chats'];
const doc = content => ({ entries: { 0: { content, keys: ['k'] } }, extensions: { depth: 4 } });
// Same value as doc(content), keys in the opposite order at every level.
const docReordered = content => ({ extensions: { depth: 4 }, entries: { 0: { keys: ['k'], content } } });
const json = value => JSON.stringify(value, null, 4);

describe.each(SQL_HARNESSES)('reconcileLiveCas (SQL records) — $name', ({ make }) => {
    async function setup() {
        const h = withNestedDirs(await make());
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        const shadow = await ensureShadowRepo({ userRoot: h.dirs.root, peerId: 'p' });
        await new WorldInfoRepo({ engine: h.engine }).save(h.handle, 'Lore', doc('base'));
        await new SettingsRepo({ engine: h.engine }).save(h.handle, { theme: 'base' });
        await new ChatRepo({ engine: h.engine }).save(h.handle, 'Alice', 'c1', { user_name: 'u', chat_metadata: {} }, [{ mes: 'one' }], null);
        const chatKey = { kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1', isGroup: false };
        await h.engine.withTransaction(h.handle, tx => tx.putChatState(chatKey, 'notes', { v: 1 }));
        await materializeUserDataIntoWorkdir({ handle: h.handle, directories: h.dirs, categories: CATEGORIES, workdir: shadow.workdir, engine: h.engine });
        const file = rel => fs.readFileSync(path.join(shadow.workdir, rel));
        const baseFiles = {
            'worlds/Lore.json': file('worlds/Lore.json'),
            'settings.json': file('settings.json'),
            'chats/Alice/c1.jsonl': file('chats/Alice/c1.jsonl'),
            'chats/Alice/c1.luker-state.notes.json': file('chats/Alice/c1.luker-state.notes.json'),
        };
        const base = await commitFiles(shadow.gitDir, baseFiles);
        const header = JSON.parse(baseFiles['chats/Alice/c1.jsonl'].toString('utf8').split('\n')[0]);
        const target = await commitFiles(shadow.gitDir, {
            'worlds/Lore.json': json(doc('target')),
            'worlds/New.json': json(doc('new')),
            'chats/Alice/c1.jsonl': [JSON.stringify(header), JSON.stringify({ mes: 'one' }), JSON.stringify({ mes: 'two' })].join('\n') + '\n',
        }, [base]);
        const run = () => reconcileLiveCas({ gitdir: shadow.gitDir, directories: h.dirs, handle: h.handle, categories: CATEGORIES, engine: h.engine, base, target });
        const get = key => h.engine.withTransaction(h.handle, tx => tx.getResource(key));
        return { h, shadow, run, get, chatKey, baseFiles, header };
    }

    const runPair = (h, shadow, base, target, categories = CATEGORIES) =>
        reconcileLiveCas({ gitdir: shadow.gitDir, directories: h.dirs, handle: h.handle, categories, engine: h.engine, base, target });

    test('a record whose target entry is a symlink is ignored and kept', async () => {
        const { h, shadow, get, baseFiles } = await setup();
        try {
            const base = await commitFiles(shadow.gitDir, { 'worlds/Lore.json': baseFiles['worlds/Lore.json'] });
            const link = await writeBlob(shadow.gitDir, '../settings.json');
            const target = await commitTree(shadow.gitDir, await writeRawTree(shadow.gitDir, [{ mode: '40000', name: 'worlds', oid: await writeRawTree(shadow.gitDir, [
                { mode: '120000', name: 'Lore.json', oid: link },
            ]) }]), [base]);
            const report = await runPair(h, shadow, base, target);
            expect(report).toEqual({ written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: ['worlds/Lore.json'] });
            expect(await get({ kind: 'world', handle: h.handle, name: 'Lore' })).toEqual(doc('base'));
        } finally {
            await h.cleanup();
        }
    });

    test('a chat with a state namespace the base never had is not deleted', async () => {
        const { h, shadow, get, chatKey, baseFiles } = await setup();
        try {
            const base = await commitFiles(shadow.gitDir, {
                'chats/Alice/c1.jsonl': baseFiles['chats/Alice/c1.jsonl'],
                'chats/Alice/c1.luker-state.notes.json': baseFiles['chats/Alice/c1.luker-state.notes.json'],
            });
            const target = await commitFiles(shadow.gitDir, {}, [base]);
            await h.engine.withTransaction(h.handle, tx => tx.putChatState(chatKey, 'added', { v: 2 }));
            const report = await runPair(h, shadow, base, target);
            expect(report.deleted).toEqual(['chats/Alice/c1.luker-state.notes.json']);
            expect(report.skipped).toEqual(['chats/Alice/c1.jsonl']);
            expect((await get(chatKey)).body).toEqual([{ mes: 'one' }]);
            expect(await h.engine.withTransaction(h.handle, tx => tx.getChatState(chatKey, 'added'))).toEqual({ v: 2 });
        } finally {
            await h.cleanup();
        }
    });

    test('a chat whose state namespaces are all deleted by the plan is deleted', async () => {
        const { h, shadow, get, chatKey, baseFiles } = await setup();
        try {
            const base = await commitFiles(shadow.gitDir, {
                'chats/Alice/c1.jsonl': baseFiles['chats/Alice/c1.jsonl'],
                'chats/Alice/c1.luker-state.notes.json': baseFiles['chats/Alice/c1.luker-state.notes.json'],
            });
            const target = await commitFiles(shadow.gitDir, {}, [base]);
            const report = await runPair(h, shadow, base, target);
            expect(report.deleted).toEqual(['chats/Alice/c1.luker-state.notes.json', 'chats/Alice/c1.jsonl']);
            expect(await get(chatKey)).toBeNull();
        } finally {
            await h.cleanup();
        }
    });

    test('a preset with a state namespace the base never had is not deleted', async () => {
        const { h, shadow, get } = await setup();
        try {
            fs.mkdirSync(h.dirs.openAI_Settings, { recursive: true });
            await new PresetRepo({ engine: h.engine }).save(h.handle, 'openai', 'creative', { temperature: 0.7 });
            const presetKey = { kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'creative' };
            await materializeUserDataIntoWorkdir({ handle: h.handle, directories: h.dirs, categories: ['openai-presets'], workdir: shadow.workdir, engine: h.engine });
            const presetRel = 'OpenAI Settings/creative.json';
            const base = await commitFiles(shadow.gitDir, { [presetRel]: fs.readFileSync(path.join(shadow.workdir, presetRel)) });
            const target = await commitFiles(shadow.gitDir, {}, [base]);
            await h.engine.withTransaction(h.handle, tx => tx.putPresetState(presetKey, 'added', { n: 1 }));
            const report = await runPair(h, shadow, base, target, ['openai-presets']);
            expect(report.skipped).toEqual([presetRel]);
            expect(await get(presetKey)).toEqual({ temperature: 0.7 });
            expect(await h.engine.withTransaction(h.handle, tx => tx.getPresetState(presetKey, 'added'))).toEqual({ n: 1 });
        } finally {
            await h.cleanup();
        }
    });

    test('an unparseable base blob is skipped unless the record already equals the target', async () => {
        const { h, shadow, get } = await setup();
        try {
            const base = await commitFiles(shadow.gitDir, { 'worlds/Bad.json': 'not json', 'worlds/Done.json': 'not json' });
            const target = await commitFiles(shadow.gitDir, { 'worlds/Bad.json': json(doc('bad')), 'worlds/Done.json': json(doc('done')) }, [base]);
            await new WorldInfoRepo({ engine: h.engine }).save(h.handle, 'Done', doc('done'));
            const report = await runPair(h, shadow, base, target);
            expect(report.skipped).toEqual(['worlds/Bad.json']);
            expect(report.alreadyApplied).toEqual(['worlds/Done.json']);
            expect(await get({ kind: 'world', handle: h.handle, name: 'Bad' })).toBeNull();
        } finally {
            await h.cleanup();
        }
    });

    test('matching records are put and deleted inside one transaction', async () => {
        const { h, run, get, chatKey } = await setup();
        try {
            const spy = jest.spyOn(h.engine, 'withTransaction');
            const report = await run();
            expect(spy).toHaveBeenCalledTimes(1);
            spy.mockRestore();
            expect(report.written.sort()).toEqual(['chats/Alice/c1.jsonl', 'worlds/Lore.json', 'worlds/New.json']);
            expect(report.deleted.sort()).toEqual(['chats/Alice/c1.luker-state.notes.json', 'settings.json']);
            expect(report.skipped).toEqual([]);
            expect(await get({ kind: 'world', handle: h.handle, name: 'Lore' })).toEqual(doc('target'));
            expect(await get({ kind: 'world', handle: h.handle, name: 'New' })).toEqual(doc('new'));
            expect(await get({ kind: 'settings', handle: h.handle })).toBeNull();
            expect((await get(chatKey)).body).toEqual([{ mes: 'one' }, { mes: 'two' }]);
            expect(await h.engine.withTransaction(h.handle, tx => tx.getChatState(chatKey, 'notes'))).toBeNull();
        } finally {
            await h.cleanup();
        }
    });

    test('a throwpoint on the second record rolls back the first', async () => {
        const { h, shadow, get, baseFiles } = await setup();
        try {
            const base = await commitFiles(shadow.gitDir, { 'settings.json': baseFiles['settings.json'], 'worlds/Lore.json': baseFiles['worlds/Lore.json'] });
            const target = await commitFiles(shadow.gitDir, { 'settings.json': json({ theme: 'target' }), 'worlds/Lore.json': json(doc('target')) }, [base]);
            const settingsKey = { kind: 'settings', handle: h.handle };
            const settingsBefore = await get(settingsKey);
            process.env.LUKER_SYNC_THROWPOINT = 'reconcile-write';
            process.env.LUKER_SYNC_THROWPOINT_MATCH = 'worlds/Lore.json';
            try {
                await expect(runPair(h, shadow, base, target)).rejects.toMatchObject({ code: 'THROWPOINT' });
            } finally {
                delete process.env.LUKER_SYNC_THROWPOINT;
                delete process.env.LUKER_SYNC_THROWPOINT_MATCH;
            }
            expect(await get(settingsKey)).toEqual(settingsBefore);
            expect(await get({ kind: 'world', handle: h.handle, name: 'Lore' })).toEqual(doc('base'));
            expect((await runPair(h, shadow, base, target)).written).toEqual(['settings.json', 'worlds/Lore.json']);
        } finally {
            await h.cleanup();
        }
    });

    test('a record changed after the base is skipped and kept', async () => {
        const { h, run, get } = await setup();
        try {
            await new WorldInfoRepo({ engine: h.engine }).save(h.handle, 'Lore', doc('user'));
            const report = await run();
            expect(report.skipped).toEqual(['worlds/Lore.json']);
            expect(await get({ kind: 'world', handle: h.handle, name: 'Lore' })).toEqual(doc('user'));
            expect(report.written).toContain('worlds/New.json');
        } finally {
            await h.cleanup();
        }
    });

    test('an already-applied record counts as applied even with a different key order', async () => {
        const { h, run, get } = await setup();
        try {
            await new WorldInfoRepo({ engine: h.engine }).save(h.handle, 'Lore', docReordered('target'));
            const stored = await get({ kind: 'world', handle: h.handle, name: 'Lore' });
            // MySQL and Postgres JSON columns store keys in their own order.
            expect(Object.keys(stored)).toEqual(h.kind === 'sqlite' ? ['extensions', 'entries'] : ['entries', 'extensions']);
            const first = await run();
            expect(first.alreadyApplied).toContain('worlds/Lore.json');
            const second = await run();
            expect(second.written).toEqual([]);
            expect(second.deleted).toEqual([]);
            expect(second.skipped).toEqual([]);
            expect(second.alreadyApplied.sort()).toEqual(['chats/Alice/c1.jsonl', 'chats/Alice/c1.luker-state.notes.json', 'settings.json', 'worlds/Lore.json', 'worlds/New.json']);
        } finally {
            await h.cleanup();
        }
    });
});
