/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';

import {
    clear,
    formatDuration,
    formatTime,
    formatTokens,
    hashString,
    h,
    initialOf,
    put,
    relativeTime,
    truncate,
} from '../../public/scripts/lens-shared/util.js';
import { registerLensSharedLocaleData } from '../../public/scripts/lens-shared/locale-data.js';
import {
    button,
    checkRow,
    confirmDialog,
    emptyState,
    formField,
    iconButton,
    sectionTitle,
    segmented,
    selectInput,
    switchControl,
} from '../../public/scripts/lens-shared/ui.js';

const table = {};

beforeAll(() => {
    globalThis.Luker = { getContext: () => ({ translate: (text) => table[text] ?? text }) };
});

beforeEach(() => {
    document.body.innerHTML = '';
    for (const key of Object.keys(table)) delete table[key];
});

describe('lens-shared util', () => {
    test('h() renders HTML tags passed as text or children as text nodes, never parsed HTML', () => {
        const xss = '<img src=x onerror="alert(1)"><script>boom()</script>';
        const viaText = h('div', { class: 'box', text: xss });
        expect(viaText.querySelector('img')).toBeNull();
        expect(viaText.querySelector('script')).toBeNull();
        expect(viaText.textContent).toBe(xss);

        const viaChildren = h('div', null, xss, ['<b>bold</b>']);
        expect(viaChildren.querySelector('img')).toBeNull();
        expect(viaChildren.querySelector('script')).toBeNull();
        expect(viaChildren.querySelector('b')).toBeNull();
        expect(viaChildren.textContent).toBe(`${xss}<b>bold</b>`);
    });

    test('put() skips nullish/false children and clear() empties the element', () => {
        const el = h('div');
        put(el, null, undefined, false, 'hello', [' ', h('span', { text: 'world' })]);
        expect(el.textContent).toBe('hello world');
        expect(el.querySelector('span')?.textContent).toBe('world');
        clear(el);
        expect(el.childNodes.length).toBe(0);
    });

    test('formatTime includes seconds unless told otherwise', () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        expect(formatTime(date)).toBe('03:04:05');
        expect(formatTime(date, { seconds: false })).toBe('03:04');
        expect(formatTime('not a date')).toBe('');
    });

    test('formatTokens scales', () => {
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(1234)).toBe('1.2k');
        expect(formatTokens(15300)).toBe('15k');
        expect(formatTokens(2400000)).toBe('2.4M');
    });

    test('formatDuration', () => {
        expect(formatDuration(250)).toBe('250ms');
        expect(formatDuration(1500)).toBe('1.5s');
        expect(formatDuration(-1)).toBe('—');
    });

    test('hashString is stable and initialOf upper-cases', () => {
        expect(hashString('abc')).toBe(hashString('abc'));
        expect(hashString('abc')).not.toBe(hashString('abd'));
        expect(initialOf('  zoe')).toBe('Z');
        expect(initialOf('')).toBe('?');
        expect(truncate('abcdef', 4)).toBe('abc…');
    });

    test('relativeTime translates via active locale without conflicting with core locale files', () => {
        const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
        expect(relativeTime(now - 1000, now)).toBe('just now');
        expect(relativeTime(now - 5 * 60e3, now)).toBe('5 min ago');
        expect(relativeTime(0, now)).toBe('');
        registerLensSharedLocaleData((locale, data) => {
            if (locale === 'zh-cn') Object.assign(table, data);
        });
        expect(relativeTime(now - 3 * 86400e3, now)).toBe('3 天前');
        expect(relativeTime(now - 86400e3, now)).toBe('昨天 12:00');
        expect(relativeTime(now - 10 * 86400e3, now)).toBe('6月5日');
    });
});

describe('lens-shared locale-data contract', () => {
    test('has matching ZH_CN/ZH_TW keys, no unescaped semicolons, and zero overlap with core locale JSONs', () => {
        const captured = {};
        registerLensSharedLocaleData((locale, data) => {
            captured[locale] = data;
        });

        expect(Object.keys(captured)).toEqual(['zh-cn', 'zh-tw']);
        const cnKeys = Object.keys(captured['zh-cn']).sort();
        const twKeys = Object.keys(captured['zh-tw']).sort();
        expect(cnKeys).toEqual(twKeys);

        for (const key of cnKeys) {
            expect(key.replace(/\\;/g, '')).not.toContain(';');
        }

        const zhCnCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-cn.json', import.meta.url)), 'utf8'));
        const zhTwCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-tw.json', import.meta.url)), 'utf8'));
        for (const key of cnKeys) {
            expect(Object.hasOwn(zhCnCore, key)).toBe(false);
            expect(Object.hasOwn(zhTwCore, key)).toBe(false);
        }
    });
});

