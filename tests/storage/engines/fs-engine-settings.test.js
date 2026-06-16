import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine settings handler', () => {
    let h;
    beforeEach(async () => { h = await makeTempFsEngine(); });
    afterEach(() => h.cleanup());

    test('round-trip via tx writes settings.json verbatim', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { x: 1, y: 'hi' } }));
        const fp = path.join(h.dataRoot, h.handle, 'settings.json');
        expect(JSON.parse(fs.readFileSync(fp, 'utf-8'))).toEqual({ x: 1, y: 'hi' });
    });

    test('writes pretty-printed JSON with 4-space indent (legacy compat)', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { a: 1 } }));
        const fp = path.join(h.dataRoot, h.handle, 'settings.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toContain('\n    "a"');
    });

    test('get returns null when settings.json absent', async () => {
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'settings', handle: h.handle }));
        expect(got).toBeNull();
    });

    test('put does not leave .tmp stragglers in user dir', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { x: 1 } }));
        const dir = path.join(h.dataRoot, h.handle);
        const stragglers = fs.readdirSync(dir).filter((e) => e.endsWith('.tmp'));
        expect(stragglers).toEqual([]);
    });

    test('delete removes settings.json', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { x: 1 } }));
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'settings', handle: h.handle }));
        const fp = path.join(h.dataRoot, h.handle, 'settings.json');
        expect(fs.existsSync(fp)).toBe(false);
    });

    test('list throws on settings kind (singleton)', async () => {
        await expect(h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'settings', handle: h.handle })))
            .rejects.toThrow(/list/);
    });
});
