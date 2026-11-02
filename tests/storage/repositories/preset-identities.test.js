import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { makeTempFsEngineHarness } from '../harness/contract-harness.js';
import { makeRemote, BACKEND_ID } from '../../sync/_lib/devices.js';
import { DirectoryBackend } from '../../sync/_lib/directory-backend.js';
import { runSyncCycle } from '../../../src/sync/pipeline/cycle.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';

const PRESET = { temperature: 0.31, prompts: [{ name: 'kept', content: 'PRESET_VALUE' }] };
const STATE = { notes: ['STATE_VALUE'], nested: { active: true } };

describe('filesystem preset identity ownership', () => {
    let h, repo;
    beforeEach(async () => { h = await makeTempFsEngineHarness(); repo = new PresetRepo({ engine: h.engine }); });
    afterEach(async () => h.cleanup());
    const raw = (relative, text) => {
        const file = path.join(h.dirs.openAI_Settings, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        return file;
    };
    const extended = tuple => {
        const hex = Buffer.from(JSON.stringify(tuple)).toString('hex');
        return `.luker-preset-records/v1/${hex.match(/.{1,120}/g).join('/')}/value.json`;
    };
    const physicalBytes = () => {
        const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
            const absolute = path.join(folder, entry.name);
            const relative = path.relative(h.dirs.openAI_Settings, absolute);
            return entry.isDirectory() ? [{ relative, directory: true }, ...walk(absolute)] : [{ relative, bytes: fs.readFileSync(absolute) }];
        });
        return walk(h.dirs.openAI_Settings);
    };

    test('rejected delimiter-document deletion preserves the complete legacy and orphan state on repeated attempts', async () => {
        const orphan = { orphanOwner: ['KEEP_COMPLETE_TYPED_STATE'], nested: { values: [0, false, '\u0000'] } };
        await repo.setState(h.handle, 'openai', 'A', 'n', STATE);
        await repo.setState(h.handle, 'openai', 'A.luker-state.n', 'm', orphan);
        expect(await repo.exists(h.handle, 'openai', 'A.luker-state.n')).toBe(false);
        const before = physicalBytes();
        const attempts = [];
        for (let attempt = 0; attempt < 2; attempt++) {
            const outcome = await repo.delete(h.handle, 'openai', 'A.luker-state.n').then(value => ({ value }), error => ({ error }));
            attempts.push({ ...outcome, legacy: await repo.getState(h.handle, 'openai', 'A', 'n'), orphan: await repo.getState(h.handle, 'openai', 'A.luker-state.n', 'm'), physical: physicalBytes() });
        }
        expect(attempts).toEqual([0, 1].map(() => ({ error: expect.objectContaining({ code: 'PRESET_LEGACY_AMBIGUOUS' }), legacy: STATE, orphan, physical: before })));
        await expect(repo.get(h.handle, 'openai', 'A.luker-state.n')).rejects.toMatchObject({ code: 'PRESET_LEGACY_AMBIGUOUS' });
        expect(await repo.exists(h.handle, 'openai', 'A.luker-state.n')).toBe(false);
    });

    test('owned delimiter-document deletion purges its state but preserves the independent legacy owner', async () => {
        await repo.setState(h.handle, 'openai', 'A', 'n', STATE);
        const legacy = fs.readFileSync(path.join(h.dirs.openAI_Settings, 'A.luker-state.n.json'));
        await repo.save(h.handle, 'openai', 'A.luker-state.n', PRESET);
        await repo.setState(h.handle, 'openai', 'A.luker-state.n', 'm', { own: ['COMPLETE_OWN_STATE'] });
        expect(await repo.exists(h.handle, 'openai', 'A.luker-state.n')).toBe(true);
        expect(await repo.delete(h.handle, 'openai', 'A.luker-state.n')).toBe(true);
        expect(await repo.getState(h.handle, 'openai', 'A.luker-state.n', 'm')).toBeNull();
        expect(await repo.listStateNamespaces(h.handle, 'openai', 'A.luker-state.n')).toEqual([]);
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toEqual(STATE);
        expect(fs.readFileSync(path.join(h.dirs.openAI_Settings, 'A.luker-state.n.json'))).toEqual(legacy);
        expect(fs.existsSync(path.join(h.dirs.openAI_Settings, extended(['preset', 'openAI_Settings', 'A.luker-state.n'])))).toBe(false);
        expect(fs.existsSync(path.join(h.dirs.openAI_Settings, extended(['preset-state', 'openAI_Settings', 'A.luker-state.n', 'm'])))).toBe(false);
        expect(await repo.exists(h.handle, 'openai', 'A.luker-state.n')).toBe(false);
        await expect(repo.get(h.handle, 'openai', 'A.luker-state.n')).rejects.toMatchObject({ code: 'PRESET_LEGACY_AMBIGUOUS' });
        const after = physicalBytes();
        await expect(repo.delete(h.handle, 'openai', 'A.luker-state.n')).rejects.toMatchObject({ code: 'PRESET_LEGACY_AMBIGUOUS' });
        expect(physicalBytes()).toEqual(after);
    });

    test('deleting an owned malformed document does not require reading its payload', async () => {
        raw('A.json', '{MALFORMED_OWNED_DOCUMENT');
        await repo.setState(h.handle, 'openai', 'A', 'n', STATE);
        expect(await repo.delete(h.handle, 'openai', 'A')).toBe(true);
        expect(await repo.get(h.handle, 'openai', 'A')).toBeNull();
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toBeNull();
    });

    test('a delimiter document and its colliding orphan state coexist in get and bootstrap inventory', async () => {
        await repo.save(h.handle, 'openai', 'A.luker-state.n', PRESET);
        expect(await repo.listWithDocs(h.handle, 'openai')).toEqual([{ name: 'A.luker-state.n', doc: PRESET }]);
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toBeNull();
        await repo.setState(h.handle, 'openai', 'A', 'n', STATE);
        expect(await repo.get(h.handle, 'openai', 'A.luker-state.n')).toEqual(PRESET);
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toEqual(STATE);
        expect(await repo.get(h.handle, 'openai', 'A')).toBeNull();
        expect(await repo.listWithDocs(h.handle, 'openai')).toEqual([{ name: 'A.luker-state.n', doc: PRESET }]);
    });

    test('namespace and infix-bearing base ownership stay independent through rename and delete', async () => {
        await repo.setState(h.handle, 'openai', 'A', 'n.luker-state.m', STATE);
        await repo.setState(h.handle, 'openai', 'A.luker-state.n', 'm', { independent: ['BASE_STATE'] });
        await repo.save(h.handle, 'openai', 'A.luker-state.n', PRESET);
        expect(await repo.listStateNamespaces(h.handle, 'openai', 'A')).toEqual(['n.luker-state.m']);
        expect(await repo.listStateNamespaces(h.handle, 'openai', 'A.luker-state.n')).toEqual(['m']);
        expect(await repo.renameStates(h.handle, 'openai', 'A.luker-state.n', 'Renamed')).toBe(1);
        expect(await repo.getState(h.handle, 'openai', 'Renamed', 'm')).toEqual({ independent: ['BASE_STATE'] });
        await repo.delete(h.handle, 'openai', 'A.luker-state.n');
        expect(await repo.getState(h.handle, 'openai', 'A', 'n.luker-state.m')).toEqual(STATE);
        expect(await repo.getState(h.handle, 'openai', 'Renamed', 'm')).toEqual({ independent: ['BASE_STATE'] });
    });

    test('a historical slot has its published state owner and cannot be read through an aliased document getter', async () => {
        const file = raw('A.luker-state.n.json', JSON.stringify(STATE));
        await expect(repo.get(h.handle, 'openai', 'A.luker-state.n')).rejects.toMatchObject({ code: 'PRESET_LEGACY_AMBIGUOUS' });
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toEqual(STATE);
        await repo.save(h.handle, 'openai', 'A.luker-state.n', PRESET);
        expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(STATE));
        expect(await repo.get(h.handle, 'openai', 'A.luker-state.n')).toEqual(PRESET);
    });

    test('canonical snapshots retain an existing owned typed physical source and unowned files', async () => {
        const source = raw(extended(['preset', 'openAI_Settings', 'A']), JSON.stringify(PRESET));
        raw('notes.txt', 'UNOWNED_PRESET_CATEGORY_BYTES');
        const before = fs.statSync(source);
        const remote = await makeRemote();
        const ctx = { userRoot: h.dirs.root, handle: h.handle, directories: h.dirs, backendId: BACKEND_ID, categories: ['openai-presets'], engine: h.engine, backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir: remote.remoteDir, userRoot: h.dirs.root }) };
        try {
            await runSyncCycle(ctx);
            const result = await runSyncCycle(ctx);
            expect(fs.statSync(source).ino).toBe(before.ino);
            expect(fs.readFileSync(source, 'utf8')).toBe(JSON.stringify(PRESET));
            expect(fs.existsSync(path.join(h.dirs.openAI_Settings, 'A.json'))).toBe(false);
            const gitdir = getShadowPaths({ userRoot: h.dirs.root, peerId: BACKEND_ID }).gitDir;
            const files = await readCommitFiles({ gitdir, commitOid: result.localHead });
            expect([...files.keys()].sort()).toEqual(['OpenAI Settings/A.json', 'OpenAI Settings/notes.txt']);
            expect((await readBlobBytes({ gitdir, oid: files.get('OpenAI Settings/notes.txt').oid })).toString('utf8')).toBe('UNOWNED_PRESET_CATEGORY_BYTES');
            expect(await repo.get(h.handle, 'openai', 'A')).toEqual(PRESET);
        } finally { remote.cleanup(); }
    });

    test('repository state keys retain suffixes, empty components and full namespaces', async () => {
        const cases = [
            ['A.json', 'n', { suffix: true }],
            ['', 'empty-base', { emptyBase: true }],
            ['A', '', { emptyNamespace: true }],
            ['A', 'x'.repeat(128), { fullNamespace: true }],
            ['../outside', 'n/path', { exact: ['unsafe physical segments are encoded'] }],
        ];
        for (const [name, namespace, value] of cases) await repo.setState(h.handle, 'openai', name, namespace, value);
        for (const [name, namespace, value] of cases) expect(await repo.getState(h.handle, 'openai', name, namespace)).toEqual(value);
        const records = await h.engine.withTransaction(h.handle, tx => tx.listPresetStateRecords({ handle: h.handle, dirKey: 'openAI_Settings' }));
        expect(records.map(({ name, namespace }) => [name, namespace]).sort()).toEqual(cases.map(([name, namespace]) => [name, namespace]).sort());
        expect(fs.existsSync(path.join(h.dirs.root, 'outside.luker-state.n'))).toBe(false);
    });

    test('duplicate physical formats for one identity fail before reading either payload', async () => {
        raw('A.json', '{PRIVATE_CREDENTIAL_MARKER');
        raw(extended(['preset', 'openAI_Settings', 'A']), JSON.stringify(PRESET));
        await expect(repo.get(h.handle, 'openai', 'A')).rejects.toMatchObject({ code: 'PRESET_IDENTITY_DUPLICATE' });
    });

    test('a selected malformed document does not become absence or disclose parser excerpts', async () => {
        const file = raw('A.json', '{PRIVATE_CREDENTIAL_MARKER');
        const outcome = await repo.get(h.handle, 'openai', 'A').then(value => ({ value }), error => ({ error }));
        expect(outcome.error).toMatchObject({ code: 'PRESET_DOCUMENT_INVALID' });
        expect(String(outcome.error)).not.toContain('PRIVATE_CREDENTIAL_MARKER');
        expect(outcome.error?.cause?.message || '').not.toContain('PRIVATE_CREDENTIAL_MARKER');
        expect(fs.readFileSync(file, 'utf8')).toBe('{PRIVATE_CREDENTIAL_MARKER');
    });

    test('an unreadable selected state preserves the file and exposes its read error', async () => {
        const file = raw('A.luker-state.n.json', JSON.stringify(STATE));
        fs.chmodSync(file, 0o000);
        try {
            await expect(repo.getState(h.handle, 'openai', 'A', 'n')).rejects.toMatchObject({ code: 'EACCES' });
        } finally { fs.chmodSync(file, 0o600); }
        expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(STATE));
    });

    test('a malformed selected typed document never reads the independent legacy state instead', async () => {
        const legacy = raw('A.luker-state.n.json', JSON.stringify(STATE));
        const selected = raw(extended(['preset', 'openAI_Settings', 'A.luker-state.n']), '{PRIVATE_SELECTED_MARKER');
        await expect(repo.get(h.handle, 'openai', 'A.luker-state.n')).rejects.toMatchObject({ code: 'PRESET_DOCUMENT_INVALID' });
        expect(await repo.getState(h.handle, 'openai', 'A', 'n')).toEqual(STATE);
        expect(fs.readFileSync(legacy, 'utf8')).toBe(JSON.stringify(STATE));
        expect(fs.readFileSync(selected, 'utf8')).toBe('{PRIVATE_SELECTED_MARKER');
    });

    test.each(['v2/00/value.json', 'v1/not-hex/value.json'])('a malformed reserved format %s never falls through to flat storage', async relative => {
        raw('A.json', JSON.stringify(PRESET));
        raw(`.luker-preset-records/${relative}`, JSON.stringify(STATE));
        await expect(repo.get(h.handle, 'openai', 'A')).rejects.toHaveProperty('code');
        expect(fs.readFileSync(path.join(h.dirs.openAI_Settings, 'A.json'), 'utf8')).toBe(JSON.stringify(PRESET));
    });
});
