/**
 * SQLite-mode sync via the engine-agnostic record materializer.
 *
 * The orchestrator no longer ships a whole-DB blob in SQLite mode (the
 * previous design copied `luker-storage.sqlite` wholesale via VACUUM INTO
 * and atomically renamed it into place on the receiver, which destroyed
 * row-level granularity and silently replaced any data the receiver had).
 * Instead `runPullBody` projects per-user records into the shadow workdir
 * via `materializeUserDataIntoWorkdir`, snapshots that shape, and
 * `dematerializeWorkdirIntoUserData` writes the merged tree back through
 * the engine's normal `tx.putResource` path on the responder side.
 *
 * This test pins the new contract by writing real records on A through
 * the same repos production code uses, running a full pair-init pull,
 * and reading those records back on B by B's handle — proving the
 * dematerialize lands rows under the responder's handle (not A's),
 * which the legacy whole-DB swap could never do.
 *
 * Harness shape mirrors `full-flow.test.js`: two Express apps wrapped in
 * real `http.Server` listeners on random ports because the orchestrator's
 * `fetch()` makes outbound HTTP. A SHARED SqliteEngine with a
 * handle→directory dispatcher avoids the process-global `_engine`
 * clobber that two `initStorage()` calls would cause — each app's
 * middleware injects its own handle and the engine routes to the
 * matching DB file.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import bodyParser from 'body-parser';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';

import { router as syncRouter } from '../../../src/endpoints/sync.js';
import {
    initStorage,
    getStorageEngine,
    getChatRepo,
    getWorldInfoRepo,
} from '../../../src/storage/index.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE; copied so this file
// stays self-contained against the shared endpoint-harness (which is
// pinned to a single handle and would clash with the two-handle setup).
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

function buildDirs(userDir) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    return dirs;
}

function precreateCommonDirs(dirs) {
    fs.mkdirSync(dirs.root, { recursive: true });
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });
    fs.mkdirSync(dirs.groups, { recursive: true });
    fs.mkdirSync(dirs.groupChats, { recursive: true });
    fs.mkdirSync(dirs.worlds, { recursive: true });
}

function startListener(app) {
    return new Promise(resolve => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

function buildDualSqliteHarness() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-sqlite-mode-'));
    const aDir = path.join(dataRoot, 'alice');
    const bDir = path.join(dataRoot, 'bob');
    const aDirs = buildDirs(aDir);
    const bDirs = buildDirs(bDir);
    precreateCommonDirs(aDirs);
    precreateCommonDirs(bDirs);

    initStorage({
        mode: 'sqlite',
        directoriesByHandle: (h) => {
            if (h === 'alice') return aDirs;
            if (h === 'bob') return bDirs;
            throw new Error(`unknown handle ${h}`);
        },
    });

    function buildApp(handle, dirs) {
        const app = express();
        app.use(bodyParser.json({ limit: '500mb' }));
        app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
        const userProfile = { handle, admin: true, enabled: true, name: handle, created: 0, password: '', salt: '' };
        app.use((req, _res, next) => {
            req.user = { profile: userProfile, directories: dirs };
            next();
        });
        app.use('/api/sync/v1', syncRouter);
        return app;
    }

    return {
        aApp: buildApp('alice', aDirs),
        bApp: buildApp('bob', bDirs),
        aDirs,
        bDirs,
        cleanup() {
            try { getStorageEngine().close(); } catch { /* may already be torn down */ }
            try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
        },
    };
}

