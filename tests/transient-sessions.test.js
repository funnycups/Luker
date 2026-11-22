// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { request } from '@playwright/test';
import WebSocket from 'ws';
import { Jimp, JimpMime } from '../src/jimp.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { normalizeCharacterProfile } from '../public/scripts/extensions/stable-diffusion/character-archive/store.js';
import { startServer, tearDownServer } from './e2e/_lib/server.js';

const SESSION_HEADER = 'X-Luker-Transient-Session';
const NAMESPACE = 'sd_character_profiles';
const SOURCE_IMAGE_URL = 'https://raw.githubusercontent.com/SillyTavern/SillyTavern/release/public/img/ai4.png';
let server;
let admin;
let otherUser;
let imageBytes;
let testScope;
const sessions = new Set();
const sockets = new Set();
const releases = new Set();

function userFile(handle, directory, ...parts) {
    return path.join(server.dataRoot, handle, USER_DIRECTORY_TEMPLATE[directory], ...parts);
}

function absoluteImage(handle, imagePath) {
    return path.join(server.dataRoot, handle, imagePath.replace(/^\/+/, ''));
}

async function createApi(handle) {
    const client = await request.newContext({ baseURL: server.baseURL });
    let token = (await (await client.get('/csrf-token')).json()).token;
    const api = {
        handle,
        client,
        get: (url) => client.get(url),
        post: (url, data = {}, headers = {}) => client.post(url, {
            data,
            headers: { 'X-CSRF-Token': token, ...headers },
        }),
        async login() {
            const response = await api.post('/api/users/login', { handle, password: '' });
            expect(response.status()).toBe(200);
            token = (await (await client.get('/csrf-token')).json()).token;
        },
    };
    await api.login();
    return api;
}

async function openSession(api = admin) {
    // Fail on the missing HTTP contract before waiting for a not-yet-implemented WS frame.
    const missingId = await api.post('/api/transient-sessions/close');
    expect(missingId.status()).toBe(400);
    const ticketResponse = await api.post('/api/ws-ticket');
    expect(ticketResponse.status()).toBe(200);
    const { ticket } = await ticketResponse.json();
    const socket = new WebSocket(server.baseURL.replace(/^http/, 'ws') + '/api/ws-delivery', [
        `luker-ws-ticket.${ticket}`,
    ]);
    sockets.add(socket);
    let resolveOpened;
    let rejectOpened;
    const opened = new Promise((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
    });
    socket.on('message', raw => {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: frame.ts }));
        if (frame.type === 'session_opened') resolveOpened(frame);
        if (frame.type === 'session_error') rejectOpened(new Error(frame.message));
    });
    socket.on('error', rejectOpened);
    socket.on('close', () => rejectOpened(new Error('Socket closed before the session opened.')));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'session_open' }));
    const frame = await opened;
    expect(typeof frame.session_id).toBe('string');
    expect(frame.session_id).not.toBe('');
    const session = {
        api,
        socket,
        sessionId: frame.session_id,
        headers: { [SESSION_HEADER]: frame.session_id },
        directory: userFile(api.handle, 'userImages', '_sandbox_tmp', frame.session_id),
    };
    sessions.add(session);
    expect(JSON.parse(await fs.readFile(path.join(session.directory, 'session.json'), 'utf8')).userHandle)
        .toBe(api.handle);
    return session;
}

async function upload(api, session = null, extra = {}) {
    const response = await api.post('/api/images/upload', {
        image: imageBytes.toString('base64'),
        format: 'png',
        ch_name: 'formal_visual',
        ...extra,
    }, session?.headers ?? {});
    expect(response.status()).toBe(200);
    return (await response.json()).path;
}

async function closeSession(session) {
    const response = await session.api.post('/api/transient-sessions/close', {}, session.headers);
    expect(response.status()).toBe(200);
    return response;
}

async function promote(session, imagePath) {
    const response = await session.api.post('/api/sd/character-sources/promote-staged', {
        paths: [imagePath],
        profileId: 'profile_visual',
        namespace: NAMESPACE,
    }, session.headers);
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.images).toHaveLength(1);
    expect(result.images[0].sourcePath).toBe(imagePath);
    return result;
}

