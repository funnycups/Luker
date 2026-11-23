/** @jest-environment jsdom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from '@jest/globals';
import { ensureStylesheet } from '../../public/scripts/lens-shared/util.js';
import { ensureWorkbenchStyles } from '../../public/scripts/workbench/app.js';
import { ensureDockStyles } from '../../public/scripts/run-panel/dock.js';
import { findSupersededExtension } from '../../public/scripts/util/superseded-extensions.js';

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
});
