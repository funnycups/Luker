import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import writeFileAtomic from 'write-file-atomic';

import { normalizeDeviceLabel } from './device-label.js';
import { normalizeS3Settings } from './backends/s3/layout.js';
import { syncError } from './errors.js';
import { PEER_ID_PATTERN, assertSafePeerId, getShadowPaths } from './shadow.js';
import { atomicFs } from './pipeline/atomic-fs.js';
import { readSnapshotCategories, writeSnapshotCategories } from './pipeline/snapshot-categories.js';

/**
 * Pairing codes and peer secrets are 32 random bytes rendered as 64
 * lowercase hex chars (see `/pair/start` and `/session/offer` in
 * `src/endpoints/sync.js`). Anything else is treated as "not supplied".
 */
const SYNC_SECRET_PATTERN = /^[a-f0-9]{64}$/i;
const REGISTRY_VERSION = 2;

export const DEFAULT_SCHEDULE = Object.freeze({
    // A UX knob; longer than a generation plus a typical edit gap, so one
    // conversation does not push over and over.
    idleSeconds: 60,
    // A UX knob; bounds how long another device's change takes to arrive;
    // each poll costs one small request.
    pollSeconds: 300,
});

/**
 * @typedef {{ at: number|null, head: string|null, mergeCase: string|null, stalled: string[]|null, error: { code: string, message: string, at: number }|null }} LastSync
 * @typedef {{ peerId: string, peerBaseUrl: string, peerAuth: { username: string, password: string }|null, syncSecret: string, peerDeviceLabel: string }} LanSettings
 *   `peerDeviceLabel` is the label the other device reports for itself
 * @typedef {{ kind: 'lan'|'s3', label: string, categories: string[], createdAt: string|null, lastSync: LastSync, lan?: LanSettings, s3?: object }} BackendEntry
 * @typedef {{ version: 2, device: { label: string }, backends: Record<string, BackendEntry>, schedule: { idleSeconds: number, pollSeconds: number } }} SyncRegistry
 */

function statePathFor(userRoot) {
    return path.join(userRoot, '.sync', 'state.json');
}

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isInterval = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function readSchedule(schedule) {
    return {
        idleSeconds: isInterval(schedule?.idleSeconds) ? schedule.idleSeconds : DEFAULT_SCHEDULE.idleSeconds,
        pollSeconds: isInterval(schedule?.pollSeconds) ? schedule.pollSeconds : DEFAULT_SCHEDULE.pollSeconds,
    };
}

/** @returns {SyncRegistry} */
function emptyRegistry() {
    return { version: REGISTRY_VERSION, device: { label: '' }, backends: {}, schedule: { ...DEFAULT_SCHEDULE } };
}

/** @returns {LastSync} */
function emptyLastSync() {
    return { at: null, head: null, mergeCase: null, stalled: null, error: null };
}

function normalizePeerAuth(peerAuth) {
    return (isPlainObject(peerAuth)
        && typeof peerAuth.username === 'string' && peerAuth.username.length
        && typeof peerAuth.password === 'string' && peerAuth.password.length)
        ? { username: peerAuth.username, password: peerAuth.password }
        : null;
}

function normalizeSecret(syncSecret) {
    return (typeof syncSecret === 'string' && SYNC_SECRET_PATTERN.test(syncSecret.trim()))
        ? syncSecret.trim().toLowerCase()
        : null;
}

/**
 * @param {Record<string, object>} peers a version 1 `peers` map
 * @returns {SyncRegistry}
 */
function migrateV1(peers) {
    const registry = emptyRegistry();
    for (const [peerId, peer] of Object.entries(peers)) {
        const entry = isPlainObject(peer) ? peer : {};
        registry.backends[peerId] = {
            kind: 'lan',
            label: entry.label ?? '',
            categories: Array.isArray(entry.categories) ? entry.categories.filter(id => typeof id === 'string') : [],
            createdAt: Number.isFinite(entry.pairedAt) ? new Date(entry.pairedAt).toISOString() : null,
            lastSync: { ...emptyLastSync(), at: entry.lastSyncAt ?? null, head: entry.lastSyncedOid ?? null },
            lan: {
                peerId,
                peerBaseUrl: entry.peerBaseUrl ?? '',
                peerAuth: entry.peerAuth ?? null,
                syncSecret: entry.syncSecret ?? '',
                peerDeviceLabel: '',
            },
        };
    }
    return registry;
}

