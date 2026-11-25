import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../storage/harness/endpoint-harness.js';
import { router as themesRouter } from '../../src/endpoints/themes.js';
import { router as settingsRouter } from '../../src/endpoints/settings.js';
import { getNamedDocRepo, getSettingsRepo } from '../../src/storage/index.js';
import {
    getBuiltinTheme,
    getBuiltinThemeStylesheetText,
    isBuiltinThemeName,
    listBuiltinThemeNames,
} from '../../src/themes/builtin-themes.js';
import {
    ensureLegacyThemesMigrated,
    invalidateLegacyThemeMigration,
} from '../../src/themes/theme-migration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const LENS_CSS = fs.readFileSync(path.join(REPO_ROOT, 'public/css/themes/lens.css'), 'utf8');

function createFakeDocument() {
    const children = [];
    const byId = new Map();
    const head = {
        get children() {
            return children;
        },
        appendChild(el) {
            const idx = children.indexOf(el);
            if (idx !== -1) children.splice(idx, 1);
            children.push(el);
            if (el.id) byId.set(el.id, el);
            return el;
        },
        insertBefore(el, ref) {
            const existingIdx = children.indexOf(el);
            if (existingIdx !== -1) children.splice(existingIdx, 1);
            const refIdx = children.indexOf(ref);
            if (refIdx === -1) {
                children.push(el);
            } else {
                children.splice(refIdx, 0, el);
            }
            if (el.id) byId.set(el.id, el);
            return el;
        },
    };

    return {
        head,
        getElementById(id) {
            return byId.get(id) ?? null;
        },
        createElement(tag) {
            const attrs = new Map();
            const listeners = new Map();
            const el = {
                tagName: tag.toUpperCase(),
                textContent: '',
                get id() { return attrs.get('id') || ''; },
                get nextSibling() {
                    const idx = children.indexOf(el);
                    return idx !== -1 && idx + 1 < children.length ? children[idx + 1] : null;
                },
                setAttribute(k, v) {
                    attrs.set(k, String(v));
                    if (k === 'id' && children.includes(el)) {
                        byId.set(String(v), el);
                    }
                },
                getAttribute(k) {
                    return attrs.get(k) ?? null;
                },
                addEventListener(type, fn) {
                    if (!listeners.has(type)) listeners.set(type, []);
                    listeners.get(type).push(fn);
                },
                dispatchEvent(type) {
                    for (const fn of listeners.get(type) || []) fn();
                },
                remove() {
                    const idx = children.indexOf(el);
                    if (idx !== -1) children.splice(idx, 1);
                    if (el.id && byId.get(el.id) === el) byId.delete(el.id);
                },
            };
            return el;
        },
    };
}

