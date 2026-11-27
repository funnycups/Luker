import { test as nativeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import express from 'express';
import { setConfigFilePath } from '../../src/util.js';
import { createRun } from '../harness/resources/run.js';
import { makeTempFsEngine } from './harness/fs-harness.js';
import { seedReferenceCard, referenceCardState } from './harness/world-identity.js';
import { worldFilenameState } from './harness/world-filenames.js';

// Dedicated native case-sensitive command, not a replacement or exclusion for
// the normal all-engine suites. A filesystem without distinct spellings fails.
setConfigFilePath(new URL('../../default/config.yaml', import.meta.url).pathname);
const projectRoot = process.env.LUKER_WORLD_FILENAME_PROJECT_ROOT
    ? fs.realpathSync(path.resolve(process.env.LUKER_WORLD_FILENAME_PROJECT_ROOT))
    : path.resolve(import.meta.dirname, '../..');
const run = await createRun({ projectRoot, profile: 'storage-local', command: [process.execPath, ...process.argv.slice(1)], source: import.meta.filename });
const scope = await run.scope({ kind: 'case', label: 'world filename identity' });
const scratchDir = await scope.directory('world-filename-data-root');
globalThis.DATA_ROOT = scratchDir.path;
let failed = false;
const test = (name, callback) => nativeTest(name, async context => {
    try { await callback(context); }
    catch (error) { failed = true; run.recordError(error); throw error; }
});
after(async () => {
    await scope.dispose();
    const finishResult = await run.finish({ status: failed ? 'failed' : 'passed' });
    if (!failed && finishResult?.errors?.length) {
        throw new AggregateError(finishResult.errors, 'Managed integration run cleanup failed');
    }
});
const { initStorage, getWorldInfoRepo, getSettingsRepo, getStorageEngine } = await import('../../src/storage/index.js');
const { assertWorldNotBound } = await import('../../src/character-world-ownership.js');
const { router } = await import('../../src/endpoints/worldinfo.js');

const NAME = 'Archive Ledger';
const CANONICAL = 'Archive Ledger.json', LEGACY = 'Archive Ledger.JSON', KEEP = 'Unchanged.json';
const CANONICAL_DOC = { entries: { '1': { content: 'Canonical archive 北', key: ['north'] } }, extensions: { retained: ['canonical', { complete: true }] } };
const LEGACY_DOC = { entries: { '2': { content: 'Legacy archive 南', key: ['south'] } }, extensions: { retained: ['legacy', { complete: true }] } };
const KEEP_DOC = { entries: { '3': { content: 'Independent archive' } }, extensions: { retained: ['book sibling'] } };
const SOURCE = { world_info_settings: { world_info: { charLore: [], retained: { setting: ['world sibling'] } } }, retained: { settings: ['untouched'] } };
const canonicalBytes = JSON.stringify(CANONICAL_DOC, null, 4) + '\n';
const legacyBytes = JSON.stringify(LEGACY_DOC) + '\n';

async function fixture(t, spellings = 'both') {
    const h = await makeTempFsEngine({ scope });
    let server;
    t.after(async () => {
        try { if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { try { await h.engine.close(); } finally { await h.cleanup(); } }
    });
    initStorage({ mode: 'fs', directoriesByHandle: handle => {
        assert.equal(handle, h.handle);
        return h.dirs;
    } });
    h.engine = getStorageEngine();
    const worlds = getWorldInfoRepo(), settings = getSettingsRepo();
    fs.mkdirSync(h.dirs.worlds);
    if (spellings === 'both' || spellings === 'canonical') fs.writeFileSync(path.join(h.dirs.worlds, CANONICAL), canonicalBytes, { flag: 'wx' });
    if (spellings === 'both' || spellings === 'legacy') fs.writeFileSync(path.join(h.dirs.worlds, LEGACY), legacyBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(h.dirs.worlds, KEEP), JSON.stringify(KEEP_DOC), { flag: 'wx' });
    await settings.save(h.handle, SOURCE);
    seedReferenceCard(h, 'keeper.png', 'Unchanged');
    seedReferenceCard(h, 'other.png', 'Unchanged');
    const app = express();
    app.use(express.json());
    app.use((request, response, next) => { request.user = { profile: { handle: h.handle }, directories: h.dirs }; next(); });
    app.use('/api/worldinfo', router);
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const request = async body => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/worldinfo/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    };
    const selection = async (name = NAME) => ({ doc: await worlds.get(h.handle, name), version: await worlds.getVersion(h.handle, name), name: await worlds.resolveName(h.handle, name), capturedName: await (await worlds.captureIdentity(h.handle))(name) });
    const snapshot = async (directory = h.dirs.worlds) => ({ physical: worldFilenameState(directory), settings: await settings.get(h.handle), cards: referenceCardState(h) });
    const before = await snapshot();
    const selected = await selection();
    assert.deepEqual(before.physical.files[KEEP].doc, KEEP_DOC);
    if (spellings === 'both') {
        assert.deepEqual(before.physical.enumeration, [LEGACY, CANONICAL, KEEP]);
        assert.notEqual(before.physical.files[CANONICAL].inode, before.physical.files[LEGACY].inode);
        assert.notEqual(before.physical.files[CANONICAL].version, before.physical.files[LEGACY].version);
    }
    if (spellings === 'both' || spellings === 'canonical') {
        assert.deepEqual(before.physical.files[CANONICAL].doc, CANONICAL_DOC);
        assert.equal(before.physical.files[CANONICAL].bytes, Buffer.from(canonicalBytes).toString('base64'));
        assert.deepEqual(selected, { doc: CANONICAL_DOC, version: before.physical.files[CANONICAL].version, name: NAME, capturedName: NAME });
    }
    if (spellings === 'both' || spellings === 'legacy') {
        assert.deepEqual(before.physical.files[LEGACY].doc, LEGACY_DOC);
        assert.equal(before.physical.files[LEGACY].bytes, Buffer.from(legacyBytes).toString('base64'));
    }
    return { h, worlds, settings, request, selection, snapshot, before, selected };
}

// No timer or mocked application call: the worker's native FIFO writer meets
// the actual synchronous settings reader after the captured catalog exists.
async function atSettingsRead(t, f, action, settings = SOURCE) {
    const fifo = path.join(f.h.dirs.root, 'settings.json');
    fs.unlinkSync(fifo);
    execFileSync('mkfifo', [fifo]);
    const worker = new Worker(new URL('./harness/world-filename-worker.js', import.meta.url), { workerData: { fifo, directory: f.h.dirs.worlds, action, settings, canonicalBytes } });
    let opening, observation, exited = false;
    const ready = new Promise(resolve => { opening = resolve; });
    const done = new Promise((resolve, reject) => {
        worker.on('message', message => {
            if (message.event === 'opening') opening(message);
            if (message.event === 'released') observation = message;
        });
        worker.once('error', reject);
        worker.once('exit', code => { exited = true; code === 0 ? resolve(observation) : reject(new Error(`FIFO worker exited ${code}`)); });
    });
    t.after(async () => { if (!exited) await worker.terminate(); });
    await ready;
    return async () => {
        const result = await done;
        fs.unlinkSync(fifo);
        fs.writeFileSync(fifo, JSON.stringify(settings), { flag: 'wx' });
        return result;
    };
}

for (const versioned of [true, false]) {
    test(`coexisting spellings: ${versioned ? 'valid-version' : 'standalone'} HTTP deletion removes the inspected canonical file`, async t => {
        const f = await fixture(t);
        const request = { name: NAME, onlyIfUnbound: true, ...(versioned ? { expectedVersion: f.selected.version } : {}) };
        const result = await f.request(request);
        const actual = await f.snapshot();
        const selected = await f.selection();
        assert.deepEqual(result, { status: 200, body: 'OK' });
        assert.deepEqual(actual, { ...f.before, physical: { enumeration: [LEGACY, KEEP], files: { [LEGACY]: f.before.physical.files[LEGACY], [KEEP]: f.before.physical.files[KEEP] } } });
        assert.deepEqual(selected, { doc: LEGACY_DOC, version: f.before.physical.files[LEGACY].version, name: NAME, capturedName: NAME });
    });

    test(`canonical disappearance: ${versioned ? 'version refusal' : 'standalone absence'} reports missing beside retained legacy`, async t => {
        const f = await fixture(t);
        const release = await atSettingsRead(t, f, 'remove-canonical');
        const request = { name: NAME, onlyIfUnbound: true, ...(versioned ? { expectedVersion: f.selected.version } : {}) };
        const result = await f.request(request);
        const native = await release();
        const actual = await f.snapshot();
        assert.equal(native.nativeFifo, true);
        assert.deepEqual(native.before, f.before.physical);
        assert.deepEqual(result, { status: versioned ? 409 : 404, body: { code: versioned ? 'world_changed' : 'world_missing', resourceState: 'missing' } });
        assert.deepEqual(actual, { ...f.before, physical: { enumeration: [LEGACY, KEEP], files: { [LEGACY]: f.before.physical.files[LEGACY], [KEEP]: f.before.physical.files[KEEP] } } });
    });

    test(`legacy inspection: later canonical creation cannot redirect ${versioned ? 'versioned' : 'standalone'} deletion`, async t => {
        const f = await fixture(t, 'legacy');
        const release = await atSettingsRead(t, f, 'create-canonical');
        const request = { name: NAME, onlyIfUnbound: true, ...(versioned ? { expectedVersion: f.selected.version } : {}) };
        const result = await f.request(request);
        const native = await release();
        const actual = await f.snapshot();
        const selected = await f.selection();
        assert.equal(native.nativeFifo, true);
        assert.deepEqual(native.before, f.before.physical);
        assert.deepEqual(result, { status: 200, body: 'OK' });
        assert.deepEqual(actual, { ...f.before, physical: { enumeration: [CANONICAL, KEEP], files: { [CANONICAL]: native.after.files[CANONICAL], [KEEP]: f.before.physical.files[KEEP] } } });
        assert.deepEqual(actual.physical.files[CANONICAL].doc, CANONICAL_DOC);
        assert.equal(actual.physical.files[CANONICAL].bytes, Buffer.from(canonicalBytes).toString('base64'));
        assert.deepEqual(selected, { doc: CANONICAL_DOC, version: native.after.files[CANONICAL].version, name: NAME, capturedName: NAME });
    });

    test(`legacy disappearance: later canonical remains outside ${versioned ? 'versioned' : 'standalone'} deletion`, async t => {
        const f = await fixture(t, 'legacy');
        const release = await atSettingsRead(t, f, 'replace-legacy');
        const request = { name: NAME, onlyIfUnbound: true, ...(versioned ? { expectedVersion: f.selected.version } : {}) };
        const result = await f.request(request);
        const native = await release();
        const actual = await f.snapshot();
        assert.equal(native.nativeFifo, true);
        assert.deepEqual(result, { status: versioned ? 409 : 404, body: { code: versioned ? 'world_changed' : 'world_missing', resourceState: 'missing' } });
        assert.deepEqual(actual, { ...f.before, physical: native.after });
        assert.deepEqual(actual.physical.files[CANONICAL].doc, CANONICAL_DOC);
        assert.equal(actual.physical.files[CANONICAL].bytes, Buffer.from(canonicalBytes).toString('base64'));
    });

    test(`captured absence: later canonical cannot satisfy ${versioned ? 'original version' : 'standalone target'}`, async t => {
        const f = await fixture(t, 'absent');
        const release = await atSettingsRead(t, f, 'create-canonical');
        const request = { name: NAME, onlyIfUnbound: true, ...(versioned ? { expectedVersion: 'original-version' } : {}) };
        const result = await f.request(request);
        const native = await release();
        const actual = await f.snapshot();
        assert.equal(native.nativeFifo, true);
        assert.deepEqual(f.selected, { doc: null, version: null, name: null, capturedName: null });
        assert.deepEqual(result, { status: versioned ? 409 : 404, body: { code: versioned ? 'world_changed' : 'world_missing', resourceState: 'missing' } });
        assert.deepEqual(actual, { ...f.before, physical: native.after });
        assert.deepEqual(actual.physical.files[CANONICAL].doc, CANONICAL_DOC);
    });
}

for (const conditional of [false, true]) {
    test(`uppercase-only ordinary and conditional aliases preserve legacy lookup: conditional=${conditional}`, async t => {
        const f = await fixture(t, 'legacy');
        const selected = await f.selection('Archive  Ledger');
        const result = await f.request({ name: 'Archive  Ledger', ...(conditional ? { onlyIfUnbound: true, expectedVersion: selected.version } : {}) });
        const actual = await f.snapshot();
        assert.deepEqual(selected, { doc: LEGACY_DOC, version: f.before.physical.files[LEGACY].version, name: NAME, capturedName: NAME });
        assert.deepEqual(result, { status: 200, body: 'OK' });
        assert.deepEqual(actual, { ...f.before, physical: { enumeration: [KEEP], files: { [KEEP]: f.before.physical.files[KEEP] } } });
    });

    test(`coexisting tolerant alias retains its actual legacy selection: conditional=${conditional}`, async t => {
        const f = await fixture(t);
        const selected = await f.selection('Archive  Ledger');
        const result = await f.request({ name: 'Archive  Ledger', ...(conditional ? { onlyIfUnbound: true, expectedVersion: selected.version } : {}) });
        const actual = await f.snapshot();
        assert.deepEqual(selected, { doc: LEGACY_DOC, version: f.before.physical.files[LEGACY].version, name: NAME, capturedName: NAME });
        assert.deepEqual(result, { status: 200, body: 'OK' });
        assert.deepEqual(actual, { ...f.before, physical: { enumeration: [CANONICAL, KEEP], files: { [CANONICAL]: f.before.physical.files[CANONICAL], [KEEP]: f.before.physical.files[KEEP] } } });
    });
}

test('ordinary exact HTTP deletion keeps canonical filename precedence', async t => {
    const f = await fixture(t);
    const result = await f.request({ name: NAME });
    const actual = await f.snapshot();
    assert.deepEqual(result, { status: 200, body: 'OK' });
    assert.deepEqual(actual, { ...f.before, physical: { enumeration: [LEGACY, KEEP], files: { [LEGACY]: f.before.physical.files[LEGACY], [KEEP]: f.before.physical.files[KEEP] } } });
});

test('version-only HTTP deletion retains the inspected canonical locator', async t => {
    const f = await fixture(t);
    const request = { name: NAME, expectedVersion: f.selected.version };
    const result = await f.request(request);
    const actual = await f.snapshot();
    assert.deepEqual(result, { status: 200, body: 'OK' });
    assert.deepEqual(actual, { ...f.before, physical: { enumeration: [LEGACY, KEEP], files: { [LEGACY]: f.before.physical.files[LEGACY], [KEEP]: f.before.physical.files[KEEP] } } });
});

test('stale version refuses without changing either complete physical resource', async t => {
    const f = await fixture(t);
    const result = await f.request({ name: NAME, onlyIfUnbound: true, expectedVersion: f.before.physical.files[LEGACY].version });
    const actual = await f.snapshot();
    assert.deepEqual(result, { status: 409, body: { code: 'world_changed', resourceState: 'present' } });
    assert.deepEqual(actual, f.before);
});

test('refused legacy deletion reports present after a later canonical file changes live selection', async t => {
    const f = await fixture(t, 'legacy');
    const release = await atSettingsRead(t, f, 'create-canonical');
    const request = { name: NAME, onlyIfUnbound: true, expectedVersion: 'stale-version' };
    const result = await f.request(request);
    const native = await release();
    const actual = await f.snapshot();
    assert.equal(native.nativeFifo, true);
    assert.deepEqual(result, { status: 409, body: { code: 'world_changed', resourceState: 'present' } });
    assert.deepEqual(actual, { ...f.before, physical: native.after });
    assert.deepEqual(actual.physical.files[LEGACY], f.before.physical.files[LEGACY]);
    assert.deepEqual(actual.physical.files[CANONICAL].doc, CANONICAL_DOC);
    assert.equal(actual.physical.files[CANONICAL].bytes, Buffer.from(canonicalBytes).toString('base64'));
});

for (const reference of ['auxiliary', 'primary']) {
    test(`${reference} binding refuses deletion and retains both filenames`, async t => {
        const f = await fixture(t);
        const source = structuredClone(SOURCE);
        if (reference === 'auxiliary') source.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [NAME] }];
        else seedReferenceCard(f.h, 'keeper.png', NAME);
        await f.settings.save(f.h.handle, source);
        const before = await f.snapshot();
        const result = await f.request({ name: NAME, onlyIfUnbound: true });
        const actual = await f.snapshot();
        assert.deepEqual(result, { status: 409, body: { code: 'world_in_use', details: reference === 'auxiliary' ? { name: NAME, reference } : { name: NAME, avatar: 'keeper.png' }, resourceState: 'present' } });
        assert.deepEqual(actual, before);
    });
}