describe('SQLite-mode sync', () => {
    let H, aListener, bListener;

    beforeEach(async () => {
        H = buildDualSqliteHarness();
        aListener = await startListener(H.aApp);
        bListener = await startListener(H.bApp);
    });

    afterEach(async () => {
        if (aListener) await aListener.close();
        if (bListener) await bListener.close();
        if (H) H.cleanup();
    });

    test('pair: A\'s chat and world materialize through git and land in B\'s engine under B\'s handle', async () => {
        // Step 1: seed A with one per-character chat and one world,
        // through the same repos production code uses. The repos go
        // through SqliteEngine.withTransaction, so the chat / world
        // rows land in A's DB file the same way a real user write
        // would.
        const chatRepo = getChatRepo();
        const worldRepo = getWorldInfoRepo();
        const CHAR_DIR = 'aria_demo';
        const CHAT_NAME = '2026-06-25 first session';
        const chatHeader = {
            user_name: 'Captain',
            character_name: 'Aria',
            create_date: '2026-06-25 12:00:00',
            chat_metadata: { tainted: false },
        };
        const chatMessages = [
            { name: 'Captain', is_user: true, send_date: '2026-06-25', mes: 'Aria, what do you see on the horizon?' },
            { name: 'Aria', is_user: false, send_date: '2026-06-25', mes: 'Smoke. Three columns, two miles out.' },
        ];
        const { integrity: aliceChatIntegrity } = await chatRepo.save(
            'alice', CHAR_DIR, CHAT_NAME, chatHeader, chatMessages, null,
        );
        expect(aliceChatIntegrity).toMatch(/^[a-f0-9-]{36}$/);

        const WORLD_NAME = 'aria_world';
        const worldDoc = {
            entries: {
                1: { uid: 1, key: ['horizon'], content: 'Smoke columns appear at noon.', enabled: true },
            },
        };
        await worldRepo.save('alice', WORLD_NAME, worldDoc);

        // Sanity: B's DB file should NOT exist yet — no storage call
        // touched the 'bob' handle, so SqliteEngine never lazy-opened
        // it. The orchestrator's pull is what will create it (via the
        // dematerialize step writing the synced rows back through the
        // engine under handle='bob').
        const bDbPath = path.join(H.bDirs.root, 'luker-storage.sqlite');
        expect(fs.existsSync(bDbPath)).toBe(false);

        // Step 2: A offers, B pulls. The offer route triggers the
        // engine-agnostic materializer on A's side (project alice's
        // chat + world rows into A's shadow workdir as JSON/JSONL
        // files), then snapshots that workdir into the shadow git
        // repo. B's pull fetches those git objects, fast-forwards,
        // reconciles into B's live tree, and finally dematerializes
        // the reconciled workdir into B's engine under handle='bob'.
        const PEER_ID = 'alice@a1b2c3d4';
        const offer = await request(H.aApp)
            .post('/api/sync/v1/session/offer')
            .send({
                peerId: PEER_ID,
                label: 'B',
                categories: ['chats', 'worlds'],
            });
        expect(offer.status).toBe(200);
        expect(offer.body.token).toMatch(/^[a-f0-9]{64}$/);

        const pull = await request(H.bApp)
            .post('/api/sync/v1/pull')
            .send({
                peerId: PEER_ID,
                peerLabel: 'A',
                peerBaseUrl: aListener.baseUrl,
                offerToken: offer.body.token,
                categories: ['chats', 'worlds'],
            });
        expect(pull.status).toBe(200);
        expect(pull.body.ok).toBe(true);
        // First pair on B → fastForward path.
        expect(pull.body.fastForward).toBe(true);

        // Step 3a: B's DB file now exists — dematerialize wrote
        // chat + world rows under handle='bob', which lazy-opened the
        // engine's connection for that handle and created the file.
        expect(fs.existsSync(bDbPath)).toBe(true);

        // Step 3b: B's chat repo reports alice's chat content under
        // B's own handle. This is the new behavior the legacy whole-
        // DB swap could not produce: rows land scoped to the
        // receiver's handle so the receiver's storage layer reads
        // them through its normal access path, instead of forcing
        // callers to query by the sender's handle.
        const bobChat = await chatRepo.get('bob', CHAR_DIR, CHAT_NAME);
        expect(bobChat).not.toBeNull();
        expect(bobChat.header.user_name).toBe('Captain');
        expect(bobChat.header.character_name).toBe('Aria');
        expect(bobChat.body).toHaveLength(2);
        expect(bobChat.body[0].mes).toBe('Aria, what do you see on the horizon?');
        expect(bobChat.body[1].mes).toBe('Smoke. Three columns, two miles out.');

        // Integrity tokens travel through the materialize roundtrip:
        // the materializer reads from the chat header's
        // chat_metadata.integrity, the snapshot ships that as part of
        // the JSONL header, and the dematerializer reads it back when
        // it calls putResource. The receiving side keeps the same
        // integrity so concurrent edits get conflict detection.
        expect(bobChat.integrity).toBe(aliceChatIntegrity);

        // Step 3c: world data lands under B's handle too. Worlds use
        // a separate repo and a different on-disk shape (one JSON
        // per file under worlds/), so this path exercises the
        // materializeWorlds / dematerializeWorlds branch in addition
        // to materializeChats.
        const bobWorld = await worldRepo.get('bob', WORLD_NAME);
        expect(bobWorld).toEqual(worldDoc);

        // Step 3d: alice's side is unchanged — the orchestrator never
        // writes back through the engine under the sender's handle.
        const aliceChatAfter = await chatRepo.get('alice', CHAR_DIR, CHAT_NAME);
        expect(aliceChatAfter.body[0].mes).toBe(chatMessages[0].mes);
        const aliceWorldAfter = await worldRepo.get('alice', WORLD_NAME);
        expect(aliceWorldAfter).toEqual(worldDoc);
    });
});