describe('lens-shared ui primitives', () => {
    test('renders shared controls safely without innerHTML', () => {
        let clicked = 0;
        const btn = button('<script>x</script>', () => { clicked += 1; }, { iconName: 'plus', primary: true });
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.querySelector('script')).toBeNull();
        expect(btn.textContent).toBe('<script>x</script>');
        btn.click();
        expect(clicked).toBe(1);

        const ibtn = iconButton('x', 'Close', () => { clicked += 1; }, { pressed: true });
        expect(ibtn.getAttribute('aria-pressed')).toBe('true');
        expect(ibtn.getAttribute('aria-label')).toBe('Close');
        ibtn.click();
        expect(clicked).toBe(2);

        let switched = false;
        const sw = switchControl('Enable', false, (next) => { switched = next; });
        expect(sw.getAttribute('role')).toBe('switch');
        expect(sw.getAttribute('aria-checked')).toBe('false');
        sw.click();
        expect(switched).toBe(true);
        expect(sw.getAttribute('aria-checked')).toBe('true');

        let segVal = 'a';
        const seg = segmented(
            [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
            segVal,
            (next) => { segVal = next; },
            { ariaLabel: 'Mode' },
        );
        seg.querySelectorAll('button')[1].click();
        expect(segVal).toBe('b');

        let checked = false;
        const chk = checkRow({ checked, label: 'Confirm', note: 'Details', onChange: (v) => { checked = v; } });
        expect(chk.getAttribute('role')).toBe('checkbox');
        chk.click();
        expect(checked).toBe(true);
        expect(chk.getAttribute('aria-checked')).toBe('true');

        const sec = sectionTitle('Header', h('span', { text: 'Extra' }));
        expect(sec.textContent).toContain('Header');
        expect(sec.textContent).toContain('Extra');

        const emp = emptyState('info', 'Nothing here', 'Try again');
        expect(emp.textContent).toContain('Nothing here');
        expect(emp.textContent).toContain('Try again');

        let selected = 'one';
        const sel = selectInput(
            [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }],
            selected,
            (v) => { selected = v; },
            { follow: true },
        );
        expect(sel.classList.contains('is-follow')).toBe(true);
        sel.value = 'two';
        sel.dispatchEvent(new Event('change'));
        expect(selected).toBe('two');
        expect(sel.classList.contains('is-follow')).toBe(false);

        const fld = formField('Name', sel);
        expect(fld.tagName).toBe('LABEL');
        expect(fld.querySelector('select')).toBe(sel);
    });

    test('confirmDialog mounts safely and resolves boolean on confirm/cancel', async () => {
        const host = h('div');
        document.body.appendChild(host);

        const promiseTrue = confirmDialog(host, {
            title: 'Delete <b>item</b>?',
            lines: ['Line 1'],
            okLabel: 'Delete',
            danger: true,
        });
        const okBtn = host.querySelector('.lw-btn.is-danger');
        expect(okBtn).not.toBeNull();
        expect(host.querySelector('b')).toBeNull();
        okBtn.click();
        await expect(promiseTrue).resolves.toBe(true);
        expect(host.querySelector('.lw-dialog-backdrop')).toBeNull();

        const promiseFalse = confirmDialog(host, {
            title: 'Cancel test',
            lines: ['Line 1'],
        });
        const cancelBtn = host.querySelector('.lw-btn.is-ghost');
        expect(cancelBtn).not.toBeNull();
        cancelBtn.click();
        await expect(promiseFalse).resolves.toBe(false);
    });

    test('confirmDialog mounted on document.body adds .lw-surface and skips redundant .lw-surface inside surface hosts', async () => {
        const bodyPromise = confirmDialog({
            title: '',
            lines: ['Body mounted'],
            theme: 'light',
        });
        const bodyBackdrop = document.body.querySelector(':scope > .lw-dialog-backdrop');
        expect(bodyBackdrop).not.toBeNull();
        expect(bodyBackdrop.classList.contains('lw-surface')).toBe(true);
        expect(bodyBackdrop.dataset.theme).toBe('light');
        const bodyPanel = bodyBackdrop.querySelector('.lw-dialog');
        expect(bodyPanel.hasAttribute('aria-label')).toBe(false);

        const cssText = readFileSync(fileURLToPath(new URL('../../public/scripts/lens-shared/tokens.css', import.meta.url)), 'utf8');
        const styleEl = document.createElement('style');
        styleEl.textContent = cssText;
        document.head.appendChild(styleEl);
        expect(getComputedStyle(bodyBackdrop).position).toBe('fixed');
        styleEl.remove();

        bodyBackdrop.querySelector('.lw-btn.is-primary').click();
        await expect(bodyPromise).resolves.toBe(true);

        const surfaceHost = h('div', { class: 'wbench' });
        document.body.appendChild(surfaceHost);
        const surfacePromise = confirmDialog(surfaceHost, { title: 'Inside surface' });
        const innerBackdrop = surfaceHost.querySelector('.lw-dialog-backdrop');
        expect(innerBackdrop.classList.contains('lw-surface')).toBe(false);
        expect(innerBackdrop.querySelector('.lw-dialog').getAttribute('aria-label')).toBe('Inside surface');
        innerBackdrop.querySelector('.lw-btn.is-ghost').click();
        await expect(surfacePromise).resolves.toBe(false);
    });
});
