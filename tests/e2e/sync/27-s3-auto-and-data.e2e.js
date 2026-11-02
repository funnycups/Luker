import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import crc from 'crc';
import git from 'isomorphic-git';
import assert from 'node:assert/strict';
import { s3Fixture, registryOf, createReadyWorldBook as createWorldBook, selectReadyWorldBook as selectWorldBook, reloadS3Page } from '../_lib/sync-s3.js';
import { addS3Backend, waitForBackendSync, closeAllPopups, openLanSyncPanel, setSyncSchedule, clickSyncNow, readUserFile, userRootOf, recordDirtyWrites, waitForSyncPopup, conflictChoiceShowing, chooseConflictVersion, applyConflictChoices, shadowMain } from '../_lib/sync.js';
import { addWorldEntry, deleteSelectedWorldBook } from '../_lib/ui-worldinfo.js';

const fixture = s3Fixture(test);
test.describe.configure({ timeout: 300_000 });
async function pair(browser, categories = ['worlds'], extraEnv = {}, receiverEndpoint) {
    const a = await fixture.device(browser, 'data-a', extraEnv);
    const b = await fixture.device(browser, 'data-b');
    const options = await fixture.options(categories);
    await addS3Backend(a.page, options);
    await waitForBackendSync(a.page, { label: 'Cloud' });
    await addS3Backend(b.page, { ...options, endpoint: receiverEndpoint ?? options.endpoint });
    await waitForBackendSync(b.page, { label: 'Cloud' });
    // Explicitly settle both initialization runs before any divergent edit.
    await waitForBackendSync(a.page, { label: 'Cloud' });
    await closeAllPopups(a.page);
    await closeAllPopups(b.page);
    for (const device of [a, b]) expect(registryOf(device.server).schedule).toMatchObject({ idleSeconds: 3600, pollSeconds: 3600 });
    return { a, b, options };
}
async function manual(device, timeoutMs) {
    await openLanSyncPanel(device.page);
    expect(await clickSyncNow(device.page, 'Cloud', timeoutMs)).toBe('success');
    await closeAllPopups(device.page);
}
const lastSync = server => Object.values(registryOf(server).backends)[0].lastSync.at;
async function snapshotted(server, filepath) {
    const id = Object.keys(registryOf(server).backends)[0];
    try {
        await git.readBlob({ fs, gitdir: path.join(userRootOf(server), '.sync', id, 'repo.git'), oid: await shadowMain(server, id), filepath });
        return true;
    } catch { return false; }
}

test('idle1 publishes without manual or poll triggers and poll2 applies with the frontend closed', async ({ browser }, testInfo) => {
    const trace = testInfo.outputPath('dirty.jsonl');
    const receiverProxy = await fixture.proxy();
    const { a, b } = await pair(browser, ['worlds'], { LUKER_TEST_DIRTY_TRACE: trace }, receiverProxy.endpoint);
    const writes = recordDirtyWrites(a.page);
    await openLanSyncPanel(a.page);
    await setSyncSchedule(a.page, { idleSeconds: 1, pollSeconds: 3600 });
    expect(registryOf(a.server).schedule).toMatchObject({ idleSeconds: 1, pollSeconds: 3600 });
    await closeAllPopups(a.page);
    // Wait for all UI preparation writes and their idle run before the edit.
    await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.lastSentAt, writes.at(-1)?.at ?? 0) > 1500, { timeout: 60_000 }).toBe(true);
    await waitForBackendSync(a.page, { label: 'Cloud' });
    const beforeA = lastSync(a.server), beforeB = lastSync(b.server);
    const manualRequests = [];
    a.page.on('request', r => { if (r.method() === 'POST' && /\/backends\/[^/]+\/sync$/.test(new URL(r.url()).pathname)) manualRequests.push(r.url()); });
    const from = writes.length;
    const traceFrom = fs.readFileSync(trace, 'utf8').length;
    await createWorldBook(a.page, 'Idle Moonwell');
    await expect.poll(() => lastSync(a.server), { timeout: 60_000 }).toBeGreaterThan(beforeA);
    await expect.poll(() => snapshotted(a.server, 'worlds/Idle Moonwell.json'), { timeout: 60_000 }).toBe(true);
    await waitForBackendSync(a.page, { label: 'Cloud', since: beforeA });
    expect(writes.slice(from).some(w => w.path === '/api/worldinfo/edit')).toBe(true);
    const marks = fs.readFileSync(trace, 'utf8').slice(traceFrom).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(marks.some(mark => mark.path === '/api/worldinfo/edit'), 'the world edit itself emitted the genuine dirty notification').toBe(true);
    expect(manualRequests).toEqual([]);
    // A cannot push into B over S3: B's idle and poll remain at 3600.
    expect(lastSync(b.server)).toBe(beforeB);
    expect(readUserFile(b.server, 'worlds/Idle Moonwell.json')).toBeNull();
    // Hold the genuine poll's remote read until the browser has closed:
    // arrival before closure cannot accidentally satisfy this assertion.
    const poll = receiverProxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
    await openLanSyncPanel(b.page);
    await setSyncSchedule(b.page, { idleSeconds: 3600, pollSeconds: 2 });
    expect(registryOf(b.server).schedule).toMatchObject({ idleSeconds: 3600, pollSeconds: 2 });
    try {
        await poll.reached;
        expect(readUserFile(b.server, 'worlds/Idle Moonwell.json')).toBeNull();
        await b.context.close();
    } finally { poll.release(); }
    await expect.poll(() => readUserFile(b.server, 'worlds/Idle Moonwell.json'), { timeout: 60_000 }).not.toBeNull();
    expect(b.context.pages()).toEqual([]);
    expect(lastSync(b.server)).toBeGreaterThan(beforeB);
});

