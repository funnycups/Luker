import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as imagesRouter } from '../../../src/endpoints/images.js';
import { getChatRepo } from '../../../src/storage/index.js';
import { MEDIA_ATTRIBUTION_NAMESPACE, normalizeAttributionTarget } from '../../../src/endpoints/media-attribution.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [{ name: 'User', mes: 'hi' }];
const IMAGE_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

describe('media attribution target normalization', () => {
    test('sanitizes path components and rejects names that sanitize to nothing', () => {
        expect(normalizeAttributionTarget({ char_dir: 'Alice/../Alice', chat_name: 'main' })).toEqual({
            charDir: 'Alice..Alice',
            chatName: 'main',
            isGroup: false,
            groupId: undefined,
        });
        expect(normalizeAttributionTarget({ chat_name: '..' })).toBeNull();
        expect(normalizeAttributionTarget({ is_group: true, chat_name: 'Group/../One' })).toEqual({
            charDir: '',
            chatName: 'Group..One',
            isGroup: true,
            groupId: 'Group..One',
        });
    });

    test('strips .jsonl suffixes so list-endpoint file names resolve to Repo keys', () => {
        expect(normalizeAttributionTarget({ char_dir: 'Alice', chat_name: 'main.jsonl' })).toEqual({
            charDir: 'Alice',
            chatName: 'main',
            isGroup: false,
            groupId: undefined,
        });
        expect(normalizeAttributionTarget({ is_group: true, chat_name: 'g1.jsonl.jsonl' })).toEqual({
            charDir: '',
            chatName: 'g1',
            isGroup: true,
            groupId: 'g1',
        });
    });
});

function upload(harness, { filename, sha, attribution }) {
    return request(harness.app)
        .post('/api/images/upload')
        .send({
            image: IMAGE_BASE64,
            format: 'png',
            ch_name: 'Alice',
            filename,
            ...(attribution ? { attribution } : {}),
        });
}

describe.each(ENDPOINT_HARNESSES)('media attribution on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/images', imagesRouter); },
        });
        fs.mkdirSync(harness.dirs.userImages, { recursive: true });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('records uploaded images in the chat sidecar', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        const response = await upload(harness, {
            filename: 'one',
            attribution: { char_dir: 'Alice', chat_name: 'main', is_group: false },
        }).expect(200);

        const doc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(doc.entries).toHaveLength(1);
        expect(doc.entries[0].path).toBe(response.body.path);
        expect(doc.entries[0].ch_name).toBe('Alice');
    });

    test('dedupes repeated uploads and refreshes the entry timestamp', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        const first = await upload(harness, { filename: 'one', attribution: { char_dir: 'Alice', chat_name: 'main' } }).expect(200);
        const firstDoc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        const firstTs = firstDoc.entries.find(entry => entry.path === first.body.path).ts;

        await upload(harness, { filename: 'one', attribution: { char_dir: 'Alice', chat_name: 'main' } }).expect(200);
        const doc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(doc.entries).toHaveLength(1);
        const replayed = doc.entries.find(entry => entry.path === first.body.path);
        expect(replayed.ts).toBeGreaterThanOrEqual(firstTs);

        await upload(harness, { filename: 'two', attribution: { char_dir: 'Alice', chat_name: 'ghost' } }).expect(200);
        const ghost = await getChatRepo().getState(harness.handle, 'Alice', 'ghost', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(ghost).toBeNull();
    });

    test('accepts a .jsonl-suffixed chat_name from list-endpoint file names', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        await upload(harness, { filename: 'sfx', attribution: { char_dir: 'Alice', chat_name: 'main.jsonl' } }).expect(200);

        const doc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(doc.entries).toHaveLength(1);
        expect(await getChatRepo().getState(harness.handle, 'Alice', 'main.jsonl', MEDIA_ATTRIBUTION_NAMESPACE)).toBeNull();
    });

    test('records uploaded images for a group chat under the group key', async () => {
        const groupId = 'group-nightly';
        await getChatRepo().save(harness.handle, '', groupId, HEADER, MESSAGES, null, { isGroup: true, groupId });
        const response = await upload(harness, {
            filename: 'group-one',
            attribution: { is_group: true, chat_name: groupId },
        }).expect(200);

        const doc = await getChatRepo().getState(harness.handle, '', groupId, MEDIA_ATTRIBUTION_NAMESPACE, { isGroup: true, groupId });
        expect(doc.entries).toHaveLength(1);
        expect(doc.entries[0].path).toBe(response.body.path);
    });

    test('serializes concurrent uploads without losing entries', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        await Promise.all(Array.from({ length: 6 }, (_, index) => upload(harness, {
            filename: `concurrent-${index}`,
            attribution: { char_dir: 'Alice', chat_name: 'main' },
        }).expect(200)));

        const doc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(new Set(doc.entries.map(entry => entry.path)).size).toBe(6);
    });

    test('prunes entries whose files are gone on the next append', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'main', HEADER, MESSAGES, null);
        const first = await upload(harness, { filename: 'one', attribution: { char_dir: 'Alice', chat_name: 'main' } }).expect(200);
        fs.rmSync(path.join(harness.dirs.root, first.body.path), { force: true });
        await upload(harness, { filename: 'two', attribution: { char_dir: 'Alice', chat_name: 'main' } }).expect(200);

        const doc = await getChatRepo().getState(harness.handle, 'Alice', 'main', MEDIA_ATTRIBUTION_NAMESPACE);
        expect(doc.entries.map(entry => entry.path).some(p => p.includes('one'))).toBe(false);
        expect(doc.entries).toHaveLength(1);
    });
});