test('a legacy deletion receipt retains its original aliases after canonical creation', async t => {
    const f = await fixture(t, 'legacy');
    const intended = { ...SOURCE, world_info_settings: { world_info: { ...SOURCE.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: ['Archive  Ledger'] }] } } };
    const sibling = { ...SOURCE, retained: { settings: ['independent writer'] } };
    let writing, siblingWriting, created;
    const result = await f.worlds.delete(f.h.handle, NAME, { expectedVersion: f.selected.version, beforeDelete: async resolveName => {
        assert.equal(await resolveName('Archive  Ledger'), NAME);
        fs.writeFileSync(path.join(f.h.dirs.worlds, CANONICAL), canonicalBytes, { flag: 'wx' });
        created = worldFilenameState(f.h.dirs.worlds);
        writing = f.settings.save(f.h.handle, intended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
        siblingWriting = f.settings.save(f.h.handle, sibling).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
    } });
    const writer = await writing, siblingWriter = await siblingWriting;
    const actual = await f.snapshot();
    assert.equal(result, true);
    assert.deepEqual(writer, { saved: false, code: 'world_deleted', details: { name: NAME } });
    assert.deepEqual(siblingWriter, { saved: true });
    assert.deepEqual(actual, { ...f.before, settings: sibling, physical: { enumeration: [CANONICAL, KEEP], files: { [CANONICAL]: created.files[CANONICAL], [KEEP]: f.before.physical.files[KEEP] } } });
    await f.settings.save(f.h.handle, intended);
    const recovered = await f.snapshot();
    assert.deepEqual(recovered, { ...actual, settings: intended });
});

