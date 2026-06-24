import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNC_CATEGORIES, getCategoryById, resolveCategoryPaths } from '../../src/sync/categories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('SYNC_CATEGORIES registry', () => {
    test('is a non-empty array of distinct ids', () => {
        expect(Array.isArray(SYNC_CATEGORIES)).toBe(true);
        expect(SYNC_CATEGORIES.length).toBeGreaterThan(5);
        const ids = SYNC_CATEGORIES.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every entry has the required shape', () => {
        for (const cat of SYNC_CATEGORIES) {
            expect(typeof cat.id).toBe('string');
            expect(typeof cat.displayKey).toBe('string');
            expect(typeof cat.descriptionKey).toBe('string');
            expect(Array.isArray(cat.paths)).toBe(true);
            expect(cat.paths.length).toBeGreaterThan(0);
            expect(['file', 'none']).toContain(cat.conflictMode);
            expect(['on', 'opt-in', 'never']).toContain(cat.syncDefault);
            expect(Array.isArray(cat.warnings)).toBe(true);
        }
    });

    test('getCategoryById finds a known category and returns null for unknown', () => {
        expect(getCategoryById('characters')).toBeTruthy();
        expect(getCategoryById('characters').id).toBe('characters');
        expect(getCategoryById('does-not-exist')).toBeNull();
    });

    test('resolveCategoryPaths returns absolute paths that stay within the user root', () => {
        // Fake UserDirectoryList covering every field any category resolver
        // touches. Mirrors the runtime template in src/constants.js
        // USER_DIRECTORY_TEMPLATE: each field is the live data directory for
        // one logical area. The test does not exercise the filesystem; only
        // path arithmetic.
        const fakeDirs = {
            root: '/tmp/fake-user',
            characters: '/tmp/fake-user/characters',
            chats: '/tmp/fake-user/chats',
            groups: '/tmp/fake-user/groups',
            groupChats: '/tmp/fake-user/group chats',
            worlds: '/tmp/fake-user/worlds',
            cardApps: '/tmp/fake-user/card-apps',
            openAI_Settings: '/tmp/fake-user/OpenAI Settings',
            novelAI_Settings: '/tmp/fake-user/NovelAI Settings',
            koboldAI_Settings: '/tmp/fake-user/KoboldAI Settings',
            textGen_Settings: '/tmp/fake-user/TextGen Settings',
            instruct: '/tmp/fake-user/instruct',
            context: '/tmp/fake-user/context',
            sysprompt: '/tmp/fake-user/sysprompt',
            reasoning: '/tmp/fake-user/reasoning',
            themes: '/tmp/fake-user/themes',
            movingUI: '/tmp/fake-user/movingUI',
            quickreplies: '/tmp/fake-user/QuickReplies',
            assets: '/tmp/fake-user/assets',
            backgrounds: '/tmp/fake-user/backgrounds',
            avatars: '/tmp/fake-user/User Avatars',
            files: '/tmp/fake-user/user/files',
            userImages: '/tmp/fake-user/user/images',
            comfyWorkflows: '/tmp/fake-user/user/workflows',
            vectors: '/tmp/fake-user/vectors',
            extensions: '/tmp/fake-user/extensions',
        };
        const chats = getCategoryById('chats');
        const resolved = resolveCategoryPaths(chats, fakeDirs);
        for (const p of resolved) {
            expect(p.absolutePath.startsWith(fakeDirs.root + path.sep)).toBe(true);
        }

        // Sanity: confined-to-root property must hold for every category, not
        // just chats. A typo in any resolver would let a path escape root and
        // sync would happily ship files outside the user's data dir.
        for (const cat of SYNC_CATEGORIES) {
            const allResolved = resolveCategoryPaths(cat, fakeDirs);
            for (const p of allResolved) {
                expect(typeof p.absolutePath).toBe('string');
                expect(['file', 'directory']).toContain(p.kind);
                const startsAtRoot = p.absolutePath === fakeDirs.root
                    || p.absolutePath.startsWith(fakeDirs.root + path.sep);
                expect(startsAtRoot).toBe(true);
            }
        }
    });

    test('resolveCategoryPaths throws when a resolver returns a non-string', () => {
        const fakeDirs = { root: '/tmp/fake-user', chats: '/tmp/fake-user/chats' };
        const bogus = {
            id: 'bogus',
            displayKey: 'sync.category.bogus',
            descriptionKey: 'sync.category.bogus.desc',
            paths: [
                // resolver returns undefined (simulated typo: directories.chatz)
                { kind: 'directory', from: directories => directories.chatz },
            ],
            conflictMode: 'file',
            syncDefault: 'on',
            warnings: [],
        };
        expect(() => resolveCategoryPaths(bogus, fakeDirs)).toThrow();
    });

    test('every i18n key listed in the registry exists in zh-CN and zh-TW', () => {
        // Project i18n is flat JSON, keyed by either an English source string
        // OR an explicit dotted namespace key like `var_ops_panel.label.op`.
        // There is no en.json — translate() in public/scripts/i18n.js falls
        // back to the key itself when the locale lookup misses, so the English
        // "value" of every key is implicitly the key when it reads as English,
        // or — in our case — the descriptive English label the registry
        // declares via its `enFallback` field. We still verify the localized
        // entries exist in zh-CN and zh-TW exactly.
        const locales = ['zh-cn', 'zh-tw'];
        const localeData = {};
        for (const locale of locales) {
            const filePath = path.resolve(__dirname, '../../public/locales', `${locale}.json`);
            if (!fs.existsSync(filePath)) {
                throw new Error(`i18n file missing: ${filePath}`);
            }
            localeData[locale] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        const allKeys = new Set();
        for (const cat of SYNC_CATEGORIES) {
            allKeys.add(cat.displayKey);
            allKeys.add(cat.descriptionKey);
            for (const w of cat.warnings) allKeys.add(w);
        }
        for (const key of allKeys) {
            for (const locale of locales) {
                // Flat lookup — this project's locale files store dotted keys
                // as literal flat-string keys, not as nested objects. See
                // existing var_ops_panel.* keys in public/locales/zh-cn.json.
                const value = localeData[locale][key];
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
        }
    });
});