describe.each(ENDPOINT_HARNESSES)('Theme API built-in hosting, patch, and legacy migration on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/themes', themesRouter);
                app.use('/api/settings', settingsRouter);
            },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('serves built-in themes read-only, rejects overwrite/patch/delete, and supports user /patch', async () => {
        expect(isBuiltinThemeName('Lens')).toBe(true);
        expect(listBuiltinThemeNames()).toEqual(expect.arrayContaining(['Azure', 'Dark Lite', 'Lens']));
        expect(getBuiltinThemeStylesheetText(getBuiltinTheme('Lens'))).toBe(LENS_CSS);

        // Built-in theme list is served without anything seeded in NamedDocRepo
        const listRes = await request(harness.server)
            .get('/api/themes/list')
            .query({ account: harness.handle })
            .expect(200);
        expect(listRes.body.builtin).toEqual(listBuiltinThemeNames());
        expect(listRes.body.names).toEqual(listBuiltinThemeNames());

        // Built-in theme rejects save, patch, and delete with 403
        await request(harness.server)
            .post('/api/themes/save')
            .send({ name: 'Lens', custom_css: 'body{}' })
            .expect(403)
            .expect(({ body }) => expect(body.code).toBe('builtin_theme_readonly'));
        await request(harness.server)
            .post('/api/themes/patch')
            .send({ name: 'Dark Lite', patch: { custom_css: 'body{}' } })
            .expect(403)
            .expect(({ body }) => expect(body.code).toBe('builtin_theme_readonly'));
        await request(harness.server)
            .post('/api/themes/delete')
            .send({ name: 'Lens' })
            .expect(403)
            .expect(({ body }) => expect(body.code).toBe('builtin_theme_readonly'));

        // User theme strips internal built-in metadata on save and supports /patch
        await request(harness.server)
            .post('/api/themes/save')
            .send({
                name: 'MyFork',
                builtin: true,
                builtin_stylesheet: 'css/themes/lens.css',
                main_text_color: '#fff',
                custom_css: 'body { color: #fff; }',
            })
            .expect(200);

        const savedDoc = await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'MyFork' })
            .expect(200);
        expect(savedDoc.body.builtin).toBeUndefined();
        expect(savedDoc.body.builtin_stylesheet).toBeUndefined();
        expect(savedDoc.body.main_text_color).toBe('#fff');

        const patchRes = await request(harness.server)
            .post('/api/themes/patch')
            .send({
                name: 'MyFork',
                patch: {
                    custom_css: 'body { color: #0f0; }',
                    builtin: true,
                    builtin_stylesheet: 'css/themes/lens.css',
                },
            })
            .expect(200);
        expect(patchRes.body.ok).toBe(true);
        expect(patchRes.body.theme.custom_css).toBe('body { color: #0f0; }');
        expect(patchRes.body.theme.main_text_color).toBe('#fff');
        expect(patchRes.body.theme.builtin).toBeUndefined();
        expect(patchRes.body.theme.builtin_stylesheet).toBeUndefined();

        const afterPatch = await request(harness.server)
            .get('/api/themes/get')
            .query({ account: harness.handle, name: 'MyFork' })
            .expect(200);
        expect(afterPatch.body.custom_css).toBe('body { color: #0f0; }');
        expect(afterPatch.body.main_text_color).toBe('#fff');
    });

    test('/api/settings/bootstrap returns lightweight summaries for unselected themes and full doc for selected theme', async () => {
        await getNamedDocRepo().save(harness.handle, 'themes', 'HeavyUnused', {
            name: 'HeavyUnused',
            custom_css: 'x'.repeat(20000),
        });
        await getNamedDocRepo().save(harness.handle, 'themes', 'ActiveCustom', {
            name: 'ActiveCustom',
            custom_css: 'body { background: black; }',
        });
        await getSettingsRepo().save(harness.handle, {
            power_user: { theme: 'ActiveCustom' },
        });

        const res = await request(harness.server)
            .post('/api/settings/bootstrap')
            .send({})
            .expect(200);

        const unused = res.body.themes.find(t => t.name === 'HeavyUnused');
        const active = res.body.themes.find(t => t.name === 'ActiveCustom');
        expect(unused).toEqual({ name: 'HeavyUnused', builtin: false, _summary: true });
        expect(unused.custom_css).toBeUndefined();
        expect(active.custom_css).toBe('body { background: black; }');
    });

    test('migration cleans up unmodified legacy Lens seed and settings custom_css while preserving Lens active', async () => {
        const builtinLens = getBuiltinTheme('Lens');
        const legacySeededLens = { ...builtinLens, custom_css: LENS_CSS };
        delete legacySeededLens.builtin;
        delete legacySeededLens.builtin_stylesheet;

        await getNamedDocRepo().save(harness.handle, 'themes', 'Lens', legacySeededLens);
        await getSettingsRepo().save(harness.handle, {
            power_user: {
                theme: 'Lens',
                custom_css: LENS_CSS,
                palettes: builtinLens.palettes,
                font_scale: 1.05,
            },
        });

        await ensureLegacyThemesMigrated(harness.handle);

        // Old seeded Lens doc is removed from user repo; built-in Lens takes over cleanly
        expect(await getNamedDocRepo().get(harness.handle, 'themes', 'Lens')).toBeNull();
        const settings = await getSettingsRepo().get(harness.handle);
        expect(settings.power_user.theme).toBe('Lens');
        expect(settings.power_user.font_scale).toBe(1.05);
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'custom_css')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'palettes')).toBe(false);
    });

    test('migration preserves user custom CSS written directly on built-in Dark Lite as an independent theme', async () => {
        const builtinDarkLite = getBuiltinTheme('Dark Lite');
        const legacySeededDarkLite = { ...builtinDarkLite };
        delete legacySeededDarkLite.builtin;
        await getNamedDocRepo().save(harness.handle, 'themes', 'Dark Lite', legacySeededDarkLite);
        await getSettingsRepo().save(harness.handle, {
            power_user: {
                theme: 'Dark Lite',
                custom_css: '#chat { border: 2px solid magenta; }',
                chat_width: 68,
            },
        });

        await ensureLegacyThemesMigrated(harness.handle);

        expect(await getNamedDocRepo().get(harness.handle, 'themes', 'Dark Lite')).toBeNull();
        const settings = await getSettingsRepo().get(harness.handle);
        expect(settings.power_user.theme).toBe('Dark Lite (Custom)');
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'custom_css')).toBe(false);

        const migratedTheme = await getNamedDocRepo().get(harness.handle, 'themes', 'Dark Lite (Custom)');
        expect(migratedTheme).not.toBeNull();
        expect(migratedTheme.custom_css).toBe('#chat { border: 2px solid magenta; }');
        expect(migratedTheme.chat_width).toBe(68);
        expect(migratedTheme.builtin).toBeUndefined();
        expect(migratedTheme.builtin_stylesheet).toBeUndefined();
    });

    test('migration preserves user-modified seeded Lens theme under a custom name without double-stacking built-in CSS', async () => {
        const builtinLens = getBuiltinTheme('Lens');
        const modifiedLensCss = `${LENS_CSS}\n/* user tweak */\n#chat { letter-spacing: 0.5px; }`;
        const modifiedLens = { ...builtinLens, custom_css: modifiedLensCss };
        delete modifiedLens.builtin;
        delete modifiedLens.builtin_stylesheet;

        await getNamedDocRepo().save(harness.handle, 'themes', 'Lens', modifiedLens);
        await getSettingsRepo().save(harness.handle, {
            power_user: {
                theme: 'Lens',
                custom_css: modifiedLensCss,
                palettes: builtinLens.palettes,
            },
        });

        await ensureLegacyThemesMigrated(harness.handle);

        expect(await getNamedDocRepo().get(harness.handle, 'themes', 'Lens')).toBeNull();
        const settings = await getSettingsRepo().get(harness.handle);
        expect(settings.power_user.theme).toBe('Lens (Custom)');
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'custom_css')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'palettes')).toBe(false);

        const preserved = await getNamedDocRepo().get(harness.handle, 'themes', 'Lens (Custom)');
        expect(preserved).not.toBeNull();
        expect(preserved.custom_css).toBe(modifiedLensCss);
        expect(preserved.builtin_stylesheet).toBeUndefined();
        expect(preserved.palettes?.default).toBe('night');
    });

    test('migration strips duplicate power_user.custom_css for external themes without creating extra copies', async () => {
        await getNamedDocRepo().save(harness.handle, 'themes', 'ExternalOne', {
            name: 'ExternalOne',
            custom_css: 'body { font-size: 17px; }',
        });
        await getSettingsRepo().save(harness.handle, {
            power_user: {
                theme: 'ExternalOne',
                custom_css: 'body { font-size: 17px; }',
            },
        });

        await ensureLegacyThemesMigrated(harness.handle);

        const settings = await getSettingsRepo().get(harness.handle);
        expect(settings.power_user.theme).toBe('ExternalOne');
        expect(Object.prototype.hasOwnProperty.call(settings.power_user, 'custom_css')).toBe(false);
        expect(await getNamedDocRepo().get(harness.handle, 'themes', 'ExternalOne (Custom)')).toBeNull();

        // Invalidation allows re-running migration if a legacy archive is restored later
        invalidateLegacyThemeMigration(harness.handle);
        await getSettingsRepo().save(harness.handle, {
            power_user: {
                theme: 'ExternalOne',
                custom_css: 'body { font-size: 19px; }',
            },
        });
        await ensureLegacyThemesMigrated(harness.handle);
        const afterRestore = await getSettingsRepo().get(harness.handle);
        expect(afterRestore.power_user.theme).toBe('ExternalOne (Custom)');
    });
});