test('coexisting receipts distinguish the deleted locator from a retained same-stem alias', async t => {
    const f = await fixture(t);
    const alias = 'Archive  Ledger';
    const selected = await f.selection(alias);
    const targetSource = { ...SOURCE, world_info_settings: { world_info: { ...SOURCE.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: [alias] }] } } };
    const retainedSource = { ...SOURCE, world_info_settings: { world_info: { ...SOURCE.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: [NAME] }] } } };
    let targetWriting, retainedWriting;
    const result = await f.worlds.delete(f.h.handle, alias, { expectedVersion: selected.version, beforeDelete: async resolveName => {
        assert.equal(await resolveName(NAME), NAME);
        assert.equal(await resolveName(alias), NAME);
        targetWriting = f.settings.save(f.h.handle, targetSource).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
        retainedWriting = f.settings.save(f.h.handle, retainedSource).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
    } }).then(deleted => ({ deleted }), error => ({ code: error.code, name: error.name, details: error.details }));
    const targetWriter = await targetWriting, retainedWriter = await retainedWriting;
    const actual = await f.snapshot();
    assert.deepEqual(selected, { doc: LEGACY_DOC, version: f.before.physical.files[LEGACY].version, name: NAME, capturedName: NAME });
    assert.deepEqual(result, { deleted: true });
    assert.deepEqual(targetWriter, { saved: false, code: 'world_deleted', details: { name: NAME } });
    assert.deepEqual(retainedWriter, { saved: true });
    assert.deepEqual(actual, { ...f.before, settings: retainedSource, physical: { enumeration: [CANONICAL, KEEP], files: { [CANONICAL]: f.before.physical.files[CANONICAL], [KEEP]: f.before.physical.files[KEEP] } } });
});

