import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { startLanDevice } from './_lib/lan-devices.js';
import { makeUserDirs } from './_lib/user-dirs.js';
import { commitFiles } from './_lib/commits.js';
import { LanBackend } from '../../src/sync/backends/lan/client.js';
import { incomingRefFor } from '../../src/sync/backends/lan/incoming.js';
import { runSyncCycle } from '../../src/sync/pipeline/cycle.js';
import { readRegistry, upsertLanBackend, removeBackendCompletely } from '../../src/sync/state.js';
import { ensureShadowRepo } from '../../src/sync/shadow.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { FsEngine } from '../../src/storage/engines/fs-engine.js';
import { _resetGateForTests } from '../../src/sync/in-progress-gate.js';
import { syncService } from '../../src/sync/sync-service.js';
import { until } from './_lib/until.js';
import { startDnsFixture, startTlsFixture, startHttpFixture } from './_lib/network-fixtures.js';

const SECRET = 'a'.repeat(64);
const PEER = 'u@0a1b2c3d';

describe('LanBackend against a real peer router', () => {
    let A;
    let bRoot;
    let bDirs;
    const entry = (lan = {}) => ({ kind: 'lan', label: 'A device', categories: ['worlds'], lan: { peerId: PEER, peerBaseUrl: A.baseUrl, peerAuth: null, syncSecret: SECRET, ...lan } });
    const owner = { getCurrentProfile: async () => ({ enabled: true, admin: true }) };
    const lanFor = (extra = {}) => new LanBackend({ id: PEER, owner, userRoot: bRoot, entry: entry(extra), deviceLabel: 'B device', callback: A.userStore.selfCallback() });
    const bCtx = backend => ({ userRoot: bRoot, handle: 'u', directories: bDirs, backendId: PEER, categories: ['worlds'], engine: new FsEngine({ directoriesByHandle: () => bDirs }), backend });
    const aGitdir = async () => (await ensureShadowRepo({ userRoot: A.userRoot, peerId: PEER })).gitDir;
    const writeB = (rel, content) => { const abs = path.join(bRoot, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); };

    beforeEach(async () => {
        _resetGateForTests();
        A = await startLanDevice();
        await upsertLanBackend({ userRoot: A.userRoot, backendId: PEER, label: 'B device', categories: ['worlds'], syncSecret: SECRET });
        bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-lan-b-'));
        bDirs = makeUserDirs(bRoot);
    });
    afterEach(async () => {
        // Waits for runs a notify started in the background.
        await syncService.removeBackend(A.owner, PEER);
        await A.close();
        fs.rmSync(bRoot, { recursive: true, force: true });
    });

    test('a peer whose health reports no protocol is rejected', async () => {
        const stub = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(req.url === '/api/sync/v1/health' ? '{"ok":true}' : '{}');
        });
        await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
        try {
            const lan = lanFor({ peerBaseUrl: `http://127.0.0.1:${stub.address().port}` });
            await expect(lan.readHead()).rejects.toMatchObject({ code: 'PEER_PROTOCOL_OUTDATED' });
        } finally {
            await new Promise(resolve => stub.close(resolve));
        }
    });

    test('a peer answering a sync request with a non-JSON page is rejected with a code', async () => {
        // Exercise the genuine router's HTML 404 response, not a fake peer.
        await expect(lanFor().request('/not-a-sync-route')).rejects.toMatchObject({ code: 'PEER_ERROR' });
    });

    test('the offer carries the secret, protocol and callback', async () => {
        await lanFor().openSession();
        expect((await readRegistry({ userRoot: A.userRoot })).backends[PEER].lan.peerBaseUrl).toBe(A.baseUrl);
        expect(A.requests).toEqual(['GET /api/sync/v1/health', 'POST /api/sync/v1/session/offer']);
    });

    test('every connection checks the current profile and preserves the policy error', async () => {
        const previous = process.env.LUKER_ENABLE_USER_ACCOUNTS;
        process.env.LUKER_ENABLE_USER_ACCOUNTS = 'true';
        const profile = { enabled: true, admin: true };
        const backend = new LanBackend({ id: PEER, owner: { getCurrentProfile: async () => profile }, userRoot: bRoot, entry: entry(), deviceLabel: 'B', callback: null });
        try {
            await backend.openSession();
            profile.admin = false;
            const before = [...A.requests];
            await expect(backend.readHead()).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            expect(A.requests).toEqual(before);
            profile.admin = true;
            await expect(backend.readHead()).resolves.toBeNull();
        } finally {
            await backend.close();
            if (previous === undefined) delete process.env.LUKER_ENABLE_USER_ACCOUNTS;
            else process.env.LUKER_ENABLE_USER_ACCOUNTS = previous;
        }
    });

    test('the LAN constructor carries real DNS and CA through hostname and IP identity checks', async () => {
        const dns = await startDnsFixture();
        const backends = [];
        const forward = (req, res) => {
            const upstream = http.request(`${A.baseUrl}${req.url}`, { method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
            upstream.on('error', error => res.destroy(error)); req.pipe(upstream);
        };
        const tls = await startTlsFixture({ dnsSans: ['peer.sync.test'], ipSans: ['127.0.0.1'], handler: forward });
        const dnsOnly = await startTlsFixture({ dnsSans: ['peer.sync.test'], handler: forward });
        const make = (url, ca = tls.caPem) => {
            const backend = new LanBackend({ id: PEER, owner, userRoot: bRoot, entry: entry({ peerBaseUrl: url }), deviceLabel: 'DNS inheritor', callback: null,
                network: { resolveAll: dns.resolveAll, ca } });
            backends.push(backend); return backend;
        };
        try {
            for (const name of ['peer.sync.test', 'wrong.sync.test']) dns.setAnswers(name, { a: ['127.0.0.1'], aaaa: [] });
            await make(`https://peer.sync.test:${tls.port}`).openSession();
            expect(tls.hits.map(hit => hit.url)).toEqual(['/api/sync/v1/health', '/api/sync/v1/session/offer']);
            expect(tls.hits.map(hit => hit.host)).toEqual([`peer.sync.test:${tls.port}`, `peer.sync.test:${tls.port}`]);
            expect(tls.sniNames).toEqual(['peer.sync.test', 'peer.sync.test']);
            await expect(make(`https://wrong.sync.test:${tls.port}`).openSession()).rejects.toMatchObject({ code: 'PEER_UNREACHABLE', message: 'ERR_TLS_CERT_ALTNAME_INVALID' });
            expect((await make(`https://127.0.0.1:${tls.port}`).request('/health')).ok).toBe(true);
            expect(tls.hits).toHaveLength(3);
            await expect(make(`https://127.0.0.1:${dnsOnly.port}`, dnsOnly.caPem).openSession()).rejects.toMatchObject({ code: 'PEER_UNREACHABLE', message: 'ERR_TLS_CERT_ALTNAME_INVALID' });
            expect(dnsOnly.hits).toEqual([]);
        } finally { for (const backend of backends) await backend.close(); await dns.close(); await tls.close(); await dnsOnly.close(); }
    });

    test('LAN mixed DNS, rebinding and held-DNS revocation never contact the forbidden peer', async () => {
        const previous = process.env.LUKER_ENABLE_USER_ACCOUNTS;
        process.env.LUKER_ENABLE_USER_ACCOUNTS = 'true';
        const dns = await startDnsFixture();
        const profile = { enabled: true, admin: false };
        const observations = [];
        const make = base => new LanBackend({ id: PEER, owner: { getCurrentProfile: async () => profile }, userRoot: bRoot, entry: entry({ peerBaseUrl: base }), deviceLabel: 'Guarded', callback: null,
            network: { resolveAll: dns.resolveAll, onValidatedDial: value => { observations.push(value); if (!profile.admin) throw new Error('Public dial stopped after validation'); } } });
        const backend = make(A.baseUrl.replace('127.0.0.1', 'peer.sync.test'));
        const portZero = make('http://peer.sync.test:0');
        const before = [...A.requests];
        let hold;
        try {
            dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: ['::1'] });
            await expect(backend.openSession()).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            expect(observations).toEqual([]);
            dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: [] });
            // node-fetch normalizes port zero to 80. Stop at the immutable
            // observation rather than contacting an external public host.
            await expect(portZero.openSession()).rejects.toMatchObject({ code: 'PEER_UNREACHABLE' });
            expect(observations).toEqual([expect.objectContaining({ address: '8.8.8.8', port: 80 })]);
            dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
            await expect(portZero.openSession()).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            profile.admin = true;
            hold = dns.holdNext('peer.sync.test');
            const pending = backend.openSession().catch(error => error);
            await hold.reached;
            profile.admin = false; hold.release();
            expect(await pending).toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
            expect(A.requests).toEqual(before);
            expect(observations).toHaveLength(1);
        } finally {
            hold?.release(); await backend.close(); await portZero.close(); await dns.close();
            if (previous === undefined) delete process.env.LUKER_ENABLE_USER_ACCOUNTS;
            else process.env.LUKER_ENABLE_USER_ACCOUNTS = previous;
        }
    });

    test('LAN rejects a redirect without following it to the real peer', async () => {
        const redirect = await startHttpFixture((_req, res) => { res.writeHead(302, { Location: `${A.baseUrl}/api/sync/v1/health` }); res.end(); });
        const backend = lanFor({ peerBaseUrl: redirect.url });
        try {
            await expect(backend.openSession()).rejects.toMatchObject({ code: 'PEER_UNREACHABLE' });
            expect(redirect.hits).toHaveLength(1);
            expect(A.requests).toEqual([]);
        } finally { await backend.close(); await redirect.close(); }
    });

    test('readHead reports the peer main with the incoming ref as etag', async () => {
        A.write('worlds/a.json', '{}');
        const lan = lanFor();
        const head = await lan.readHead();
        expect(head.etag).toBe('none');
        expect(head.oid).toBe(await git.resolveRef({ fs: atomicFs, gitdir: await aGitdir(), ref: 'refs/heads/main' }));
        expect(lan.observedIncoming).toBeNull();
    });

    test('casHead compares against the incoming ref observed by readHead when the head was null', async () => {
        const lan = lanFor();
        await lan.openSession();
        const gitdir = await aGitdir();
        const earlier = await commitFiles(gitdir, { 'worlds/x.json': 'X' });
        await git.deleteRef({ fs: atomicFs, gitdir, ref: 'refs/heads/main' });
        await git.writeRef({ fs: atomicFs, gitdir, ref: incomingRefFor(PEER), value: earlier, force: true });
        expect(await lan.readHead()).toBeNull();
        expect(lan.observedIncoming).toBe(earlier);
        const { gitDir: bGitdir } = await ensureShadowRepo({ userRoot: bRoot, peerId: PEER });
        const mine = await commitFiles(bGitdir, { 'worlds/b.json': 'B' });
        await lan.pushObjects(mine, null);
        expect(await lan.casHead(null, mine)).toEqual({ ok: true });
        expect(await git.resolveRef({ fs: atomicFs, gitdir, ref: incomingRefFor(PEER) })).toBe(mine);
    });

    test('a cycle with nothing new sends no ref update or notify', async () => {
        writeB('worlds/b.json', 'B');
        await runSyncCycle(bCtx(lanFor()));
        A.requests.length = 0;
        const outcome = await runSyncCycle(bCtx(lanFor()));
        expect(outcome.mergeCase).toBe('equal');
        expect(A.requests.filter(r => r.endsWith('/session/ref') || r.endsWith('/session/notify'))).toEqual([]);
    });

    test('casHead to the value already in place sends nothing and skips notify', async () => {
        const lan = lanFor();
        await lan.readHead();
        A.requests.length = 0;
        const { gitDir: bGitdir } = await ensureShadowRepo({ userRoot: bRoot, peerId: PEER });
        const same = await commitFiles(bGitdir, { 'worlds/s.json': 'S' });
        expect(await lan.casHead(same, same)).toEqual({ ok: true });
        await lan.notifyPeer();
        expect(A.requests).toEqual([]);
    });

    test('pushObjects skips the closures of the peer head and of the observed incoming ref', async () => {
        writeB('worlds/b.json', 'B');
        await runSyncCycle(bCtx(lanFor()));
        writeB('worlds/c.json', 'C');
        A.requests.length = 0;
        await runSyncCycle(bCtx(lanFor()));
        expect(A.requests.filter(r => r === 'POST /api/sync/v1/session/object')).toHaveLength(4);
    });

    test('a moved incoming ref turns the push into a conflict result', async () => {
        const lan = lanFor();
        expect(await lan.readHead()).toBeNull();
        const gitdir = await aGitdir();
        const other = await commitFiles(gitdir, { 'worlds/o.json': 'O' });
        await git.writeRef({ fs: atomicFs, gitdir, ref: incomingRefFor(PEER), value: other, force: true });
        const { gitDir: bGitdir } = await ensureShadowRepo({ userRoot: bRoot, peerId: PEER });
        const mine = await commitFiles(bGitdir, { 'worlds/b.json': 'B' });
        await lan.pushObjects(mine, null);
        expect(await lan.casHead(null, mine)).toEqual({ ok: false, reason: 'conflict' });
    });

    test('error statuses map to codes', async () => {
        await expect(lanFor({ syncSecret: 'b'.repeat(64) }).readHead()).rejects.toMatchObject({ code: 'PEER_AUTH_FAILED' });
        await expect(lanFor({ peerBaseUrl: '' }).readHead()).rejects.toMatchObject({ code: 'NO_BASE_URL' });
        const closed = http.createServer();
        await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
        const port = closed.address().port;
        await new Promise(resolve => closed.close(resolve));
        await expect(lanFor({ peerBaseUrl: `http://127.0.0.1:${port}` }).readHead()).rejects.toMatchObject({ code: 'PEER_UNREACHABLE', message: 'ECONNREFUSED' });
        await removeBackendCompletely({ userRoot: A.userRoot, backendId: PEER });
        await expect(lanFor().readHead()).rejects.toMatchObject({ code: 'PEER_FORGOTTEN' });
    });

    test('a handle the peer does not have maps to HANDLE_MISMATCH', async () => {
        const other = new LanBackend({ id: 'bob@0a1b2c3d', owner, userRoot: bRoot, entry: { ...entry(), lan: { ...entry().lan, peerId: 'bob@0a1b2c3d' } }, deviceLabel: 'B', callback: null });
        await expect(other.readHead()).rejects.toMatchObject({ code: 'HANDLE_MISMATCH' });
    });

    test('a full cycle pushes into the incoming ref and the notified peer merges it', async () => {
        writeB('worlds/from-b.json', '{"b":1}');
        const outcome = await runSyncCycle(bCtx(lanFor()));
        expect(outcome).toMatchObject({ status: 'synced', pushed: true, notifyError: null });
        expect(await git.resolveRef({ fs: atomicFs, gitdir: await aGitdir(), ref: incomingRefFor(PEER) })).toBe(outcome.localHead);
        await until(() => A.read('worlds/from-b.json') === '{"b":1}');
    });
});
