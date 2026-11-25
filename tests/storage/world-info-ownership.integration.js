import { test as nativeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { sync as writeFileAtomic } from 'write-file-atomic';
import { makeTempFsEngineHarness, makeTempSqliteEngineHarness } from './harness/contract-harness.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { ConflictError } from '../../src/storage/errors.js';
import { assertValidSqliteFile } from '../../src/storage/engines/sqlite-engine.js';
import { getFileVersion } from '../../src/storage/file-version.js';
import { assertWorldNotBound } from '../../src/character-world-ownership.js';
import { write } from '../../src/character-card-parser.js';
import { createRun } from '../harness/resources/run.js';

const run = await createRun({ projectRoot: path.resolve(import.meta.dirname, '../..'), profile: 'storage-local', command: [process.execPath, ...process.argv.slice(1)], source: import.meta.filename });
const scope = await run.scope({ kind: 'case', label: 'world ownership integration' });
let failed = false;
const test = (name, callback) => nativeTest(name, async context => {
    try { await callback(context); }
    catch (error) { failed = true; run.recordError(error); throw error; }
});
after(async () => { await scope.dispose(); await run.finish({ status: failed ? 'failed' : 'passed' }); });

// Standalone real local-engine integration checks. This command does not
// replace the required all-engine repository suite or its database teardown.
for (const make of [makeTempFsEngineHarness, makeTempSqliteEngineHarness]) {
    for (const change of ['untouched', 'save', 'patch', 'recreate', 'adopt']) {
        test(`${make.name}: conditional cleanup after ${change}`, async t => {
            const h = await make({ scope }); t.after(() => h.cleanup());
            const repo = new WorldInfoRepo({ engine: h.engine });
            const original = { entries: { '7': { content: 'Original' } }, extensions: { retained: ['sibling'] } };
            const version = await repo.save(h.handle, 'Owned', original);
            assert.equal(typeof version, 'string'); assert.equal(await repo.getVersion(h.handle, 'Owned'), version);
            const expected = structuredClone(original);
            if (change === 'save') await repo.save(h.handle, 'Owned', original);
            if (change === 'patch') {
                expected.entries['7'].content = 'External edit';
                await repo.patch(h.handle, 'Owned', [{ op: 'replace', path: '/entries/7/content', value: 'External edit' }]);
            }
            if (change === 'recreate') { await repo.delete(h.handle, 'Owned'); await repo.save(h.handle, 'Owned', original); }
            const beforeDelete = change === 'adopt' ? () => { throw new ConflictError('world_in_use'); } : undefined;
            if (change === 'untouched') {
                assert.equal(await repo.delete(h.handle, 'Owned', { expectedVersion: version }), true);
                assert.equal(await repo.get(h.handle, 'Owned'), null);
            } else {
                await assert.rejects(repo.delete(h.handle, 'Owned', { expectedVersion: version, beforeDelete }), ConflictError);
                assert.deepEqual(await repo.get(h.handle, 'Owned'), expected);
            }
        });
    }
}

test('filesystem ownership expires on external same-content file replacement', async t => {
    const h = await makeTempFsEngineHarness({ scope }); t.after(() => h.cleanup());
    const repo = new WorldInfoRepo({ engine: h.engine });
    const original = { entries: {}, extensions: { retained: true } };
    const version = await repo.save(h.handle, 'Owned', original);
    writeFileAtomic(path.join(h.dirs.worlds, 'Owned.json'), JSON.stringify(original, null, 4));
    await assert.rejects(repo.delete(h.handle, 'Owned', { expectedVersion: version }), { code: 'world_changed' });
    assert.deepEqual(await repo.get(h.handle, 'Owned'), original);
});

test('persisted adoption and character file identity are independent of a world name', async t => {
    const h = await makeTempFsEngineHarness({ scope }); t.after(() => h.cleanup());
    const repo = new WorldInfoRepo({ engine: h.engine }); await repo.save(h.handle, 'Owned', { entries: {} });
    const resolveName = await repo.captureIdentity(h.handle);
    const image = fs.readFileSync(new URL('../../public/img/ai4.png', import.meta.url));
    const file = path.join(h.dirs.characters, 'original.png');
    const data = { data: { extensions: { world: 'Owned', retained: { source: true } } } };
    const bytes = write(image, JSON.stringify(data)); fs.writeFileSync(file, bytes);
    const version = getFileVersion(file);
    await assert.doesNotReject(assertWorldNotBound(h.dirs.characters, 'Owned', 'original.png', undefined, resolveName));
    writeFileAtomic(file, bytes);
    assert.notEqual(getFileVersion(file), version);
    fs.writeFileSync(path.join(h.dirs.characters, 'adopter.png'), bytes);
    await assert.rejects(assertWorldNotBound(h.dirs.characters, 'Owned', 'original.png', undefined, resolveName), { code: 'world_in_use', details: { name: 'Owned', avatar: 'adopter.png' } });
});

for (const version of [0, 1]) {
    test(`legacy SQLite schema ${version} validates and restores without losing book data`, async t => {
        const h = await makeTempSqliteEngineHarness({ scope }); t.after(() => h.cleanup());
        const oldFile = path.join(h.dataRoot, 'legacy.sqlite');
        const db = new Database(oldFile);
        const original = { entries: { '7': { content: 'Legacy' } }, extensions: { retained: ['sibling'] } };
        try {
            db.exec(fs.readFileSync(new URL('../../src/storage/engines/migrations/sqlite/0001-initial.sql', import.meta.url), 'utf8'));
            db.pragma(`user_version = ${version}`);
            db.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)').run('source', 'Owned', JSON.stringify(original), 100);
        } finally { db.close(); }
        await assertValidSqliteFile(oldFile);
        await h.engine.restoreUser(h.handle, Readable.from(fs.readFileSync(oldFile)));
        const repo = new WorldInfoRepo({ engine: h.engine });
        assert.deepEqual(await repo.get(h.handle, 'Owned'), original);
        assert.equal(await repo.getVersion(h.handle, 'Owned'), null);
        const next = await repo.save(h.handle, 'Owned', original);
        assert.equal(typeof next, 'string');
        assert.equal(await repo.delete(h.handle, 'Owned', { expectedVersion: next }), true);
    });
}