test('poll2 publishes a UI edit with idle disabled and manual remains independent at schedule3600', async ({ browser }) => {
    const { a, b } = await pair(browser);
    await createWorldBook(a.page, 'Manual Thornwatch');
    const beforeA = lastSync(a.server), beforeB = lastSync(b.server);
    // More than the tested idle1/poll2 window: neither default can mask manual.
    // This deliberate negative-control interval exceeds idle1 and poll2.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await a.page.waitForTimeout(3500);
    expect(lastSync(a.server)).toBe(beforeA);
    expect(lastSync(b.server)).toBe(beforeB);
    expect(readUserFile(b.server, 'worlds/Manual Thornwatch.json')).toBeNull();
    await manual(a);
    expect(readUserFile(b.server, 'worlds/Manual Thornwatch.json')).toBeNull();
    await manual(b);
    expect(readUserFile(b.server, 'worlds/Manual Thornwatch.json')).not.toBeNull();
    await openLanSyncPanel(a.page);
    await setSyncSchedule(a.page, { idleSeconds: 3600, pollSeconds: 2 });
    expect(registryOf(a.server).schedule).toMatchObject({ idleSeconds: 3600, pollSeconds: 2 });
    await closeAllPopups(a.page);
    await createWorldBook(a.page, 'Polling Rivermouth');
    const editedAt = Date.now();
    await expect.poll(() => lastSync(a.server), { timeout: 60_000 }).toBeGreaterThan(editedAt);
    await expect.poll(() => snapshotted(a.server, 'worlds/Polling Rivermouth.json'), { timeout: 60_000 }).toBe(true);
    await waitForBackendSync(a.page, { label: 'Cloud', since: editedAt });
    expect(readUserFile(b.server, 'worlds/Polling Rivermouth.json')).toBeNull();
    await manual(b);
    expect(readUserFile(b.server, 'worlds/Polling Rivermouth.json')).not.toBeNull();
});

test('manual disjoint divergence and deletion/rename preserve roleplay content', async ({ browser }) => {
    const { a, b } = await pair(browser);
    await createWorldBook(a.page, 'Thornwatch');
    await addWorldEntry(a.page, { key: 'warden', content: 'The warden keeps the moonwell sealed.' });
    await createWorldBook(b.page, 'Rivermouth');
    await addWorldEntry(b.page, { key: 'ferryman', content: 'The ferryman awaits the glade guardian.' });
    await manual(a);
    await manual(b);
    await manual(a);
    for (const device of [a, b]) {
        expect(readUserFile(device.server, 'worlds/Thornwatch.json')).toContain('moonwell sealed');
        expect(readUserFile(device.server, 'worlds/Rivermouth.json')).toContain('glade guardian');
    }
    await reloadS3Page(a.page);
    await selectWorldBook(a.page, 'Thornwatch');
    await a.page.locator('#world_popup_name_button').click();
    const rename = a.page.locator('dialog.popup[open]').last();
    await rename.locator('.popup-input').fill('Thornwatch at Dawn');
    await rename.locator('.popup-button-ok').click();
    await expect.poll(() => readUserFile(a.server, 'worlds/Thornwatch at Dawn.json'), { timeout: 30_000 }).not.toBeNull();
    await selectWorldBook(a.page, 'Rivermouth');
    await deleteSelectedWorldBook(a.page);
    await expect.poll(() => readUserFile(a.server, 'worlds/Rivermouth.json')).toBeNull();
    await manual(a);
    await manual(b);
    expect(readUserFile(b.server, 'worlds/Thornwatch.json')).toBeNull();
    expect(readUserFile(b.server, 'worlds/Rivermouth.json')).toBeNull();
    expect(readUserFile(b.server, 'worlds/Thornwatch at Dawn.json')).toContain('moonwell sealed');
    await reloadS3Page(b.page);
    await selectWorldBook(b.page, 'Thornwatch at Dawn');
    const content = b.page.locator('#world_popup_entries_list textarea[name="content"]').first();
    // eslint-disable-next-line playwright/no-conditional-in-test -- Entry expansion is persisted UI state.
    if (!await content.isVisible()) await b.page.locator('#world_popup_entries_list .wi-entry-toggle').first().click();
    await expect(content).toHaveValue('The warden keeps the moonwell sealed.');
});

