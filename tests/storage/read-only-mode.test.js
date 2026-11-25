import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import request from 'supertest';
import { setReadOnly, isReadOnly, assertWritable, withReadOnlyBypass } from '../../src/storage/read-only-mode.js';
import { StorageReadOnlyError } from '../../src/storage/errors.js';
import { CONTRACT_HARNESSES } from './harness/contract-harness.js';
import { ENDPOINT_HARNESSES, makeEndpointHarness } from './harness/endpoint-harness.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { getWorldInfoRepo } from '../../src/storage/index.js';
import { router as worldInfoRouter } from '../../src/endpoints/worldinfo.js';

describe('read-only mode flag', () => {
    afterEach(() => setReadOnly(false));  // always release

    test('default state is not read-only', () => {
        expect(isReadOnly()).toBe(false);
    });

    test('setReadOnly(true) flips flag', () => {
        setReadOnly(true);
        expect(isReadOnly()).toBe(true);
    });

    test('setReadOnly(false) clears flag', () => {
        setReadOnly(true);
        setReadOnly(false);
        expect(isReadOnly()).toBe(false);
    });

    test('assertWritable throws StorageReadOnlyError when read-only', () => {
        setReadOnly(true);
        expect(() => assertWritable()).toThrow(StorageReadOnlyError);
    });

    test('assertWritable is a no-op when writable', () => {
        expect(() => assertWritable()).not.toThrow();
    });

    test('StorageReadOnlyError has correct shape', () => {
        const err = new StorageReadOnlyError();
        expect(err.name).toBe('StorageReadOnlyError');
        expect(err.code).toBe('storage_read_only');
        expect(err.message).toMatch(/migration/);
    });

    test('withReadOnlyBypass suspends the guard for the duration of fn', async () => {
        setReadOnly(true);
        expect(() => assertWritable()).toThrow(StorageReadOnlyError);
        await withReadOnlyBypass(async () => {
            expect(() => assertWritable()).not.toThrow();
        });
        // Restored after fn completes.
        expect(() => assertWritable()).toThrow(StorageReadOnlyError);
    });

    test('withReadOnlyBypass restores guard even when fn throws', async () => {
        setReadOnly(true);
        await expect(withReadOnlyBypass(async () => {
            expect(() => assertWritable()).not.toThrow();
            throw new Error('boom');
        })).rejects.toThrow(/boom/);
        expect(() => assertWritable()).toThrow(StorageReadOnlyError);
    });

    test('withReadOnlyBypass is reentrant via depth counter', async () => {
        setReadOnly(true);
        await withReadOnlyBypass(async () => {
            expect(() => assertWritable()).not.toThrow();
            await withReadOnlyBypass(async () => {
                expect(() => assertWritable()).not.toThrow();
            });
            // Still inside outer scope; guard must still be suspended.
            expect(() => assertWritable()).not.toThrow();
        });
        expect(() => assertWritable()).toThrow(StorageReadOnlyError);
    });

    test('withReadOnlyBypass returns fn result', async () => {
        const result = await withReadOnlyBypass(async () => 42);
        expect(result).toBe(42);
    });

    test('withReadOnlyBypass does nothing harmful when flag is not set', async () => {
        expect(isReadOnly()).toBe(false);
        await withReadOnlyBypass(async () => {
            expect(() => assertWritable()).not.toThrow();
        });
        expect(() => assertWritable()).not.toThrow();
    });
});

