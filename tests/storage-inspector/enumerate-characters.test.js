import { makeFixtureUser } from './_fixture-helper.js';
import {
    enumerateCategory,
    enumerateCharacterDetail,
    StorageInspectorError,
} from '../../src/storage/inspector.js';

describe('enumerateCategory("characters") · L2', () => {
    test('empty fixture returns []', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await enumerateCategory(userRoot, 'characters');
            expect(res.entries).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('rich fixture returns 2 chars sorted by size desc', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            const res = await enumerateCategory(userRoot, 'characters');
            expect(res.entries).toHaveLength(2);
            expect(res.entries.map(e => e.key)).toEqual(['default_Seraphina', 'default_Coding']);
            const sera = res.entries[0];
            expect(sera.kind).toBe('character-group');
            expect(sera.canDrill).toBe(true);
            // Sera 应包含: PNG 60K + 3 sprites 各 20K + 2 sidecars
            expect(sera.sizeBytes).toBeGreaterThan(60_000 + 60_000);  // > 120K
            // Coding 只有 PNG · 无 sprites/sidecar
            const coding = res.entries[1];
            expect(coding.sizeBytes).toBeLessThan(50_000);  // 40K PNG + overhead
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateCharacterDetail · L3 叶子', () => {
    test('splits into card + sprites-summary + per-sidecar rows', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            const res = await enumerateCharacterDetail(userRoot, 'default_Seraphina');
            expect(res.isLeaf).toBe(true);
            expect(res.path).toEqual(['characters', 'default_Seraphina']);
            const kinds = res.entries.map(e => e.kind).sort();
            expect(kinds).toEqual(expect.arrayContaining(['character-card', 'character-sprites', 'character-sidecar', 'character-sidecar']));

            const card = res.entries.find(e => e.kind === 'character-card');
            const sprites = res.entries.find(e => e.kind === 'character-sprites');
            expect(card.label).toBe('default_Seraphina.png');
            expect(card.canDrill).toBe(false);
            expect(sprites.label).toMatch(/Sprites/);
            expect(sprites.childCount).toBe(3);  // happy + sad + neutral
            expect(sprites.canDrill).toBe(false); // 按 spec: 合并一行不再钻
            expect(sprites.sizeBytes).toBe(60_000);  // 3 × 20K

            const sidecars = res.entries.filter(e => e.kind === 'character-sidecar');
            const labels = sidecars.map(s => s.label).sort();
            expect(labels).toEqual(['cardapp_studio_sessions_v2', 'character_editor_assistant_iter_sessions']);
        } finally {
            await cleanup();
        }
    });

    test('char without sprites omits the sprites row', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            const res = await enumerateCharacterDetail(userRoot, 'default_Coding');
            const kinds = res.entries.map(e => e.kind);
            expect(kinds).toContain('character-card');
            expect(kinds).not.toContain('character-sprites');
            expect(kinds.filter(k => k === 'character-sidecar')).toEqual([]);
        } finally {
            await cleanup();
        }
    });

    test('unknown char throws E_INVALID_PATH', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ charactersRich: true });
        try {
            await expect(enumerateCharacterDetail(userRoot, 'bogus'))
                .rejects.toThrow(StorageInspectorError);
        } finally {
            await cleanup();
        }
    });
});
