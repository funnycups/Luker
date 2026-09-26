import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config.yaml');

let app;
let chatStore;

beforeEach(async () => {
    chatStore = new Map();
    chatStore.set('Aqua||chatA', {
        header: { user_name: 'U', character_name: 'Aqua', create_date: '2026-01-01 00:00:00', chat_metadata: { tainted: false, main_chat: 'somewhere', branches: ['x'] } },
        body: [{ name: 'U', mes: 'a1' }, { name: 'Aqua', mes: 'a2' }],
    });
    chatStore.set('Aqua||chatB', {
        header: { user_name: 'U', character_name: 'Aqua', create_date: '2026-01-02 00:00:00', chat_metadata: { tainted: false } },
        body: [{ name: 'U', mes: 'b1' }, { name: 'Aqua', mes: 'b2' }, { name: 'U', mes: 'b3' }],
    });

    const fakeRepo = {
        async get(handle, charDir, name) {
            const v = chatStore.get(`${charDir}||${name}`);
            return v ? structuredClone(v) : null;
        },
        async save(handle, charDir, name, header, body) {
            const key = `${charDir}||${name}`;
            if (chatStore.has(key)) {
                const err = new Error('exists');
                err.code = 'ConflictError';
                throw err;
            }
            chatStore.set(key, { header, body });
            return 'integrity-stub';
        },
    };

    jest.unstable_mockModule('../../src/storage/index.js', () => ({
        getChatRepo: () => fakeRepo,
        getGroupRepo: () => ({}),
        getStorageEngine: () => ({ kind: 'fs', close: async () => {} }),
        initStorage: () => {},
        getWorldInfoRepo: () => ({}),
        getPersonaRepo: () => ({}),
        getCharacterRepo: () => ({}),
    }));
    jest.unstable_mockModule('../../src/storage/errors.js', () => ({
        ConflictError: class ConflictError extends Error { constructor(...a) { super(...a); this.code = 'ConflictError'; } },
        NotFoundError: class NotFoundError extends Error {},
        InvalidArgumentError: class InvalidArgumentError extends Error { constructor(m) { super(m); this.code = 'invalid_argument'; } },
    }));
    jest.unstable_mockModule('../../src/middleware/validateFileName.js', () => ({
        default: (req, res, next) => next(),
    }));

    // jest.setup.js only runs once at the jest process start. jest.resetModules()
    // in the previous afterEach wipes the util.js module cache, so the freshly-
    // imported util.js below has CONFIG_PATH = null. Re-pin it here so the
    // module-eval-time getConfigValue() calls inside luker-generation.js and
    // chats.js can find the bundled default config.
    const util = await import('../../src/util.js');
    if (!util.getConfigFilePath()) {
        util.setConfigFilePath(configPath);
        util.reloadConfigCache();
    }

    const { router } = await import('../../src/endpoints/chats.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: 'default-user' },
            directories: { chats: '/tmp/x/chats', groupChats: '/tmp/x/groupchats' },
        };
        next();
    });
    app.use('/api/chats', router);
});

afterEach(() => { jest.resetModules(); });

describe('POST /api/chats/merge', () => {
    test('concatenates two chats in order, resets cross-chat metadata refs', async () => {
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [{ source: 'chatA' }, { source: 'chatB' }],
            target_name: 'merged-1',
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.new_chat.file_name).toBe('merged-1');
        const newChat = chatStore.get('Aqua||merged-1');
        expect(newChat.body.map(m => m.mes)).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
        expect(newChat.header.character_name).toBe('Aqua');
        expect(newChat.header.chat_metadata.main_chat).toBeUndefined();
        expect(newChat.header.chat_metadata.branches).toEqual([]);
    });

    test('applies per-segment range', async () => {
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [
                { source: 'chatA', range: [1, 2] },
                { source: 'chatB', range: [0, 2] },
            ],
            target_name: 'merged-trim',
        });
        expect(res.status).toBe(200);
        const newChat = chatStore.get('Aqua||merged-trim');
        expect(newChat.body.map(m => m.mes)).toEqual(['a2', 'b1', 'b2']);
    });

    test('same source twice keeps both slices', async () => {
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [
                { source: 'chatA', range: [0, 1] },
                { source: 'chatA', range: [1, 2] },
            ],
            target_name: 'merged-dup',
        });
        expect(res.status).toBe(200);
        expect(chatStore.get('Aqua||merged-dup').body.map(m => m.mes)).toEqual(['a1', 'a2']);
    });

    test('name conflict appends (2)', async () => {
        chatStore.set('Aqua||merged-1', { header: { user_name: 'U', character_name: 'Aqua', create_date: '', chat_metadata: {} }, body: [] });
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [{ source: 'chatA' }],
            target_name: 'merged-1',
        });
        expect(res.status).toBe(200);
        expect(res.body.new_chat.file_name).toBe('merged-1 (2)');
    });

    test('missing source returns 404, no writes', async () => {
        const before = chatStore.size;
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [{ source: 'chatA' }, { source: 'nope' }],
            target_name: 'merged-x',
        });
        expect(res.status).toBe(404);
        expect(chatStore.size).toBe(before);
    });

    test('out-of-range range returns 400', async () => {
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [{ source: 'chatA', range: [0, 99] }],
            target_name: 'merged-bad',
        });
        expect(res.status).toBe(400);
    });

    test('empty effective body (from==to on every segment) returns 400', async () => {
        const res = await request(app).post('/api/chats/merge').send({
            avatar_url: 'Aqua.png',
            segments: [{ source: 'chatA', range: [1, 1] }],
            target_name: 'merged-empty',
        });
        expect(res.status).toBe(400);
    });
});