describe('Client theme-manager proxy, lazy loading, stylesheet order, and independent derivation', () => {
    let createThemeManager;

    beforeEach(async () => {
        jest.unstable_mockModule('../../public/scripts/named-resource-read.js', () => ({
            invalidateThemeResourceReads: jest.fn(),
            readThemeDocument: jest.fn(async () => null),
        }));
        ({ createThemeManager } = await import('../../public/scripts/theme-manager.js'));
    });

    test('lazy-loads unselected themes on demand, proxies custom_css/palettes with auto Theme API writeback, and omits them from JSON', async () => {
        const fakeDoc = createFakeDocument();
        const readTheme = jest.fn(async (name) => {
            if (name === 'ExternalA') {
                return { name: 'ExternalA', custom_css: 'body { color: blue; }' };
            }
            if (name === 'Lens') {
                return { name: 'Lens', builtin: true, builtin_stylesheet: 'css/themes/lens.css', custom_css: '' };
            }
            return null;
        });
        const patchTheme = jest.fn(async () => ({ ok: true }));
        const onCustomCssApplied = jest.fn();
        const onBuiltinWriteBlocked = jest.fn();

        const manager = createThemeManager({
            readTheme,
            patchTheme,
            invalidateReads: jest.fn(),
            onCustomCssApplied,
            onBuiltinWriteBlocked,
            patchDelayMs: 20,
            getDocument: () => fakeDoc,
        });

        const powerUser = { theme: 'Lens', chat_width: 55 };
        manager.installPowerUserProxies(powerUser);

        // Hydrate from bootstrap summary payload: only active Lens doc is present
        manager.hydrateFromSettingsData({
            theme_directory: { names: ['ExternalA', 'Lens'], builtin: ['Lens'] },
            active_theme: { name: 'Lens', builtin: true, builtin_stylesheet: 'css/themes/lens.css', custom_css: '' },
            themes: [
                { name: 'ExternalA', builtin: false, _summary: true },
                { name: 'Lens', builtin: true, builtin_stylesheet: 'css/themes/lens.css', custom_css: '' },
            ],
        });
        manager.setActiveTheme(manager.getCachedTheme('Lens'));

        // Unselected theme was NOT eagerly fetched
        expect(readTheme).not.toHaveBeenCalled();
        expect(manager.getCachedTheme('ExternalA')).toBeNull();

        // Non-enumerable proxy: custom_css and palettes are NEVER serialized to settings.json
        expect(JSON.parse(JSON.stringify(powerUser))).toEqual({ theme: 'Lens', chat_width: 55 });
        expect(powerUser.custom_css).toBe('');

        // Writing to a read-only built-in theme is blocked and never hits patchTheme
        powerUser.custom_css = 'body { background: red; }';
        expect(onBuiltinWriteBlocked).toHaveBeenCalledWith('custom_css', 'Lens');
        expect(powerUser.custom_css).toBe('');
        await manager.flushPendingPatch();
        expect(patchTheme).not.toHaveBeenCalled();

        // Built-in stylesheet mounts BEFORE custom-style without version query strings
        manager.applyCustomStyleTag('');
        const mountPromise = manager.mountBuiltinStylesheet('css/themes/lens.css');
        const link = fakeDoc.getElementById('builtin-theme-style');
        const customStyle = fakeDoc.getElementById('custom-style');
        expect(link).not.toBeNull();
        expect(link.getAttribute('href')).toBe('css/themes/lens.css');
        expect(fakeDoc.head.children.indexOf(link)).toBeLessThan(fakeDoc.head.children.indexOf(customStyle));
        link.dispatchEvent('load');
        await mountPromise;

        // Switching to unselected ExternalA lazy-fetches it once
        const extDoc = await manager.ensureThemeLoaded('ExternalA');
        expect(readTheme).toHaveBeenCalledTimes(1);
        expect(readTheme).toHaveBeenCalledWith('ExternalA');
        manager.setActiveTheme(extDoc);
        await manager.mountBuiltinStylesheet('');
        expect(fakeDoc.getElementById('builtin-theme-style')).toBeNull();
        expect(powerUser.custom_css).toBe('body { color: blue; }');

        // Writing power_user.custom_css on a user theme updates memory, UI callback, and writes back via Theme API
        powerUser.custom_css = 'body { color: green; }';
        expect(powerUser.custom_css).toBe('body { color: green; }');
        expect(onCustomCssApplied).toHaveBeenCalledWith('body { color: green; }');
        expect(JSON.parse(JSON.stringify(powerUser))).toEqual({ theme: 'Lens', chat_width: 55 });

        await manager.flushPendingPatch();
        expect(patchTheme).toHaveBeenCalledTimes(1);
        expect(patchTheme).toHaveBeenCalledWith('ExternalA', { custom_css: 'body { color: green; }' });
    });

    test('deriving produces completely independent copies for both built-in and non-built-in themes', async () => {
        const fetchStylesheet = jest.fn(async (href) => `/* live ${href} */\nbody { color: cyan; }`);
        const manager = createThemeManager({
            fetchStylesheet,
            invalidateReads: jest.fn(),
        });

        const builtinLens = {
            name: 'Lens',
            builtin: true,
            builtin_stylesheet: 'css/themes/lens.css',
            custom_css: '',
            palettes: {
                default: 'night',
                items: [
                    { id: 'night', label: 'Night', title: 'Night' },
                    { id: 'mist', label: 'Mist', title: 'Mist' },
                ],
            },
        };

        const derivedFromBuiltin = await manager.buildIndependentThemeSnapshot({
            name: 'Lens (Custom)',
            baseFields: { chat_width: 60 },
            sourceTheme: builtinLens,
        });
        expect(fetchStylesheet).toHaveBeenCalledWith('css/themes/lens.css');
        expect(derivedFromBuiltin.builtin).toBeUndefined();
        expect(derivedFromBuiltin.builtin_stylesheet).toBeUndefined();
        expect(derivedFromBuiltin.custom_css).toBe('/* live css/themes/lens.css */\nbody { color: cyan; }');
        expect(derivedFromBuiltin.palettes.items).toHaveLength(2);

        // Mutating the derived copy's palettes does NOT mutate the source theme
        derivedFromBuiltin.palettes.items[0].label = 'Mutated';
        expect(builtinLens.palettes.items[0].label).toBe('Night');

        // Deriving from a non-built-in theme also produces an independent copy
        const externalTheme = {
            name: 'MyExternal',
            custom_css: 'body { margin: 4px; }',
            palettes: {
                default: 'warm',
                items: [
                    { id: 'warm', label: 'Warm', title: 'Warm' },
                    { id: 'cool', label: 'Cool', title: 'Cool' },
                ],
            },
        };
        const derivedFromExternal = await manager.buildIndependentThemeSnapshot({
            name: 'MyExternal (Copy)',
            baseFields: { chat_width: 55 },
            sourceTheme: externalTheme,
        });
        expect(derivedFromExternal.custom_css).toBe('body { margin: 4px; }');
        derivedFromExternal.custom_css = 'body { margin: 12px; }';
        derivedFromExternal.palettes.items[0].label = 'Changed';
        expect(externalTheme.custom_css).toBe('body { margin: 4px; }');
        expect(externalTheme.palettes.items[0].label).toBe('Warm');
    });
});
