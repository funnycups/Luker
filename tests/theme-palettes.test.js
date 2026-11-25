/** @jest-environment jsdom */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    THEME_PALETTES_ACTIVE_CLASS,
    THEME_PALETTES_STORAGE_KEY,
    THEME_PALETTE_STRIP_ID,
    __resetThemePalettesForTests,
    applyThemePalette,
    getActiveThemePalette,
    getActiveThemePaletteColor,
    getSavedThemePaletteMode,
    initThemePalettes,
    isThemePalettesActive,
    normalizeThemePalettes,
    resolveThemePaletteId,
    saveThemePaletteMode,
    syncThemePalettes,
} from '../public/scripts/theme-palettes.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LENS_THEME_PATH = path.join(REPO_ROOT, 'default/content/themes/Lens.json');
const LENS_CSS_PATH = path.join(REPO_ROOT, 'public/css/themes/lens.css');
const LENS_THEME = JSON.parse(fs.readFileSync(LENS_THEME_PATH, 'utf8'));
const LENS_CSS = fs.readFileSync(LENS_CSS_PATH, 'utf8');

function installMatchMediaStub(initialDark = true) {
    let prefersDark = initialDark;
    const listeners = new Set();

    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: () => ({
            get matches() { return prefersDark; },
            addEventListener: (_type, fn) => listeners.add(fn),
            removeEventListener: (_type, fn) => listeners.delete(fn),
        }),
    });

    return {
        setPrefersDark(nextDark) {
            prefersDark = Boolean(nextDark);
            for (const fn of listeners) fn({ matches: prefersDark });
        },
        listenerCount: () => listeners.size,
    };
}

