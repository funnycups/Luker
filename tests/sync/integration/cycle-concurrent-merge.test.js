import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSyncCycle, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { blobOidOf, readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries } from '../../../src/sync/pipeline/conflict-records.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';
import { write as writeCard } from '../../../src/character-card-parser.js';
import { DirectoryBackend } from '../_lib/directory-backend.js';
import { BACKEND_ID, makeDevice, makeRemote, resolveRefOrNull } from '../_lib/devices.js';

const HEADER = JSON.stringify({ user_name: 'U', character_name: 'Seraphina', chat_metadata: {} });
const CHAT = 'chats/Seraphina/c1.jsonl';
const WORLD = 'worlds/w.json';
const oid = content => blobOidOf(Buffer.from(content));
const SEED_PNG = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../default/content/default_Seraphina.png'));
const CARD = 'characters/Seraphina.png';
const card = chat => writeCard(SEED_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Seraphina', data: { name: 'Seraphina' }, ...(chat ? { chat } : {}) }));

describe('two devices merging the same heads at once', () => {
    const cleanups = [];
    beforeEach(() => _resetGateForTests());
    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup();
    });

    const copyRemote = source => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-remote-copy-'));
        fs.cpSync(source, dir, { recursive: true });
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        return dir;
    };
    const against = (device, remoteDir) => ({ ...device.ctx, backend: new DirectoryBackend({ id: BACKEND_ID, remoteDir, userRoot: device.userRoot }) });

    test('write the same merge commit with one fork and records that match the files', async () => {
        const shared = await makeRemote();
        cleanups.push(shared.cleanup);
        const devices = { Desk: makeDevice({ remoteDir: shared.remoteDir, categories: ['worlds', 'chats'] }), Phone: makeDevice({ remoteDir: shared.remoteDir, categories: ['worlds', 'chats'] }) };
        for (const [label, d] of Object.entries(devices)) {
            cleanups.push(d.cleanup);
            d.ctx.getDeviceLabel = async () => label;
        }
        const { Desk, Phone } = devices;
        Desk.ctx.onConflicts = createConflictPolicy({ directories: Desk.directories, localDevice: 'Desk', remoteDevice: 'Phone' });
        Phone.ctx.onConflicts = createConflictPolicy({ directories: Phone.directories, localDevice: 'Phone', remoteDevice: 'Desk' });

        Desk.write(WORLD, 'base');
        Desk.write(CHAT, `${HEADER}\nbase`);
        await runSyncCycle(Desk.ctx);
        await runSyncCycle(Phone.ctx);
        const deskRemote = copyRemote(shared.remoteDir);
        const phoneRemote = copyRemote(shared.remoteDir);

        const content = { Desk: { world: 'from Desk', chat: `${HEADER}\nfrom Desk` }, Phone: { world: 'from Phone', chat: `${HEADER}\nfrom Phone` } };
        for (const name of ['Desk', 'Phone']) {
            devices[name].write(WORLD, content[name].world);
            devices[name].write(CHAT, content[name].chat);
        }
        expect((await runSyncCycle(against(Desk, deskRemote))).mergeCase).toBe('ahead');
        expect((await runSyncCycle(against(Phone, phoneRemote))).mergeCase).toBe('ahead');

        // Each device reads the head the other one published.
        const [deskMerge, phoneMerge] = await Promise.all([runSyncCycle(against(Desk, phoneRemote)), runSyncCycle(against(Phone, deskRemote))]);
        expect(deskMerge.mergeCase).toBe('merged');
        expect(phoneMerge.mergeCase).toBe('merged');
        expect(deskMerge.localHead).toBe(phoneMerge.localHead);
        for (const d of [Desk, Phone]) expect(await resolveRefOrNull(d.shadow.gitDir, MAIN_REF)).toBe(deskMerge.localHead);

        const gitdir = Desk.shadow.gitDir;
        const files = await readCommitFiles({ gitdir, commitOid: deskMerge.localHead });
        const forks = [...files.keys()].filter(key => key.startsWith('chats/Seraphina/') && key.endsWith('.jsonl') && key !== CHAT);
        expect(forks).toHaveLength(1);

        const { [WORLD]: record } = await readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' });
        expect(record.kept).toBe(files.get(WORLD).oid);
        expect(record.ours).toBe(oid(content[record.oursDevice].world));
        expect(record.theirs).toBe(oid(content[record.theirsDevice].world));
        expect([record.oursDevice, record.theirsDevice].sort()).toEqual(['Desk', 'Phone']);

        const notice = Object.values(await readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' })).find(n => n.kind === 'fork');
        expect(notice.device).toBe(record.theirsDevice);
        expect(files.get(CHAT).oid).toBe(oid(content[record.oursDevice].chat));
        for (const d of [Desk, Phone]) {
            expect(d.read(WORLD)).toBe(content[record.oursDevice].world);
            expect(d.read(CHAT)).toBe(content[record.oursDevice].chat);
            expect(d.read(forks[0]).split('\n')[1]).toBe(`from ${record.theirsDevice}`);
        }
    });

    test('restore a chat each device deleted and the other edited and merge the character card the same way', async () => {
        const shared = await makeRemote();
        cleanups.push(shared.cleanup);
        const categories = ['characters', 'chats'];
        const devices = { Desk: makeDevice({ remoteDir: shared.remoteDir, categories }), Phone: makeDevice({ remoteDir: shared.remoteDir, categories }) };
        for (const [label, d] of Object.entries(devices)) {
            cleanups.push(d.cleanup);
            d.ctx.getDeviceLabel = async () => label;
        }
        const { Desk, Phone } = devices;
        Desk.ctx.onConflicts = createConflictPolicy({ directories: Desk.directories, localDevice: 'Desk', remoteDevice: 'Phone' });
        Phone.ctx.onConflicts = createConflictPolicy({ directories: Phone.directories, localDevice: 'Phone', remoteDevice: 'Desk' });
        const chats = { Desk: 'chats/Seraphina/c1.jsonl', Phone: 'chats/Seraphina/c2.jsonl' };

        Desk.write(CARD, card());
        for (const chat of Object.values(chats)) Desk.write(chat, `${HEADER}\nbase`);
        await runSyncCycle(Desk.ctx);
        await runSyncCycle(Phone.ctx);
        const deskRemote = copyRemote(shared.remoteDir);
        const phoneRemote = copyRemote(shared.remoteDir);

        // Each device edits its own chat, deletes the other's and opens a different chat last.
        Desk.write(chats.Desk, `${HEADER}\nfrom Desk`);
        Desk.remove(chats.Phone);
        Desk.write(CARD, card('c1'));
        Phone.write(chats.Phone, `${HEADER}\nfrom Phone`);
        Phone.remove(chats.Desk);
        Phone.write(CARD, card('c2'));
        expect((await runSyncCycle(against(Desk, deskRemote))).mergeCase).toBe('ahead');
        expect((await runSyncCycle(against(Phone, phoneRemote))).mergeCase).toBe('ahead');

        const [deskMerge, phoneMerge] = await Promise.all([runSyncCycle(against(Desk, phoneRemote)), runSyncCycle(against(Phone, deskRemote))]);
        expect([deskMerge.mergeCase, phoneMerge.mergeCase]).toEqual(['merged', 'merged']);
        expect(deskMerge.localHead).toBe(phoneMerge.localHead);
        for (const d of [Desk, Phone]) expect(await resolveRefOrNull(d.shadow.gitDir, MAIN_REF)).toBe(deskMerge.localHead);

        const gitdir = Desk.shadow.gitDir;
        const files = await readCommitFiles({ gitdir, commitOid: deskMerge.localHead });
        expect(await readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' })).toEqual({});
        const notices = await readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' });
        expect(Object.fromEntries(Object.entries(notices).map(([key, n]) => [key, [n.kind, n.device, n.deletedBy]]))).toEqual({
            [chats.Desk]: ['restored', 'Desk', 'Phone'],
            [chats.Phone]: ['restored', 'Phone', 'Desk'],
        });
        expect([...files.keys()].filter(key => key.includes('Sync conflict'))).toEqual([]);
        for (const d of [Desk, Phone]) {
            expect(d.read(chats.Desk)).toBe(`${HEADER}\nfrom Desk`);
            expect(d.read(chats.Phone)).toBe(`${HEADER}\nfrom Phone`);
        }
        const cardBytes = d => fs.readFileSync(path.join(d.userRoot, ...CARD.split('/')));
        expect(Buffer.compare(cardBytes(Desk), cardBytes(Phone))).toBe(0);
        expect(blobOidOf(cardBytes(Desk))).toBe(files.get(CARD).oid);
    });
});
