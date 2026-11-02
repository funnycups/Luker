import { beforeAll, afterAll, afterEach, describe, expect, test } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from '../../e2e/_lib/s3-container.js';
import { CONTRACT_HARNESSES } from '../_lib/required-engines.js';
import { startLanDevice } from '../_lib/lan-devices.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { readRegistry } from '../../../src/sync/state.js';
import { readSqlRecordValue, writeSqlRecordValue, describeSqlRecordPath } from '../../../src/sync/materialize.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { readCommitFiles, readBlobBytes } from '../../../src/sync/pipeline/git-tree.js';
import { reviewedChoice } from '../_lib/conflict-choices.js';

let storage, sdk;
const devices = [];
beforeAll(async () => {
    storage = await startRustfsContainer();
    sdk = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: true, maxAttempts: 1,
        credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
}, 240_000);
afterEach(async () => { for (const d of devices.splice(0)) { await d.close(); await d.h.cleanup(); } });
afterAll(async () => { sdk?.destroy(); await storage?.stop(); });

async function device(make, settings) {
    const h = await make();
    const d = await startLanDevice({ makeEngine: () => h.engine });
    d.h = h; devices.push(d);
    const created = await d.call('POST', '/backends/s3', { body: { label: 'SQL cloud', categories: ['worlds', 'chats', 'openai-presets'],
        passphrase: 'Task14 SQL integration phrase', s3: settings } });
    expect(created.status).toBe(201);
    d.id = created.body.backendId;
    d.run = async () => { const result = await syncService.trigger(d.owner, d.id, 'manual'); expect(result.ok).toBe(true); return result; };
    d.readRecord = record => h.engine.withTransaction(d.handle, tx => readSqlRecordValue(tx, d.handle, record));
    d.writeRecord = (record, value) => h.engine.withTransaction(d.handle, tx => writeSqlRecordValue(tx, d.handle, record, value));
    d.gitdir = getShadowPaths({ userRoot: d.userRoot, peerId: d.id }).gitDir;
    d.files = async () => readCommitFiles({ gitdir: d.gitdir, commitOid: await git.resolveRef({ fs, gitdir: d.gitdir, ref: 'refs/heads/main' }) });
    await d.run();
    return d;
}

async function pair(make) {
    const bucket = `sql-records-${randomBytes(8).toString('hex')}`;
    await sdk.send(new CreateBucketCommand({ Bucket: bucket }));
    const settings = { ...storage, bucket, prefix: 'records', forcePathStyle: true };
    // Only the actual settings accepted by the route are submitted.
    delete settings.stop;
    const a = await device(make, settings), b = await device(make, settings);
    return { a, b };
}

const state = { kind: 'preset-state', dirKey: 'openAI_Settings', name: 'missing', namespace: 'notes' };
const preset = { kind: 'preset', dirKey: 'openAI_Settings', name: 'missing' };
const complete = { recoverable: true, chapters: [{ name: 'Dawn', text: 'Silver spring' }, { name: 'Dusk', text: 'Birch stones' }], selected: 'Dawn' };
const chat = { kind: 'chat', charDir: null, name: 'kept', isGroup: true };
const chatValue = { header: { user_name: 'User', character_name: 'Group', chat_metadata: { integrity: 'task14-sql' } }, body: [{ name: 'User', is_user: true, mes: 'Complete original group chat' }] };