async function saveImageReference(api, imagePath) {
    const profile = normalizeCharacterProfile({
        id: 'profile_visual',
        name: 'Visual profile',
        description: 'Visual profile description.',
        referenceImages: [{ path: imagePath, label: 'Default' }],
    });
    const response = await api.post('/api/state/set', {
        namespace: NAMESPACE,
        data: { version: 2, profiles: { [profile.id]: profile } },
    });
    expect(response.status()).toBe(200);
}

async function beginDelayedStateWrite(api, session, imagePath) {
    const token = (await (await api.client.get('/csrf-token')).json()).token;
    const { cookies } = await api.client.storageState();
    const body = JSON.stringify({
        namespace: NAMESPACE,
        data: { referenceImage: imagePath },
    });
    const outgoing = httpRequest(new URL('/api/state/set', server.baseURL), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
            'X-CSRF-Token': token,
            ...session.headers,
        },
    });
    const response = new Promise((resolve, reject) => {
        outgoing.on('error', reject);
        outgoing.on('response', incoming => {
            const chunks = [];
            incoming.on('data', chunk => chunks.push(chunk));
            incoming.on('error', reject);
            incoming.on('end', () => resolve({
                status: incoming.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
    });
    let ended = false;
    const finish = () => {
        if (!ended) outgoing.end(body.slice(-1));
        ended = true;
    };
    releases.add(finish);
    await new Promise((resolve, reject) => {
        outgoing.write(body.slice(0, -1), error => error ? reject(error) : resolve());
    });
    return { finish, response };
}

async function waitForJournal(session, predicate) {
    const events = fs.watch(session.directory, { signal: testScope.signal });
    const read = async () => JSON.parse(await fs.readFile(path.join(session.directory, 'session.json'), 'utf8'));
    try {
        let journal = await read();
        if (predicate(journal)) return journal;
        while (!(await events.next()).done) {
            journal = await read();
            if (predicate(journal)) return journal;
        }
    } finally {
        await events.return();
    }
}

async function waitForRemoval(directory, action) {
    const events = fs.watch(path.dirname(directory), { signal: testScope.signal });
    try {
        await action();
        if (!existsSync(directory)) return;
        while (!(await events.next()).done) {
            if (!existsSync(directory)) return;
        }
    } finally {
        await events.return();
    }
}

// This matches the existing real-server fixture's 60-second startup readiness budget.
beforeAll(async () => {
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: 'transient-media',
        extraConfig: { enableUserAccounts: true, disableCsrfProtection: false },
    });
    imageBytes = Buffer.from(await new Jimp({ width: 128, height: 192, color: 0x4488ccff }).getBuffer(JimpMime.png));
    admin = await createApi('default-user');
    const created = await admin.post('/api/users/create', { handle: 'media-other', name: 'Other media user' });
    if (!created.ok()) throw new Error(`Cannot create fixture user (${created.status()}): ${await created.text()}`);
    otherUser = await createApi('media-other');
}, 60_000);

beforeEach(() => {
    testScope = new AbortController();
});

afterEach(async () => {
    for (const release of releases) release();
    releases.clear();
    testScope?.abort();
    try {
        for (const session of sessions) {
            if (session.socket.readyState === WebSocket.OPEN) await closeSession(session);
        }
    } finally {
        sessions.clear();
        for (const socket of sockets) {
            if (socket.readyState === WebSocket.OPEN) socket.close();
            else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        }
        sockets.clear();
    }
});

afterAll(async () => {
    await admin?.client.dispose();
    await otherUser?.client.dispose();
    await tearDownServer(server);
});

describe('owned transient media sessions', () => {
    test('temporary previews require their owner and are not cached', async () => {
        const own = await openSession();
        const separate = await openSession();
        const imagePath = await upload(admin, own);
        expect((await admin.get(imagePath)).status()).toBe(403);
        expect((await admin.client.get(imagePath, { headers: separate.headers })).status()).toBe(403);
        expect((await otherUser.client.get(imagePath, { headers: own.headers })).status()).toBe(403);
        expect((await admin.client.get(`${path.dirname(imagePath)}/session.json`, { headers: own.headers })).status()).toBe(403);
        const preview = await admin.client.get(imagePath, { headers: own.headers });
        expect(preview.status()).toBe(200);
        expect(await preview.body()).toEqual(imageBytes);
        expect(preview.headers()['cache-control']).toBe('no-store');
    });

    test('ownsMediaByUserAndSession', async () => {
        const own = await openSession();
        const separate = await openSession();
        const foreign = await openSession(otherUser);
        const formalImage = await upload(admin);
        const ownImage = await upload(admin, own, { ch_name: '../../outside' });
        const separateImage = await upload(admin, separate);
        const foreignImage = await upload(otherUser, foreign);
        expect(ownImage).toContain(`/_sandbox_tmp/${own.sessionId}/`);
        expect(await fs.readFile(absoluteImage(admin.handle, ownImage))).toEqual(imageBytes);

        const foreignWrite = await otherUser.post('/api/images/upload', {
            image: imageBytes.toString('base64'), format: 'png',
        }, own.headers);
        expect(foreignWrite.status()).toBe(403);
        const separateDelete = await admin.post('/api/images/delete', { path: separateImage }, own.headers);
        expect(separateDelete.status()).toBe(403);
        const unownedDelete = await admin.post('/api/images/delete', { path: ownImage });
        expect(unownedDelete.status()).toBe(403);
        const formalDelete = await admin.post('/api/images/delete', { path: formalImage }, own.headers);
        expect(formalDelete.status()).toBe(403);
        const folders = await admin.post('/api/images/folders');
        expect(await folders.json()).not.toContain('_sandbox_tmp');
        expect((await admin.post('/api/images/list', { folder: '_sandbox_tmp' })).status()).toBe(403);

        await closeSession(own);
        await closeSession(own);
        await expect(fs.stat(own.directory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(absoluteImage(admin.handle, formalImage))).toEqual(imageBytes);
        expect(await fs.readFile(absoluteImage(admin.handle, separateImage))).toEqual(imageBytes);
        expect(await fs.readFile(absoluteImage(otherUser.handle, foreignImage))).toEqual(imageBytes);
        const closedWrite = await admin.post('/api/images/upload', {
            image: imageBytes.toString('base64'), format: 'png',
        }, own.headers);
        expect(closedWrite.status()).toBe(410);
    });

    test('rejects unbound sessions and reserved-directory writes', async () => {
        const forged = await admin.post('/api/images/upload', {
            image: imageBytes.toString('base64'), format: 'png',
        }, { [SESSION_HEADER]: randomUUID() });
        expect(forged.status()).toBe(403);
        const reserved = await admin.post('/api/images/upload', {
            image: imageBytes.toString('base64'), format: 'png', ch_name: '_sandbox_tmp',
        });
        expect(reserved.status()).toBe(403);
    });

    test('bulk media deletion cannot bypass temporary ownership', async () => {
        const directory = userFile(admin.handle, 'userImages', '_sandbox_tmp', 'unbound-resource');
        const file = path.join(directory, 'retained.png');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(file, imageBytes);
        try {
            const response = await admin.post('/api/media/delete', {
                paths: ['/user/images/_sandbox_tmp/unbound-resource/retained.png'],
            });
            expect(response.status()).toBe(403);
            expect(await fs.readFile(file)).toEqual(imageBytes);
        } finally {
            await fs.rm(directory, { recursive: true });
        }
    });

    test('stages actual downloads and local images and cleans them on socket close', async () => {
        const session = await openSession();
        const formalImage = await upload(admin);
        const local = await admin.post('/api/sd/character-sources/promote-local-image', {
            sourcePath: formalImage, profileId: 'profile_visual', staging: true,
        }, session.headers);
        expect(local.status()).toBe(200);
        const downloaded = await admin.post('/api/sd/character-sources/fetch-image', {
            imageUrl: SOURCE_IMAGE_URL, profileId: 'profile_visual', staging: true,
        }, session.headers);
        expect(downloaded.status()).toBe(200);
        for (const result of [await local.json(), await downloaded.json()]) {
            expect(result.imagePath).toContain(`/_sandbox_tmp/${session.sessionId}/`);
            expect((await fs.stat(absoluteImage(admin.handle, result.imagePath))).size).toBeGreaterThan(0);
        }
        const missingSession = await admin.post('/api/sd/character-sources/promote-local-image', {
            sourcePath: formalImage, staging: true,
        });
        expect(missingSession.status()).toBe(403);
        await waitForRemoval(session.directory, () => {
            session.socket.close();
            return once(session.socket, 'close');
        });
        expect(await fs.readFile(absoluteImage(admin.handle, formalImage))).toEqual(imageBytes);
    });

    test('closing an already released owner session is idempotent', async () => {
        const session = await openSession();
        await upload(admin, session);
        await waitForRemoval(session.directory, () => {
            session.socket.close();
            return once(session.socket, 'close');
        });
        const response = await closeSession(session);
        expect(await response.json()).toEqual({ ok: true });
    });

    test('unscoped reference promotion cannot persist temporary images', async () => {
        const session = await openSession();
        const image = await upload(admin, session);
        const response = await admin.post('/api/sd/character-sources/promote-local-image', {
            sourcePath: image, profileId: 'profile_visual',
        });
        expect(response.status()).toBe(403);
        expect(await fs.readFile(absoluteImage(admin.handle, image))).toEqual(imageBytes);
    });

    test('cleansLateWritesAfterClose', async () => {
        const session = await openSession();
        const filename = 'late-image.png';
        const fifo = path.join(session.directory, filename);
        execFileSync('mkfifo', [fifo]);
        let reader;
        const release = () => {
            if (!reader) {
                reader = createReadStream(fifo);
                reader.resume();
            }
        };
        releases.add(release);
        const uploaded = admin.post('/api/images/upload', {
            image: imageBytes.toString('base64'), format: 'png', filename,
        }, session.headers);
        await waitForJournal(session, journal => journal.files.some(file => file.endsWith('/' + filename)));
        const closed = admin.post('/api/transient-sessions/close', {}, session.headers);
        await waitForJournal(session, journal => journal.state === 'closing');
        release();
        expect((await uploaded).status()).toBe(200);
        expect((await closed).status()).toBe(200);
        await expect(fs.stat(session.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('retriesFailedCleanup', async () => {
        const session = await openSession();
        const ownImage = await upload(admin, session);
        const originalMode = (await fs.stat(session.directory)).mode & 0o777;
        try {
            await fs.chmod(session.directory, 0o555);
            const failed = await admin.post('/api/transient-sessions/close', {}, session.headers);
            expect(failed.status()).toBe(500);
            expect((await failed.json()).details).toContain('EACCES');
            expect(await fs.readFile(absoluteImage(admin.handle, ownImage))).toEqual(imageBytes);
            expect(await fs.stat(path.join(session.directory, 'session.json'))).toBeDefined();
        } finally {
            await fs.chmod(session.directory, originalMode);
        }
        await closeSession(session);
        await expect(fs.stat(session.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rollback deletes only its own new copies', async () => {
        const session = await openSession();
        const formalImage = await upload(admin);
        const temporaryImage = await upload(admin, session);
        const first = await promote(session, temporaryImage);
        const second = await promote(session, temporaryImage);
        expect(first.images[0].imagePath).not.toBe(second.images[0].imagePath);
        const rolledBack = await admin.post('/api/sd/character-sources/rollback-staged-promotion', {
            promotionId: first.promotionId,
        }, session.headers);
        expect(rolledBack.status()).toBe(200);
        await expect(fs.stat(absoluteImage(admin.handle, first.images[0].imagePath)))
            .rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(absoluteImage(admin.handle, formalImage))).toEqual(imageBytes);
        expect(await fs.stat(absoluteImage(admin.handle, second.images[0].imagePath))).toBeDefined();
        expect(await fs.readFile(absoluteImage(admin.handle, temporaryImage))).toEqual(imageBytes);
    });

    test('a late profile write cannot commit references after its media session closes', async () => {
        const session = await openSession();
        const temporaryImage = await upload(admin, session);
        const promoted = await promote(session, temporaryImage);
        const stateUrl = `/api/state/get?account=${admin.handle}&namespace=${NAMESPACE}`;
        const before = await (await admin.get(stateUrl)).json();
        const pending = await beginDelayedStateWrite(admin, session, promoted.images[0].imagePath);
        await closeSession(session);
        await expect(fs.stat(absoluteImage(admin.handle, promoted.images[0].imagePath)))
            .rejects.toMatchObject({ code: 'ENOENT' });
        pending.finish();
        const response = await pending.response;
        expect(response.status).toBe(410);
        expect((await (await admin.get(stateUrl)).json()).data).toEqual(before.data);
    });

    test('a media session cannot mutate state outside its pending promotion', async () => {
        const session = await openSession();
        const namespace = 'unrelated_visual_state';
        const set = await admin.post('/api/state/set', {
            namespace, data: { value: 'Uncommitted value' },
        }, session.headers);
        expect(set.status()).toBe(403);
        const patch = await admin.post('/api/state/patch', {
            namespace, operations: [{ op: 'add', path: '/value', value: 'Uncommitted value' }],
        }, session.headers);
        expect(patch.status()).toBe(403);
        const deleted = await admin.post('/api/state/delete', { namespace }, session.headers);
        expect(deleted.status()).toBe(403);
    });

    test('a text-only draft can acquire a scoped save without copying images', async () => {
        const session = await openSession();
        const references = userFile(admin.handle, 'userImages', '_references');
        const before = existsSync(references) ? await fs.readdir(references) : [];
        const prepared = await admin.post('/api/sd/character-sources/promote-staged', {
            paths: [], namespace: NAMESPACE, profileId: 'profile_visual',
        }, session.headers);
        expect(prepared.status()).toBe(200);
        const promotion = await prepared.json();
        expect(promotion.images).toEqual([]);
        const saved = await admin.post('/api/state/set', {
            namespace: NAMESPACE, data: { version: 2, profiles: {} },
        }, session.headers);
        expect(saved.status()).toBe(200);
        const patched = await admin.post('/api/state/patch', {
            namespace: NAMESPACE,
            operations: [{ op: 'add', path: '/note', value: 'Confirmed visual draft' }],
        }, session.headers);
        expect(patched.status()).toBe(200);
        const complete = await admin.post('/api/sd/character-sources/complete-staged-promotion', {
            promotionId: promotion.promotionId,
        }, session.headers);
        expect(complete.status()).toBe(200);
        await closeSession(session);
        const after = existsSync(references) ? await fs.readdir(references) : [];
        expect(after.sort()).toEqual(before.sort());
    });

    test('recoversInterruptedPromotion', async () => {
        const session = await openSession();
        const image = await upload(admin, session);
        const adopted = await promote(session, image);
        const discarded = await promote(session, image);
        await saveImageReference(admin, adopted.images[0].imagePath);
        expect(await fs.stat(absoluteImage(admin.handle, discarded.images[0].imagePath))).toBeDefined();
        await server.kill('SIGKILL');
        expect(await fs.stat(session.directory)).toBeDefined();
        await server.restart();
        await admin.login();
        await otherUser.login();
        await expect(fs.stat(session.directory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.stat(absoluteImage(admin.handle, adopted.images[0].imagePath))).toBeDefined();
        await expect(fs.stat(absoluteImage(admin.handle, discarded.images[0].imagePath)))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('a failed reference-state read preserves the promotion journal and permits retry', async () => {
        const session = await openSession();
        const image = await upload(admin, session);
        const promoted = await promote(session, image);
        await saveImageReference(admin, promoted.images[0].imagePath);
        const stateFile = userFile(admin.handle, 'states', NAMESPACE + '.json');
        const original = await fs.readFile(stateFile);
        try {
            await fs.writeFile(stateFile, '{');
            const failed = await admin.post('/api/transient-sessions/close', {}, session.headers);
            expect(failed.status()).toBe(500);
            expect(await fs.stat(session.directory)).toBeDefined();
            expect(await fs.stat(absoluteImage(admin.handle, promoted.images[0].imagePath))).toBeDefined();
        } finally {
            await fs.writeFile(stateFile, original);
        }
        await closeSession(session);
        await expect(fs.stat(session.directory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.stat(absoluteImage(admin.handle, promoted.images[0].imagePath))).toBeDefined();
    });

    test('failed startup recovery retains ownership for a checked cleanup retry', async () => {
        const session = await openSession();
        const image = await upload(admin, session);
        const promoted = await promote(session, image);
        await saveImageReference(admin, promoted.images[0].imagePath);
        const stateFile = userFile(admin.handle, 'states', NAMESPACE + '.json');
        const original = await fs.readFile(stateFile);
        try {
            await fs.writeFile(stateFile, '{');
            await server.kill('SIGKILL');
            await server.restart();
            await admin.login();
            const failed = await admin.post('/api/transient-sessions/close', {}, session.headers);
            expect(failed.status()).toBe(500);
            expect(await fs.stat(session.directory)).toBeDefined();
            expect(await fs.stat(absoluteImage(admin.handle, promoted.images[0].imagePath))).toBeDefined();
        } finally {
            await fs.writeFile(stateFile, original);
        }
        await closeSession(session);
        await expect(fs.stat(session.directory)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.stat(absoluteImage(admin.handle, promoted.images[0].imagePath))).toBeDefined();
    });

    test('blocks method, encoded-delimiter traversal, and journal reads and enforces ownership on SD reference endpoints and delete', async () => {
        const own = await openSession();
        const other = await openSession();
        const ownImage = await upload(admin, own);
        const fileName = path.basename(ownImage);

        // Method bypass (POST /user/images/*) and direct journal reads are rejected.
        expect((await admin.post(`/user/images/_sandbox_tmp/${own.sessionId}/${fileName}`, {})).status()).toBe(403);
        expect((await admin.post(`/user/images/_sandbox_tmp/${own.sessionId}/session.json`, {})).status()).toBe(403);
        expect((await admin.get(`/user/images/_sandbox_tmp/${own.sessionId}/session.json`, own.headers)).status()).toBe(403);

        // Percent-encoded '?' / '#' traversal attempts cannot bypass guardTransientMediaRead.
        expect((await admin.get(`/user/images/x%3F/../_sandbox_tmp/${own.sessionId}/${fileName}`)).status()).toBe(403);
        expect((await admin.get(`/user/images/x%23/../_sandbox_tmp/${own.sessionId}/session.json`)).status()).toBe(403);

        // SD ComfyUI reference upload and SD luker-dispatch endpoints enforce transient ownership.
        const unownedUpload = await admin.post('/api/sd/comfy/upload-references', {
            url: 'http://127.0.0.1:1',
            references: [{ imagePath: ownImage, role: 'character' }],
        });
        expect(unownedUpload.status()).toBe(403);
        const crossSessionUpload = await admin.post('/api/sd/comfy/upload-references', {
            url: 'http://127.0.0.1:1',
            references: [{ imagePath: ownImage, role: 'character' }],
        }, other.headers);
        expect(crossSessionUpload.status()).toBe(403);
        const unownedDispatch = await admin.post('/api/sd/comfy/generate', {
            url: 'http://127.0.0.1:1',
            prompt: {},
            references: [{ imagePath: ownImage, role: 'character' }],
        });
        expect(unownedDispatch.status()).toBe(403);

        // Deleting a transient image removes it from the session journal so promote rejects cleanly with 403 (not 500 ENOENT).
        const deleted = await admin.post('/api/images/delete', { path: ownImage }, own.headers);
        expect(deleted.status()).toBe(200);
        const promoteDeleted = await admin.post('/api/sd/character-sources/promote-staged', {
            paths: [ownImage],
            profileId: 'profile_visual',
            namespace: NAMESPACE,
        }, own.headers);
        expect(promoteDeleted.status()).toBe(403);

        await closeSession(own);
        await closeSession(other);
    });
});
