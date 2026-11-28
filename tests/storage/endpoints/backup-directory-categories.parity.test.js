import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import archiver from 'archiver';
import request from 'supertest';
import yauzl from 'yauzl';

import { ENDPOINT_HARNESSES, makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';

function emptySelection(overrides = {}) {
    return {
        settings: false,
        secrets: false,
        characters: false,
        chats: false,
        lorebooks: false,
        presets: false,
        assets: false,
        extensions: false,
        globalExtensions: false,
        vectors: false,
        ...overrides,
    };
}

async function postBackup(harness, selection) {
    return await new Promise((resolve, reject) => {
        request(harness.server)
            .post('/api/users/backup')
            .send({ handle: harness.handle, selection })
            .buffer(true)
            .parse((res, cb) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => cb(null, Buffer.concat(chunks)));
                res.on('error', cb);
            })
            .end((err, res) => {
                if (err) reject(err);
                else resolve(res);
            });
    });
}

function listZipEntries(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const names = [];
            zip.readEntry();
            zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
            zip.on('end', () => resolve(names));
            zip.on('error', reject);
        });
    });
}

function buildZipBuffer(entries) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const arc = archiver('zip');
        arc.on('data', (c) => chunks.push(c));
        arc.on('error', reject);
        arc.on('end', () => resolve(Buffer.concat(chunks)));
        for (const [name, content] of Object.entries(entries)) {
            arc.append(content, { name });
        }
        arc.finalize();
    });
}

describe.each(ENDPOINT_HARNESSES)('backups/ category separation on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            handle: `bkcat-${randomBytes(6).toString('hex')}`,
            mount: (app) => {
                app.use('/api/users', usersPrivateRouter);
            },
        });
        globalThis.DATA_ROOT = harness.dataRoot;
        fs.mkdirSync(path.join(harness.dirs.backups, '_sysprompt'), { recursive: true });
    });

    test('chats-only backup includes backups/chat_*.jsonl and excludes settings/secrets backups', async () => {
        fs.writeFileSync(path.join(harness.dirs.backups, 'chat_alice_20260101-120000.jsonl'), '{"chat_metadata":{}}\n');
        fs.writeFileSync(path.join(harness.dirs.backups, 'settings_u_20260101-120000.json'), '{}');
        fs.writeFileSync(path.join(harness.dirs.backups, '_sysprompt', 'default.json'), '{}');
        fs.writeFileSync(path.join(harness.dirs.backups, 'secrets_migration_1.json'), '{}');

        const res = await postBackup(harness, emptySelection({ chats: true }));
        expect(res.status).toBe(200);

        const zipPath = path.join(harness.dataRoot, 'chats-only.zip');
        fs.writeFileSync(zipPath, res.body);
        const entries = await listZipEntries(zipPath);

        expect(entries).toContain('backups/chat_alice_20260101-120000.jsonl');
        expect(entries).not.toContain('backups/settings_u_20260101-120000.json');
        expect(entries).not.toContain('backups/_sysprompt/default.json');
        expect(entries).not.toContain('backups/secrets_migration_1.json');
    });

    test('settings-only backup includes settings snapshots and excludes chat/secrets backups', async () => {
        fs.writeFileSync(path.join(harness.dirs.backups, 'chat_alice_20260101-120000.jsonl'), '{"chat_metadata":{}}\n');
        fs.writeFileSync(path.join(harness.dirs.backups, 'settings_u_20260101-120000.json'), '{}');
        fs.writeFileSync(path.join(harness.dirs.backups, '_sysprompt', 'default.json'), '{}');
        fs.writeFileSync(path.join(harness.dirs.backups, 'secrets_migration_1.json'), '{}');

        const res = await postBackup(harness, emptySelection({ settings: true }));
        expect(res.status).toBe(200);

        const zipPath = path.join(harness.dataRoot, 'settings-only.zip');
        fs.writeFileSync(zipPath, res.body);
        const entries = await listZipEntries(zipPath);

        expect(entries).not.toContain('backups/chat_alice_20260101-120000.jsonl');
        expect(entries).toContain('backups/settings_u_20260101-120000.json');
        expect(entries).toContain('backups/_sysprompt/default.json');
        expect(entries).not.toContain('backups/secrets_migration_1.json');
    });

    test('restoring a legacy fs ZIP with chats-only restores chat backups without deleting existing settings backups', async () => {
        const existingSettingsBackup = path.join(harness.dirs.backups, 'settings_keep_20260101-000000.json');
        const oldChatBackup = path.join(harness.dirs.backups, 'chat_old_20260101-000000.jsonl');
        fs.writeFileSync(existingSettingsBackup, '{"keep":true}');
        fs.writeFileSync(oldChatBackup, '{"chat_metadata":{}}\n{"name":"Old","mes":"stale"}\n');

        const zipBytes = await buildZipBuffer({
            'chats/Alice/c1.jsonl': '{"chat_metadata":{}}\n{"name":"Alice","mes":"hello"}\n',
            'backups/chat_alice_20260102-120000.jsonl': '{"chat_metadata":{}}\n{"name":"Alice","mes":"restored backup"}\n',
            'backups/settings_other_20260102-120000.json': '{"fromZip":true}',
        });

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({
                uploadId,
                handle: harness.handle,
                mode: 'overwrite',
                selection: emptySelection({ chats: true }),
            });
        expect(restoreRes.status).toBe(200);

        const restoredChatBackup = path.join(harness.dirs.backups, 'chat_alice_20260102-120000.jsonl');
        expect(fs.existsSync(restoredChatBackup)).toBe(true);
        expect(fs.readFileSync(restoredChatBackup, 'utf8')).toContain('restored backup');
        expect(fs.existsSync(existingSettingsBackup)).toBe(true);
        expect(fs.existsSync(path.join(harness.dirs.backups, 'settings_other_20260102-120000.json'))).toBe(false);
        // In same-mode fs overwrite, old chat backups are replaced while settings backups stay intact.
        expect(fs.existsSync(oldChatBackup)).toBe(mode !== 'fs');
    });

    test('restoring a legacy fs ZIP with settings-only in overwrite mode preserves existing chat backups', async () => {
        if (mode !== 'fs') return;
        const existingChatBackup = path.join(harness.dirs.backups, 'chat_keep_20260101-000000.jsonl');
        const oldSettingsBackup = path.join(harness.dirs.backups, 'settings_old_20260101-000000.json');
        fs.writeFileSync(existingChatBackup, '{"chat_metadata":{}}\n{"name":"Keep","mes":"stay"}\n');
        fs.writeFileSync(oldSettingsBackup, '{"old":true}');

        const zipBytes = await buildZipBuffer({
            'settings.json': '{"user_name":"restored"}',
            'backups/settings_new_20260102-120000.json': '{"fresh":true}',
            'backups/chat_zip_20260102-120000.jsonl': '{"chat_metadata":{}}\n{"name":"Skip","mes":"skip"}\n',
        });

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const restoreRes = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({
                uploadId,
                handle: harness.handle,
                mode: 'overwrite',
                selection: emptySelection({ settings: true }),
            });
        expect(restoreRes.status).toBe(200);

        expect(fs.existsSync(existingChatBackup)).toBe(true);
        expect(fs.existsSync(oldSettingsBackup)).toBe(false);
        expect(fs.existsSync(path.join(harness.dirs.backups, 'settings_new_20260102-120000.json'))).toBe(true);
        expect(fs.existsSync(path.join(harness.dirs.backups, 'chat_zip_20260102-120000.jsonl'))).toBe(false);
    });
});