/**
 * Fill every field a stored backend entry must have, so a hand-edited or
 * partial entry reads in the full shape. An entry of an unknown kind reads
 * as null and is dropped.
 *
 * @param {string} id
 * @param {unknown} entry
 * @returns {BackendEntry | null}
 */
function normalizeEntry(id, entry) {
    if (!isPlainObject(entry) || (entry.kind !== 'lan' && entry.kind !== 's3')) return null;
    const normalized = {
        ...entry,
        label: typeof entry.label === 'string' ? entry.label : '',
        categories: Array.isArray(entry.categories) ? entry.categories.filter(c => typeof c === 'string') : [],
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
        lastSync: { ...emptyLastSync(), ...(isPlainObject(entry.lastSync) ? entry.lastSync : {}) },
    };
    if (entry.kind === 'lan') {
        const lan = isPlainObject(entry.lan) ? entry.lan : {};
        normalized.lan = {
            peerId: id,
            peerBaseUrl: typeof lan.peerBaseUrl === 'string' ? lan.peerBaseUrl : '',
            peerAuth: normalizePeerAuth(lan.peerAuth),
            syncSecret: normalizeSecret(lan.syncSecret) ?? '',
            peerDeviceLabel: normalizeDeviceLabel(lan.peerDeviceLabel),
        };
    } else {
        normalized.s3 = isPlainObject(entry.s3) ? entry.s3 : {};
    }
    return normalized;
}

/**
 * Read and parse the registry file without writing. A version 1 file is
 * migrated in memory and its backend ids are returned in `migratedIds`.
 * Only a missing file creates an empty registry. Present read, parse and
 * format failures stop both reads and ordinary mutations.
 *
 * @param {string} userRoot
 * @returns {{ registry: SyncRegistry, migratedIds: string[] | null }}
 */
