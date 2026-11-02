import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { spawnSync } from 'node:child_process';

import { createRealFilesystemFixture } from '../_lib/real-filesystems.js';
import { makeRemote, openDevice, remoteHead, resolveRefOrNull } from '../_lib/devices.js';
import { commitFiles, commitTree, writeBlob, writeRawTree } from '../_lib/commits.js';
import { runSyncCycle, recoverReconcile, MAIN_REF, PENDING_REF } from '../../../src/sync/pipeline/cycle.js';
import { journalPath, writeReconcileJournal, readReconcileJournal } from '../../../src/sync/pipeline/reconcile-journal.js';
import { snapshotCategoriesPath, writeSnapshotCategories } from '../../../src/sync/pipeline/snapshot-categories.js';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { ensureShadowRepo } from '../../../src/sync/shadow.js';

describe('native destination identities through the production cycle', () => {
    let sensitive, insensitive;
    let failed = false;
    const artifactDir = process.env.LUKER_TEST_NATIVE_ARTIFACT_DIR;
    beforeAll(async () => {
        sensitive = await createRealFilesystemFixture({ semantics: 'case-sensitive', artifactDir });
        insensitive = await createRealFilesystemFixture({ semantics: 'case-insensitive', artifactDir });
    }, 120_000);
    afterAll(async () => {
        const results = await Promise.allSettled([sensitive, insensitive].filter(Boolean).map(fixture => fixture.cleanup({ retain: failed })));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
    }, 120_000);
    const checked = fn => async () => {
        try { await fn(); } catch (error) { failed = true; throw error; }
    };
    const bytesOf = async (gitdir, commitOid) => Object.fromEntries(await Promise.all([...(await readCommitFiles({ gitdir, commitOid }))].map(async ([rel, entry]) => [rel, (await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8')])));
    const persistRecovery = async (receiver, baseFiles, targetFiles, advanceOnSkip = false) => {
        const { gitDir: gitdir } = await ensureShadowRepo({ userRoot: receiver.userRoot, peerId: receiver.ctx.backendId });
        const base = await commitFiles(gitdir, baseFiles);
        const target = await commitFiles(gitdir, targetFiles, [base]);
        await git.writeRef({ fs, gitdir, ref: MAIN_REF, value: base, force: true });
        await git.writeRef({ fs, gitdir, ref: PENDING_REF, value: target, force: true });
        await writeReconcileJournal({ ...receiver.ctx, base, target, advanceOnSkip });
        await writeSnapshotCategories({ ...receiver.ctx, syncedAt: Object.fromEntries(receiver.ctx.categories.map(id => [id, base])) });
        return { base, target };
    };
    const liveBytes = receiver => Object.fromEntries(['characters', 'worlds'].map(category => [category,
        fs.readdirSync(receiver.directories[category], { encoding: 'buffer' }).map(name => ({ name: name.toString('hex'), bytes: fs.readFileSync(path.join(receiver.directories[category], name.toString('utf8'))) })),
    ]));
    const recoveryEvidence = async receiver => ({
        live: liveBytes(receiver),
        refs: await Promise.all([MAIN_REF, PENDING_REF].map(ref => resolveRefOrNull(receiver.shadow.gitDir, ref))),
        journal: fs.existsSync(journalPath(receiver.ctx)) ? fs.readFileSync(journalPath(receiver.ctx)) : null,
        categories: fs.readFileSync(snapshotCategoriesPath(receiver.ctx)),
    });
    const encodedPreset = name => {
        const hex = Buffer.from(JSON.stringify(['preset', 'openAI_Settings', name])).toString('hex');
        return `OpenAI Settings/.luker-preset-records/v1/${hex.match(/.{1,120}/g).join('/')}/value.json`;
    };
    const obstructedPresetFiles = () => ({ [encodedPreset('A')]: '{"owned":"DOCUMENT"}', 'OpenAI Settings/A.json/child.txt': 'UNOWNED_CHILD' });
    const presetBytes = receiver => {
        const walk = folder => fs.readdirSync(folder, { encoding: 'buffer' }).map(name => {
            const file = path.join(folder, name.toString('utf8'));
            return { name: name.toString('hex'), ...(fs.statSync(file).isDirectory() ? { entries: walk(file) } : { bytes: fs.readFileSync(file) }) };
        });
        return fs.existsSync(receiver.directories.openAI_Settings) ? walk(receiver.directories.openAI_Settings) : null;
    };

    test.each(['base', 'target'].flatMap(aliasSide => ['same-parent', 'other-parent', 'decoded-presets', 'obstructed-parent'].flatMap(parent => [false, true].map(advanceOnSkip => ({ aliasSide, parent, advanceOnSkip })))))('obstruction cannot hide $aliasSide aliases in $parent with advanceOnSkip=$advanceOnSkip', ({ aliasSide, parent, advanceOnSkip }) => checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `obstruction-${aliasSide}-${parent}-${advanceOnSkip}`), remoteDir: remote.remoteDir, categories: ['characters', 'worlds', 'openai-presets'] });
            const aliases = parent === 'decoded-presets'
                ? { [encodedPreset('B')]: '{"value":"SAME"}', [encodedPreset('b')]: '{"value":"SAME"}' }
                : parent === 'same-parent' ? { 'OpenAI Settings/B.png': 'SAME', 'OpenAI Settings/b.png': 'SAME' }
                    : parent === 'obstructed-parent' ? { 'OpenAI Settings/A.json/B.png': 'SAME', 'OpenAI Settings/A.json/b.png': 'SAME' } : { 'characters/B.png': 'SAME', 'characters/b.png': 'SAME' };
            const baseFiles = { ...obstructedPresetFiles(), ...(aliasSide === 'base' ? aliases : {}) };
            const targetFiles = { ...(aliasSide === 'target' ? aliases : {}), 'worlds/unrelated.json': 'UNRELATED_TARGET' };
            await persistRecovery(receiver, baseFiles, targetFiles, advanceOnSkip);
            receiver.write('worlds/unrelated.json', 'COMPLETE_UNRELATED_ORIGINAL');
            const evidence = async () => ({ ...await recoveryEvidence(receiver), presets: presetBytes(receiver) });
            const before = await evidence();
            const attempts = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                const outcome = await recoverReconcile(receiver.ctx).then(report => ({ report }), error => ({ error }));
                attempts.push({ ...outcome, evidence: await evidence() });
            }
            expect(attempts).toEqual([0, 1].map(() => ({ error: expect.objectContaining({ code: 'SYNC_FS_ALIAS' }), evidence: before })));
        } finally { remote.cleanup(); }
    })());

    test.each([false, true])('an obstruction without aliases retains skipped completion with advanceOnSkip=%s', advanceOnSkip => checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `obstruction-only-${advanceOnSkip}`), remoteDir: remote.remoteDir, categories: ['characters', 'worlds', 'openai-presets'] });
            const pair = await persistRecovery(receiver, obstructedPresetFiles(), { 'worlds/unrelated.json': 'UNRELATED_TARGET' }, advanceOnSkip);
            receiver.write('worlds/unrelated.json', 'COMPLETE_UNRELATED_ORIGINAL');
            const before = liveBytes(receiver);
            expect(await recoverReconcile(receiver.ctx)).toEqual({ ...pair, reconcile: { written: [], deleted: [], alreadyApplied: [], skipped: ['OpenAI Settings/A.json', 'OpenAI Settings/A.json/child.txt'], ignored: [] } });
            expect(liveBytes(receiver)).toEqual(before);
            expect(presetBytes(receiver)).toBeNull();
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBe(advanceOnSkip ? pair.target : pair.base);
            expect(await resolveRefOrNull(receiver.shadow.gitDir, PENDING_REF)).toBeNull();
            expect(readReconcileJournal(receiver.ctx)).toBeNull();
        } finally { remote.cleanup(); }
    })());

    test.each(['case', 'normalization'].flatMap(label => [false, true].flatMap(advanceOnSkip => [false, true].map(unrelatedWrite => ({ label, advanceOnSkip, unrelatedWrite })))))('journal recovery refuses base-only $label aliases before mutation with advanceOnSkip=$advanceOnSkip and unrelatedWrite=$unrelatedWrite', ({ label, advanceOnSkip, unrelatedWrite }) => checked(async () => {
        const observation = insensitive.observations.find(entry => entry.label === label);
        if (!observation.alias) throw new Error(`BLOCKED: required native ${label} alias observation is unavailable`);
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `recovery-${label}-${advanceOnSkip}-${unrelatedWrite}`), remoteDir: remote.remoteDir });
            const original = Buffer.from('COMPLETE_ORIGINAL_BYTES\u0000\ufffd\n');
            const baseFiles = { [`characters/${observation.a}`]: original, [`characters/${observation.b}`]: original };
            const targetFiles = unrelatedWrite ? { 'worlds/unrelated.json': 'COMPLETE_UNRELATED_TARGET' } : {};
            const pair = await persistRecovery(receiver, baseFiles, targetFiles, advanceOnSkip);
            receiver.write(`characters/${observation.a}`, original);
            expect(() => fs.writeFileSync(path.join(receiver.directories.characters, observation.b), 'MUST_NOT_REPLACE', { flag: 'wx' })).toThrow(expect.objectContaining({ code: 'EEXIST' }));
            expect(fs.readdirSync(receiver.directories.characters, { encoding: 'buffer' }).map(name => name.toString('hex'))).toEqual(observation.names);
            if (unrelatedWrite) receiver.write('worlds/unrelated.json', 'COMPLETE_UNRELATED_ORIGINAL');
            const before = await recoveryEvidence(receiver);
            const attempts = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                const outcome = await recoverReconcile(receiver.ctx).then(report => ({ report }), error => ({ error }));
                attempts.push({ ...outcome, evidence: await recoveryEvidence(receiver) });
            }
            expect(attempts).toEqual([0, 1].map(() => ({ error: expect.objectContaining({ code: 'SYNC_FS_ALIAS' }), evidence: before })));
            expect(await bytesOf(receiver.shadow.gitDir, pair.base)).toEqual(Object.fromEntries(Object.entries(baseFiles).map(([rel, bytes]) => [rel, bytes.toString('utf8')])));
            expect(await bytesOf(receiver.shadow.gitDir, pair.target)).toEqual(targetFiles);
            expect(await remoteHead(remote.remoteDir)).toBeNull();
        } finally { remote.cleanup(); }
    })());

    test.each(['alternate-spelling', 'absent-base'])('recovery admits actual deletion destinations for an %s live layout', layout => checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `deletion-${layout}`), remoteDir: remote.remoteDir });
            const baseFiles = layout === 'alternate-spelling' ? { 'characters/a.png': 'ORIGINAL' } : { 'characters/A.png': 'ORIGINAL', 'characters/a.png': 'ORIGINAL' };
            await persistRecovery(receiver, baseFiles, { 'worlds/new.json': 'UNRELATED_TARGET' });
            if (layout === 'alternate-spelling') receiver.write('characters/A.png', 'ORIGINAL');
            const before = await recoveryEvidence(receiver);
            for (let attempt = 0; attempt < 2; attempt++) {
                await expect(recoverReconcile(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
                expect(await recoveryEvidence(receiver)).toEqual(before);
            }
        } finally { remote.cleanup(); }
    })());

    test.each(['case-sensitive', 'case-insensitive'])('compatible %s journal deletion and already-applied replay complete refs and journal', semantics => checked(async () => {
        const fixture = semantics === 'case-sensitive' ? sensitive : insensitive;
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(fixture.root, 'compatible-recovery'), remoteDir: remote.remoteDir });
            const baseFiles = semantics === 'case-sensitive' ? { 'characters/A.png': 'FIRST', 'characters/a.png': 'SECOND' } : { 'characters/A.png': 'FIRST' };
            const pair = await persistRecovery(receiver, baseFiles, { 'worlds/new.json': 'COMPLETE_TARGET' });
            for (const [rel, bytes] of Object.entries(baseFiles)) receiver.write(rel, bytes);
            expect(fs.readdirSync(receiver.directories.characters).sort()).toEqual(Object.keys(baseFiles).map(rel => path.basename(rel)).sort());
            expect(await recoverReconcile(receiver.ctx)).toEqual({ ...pair, reconcile: { written: ['worlds/new.json'], deleted: Object.keys(baseFiles), alreadyApplied: [], skipped: [], ignored: [] } });
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBe(pair.target);
            expect(await resolveRefOrNull(receiver.shadow.gitDir, PENDING_REF)).toBeNull();
            expect(readReconcileJournal(receiver.ctx)).toBeNull();
            expect(fs.readdirSync(receiver.directories.characters)).toEqual([]);
            expect(receiver.read('worlds/new.json')).toBe('COMPLETE_TARGET');
            await git.writeRef({ fs, gitdir: receiver.shadow.gitDir, ref: PENDING_REF, value: pair.target, force: true });
            await writeReconcileJournal({ ...receiver.ctx, ...pair });
            expect(await recoverReconcile(receiver.ctx)).toEqual({ ...pair, reconcile: { written: [], deleted: [], alreadyApplied: [...Object.keys(baseFiles), 'worlds/new.json'], skipped: [], ignored: [] } });
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBe(pair.target);
            expect(await resolveRefOrNull(receiver.shadow.gitDir, PENDING_REF)).toBeNull();
            expect(readReconcileJournal(receiver.ctx)).toBeNull();
            expect(await recoverReconcile(receiver.ctx)).toBeNull();
            expect(receiver.read('worlds/new.json')).toBe('COMPLETE_TARGET');
        } finally { remote.cleanup(); }
    })());

    test('recovery admits compatible base and target sides independently for a file-to-directory change', checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'independent-sides'), remoteDir: remote.remoteDir });
            const pair = await persistRecovery(receiver, { 'characters/item': 'OLD_FILE' }, { 'characters/item/leaf.png': 'NEW_LEAF' });
            receiver.write('characters/item', 'OLD_FILE');
            expect(await recoverReconcile(receiver.ctx)).toEqual({ ...pair, reconcile: { written: ['characters/item/leaf.png'], deleted: ['characters/item'], alreadyApplied: [], skipped: [], ignored: [] } });
            expect(receiver.read('characters/item/leaf.png')).toBe('NEW_LEAF');
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBe(pair.target);
            expect(await resolveRefOrNull(receiver.shadow.gitDir, PENDING_REF)).toBeNull();
            expect(readReconcileJournal(receiver.ctx)).toBeNull();
        } finally { remote.cleanup(); }
    }));

    test('recovery does not admit identities from disabled categories', checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'disabled-recovery'), remoteDir: remote.remoteDir, categories: ['worlds'] });
            await persistRecovery(receiver, { 'characters/A.png': 'KEEP', 'characters/a.png': 'KEEP', 'worlds/old.json': 'OLD' }, { 'worlds/new.json': 'NEW' });
            receiver.write('characters/A.png', 'KEEP');
            receiver.write('worlds/old.json', 'OLD');
            const before = liveBytes(receiver).characters;
            const result = await recoverReconcile(receiver.ctx);
            expect(result.reconcile).toEqual({ written: ['worlds/new.json'], deleted: ['worlds/old.json'], alreadyApplied: [], skipped: [], ignored: [] });
            expect(liveBytes(receiver).characters).toEqual(before);
        } finally { remote.cleanup(); }
    }));

    test('recovery keeps base paths ignored when the target declares hostile entries', checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'hostile-recovery'), remoteDir: remote.remoteDir });
            const { base } = await persistRecovery(receiver, { 'characters/A.png': 'KEEP', 'characters/a.png': 'KEEP' }, {});
            const oid = await writeBlob(receiver.shadow.gitDir, '../outside');
            const tree = await writeRawTree(receiver.shadow.gitDir, [{ mode: '40000', name: 'characters', oid: await writeRawTree(receiver.shadow.gitDir, ['A.png', 'a.png'].map(name => ({ mode: '120000', name, oid }))) }]);
            const target = await commitTree(receiver.shadow.gitDir, tree, [base]);
            await git.writeRef({ fs, gitdir: receiver.shadow.gitDir, ref: PENDING_REF, value: target, force: true });
            await writeReconcileJournal({ ...receiver.ctx, base, target });
            receiver.write('characters/A.png', 'KEEP');
            const before = liveBytes(receiver);
            expect(await recoverReconcile(receiver.ctx)).toEqual({ base, target, reconcile: { written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: ['characters/A.png', 'characters/a.png'] } });
            expect(liveBytes(receiver)).toEqual(before);
        } finally { remote.cleanup(); }
    }));

    test.each(['same', 'different'])('case aliases with %s bytes cannot become propagated deletions', mode => checked(async () => {
        const remote = await makeRemote();
        try {
            const source = openDevice({ userRoot: path.join(sensitive.root, `source-${mode}`), remoteDir: remote.remoteDir });
            source.write('characters/A.png', 'FIRST');
            source.write('characters/a.png', mode === 'same' ? 'FIRST' : 'SECOND');
            await runSyncCycle(source.ctx);
            const original = await remoteHead(remote.remoteDir);
            const expected = { 'characters/A.png': 'FIRST', 'characters/a.png': mode === 'same' ? 'FIRST' : 'SECOND' };
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `receiver-${mode}`), remoteDir: remote.remoteDir });
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBeNull();
            expect(fs.readdirSync(receiver.directories.characters)).toEqual([]);
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            await runSyncCycle(source.ctx);
            expect(await remoteHead(remote.remoteDir)).toBe(original);
            expect(await bytesOf(source.shadow.gitDir, original)).toEqual(expected);
            expect(source.read('characters/A.png')).toBe('FIRST');
            expect(source.read('characters/a.png')).toBe(expected['characters/a.png']);
            const compatible = openDevice({ userRoot: path.join(sensitive.root, `compatible-${mode}`), remoteDir: remote.remoteDir });
            await runSyncCycle(compatible.ctx);
            await runSyncCycle(compatible.ctx);
            await runSyncCycle(source.ctx);
            expect(await bytesOf(compatible.shadow.gitDir, await remoteHead(remote.remoteDir))).toEqual(expected);
        } finally { remote.cleanup(); }
    })());

    test.each(['same', 'different'])('raw normalization aliases with %s bytes preserve their original Git history', mode => checked(async () => {
        const remote = await makeRemote();
        try {
            const expected = { 'characters/\u00e9.png': 'FIRST', 'characters/e\u0301.png': mode === 'same' ? 'FIRST' : 'SECOND' };
            const original = await commitFiles(remote.remoteDir, expected);
            await git.writeRef({ fs, gitdir: remote.remoteDir, ref: MAIN_REF, value: original, force: true });
            const receiver = openDevice({ userRoot: path.join(insensitive.root, `normalization-${mode}`), remoteDir: remote.remoteDir });
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBeNull();
            expect(await remoteHead(remote.remoteDir)).toBe(original);
            expect(await bytesOf(receiver.shadow.gitDir, original)).toEqual(expected);
            expect(fs.readdirSync(receiver.directories.characters)).toEqual([]);
        } finally { remote.cleanup(); }
    })());

    test('an existing aliased main cannot snapshot a missing spelling as a deletion', checked(async () => {
        const remote = await makeRemote();
        try {
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'existing-main'), remoteDir: remote.remoteDir });
            const shadow = await ensureShadowRepo({ userRoot: receiver.userRoot, peerId: 'remote' });
            const expected = { 'characters/A.png': 'SAME', 'characters/a.png': 'SAME' };
            const original = await commitFiles(shadow.gitDir, expected);
            await git.writeRef({ fs, gitdir: shadow.gitDir, ref: MAIN_REF, value: original, force: true });
            receiver.write('characters/A.png', 'SAME');
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            expect(await resolveRefOrNull(shadow.gitDir, MAIN_REF)).toBe(original);
            expect(await bytesOf(shadow.gitDir, original)).toEqual(expected);
            expect(await remoteHead(remote.remoteDir)).toBeNull();
        } finally { remote.cleanup(); }
    }));

    test('distinct directory spellings cannot collapse even when their leaves differ', checked(async () => {
        const remote = await makeRemote();
        try {
            const expected = { 'characters/A/one.png': 'ONE', 'characters/a/two.png': 'TWO' };
            const original = await commitFiles(remote.remoteDir, expected);
            await git.writeRef({ fs, gitdir: remote.remoteDir, ref: MAIN_REF, value: original, force: true });
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'directory-alias'), remoteDir: remote.remoteDir });
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            expect(fs.readdirSync(receiver.directories.characters)).toEqual([]);
            expect(await bytesOf(receiver.shadow.gitDir, original)).toEqual(expected);
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBeNull();
        } finally { remote.cleanup(); }
    }));

    test('distinct encoded preset paths are checked against their decoded native destinations', checked(async () => {
        const remote = await makeRemote();
        try {
            const encoded = name => {
                const hex = Buffer.from(JSON.stringify(['preset', 'openAI_Settings', name])).toString('hex');
                return `OpenAI Settings/.luker-preset-records/v1/${hex.match(/.{1,120}/g).join('/')}/value.json`;
            };
            const expected = { [encoded('A')]: '{"value":"FIRST"}', [encoded('a')]: '{"value":"SECOND"}' };
            const original = await commitFiles(remote.remoteDir, expected);
            await git.writeRef({ fs, gitdir: remote.remoteDir, ref: MAIN_REF, value: original, force: true });
            const receiver = openDevice({ userRoot: path.join(insensitive.root, 'decoded-presets'), remoteDir: remote.remoteDir, categories: ['openai-presets'] });
            await expect(runSyncCycle(receiver.ctx)).rejects.toMatchObject({ code: 'SYNC_FS_ALIAS' });
            expect(await resolveRefOrNull(receiver.shadow.gitDir, MAIN_REF)).toBeNull();
            expect(fs.existsSync(receiver.directories.openAI_Settings)).toBe(false);
            expect(await bytesOf(receiver.shadow.gitDir, original)).toEqual(expected);
            expect(await remoteHead(remote.remoteDir)).toBe(original);
        } finally { remote.cleanup(); }
    }));

    test('separately named hard links remain distinct entries through another snapshot', checked(async () => {
        const remote = await makeRemote();
        try {
            const source = openDevice({ userRoot: path.join(sensitive.root, 'hard-links'), remoteDir: remote.remoteDir });
            source.write('characters/first.png', 'SHARED');
            fs.linkSync(path.join(source.directories.characters, 'first.png'), path.join(source.directories.characters, 'second.png'));
            await runSyncCycle(source.ctx);
            await runSyncCycle(source.ctx);
            expect(await bytesOf(source.shadow.gitDir, await remoteHead(remote.remoteDir))).toEqual({ 'characters/first.png': 'SHARED', 'characters/second.png': 'SHARED' });
            expect(fs.readdirSync(source.directories.characters).sort()).toEqual(['first.png', 'second.png']);
            expect(fs.readdirSync(source.userRoot).some(name => name.startsWith('.luker-staging-identity-'))).toBe(false);
        } finally { remote.cleanup(); }
    }));
});

test('disabling a required native fixture fails its real child invocation as blocked', () => {
    const moduleUrl = new URL('../_lib/real-filesystems.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const {createRealFilesystemFixture} = await import(${JSON.stringify(moduleUrl)}); await createRealFilesystemFixture({semantics:'case-sensitive'});`], { encoding: 'utf8', env: { ...process.env, LUKER_DISABLE_NATIVE_FS_TESTS: '1' } });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('BLOCKED: required native filesystem fixture is disabled');
});
