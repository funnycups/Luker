import { afterEach, beforeEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createS3BackendEntry, patchS3BackendEntry, readRegistry, recordLastSync, removeBackendCompletely,
    sanitizeRegistryForClient, setBackendSettings, setDeviceLabel, setSchedule } from '../../src/sync/state.js';
import { normalizeDeviceLabel } from '../../src/sync/device-label.js';

let userRoot;
const backendId = `s3-${'a'.repeat(32)}`;
const settings = () => ({ endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'registry', prefix: 'namespace',
    forcePathStyle: true, stripIfMatchQuotes: false, accessKeyId: 'private-access', secretAccessKey: 'private-secret', keyId: 'a'.repeat(16), derivedKey: randomBytes(32).toString('base64') });
const create = s3 => createS3BackendEntry({ userRoot, backendId, label: 'Original', categories: ['worlds'], s3 });
beforeEach(() => { userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's3-registry-')); });
afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

test('private atomic entry is mode0600 and client output is allowlisted', async () => {
    const s3 = settings();
    const entry = await create(s3);
    expect(entry.s3).toEqual(s3);
    expect(fs.statSync(path.join(userRoot, '.sync/state.json')).mode & 0o777).toBe(0o600);
    const shown = sanitizeRegistryForClient(await readRegistry({ userRoot }));
    expect(shown.backends[backendId].s3.hasCredentials).toBe(true);
    for (const secret of [s3.accessKeyId, s3.secretAccessKey, s3.derivedKey, 'passphrase']) expect(JSON.stringify(shown)).not.toContain(secret);
    entry.s3.secretAccessKey = 'mutated-return';
    expect((await readRegistry({ userRoot })).backends[backendId].s3.secretAccessKey).toBe(s3.secretAccessKey);
});

test('the If-Match quote setting persists and is public without credentials', async () => {
    const s3 = settings(); await create(s3);
    const patched = await patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch: { stripIfMatchQuotes: true } });
    expect(patched.s3.stripIfMatchQuotes).toBe(true);
    expect(sanitizeRegistryForClient(await readRegistry({ userRoot })).backends[backendId].s3.stripIfMatchQuotes).toBe(true);
});

test('an entry saved before the If-Match quote setting keeps quoted ETags', async () => {
    const legacy = settings();
    delete legacy.stripIfMatchQuotes;
    const entry = await create(legacy);
    expect(entry.s3.stripIfMatchQuotes).toBe(false);
    expect(sanitizeRegistryForClient(await readRegistry({ userRoot })).backends[backendId].s3.stripIfMatchQuotes).toBe(false);
});

test('prepared patch retains latest unrelated settings and sync outcome', async () => {
    const s3 = settings(); await create(s3);
    await Promise.all([
        recordLastSync({ userRoot, backendId, success: { head: 'b'.repeat(40) } }),
        setSchedule({ userRoot, idleSeconds: 21, pollSeconds: 89 }),
        setDeviceLabel({ userRoot, label: '  My\n Device  ' }),
        setBackendSettings({ userRoot, backendId, label: 'Latest', categories: ['characters'] }),
        patchS3BackendEntry({ userRoot, backendId, expectedS3: { ...s3, prefix: '/namespace/' }, s3Patch: { region: 'changed' } }),
    ]);
    const registry = await readRegistry({ userRoot });
    expect(registry.schedule).toEqual({ idleSeconds: 21, pollSeconds: 89 });
    expect(registry.device.label).toBe(normalizeDeviceLabel('  My\n Device  '));
    expect(registry.backends[backendId]).toMatchObject({ label: 'Latest', categories: ['characters'], lastSync: { head: 'b'.repeat(40) }, s3: { region: 'changed' } });
});

test.each([{}, { accessKeyId: '', secretAccessKey: '' }])('omitted or blank credential pair retains private fields: %j', async s3Patch => {
    const s3 = settings(); await create(s3);
    expect((await patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch })).s3).toEqual(s3);
});

test.each([{ accessKeyId: 'replacement' }, { secretAccessKey: 'replacement' }, { accessKeyId: '', secretAccessKey: 'replacement' },
    { phrase: 'secret' }, { passphrase: 'secret' }, { unknown: 'secret' }, { bucket: 'other' }, { prefix: 'other' }, { stripIfMatchQuotes: 'yes' }])('invalid replacement leaves entry and ledger unchanged: %j', async s3Patch => {
    const s3 = settings(); await create(s3);
    const ledger = path.join(userRoot, '.sync', backendId, 's3-packs.json');
    fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, 'fixture-owned-ledger');
    const before = fs.readFileSync(path.join(userRoot, '.sync/state.json'), 'utf8');
    await expect(patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch })).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    expect(fs.readFileSync(path.join(userRoot, '.sync/state.json'), 'utf8')).toBe(before);
    expect(fs.readFileSync(ledger, 'utf8')).toBe('fixture-owned-ledger');
});

test('explicit fields patch fresh state; concurrent private change rejects stale preparation', async () => {
    const s3 = settings(); await create(s3);
    const next = await patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch: { accessKeyId: 'new-access', secretAccessKey: 'new-secret' }, label: 'Explicit' });
    await expect(patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch: { derivedKey: randomBytes(32).toString('base64') } })).rejects.toMatchObject({ code: 'S3_SETTINGS_CHANGED' });
    expect((await readRegistry({ userRoot })).backends[backendId]).toEqual(next);
    await removeBackendCompletely({ userRoot, backendId });
    await expect(patchS3BackendEntry({ userRoot, backendId, expectedS3: next.s3, s3Patch: {} })).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
    expect((await readRegistry({ userRoot })).backends).toEqual({});
});

test('creation rejects collisions, malformed IDs, incomplete credentials and extra secrets', async () => {
    const s3 = settings(); await create(s3);
    await expect(create(s3)).rejects.toMatchObject({ code: 'BACKEND_ID_OCCUPIED' });
    for (const invalid of [{ ...s3, accessKeyId: '' }, { ...s3, secretAccessKey: '' }, { ...s3, passphrase: 'never-store' }]) {
        await expect(createS3BackendEntry({ userRoot, backendId: `s3-${randomBytes(16).toString('hex')}`, label: '', categories: ['worlds'], s3: invalid })).rejects.toMatchObject({ code: 'S3_SETTINGS_INVALID' });
    }
    await expect(createS3BackendEntry({ userRoot, backendId: 's3-short', label: '', categories: ['worlds'], s3 })).rejects.toMatchObject({ code: 'INVALID_BACKEND_ID' });
});

test('maintenance commit guard runs inside mutation and prevents delayed writes', async () => {
    const s3 = settings(); await create(s3);
    await expect(patchS3BackendEntry({ userRoot, backendId, expectedS3: s3, s3Patch: { region: 'never-commit' }, assertAlive: () => { throw Object.assign(new Error('removed'), { code: 'UNKNOWN_BACKEND' }); } })).rejects.toMatchObject({ code: 'UNKNOWN_BACKEND' });
    expect((await readRegistry({ userRoot })).backends[backendId].s3).toEqual(s3);
});
