import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import storage from 'node-persist';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSyncAgents, createSyncFetch, isProhibitedSyncAddress } from '../../src/sync/net-guard.js';
import { ownerFromUser } from '../../src/sync/sync-service.js';
import { startDnsFixture, startHttpFixture, startTlsFixture } from './_lib/network-fixtures.js';

const prohibited = [
    '0.0.0.0', '127.0.0.0', '127.255.255.255', '10.0.0.0', '10.255.255.255',
    '172.16.0.0', '172.31.255.255', '192.168.0.0', '192.168.255.255',
    '169.254.0.0', '169.254.255.255', '100.64.0.0', '100.127.255.255',
    '::', '::1', 'fc00::', 'fdff:ffff::1', 'fe80::', 'febf:ffff::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:0', '::ffff:ac10:1',
    '::ffff:192.168.1.1', '::ffff:169.254.1.1', '::ffff:100.64.0.1',
];
const permitted = ['1.0.0.0', '9.255.255.255', '11.0.0.0', '126.255.255.255', '128.0.0.0',
    '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '169.253.255.255',
    '169.255.0.0', '100.63.255.255', '100.128.0.0', '2001:4860:4860::8888',
    'fbff:ffff::1', 'fe00::1', 'fec0::1', '::ffff:8.8.8.8'];

describe('sync address classification', () => {
    test.each(prohibited)('blocks %s', address => expect(isProhibitedSyncAddress(address)).toBe(true));
    test.each(permitted)('allows %s', address => expect(isProhibitedSyncAddress(address)).toBe(false));
});

