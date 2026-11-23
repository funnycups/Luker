/** @jest-environment jsdom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import { afterEach, describe, expect, test } from '@jest/globals';
import { ensureStylesheet, isActiveStylesheetLink } from '../../public/scripts/lens-shared/util.js';
import { ensureWorkbenchStyles } from '../../public/scripts/workbench/app.js';
import { ensureDockStyles } from '../../public/scripts/run-panel/dock.js';
import {
    findSupersededExtension,
    getSupersededUiState,
    shouldSkipToggleAll,
} from '../../public/scripts/util/superseded-extensions.js';

describe('legacy third-party lens/workbench conflict protection', () => {
    afterEach(() => {
        document.head.innerHTML = '';
    });

    test('ensureStylesheet does not confuse third-party luker-workbench/style.css with built-in workbench/style.css', () => {
        const legacy = document.createElement('link');
        legacy.id = 'third-party_luker-workbench-css';
        legacy.rel = 'stylesheet';
        legacy.href = '/scripts/extensions/third-party/luker-workbench/style.css';
        document.head.appendChild(legacy);

        const injected = ensureStylesheet(document, 'luker-workbench-style-css', '/scripts/workbench/style.css');
        expect(injected).not.toBeNull();
        expect(injected).not.toBe(legacy);
        expect(injected.id).toBe('luker-workbench-style-css');
        expect(document.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(2);

        // Calling again with same path (even with a cache-busting query string) deduplicates cleanly.
        const second = ensureStylesheet(document, 'different-id', '/scripts/workbench/style.css?v=2');
        expect(second).toBe(injected);
        expect(document.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(2);
    });

    test('ensureStylesheet deduplicates cleanly on about:blank HTMLDocuments', () => {
        const blankDoc = document.implementation.createHTMLDocument('blank');
        const legacy = blankDoc.createElement('link');
        legacy.rel = 'stylesheet';
        legacy.href = '/scripts/extensions/third-party/luker-workbench/style.css';
        blankDoc.head.appendChild(legacy);

        const injected = ensureStylesheet(blankDoc, 'luker-workbench-style-css', '/scripts/workbench/style.css');
        expect(injected).not.toBeNull();
        expect(injected).not.toBe(legacy);

        const repeat = ensureStylesheet(blankDoc, 'other-id', '/scripts/workbench/style.css?v=99');
        expect(repeat).toBe(injected);
        expect(blankDoc.head.querySelectorAll('link[rel="stylesheet"]').length).toBe(2);
    });

    test('ensureWorkbenchStyles still injects built-in CSS when third-party luker-workbench stylesheet is present', () => {
        const legacy = document.createElement('link');
        legacy.id = 'third-party_luker-workbench-css';
        legacy.rel = 'stylesheet';
        legacy.href = '/scripts/extensions/third-party/luker-workbench/style.css';
        document.head.appendChild(legacy);

        ensureWorkbenchStyles(document);

        const tokensLink = document.getElementById('luker-lens-shared-tokens-css');
        const wbLink = document.getElementById('luker-workbench-style-css');
        expect(tokensLink).not.toBeNull();
        expect(wbLink).not.toBeNull();
        expect(wbLink.href).toMatch(/\/workbench\/style\.css$/);
        expect(wbLink.href).not.toContain('third-party');

        // Idempotent on repeat calls.
        ensureWorkbenchStyles(document);
        expect(document.head.querySelectorAll('#luker-workbench-style-css').length).toBe(1);
    });

    test('ensureDockStyles still injects built-in CSS when a third-party stylesheet shares suffix substrings', () => {
        const legacyDock = document.createElement('link');
        legacyDock.rel = 'stylesheet';
        legacyDock.href = '/scripts/extensions/third-party/custom-run-panel/dock.css';
        document.head.appendChild(legacyDock);

        const legacyTokens = document.createElement('link');
        legacyTokens.rel = 'stylesheet';
        legacyTokens.href = '/scripts/extensions/third-party/custom-lens-shared/tokens.css';
        document.head.appendChild(legacyTokens);

        ensureDockStyles(document);

        const tokensLink = document.getElementById('luker-lens-shared-tokens-css');
        const dockLink = document.getElementById('luker-run-panel-dock-css');
        expect(tokensLink).not.toBeNull();
        expect(dockLink).not.toBeNull();
        expect(dockLink.href).toMatch(/\/run-panel\/dock\.css$/);
        expect(dockLink.href).not.toContain('third-party');
    });

    test('findSupersededExtension detects all three legacy third-party extensions by folder or homePage', () => {
        expect(findSupersededExtension('third-party/luker-workbench')?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/LUKER-WORKBENCH')?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/memory-lens')?.id).toBe('memory-lens');
        expect(findSupersededExtension('third-party/orchestra-lens')?.id).toBe('orchestra-lens');

        // Renamed folders still match via manifest homePage (with http/www/query/hash/.git/trailing slash).
        expect(findSupersededExtension('third-party/my-old-wb', {
            homePage: 'https://github.com/xzhouzhou758/luker-workbench.git/',
        })?.id).toBe('luker-workbench');
        expect(findSupersededExtension('Third-Party/my-old-wb-http', {
            homePage: 'http://www.github.com/xzhouzhou758/luker-workbench?tab=readme-ov-file#readme',
        })?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/my-ml', {
            homePage: 'https://github.com/XZHOUZHOU758/memory-lens/',
        })?.id).toBe('memory-lens');
        expect(findSupersededExtension('third-party/my-ol', {
            homepage: 'https://github.com/xzhouzhou758/orchestra-lens',
        })?.id).toBe('orchestra-lens');
    });

    test('findSupersededExtension never blocks built-in extensions or unrelated third-party extensions', () => {
        expect(findSupersededExtension('memory-graph')).toBeNull();
        expect(findSupersededExtension('orchestrator')).toBeNull();
        expect(findSupersededExtension('luker-workbench')).toBeNull();
        expect(findSupersededExtension('third-party/float-wheel', {
            homePage: 'https://github.com/xzhouzhou758/float-wheel',
        })).toBeNull();
        expect(findSupersededExtension('third-party/some-other-extension', {
            homePage: 'https://github.com/someone/other-ext',
        })).toBeNull();
    });

    describe('ensureStylesheet ignores inactive or mismatched stylesheet links', () => {
        const BUILTIN = '/scripts/workbench/style.css';

        function addLink(doc, attrs) {
            const link = doc.createElement('link');
            for (const [key, value] of Object.entries(attrs)) {
                link.setAttribute(key, value);
            }
            doc.head.appendChild(link);
            return link;
        }

        test.each([
            ['disabled attribute', { rel: 'stylesheet', href: BUILTIN, disabled: '' }],
            ['media="not all"', { rel: 'stylesheet', href: BUILTIN, media: 'not all' }],
            ['media="print"', { rel: 'stylesheet', href: BUILTIN, media: 'print' }],
            ['rel="alternate stylesheet"', { rel: 'alternate stylesheet', href: BUILTIN, title: 'Alt' }],
            ['rel="preload"', { rel: 'preload', as: 'style', href: BUILTIN }],
        ])('does not reuse a link with %s', (_label, attrs) => {
            const inactive = addLink(document, attrs);
            const injected = ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN);
            expect(injected).not.toBe(inactive);
            expect(injected.id).toBe('luker-workbench-style-css');
            expect(injected.getAttribute('rel')).toBe('stylesheet');
        });

        test('does not reuse a link disabled via the DOM property', () => {
            const inactive = addLink(document, { rel: 'stylesheet', href: BUILTIN });
            inactive.disabled = true;
            const injected = ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN);
            expect(injected).not.toBe(inactive);
        });

        test('reuses active links regardless of rel / media case and whitespace', () => {
            const upper = addLink(document, { REL: 'STYLESHEET', href: BUILTIN, media: '  ALL ' });
            expect(ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN)).toBe(upper);

            document.head.innerHTML = '';
            const screen = addLink(document, { rel: ' Stylesheet ', href: BUILTIN, media: 'Screen' });
            expect(ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN)).toBe(screen);
        });

        test('isActiveStylesheetLink rejects non-link elements and inactive links', () => {
            expect(isActiveStylesheetLink(null)).toBe(false);
            expect(isActiveStylesheetLink(document.createElement('style'))).toBe(false);
            expect(isActiveStylesheetLink(addLink(document, { rel: 'stylesheet', href: BUILTIN }))).toBe(true);
            expect(isActiveStylesheetLink(addLink(document, { rel: 'stylesheet', href: BUILTIN, media: 'not all' }))).toBe(false);
            expect(isActiveStylesheetLink(addLink(document, { rel: 'alternate stylesheet', href: BUILTIN }))).toBe(false);
        });

        test.each([
            ['an inactive link', (doc) => addLink(doc, { id: 'luker-workbench-style-css', rel: 'stylesheet', href: BUILTIN, media: 'not all' })],
            ['a link to a different path', (doc) => addLink(doc, { id: 'luker-workbench-style-css', rel: 'stylesheet', href: '/scripts/extensions/third-party/luker-workbench/style.css' })],
            ['a non-link element', (doc) => {
                const div = doc.createElement('div');
                div.id = 'luker-workbench-style-css';
                doc.body.appendChild(div);
                return div;
            }],
        ])('injects without a duplicate id when the id is held by %s', (_label, createPlaceholder) => {
            const placeholder = createPlaceholder(document);
            try {
                const injected = ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN);
                expect(injected).not.toBe(placeholder);
                expect(injected.tagName).toBe('LINK');
                expect(injected.hasAttribute('id')).toBe(false);
                expect(document.querySelectorAll('#luker-workbench-style-css').length).toBe(1);
                expect(new URL(injected.href).pathname).toBe(BUILTIN);

                // Idempotent: the URL scan finds the injected link next time.
                expect(ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN)).toBe(injected);
            } finally {
                placeholder.remove();
            }
        });

        test('reuses the id fast path only when the id link is active and matches the URL', () => {
            const owned = addLink(document, { id: 'luker-workbench-style-css', rel: 'stylesheet', href: `${BUILTIN}?v=3` });
            expect(ensureStylesheet(document, 'luker-workbench-style-css', BUILTIN)).toBe(owned);
            expect(document.head.querySelectorAll('link').length).toBe(1);
        });

        test('resolves relative links under a /luker/ reverse-proxy sub-path', () => {
            const doc = document.implementation.createHTMLDocument('proxy');
            const base = doc.createElement('base');
            base.href = 'https://example.com/luker/index.html';
            doc.head.appendChild(base);

            const rootLink = addLink(doc, { rel: 'stylesheet', href: '/scripts/workbench/style.css' });
            const target = 'https://example.com/luker/scripts/workbench/style.css';
            const injected = ensureStylesheet(doc, 'luker-workbench-style-css', target);
            expect(injected).not.toBe(rootLink);

            doc.head.innerHTML = '';
            doc.head.appendChild(base);
            const relativeLink = addLink(doc, { rel: 'stylesheet', href: 'scripts/workbench/style.css?v=1' });
            expect(ensureStylesheet(doc, 'luker-workbench-style-css', target)).toBe(relativeLink);
        });

        test('compares protocol under file:// where origins are opaque', () => {
            const doc = document.implementation.createHTMLDocument('file');
            const base = doc.createElement('base');
            base.href = 'file:///opt/luker/public/index.html';
            doc.head.appendChild(base);

            const sameFile = addLink(doc, { rel: 'stylesheet', href: '/scripts/workbench/style.css' });
            expect(ensureStylesheet(doc, 'luker-workbench-style-css', 'file:///scripts/workbench/style.css')).toBe(sameFile);

            doc.head.innerHTML = '';
            doc.head.appendChild(base);
            // Non-special scheme: origin is also "null" with the same pathname, so only protocol differs.
            const otherScheme = addLink(doc, { rel: 'stylesheet', href: 'app://host/scripts/workbench/style.css' });
            const injected = ensureStylesheet(doc, 'luker-workbench-style-css', '/scripts/workbench/style.css');
            expect(injected).not.toBe(otherScheme);
            expect(injected.id).toBe('luker-workbench-style-css');
        });

        test.each([
            ['data:', 'data:text/html,<p>hi</p>'],
            ['blob:', 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000'],
            ['about:', 'about:blank'],
        ])('falls back to a hierarchical base when baseURI is %s', (_label, baseURI) => {
            const doc = document.implementation.createHTMLDocument('opaque');
            Object.defineProperty(doc, 'baseURI', { configurable: true, value: baseURI });

            const legacy = addLink(doc, { rel: 'stylesheet', href: '/scripts/extensions/third-party/luker-workbench/style.css' });
            const injected = ensureStylesheet(doc, 'luker-workbench-style-css', BUILTIN);
            expect(injected).not.toBe(legacy);

            // URL normalization still works (query strings ignored), so no raw string fallback.
            expect(ensureStylesheet(doc, 'other-id', `${BUILTIN}?v=2`)).toBe(injected);
            expect(doc.head.querySelectorAll('link').length).toBe(2);
        });
    });

    test('findSupersededExtension matches SSH remotes and repository sub-paths', () => {
        expect(findSupersededExtension('third-party/renamed-wb', {
            homePage: 'git@github.com:xzhouzhou758/luker-workbench.git',
        })?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/renamed-ml', {
            homePage: 'git@github.com:XZHOUZHOU758/Memory-Lens',
        })?.id).toBe('memory-lens');
        expect(findSupersededExtension('third-party/renamed-ol', {
            homePage: 'ssh://git@github.com/xzhouzhou758/orchestra-lens.git',
        })?.id).toBe('orchestra-lens');
        expect(findSupersededExtension('third-party/renamed-wb2', {
            homePage: 'https://github.com/xzhouzhou758/luker-workbench/tree/main',
        })?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/renamed-wb3', {
            homePage: 'github.com/xzhouzhou758/luker-workbench/blob/main/README.md',
        })?.id).toBe('luker-workbench');

        // Sub-path matching never widens to other repositories of the same owner.
        expect(findSupersededExtension('third-party/fw', {
            homePage: 'git@github.com:xzhouzhou758/float-wheel.git',
        })).toBeNull();
        expect(findSupersededExtension('third-party/owner-only', {
            homePage: 'https://github.com/xzhouzhou758',
        })).toBeNull();
    });

    test('findSupersededExtension tolerates null / missing / malformed manifests', () => {
        expect(findSupersededExtension('third-party/luker-workbench', null)?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/luker-workbench', undefined)?.id).toBe('luker-workbench');
        expect(findSupersededExtension('third-party/unrelated', null)).toBeNull();
        expect(findSupersededExtension('third-party/unrelated', { homePage: null })).toBeNull();
        expect(findSupersededExtension('third-party/unrelated', { homePage: 42 })).toBeNull();
        expect(findSupersededExtension(null, null)).toBeNull();
        expect(findSupersededExtension(undefined)).toBeNull();
    });

    test('getSupersededUiState locks disabled superseded extensions and keeps the normal matrix otherwise', () => {
        // Superseded + still enabled: may be disabled, but never counts as activatable.
        expect(getSupersededUiState({ isSuperseded: true, isActive: false, isDisabled: false, canActivate: true }))
            .toEqual({ canActivate: false, canBeToggled: true, isLocked: false });
        // Superseded + disabled: locked (dedicated "Built into Luker" tooltip).
        expect(getSupersededUiState({ isSuperseded: true, isActive: false, isDisabled: true, canActivate: true }))
            .toEqual({ canActivate: false, canBeToggled: false, isLocked: true });

        // Regular extensions keep the original rule: isActive || isDisabled || canActivate.
        expect(getSupersededUiState({ isSuperseded: false, isActive: true, isDisabled: false, canActivate: false }))
            .toEqual({ canActivate: false, canBeToggled: true, isLocked: false });
        expect(getSupersededUiState({ isSuperseded: false, isActive: false, isDisabled: true, canActivate: false }))
            .toEqual({ canActivate: false, canBeToggled: true, isLocked: false });
        expect(getSupersededUiState({ isSuperseded: false, isActive: false, isDisabled: false, canActivate: true }))
            .toEqual({ canActivate: true, canBeToggled: true, isLocked: false });
        // Missing deps / client version: generic "Cannot enable extension", not locked.
        expect(getSupersededUiState({ isSuperseded: false, isActive: false, isDisabled: false, canActivate: false }))
            .toEqual({ canActivate: false, canBeToggled: false, isLocked: false });
        expect(getSupersededUiState()).toEqual({ canActivate: false, canBeToggled: false, isLocked: false });
    });

    test('shouldSkipToggleAll only skips bulk re-enabling of superseded extensions', () => {
        expect(shouldSkipToggleAll({ enable: true, isSuperseded: true })).toBe(true);
        expect(shouldSkipToggleAll({ enable: false, isSuperseded: true })).toBe(false);
        expect(shouldSkipToggleAll({ enable: true, isSuperseded: false })).toBe(false);
        expect(shouldSkipToggleAll({ enable: false, isSuperseded: false })).toBe(false);
        expect(shouldSkipToggleAll()).toBe(false);
    });

    test('extensions.js routes superseded extensions through the guarded code paths', () => {
        const source = fs.readFileSync(new URL('../../public/scripts/extensions.js', import.meta.url), 'utf8');
        const slashSource = fs.readFileSync(new URL('../../public/scripts/extensions-slashcommands.js', import.meta.url), 'utf8');
        const body = (fnName) => {
            const start = source.indexOf(`function ${fnName}(`);
            expect(start).toBeGreaterThan(-1);
            const next = source.indexOf('\nfunction ', start + 1);
            const nextAsync = source.indexOf('\nasync function ', start + 1);
            const nextExport = source.indexOf('\nexport ', start + 1);
            const end = Math.min(...[next, nextAsync, nextExport].filter(i => i > -1));
            return source.slice(start, end);
        };

        expect(body('onToggleAllExtensions')).toMatch(/shouldSkipToggleAll\(\{\s*enable,\s*isSuperseded:/);
        expect(body('callExtensionHook')).toMatch(/findSupersededExtension\(name, manifest\)\)\s*\{[\s\S]*?return;/);
        expect(body('checkForExtensionUpdates')).toMatch(/findSupersededExtension\(id, manifest\)\)\s*\{[\s\S]*?continue;/);
        expect(body('autoUpdateExtensions')).toMatch(/findSupersededExtension\(id, manifest\)\)\s*\{[\s\S]*?continue;/);
        expect(body('canExtensionBeActivated')).toMatch(/findSupersededExtension\(dep, manifests\[dep\]\)/);
        expect(body('activateExtensions')).toMatch(/disabledDependencies = extensionDependencies\.filter\([\s\S]*?findSupersededExtension\(dep, manifests\[dep\]\)/);
        expect(body('generateExtensionElement')).toMatch(/getSupersededUiState\(/);
        expect(body('generateExtensionElement')).toContain('t`Built into Luker — please uninstall`');
        expect(slashSource).toMatch(/action === 'enable' && findSupersededExtension\(extension\.name, getExtensionManifest\(extension\.name\)\)/);
    });

    test('zh-cn / zh-tw locales translate the superseded tooltip', () => {
        const zhCn = JSON.parse(fs.readFileSync(new URL('../../public/locales/zh-cn.json', import.meta.url), 'utf8'));
        const zhTw = JSON.parse(fs.readFileSync(new URL('../../public/locales/zh-tw.json', import.meta.url), 'utf8'));
        expect(zhCn['Built into Luker — please uninstall']).toBe('已内置到 Luker，请卸载');
        expect(zhTw['Built into Luker — please uninstall']).toBe('已內建到 Luker，請移除');
    });
});
