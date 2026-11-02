import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { recordLastSync, upsertLanBackend, readRegistry } from '../../../src/sync/state.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { commitLocalEdit } from '../../../src/sync/pipeline/cycle.js';
import { CONFLICTS_PATH, NOTICES_PATH, serializeEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { blobOidOf, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { reviewedChoice } from '../_lib/conflict-choices.js';
import { PAUSEPOINTS } from '../../../src/sync/pipeline/failpoints.js';

const header = JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} });
const oid = text => blobOidOf(Buffer.from(text));

describe('conflict routes across two devices', () => {
    let A;
    let B;
    let id;
    const sync = device => device.call('POST', `/backends/${id}/sync`);
    const status = async device => (await device.call('GET', '/status')).body;
    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice({ deviceLabel: 'A device' });
        B = await startLanDevice({ deviceLabel: 'B device' });
    });
    afterEach(async () => {
        await A.close();
        await B.close();
    });

    test('a file conflict appears in status on both devices and one resolution clears it on both', async () => {
        A.write('worlds/w.json', 'A0');
        id = await pair(A, B);
        A.write('worlds/w.json', 'A1');
        B.write('worlds/w.json', 'B1');
        const content = { 'A device': 'A1', 'B device': 'B1' };
        expect((await sync(B)).body).toMatchObject({ ok: true, conflicts: 1 });
        await until(async () => JSON.stringify((await status(A)).conflicts.map(c => c.path)) === '["worlds/w.json"]');
        const [entry] = (await status(B)).conflicts;
        expect([entry.oursDevice, entry.theirsDevice].sort()).toEqual(['A device', 'B device']);
        expect(entry).toMatchObject({ path: 'worlds/w.json', backends: [id], ours: oid(content[entry.oursDevice]), theirs: oid(content[entry.theirsDevice]), stale: false });
        expect(B.read('worlds/w.json')).toBe(content[entry.oursDevice]);
        expect(await B.call('POST', '/conflicts/resolve', { body: [reviewedChoice(entry, 'theirs')] })).toMatchObject({ status: 200, body: { ok: true, results: [{ path: 'worlds/w.json', backends: [id], applied: true }] } });
        expect(B.read('worlds/w.json')).toBe(content[entry.theirsDevice]);
        await until(async () => (await status(A)).conflicts.length === 0);
        await until(() => A.read('worlds/w.json') === content[entry.theirsDevice]);
    });

    test('a manual sync with nothing to merge reports the conflicts a background run recorded', async () => {
        A.write('worlds/w.json', 'A0');
        id = await pair(A, B);
        A.write('worlds/w.json', 'A1');
        B.write('worlds/w.json', 'B1');
        expect((await sync(B)).body).toMatchObject({ ok: true, conflicts: 1, pendingConflicts: 1 });
        // A's notify-driven run brings the recorded conflict to A's main.
        await until(async () => (await status(A)).conflicts.length === 1);
        await until(() => !syncService.getRunning(A.userRoot)[id]);
        expect((await sync(A)).body).toMatchObject({ ok: true, conflicts: 0, pendingConflicts: 1 });
        expect((await sync(B)).body).toMatchObject({ ok: true, conflicts: 0, pendingConflicts: 1 });
    });

    test('resolve rejects malformed bodies', async () => {
        id = await pair(A, B);
        for (const body of [{}, [], [{ path: 'x' }], [{ path: 3, choice: 'ours' }], [{ path: 'x', choice: 'mine' }], [{ path: 'x', choice: 'ours' }, { path: 'x', choice: 'theirs' }]]) {
            expect(await B.call('POST', '/conflicts/resolve', { body })).toMatchObject({ status: 400, body: { code: 'INVALID_CHOICES' } });
        }
        const choice = { path: 'x', choice: 'ours', review: { backendId: id, selectedOid: null, recordVersions: { [id]: 'a'.repeat(40) }, currentVersions: { [id]: null } } };
        for (const review of [undefined, {}, { ...choice.review, selectedOid: 'not-an-oid' }, { ...choice.review, currentVersions: {} }]) {
            expect(await B.call('POST', '/conflicts/resolve', { body: [{ ...choice, review }] })).toMatchObject({ status: 400, body: { code: 'INVALID_CHOICES' } });
        }
    });

    test('resolve retains and propagates a completed choice despite a later backend repository failure', async () => {
        A.write('worlds/w.json', 'before'); id = await pair(A, B);
        await until(() => A.idle() && B.idle());
        const broken = 'zz-broken';
        await upsertLanBackend({ userRoot: B.userRoot, backendId: broken, categories: ['worlds'] });
        for (const backendId of [id, broken]) {
            const ctx = await syncService.contextFor(B.owner, backendId);
            await commitLocalEdit(ctx, async ({ gitdir, files }) => {
                const selected = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('reviewed selected bytes') });
                const records = { 'worlds/w.json': { kept: oid('before'), ours: oid('before'), theirs: selected, oursDevice: 'A', theirsDevice: 'B', mergeParents: [], createdAt: backendId === id ? '2026-10-15' : '2026-10-14' } };
                return { files: new Map(files).set('extra/selected', { oid: selected, mode: '100644' }).set(CONFLICTS_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: serializeEntries(records) }), mode: '100644' }), message: 'reviewed conflict fixture' };
            });
        }
        expect((await sync(B)).status).toBe(200);
        await until(async () => (await status(A)).conflicts.length === 1 && A.idle() && B.idle());
        const [entry] = (await status(B)).conflicts;
        expect(entry.backends).toEqual([id, broken]);
        const submitted = reviewedChoice(entry, 'theirs');
        const pause = path.join(B.userRoot, 'resolve-pause'); fs.mkdirSync(pause);
        const name = PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ;
        process.env.LUKER_SYNC_PAUSEPOINT = name; process.env.LUKER_SYNC_PAUSE_DIR = pause;
        fs.writeFileSync(path.join(pause, `${name}.arm`), '');
        const objects = path.join(getShadowPaths({ userRoot: B.userRoot, peerId: broken }).gitDir, 'objects');
        const resolving = B.call('POST', '/conflicts/resolve', { body: [submitted] });
        let response;
        try {
            await until(() => fs.existsSync(path.join(pause, `${name}.reached`)));
            fs.chmodSync(objects, 0o000);
            fs.writeFileSync(path.join(pause, `${name}.release`), '');
            response = await resolving;
        } finally {
            fs.chmodSync(objects, 0o700);
            fs.writeFileSync(path.join(pause, `${name}.release`), '');
            delete process.env.LUKER_SYNC_PAUSEPOINT; delete process.env.LUKER_SYNC_PAUSE_DIR;
        }
        expect(response).toMatchObject({ status: 200, body: { ok: false, results: [{ path: entry.path, backends: [id, broken], committedBackends: [id], applied: false, errors: { [broken]: { code: 'CONFLICT_COMMIT_FAILED' } } }] } });
        expect(JSON.stringify(response.body)).not.toContain(B.userRoot);
        await until(async () => A.read(entry.path) === 'reviewed selected bytes' && (await status(A)).conflicts.length === 0 && A.idle() && B.idle());
        expect(B.read(entry.path)).toBe('reviewed selected bytes');
        expect((await status(B)).conflicts).toEqual([expect.objectContaining({ path: entry.path, backends: [broken] })]);
        expect((await readRegistry({ userRoot: B.userRoot })).backends[id].lastSync.error).toBeNull();
        expect((await readRegistry({ userRoot: B.userRoot })).backends[broken].lastSync.at).toBeNull();
    });

    test('status lists stalled paths', async () => {
        id = await pair(A, B);
        await recordLastSync({ userRoot: B.userRoot, backendId: id, success: { head: null, mergeCase: 'pairing-pull', stalled: ['chats/S/c.luker-state.mg.json'] } });
        const { backends } = await status(B);
        expect(backends[id]).toMatchObject({ kind: 'lan', label: 'A device', running: false });
        expect(backends[id].lastSync.stalled).toEqual(['chats/S/c.luker-state.mg.json']);
    });

    test('status survives a malformed record file', async () => {
        id = await pair(A, B);
        await commitLocalEdit(await syncService.contextFor(B.owner, id), async ({ gitdir, files }) => ({
            files: new Map([...files, [CONFLICTS_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from('{not json') }), mode: '100644' }]]),
            message: 'bad record',
        }));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await B.call('GET', '/status')).toMatchObject({ status: 200, body: { conflicts: [], notices: [] } });
            expect((await B.call('GET', '/status')).body).toMatchObject({ ok: false, errors: { [id]: { code: 'PENDING_READ_FAILED' } }, backends: { [id]: { pendingError: { code: 'PENDING_READ_FAILED' } } } });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read pending records'), expect.any(Error));
        } finally {
            warn.mockRestore();
        }
    });

    test('status leaves out a backend that is being removed', async () => {
        id = await pair(A, B);
        // Holding the shadow lock keeps the removal waiting with the registry entry still present.
        let release;
        const held = syncService.withShadowLock(B.userRoot, id, () => new Promise(resolve => { release = resolve; }));
        await until(() => release);
        const removal = syncService.removeBackend(B.owner, id);
        try {
            await until(() => syncService.isRemoving(B.userRoot, id));
            expect(await B.call('GET', '/status')).toEqual({ status: 200, body: { conflicts: [], notices: [], backends: {}, errors: {}, ok: true } });
        } finally {
            release();
            await held;
            await removal;
        }
    });

    test('a chat conflict forks the other version on both devices and the notice can be dismissed', async () => {
        A.write('chats/Seraphina/c1.jsonl', `${header}\nbase`);
        id = await pair(A, B);
        A.write('chats/Seraphina/c1.jsonl', `${header}\nfrom A device`);
        B.write('chats/Seraphina/c1.jsonl', `${header}\nfrom B device`);
        expect((await sync(B)).body).toMatchObject({ ok: true, conflicts: 0 });
        const [notice] = (await status(B)).notices;
        expect(['A device', 'B device']).toContain(notice.device);
        const keptDevice = notice.device === 'A device' ? 'B device' : 'A device';
        expect(notice).toMatchObject({ chat: 'chats/Seraphina/c1.jsonl', target: { kind: 'character', avatar: 'Seraphina.png' } });
        expect(B.read(notice.path).split('\n')[1]).toBe(`from ${notice.device}`);
        expect(JSON.parse(B.read(notice.path).split('\n')[0]).chat_metadata.main_chat).toBe('c1');
        expect(B.read('chats/Seraphina/c1.jsonl')).toBe(`${header}\nfrom ${keptDevice}`);
        await until(() => A.read(notice.path) === B.read(notice.path));
        await until(() => A.read('chats/Seraphina/c1.jsonl') === `${header}\nfrom ${keptDevice}`);
        await until(async () => (await status(A)).notices.length === 1);
        expect((await A.call('POST', '/notices/dismiss', { body: { paths: [notice.path] } })).body).toMatchObject({ ok: true, results: [{ path: notice.path, backends: [id] }] });
        await until(async () => (await status(B)).notices.length === 0);
        expect((await status(A)).notices).toEqual([]);
    });

    test('dismiss rejects a body without a list of paths', async () => {
        id = await pair(A, B);
        for (const body of [{}, { paths: 'x' }, { paths: [3] }]) {
            expect(await B.call('POST', '/notices/dismiss', { body })).toMatchObject({ status: 400, body: { code: 'INVALID_PATHS' } });
        }
    });

    test('grouped dismissal returns partial read errors and propagates only committed backends', async () => {
        const rel = 'group chats/kept.jsonl';
        const notice = { kind: 'restored', device: 'Phone', createdAt: '1', target: { kind: 'group', groupId: null, name: 'kept' } };
        for (const backendId of ['notice-bad', 'notice-good']) {
            await upsertLanBackend({ userRoot: B.userRoot, backendId, categories: ['worlds'] });
            const ctx = await syncService.contextFor(B.owner, backendId);
            await commitLocalEdit(ctx, async ({ gitdir, files }) => ({ files: new Map(files).set(NOTICES_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: serializeEntries({ [rel]: notice }) }), mode: '100644' }), message: 'notice fixture' }));
        }
        const gitdir = getShadowPaths({ userRoot: B.userRoot, peerId: 'notice-bad' }).gitDir;
        const main = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
        const oid = (await readCommitFiles({ gitdir, commitOid: main })).get(NOTICES_PATH).oid;
        const file = path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
        const bytes = fs.readFileSync(file);
        fs.writeFileSync(file, 'unreadable notice object');
        try {
            expect(await B.call('POST', '/notices/dismiss', { body: { paths: [rel] } })).toMatchObject({ status: 200, body: { ok: false, errors: { 'notice-bad': { code: 'PENDING_READ_FAILED' } }, results: [{ path: rel, backends: ['notice-good'], committedBackends: ['notice-good'], applied: false }] } });
            await until(() => !syncService.getRunning(B.userRoot)['notice-good']);
            expect((await readRegistry({ userRoot: B.userRoot })).backends['notice-bad'].lastSync.error).toBeNull();
            expect(await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' })).toBe(main);
        } finally { fs.writeFileSync(file, bytes); }
        expect((await status(B)).notices).toEqual([expect.objectContaining({ path: rel, backends: ['notice-bad'] })]);
        expect((await B.call('POST', '/notices/dismiss', { body: { paths: [rel] } })).body).toMatchObject({ ok: true, results: [{ committedBackends: ['notice-bad'], applied: true }] });
    });

    test('a group chat conflict adds the branch to the group on both devices', async () => {
        A.write('groups/g1.json', JSON.stringify({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'] }, null, 4));
        A.write('group chats/gc1.jsonl', `${header}\nbase`);
        id = await pair(A, B);
        A.write('group chats/gc1.jsonl', `${header}\nfrom A`);
        B.write('group chats/gc1.jsonl', `${header}\nfrom B`);
        await sync(B);
        const [notice] = (await status(B)).notices;
        expect(notice.target).toMatchObject({ kind: 'group', groupId: 'g1' });
        expect(JSON.parse(B.read('groups/g1.json')).chats).toEqual(['gc1', notice.target.name]);
        await until(() => JSON.stringify(JSON.parse(A.read('groups/g1.json')).chats) === JSON.stringify(['gc1', notice.target.name]));
    });

    test('blob returns the bytes of a recorded version', async () => {
        A.write('worlds/w.json', 'A0');
        id = await pair(A, B);
        A.write('worlds/w.json', 'A1');
        B.write('worlds/w.json', 'B1');
        await sync(B);
        const [entry] = (await status(B)).conflicts;
        const res = await B.request(`${B.baseUrl}/api/sync/v1/blob/${id}/${entry.theirs}`);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe(entry.theirsDevice === 'A device' ? 'A1' : 'B1');
        expect((await B.call('GET', `/blob/${id}/nothex`)).status).toBe(400);
        expect((await B.call('GET', `/blob/u@ffffffff/${entry.theirs}`)).status).toBe(404);
        expect((await B.call('GET', `/blob/${id}/${'e'.repeat(40)}`)).status).toBe(404);
    });
});