describe('Declarative theme palettes & built-in Lens theme', () => {
    let mediaStub;

    beforeEach(() => {
        __resetThemePalettesForTests();
        localStorage.clear();
        document.documentElement.className = '';
        delete document.documentElement.dataset.themePalette;
        document.head.innerHTML = '<meta name="theme-color" content="#333">';
        document.body.innerHTML = '<div id="options"><div class="options-content"><a>Item</a></div></div><div id="chat"></div>';
        mediaStub = installMatchMediaStub(true);
    });

    afterEach(() => {
        __resetThemePalettesForTests();
        localStorage.clear();
    });

    test('built-in Lens theme declares static stylesheet, valid palettes, and is not seeded via content index', () => {
        const indexPath = path.join(REPO_ROOT, 'default/content/index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        expect(index.filter((entry) => entry.type === 'theme')).toEqual([]);

        expect(LENS_THEME.name).toBe('Lens');
        expect(LENS_THEME.builtin_stylesheet).toBe('css/themes/lens.css');
        expect(LENS_THEME.custom_css).toBe('');
        const normalized = normalizeThemePalettes(LENS_THEME.palettes);
        expect(normalized).not.toBeNull();
        expect(normalized.default).toBe('night');
        expect(normalized.items.map((p) => p.id)).toEqual(['night', 'mist', 'ink', 'paper']);
        expect(normalized.auto).toMatchObject({ dark: 'night', light: 'mist' });

        const openBraces = (LENS_CSS.match(/\{/g) || []).length;
        const closeBraces = (LENS_CSS.match(/\}/g) || []).length;
        expect(openBraces).toBeGreaterThan(0);
        expect(openBraces).toBe(closeBraces);
    });

    test('normalizeThemePalettes validates structure, deduplicates IDs, and rejects unsafe CSS values', () => {
        expect(normalizeThemePalettes(null)).toBeNull();
        expect(normalizeThemePalettes({})).toBeNull();
        expect(normalizeThemePalettes({ items: [{ id: 'only', label: 'Only' }] })).toBeNull();

        const normalized = normalizeThemePalettes({
            default: 'missing',
            auto: { dark: 'dusk', light: 'unknown' },
            items: [
                { id: 'bad id!', label: 'Bad' },
                { id: 'dusk', label: 'Dusk', theme_color: '#112233', swatch: 'url(https://evil.example/a.png)' },
                { id: 'dusk', label: 'Duplicate' },
                { id: 'dawn', label: 'Dawn', title: 'Morning Dawn', theme_color: 'rgb(240, 244, 250)', swatch: 'linear-gradient(90deg, #fff, #ddd)' },
            ],
        });

        expect(normalized).toEqual({
            default: 'dusk',
            items: [
                { id: 'dusk', label: 'Dusk', title: 'Dusk', theme_color: '#112233' },
                { id: 'dawn', label: 'Dawn', title: 'Morning Dawn', theme_color: 'rgb(240, 244, 250)', swatch: 'linear-gradient(90deg, #fff, #ddd)' },
            ],
        });
        expect(normalized.auto).toBeUndefined();
    });

    test('resolveThemePaletteId handles explicit IDs, auto mode, missing auto config, and invalid fallbacks', () => {
        const lensConfig = normalizeThemePalettes(LENS_THEME.palettes);
        expect(resolveThemePaletteId(lensConfig, 'night', false)).toBe('night');
        expect(resolveThemePaletteId(lensConfig, 'mist', true)).toBe('mist');
        expect(resolveThemePaletteId(lensConfig, 'ink', false)).toBe('ink');
        expect(resolveThemePaletteId(lensConfig, 'paper', true)).toBe('paper');
        expect(resolveThemePaletteId(lensConfig, 'auto', true)).toBe('night');
        expect(resolveThemePaletteId(lensConfig, 'auto', false)).toBe('mist');
        expect(resolveThemePaletteId(lensConfig, 'invalid', false)).toBe('night');
        expect(resolveThemePaletteId(lensConfig, null, true)).toBe('night');

        const twoTone = normalizeThemePalettes({
            default: 'warm',
            items: [
                { id: 'warm', label: 'Warm' },
                { id: 'cool', label: 'Cool' },
            ],
        });
        expect(resolveThemePaletteId(twoTone, 'auto', false)).toBe('warm');
        expect(resolveThemePaletteId(twoTone, 'cool', false)).toBe('cool');
    });

    test('storage helpers isolate saved palette preferences per theme and ignore invalid modes', () => {
        const lensConfig = normalizeThemePalettes(LENS_THEME.palettes);
        const customConfig = normalizeThemePalettes({
            default: 'slate',
            items: [
                { id: 'slate', label: 'Slate' },
                { id: 'sand', label: 'Sand' },
            ],
        });

        expect(getSavedThemePaletteMode('Lens', lensConfig, localStorage)).toBe('night');
        saveThemePaletteMode('Lens', 'ink', lensConfig, localStorage);
        saveThemePaletteMode('CustomTheme', 'sand', customConfig, localStorage);
        saveThemePaletteMode('Lens', 'bogus', lensConfig, localStorage);
        saveThemePaletteMode('CustomTheme', 'auto', customConfig, localStorage);

        expect(getSavedThemePaletteMode('Lens', lensConfig, localStorage)).toBe('ink');
        expect(getSavedThemePaletteMode('CustomTheme', customConfig, localStorage)).toBe('sand');
        expect(JSON.parse(localStorage.getItem(THEME_PALETTES_STORAGE_KEY))).toEqual({
            Lens: 'ink',
            CustomTheme: 'sand',
        });
    });

    test('mounts strip for palette theme, switches palettes, and cleans up without clobbering meta theme-color', () => {
        const events = [];
        initThemePalettes({
            onPaletteChange: (palette, mode) => events.push({ id: palette?.id ?? null, color: palette?.theme_color ?? null, mode }),
        });

        expect(syncThemePalettes('Azure', null)).toBe(false);
        expect(isThemePalettesActive()).toBe(false);
        expect(document.getElementById(THEME_PALETTE_STRIP_ID)).toBeNull();
        expect(events).toEqual([]);

        // Activate Lens theme
        expect(syncThemePalettes('Lens', LENS_THEME.palettes)).toBe(true);
        expect(isThemePalettesActive()).toBe(true);
        expect(document.documentElement.classList.contains(THEME_PALETTES_ACTIVE_CLASS)).toBe(true);
        expect(document.documentElement.dataset.themePalette).toBe('night');
        expect(getActiveThemePaletteColor()).toBe('#07090f');

        const strip = document.getElementById(THEME_PALETTE_STRIP_ID);
        expect(strip).not.toBeNull();
        expect(document.getElementById('options').firstElementChild).toBe(strip);
        expect(strip.style.getPropertyValue('--theme-palette-columns')).toBe('5');

        const buttons = strip.querySelectorAll('.theme-palette-item');
        expect(buttons).toHaveLength(5);
        expect(buttons[0].getAttribute('tabindex')).toBe('0');
        expect(buttons[1].getAttribute('tabindex')).toBe('-1');

        // Click Mist swatch
        buttons[1].click();
        expect(document.documentElement.dataset.themePalette).toBe('mist');
        expect(getActiveThemePalette()?.id).toBe('mist');
        expect(getActiveThemePaletteColor()).toBe('#e8ecf3');
        expect(buttons[1].getAttribute('aria-checked')).toBe('true');
        expect(buttons[1].getAttribute('tabindex')).toBe('0');
        expect(buttons[0].getAttribute('tabindex')).toBe('-1');

        // Simulate switching to Azure: power-user.js sets meta to Azure's tint before/after sync
        const meta = document.querySelector('meta[name="theme-color"]');
        meta.setAttribute('content', 'rgba(23, 30, 33, 0.61)');

        expect(syncThemePalettes('Azure', null)).toBe(false);
        expect(isThemePalettesActive()).toBe(false);
        expect(document.documentElement.classList.contains(THEME_PALETTES_ACTIVE_CLASS)).toBe(false);
        expect(document.documentElement.dataset.themePalette).toBeUndefined();
        expect(getActiveThemePaletteColor()).toBeNull();
        // Must NOT overwrite meta[name="theme-color"] back to stale '#333'
        expect(meta.getAttribute('content')).toBe('rgba(23, 30, 33, 0.61)');
        expect(events).toEqual([
            { id: 'night', color: '#07090f', mode: 'night' },
            { id: 'mist', color: '#e8ecf3', mode: 'mist' },
            { id: null, color: null, mode: null },
        ]);
    });

    test('supports arbitrary third-party themes with custom palette counts and escapes semicolons in data-i18n', () => {
        const thirdPartyPalettes = {
            default: 'forest',
            items: [
                { id: 'forest', label: 'Forest; Deep', title: 'Deep; Forest', theme_color: '#102018' },
                { id: 'amber', label: 'Amber', theme_color: '#2b1e10' },
            ],
        };

        expect(syncThemePalettes('Woodland', thirdPartyPalettes)).toBe(true);
        const strip = document.getElementById(THEME_PALETTE_STRIP_ID);
        expect(strip.style.getPropertyValue('--theme-palette-columns')).toBe('2');

        const buttons = strip.querySelectorAll('.theme-palette-item');
        expect(buttons).toHaveLength(2);
        expect(buttons[0].getAttribute('data-i18n')).toBe('[title]Deep\\; Forest');
        expect(buttons[0].querySelector('span[data-i18n]').getAttribute('data-i18n')).toBe('Forest\\; Deep');
        expect(document.documentElement.dataset.themePalette).toBe('forest');
        expect(getActiveThemePaletteColor()).toBe('#102018');
    });

    test('auto mode tracks prefers-color-scheme changes and notifies callback', () => {
        const onPaletteChange = jest.fn();
        initThemePalettes({ onPaletteChange });
        syncThemePalettes('Lens', LENS_THEME.palettes);

        const autoBtn = document.querySelector('.theme-palette-item[data-mode="auto"]');
        autoBtn.click();
        expect(document.documentElement.dataset.themePalette).toBe('night');
        expect(getActiveThemePaletteColor()).toBe('#07090f');

        mediaStub.setPrefersDark(false);
        expect(document.documentElement.dataset.themePalette).toBe('mist');
        expect(getActiveThemePaletteColor()).toBe('#e8ecf3');
        expect(onPaletteChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'mist', theme_color: '#e8ecf3' }), 'auto');
    });

    test('radiogroup supports arrow-key, Home, and End navigation with roving tabindex', () => {
        initThemePalettes();
        syncThemePalettes('Lens', LENS_THEME.palettes);

        const strip = document.getElementById(THEME_PALETTE_STRIP_ID);
        const buttons = Array.from(strip.querySelectorAll('.theme-palette-item'));

        buttons[0].focus();
        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(document.activeElement).toBe(buttons[1]);
        expect(document.documentElement.dataset.themePalette).toBe('mist');
        expect(buttons[1].getAttribute('tabindex')).toBe('0');
        expect(buttons[0].getAttribute('tabindex')).toBe('-1');

        buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(document.activeElement).toBe(buttons[4]);
        expect(buttons[4].dataset.mode).toBe('auto');
        expect(buttons[4].getAttribute('aria-checked')).toBe('true');

        buttons[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(document.activeElement).toBe(buttons[0]);
        expect(document.documentElement.dataset.themePalette).toBe('night');

        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(document.activeElement).toBe(buttons[4]);
    });

    test('does not silently swallow errors thrown by onPaletteChange callback', () => {
        initThemePalettes({
            onPaletteChange: () => {
                throw new Error('bridge exploded');
            },
        });

        expect(() => syncThemePalettes('Lens', LENS_THEME.palettes)).toThrow('bridge exploded');
        expect(() => applyThemePalette('mist', { notify: true })).toThrow('bridge exploded');
    });
});