// Verify EVERY Repo write throws when read-only, every read still works.
// Run against both engines via the contract harness.
describe.each(CONTRACT_HARNESSES)('Repo writes respect read-only mode on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); });
    afterEach(() => { setReadOnly(false); h.cleanup(); });

    test('ChatRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new ChatRepo({ engine: h.engine });
        await expect(repo.save(h.handle, 'TestChar', 'chat1',
            { chat_metadata: {} }, [], null)).rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('ChatRepo.get works when read-only', async () => {
        const repo = new ChatRepo({ engine: h.engine });
        // Pre-seed before flipping flag
        await repo.save(h.handle, 'TestChar', 'chat1', { chat_metadata: {} }, [], null);
        setReadOnly(true);
        const got = await repo.get(h.handle, 'TestChar', 'chat1');
        expect(got).not.toBeNull();
    });

    test('SettingsRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new SettingsRepo({ engine: h.engine });
        await expect(repo.save(h.handle, { x: 1 })).rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('SettingsRepo.patch throws when read-only', async () => {
        const repo = new SettingsRepo({ engine: h.engine });
        await repo.save(h.handle, { x: 1 });  // setup before flip
        setReadOnly(true);
        await expect(repo.patch(h.handle, [{ op: 'replace', path: '/x', value: 2 }]))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('PresetRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new PresetRepo({ engine: h.engine });
        await expect(repo.save(h.handle, 'openai', 'GPT', { temperature: 0.7 }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('PresetRepo.setState throws when read-only', async () => {
        const repo = new PresetRepo({ engine: h.engine });
        await repo.save(h.handle, 'openai', 'GPT', {});  // setup
        setReadOnly(true);
        await expect(repo.setState(h.handle, 'openai', 'GPT', 'ns', { v: 1 }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('WorldInfoRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new WorldInfoRepo({ engine: h.engine });
        await expect(repo.save(h.handle, 'World', { entries: {} }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('NamedDocRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new NamedDocRepo({ engine: h.engine });
        await expect(repo.save(h.handle, 'themes', 'Dark', { bg: '#000' }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('NamedDocRepo.delete throws when read-only', async () => {
        const repo = new NamedDocRepo({ engine: h.engine });
        await repo.save(h.handle, 'themes', 'X', {});
        setReadOnly(true);
        await expect(repo.delete(h.handle, 'themes', 'X'))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('GroupRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new GroupRepo({ engine: h.engine });
        await expect(repo.save(h.handle, 'g1', { id: 'g1' }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('StatsRepo.save throws when read-only', async () => {
        setReadOnly(true);
        const repo = new StatsRepo({ engine: h.engine });
        await expect(repo.save(h.handle, { timestamp: Date.now() }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });
});

describe.each(ENDPOINT_HARNESSES)('worldinfo read-only error mapping on $name', ({ mode }) => {
    let harness;
    let uploadsDir;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app, { dirs }) => {
                uploadsDir = path.join(dirs.root, 'wi-uploads');
                fs.mkdirSync(uploadsDir, { recursive: true });
                const upload = multer({
                    storage: multer.diskStorage({
                        destination: (_req, _file, cb) => cb(null, uploadsDir),
                    }),
                }).single('avatar');
                app.use('/api/worldinfo/import', upload);
                app.use('/api/worldinfo', worldInfoRouter);
            },
        });
        await getWorldInfoRepo().save(harness.handle, 'Protected', { entries: { '0': { uid: 0, content: 'keep' } } });
    });

    afterEach(() => {
        setReadOnly(false);
    });

    test('POST /api/worldinfo/delete returns 503 storage_read_only when read-only', async () => {
        setReadOnly(true);
        const res = await request(harness.server)
            .post('/api/worldinfo/delete')
            .send({ name: 'Protected' });

        expect(res.status).toBe(503);
        expect(res.body.error).toBe('storage_read_only');

        setReadOnly(false);
        expect(await getWorldInfoRepo().get(harness.handle, 'Protected')).toEqual({ entries: { '0': { uid: 0, content: 'keep' } } });
    });

    test('POST /api/worldinfo/edit and /patch return 503 storage_read_only when read-only', async () => {
        setReadOnly(true);
        const editRes = await request(harness.server)
            .post('/api/worldinfo/edit')
            .send({ name: 'Protected', data: { entries: {} } });
        expect(editRes.status).toBe(503);
        expect(editRes.body.error).toBe('storage_read_only');

        const patchRes = await request(harness.server)
            .post('/api/worldinfo/patch')
            .send({ name: 'Protected', operations: [{ op: 'replace', path: '/entries/0/content', value: 'changed' }] });
        expect(patchRes.status).toBe(503);
        expect(patchRes.body.error).toBe('storage_read_only');

        setReadOnly(false);
        expect(await getWorldInfoRepo().get(harness.handle, 'Protected')).toEqual({ entries: { '0': { uid: 0, content: 'keep' } } });
    });

    test('POST /api/worldinfo/import removes uploaded temp file even when convertedData is provided', async () => {
        const res = await request(harness.server)
            .post('/api/worldinfo/import')
            .field('convertedData', JSON.stringify({ entries: { '0': { uid: 0, content: 'converted' } } }))
            .attach('avatar', Buffer.from('raw-uploaded-payload'), 'ImportedBook.json');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ name: 'ImportedBook' });
        expect(fs.readdirSync(uploadsDir)).toEqual([]);
        expect(await getWorldInfoRepo().get(harness.handle, 'ImportedBook')).toEqual({
            entries: { '0': { uid: 0, content: 'converted' } },
        });
    });
});
