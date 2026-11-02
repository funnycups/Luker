import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import {
    readRegistry, upsertLanBackend, recordLastSync, setSchedule, sanitizeRegistryForClient,
    removeBackendCompletely, resolveDeviceLabel, assertSafeBackendId, setBackendSettings, setLanSecret,
    updateRegistry, clearLanPeerAuth, setLanPeerDeviceLabel,
} from '../../src/sync/state.js';
import { normalizeDeviceLabel } from '../../src/sync/device-label.js';
import { readSnapshotCategories, snapshotCategoriesPath } from '../../src/sync/pipeline/snapshot-categories.js';
import { ensureShadowRepo, getShadowPaths } from '../../src/sync/shadow.js';
import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { commitFiles } from './_lib/commits.js';

const H = c => c.repeat(40);
let userRoot;
let statePath;
const writeV1 = body => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(body));
};
const v1Peer = extra => ({ label: 'Phone', categories: ['worlds'], pairedAt: 1700000000000, ...extra });

beforeEach(() => {
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-registry-'));
    statePath = path.join(userRoot, '.sync', 'state.json');
});
afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

describe('registry v2', () => {
    test('a missing file reads as an empty v2 registry', async () => {
        expect(await readRegistry({ userRoot })).toEqual({
            version: 2, device: { label: '' }, backends: {}, schedule: { idleSeconds: 60, pollSeconds: 300 },
        });
    });

    test('a v1 file migrates every peer to a lan backend and is written back with mode 0600', async () => {
        writeV1({ peers: { 'u@aa': v1Peer({ peerBaseUrl: 'http://10.0.0.2:8000', peerAuth: { username: 'u', password: 'p' },
            syncSecret: 'a'.repeat(64), lastSyncAt: 1700000001000, lastSyncedOid: H('b') }) } });
        const registry = await readRegistry({ userRoot });
        expect(registry.backends['u@aa']).toEqual({
            kind: 'lan', label: 'Phone', categories: ['worlds'], createdAt: new Date(1700000000000).toISOString(),
            lastSync: { at: 1700000001000, head: H('b'), mergeCase: null, stalled: null, error: null },
            lan: { peerId: 'u@aa', peerBaseUrl: 'http://10.0.0.2:8000', peerAuth: { username: 'u', password: 'p' }, syncSecret: 'a'.repeat(64), peerDeviceLabel: '' },
        });
        expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).version).toBe(2);
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    });

    test('a v1 entry from the link-generating side migrates with an empty peerBaseUrl', async () => {
        writeV1({ peers: { 'u@aa': v1Peer({ syncSecret: 'c'.repeat(64) }) } });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan).toEqual({ peerId: 'u@aa', peerBaseUrl: '', peerAuth: null, syncSecret: 'c'.repeat(64), peerDeviceLabel: '' });
    });

    test('a v2 file with invalid contents reads with those parts replaced by defaults', async () => {
        const good = { kind: 'lan', label: 'G', categories: [], createdAt: null, lastSync: { at: null, head: null, mergeCase: null, stalled: null, error: null }, lan: { peerId: 'u@aa', peerBaseUrl: '', peerAuth: null, syncSecret: '', peerDeviceLabel: '' } };
        writeV1({ version: 2, device: { label: 5 }, backends: { 'u@aa': good, 'u@bb': 'x', 'u@cc': [], 'u@dd': null }, schedule: { idleSeconds: -1, pollSeconds: 120 } });
        expect(await readRegistry({ userRoot })).toEqual({
            version: 2, device: { label: '' }, backends: { 'u@aa': good }, schedule: { idleSeconds: 60, pollSeconds: 120 },
        });
        writeV1({ version: 2, backends: {}, schedule: { idleSeconds: 30, pollSeconds: 'soon' } });
        expect((await readRegistry({ userRoot })).schedule).toEqual({ idleSeconds: 30, pollSeconds: 300 });
    });

    test('a hand-edited backend entry reads in the full shape and an unknown kind is dropped', async () => {
        writeV1({ version: 2, backends: { 'u@aa': { kind: 'lan', categories: ['worlds', 4] }, 'u@xx': { kind: 'ftp' } } });
        const registry = await readRegistry({ userRoot });
        expect(registry.backends).toEqual({ 'u@aa': {
            kind: 'lan', label: '', categories: ['worlds'], createdAt: null,
            lastSync: { at: null, head: null, mergeCase: null, stalled: null, error: null },
            lan: { peerId: 'u@aa', peerBaseUrl: '', peerAuth: null, syncSecret: '', peerDeviceLabel: '' },
        } });
        await setLanSecret({ userRoot, backendId: 'u@aa', syncSecret: 'b'.repeat(64) });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.syncSecret).toBe('b'.repeat(64));
    });

    test.each(['{ bad json', '{"peers": []}', '{"version":3,"backends":{}}', 'null'])('an unreadable registry %s refuses reads and mutations without archival replacement', async body => {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, body, { mode: 0o600 });
        await expect(readRegistry({ userRoot })).rejects.toHaveProperty('code');
        await expect(upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] })).rejects.toHaveProperty('code');
        await expect(setSchedule({ userRoot, idleSeconds: 10, pollSeconds: 20 })).rejects.toHaveProperty('code');
        expect(fs.readFileSync(statePath, 'utf8')).toBe(body);
        expect(fs.readdirSync(path.dirname(statePath))).toEqual(['state.json']);
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    });

    test('an actual registry read-permission failure cannot become a new registry', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: ['worlds'] });
        const before = fs.readFileSync(statePath);
        fs.chmodSync(statePath, 0o000);
        try {
            await expect(readRegistry({ userRoot })).rejects.toMatchObject({ code: 'SYNC_REGISTRY_READ_FAILED' });
            await expect(setSchedule({ userRoot, idleSeconds: 10, pollSeconds: 20 })).rejects.toMatchObject({ code: 'SYNC_REGISTRY_READ_FAILED' });
            expect(fs.readdirSync(path.dirname(statePath))).toEqual(['state.json']);
        } finally { fs.chmodSync(statePath, 0o600); }
        expect(fs.readFileSync(statePath)).toEqual(before);
    });

    test('a v1 entry without pairedAt migrates with a null createdAt', async () => {
        writeV1({ peers: { 'u@aa': { label: 'Phone', categories: [] } } });
        expect((await readRegistry({ userRoot })).backends['u@aa'].createdAt).toBeNull();
    });

    test('a v1 entry without pairedAt keeps a null createdAt after an upsert', async () => {
        writeV1({ peers: { 'u@aa': { label: 'Phone', categories: [] } } });
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'P', categories: [] });
        expect((await readRegistry({ userRoot })).backends['u@aa'].createdAt).toBeNull();
    });

    test('a read and an upsert racing on a fresh v1 file keep both the migrated peer and the new entry', async () => {
        const shadow = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
        const main = await commitFiles(shadow.gitDir, { 'worlds/w.json': '{}' });
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: main, force: true });
        const upsert = () => upsertLanBackend({ userRoot, backendId: 'u@bb', label: 'B', categories: [] });
        for (const race of [() => [readRegistry({ userRoot }), upsert()], () => [upsert(), readRegistry({ userRoot })]]) {
            fs.rmSync(snapshotCategoriesPath({ userRoot, backendId: 'u@aa' }), { force: true });
            writeV1({ peers: { 'u@aa': v1Peer() } });
            await Promise.all(race());
            expect(Object.keys((await readRegistry({ userRoot })).backends).sort()).toEqual(['u@aa', 'u@bb']);
        }
    });

    test('migration is idempotent', async () => {
        writeV1({ peers: { 'u@aa': v1Peer() } });
        await readRegistry({ userRoot });
        const first = fs.readFileSync(statePath, 'utf8');
        await readRegistry({ userRoot });
        expect(fs.readFileSync(statePath, 'utf8')).toBe(first);
    });

    test('migration keeps the shadow directory of a migrated backend', async () => {
        const shadow = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
        const headBefore = fs.readFileSync(path.join(shadow.gitDir, 'HEAD'), 'utf8');
        writeV1({ peers: { 'u@aa': v1Peer() } });
        await readRegistry({ userRoot });
        expect(fs.readFileSync(path.join(getShadowPaths({ userRoot, peerId: 'u@aa' }).gitDir, 'HEAD'), 'utf8')).toBe(headBefore);
    });

    test('a migrated backend whose shadow has a main gets a snapshot category record at that main', async () => {
        const shadow = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
        const main = await commitFiles(shadow.gitDir, { 'worlds/w.json': '{}' });
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: main, force: true });
        writeV1({ peers: { 'u@aa': v1Peer({ categories: ['worlds', 'characters'] }) } });
        await readRegistry({ userRoot });
        expect(readSnapshotCategories({ userRoot, backendId: 'u@aa' })).toEqual({ categories: ['worlds', 'characters'], syncedAt: { worlds: main, characters: main } });
    });

    test('a migrated backend without a shadow main gets no record', async () => {
        writeV1({ peers: { 'u@aa': v1Peer() } });
        await readRegistry({ userRoot });
        expect(readSnapshotCategories({ userRoot, backendId: 'u@aa' })).toBeNull();
    });

    test('migration drops non-string categories and a corrupt snapshot record does not block other backends', async () => {
        const corrupt = snapshotCategoriesPath({ userRoot, backendId: 'u@aa' });
        fs.mkdirSync(path.dirname(corrupt), { recursive: true });
        fs.writeFileSync(corrupt, '{ not json');
        const shadow = await ensureShadowRepo({ userRoot, peerId: 'u@bb' });
        const main = await commitFiles(shadow.gitDir, { 'worlds/w.json': '{}' });
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: main, force: true });
        writeV1({ peers: { 'u@aa': v1Peer(), 'u@bb': v1Peer({ categories: ['worlds', 7, null] }) } });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const registry = await readRegistry({ userRoot });
            expect(registry.backends['u@bb'].categories).toEqual(['worlds']);
            expect(readSnapshotCategories({ userRoot, backendId: 'u@bb' })).toEqual({ categories: ['worlds'], syncedAt: { worlds: main } });
            expect(warn).toHaveBeenCalled();
            await upsertLanBackend({ userRoot, backendId: 'u@cc', label: 'C', categories: [] });
            expect(Object.keys((await readRegistry({ userRoot })).backends).sort()).toEqual(['u@aa', 'u@bb', 'u@cc']);
        } finally {
            warn.mockRestore();
        }
    });

    test('concurrent updates do not lose writes', async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `u@${String(i).padStart(2, '0')}`);
        await Promise.all(ids.map(id => upsertLanBackend({ userRoot, backendId: id, label: id, categories: [] })));
        expect(Object.keys((await readRegistry({ userRoot })).backends).sort()).toEqual(ids);
    });

    test('upsertLanBackend keeps credentials, the secret and createdAt when they are omitted', async () => {
        const first = await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: ['worlds'],
            peerBaseUrl: 'http://10.0.0.2:8000', peerAuth: { username: 'u', password: 'p' }, syncSecret: 'd'.repeat(64) });
        const second = await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'B', categories: ['chats'] });
        expect(second).toMatchObject({ label: 'B', categories: ['chats'], createdAt: first.createdAt,
            lan: { peerBaseUrl: 'http://10.0.0.2:8000', peerAuth: { username: 'u', password: 'p' }, syncSecret: 'd'.repeat(64) } });
    });

    test('recordLastSync success clears the error and an error keeps the last success', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        await recordLastSync({ userRoot, backendId: 'u@aa', success: { head: H('1'), mergeCase: 'equal', stalled: ['worlds/x.json'] } });
        await recordLastSync({ userRoot, backendId: 'u@aa', error: { code: 'PEER_UNREACHABLE', message: 'ECONNREFUSED' } });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lastSync).toMatchObject({
            head: H('1'), mergeCase: 'equal', stalled: ['worlds/x.json'], error: { code: 'PEER_UNREACHABLE', message: 'ECONNREFUSED' },
        });
        await recordLastSync({ userRoot, backendId: 'u@aa', success: { head: H('2'), mergeCase: 'merged', stalled: null } });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lastSync).toMatchObject({ head: H('2'), stalled: null, error: null });
    });

    test('recordLastSync without an outcome does not rewrite the file', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        const before = fs.statSync(statePath).ino;
        await recordLastSync({ userRoot, backendId: 'u@aa' });
        expect(fs.statSync(statePath).ino).toBe(before);
    });

    test('recordLastSync on a missing backend writes nothing', async () => {
        await recordLastSync({ userRoot, backendId: 'u@gone', success: { head: null, mergeCase: null, stalled: null } });
        expect((await readRegistry({ userRoot })).backends).toEqual({});
    });

    test('setSchedule rejects zero, negative and non-finite values', async () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(setSchedule({ userRoot, idleSeconds: bad, pollSeconds: 300 })).rejects.toMatchObject({ code: 'INVALID_SCHEDULE' });
        }
        expect(await setSchedule({ userRoot, idleSeconds: 0.5, pollSeconds: 7200 })).toEqual({ idleSeconds: 0.5, pollSeconds: 7200 });
    });

    test('setLanSecret stores a 64-hex secret and refuses anything else', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        await setLanSecret({ userRoot, backendId: 'u@aa', syncSecret: 'A'.repeat(64) });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.syncSecret).toBe('a'.repeat(64));
        await expect(setLanSecret({ userRoot, backendId: 'u@aa', syncSecret: 'short' })).rejects.toMatchObject({ code: 'INVALID_SECRET' });
    });

    test('setBackendSettings on an unknown backend throws UNKNOWN_BACKEND', async () => {
        await expect(setBackendSettings({ userRoot, backendId: 'u@zz', label: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
    });

    test('setBackendSettings refuses categories that are not an array of strings', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: ['worlds'] });
        for (const bad of ['worlds', null, ['worlds', 3], { 0: 'worlds' }]) {
            await expect(setBackendSettings({ userRoot, backendId: 'u@aa', categories: bad })).rejects.toMatchObject({ code: 'INVALID_CATEGORIES' });
        }
        await setBackendSettings({ userRoot, backendId: 'u@aa', categories: ['chats'] });
        expect((await readRegistry({ userRoot })).backends['u@aa'].categories).toEqual(['chats']);
    });

    test('sanitizeRegistryForClient drops the secret and credentials', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [], peerAuth: { username: 'u', password: 'p' }, syncSecret: 'e'.repeat(64) });
        const shown = sanitizeRegistryForClient(await readRegistry({ userRoot }));
        const text = JSON.stringify(shown);
        expect(text).not.toContain('e'.repeat(64));
        expect(text).not.toContain('"password"');
        expect(shown.backends['u@aa'].lan).toEqual({ peerId: 'u@aa', peerBaseUrl: '', hasStoredCredentials: true });
    });

    test('sanitizeRegistryForClient leaves out fields outside the client shape', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: ['worlds'] });
        await updateRegistry({ userRoot }, registry => {
            registry.backends['u@aa'].internalToken = 'INTERNALEXTRAVALUE';
        });
        const shown = sanitizeRegistryForClient(await readRegistry({ userRoot }));
        expect(JSON.stringify(shown)).not.toContain('INTERNALEXTRAVALUE');
        expect(Object.keys(shown.backends['u@aa']).sort()).toEqual(['categories', 'createdAt', 'kind', 'label', 'lan', 'lastSync']);
    });

    test('sanitizeRegistryForClient shows only the public S3 fields', async () => {
        const s3 = {
            endpoint: 'https://s3.example', region: 'r1', bucket: 'b', prefix: 'p/', forcePathStyle: true, keyId: 'k1',
            accessKeyId: 'AKIAEXAMPLEACCESS', secretAccessKey: 'SECRETEXAMPLEVALUE', derivedKey: 'DERIVEDEXAMPLEVALUE',
        };
        await updateRegistry({ userRoot }, registry => {
            registry.backends.s3a = { kind: 's3', label: 'S', categories: [], createdAt: new Date(0).toISOString(), lastSync: null, s3 };
        });
        const shown = sanitizeRegistryForClient(await readRegistry({ userRoot }));
        const text = JSON.stringify(shown);
        for (const value of ['AKIAEXAMPLEACCESS', 'SECRETEXAMPLEVALUE', 'DERIVEDEXAMPLEVALUE']) expect(text).not.toContain(value);
        expect(shown.backends.s3a.s3).toEqual({
            endpoint: 'https://s3.example', region: 'r1', bucket: 'b', prefix: 'p/', forcePathStyle: true, stripIfMatchQuotes: false, keyId: 'k1', hasCredentials: true,
        });
    });

    test('a migrated id that is not a valid ref component can still be removed', async () => {
        const legacyId = '.foo@1234abcd';
        const shadow = await ensureShadowRepo({ userRoot, peerId: legacyId });
        writeV1({ peers: { [legacyId]: v1Peer(), '.bar@1234abcd': v1Peer() } });
        expect(Object.keys((await readRegistry({ userRoot })).backends)).toContain(legacyId);
        await expect(upsertLanBackend({ userRoot, backendId: legacyId, label: 'x', categories: [] })).rejects.toMatchObject({ code: 'INVALID_BACKEND_ID' });
        await removeBackendCompletely({ userRoot, backendId: legacyId });
        expect((await readRegistry({ userRoot })).backends[legacyId]).toBeUndefined();
        expect(fs.existsSync(shadow.peerDir)).toBe(false);
        await removeBackendCompletely({ userRoot, backendId: '.bar@1234abcd' });
        expect((await readRegistry({ userRoot })).backends).toEqual({});
        await expect(removeBackendCompletely({ userRoot, backendId: 'a/b' })).rejects.toThrow();
    });

    test('removeBackendCompletely deletes the entry and the shadow directory', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        const shadow = await ensureShadowRepo({ userRoot, peerId: 'u@aa' });
        await removeBackendCompletely({ userRoot, backendId: 'u@aa' });
        expect((await readRegistry({ userRoot })).backends['u@aa']).toBeUndefined();
        expect(fs.existsSync(shadow.peerDir)).toBe(false);
    });

    test('resolveDeviceLabel prefers the stored label, then a real host name, then the profile name', () => {
        const owner = { handle: 'u', displayName: 'Ilya' };
        expect(resolveDeviceLabel({ device: { label: 'Desk' } }, owner)).toBe('Desk');
        const host = os.hostname();
        const expected = (!host || /^localhost(\.|$)/i.test(host)) ? 'Ilya' : host;
        expect(resolveDeviceLabel({ device: { label: '' } }, owner)).toBe(expected);
        expect(resolveDeviceLabel({ device: { label: '' } }, { handle: 'u', displayName: '' }, 'localhost')).toBe('u');
    });

    test('assertSafeBackendId refuses ids that are not valid git ref components', () => {
        for (const bad of ['', 'a..b', '.a', 'a.', 'a.lock', 'a@{b', 'a/b', 'a b', 'a\\b']) {
            expect(() => assertSafeBackendId(bad)).toThrow();
        }
        expect(() => assertSafeBackendId('alice@0a1b2c3d')).not.toThrow();
    });

    test('upsertLanBackend stores only complete credentials and a well-formed secret', async () => {
        for (const [i, peerAuth] of [{ username: 'u' }, { password: 'p' }, { username: '', password: '' }, null].entries()) {
            const entry = await upsertLanBackend({ userRoot, backendId: `u@0${i}`, label: 'A', categories: [], peerAuth, syncSecret: 'not-hex' });
            expect(entry.lan).toMatchObject({ peerAuth: null, syncSecret: '' });
        }
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [], peerAuth: { username: 'u', password: 'p' } });
        expect((await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [], peerAuth: null })).lan.peerAuth).toEqual({ username: 'u', password: 'p' });
    });

    test('upsertLanBackend refuses ids that are not safe', async () => {
        for (const bad of ['', '.', '..', 'a/b']) {
            await expect(upsertLanBackend({ userRoot, backendId: bad, label: 'x', categories: [] })).rejects.toMatchObject({ code: 'INVALID_BACKEND_ID' });
        }
    });

    test('clearLanPeerAuth drops only the credentials', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: ['worlds'], peerBaseUrl: 'http://10.0.0.5:8000', peerAuth: { username: 'u', password: 'p' }, syncSecret: 'a'.repeat(64) });
        await recordLastSync({ userRoot, backendId: 'u@aa', success: { head: H('b'), mergeCase: 'equal', stalled: null } });
        await clearLanPeerAuth({ userRoot, backendId: 'u@aa' });
        expect((await readRegistry({ userRoot })).backends['u@aa']).toMatchObject({
            label: 'A', categories: ['worlds'], lastSync: { head: H('b') },
            lan: { peerBaseUrl: 'http://10.0.0.5:8000', peerAuth: null, syncSecret: 'a'.repeat(64), peerDeviceLabel: '' },
        });
        await expect(clearLanPeerAuth({ userRoot, backendId: 'a/b' })).rejects.toMatchObject({ code: 'INVALID_BACKEND_ID' });
    });

    test('clearLanPeerAuth without stored credentials does not write the file', async () => {
        await clearLanPeerAuth({ userRoot, backendId: 'u@aa' });
        expect(fs.existsSync(statePath)).toBe(false);
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        const before = fs.statSync(statePath).ino;
        await clearLanPeerAuth({ userRoot, backendId: 'u@aa' });
        expect(fs.statSync(statePath).ino).toBe(before);
    });

    test('every write keeps the file at mode 0600', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [], peerAuth: { username: 'u', password: 'p' } });
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
        await recordLastSync({ userRoot, backendId: 'u@aa', success: { head: H('c'), mergeCase: 'equal', stalled: null } });
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
        await clearLanPeerAuth({ userRoot, backendId: 'u@aa' });
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    });

    test('setLanPeerDeviceLabel stores a reported label and keeps it through upserts', async () => {
        await setLanPeerDeviceLabel({ userRoot, backendId: 'u@aa', peerDeviceLabel: 'Desk' });
        expect(fs.existsSync(statePath)).toBe(false);
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        for (const ignored of ['', 5, undefined]) await setLanPeerDeviceLabel({ userRoot, backendId: 'u@aa', peerDeviceLabel: ignored });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.peerDeviceLabel).toBe('');
        await setLanPeerDeviceLabel({ userRoot, backendId: 'u@aa', peerDeviceLabel: 'Desk' });
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'B', categories: [] });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.peerDeviceLabel).toBe('Desk');
    });

    test('a hostile reported label is stored normalized and one without text is ignored', async () => {
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        await setLanPeerDeviceLabel({ userRoot, backendId: 'u@aa', peerDeviceLabel: `\u0000Desk\n\n  top${'x'.repeat(10_000)}` });
        const stored = (await readRegistry({ userRoot })).backends['u@aa'].lan.peerDeviceLabel;
        expect(stored).toBe(normalizeDeviceLabel(`Desk top${'x'.repeat(10_000)}`));
        expect(stored).toMatch(/^Desk topx+$/);
        await setLanPeerDeviceLabel({ userRoot, backendId: 'u@aa', peerDeviceLabel: '\n\u0007 ' });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.peerDeviceLabel).toBe(stored);
        await upsertLanBackend({ userRoot, backendId: 'u@bb', label: 'B', categories: [], peerDeviceLabel: ' Phone\r\n' });
        expect((await readRegistry({ userRoot })).backends['u@bb'].lan.peerDeviceLabel).toBe('Phone');
    });

    test('a hand-edited reported label reads back normalized', async () => {
        writeV1({ version: 2, backends: { 'u@aa': { kind: 'lan', lan: { peerDeviceLabel: '\tDesk\u0000\n' } } } });
        expect((await readRegistry({ userRoot })).backends['u@aa'].lan.peerDeviceLabel).toBe('Desk');
    });

    test('resolveDeviceLabel normalizes every source and skips one without text', () => {
        const owner = { handle: 'u', displayName: ' Ilya\n' };
        expect(resolveDeviceLabel({ device: { label: ' Desk\u0000\n' } }, owner)).toBe('Desk');
        expect(resolveDeviceLabel({ device: { label: '\n\u0007' } }, owner, 'host\nname')).toBe('host name');
        expect(resolveDeviceLabel({ device: { label: '' } }, owner, '\u0000')).toBe('Ilya');
        expect(resolveDeviceLabel({ device: { label: '' } }, { handle: 'u', displayName: '\n' }, 'localhost')).toBe('u');
    });

    test('removeBackendCompletely is idempotent', async () => {
        await expect(removeBackendCompletely({ userRoot, backendId: 'u@never' })).resolves.toBeUndefined();
        await upsertLanBackend({ userRoot, backendId: 'u@aa', label: 'A', categories: [] });
        await removeBackendCompletely({ userRoot, backendId: 'u@aa' });
        await expect(removeBackendCompletely({ userRoot, backendId: 'u@aa' })).resolves.toBeUndefined();
        expect((await readRegistry({ userRoot })).backends).toEqual({});
    });
});
