import fs from 'node:fs';
import path from 'node:path';
import { makeTempFsEngine } from '../harness/fs-harness.js';

describe('FsEngine named-doc handler', () => {
    let h;
    beforeEach(async () => {
        h = await makeTempFsEngine();
        for (const dir of [h.dirs.themes, h.dirs.movingUI, h.dirs.quickreplies]) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
    afterEach(() => h.cleanup());

    test('put writes pretty-printed JSON', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Dark' }, { doc: { bg: '#000' } }));
        const fp = path.join(h.dirs.themes, 'Dark.json');
        const raw = fs.readFileSync(fp, 'utf-8');
        expect(raw).toContain('\n    "bg"');
    });

    test('put writes to bucket-correct folder', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'quickReplies', name: 'Greet' }, { doc: {} }));
        expect(fs.existsSync(path.join(h.dirs.quickreplies, 'Greet.json'))).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.themes, 'Greet.json'))).toBe(false);
    });

    test('delete returns boolean', async () => {
        const missing = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Nope' }));
        expect(missing).toBe(false);
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'X' }, { doc: {} }));
        const present = await h.engine.withTransaction(h.handle, (tx) =>
            tx.deleteResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'X' }));
        expect(present).toBe(true);
    });

    test('get round-trips the doc, returns null when missing', async () => {
        await h.engine.withTransaction(h.handle, (tx) =>
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'X' }, { doc: { a: 1, b: [1, 2] } }));
        const got = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'X' }));
        expect(got).toEqual({ a: 1, b: [1, 2] });

        const missing = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Nope' }));
        expect(missing).toBeNull();
    });

    test.each(['themes', 'movingUI', 'quickReplies'])('reads exact legacy names listed in %s without trim collisions', async (bucket) => {
        const dir = h.dirs[bucket === 'quickReplies' ? 'quickreplies' : bucket];
        const names = [' Sample', 'Sample', 'Sample ', ' Sample ', '   '];
        for (const name of names) {
            fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name }));
        }
        const listed = await h.engine.withTransaction(h.handle, tx =>
            tx.listResources({ kind: 'named-doc', handle: h.handle, bucket }));
        expect(listed.map(entry => entry.key.name)).toEqual(expect.arrayContaining(names));
        expect(listed).toHaveLength(names.length);
        for (const name of names) {
            const doc = await h.engine.withTransaction(h.handle, tx =>
                tx.getResource({ kind: 'named-doc', handle: h.handle, bucket, name }));
            expect(doc).toEqual({ name });
        }
    });

    test.each([' Sample', 'Sample ', ' Sample '])('deletes legacy name "%s" without removing its trimmed sibling', async (name) => {
        fs.writeFileSync(path.join(h.dirs.themes, 'Sample.json'), '{"canonical":true}');
        const legacyPath = path.join(h.dirs.themes, `${name}.json`);
        fs.writeFileSync(legacyPath, '{}');
        const removed = await h.engine.withTransaction(h.handle, tx =>
            tx.deleteResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name }));
        expect(removed).toBe(true);
        expect(fs.existsSync(legacyPath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(h.dirs.themes, 'Sample.json'), 'utf8'))).toEqual({ canonical: true });
    });

    test.each(['../Sample', '/Sample', 'nested/Sample', 'nested\\Sample', 'Sample\0'])('rejects unsafe read/delete name %j without aliasing a stored document', async (name) => {
        fs.writeFileSync(path.join(h.dirs.themes, 'Sample.json'), '{}');
        fs.writeFileSync(path.join(h.dirs.root, 'Sample.json'), '{}');
        const key = { kind: 'named-doc', handle: h.handle, bucket: 'themes', name };
        await expect(h.engine.withTransaction(h.handle, tx => tx.getResource(key))).rejects.toThrow();
        await expect(h.engine.withTransaction(h.handle, tx => tx.deleteResource(key))).rejects.toThrow();
        expect(fs.existsSync(path.join(h.dirs.themes, 'Sample.json'))).toBe(true);
        expect(fs.existsSync(path.join(h.dirs.root, 'Sample.json'))).toBe(true);
    });

    test('put continues to normalize surrounding whitespace', async () => {
        await h.engine.withTransaction(h.handle, tx =>
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: ' Sample ' }, { doc: { saved: true } }));
        expect(JSON.parse(fs.readFileSync(path.join(h.dirs.themes, 'Sample.json'), 'utf8'))).toEqual({ saved: true });
        expect(fs.existsSync(path.join(h.dirs.themes, ' Sample .json'))).toBe(false);
    });

    test('list returns names sorted ascending, scoped to bucket', async () => {
        await h.engine.withTransaction(h.handle, (tx) => {
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Charlie' }, { doc: {} });
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Alpha' }, { doc: {} });
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 'Bravo' }, { doc: {} });
            tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'movingUI', name: 'X' }, { doc: {} });
        });
        const themes = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'named-doc', handle: h.handle, bucket: 'themes' }));
        expect(themes.map((e) => e.key.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
        const moving = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'named-doc', handle: h.handle, bucket: 'movingUI' }));
        expect(moving.map((e) => e.key.name)).toEqual(['X']);
    });

    test('list returns empty for an unpopulated bucket', async () => {
        const out = await h.engine.withTransaction(h.handle, (tx) =>
            tx.listResources({ kind: 'named-doc', handle: h.handle, bucket: 'quickReplies' }));
        expect(out).toEqual([]);
    });
});