function loadRegistry(userRoot) {
    const p = statePathFor(userRoot);
    let text;
    try {
        text = fs.readFileSync(p, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return { registry: emptyRegistry(), migratedIds: null };
        throw syncError('SYNC_REGISTRY_READ_FAILED', `Cannot read sync registry at ${p}: ${err.code}; restore read access before retrying`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
        throw syncError('SYNC_REGISTRY_INVALID', `Malformed sync registry JSON at ${p}; restore this file before editing sync settings`);
    }
    if (isPlainObject(parsed) && parsed.version === REGISTRY_VERSION && isPlainObject(parsed.backends)) {
        return {
            registry: {
                version: REGISTRY_VERSION,
                device: { label: typeof parsed.device?.label === 'string' ? parsed.device.label : '' },
                backends: Object.fromEntries(Object.entries(parsed.backends)
                    .map(([id, entry]) => [id, normalizeEntry(id, entry)])
                    .filter(([, entry]) => entry)),
                schedule: readSchedule(parsed.schedule),
            },
            migratedIds: null,
        };
    }
    if (isPlainObject(parsed) && parsed.version === undefined && isPlainObject(parsed.peers)) {
        return { registry: migrateV1(parsed.peers), migratedIds: Object.keys(parsed.peers) };
    }
    throw syncError('SYNC_REGISTRY_UNSUPPORTED', `Unsupported sync registry format at ${p}; expected a version 2 backends object or a legacy peers object`);
}

/**
 * A version 1 backend has no snapshot category record. Without one, the
 * next cycle would read every category as newly enabled; seeding the
 * record at the shadow's `main` keeps the selection it had. A backend whose
 * record cannot be read or written is logged and left unseeded, so it
 * does not block the registry.
 */
async function seedSnapshotCategories(userRoot, registry, migratedIds) {
    for (const backendId of migratedIds) {
        if (!PEER_ID_PATTERN.test(backendId) || /^\.+$/.test(backendId)) continue;
        try {
            if (readSnapshotCategories({ userRoot, backendId }) !== null) continue;
            let main;
            try {
                main = await git.resolveRef({ fs: atomicFs, gitdir: getShadowPaths({ userRoot, peerId: backendId }).gitDir, ref: 'refs/heads/main' });
            } catch (err) {
                if (err.code === 'NotFoundError') continue;
                throw err;
            }
            const { categories } = registry.backends[backendId];
            await writeSnapshotCategories({ userRoot, backendId, categories, syncedAt: Object.fromEntries(categories.map(id => [id, main])) });
        } catch (err) {
            console.warn(`[sync] could not seed the snapshot category record of ${backendId}: ${err.message}`);
        }
    }
}

/**
 * File mode is 0600 because the registry holds basic-auth credentials and
 * pairing secrets in plaintext.
 */
async function writeRegistry(userRoot, registry) {
    const p = statePathFor(userRoot);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await writeFileAtomic(p, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * Run `task` after every earlier task for the same user root, so each
 * read-modify-write sees the previous write.
 */
function enqueue(userRoot, task) {
    const key = path.resolve(userRoot);
    const run = (queues.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

/**
 * @param {string} userRoot
 * @param {(registry: SyncRegistry) => Promise<{ changed: boolean, value?: any }> | { changed: boolean, value?: any }} fn
 */
function transact(userRoot, fn) {
    return enqueue(userRoot, async () => {
        const { registry, migratedIds } = loadRegistry(userRoot);
        if (migratedIds) await seedSnapshotCategories(userRoot, registry, migratedIds);
        const { changed, value } = await fn(registry);
        if (!changed && !migratedIds) return value;
        await writeRegistry(userRoot, registry);
        return value;
    });
}

/**
 * Read the registry, migrating a version 1 file on disk first.
 *
 * @param {{ userRoot: string }} args
 * @returns {Promise<SyncRegistry>}
 */
export function readRegistry({ userRoot }) {
    return transact(userRoot, registry => ({ changed: false, value: registry }));
}

/**
 * Apply `mutate` to the registry and write the result. Resolves to what
 * `mutate` returns.
 *
 * @template T
 * @param {{ userRoot: string }} args
 * @param {(registry: SyncRegistry) => T | Promise<T>} mutate
 * @returns {Promise<T>}
 */
export function updateRegistry({ userRoot }, mutate) {
    return transact(userRoot, async registry => ({ changed: true, value: await mutate(registry) }));
}

/**
 * Throw unless `id` is safe as a path segment and as a git ref component.
 *
 * @param {string} id
 */
export function assertSafeBackendId(id) {
    if (typeof id !== 'string' || !PEER_ID_PATTERN.test(id) || id === '@'
        || id.includes('..') || id.startsWith('.') || id.endsWith('.') || id.endsWith('.lock') || id.includes('@{')) {
        throw syncError('INVALID_BACKEND_ID', `backend id ${JSON.stringify(id)} is not a safe identifier`);
    }
}

function requireEntry(registry, backendId, kind) {
    const entry = registry.backends[backendId];
    if (!entry || (kind && entry.kind !== kind)) {
        throw syncError('UNKNOWN_BACKEND', `no ${kind ? `${kind} ` : ''}backend ${JSON.stringify(backendId)}`);
    }
    return entry;
}

const S3_FIELDS = ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'stripIfMatchQuotes', 'accessKeyId', 'secretAccessKey', 'keyId', 'derivedKey'];
const OPTIONAL_S3_FIELDS = new Set(['stripIfMatchQuotes']);

function invalidS3() {
    throw syncError('S3_SETTINGS_INVALID', 'S3_SETTINGS_INVALID');
}

/** Private comparison excludes unrelated registry and backend settings. */
export function s3SettingsSnapshot(s3) {
    const normalized = normalizeS3Settings(s3);
    return Object.fromEntries(S3_FIELDS.map(field => [field, normalized[field]]));
}

function privateS3(s3) {
    if (!isPlainObject(s3) || Object.keys(s3).some(field => !S3_FIELDS.includes(field))
        || S3_FIELDS.some(field => !OPTIONAL_S3_FIELDS.has(field) && !Object.hasOwn(s3, field))
        || typeof s3.keyId !== 'string' || typeof s3.derivedKey !== 'string') invalidS3();
    const normalized = s3SettingsSnapshot(s3);
    if (!normalized.accessKeyId || !normalized.secretAccessKey) invalidS3();
    return normalized;
}

function s3Presentation(label, categories) {
    if (label !== undefined && typeof label !== 'string') invalidS3();
    if (categories !== undefined && (!Array.isArray(categories) || !categories.length || categories.some(id => typeof id !== 'string'))) invalidS3();
}

export function setDeviceLabel({ userRoot, label }) {
    const normalized = normalizeDeviceLabel(label);
    return updateRegistry({ userRoot }, registry => {
        registry.device.label = normalized;
        return normalized;
    });
}

export async function createS3BackendEntry({ userRoot, backendId, label, categories, s3 }) {
    if (typeof backendId !== 'string' || !/^s3-[a-f0-9]{32}$/.test(backendId)) {
        throw syncError('INVALID_BACKEND_ID', 'INVALID_BACKEND_ID');
    }
    const settings = privateS3(s3);
    s3Presentation(label, categories);
    if (label === undefined || categories === undefined) invalidS3();
    normalizeS3Settings({ ...settings, categories });
    return updateRegistry({ userRoot }, registry => {
        if (Object.hasOwn(registry.backends, backendId)) throw syncError('BACKEND_ID_OCCUPIED', 'BACKEND_ID_OCCUPIED');
        const entry = { kind: 's3', label, categories: [...categories], createdAt: new Date().toISOString(), lastSync: emptyLastSync(), s3: settings };
        registry.backends[backendId] = entry;
        return structuredClone(entry);
    });
}

export async function patchS3BackendEntry({ userRoot, backendId, expectedS3, s3Patch, label, categories, assertAlive }) {
    assertSafeBackendId(backendId);
    if (!isPlainObject(s3Patch) || Object.keys(s3Patch).some(field => !S3_FIELDS.includes(field))) invalidS3();
    s3Presentation(label, categories);
    const expected = s3SettingsSnapshot(expectedS3);
    const patch = { ...s3Patch };
    if (Object.hasOwn(patch, 'accessKeyId') || Object.hasOwn(patch, 'secretAccessKey')) {
        if (patch.accessKeyId === '' && patch.secretAccessKey === '') {
            delete patch.accessKeyId; delete patch.secretAccessKey;
        } else if (typeof patch.accessKeyId !== 'string' || !patch.accessKeyId || typeof patch.secretAccessKey !== 'string' || !patch.secretAccessKey) invalidS3();
    }
    return updateRegistry({ userRoot }, registry => {
        assertAlive?.();
        const entry = requireEntry(registry, backendId, 's3');
        const current = s3SettingsSnapshot(entry.s3);
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw syncError('S3_SETTINGS_CHANGED', 'S3_SETTINGS_CHANGED');
        const next = privateS3({ ...current, ...patch });
        if (categories !== undefined) normalizeS3Settings({ ...next, categories });
        if (next.bucket !== current.bucket || next.prefix !== current.prefix || next.keyId !== current.keyId) invalidS3();
        entry.s3 = next;
        if (label !== undefined) entry.label = label;
        if (categories !== undefined) entry.categories = [...categories];
        return structuredClone(entry);
    });
}

/**
 * Add or refresh a LAN backend. `peerBaseUrl`, `peerAuth`, `syncSecret`,
 * `peerDeviceLabel`
 * and `createdAt` keep their stored values when the caller omits them or
 * supplies an unusable value: `/pair/start` knows none of them and must
 * not clobber what `/pair/accept` saved.
 *
 * @param {{ userRoot: string, backendId: string, label: string, categories: string[], peerBaseUrl?: string, peerAuth?: { username?: string, password?: string } | null, syncSecret?: string | null, peerDeviceLabel?: string, assertAlive?: () => void, requireExisting?: boolean }} args
 * @returns {Promise<BackendEntry>}
 */
export async function upsertLanBackend({ userRoot, backendId, label, categories, peerBaseUrl, peerAuth, syncSecret, peerDeviceLabel, assertAlive, requireExisting = false }) {
    assertSafeBackendId(backendId);
    return updateRegistry({ userRoot }, registry => {
        assertAlive?.();
        if (requireExisting) requireEntry(registry, backendId, 'lan');
        const previous = registry.backends[backendId];
        if (previous && previous.kind !== 'lan') {
            throw syncError('BACKEND_KIND_MISMATCH', `backend ${JSON.stringify(backendId)} is not a LAN backend`);
        }
        const entry = {
            kind: 'lan',
            label,
            categories: [...categories],
            createdAt: previous ? previous.createdAt ?? null : new Date().toISOString(),
            lastSync: previous?.lastSync ?? emptyLastSync(),
            lan: {
                peerId: backendId,
                peerBaseUrl: peerBaseUrl || previous?.lan?.peerBaseUrl || '',
                peerAuth: normalizePeerAuth(peerAuth) ?? previous?.lan?.peerAuth ?? null,
                syncSecret: normalizeSecret(syncSecret) ?? previous?.lan?.syncSecret ?? '',
                peerDeviceLabel: normalizeDeviceLabel(peerDeviceLabel) || previous?.lan?.peerDeviceLabel || '',
            },
        };
        registry.backends[backendId] = entry;
        return structuredClone(entry);
    });
}

/**
 * @param {{ userRoot: string, backendId: string, peerBaseUrl: string }} args
 */
export async function setLanPeerBaseUrl({ userRoot, backendId, peerBaseUrl }) {
    assertSafeBackendId(backendId);
    await updateRegistry({ userRoot }, registry => {
        requireEntry(registry, backendId, 'lan').lan.peerBaseUrl = String(peerBaseUrl ?? '');
    });
}

/**
 * Store the label the other device reports for itself, normalized. No-op
 * when the label has no visible text, is unchanged or the backend is
 * missing, which a concurrent removal leaves behind.
 *
 * @param {{ userRoot: string, backendId: string, peerDeviceLabel: unknown }} args
 */
export async function setLanPeerDeviceLabel({ userRoot, backendId, peerDeviceLabel }) {
    assertSafeBackendId(backendId);
    const label = normalizeDeviceLabel(peerDeviceLabel);
    if (!label) return;
    await transact(userRoot, registry => {
        const entry = registry.backends[backendId];
        if (entry?.kind !== 'lan' || entry.lan.peerDeviceLabel === label) return { changed: false };
        entry.lan.peerDeviceLabel = label;
        return { changed: true };
    });
}

/**
 * @param {{ userRoot: string, backendId: string, syncSecret: string }} args
 */
export async function setLanSecret({ userRoot, backendId, syncSecret }) {
    assertSafeBackendId(backendId);
    const secret = normalizeSecret(syncSecret);
    if (!secret) throw syncError('INVALID_SECRET', 'a sync secret must be 64 hex characters');
    await updateRegistry({ userRoot }, registry => {
        requireEntry(registry, backendId, 'lan').lan.syncSecret = secret;
    });
}

/**
 * @param {{ userRoot: string, backendId: string, label?: string, categories?: string[], assertAlive?: () => void }} args
 */
export async function setBackendSettings({ userRoot, backendId, label, categories, assertAlive }) {
    assertSafeBackendId(backendId);
    if (categories !== undefined && !(Array.isArray(categories) && categories.every(id => typeof id === 'string'))) {
        throw syncError('INVALID_CATEGORIES', 'categories must be an array of category ids');
    }
    await updateRegistry({ userRoot }, registry => {
        assertAlive?.();
        const entry = requireEntry(registry, backendId);
        if (label !== undefined) entry.label = String(label);
        if (categories !== undefined) entry.categories = [...categories];
    });
}

/**
 * Drop stored basic-auth credentials. No-op when the backend is missing or
 * has none.
 *
 * @param {{ userRoot: string, backendId: string, assertAlive?: () => void }} args
 */
export async function clearLanPeerAuth({ userRoot, backendId, assertAlive }) {
    assertSafeBackendId(backendId);
    await transact(userRoot, registry => {
        assertAlive?.();
        const entry = registry.backends[backendId];
        if (entry?.kind !== 'lan' || !entry.lan?.peerAuth) return { changed: false };
        entry.lan.peerAuth = null;
        return { changed: true };
    });
}

/**
 * Record the outcome of a sync. A success replaces `lastSync` and clears
 * the error; an error keeps the last success. No-op for a missing backend,
 * which a concurrent removal leaves behind.
 *
 * @param {{ userRoot: string, backendId: string, success?: { head: string|null, mergeCase: string|null, stalled: string[]|null }, error?: { code: string, message: string }, assertAlive?: () => void }} args
 */
export async function recordLastSync({ userRoot, backendId, success, error, assertAlive }) {
    assertSafeBackendId(backendId);
    await transact(userRoot, registry => {
        assertAlive?.();
        const entry = registry.backends[backendId];
        if (!entry || (!success && !error)) return { changed: false };
        const now = Date.now();
        if (success) {
            entry.lastSync = {
                at: now,
                head: success.head ?? null,
                mergeCase: success.mergeCase ?? null,
                stalled: Array.isArray(success.stalled) ? [...success.stalled] : null,
                error: null,
            };
        } else {
            entry.lastSync = { ...emptyLastSync(), ...entry.lastSync, error: { code: String(error.code), message: String(error.message), at: now } };
        }
        return { changed: true };
    });
}

/**
 * @param {{ userRoot: string, idleSeconds: number, pollSeconds: number }} args
 * @returns {Promise<{ idleSeconds: number, pollSeconds: number }>}
 */
export async function setSchedule({ userRoot, idleSeconds, pollSeconds }) {
    for (const value of [idleSeconds, pollSeconds]) {
        if (!isInterval(value)) {
            throw syncError('INVALID_SCHEDULE', 'schedule intervals must be positive finite numbers of seconds');
        }
    }
    return updateRegistry({ userRoot }, registry => {
        registry.schedule = { idleSeconds, pollSeconds };
        return { ...registry.schedule };
    });
}

/**
 * Remove a backend and its shadow directory. Idempotent. Accepts any id
 * that is safe as a path segment, so an id migrated from a version 1
 * registry that is not a valid ref component can still be removed.
 *
 * @param {{ userRoot: string, backendId: string }} args
 */
export async function removeBackendCompletely({ userRoot, backendId }) {
    assertSafePeerId(backendId);
    const { peerDir } = getShadowPaths({ userRoot, peerId: backendId });
    await transact(userRoot, registry => {
        if (!(backendId in registry.backends)) return { changed: false };
        delete registry.backends[backendId];
        return { changed: true };
    });
    await fs.promises.rm(peerDir, { recursive: true, force: true });
}

/**
 * The registry as shown to the browser: no pairing secret, no credentials.
 *
 * @param {SyncRegistry} registry
 */
export function sanitizeRegistryForClient(registry) {
    const backends = {};
    for (const [id, entry] of Object.entries(registry.backends)) {
        const { kind, label, categories, createdAt, lastSync, lan, s3 } = structuredClone(entry);
        const shown = { kind, label, categories, createdAt, lastSync };
        if (lan) shown.lan = { peerId: lan.peerId, peerBaseUrl: lan.peerBaseUrl, hasStoredCredentials: !!lan.peerAuth };
        if (s3) {
            shown.s3 = {
                endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, prefix: s3.prefix,
                forcePathStyle: s3.forcePathStyle, stripIfMatchQuotes: s3.stripIfMatchQuotes === true,
                keyId: s3.keyId, hasCredentials: !!(s3.accessKeyId && s3.secretAccessKey),
            };
        }
        backends[id] = shown;
    }
    return { version: registry.version, device: { ...registry.device }, backends, schedule: { ...registry.schedule } };
}

/**
 * The name this device shows to others, normalized: the stored label,
 * else the host name unless it is a generic `localhost`, else the profile
 * name.
 *
 * @param {{ device?: { label?: string } }} registry
 * @param {{ handle: string, displayName?: string }} owner
 * @param {string} [hostName]
 * @returns {string}
 */
export function resolveDeviceLabel(registry, owner, hostName = os.hostname()) {
    const host = normalizeDeviceLabel(hostName);
    return normalizeDeviceLabel(registry?.device?.label)
        || (/^localhost(\.|$)/i.test(host) ? '' : host)
        || normalizeDeviceLabel(owner.displayName)
        || normalizeDeviceLabel(owner.handle)
        || String(owner.handle);
}