test('manual same-file divergence requires a genuine DOM choice and propagates that choice', async ({ browser }) => {
    const { a, b } = await pair(browser);
    await createWorldBook(a.page, 'Shared Glade');
    await manual(a);
    await manual(b);
    for (const [device, side] of [[a, 'Desk'], [b, 'Tablet']]) {
        await reloadS3Page(device.page);
        await selectWorldBook(device.page, 'Shared Glade');
        await addWorldEntry(device.page, { key: side, content: `${side} guards the moonwell` });
    }
    await manual(a);
    await openLanSyncPanel(b.page);
    expect(await clickSyncNow(b.page, 'Cloud')).toBe('warning');
    await waitForSyncPopup(b.page);
    const rel = 'worlds/Shared Glade.json';
    const choice = await conflictChoiceShowing(b.page, rel, 'Tablet guards the moonwell');
    await chooseConflictVersion(b.page, rel, choice);
    expect(await applyConflictChoices(b.page)).toBe('success');
    await closeAllPopups(b.page);
    await waitForBackendSync(b.page, { label: 'Cloud' });
    await manual(b);
    await manual(a);
    for (const device of [a, b]) {
        expect(readUserFile(device.server, rel)).toContain('Tablet guards the moonwell');
        expect(readUserFile(device.server, rel)).not.toContain('Desk guards the moonwell');
    }
});

function pngChunk(type, bytes) {
    const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc.crc32(Buffer.concat([name, bytes])) >>> 0);
    return Buffer.concat([size, name, bytes, checksum]);
}
function largePng() {
    // Incompressible real RGB pixels, not a tiny image with trailing junk.
    const width = 4096, height = 4267;
    const raw = randomBytes((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function assertCompletePngUpload(persisted, image, diskSize) {
    assert.equal(diskSize, image.length, 'persisted file must retain the complete uploaded PNG length');
    assert.ok(diskSize >= 50 * 1024 * 1024, 'persisted PNG must retain at least 50MiB');
    assert.equal(persisted.length, image.length, 'persisted read must retain the complete uploaded PNG length');
    assert.equal(createHash('sha256').update(persisted).digest('hex'), createHash('sha256').update(image).digest('hex'), 'persisted PNG must retain the complete input hash');
}

test('a valid 50MiB DOM background upload syncs the actual persisted image bytes', async ({ browser }, testInfo) => {
    // Real image decoding, git packing/encryption and two SDK transfers of
    // >50MiB merit a test-only budget, particularly for actual --jitless.
    test.setTimeout(600_000);
    const { a, b } = await pair(browser, ['backgrounds']);
    const input = testInfo.outputPath('moonwell-50mib.png');
    const image = largePng();
    expect(image.length).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    fs.writeFileSync(input, image);
    const uploaded = a.page.waitForResponse(r => new URL(r.url()).pathname === '/api/backgrounds/upload', { timeout: 120_000 });
    await a.page.locator('#add_bg_button').setInputFiles(input);
    expect((await uploaded).ok()).toBe(true);
    const rel = 'backgrounds/moonwell-50mib.png';
    const source = path.join(userRootOf(a.server), rel);
    await expect.poll(() => fs.existsSync(source), { timeout: 60_000 }).toBe(true);
    const persisted = fs.readFileSync(source);
    assertCompletePngUpload(persisted, image, fs.statSync(source).size);
    // Assertion-only negative control: no runtime file or product response is
    // modified. Identical truncated copies on A/B must not satisfy this guard.
    expect(() => assertCompletePngUpload(persisted.subarray(0, -1), image, persisted.length - 1)).toThrow('persisted file must retain the complete uploaded PNG length');
    const expected = createHash('sha256').update(persisted).digest('hex');
    await manual(a, 240_000);
    await manual(b, 240_000);
    const result = fs.readFileSync(path.join(userRootOf(b.server), rel));
    expect(result).toHaveLength(persisted.length);
    expect(createHash('sha256').update(result).digest('hex')).toBe(expected);
    await testInfo.attach('persisted-image-hashes', { body: JSON.stringify({ uploadedBytes: image.length, persistedBytes: persisted.length, a: expected, b: createHash('sha256').update(result).digest('hex') }), contentType: 'application/json' });
});
