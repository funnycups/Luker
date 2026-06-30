import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config.yaml');

let app;
let chatStore;
let groupStore;

beforeEach(async () => {
    chatStore = new Map();
    // Group chats use charDir='' so the key prefix is just '||'.
    chatStore.set('||groupChatA', {
        header: { user_name: 'U', character_name: '', create_date: '2026-01-01 00:00:00', chat_metadata: { tainted: false } },
        body: [{ name: 'U', mes: 'gA1' }, { name: 'Bot', mes: 'gA2' }],
    });
    chatStore.set('||groupChatB', {
        header: { user_name: 'U', character_name: '', create_date: '2026-01-02 00:00:00', chat_metadata: { tainted: false } },
        body: [{ name: 'U', mes: 'gB1' }],
    });

    // Seed a parent group so the post-write group.chats[] registration has a
    // real document to read/update. The merge/split endpoints look up the
    // group by request.body.id (the parent group id from the URL).
    groupStore = new Map();
    groupStore.set('group-1', {
        id: 'group-1',
        name: 'Test Group',
        members: ['a.png', 'b.png'],
        chats: ['groupChatA', 'groupChatB'],
    });

    const fakeRepo = {
        async get(handle, charDir, name, opts) {
            // Standardize the convention: for group chats the storage key MUST
            // carry groupId === name. This guards against the
            // groupId/parent-group-id confusion that previously made every
            // group merge return 404 source_not_found — see
            // .superpowers/sdd/task-15-report.md.
            if (opts && opts.isGroup) {
                if (String(opts.groupId) !== String(name)) {
                    throw new Error(
                        `mock invariant: isGroup=true requires opts.groupId === name; got groupId=${JSON.stringify(opts.groupId)}, name=${JSON.stringify(name)}`,
                    );
                }
            }
            const v = chatStore.get(`${charDir}||${name}`);
            return v ? structuredClone(v) : null;
        },
        async save(handle, charDir, name, header, body, expected, opts) {
            if (opts && opts.isGroup) {
                if (String(opts.groupId) !== String(name)) {
                    throw new Error(
                        `mock invariant: isGroup=true requires opts.groupId === name; got groupId=${JSON.stringify(opts.groupId)}, name=${JSON.stringify(name)}`,
                    );
                }
            }
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

    const fakeGroupRepo = {
        async get(handle, id) {
            const v = groupStore.get(String(id));
            return v ? structuredClone(v) : null;
        },
        async save(handle, id, doc) {
            groupStore.set(String(id), structuredClone(doc));
        },
    };

    jest.unstable_mockModule('../../src/storage/index.js', () => ({
        getChatRepo: () => fakeRepo,
        getGroupRepo: () => fakeGroupRepo,
        getStorageEngine: () => ({ kind: 'fs', close: async () => {} }),
        initStorage: () => {},
        getWorldInfoRepo: () => ({}),
        getPersonaRepo: () => ({}),
        getCharacterRepo: () => ({}),
    }));
    jest.unstable_mockModule('../../src/storage/errors.js', () => ({
        ConflictError: class ConflictError extends Error { constructor(...a) { super(...a); this.code = 'ConflictError'; } },
        NotFoundError: class NotFoundError extends Error {},
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

describe('POST /api/chats/group/merge', () => {
    test('merges two group chats by id', async () => {
        const res = await request(app).post('/api/chats/group/merge').send({
            id: 'group-1',
            segments: [{ source: 'groupChatA' }, { source: 'groupChatB' }],
            target_name: 'group-merged',
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.new_chat.file_name).toBe('group-merged');
        expect(chatStore.get('||group-merged').body.map(m => m.mes))
            .toEqual(['gA1', 'gA2', 'gB1']);
        // The merged chat must be appended to the parent group's chats[] so
        // the client's openGroupChat(groupId, newName) gate accepts it (see
        // public/scripts/group-chats.js:2381). Otherwise CHAT_CHANGED never
        // fires and the user is stuck on the source chat after a successful
        // merge.
        expect(groupStore.get('group-1').chats).toEqual(['groupChatA', 'groupChatB', 'group-merged']);
    });

    test('missing id returns 400', async () => {
        const res = await request(app).post('/api/chats/group/merge').send({
            segments: [{ source: 'groupChatA' }],
            target_name: 'x',
        });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/chats/group/split', () => {
    test('splits group chat', async () => {
        const res = await request(app).post('/api/chats/group/split').send({
            id: 'group-1',
            source_file_name: 'groupChatA',
            split_points: [1],
            target_names: ['gpart1', 'gpart2'],
        });
        expect(res.status).toBe(200);
        expect(res.body.new_chats.map(c => c.file_name)).toEqual(['gpart1', 'gpart2']);
        expect(chatStore.get('||gpart1').body.map(m => m.mes)).toEqual(['gA1']);
        expect(chatStore.get('||gpart2').body.map(m => m.mes)).toEqual(['gA2']);
        // Both split parts must be appended to the parent group's chats[].
        expect(groupStore.get('group-1').chats).toEqual(['groupChatA', 'groupChatB', 'gpart1', 'gpart2']);
    });

    test('missing source returns 404', async () => {
        const res = await request(app).post('/api/chats/group/split').send({
            id: 'group-1',
            source_file_name: 'nope',
            split_points: [1],
            target_names: ['a', 'b'],
        });
        expect(res.status).toBe(404);
    });
});