describe.each(CONTRACT_HARNESSES.filter(h => h.name !== 'FsEngine'))('S3 SQL records — $name', ({ make }) => {
    test('orphan state and accepted names survive real S3 snapshots, pull and conflict choice without a preset parent', async () => {
        const { a, b } = await pair(make);
        await a.writeRecord(state, complete);
        for (const name of ['.chapter', 'chapter..draft']) await a.writeRecord({ kind: 'world', name }, { entries: {}, name });
        await a.run(); await b.run();
        await a.writeRecord(state, { ...complete, selected: 'Dusk' });
        await b.writeRecord(state, { ...complete, selected: 'Local' });
        await a.run(); await b.run();
        const pending = await b.call('GET', '/status');
        const rel = 'OpenAI Settings/missing.luker-state.notes.json';
        const conflict = pending.body.conflicts.find(row => row.path === rel);
        expect(conflict).toBeTruthy();
        const wanted = { ...complete, selected: 'Dusk' };
        const ours = JSON.parse((await readBlobBytes({ gitdir: b.gitdir, oid: conflict.ours })).toString());
        const choice = ours.selected === 'Dusk' ? 'ours' : 'theirs';
        expect(await b.call('POST', '/conflicts/resolve', { body: [reviewedChoice(conflict, choice)] })).toMatchObject({ status: 200, body: { ok: true, results: [{ applied: true, committedBackends: [b.id] }] } });
        await b.run(); await a.run();
        for (const d of [a, b]) {
            await d.run();
            expect(await d.readRecord(state)).toEqual(wanted);
            expect(await d.readRecord(preset)).toBeNull();
            const files = await d.files();
            expect(JSON.parse((await readBlobBytes({ gitdir: d.gitdir, oid: files.get(rel).oid })).toString())).toEqual(wanted);
            expect(files.has('OpenAI Settings/missing.json')).toBe(false);
            for (const name of ['.chapter', 'chapter..draft']) {
                expect(await d.readRecord({ kind: 'world', name })).toEqual({ entries: {}, name });
                expect(files.has(`worlds/${name}.json`)).toBe(true);
            }
            for (const rel of ['worlds/../escape.json', 'worlds/.git/escape.json', 'worlds/nested/../../escape.json']) expect(describeSqlRecordPath(d.directories, rel)).toBeNull();
            expect((await readRegistry({ userRoot: d.userRoot })).backends[d.id].lastSync.error).toBeNull();
        }
    }, 120_000);

    test.each([[false, false], [false, true], [true, false], [true, true]])('forward Undo retains group ownership through source snapshots, existing group=%s edited chat=%s', async (existing, editChat) => {
        const { a, b } = await pair(make);
        const group = { kind: 'group', id: 'g14' };
        const doc = chats => ({ id: 'g14', name: 'Ownership proof', chats, chat_id: chats.at(-1) || '', date_added: 1 });
        await a.writeRecord({ kind: 'world', name: 'undo' }, { entries: {}, revision: 'base' });
        if (existing) await a.writeRecord(group, doc(['old']));
        await a.run(); await b.run();
        await a.writeRecord(group, doc(existing ? ['old', 'kept'] : ['kept']));
        await a.writeRecord(chat, chatValue);
        await a.writeRecord({ ...chat, kind: 'chat-state', namespace: 'iter_studio' }, complete);
        await a.writeRecord({ kind: 'world', name: 'undo' }, { entries: {}, revision: 'incoming' });
        await a.run(); await b.run();
        const edited = editChat ? { ...chatValue, body: [...chatValue.body, { name: 'User', is_user: true, mes: 'Later retained edit' }] } : chatValue;
        if (editChat) await b.writeRecord(chat, edited);
        const editedState = { ...complete, selected: 'After sync' };
        await b.writeRecord({ ...chat, kind: 'chat-state', namespace: 'iter_studio' }, editedState);
        const importedOid = (await b.files()).get('group chats/kept.jsonl').oid;
        const undone = await b.call('POST', `/backends/${b.id}/undo`);
        expect(undone).toMatchObject({ status: 200, body: { ok: true, committed: true, propagation: { ok: true } } });
        expect(undone.body.keptEdited).toContain('group chats/kept.jsonl');
        expect(undone.body.reverted).toContain('worlds/undo.json');
        await a.run();
        const expectedGroup = doc(existing ? ['old', 'kept'] : ['kept']);
        for (const d of [a, b]) {
            expect(await d.readRecord(group)).toEqual(expectedGroup);
            expect(await d.readRecord(chat)).toEqual(edited);
            expect(await d.readRecord({ ...chat, kind: 'chat-state', namespace: 'iter_studio' })).toEqual(editedState);
            const before = (await d.files()).get('group chats/kept.jsonl').oid;
            if (!editChat) expect(before).toBe(importedOid);
            // Rewriting the exact group doc invokes SQL ownership bookkeeping
            // without changing a chat blob. The next snapshots must still
            // enumerate the chat through the owning group.
            await d.writeRecord(group, expectedGroup);
            await d.run(); await d.run();
            const files = await d.files();
            expect(files.get('group chats/kept.jsonl').oid).toBe(before);
            expect(await d.readRecord(group)).toEqual(expectedGroup);
            expect(await d.readRecord(chat)).toEqual(edited);
            expect(await d.readRecord({ kind: 'world', name: 'undo' })).toEqual({ entries: {}, revision: 'base' });
            const log = await git.log({ fs, gitdir: d.gitdir, ref: 'refs/heads/main' });
            expect(log.some(row => row.commit.message.startsWith('undo sync sync-backup-'))).toBe(true);
        }
    }, 120_000);
});
