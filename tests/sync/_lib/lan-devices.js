import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createSyncRouter } from '../../../src/endpoints/sync.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { PEER_SECRET_HEADER, PAIR_CODE_HEADER } from '../../../src/sync/session.js';
import { readRegistry, updateRegistry } from '../../../src/sync/state.js';
import { syncService } from '../../../src/sync/sync-service.js';
import { makeUserDirs } from './user-dirs.js';
import { createSyncFetch } from '../../../src/sync/net-guard.js';

export async function startLanDevice({ handle = 'u', name = handle, makeEngine, deviceLabel, beforeRequest } = {}) {
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-lan-'));
    // Devices of one test share a host name, which is the default label.
    if (deviceLabel) await updateRegistry({ userRoot }, registry => { registry.device.label = deviceLabel; });
    const directories = makeUserDirs(userRoot);
    for (const key of ['chats', 'groups', 'groupChats']) fs.mkdirSync(directories[key], { recursive: true });
    const engine = makeEngine ? await makeEngine(directories) : new FsEngine({ directoriesByHandle: () => directories });
    const profile = { handle, name, enabled: true, admin: true };
    const fixtureFetch = createSyncFetch({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) }, enableAccounts: true });
    let port = 0;
    const userStore = {
        listHandles: async () => [handle],
        getDirectories: () => directories,
        getProfile: async () => profile,
        getEngine: () => engine,
        selfCallback: () => ({ scheme: 'http', port, baseUrls: [`http://127.0.0.1:${port}`] }),
    };
    const requests = [];
    const app = express();
    app.use(async (request, _response, next) => {
        requests.push(`${request.method} ${request.path}`);
        if (!request.path.startsWith('/api/sync/v1/session/')) request.user = { profile, directories };
        try {
            if (beforeRequest) await beforeRequest(request);
            next();
        } catch (error) { next(error); }
    });
    app.use('/api/sync/v1', createSyncRouter({ userStore }));
    const server = await new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
    port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const abs = rel => path.join(userRoot, ...rel.split('/'));
    const call = async (method, route, { body, headers = {} } = {}) => {
        const res = await fixtureFetch(`${baseUrl}/api/sync/v1${route}`, {
            method,
            headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        return { status: res.status, body: parsed };
    };
    const owner = { handle, displayName: name, userRoot, directories, engine, selfCallback: () => userStore.selfCallback(), getCurrentProfile: async () => profile };
    return {
        handle, userRoot, directories, engine, baseUrl, userStore, profile, requests, owner,
        write(rel, content) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content); },
        read(rel) { return fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : null; },
        call,
        request: fixtureFetch,
        /** True while no network run of this device is in progress. */
        idle: () => Object.values(syncService.getRunning(userRoot)).every(running => !running),
        offer(body, { secret, pairCode } = {}) {
            const headers = {};
            if (secret) headers[PEER_SECRET_HEADER] = secret;
            if (pairCode) headers[PAIR_CODE_HEADER] = pairCode;
            return call('POST', '/session/offer', { body, headers });
        },
        async close() {
            // Removing every backend waits for the runs a notify or a
            // pairing started in the background.
            for (const id of Object.keys((await readRegistry({ userRoot })).backends)) {
                await syncService.removeBackend(owner, id);
            }
            await new Promise(done => server.close(done));
            fs.rmSync(userRoot, { recursive: true, force: true });
        },
    };
}

export async function pair(A, B, { categories = ['worlds', 'chats'] } = {}) {
    const start = await A.call('POST', '/pair/start', { body: { label: 'B device', categories } });
    if (start.status !== 200) throw new Error(`pair/start failed: ${JSON.stringify(start)}`);
    const accept = await B.call('POST', '/pair/accept', { body: {
        peerBaseUrl: A.baseUrl, remotePeerId: start.body.peerId, label: 'A device', categories, pairCode: start.body.pairCode,
    } });
    if (accept.status !== 200) throw new Error(`pair/accept failed: ${JSON.stringify(accept)}`);
    return start.body.peerId;
}
