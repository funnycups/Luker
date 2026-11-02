import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import git from 'isomorphic-git';

import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { blobOidOf, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { findMergeBaseOrNull, mergeCommitTrees } from '../../../src/sync/pipeline/merge.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries, serializeEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { authorForDevice } from '../../../src/sync/pipeline/commit-provenance.js';
import { formatForkTimestamp } from '../../../src/sync/pipeline/chat-fork.js';
import { subRecordParentPath } from '../../../src/sync/materialize.js';
import { write as writeCard } from '../../../src/character-card-parser.js';
import { makeUserDirs } from '../_lib/user-dirs.js';
import { commitFiles } from '../_lib/commits.js';

const SEED_PNG = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../default/content/default_Seraphina.png'));
const NOW = new Date('2026-10-13T09:05:00.000Z');
const oid = content => blobOidOf(Buffer.from(content));
const CHAT = 'chats/Seraphina/c1.jsonl';
const header = JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} });
const record = (extra = {}) => ({ kept: oid('k'), ours: oid('o'), theirs: oid('t'), oursDevice: 'X', theirsDevice: 'Y', mergeParents: ['a'.repeat(40), 'b'.repeat(40)], createdAt: '2026-10-01T00:00:00.000Z', ...extra });

describe('conflict policy', () => {
    let userRoot;
    let gitdir;
    let policy;
    let directories;
    beforeEach(async () => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-policy-'));
        ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
        directories = makeUserDirs(userRoot);
        policy = createConflictPolicy({ directories, localDevice: 'Desk', remoteDevice: 'Phone', now: () => NOW });
    });
    afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

    async function run(baseFiles, oursFiles, theirsFiles, extra = {}) {
        const base = await commitFiles(gitdir, baseFiles);
        const ours = await commitFiles(gitdir, oursFiles, [base], authorForDevice('Desk'));
        const theirs = await commitFiles(gitdir, theirsFiles, [base], authorForDevice('Phone'));
        expect(await findMergeBaseOrNull({ gitdir, ours, theirs })).toBe(base);
        const merged = await mergeCommitTrees({ gitdir, base, ours, theirs });
        const out = await policy({ gitdir, base, ours, theirs, files: merged.files, conflicts: merged.conflicts, ...extra });
        return { ...out, ours, theirs };
    }
    const records = files => readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' });
    const notices = files => readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' });

    test('observer-side roles do not override immutable origin labels', async () => {
        const out = await run({ 'worlds/w.json': 'B', [CHAT]: `${header}\nbase` }, { 'worlds/w.json': 'O', [CHAT]: `${header}\nours` }, { 'worlds/w.json': 'T', [CHAT]: `${header}\ntheirs` }, { oursIsLocal: false });
        expect((await records(out.files))['worlds/w.json']).toMatchObject({ ours: oid('O'), oursDevice: 'Desk', theirs: oid('T'), theirsDevice: 'Phone' });
        expect(Object.values(await notices(out.files))).toEqual([expect.objectContaining({ kind: 'fork', device: 'Phone' })]);
    });

    test('without a clock the records carry the time of the newer side', async () => {
        const clockless = createConflictPolicy({ directories, localDevice: 'Desk', remoteDevice: 'Phone' });
        const base = await commitFiles(gitdir, { 'worlds/w.json': 'B' });
        const ours = await commitFiles(gitdir, { 'worlds/w.json': 'O' }, [base]);
        const theirs = await commitFiles(gitdir, { 'worlds/w.json': 'T' }, [base]);
        const merged = await mergeCommitTrees({ gitdir, base, ours, theirs });
        const out = await clockless({ gitdir, base, ours, theirs, files: merged.files, conflicts: merged.conflicts });
        const times = await Promise.all([ours, theirs].map(async commitOid => (await git.readCommit({ fs: atomicFs, gitdir, oid: commitOid })).commit.committer.timestamp));
        expect((await records(out.files))['worlds/w.json'].createdAt).toBe(new Date(Math.max(...times) * 1000).toISOString());
    });

    test('a non-chat conflict gets a record with the provisional version as kept', async () => {
        const out = await run({ 'worlds/w.json': 'B' }, { 'worlds/w.json': 'O' }, { 'worlds/w.json': 'T' });
        expect(await records(out.files)).toEqual({ 'worlds/w.json': {
            kept: oid('O'), ours: oid('O'), theirs: oid('T'), oursDevice: 'Desk', theirsDevice: 'Phone', mergeParents: [out.ours, out.theirs], createdAt: NOW.toISOString(),
        } });
        expect(out.conflicts.map(c => c.filepath)).toEqual(['worlds/w.json']);
    });

    test('a delete-by-us conflict records kept null', async () => {
        const out = await run({ 'worlds/w.json': 'B' }, {}, { 'worlds/w.json': 'T' });
        expect((await records(out.files))['worlds/w.json']).toMatchObject({ kept: null, ours: null, theirs: oid('T') });
    });

    test('a chat conflict forks theirs and adds a notice instead of a record', async () => {
        const out = await run(
            { 'chats/Seraphina/c1.jsonl': `${header}\nB` },
            { 'chats/Seraphina/c1.jsonl': `${header}\nO` },
            { 'chats/Seraphina/c1.jsonl': `${header}\nT` },
        );
        const branchPath = `chats/Seraphina/c1 - Sync conflict Phone ${formatForkTimestamp(NOW)}.jsonl`;
        expect(out.files.has(branchPath)).toBe(true);
        expect(Object.keys(await notices(out.files))).toEqual([branchPath]);
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('a companion-only conflict forks the whole chat', async () => {
        const out = await run(
            { 'chats/S/c.jsonl': header, 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl': header, 'chats/S/c.luker-state.mg.json': 'S1' },
            { 'chats/S/c.jsonl': header, 'chats/S/c.luker-state.mg.json': 'S2' },
        );
        const keys = [...out.files.keys()].filter(k => k.includes('Sync conflict')).sort();
        expect(keys).toHaveLength(2);
        expect(keys[0].endsWith('.jsonl')).toBe(true);
        expect(out.files.get(keys[1]).oid).toBe(oid('S2'));
    });

    test('a companion conflict whose chat theirs lacks gets a record', async () => {
        const out = await run(
            { 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.luker-state.mg.json': 'S1' },
            { 'chats/S/c.luker-state.mg.json': 'S2' },
        );
        expect((await records(out.files))['chats/S/c.luker-state.mg.json']).toMatchObject({ kept: oid('S1'), ours: oid('S1'), theirs: oid('S2') });
        expect(out.conflicts.map(c => c.filepath)).toEqual(['chats/S/c.luker-state.mg.json']);
        expect(await notices(out.files)).toEqual({});
    });

    test('a chat theirs deleted and ours changed is kept whole with a restored notice naming ours as the keeper', async () => {
        const out = await run(
            { 'chats/S/c.jsonl': `${header}\nB`, 'chats/S/c.luker-state.mg.json': 'S0' },
            { 'chats/S/c.jsonl': `${header}\nO`, 'chats/S/c.luker-state.mg.json': 'S0' },
            {},
        );
        expect(out.files.get('chats/S/c.jsonl').oid).toBe(oid(`${header}\nO`));
        expect(out.files.get('chats/S/c.luker-state.mg.json').oid).toBe(oid('S0'));
        expect(await notices(out.files)).toEqual({ 'chats/S/c.jsonl': { kind: 'restored', device: 'Desk', deletedBy: 'Phone', createdAt: NOW.toISOString(), target: { kind: 'character', avatar: 'S.png', name: 'c' } } });
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('a chat ours deleted and theirs changed is restored from theirs although no companion survived', async () => {
        const out = await run({ 'chats/S/c.jsonl': `${header}\nB` }, {}, { 'chats/S/c.jsonl': `${header}\nT` });
        expect([...out.files.keys()].filter(k => k.includes('Sync conflict'))).toEqual([]);
        expect(out.files.get('chats/S/c.jsonl').oid).toBe(oid(`${header}\nT`));
        expect(await notices(out.files)).toEqual({ 'chats/S/c.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 'Desk', createdAt: NOW.toISOString(), target: { kind: 'character', avatar: 'S.png', name: 'c' } } });
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('a group chat one side deleted stays listed on its group when the other side kept it', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1', 'gc2'], date_last_chat: 1, ...extra }, null, 4);
        const out = await run(
            { 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nB`, 'group chats/gc2.jsonl': header },
            { 'groups/g1.json': group({ date_last_chat: 5 }), 'group chats/gc1.jsonl': `${header}\nO`, 'group chats/gc2.jsonl': header },
            { 'groups/g1.json': group({ chat_id: 'gc2', chats: ['gc2'], date_last_chat: 3 }), 'group chats/gc2.jsonl': header },
        );
        expect(JSON.parse((await readBlobBytes({ gitdir, oid: out.files.get('groups/g1.json').oid })).toString('utf8'))).toEqual({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc2', 'gc1'], date_last_chat: 5 });
        expect(out.files.get('group chats/gc1.jsonl').oid).toBe(oid(`${header}\nO`));
        expect(await notices(out.files)).toEqual({ 'group chats/gc1.jsonl': { kind: 'restored', device: 'Desk', deletedBy: 'Phone', createdAt: NOW.toISOString(), target: { kind: 'group', groupId: 'g1', name: 'gc1' } } });
        expect(await records(out.files)).toEqual({});
    });

    test('a group deleted with its chat on one side comes back with the chat the other side kept', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 1, ...extra }, null, 4);
        // Each role order, with the keeping side changing the group file or not.
        for (const [ours, theirs, device, deletedBy] of [
            [{}, { 'groups/g1.json': group({ date_last_chat: 5 }), 'group chats/gc1.jsonl': `${header}\nT` }, 'Phone', 'Desk'],
            [{}, { 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nT` }, 'Phone', 'Desk'],
            [{ 'groups/g1.json': group({ date_last_chat: 5 }), 'group chats/gc1.jsonl': `${header}\nT` }, {}, 'Desk', 'Phone'],
            [{ 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nT` }, {}, 'Desk', 'Phone'],
        ]) {
            const out = await run({ 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nB` }, ours, theirs);
            const keeper = Object.keys(ours).length > 0 ? ours : theirs;
            expect(out.files.get('groups/g1.json').oid).toBe(oid(keeper['groups/g1.json']));
            expect(out.files.get('group chats/gc1.jsonl').oid).toBe(oid(`${header}\nT`));
            expect(await notices(out.files)).toEqual({ 'group chats/gc1.jsonl': { kind: 'restored', device, deletedBy, createdAt: NOW.toISOString(), target: { kind: 'group', groupId: 'g1', name: 'gc1' } } });
            expect(await records(out.files)).toEqual({});
            expect(out.conflicts).toEqual([]);
        }
    });

    test('a group put back with its restored chat lists only chats that exist and opens the restored one', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 1, ...extra }, null, 4);
        const base = { 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nB`, 'group chats/gc2.jsonl': header };
        // One side deleted the group with both chats; the other edited gc1 only.
        for (const [ours, theirs] of [[{}, { ...base, 'group chats/gc1.jsonl': `${header}\nT` }], [{ ...base, 'group chats/gc1.jsonl': `${header}\nT` }, {}]]) {
            const out = await run(base, ours, theirs);
            expect(out.files.has('group chats/gc2.jsonl')).toBe(false);
            expect(JSON.parse((await readBlobBytes({ gitdir, oid: out.files.get('groups/g1.json').oid })).toString('utf8'))).toEqual({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 1 });
            expect(await records(out.files)).toEqual({});
        }
    });

    test('a group listing a chat never saved keeps that id and its chat_id', async () => {
        // createGroup lists its chat before the chat file exists.
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 1, ...extra }, null, 4);
        const out = await run({ 'groups/g1.json': group() }, { 'groups/g1.json': group({ name: 'North Watch', date_last_chat: 5 }) }, { 'groups/g1.json': group({ date_last_chat: 7, fav: true }) });
        expect(JSON.parse((await readBlobBytes({ gitdir, oid: out.files.get('groups/g1.json').oid })).toString('utf8'))).toEqual({ id: 'g1', name: 'North Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 7, fav: true });
        expect(await records(out.files)).toEqual({});
    });

    test('group file bookkeeping changed on both sides merges without a record', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 1, ...extra }, null, 4);
        const out = await run(
            { 'groups/g1.json': group() },
            { 'groups/g1.json': group({ date_last_chat: 5 }) },
            { 'groups/g1.json': group({ chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 7 }) },
        );
        expect(out.files.get('groups/g1.json').oid).toBe(oid(JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 7 }, null, 4)));
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('a group file deleted on one side still gets a record', async () => {
        const group = JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 1 }, null, 4);
        const out = await run({ 'groups/g1.json': group }, { 'groups/g1.json': group.replace('"date_last_chat": 1', '"date_last_chat": 2') }, {});
        expect(Object.keys(await records(out.files))).toEqual(['groups/g1.json']);
    });

    test('character cards that differ only in the last chat merge without a record', async () => {
        const png = chat => writeCard(SEED_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Seraphina', data: { name: 'Seraphina' }, ...(chat ? { chat } : {}) }));
        const out = await run({ 'characters/Seraphina.png': png() }, { 'characters/Seraphina.png': png('Forest Path') }, { 'characters/Seraphina.png': png('River Ford') });
        expect(out.files.get('characters/Seraphina.png').oid).toBe(blobOidOf(png('Forest Path')));
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('character cards edited on both sides beyond the last chat get a record', async () => {
        const png = (description, chat) => writeCard(SEED_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Seraphina', data: { name: 'Seraphina', description }, chat }));
        const out = await run({ 'characters/Seraphina.png': png('base', 'a') }, { 'characters/Seraphina.png': png('ours', 'b') }, { 'characters/Seraphina.png': png('theirs', 'c') });
        expect((await records(out.files))['characters/Seraphina.png']).toMatchObject({ kept: blobOidOf(png('ours', 'b')), ours: blobOidOf(png('ours', 'b')), theirs: blobOidOf(png('theirs', 'c')) });
    });

    test('conflicting record files merge with the entry rule and are never reported', async () => {
        const out = await run(
            { [CONFLICTS_PATH]: serializeEntries({ 'worlds/a.json': record() }) },
            { [CONFLICTS_PATH]: serializeEntries({ 'worlds/a.json': record(), 'worlds/b.json': record() }) },
            { [CONFLICTS_PATH]: serializeEntries({ 'worlds/c.json': record() }) },
        );
        expect(Object.keys(await records(out.files)).sort()).toEqual(['worlds/b.json', 'worlds/c.json']);
        expect(out.conflicts).toEqual([]);
    });

    test('a resolved entry stays resolved after merging a device that still lists it', async () => {
        const listed = serializeEntries({ 'worlds/p.json': record() });
        const out = await run(
            { [CONFLICTS_PATH]: listed, [NOTICES_PATH]: serializeEntries({}), 'worlds/x.json': '1' },
            { 'worlds/x.json': '2' },
            { [CONFLICTS_PATH]: listed, [NOTICES_PATH]: serializeEntries({ 'chats/S/n.jsonl': { chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target: { kind: 'character', avatar: 'S.png', name: 'n' } } }), 'worlds/x.json': '3' },
        );
        expect((await records(out.files))['worlds/p.json']).toBeUndefined();
    });

    test('opposite resolutions produce a fresh record', async () => {
        const out = await run(
            { [CONFLICTS_PATH]: serializeEntries({ 'worlds/p.json': record() }), 'worlds/p.json': 'X0' },
            { 'worlds/p.json': 'X1' },
            { 'worlds/p.json': 'Y1' },
        );
        expect((await records(out.files))['worlds/p.json']).toMatchObject({ kept: oid('X1'), ours: oid('X1'), theirs: oid('Y1'), createdAt: NOW.toISOString() });
    });

    test('a group file record keeps the blob the fork wrote', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], ...extra }, null, 4);
        const out = await run(
            { 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nB` },
            { 'groups/g1.json': group({ name: 'Glade' }), 'group chats/gc1.jsonl': `${header}\nO` },
            { 'groups/g1.json': group({ name: 'Watch' }), 'group chats/gc1.jsonl': `${header}\nT` },
        );
        const final = out.files.get('groups/g1.json');
        expect((await records(out.files))['groups/g1.json'].kept).toBe(final.oid);
        expect(JSON.parse((await readBlobBytes({ gitdir, oid: final.oid })).toString('utf8')).chats).toHaveLength(2);
    });

    test('a group file record keeps the parents\' own blobs while kept lists the branch', async () => {
        const group = extra => JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], ...extra }, null, 4);
        const out = await run(
            { 'groups/g1.json': group(), 'group chats/gc1.jsonl': `${header}\nB` },
            { 'groups/g1.json': group({ name: 'Glade' }), 'group chats/gc1.jsonl': `${header}\nO` },
            { 'groups/g1.json': group({ name: 'Watch' }), 'group chats/gc1.jsonl': `${header}\nT` },
        );
        const branch = `gc1 - Sync conflict Phone ${formatForkTimestamp(NOW)}`;
        const record = (await records(out.files))['groups/g1.json'];
        expect(record.ours).toBe(oid(group({ name: 'Glade' })));
        expect(record.theirs).toBe(oid(group({ name: 'Watch' })));
        const kept = JSON.parse((await readBlobBytes({ gitdir, oid: record.kept })).toString('utf8'));
        expect(kept).toMatchObject({ name: 'Glade', chats: ['gc1', branch] });
    });

    test('an image-metadata.json both fresh installs wrote is merged without a record', async () => {
        const index = images => JSON.stringify({ version: 2, images, folders: [] }, null, 4);
        const ours = await commitFiles(gitdir, { 'image-metadata.json': index({ 'backgrounds/__transparent.png': { addedTimestamp: 500, folderIds: [] } }) });
        const theirs = await commitFiles(gitdir, { 'image-metadata.json': index({ 'backgrounds/__transparent.png': { addedTimestamp: 300, folderIds: [] }, 'backgrounds/glade.png': { addedTimestamp: 900, folderIds: [] } }) });
        const merged = await mergeCommitTrees({ gitdir, base: null, ours, theirs });
        expect(merged.conflicts.map(c => c.filepath)).toEqual(['image-metadata.json']);
        const out = await policy({ gitdir, base: null, ours, theirs, files: merged.files, conflicts: merged.conflicts });
        const bytes = (await readBlobBytes({ gitdir, oid: out.files.get('image-metadata.json').oid })).toString('utf8');
        expect(bytes).toBe(index({ 'backgrounds/__transparent.png': { addedTimestamp: 300, folderIds: [] }, 'backgrounds/glade.png': { addedTimestamp: 900, folderIds: [] } }));
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('an image both sides moved to different folders keeps the merged index and gets a record', async () => {
        const folders = [{ id: 'f1', name: 'Dawn', thumbnailFile: '' }, { id: 'f2', name: 'Dusk', thumbnailFile: '' }, { id: 'f3', name: 'Noon', thumbnailFile: '' }];
        const index = (folderIds, extra = {}) => JSON.stringify({ version: 2, images: { 'backgrounds/a.png': { addedTimestamp: 1, folderIds }, ...extra }, folders }, null, 4);
        const out = await run(
            { 'image-metadata.json': index(['f1']) },
            { 'image-metadata.json': index(['f2']) },
            { 'image-metadata.json': index(['f3'], { 'backgrounds/b.png': { addedTimestamp: 2, folderIds: [] } }) },
        );
        const record = (await records(out.files))['image-metadata.json'];
        expect(record).toMatchObject({ ours: oid(index(['f2'])), theirs: oid(index(['f3'], { 'backgrounds/b.png': { addedTimestamp: 2, folderIds: [] } })) });
        expect(JSON.parse((await readBlobBytes({ gitdir, oid: record.kept })).toString('utf8')).images).toEqual({
            'backgrounds/a.png': { addedTimestamp: 1, folderIds: ['f2'] },
            'backgrounds/b.png': { addedTimestamp: 2, folderIds: [] },
        });
    });

    test('a stats.json conflict is merged without a record', async () => {
        const stats = value => JSON.stringify({ timestamp: value, S: { user_word_count: value } });
        const out = await run({ 'stats.json': stats(1) }, { 'stats.json': stats(5) }, { 'stats.json': stats(7) });
        expect(JSON.parse((await readBlobBytes({ gitdir, oid: out.files.get('stats.json').oid })).toString('utf8'))).toEqual({ S: { user_word_count: 7 }, timestamp: 7 });
        expect(await records(out.files)).toEqual({});
        expect(out.conflicts).toEqual([]);
    });

    test('a chat ours deleted and the merge restored for a surviving companion is kept whole without a branch', async () => {
        const base = await commitFiles(gitdir, { 'chats/S/c.jsonl': `${header}\nB`, 'chats/S/c.luker-state.mg.json': 'S0' });
        const ours = await commitFiles(gitdir, { 'worlds/w.json': 'W' }, [base], authorForDevice('Desk'));
        const theirs = await commitFiles(gitdir, { 'chats/S/c.jsonl': `${header}\nT`, 'chats/S/c.luker-state.mg.json': 'S1', 'chats/S/c.luker-state.new.json': 'N' }, [base], authorForDevice('Phone'));
        const merged = await mergeCommitTrees({ gitdir, base, ours, theirs, parentOfSubRecord: relPath => subRecordParentPath(directories, relPath) });
        expect(merged.files.get('chats/S/c.jsonl').oid).toBe(oid(`${header}\nT`));
        const out = await policy({ gitdir, base, ours, theirs, files: merged.files, conflicts: merged.conflicts });
        expect([...out.files.keys()].filter(k => k.includes('Sync conflict'))).toEqual([]);
        expect(out.files.get('chats/S/c.jsonl').oid).toBe(oid(`${header}\nT`));
        expect(out.files.get('chats/S/c.luker-state.mg.json').oid).toBe(oid('S1'));
        expect(out.files.get('chats/S/c.luker-state.new.json').oid).toBe(oid('N'));
        expect(await notices(out.files)).toEqual({ 'chats/S/c.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 'Desk', createdAt: NOW.toISOString(), target: { kind: 'character', avatar: 'S.png', name: 'c' } } });
        expect(out.conflicts).toEqual([]);
    });

    test('a restored group chat notice points at the owning group', async () => {
        const group = JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'] }, null, 4);
        const base = await commitFiles(gitdir, { 'groups/g1.json': group, 'group chats/gc1.jsonl': `${header}\nB` });
        const ours = await commitFiles(gitdir, { 'groups/g1.json': group }, [base], authorForDevice('Desk'));
        const theirs = await commitFiles(gitdir, { 'groups/g1.json': group, 'group chats/gc1.jsonl': `${header}\nT`, 'group chats/gc1.luker-state.new.json': 'N' }, [base], authorForDevice('Phone'));
        const merged = await mergeCommitTrees({ gitdir, base, ours, theirs, parentOfSubRecord: relPath => subRecordParentPath(directories, relPath) });
        const out = await policy({ gitdir, base, ours, theirs, files: merged.files, conflicts: merged.conflicts });
        expect(await notices(out.files)).toEqual({ 'group chats/gc1.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 'Desk', createdAt: NOW.toISOString(), target: { kind: 'group', groupId: 'g1', name: 'gc1' } } });
    });
});
