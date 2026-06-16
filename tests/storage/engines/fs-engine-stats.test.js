import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine stats handler', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    test('put writes compact JSON (no pretty indent)', async () => {
        // stats writes are sized for the periodic flush — keep compact like legacy.
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'stats', handle: h.handle }, { doc: { a: 1, b: { c: 2 } } }));
        const fp = path.join(h.dataRoot, h.handle, 'stats.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toBe('{"a":1,"b":{"c":2}}');
    });

    test('get returns null when stats.json absent', async () => {
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'stats', handle: h.handle }));
        expect(got).toBeNull();
    });

    test('delete returns false when missing, true when present', async () => {
        const missing = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'stats', handle: h.handle }));
        expect(missing).toBe(false);
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'stats', handle: h.handle }, { doc: {} }));
        const present = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'stats', handle: h.handle }));
        expect(present).toBe(true);
    });

    test('list throws (stats is a singleton)', async () => {
        await expect(h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'stats', handle: h.handle })))
            .rejects.toThrow(/list/);
    });

    test('get returns null when stats.json is corrupt (FS-only contract)', async () => {
        // Repo-level test moved here: writing raw bytes to a path is meaningful only on
        // FsEngine. The same tolerance contract is upheld by SqliteEngine (it returns null
        // on JSON.parse failure when reading a corrupt blob), but there's no equivalent way
        // to *induce* the corruption without bypassing the engine.
        fs.writeFileSync(path.join(h.dataRoot, h.handle, 'stats.json'), 'not json');
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'stats', handle: h.handle }));
        expect(got).toBeNull();
    });
});
