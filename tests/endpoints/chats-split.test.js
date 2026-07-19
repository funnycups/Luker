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
        body: [
            { name: 'U', mes: 'm0' },
            { name: 'Aqua', mes: 'm1' },
            { name: 'U', mes: 'm2' },
            { name: 'Aqua', mes: 'm3' },
            { name: 'U', mes: 'm4' },
        ],
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

describe('POST /api/chats/split', () => {
    test('splits at points [2] into two parts', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [2],
            target_names: ['part1', 'part2'],
        });
        expect(res.status).toBe(200);
        expect(res.body.new_chats.map(c => c.file_name)).toEqual(['part1', 'part2']);
        expect(chatStore.get('Aqua||part1').body.map(m => m.mes)).toEqual(['m0', 'm1']);
        expect(chatStore.get('Aqua||part2').body.map(m => m.mes)).toEqual(['m2', 'm3', 'm4']);
    });

    test('non-ascending split_points returns 400', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [3, 2],
            target_names: ['a', 'b', 'c'],
        });
        expect(res.status).toBe(400);
    });

    test('point at 0 returns 400', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [0],
            target_names: ['a', 'b'],
        });
        expect(res.status).toBe(400);
    });

    test('point at body.length returns 400', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [5],
            target_names: ['a', 'b'],
        });
        expect(res.status).toBe(400);
    });

    test('target_names length mismatch returns 400', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [2],
            target_names: ['a'],
        });
        expect(res.status).toBe(400);
    });

    test('per-segment name conflict gets independent (2) suffix', async () => {
        chatStore.set('Aqua||part1', { header: { user_name: 'U', character_name: 'Aqua', create_date: '', chat_metadata: {} }, body: [] });
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [2],
            target_names: ['part1', 'part2'],
        });
        expect(res.status).toBe(200);
        expect(res.body.new_chats[0].file_name).toBe('part1 (2)');
        expect(res.body.new_chats[1].file_name).toBe('part2');
    });

    test('defaults target_names when omitted', async () => {
        const res = await request(app).post('/api/chats/split').send({
            avatar_url: 'Aqua.png',
            source_file_name: 'chatA',
            split_points: [2],
        });
        expect(res.status).toBe(200);
        expect(res.body.new_chats[0].file_name).toBe('chatA part 1');
        expect(res.body.new_chats[1].file_name).toBe('chatA part 2');
    });
});