test('inspection failure reports unknown without replacing the binding conflict or retained data', async t => {
    const f = await fixture(t);
    const source = structuredClone(SOURCE);
    source.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [NAME] }];
    const release = await atSettingsRead(t, f, 'obstruct-inspection', source);
    const result = await f.request({ name: NAME, onlyIfUnbound: true });
    const native = await release();
    const actual = await f.snapshot(native.retainedDirectory);
    assert.equal(native.nativeFifo, true);
    assert.deepEqual(result, { status: 409, body: { code: 'world_in_use', details: { name: NAME, reference: 'auxiliary' }, resourceState: 'unknown' } });
    assert.deepEqual(actual, { ...f.before, settings: source });
});

const ALIAS = 'Archive  Ledger';

for (const adoption of ['auxiliary', 'primary']) {
    for (const versioned of [false, true]) {
        for (const direction of [
            { label: 'delete-canonical-while-legacy-adopted', adoptedRef: ALIAS, deleteRef: NAME, removedFile: CANONICAL, retainedFile: LEGACY, retainedDoc: LEGACY_DOC },
            { label: 'delete-legacy-while-canonical-adopted', adoptedRef: NAME, deleteRef: ALIAS, removedFile: LEGACY, retainedFile: CANONICAL, retainedDoc: CANONICAL_DOC },
        ]) {
            test(`cross-locator persisted ${adoption} adoption allows ${versioned ? 'versioned' : 'standalone'} deletion of unadopted sibling (${direction.label})`, async t => {
                const f = await fixture(t);
                const source = structuredClone(SOURCE);
                if (adoption === 'auxiliary') {
                    source.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [direction.adoptedRef] }];
                } else {
                    seedReferenceCard(f.h, 'keeper.png', direction.adoptedRef);
                }
                await f.settings.save(f.h.handle, source);
                const before = await f.snapshot();
                const targetSelection = await f.selection(direction.deleteRef);
                const adoptedSelection = await f.selection(direction.adoptedRef);
                assert.equal(targetSelection.version, before.physical.files[direction.removedFile].version);
                assert.equal(adoptedSelection.version, before.physical.files[direction.retainedFile].version);
                assert.equal(targetSelection.name, NAME);
                assert.equal(adoptedSelection.name, NAME);

                const request = {
                    name: direction.deleteRef,
                    onlyIfUnbound: true,
                    ...(versioned ? { expectedVersion: targetSelection.version } : {}),
                };
                const result = await f.request(request);
                const actual = await f.snapshot();

                assert.deepEqual(result, { status: 200, body: 'OK' });
                assert.deepEqual(actual, {
                    ...before,
                    physical: {
                        enumeration: [direction.retainedFile, KEEP],
                        files: {
                            [direction.retainedFile]: before.physical.files[direction.retainedFile],
                            [KEEP]: before.physical.files[KEEP],
                        },
                    },
                });
                assert.deepEqual(await f.worlds.get(f.h.handle, NAME), direction.retainedDoc);
            });
        }
    }

    test(`same-locator alias ${adoption} adoption still refuses deletion on legacy and coexisting targets`, async t => {
        // Legacy-only: exact reference adopts LEGACY, alias deletion targets same LEGACY locator -> must refuse.
        const legacyOnly = await fixture(t, 'legacy');
        const legacySource = structuredClone(SOURCE);
        if (adoption === 'auxiliary') {
            legacySource.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [NAME] }];
        } else {
            seedReferenceCard(legacyOnly.h, 'keeper.png', NAME);
        }
        await legacyOnly.settings.save(legacyOnly.h.handle, legacySource);
        const legacyBefore = await legacyOnly.snapshot();
        const legacyResult = await legacyOnly.request({ name: ALIAS, onlyIfUnbound: true });
        assert.deepEqual(legacyResult, {
            status: 409,
            body: {
                code: 'world_in_use',
                details: adoption === 'auxiliary' ? { name: ALIAS, reference: 'auxiliary' } : { name: ALIAS, avatar: 'keeper.png' },
                resourceState: 'present',
            },
        });
        assert.deepEqual(await legacyOnly.snapshot(), legacyBefore);

        // Coexisting: alias reference adopts LEGACY, alias deletion targets same LEGACY locator -> must refuse.
        const coexisting = await fixture(t, 'both');
        const coexistingSource = structuredClone(SOURCE);
        if (adoption === 'auxiliary') {
            coexistingSource.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [ALIAS] }];
        } else {
            seedReferenceCard(coexisting.h, 'keeper.png', ALIAS);
        }
        await coexisting.settings.save(coexisting.h.handle, coexistingSource);
        const coexistingBefore = await coexisting.snapshot();
        const coexistingResult = await coexisting.request({ name: ALIAS, onlyIfUnbound: true });
        assert.deepEqual(coexistingResult, {
            status: 409,
            body: {
                code: 'world_in_use',
                details: adoption === 'auxiliary' ? { name: ALIAS, reference: 'auxiliary' } : { name: ALIAS, avatar: 'keeper.png' },
                resourceState: 'present',
            },
        });
        assert.deepEqual(await coexisting.snapshot(), coexistingBefore);
    });
}

test('WorldInfoRepo.captureIdentity preserves semantic string return while distinguishing locators in assertWorldNotBound', async t => {
    const f = await fixture(t);
    seedReferenceCard(f.h, 'keeper.png', ALIAS);
    const resolveName = await f.worlds.captureIdentity(f.h.handle);
    assert.equal(await resolveName(NAME), NAME);
    assert.equal(await resolveName(ALIAS), NAME);
    const currentSettings = await f.settings.get(f.h.handle);
    await assert.doesNotReject(() => assertWorldNotBound(f.h.dirs.characters, NAME, 'other.png', currentSettings, resolveName));
    await assert.rejects(
        () => assertWorldNotBound(f.h.dirs.characters, ALIAS, 'other.png', currentSettings, resolveName),
        { code: 'world_in_use', details: { name: ALIAS, avatar: 'keeper.png' } },
    );
});
