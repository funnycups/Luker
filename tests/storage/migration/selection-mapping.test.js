import { FS_TREE_CATEGORIES, selectionToRunnerCategories } from '../../../src/storage/migration/selection-mapping.js';

describe('FS_TREE_CATEGORIES', () => {
    test('lists exactly the 6 pure fs-tree categories', () => {
        expect([...FS_TREE_CATEGORIES]).toEqual([
            'secrets',
            'characters',
            'assets',
            'extensions',
            'globalExtensions',
            'vectors',
        ]);
    });

    test('is immutable', () => {
        expect(() => { FS_TREE_CATEGORIES.push('x'); }).toThrow();
    });
});

describe('selectionToRunnerCategories', () => {
    test('all-true selection enables every runner category', () => {
        const out = selectionToRunnerCategories({
            settings: true, secrets: true, characters: true, chats: true,
            lorebooks: true, presets: true, assets: true, extensions: true,
            globalExtensions: true, vectors: true,
        });
        expect(out).toEqual({
            settings: true, presets: true, namedDocs: true,
            worlds: true, chats: true, groups: true, stats: true,
        });
    });

    test('chats:true gates chats + groups + stats together', () => {
        const out = selectionToRunnerCategories({
            chats: true,
            settings: false, secrets: false, characters: false, lorebooks: false,
            presets: false, assets: false, extensions: false, globalExtensions: false,
            vectors: false,
        });
        expect(out.chats).toBe(true);
        expect(out.groups).toBe(true);
        expect(out.stats).toBe(true);
        // Other runner categories stay off
        expect(out.settings).toBe(false);
        expect(out.presets).toBe(false);
        expect(out.namedDocs).toBe(false);
        expect(out.worlds).toBe(false);
    });

    test('presets:true gates presets + namedDocs together', () => {
        const out = selectionToRunnerCategories({
            presets: true,
            settings: false, secrets: false, characters: false, chats: false,
            lorebooks: false, assets: false, extensions: false, globalExtensions: false,
            vectors: false,
        });
        expect(out.presets).toBe(true);
        expect(out.namedDocs).toBe(true);
        // Other runner categories stay off
        expect(out.chats).toBe(false);
        expect(out.groups).toBe(false);
        expect(out.stats).toBe(false);
        expect(out.worlds).toBe(false);
    });

    test('lorebooks:true maps to worlds:true only', () => {
        const out = selectionToRunnerCategories({
            lorebooks: true,
            settings: false, secrets: false, characters: false, chats: false,
            presets: false, assets: false, extensions: false, globalExtensions: false,
            vectors: false,
        });
        expect(out.worlds).toBe(true);
        expect(out.settings).toBe(false);
        expect(out.presets).toBe(false);
        expect(out.namedDocs).toBe(false);
        expect(out.chats).toBe(false);
    });

    test('null / undefined / empty selection produces all-false', () => {
        const allFalse = {
            settings: false, presets: false, namedDocs: false,
            worlds: false, chats: false, groups: false, stats: false,
        };
        expect(selectionToRunnerCategories(null)).toEqual(allFalse);
        expect(selectionToRunnerCategories(undefined)).toEqual(allFalse);
        expect(selectionToRunnerCategories({})).toEqual(allFalse);
    });

    test('fs-tree-only selection (no engine categories) produces all-false', () => {
        const out = selectionToRunnerCategories({
            secrets: true, characters: true, assets: true,
            extensions: true, globalExtensions: true, vectors: true,
        });
        expect(out).toEqual({
            settings: false, presets: false, namedDocs: false,
            worlds: false, chats: false, groups: false, stats: false,
        });
    });
});