describe('connection-bound sync policy', () => {
    let cleanup;
    let store;
    let owner;
    let dns;
    let server;
    beforeEach(async () => {
        cleanup = [];
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'luker-sync-profile-'));
        cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
        store = storage.create({ dir, expiredInterval: 0 });
        await store.init();
        await store.setItem('alice', { handle: 'alice', enabled: true, admin: false });
        owner = ownerFromUser({ profile: await store.getItem('alice'), directories: { root: dir } }, {
            getProfile: handle => store.getItem(handle), getEngine: () => undefined, selfCallback: () => null,
        });
        dns = await startDnsFixture();
        cleanup.push(dns.close);
        server = await startHttpFixture();
        cleanup.push(server.close);
    });
    afterEach(async () => { for (const close of cleanup.reverse()) await close(); });
    function fetchFor(options = {}) {
        return createSyncFetch({ owner, enableAccounts: true, allowPrivateAddressesForUsers: false, network: { resolveAll: dns.resolveAll }, ...options });
    }
    function nameUrl(name = 'peer.sync.test') {
        return server.url.replace('127.0.0.1', name);
    }

    test('the default Node resolver accepts ENODATA but rejects mixed answers and family failures', async () => {
        // Deliberately omit resolveAll: these packets exercise the imported
        // node:dns/promises functions in the production default path.
        const request = async (url, profile = '') => {
            const { stdout } = await promisify(execFile)(process.execPath, [...process.execArgv.filter(value => value === '--jitless'),
                path.resolve('sync/_lib/default-dns-child.mjs'), dns.serverAddress, url, profile]);
            return JSON.parse(stdout);
        };
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        expect(await request(nameUrl(), 'admin')).toEqual({ status: 200, body: 'ok' });
        expect(server.hits).toHaveLength(1);
        dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: ['::1'] });
        expect(await request(nameUrl())).toEqual({ code: 'SYNC_PRIVATE_ADDRESS' });
        dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: [], servfailType: 28 });
        expect(await request(nameUrl())).toEqual({ code: 'ESERVFAIL' });
        expect(await request(nameUrl('missing.sync.test'))).toEqual({ code: 'ENOTFOUND' });
        expect(server.hits).toHaveLength(1);
        expect(dns.queries.filter(query => query.hostname === 'peer.sync.test').map(query => query.type).sort()).toEqual([1, 1, 1, 28, 28, 28]);
        expect(dns.queries.filter(query => query.hostname === 'missing.sync.test').map(query => query.type).sort()).toEqual([1, 28]);
    });

    test.each(['fetch-abort', 'native-signal', 'native-destroy', 'agents-destroy', 'http-agent-destroy'])('no late dial after held DNS cancellation: %s', async mode => {
        await store.setItem('alice', { enabled: true, admin: true });
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        const hold = dns.holdNext('peer.sync.test');
        const observations = [];
        let resolved;
        const resolution = new Promise(resolve => { resolved = resolve; });
        const network = { resolveAll: async hostname => { try { return await dns.resolveAll(hostname); } finally { resolved(); } }, onValidatedDial: observation => observations.push(observation) };
        const controller = new AbortController();
        const agents = createSyncAgents({ owner, enableAccounts: true, network });
        cleanup.push(agents.destroy);
        let req;
        const pending = mode === 'fetch-abort'
            ? fetchFor({ network })(nameUrl(), { signal: controller.signal })
            : new Promise((resolve, reject) => {
                req = http.get(nameUrl(), { agent: agents.httpAgent, signal: controller.signal }, res => { res.resume(); resolve(res); });
                req.on('error', reject);
            });
        const outcome = pending.catch(error => error);
        await hold.reached;
        if (mode === 'agents-destroy') agents.destroy();
        else if (mode === 'http-agent-destroy') agents.httpAgent.destroy();
        else if (mode === 'native-destroy') req.destroy();
        else controller.abort();
        if (mode === 'agents-destroy' || mode === 'http-agent-destroy' || mode === 'fetch-abort') {
            try {
                await outcome;
            } finally {
                hold.release();
            }
        }
        hold.release();
        expect(await outcome).toMatchObject({ name: expect.stringMatching(/Error$/) });
        await resolution;
        await new Promise(resolve => setImmediate(resolve));
        // A complete real loopback exchange drains pending DNS/socket callbacks.
        await new Promise((resolve, reject) => http.get(server.url, res => { res.resume(); res.on('end', resolve); }).on('error', reject));
        expect(observations).toEqual([]);
        expect(server.connections).toHaveLength(1);
        expect(server.hits).toEqual([{ url: '/', host: new URL(server.url).host }]);
        expect((req?.listeners('abort') ?? []).some(listener => listener.name === 'cancel')).toBe(false);
        expect((req?.listeners('close') ?? []).some(listener => listener.name === 'cancel')).toBe(false);
    });

    test.each(['abort', 'destroy'])('cancellation during an actual profile-store read prevents DNS: %s', async mode => {
        await store.setItem('alice', { enabled: true, admin: true });
        let reached;
        let release;
        const reading = new Promise(resolve => { reached = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const heldOwner = ownerFromUser({ profile: { handle: 'alice' }, directories: { root: owner.userRoot } }, {
            getEngine: () => undefined, selfCallback: () => null,
            getProfile: async handle => { const profile = await store.getItem(handle); reached(); await held; return profile; },
        });
        const agents = createSyncAgents({ owner: heldOwner, enableAccounts: true, network: { resolveAll: dns.resolveAll } });
        cleanup.push(agents.destroy);
        const controller = new AbortController();
        const outcome = new Promise((resolve, reject) => {
            http.get(nameUrl(), { agent: agents.httpAgent, signal: controller.signal }, res => { res.resume(); resolve(res); }).on('error', reject);
        }).catch(error => error);
        await reading;
        if (mode === 'abort') controller.abort();
        else agents.destroy();
        release();
        expect(await outcome).toMatchObject({ name: expect.stringMatching(/Error$/) });
        expect(dns.queries).toEqual([]);
        expect(server.connections).toEqual([]);
    });

    test('disposal at validated-dial observation prevents the socket transition', async () => {
        await store.setItem('alice', { enabled: true, admin: true });
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { onValidatedDial: () => agents.destroy() } });
        cleanup.push(agents.destroy);
        await expect(new Promise((resolve, reject) => http.get(server.url, { agent: agents.httpAgent }, res => { res.resume(); resolve(res); }).on('error', reject))).rejects.toMatchObject({ code: 'SYNC_AGENT_DESTROYED' });
        expect(server.connections).toEqual([]);
    });

    test.each(['abort', 'destroy'])('cancellation during the post-DNS profile read prevents dialing: %s', async mode => {
        await store.setItem('alice', { enabled: true, admin: true });
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        let reached;
        let release;
        let reads = 0;
        const reading = new Promise(resolve => { reached = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const heldOwner = ownerFromUser({ profile: { handle: 'alice' }, directories: { root: owner.userRoot } }, {
            getEngine: () => undefined, selfCallback: () => null,
            getProfile: async handle => {
                const profile = await store.getItem(handle);
                if (++reads === 2) { reached(); await held; }
                return profile;
            },
        });
        const observations = [];
        const agents = createSyncAgents({ owner: heldOwner, enableAccounts: true, network: { resolveAll: dns.resolveAll, onValidatedDial: value => observations.push(value) } });
        cleanup.push(agents.destroy);
        const controller = new AbortController();
        const outcome = new Promise((resolve, reject) => {
            http.get(nameUrl(), { agent: agents.httpAgent, signal: controller.signal }, res => { res.resume(); resolve(res); }).on('error', reject);
        }).catch(error => error);
        await reading;
        if (mode === 'abort') controller.abort();
        else agents.destroy();
        release();
        expect(await outcome).toMatchObject({ name: expect.stringMatching(/Error$/) });
        await new Promise(resolve => setImmediate(resolve));
        expect(observations).toEqual([]);
        expect(server.connections).toEqual([]);
    });

    test('teardown destroys a produced socket before asynchronous agent registration', async () => {
        await store.setItem('alice', { enabled: true, admin: true });
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { onValidatedDial: () => queueMicrotask(agents.destroy) } });
        cleanup.push(agents.destroy);
        const outcome = new Promise((resolve, reject) => http.get(server.url, { agent: agents.httpAgent }, res => { res.resume(); resolve(res); }).on('error', reject)).catch(error => error);
        expect(await outcome).toMatchObject({ name: expect.stringMatching(/Error$/) });
        expect(server.hits).toEqual([]);
    });

    test('destroyed agents reject subsequent requests without DNS', async () => {
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { resolveAll: dns.resolveAll } });
        agents.destroy();
        await expect(new Promise((resolve, reject) => http.get(nameUrl(), { agent: agents.httpAgent }, resolve).on('error', reject))).rejects.toMatchObject({ code: 'SYNC_AGENT_DESTROYED' });
        expect(dns.queries).toEqual([]);
        expect(server.connections).toEqual([]);
    });

    test('an already destroyed request never starts profile or DNS work', async () => {
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { resolveAll: dns.resolveAll } });
        cleanup.push(agents.destroy);
        const outcome = new Promise((resolve, reject) => {
            const req = http.get(nameUrl(), { agent: agents.httpAgent }, resolve).on('error', reject);
            req.destroy();
        }).catch(error => error);
        expect(await outcome).toMatchObject({ name: expect.stringMatching(/Error$/) });
        expect(dns.queries).toEqual([]);
    });

    test.each(['http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:7f00:1]'])('checks normalized literals before opening a socket: %s', async base => {
        const url = new URL(base);
        url.port = new URL(server.url).port;
        await expect(fetchFor()(url)).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
        expect(dns.queries).toEqual([]);
    });
    test.each(['nonsense', 'ftp://peer.sync.test', 'http://alice:secret@peer.sync.test'])('rejects invalid URL %s', async url => {
        await expect(fetchFor()(url)).rejects.toMatchObject({ code: 'INVALID_SYNC_URL' });
        expect(dns.queries).toEqual([]);
    });
    test.each(['agent', 'httpAgent', 'httpsAgent', 'lookup', 'redirect', 'follow', 'rejectUnauthorized', 'checkServerIdentity', 'servername', 'ca'])('refuses caller transport override %s', async key => {
        await expect(fetchFor()(server.url, { [key]: undefined })).rejects.toMatchObject({ code: 'INVALID_SYNC_OPTIONS' });
        expect(server.hits).toEqual([]);
    });
    test.each([
        { a: ['127.0.0.1', '8.8.8.8'], aaaa: [] },
        { a: ['8.8.8.8'], aaaa: ['::1'] },
        { a: ['127.0.0.1'], aaaa: ['2001:4860::8888'] },
    ])('rejects any prohibited DNS answer %j', async answers => {
        dns.setAnswers('peer.sync.test', answers);
        await expect(fetchFor()(nameUrl())).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
        expect(dns.queries.map(query => query.type).sort()).toEqual([1, 28]);
    });
    test.each([
        ['8.8.8.8', 4, { a: ['8.8.8.8'], aaaa: [] }],
        ['2001:4860::8888', 6, { a: [], aaaa: ['2001:4860::8888'] }],
    ])('validates public %s before local port-zero refusal without Internet access', async (address, family, answers) => {
        dns.setAnswers('peer.sync.test', answers);
        const observations = [];
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { resolveAll: dns.resolveAll, onValidatedDial: observation => observations.push(observation) } });
        cleanup.push(agents.destroy);
        await expect(new Promise((resolve, reject) => {
            http.get({ hostname: 'peer.sync.test', port: '0', agent: agents.httpAgent }, resolve).on('error', reject);
        })).rejects.toMatchObject({ code: expect.stringMatching(/EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/) });
        expect(observations).toEqual([expect.objectContaining({ hostname: 'peer.sync.test', address, family, port: 0 })]);
        expect(server.hits).toEqual([]);
    });
    test.each(['missing', 'disabled'])('%s profile fails closed even with switch enabled', async mode => {
        if (mode === 'missing') await store.removeItem('alice');
        else await store.setItem('alice', { enabled: false, admin: true });
        await expect(fetchFor({ allowPrivateAddressesForUsers: true })(server.url)).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
    });
    test('owner profile hook returns null after actual account removal', async () => {
        await store.removeItem('alice');
        expect(await owner.getCurrentProfile()).toBeNull();
    });
    test.each(['admin', 'switch', 'accounts-disabled'])('%s permits real local HTTP', async mode => {
        if (mode === 'admin') await store.setItem('alice', { enabled: true, admin: true });
        const request = fetchFor({ enableAccounts: mode !== 'accounts-disabled', allowPrivateAddressesForUsers: mode === 'switch' });
        expect(await (await request(server.url)).text()).toBe('ok');
        expect(server.hits).toHaveLength(1);
    });
    test('reads the profile before DNS', async () => {
        await store.setItem('alice', { enabled: false, admin: true });
        await expect(fetchFor()(nameUrl())).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(dns.queries).toEqual([]);
    });
    test.each(['revoke', 'disable', 'remove'])('rereads the actual profile store after held DNS: %s', async change => {
        await store.setItem('alice', { enabled: true, admin: true });
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        const hold = dns.holdNext('peer.sync.test');
        const pending = fetchFor()(nameUrl());
        const outcome = pending.catch(error => error);
        await Promise.race([hold.reached, pending.then(() => { throw new Error('Request completed before DNS barrier'); })]);
        if (change === 'remove') await store.removeItem('alice');
        else await store.setItem('alice', { enabled: change !== 'disable', admin: false });
        hold.release();
        expect(await outcome).toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
    });
    test('rereads DNS and policy rather than reusing a socket', async () => {
        await store.setItem('alice', { enabled: true, admin: true });
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        const request = fetchFor();
        expect(await (await request(nameUrl())).text()).toBe('ok');
        await store.setItem('alice', { enabled: true, admin: false });
        dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: ['::1'] });
        await expect(request(nameUrl())).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toHaveLength(1);
        expect(dns.queries).toHaveLength(4);
    });
    test('DNS rebinding blocks the next request without any profile change', async () => {
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { resolveAll: dns.resolveAll } });
        cleanup.push(agents.destroy);
        dns.setAnswers('peer.sync.test', { a: ['8.8.8.8'], aaaa: [] });
        await expect(new Promise((resolve, reject) => {
            http.get({ hostname: 'peer.sync.test', port: '0', agent: agents.httpAgent }, resolve).on('error', reject);
        })).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
        dns.setAnswers('peer.sync.test', { a: ['127.0.0.1'], aaaa: [] });
        await expect(new Promise((resolve, reject) => {
            http.get(nameUrl(), { agent: agents.httpAgent }, resolve).on('error', reject);
        })).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
        expect(dns.queries).toHaveLength(4);
    });
    test.each(['missing', 'servfail'])('DNS %s fails closed', async mode => {
        if (mode === 'servfail') dns.setAnswers('peer.sync.test', { servfail: true });
        await expect(fetchFor()(nameUrl())).rejects.toMatchObject({ code: mode === 'missing' ? 'ENOTFOUND' : 'ESERVFAIL' });
        expect(server.hits).toEqual([]);
    });
    test.each([
        [{ a: ['8.8.8.8'], aaaa: [], servfailType: 28 }, 'ESERVFAIL'],
        [{ a: [], aaaa: ['2001:4860::8888'], servfailType: 1 }, 'ESERVFAIL'],
        [{ a: ['8.8.8.8'], aaaa: [], dropType: 28 }, 'ETIMEOUT'],
    ])('a successful family cannot hide another family failure %j', async (answers, code) => {
        dns.setAnswers('peer.sync.test', answers);
        await expect(fetchFor()(nameUrl())).rejects.toMatchObject({ code });
        expect(server.hits).toEqual([]);
    });
    test.each([301, 302, 307, 308])('refuses HTTP redirect %s without contacting target', async status => {
        const redirect = await startHttpFixture((_req, res) => { res.writeHead(status, { Location: server.url }); res.end(); });
        cleanup.push(redirect.close);
        await store.setItem('alice', { enabled: true, admin: true });
        await expect(fetchFor()(redirect.url)).rejects.toMatchObject({ type: 'no-redirect' });
        expect(redirect.hits).toHaveLength(1);
        expect(server.hits).toEqual([]);
    });
    test('TLS preserves hostname identity, SNI and HTTP Host while dialing the validated IP', async () => {
        await store.setItem('alice', { enabled: true, admin: true });
        const tls = await startTlsFixture({ dnsSans: ['localhost', '*.sync.test'], ipSans: ['127.0.0.1'] });
        cleanup.push(tls.close);
        for (const name of ['peer.sync.test', 'wrong.example']) dns.setAnswers(name, { a: ['127.0.0.1'], aaaa: [] });
        const request = fetchFor({ network: { resolveAll: dns.resolveAll, ca: tls.caPem } });
        expect(await (await request(`https://peer.sync.test:${tls.port}`)).text()).toBe('secure');
        expect(tls.sniNames).toEqual(['peer.sync.test']);
        expect(tls.hits).toEqual([{ host: `peer.sync.test:${tls.port}` }]);
        await expect(request(`https://wrong.example:${tls.port}`)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        const agents = createSyncAgents({ owner, enableAccounts: true, network: { resolveAll: dns.resolveAll, ca: tls.caPem } });
        cleanup.push(agents.destroy);
        await expect(new Promise((resolve, reject) => {
            https.get(`https://wrong.example:${tls.port}`, {
                agent: agents.httpsAgent,
                rejectUnauthorized: false,
                servername: 'peer.sync.test',
                checkServerIdentity: () => undefined,
                lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4),
            }, resolve).on('error', reject);
        })).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        expect(await (await request(`https://127.0.0.1:${tls.port}`)).text()).toBe('secure');
        expect(tls.sniNames).toEqual(['peer.sync.test', false]);
        await expect(fetchFor()(`https://127.0.0.1:${tls.port}`)).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
        expect(tls.hits).toHaveLength(2);
    });
    test('literal IP rejects a certificate with DNS SAN only', async () => {
        await store.setItem('alice', { enabled: true, admin: true });
        const tls = await startTlsFixture({ dnsSans: ['localhost'] });
        cleanup.push(tls.close);
        await expect(fetchFor({ network: { ca: tls.caPem } })(`https://127.0.0.1:${tls.port}`)).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
        expect(tls.hits).toEqual([]);
    });
    test.each([http, https])('agents also protect direct native requests', async transport => {
        const agents = createSyncAgents({ owner, enableAccounts: true });
        cleanup.push(agents.destroy);
        await expect(new Promise((resolve, reject) => {
            transport.get(server.url.replace('http:', transport === https ? 'https:' : 'http:'), { agent: transport === https ? agents.httpsAgent : agents.httpAgent }, resolve).on('error', reject);
        })).rejects.toMatchObject({ code: 'SYNC_PRIVATE_ADDRESS' });
        expect(server.hits).toEqual([]);
    });
});
