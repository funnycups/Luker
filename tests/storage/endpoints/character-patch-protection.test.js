import { expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// User-account enablement is captured when users.js is imported. A fresh
// process loads the fixture config before the real authentication and quota
// middleware, without sharing the Jest worker's config or account storage.
async function exerciseProtection({ repoRoot, dataRoot, configPath, scenario }) {
    const { default: assert } = await import('node:assert/strict');
    const { default: fs } = await import('node:fs');
    const { default: http } = await import('node:http');
    const { createRequire } = await import('node:module');
    const { default: path } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const load = relative => import(pathToFileURL(path.join(repoRoot, relative)).href);
    const { setConfigFilePath } = await load('src/util.js');
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = dataRoot;
    await load('src/fetch-patch.js');

    const { default: express } = await import('express');
    const { default: cookieSession } = await import('cookie-session');
    const request = createRequire(path.join(repoRoot, 'tests/package.json'))('supertest');
    const { default: accounts } = await import('node-persist');
    const {
        ENABLE_ACCOUNTS, initUserStorage, toKey, getUserDirectories,
        getCookieSecret, getCookieSessionName, getSessionCookieAge,
        getPasswordSalt, getPasswordHash, setUserDataMiddleware,
        requireLoginMiddleware, enforceUserQuotaMiddleware,
    } = await load('src/users.js');
    const { router: usersPublicRouter } = await load('src/endpoints/users-public.js');
    const { router: charactersRouter, diskCache } = await load('src/endpoints/characters.js');
    const { initStorage, getStorageEngine } = await load('src/storage/index.js');
    const { read, write } = await load('src/character-card-parser.js');
    const {
        acquireWriter, getGateState, setDirtyListener, syncWriteGateMiddleware,
    } = await load('src/sync/in-progress-gate.js');

    assert.equal(ENABLE_ACCOUNTS, true);
    await initUserStorage(dataRoot);
    await initStorage({ mode: 'fs', directoriesByHandle: getUserDirectories });

    const handle = 'patch-owner';
    const directories = getUserDirectories(handle);
    const avatar = 'Patch Protection.png';
    const avatarPath = path.join(directories.characters, avatar);
    const card = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'Patch Protection',
            description: 'Before the edit.',
            tags: [],
            extensions: { protection_fixture: { keep: true } },
        },
    };
    const original = write(fs.readFileSync(path.join(repoRoot, 'default/content/default_Seraphina.png')), JSON.stringify(card));
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.writeFileSync(avatarPath, original);
    const payload = {
        avatar_url: avatar,
        operations: [{ op: 'add', path: scenario.rejected ? '/outside' : '/data/description', value: 'After the edit.' }],
    };
    // The allowed account has room for its PNG plus the actual request body.
    const quotaBytes = scenario.overQuota ? 0 : original.length + Buffer.byteLength(JSON.stringify(payload));
    const password = 'fixture-password';
    const salt = getPasswordSalt();
    await accounts.setItem(toKey(handle), {
        handle,
        name: 'Patch Owner',
        created: 0,
        enabled: true,
        admin: scenario.admin === true,
        salt,
        password: getPasswordHash(password, salt),
        storageQuotaBytes: quotaBytes,
    });

    const dirty = [];
    setDirtyListener(info => dirty.push(info));
    const app = express();
    app.use(cookieSession({
        name: getCookieSessionName(),
        sameSite: 'lax',
        httpOnly: true,
        maxAge: getSessionCookieAge(),
        secret: getCookieSecret(dataRoot),
    }));
    app.use(setUserDataMiddleware);
    app.use('/api/users', usersPublicRouter);
    app.use(requireLoginMiddleware);
    app.use(enforceUserQuotaMiddleware);
    app.use(express.json());
    app.use(syncWriteGateMiddleware());
    app.use('/api/characters', charactersRouter);
    const server = http.createServer(app);
    let release;
    let pending;

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        await request(server).post('/api/characters/patch').send(payload).expect(403);
        const agent = request.agent(server);
        const login = await agent.post('/api/users/login').send({ handle, password }).expect(200);
        assert.equal(login.body.handle, handle);

        if (scenario.holdWriter) {
            release = await acquireWriter(directories.root);
        }
        let settled = false;
        pending = agent.post('/api/characters/patch').send(payload).then(response => {
            settled = true;
            return response;
        });
        if (scenario.holdWriter) {
            // Observe admission or an escaped response, not an elapsed delay.
            while (getGateState(directories.root).waitingReaders === 0 && !settled) {
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.equal(settled, false, 'the character patch must wait behind the sync writer');
            assert.equal(getGateState(directories.root).waitingReaders, 1);
            assert.deepEqual(fs.readFileSync(avatarPath), original, 'a waiting patch must not mutate the PNG');
            assert.deepEqual(dirty, []);
            release();
        }

        const response = await pending;
        assert.equal(response.status, scenario.status, response.text);
        const saved = fs.readFileSync(avatarPath);
        if (scenario.status === 200) {
            assert.deepEqual(response.body, { ok: true });
            assert.notDeepEqual(saved, original);
            const parsed = JSON.parse(read(saved));
            assert.equal(parsed.data.description, 'After the edit.');
            assert.deepEqual(parsed.data.extensions, card.data.extensions);
            assert.deepEqual(dirty, [{ handle, userRoot: directories.root }]);
        } else {
            assert.deepEqual(saved, original, 'a refused patch must leave the PNG byte-identical');
            assert.deepEqual(dirty, []);
            if (scenario.status === 413) {
                assert.equal(response.body.quotaBytes, 0);
                assert.ok(response.body.usedBytes >= original.length);
            }
        }
        assert.deepEqual(getGateState(directories.root), {
            readers: 0, writerHeld: false, waitingReaders: 0, waitingWriters: 0,
        });
        return { status: response.status, description: JSON.parse(read(saved)).data.description, dirty: dirty.length };
    } finally {
        release?.();
        if (pending) await pending;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        diskCache.dispose();
        setDirtyListener(null);
        await getStorageEngine().close();
    }
}

test.each([
    ['waits for the sync writer before changing the PNG and marking dirty', { holdWriter: true, status: 200 }],
    ['rejects an over-quota authenticated non-admin without changing the PNG', { overQuota: true, status: 413 }],
    ['persists an under-quota authenticated non-admin edit and marks dirty', { status: 200 }],
    ['preserves the admin quota exemption and marks successful edits dirty', { admin: true, overQuota: true, status: 200 }],
    ['does not change the PNG or mark dirty for a rejected patch', { rejected: true, status: 400 }],
])('character patch protection %s', async (_name, scenario) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-character-patch-protection-'));
    const configPath = path.join(dataRoot, 'config.yaml');
    fs.writeFileSync(configPath, 'enableUserAccounts: true\n');
    try {
        const { stdout } = await execFileAsync(process.execPath, [
            '--input-type=module',
            '--eval', `console.log(JSON.stringify(await (${exerciseProtection.toString()})(${JSON.stringify({ repoRoot, dataRoot, configPath, scenario })})));`,
        ], { cwd: repoRoot }).catch(error => {
            throw new Error(`Character patch protection process failed (${error.code}).\n${error.stdout}${error.stderr}`);
        });
        expect(JSON.parse(stdout.trim().split('\n').pop())).toEqual({
            status: scenario.status,
            description: scenario.status === 200 ? 'After the edit.' : 'Before the edit.',
            dirty: scenario.status === 200 ? 1 : 0,
        });
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
