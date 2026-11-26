/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import {
    renderTemplateParts,
    createBehaviorSummary,
    mountBehaviorSummary,
} from '../../public/scripts/lens-shared/behavior-summary.js';

function makeField(key, tag = 'input', attrs = {}) {
    const wrap = document.createElement('div');
    wrap.dataset.fieldKey = key;
    const ctl = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') ctl.textContent = v;
        else ctl.setAttribute(k, v);
    }
    wrap.appendChild(ctl);
    return { wrap, ctl };
}

beforeEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('renderTemplateParts', () => {
    test('splits literal text and placeholders into Text nodes, interactive buttons, and readonly spans', () => {
        const parts = renderTemplateParts('Runs ${mode} every ${count} turns (${note}).', {
            mode: { text: 'auto', tone: 'on', field: 'autoEnabled' },
            count: { text: 3, tone: 'accent', fields: ['cadence', 'batch'] },
            note: { text: 'read only', tone: 'off', field: null },
        });

        expect(parts).toHaveLength(7);
        expect(parts[0]).toBeInstanceOf(Text);
        expect(parts[0].textContent).toBe('Runs ');

        const modeBtn = parts[1];
        expect(modeBtn.tagName).toBe('BUTTON');
        expect(modeBtn.type).toBe('button');
        expect(modeBtn.className).toBe('luker-bsum-tok is-on');
        expect(modeBtn.dataset.bsumFields).toBe('autoEnabled');
        expect(modeBtn.textContent).toBe('auto');

        expect(parts[2]).toBeInstanceOf(Text);
        expect(parts[2].textContent).toBe(' every ');

        const countBtn = parts[3];
        expect(countBtn.tagName).toBe('BUTTON');
        expect(countBtn.className).toBe('luker-bsum-tok is-accent');
        expect(countBtn.dataset.bsumFields).toBe('cadence,batch');
        expect(countBtn.textContent).toBe('3');

        expect(parts[4]).toBeInstanceOf(Text);
        expect(parts[4].textContent).toBe(' turns (');

        const noteSpan = parts[5];
        expect(noteSpan.tagName).toBe('SPAN');
        expect(noteSpan.className).toBe('luker-bsum-tok is-off is-readonly');
        expect(noteSpan.hasAttribute('data-bsum-fields')).toBe(false);
        expect(noteSpan.textContent).toBe('read only');

        expect(parts[6]).toBeInstanceOf(Text);
        expect(parts[6].textContent).toBe(').');
    });

    test('throws loud error when a template placeholder has no matching own property in tokens', () => {
        expect(() => renderTemplateParts('Value: ${missingKey}', {})).toThrow(
            'behavior-summary: missing token "missingKey"',
        );
        expect(() => renderTemplateParts('Value: ${missingKey}')).toThrow(
            'behavior-summary: missing token "missingKey"',
        );
        expect(() => renderTemplateParts('Value: ${toString}', {})).toThrow(
            'behavior-summary: missing token "toString"',
        );
        expect(() => renderTemplateParts('Value: ${missingKey}', { missingKey: undefined })).toThrow(
            'behavior-summary: missing token "missingKey"',
        );
    });

    test('Review Focus #1: token text containing HTML and ${other} renders as literal textContent with zero child elements or recursive interpolation', () => {
        const hostile = '<img src=x onerror=1> and ${other}';
        const parts = renderTemplateParts('Label: ${slot}', {
            slot: { text: hostile, tone: 'warn', field: 'name' },
            other: { text: 'SHOULD_NOT_INTERPOLATE', tone: 'on', field: 'other' },
        });

        expect(parts).toHaveLength(2);
        const btn = parts[1];
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.children.length).toBe(0);
        expect(btn.querySelector('img')).toBeNull();
        expect(btn.textContent).toBe(hostile);
    });
});

describe('createBehaviorSummary', () => {
    test('renders Style A layout, warnings, and bidirectional hover/focus highlight preserving focus after pointerleave', () => {
        const section = document.createElement('section');
        const { wrap: batchWrap, ctl: batchInput } = makeField('settings.batch', 'input', { type: 'number', value: '2' });
        const { wrap: quoteWrap } = makeField('a"b', 'input', { type: 'text', value: 'x' });
        section.append(batchWrap, quoteWrap);

        // Simulate jsdom without CSS.escape to verify safe attribute-escape fallback.
        const savedCss = globalThis.CSS;
        delete globalThis.CSS;

        try {
            const summary = createBehaviorSummary({
                id: 'mg-summary',
                scopeEl: section,
                ariaLabel: 'Live behavior summary',
                build: () => ({
                    tone: 'warn',
                    rows: [
                        {
                            role: 'Trigger',
                            template: 'Batch ${batch} with ${quote}',
                            tokens: {
                                batch: { text: '2 turns', tone: 'on', field: 'settings.batch' },
                                quote: { text: 'quoted', tone: 'off', field: 'a"b' },
                            },
                        },
                    ],
                    warnings: [
                        { tone: 'warn', text: 'Gap detected.' },
                        { tone: 'danger', text: 'Blocked.' },
                    ],
                }),
            });

            document.body.append(summary.el, section);

            expect(summary.el.classList.contains('luker-bsum')).toBe(true);
            expect(summary.el.classList.contains('is-warn')).toBe(true);
            expect(summary.el.dataset.bsumId).toBe('mg-summary');
            expect(summary.el.getAttribute('aria-label')).toBe('Live behavior summary');

            const row = summary.el.querySelector('.luker-bsum-row');
            expect(row).not.toBeNull();
            expect(row.querySelector('.luker-bsum-role')?.textContent).toBe('Trigger');
            expect(row.querySelector('.luker-bsum-text')?.textContent).toBe('Batch 2 turns with quoted');

            const warningsBox = summary.el.querySelector('.luker-bsum-warnings');
            expect(warningsBox).not.toBeNull();
            expect(warningsBox.getAttribute('role')).toBe('status');
            expect(warningsBox.hidden).toBe(false);
            const warnItems = warningsBox.querySelectorAll('.luker-bsum-warn');
            expect(warnItems).toHaveLength(2);
            expect(warnItems[0].classList.contains('is-warn')).toBe(true);
            expect(warnItems[1].classList.contains('is-danger')).toBe(true);

            const batchTok = summary.el.querySelector('[data-bsum-fields="settings.batch"]');
            const quoteTok = summary.el.querySelector('[data-bsum-fields="a\\"b"]');
            expect(batchTok).not.toBeNull();
            expect(quoteTok).not.toBeNull();

            // Hover + focus on batch field wrapper.
            batchWrap.dispatchEvent(new Event('pointerenter'));
            expect(batchTok.classList.contains('is-hot')).toBe(true);
            expect(row.classList.contains('is-row-hot')).toBe(true);
            expect(batchWrap.classList.contains('luker-bsum-field-linked')).toBe(true);

            batchInput.focus();
            batchWrap.dispatchEvent(new Event('pointerleave'));
            // Focus remains inside the input -> highlight stays active.
            expect(batchTok.classList.contains('is-hot')).toBe(true);
            expect(row.classList.contains('is-row-hot')).toBe(true);
            expect(batchWrap.classList.contains('luker-bsum-field-linked')).toBe(true);

            batchInput.blur();
            batchInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
            expect(batchTok.classList.contains('is-hot')).toBe(false);
            expect(row.classList.contains('is-row-hot')).toBe(false);
            expect(batchWrap.classList.contains('luker-bsum-field-linked')).toBe(false);

            // Reverse direction: hovering token highlights field wrapper with escaped key.
            quoteTok.dispatchEvent(new Event('pointerenter'));
            expect(quoteTok.classList.contains('is-hot')).toBe(true);
            expect(quoteWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
            quoteTok.dispatchEvent(new Event('pointerleave'));
            expect(quoteWrap.classList.contains('luker-bsum-field-linked')).toBe(false);

            summary.destroy();
        } finally {
            if (savedCss !== undefined) globalThis.CSS = savedCss;
        }
    });

    test('Review Focus #2: calling update() while a sibling input holds focus updates summary without changing document.activeElement', () => {
        const section = document.createElement('div');
        const { wrap, ctl: input } = makeField('cadence', 'input', { type: 'number', value: '2' });
        section.appendChild(wrap);

        let count = 2;
        const summary = createBehaviorSummary({
            scopeEl: section,
            build: () => ({
                tone: 'active',
                rows: [
                    {
                        role: 'Cadence',
                        template: 'Every ${cadence} replies',
                        tokens: {
                            cadence: { text: String(count), tone: 'on', field: 'cadence' },
                        },
                    },
                ],
            }),
        });

        document.body.append(summary.el, section);
        input.focus();
        expect(document.activeElement).toBe(input);

        count = 5;
        summary.update();

        expect(document.activeElement).toBe(input);
        expect(summary.el.querySelector('.luker-bsum-text')?.textContent).toBe('Every 5 replies');
        expect(summary.el.querySelector('[data-bsum-fields="cadence"]')?.classList.contains('is-hot')).toBe(true);
        expect(wrap.classList.contains('luker-bsum-field-linked')).toBe(true);

        summary.destroy();
    });

    test('Review Focus #3: bindScope detaches previous scope listeners and binds cleanly to replacement; mountBehaviorSummary replaces duplicate ids', () => {
        const oldSection = document.createElement('section');
        const { wrap: oldWrap, ctl: oldInput } = makeField('mode', 'input', { type: 'text' });
        oldSection.appendChild(oldWrap);

        const newSection = document.createElement('section');
        const { wrap: newWrap } = makeField('mode', 'input', { type: 'text' });
        newSection.appendChild(newWrap);

        const summary = createBehaviorSummary({
            scopeEl: oldSection,
            build: () => ({
                tone: 'active',
                rows: [
                    {
                        role: 'Mode',
                        template: '${mode}',
                        tokens: {
                            mode: { text: 'auto', tone: 'on', field: 'mode' },
                        },
                    },
                ],
            }),
        });

        document.body.append(summary.el, oldSection, newSection);

        oldWrap.dispatchEvent(new Event('pointerenter'));
        expect(oldWrap.classList.contains('luker-bsum-field-linked')).toBe(true);

        summary.bindScope(newSection);
        expect(oldWrap.classList.contains('luker-bsum-field-linked')).toBe(false);

        // Old scope events must no longer activate highlights.
        oldWrap.dispatchEvent(new Event('pointerenter'));
        oldInput.focus();
        expect(oldWrap.classList.contains('luker-bsum-field-linked')).toBe(false);
        expect(summary.el.querySelector('[data-bsum-fields="mode"]')?.classList.contains('is-hot')).toBe(false);

        // New scope events must work cleanly.
        newWrap.dispatchEvent(new Event('pointerenter'));
        expect(newWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
        expect(summary.el.querySelector('[data-bsum-fields="mode"]')?.classList.contains('is-hot')).toBe(true);

        summary.destroy();

        // mountBehaviorSummary idempotency check.
        const panel = document.createElement('div');
        const anchor = document.createElement('div');
        const rowWrap = document.createElement('div');
        rowWrap.className = 'setting-row';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.id = 'chk_enabled';
        chk.checked = true;
        rowWrap.appendChild(chk);
        panel.append(anchor, rowWrap);
        document.body.appendChild(panel);

        let buildCallsFirst = 0;
        let buildCallsSecond = 0;

        const first = mountBehaviorSummary({
            id: 'dup-mount',
            root: panel,
            anchor,
            position: 'prepend',
            fields: { enabled: { selector: '#chk_enabled', highlight: '.setting-row' } },
            readState: (root) => Boolean(root.querySelector('#chk_enabled')?.checked),
            build: (enabled) => {
                buildCallsFirst += 1;
                return {
                    tone: enabled ? 'active' : 'dormant',
                    rows: [{ role: 'State', template: '${enabled}', tokens: { enabled: { text: String(enabled), field: 'enabled' } } }],
                };
            },
        });

        const second = mountBehaviorSummary({
            id: 'dup-mount',
            root: panel,
            anchor,
            position: 'prepend',
            fields: { enabled: { selector: '#chk_enabled', highlight: '.setting-row' } },
            readState: (root) => Boolean(root.querySelector('#chk_enabled')?.checked),
            build: (enabled) => {
                buildCallsSecond += 1;
                return {
                    tone: enabled ? 'active' : 'dormant',
                    rows: [{ role: 'State', template: '${enabled}', tokens: { enabled: { text: String(enabled), field: 'enabled' } } }],
                };
            },
        });

        const mountedCards = panel.querySelectorAll('.luker-bsum[data-bsum-id="dup-mount"]');
        expect(mountedCards).toHaveLength(1);
        expect(mountedCards[0]).toBe(second.el);
        expect(first.el.isConnected).toBe(false);

        const beforeCallsFirst = buildCallsFirst;
        const beforeCallsSecond = buildCallsSecond;
        chk.checked = false;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
        expect(buildCallsFirst).toBe(beforeCallsFirst);
        expect(buildCallsSecond).toBe(beforeCallsSecond + 1);
        expect(second.el.classList.contains('is-dormant')).toBe(true);

        second.destroy();
        expect(second.el.isConnected).toBe(false);
    });

    test('Review Focus #4: clicking token opens closed <details>, clicks collapsed .inline-drawer-toggle, focuses control, pulses, and invokes onActivate/onTokenActivate without throwing on missing targets', () => {
        jest.useFakeTimers();

        const container = document.createElement('div');
        container.style.overflowY = 'auto';
        Object.defineProperty(container, 'clientHeight', { value: 200, configurable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true });
        container.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200 });
        container.scrollTo = jest.fn(({ top }) => { container.scrollTop = top; });

        // 1. Closed <details>
        const details = document.createElement('details');
        details.open = false;
        const { wrap: detailsWrap, ctl: detailsInput } = makeField('inDetails', 'input', { type: 'text' });
        detailsInput.getBoundingClientRect = () => ({ top: 420, bottom: 450, left: 0, right: 200, width: 200, height: 30 });
        detailsInput.scrollIntoView = jest.fn();
        details.appendChild(detailsWrap);

        // 2. Collapsed .inline-drawer
        const drawer = document.createElement('div');
        drawer.className = 'inline-drawer';
        const toggle = document.createElement('div');
        toggle.className = 'inline-drawer-toggle inline-drawer-header';
        const content = document.createElement('div');
        content.className = 'inline-drawer-content';
        content.style.display = 'none';
        let toggleClicks = 0;
        toggle.addEventListener('click', () => {
            toggleClicks += 1;
            content.style.display = 'block';
        });
        const { wrap: drawerWrap, ctl: drawerSelect } = makeField('inDrawer', 'select');
        const opt = document.createElement('option');
        opt.value = 'a';
        drawerSelect.appendChild(opt);
        drawerSelect.scrollIntoView = jest.fn();
        content.appendChild(drawerWrap);
        drawer.append(toggle, content);

        container.append(details, drawer);

        const tokenActivateCalls = [];
        const adapterActivateCalls = [];
        const summary = createBehaviorSummary({
            scopeEl: container,
            onTokenActivate: (fields, event) => {
                adapterActivateCalls.push({ fields, type: event.type });
                return fields.includes('externalAdapter');
            },
            build: () => ({
                tone: 'active',
                rows: [
                    {
                        role: 'Targets',
                        template: '${d} / ${dr} / ${fn} / ${ext}',
                        tokens: {
                            d: { text: 'Details', field: 'inDetails' },
                            dr: { text: 'Drawer', field: 'inDrawer' },
                            fn: {
                                text: 'RemoteFn',
                                field: 'nonExistentLocal',
                                onActivate: (fields) => {
                                    tokenActivateCalls.push(fields);
                                    return true;
                                },
                            },
                            ext: { text: 'AdapterFn', field: 'externalAdapter' },
                        },
                    },
                ],
            }),
        });

        document.body.append(summary.el, container);

        // Click token inside closed <details>
        const detailsBtn = summary.el.querySelector('[data-bsum-fields="inDetails"]');
        detailsBtn.click();
        expect(details.open).toBe(true);
        expect(document.activeElement).toBe(detailsInput);
        expect(container.scrollTo).toHaveBeenCalledWith({ left: 0, top: 250, behavior: 'smooth' });
        expect(detailsInput.scrollIntoView).not.toHaveBeenCalled();
        expect(detailsWrap.classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Click token inside collapsed .inline-drawer
        const drawerBtn = summary.el.querySelector('[data-bsum-fields="inDrawer"]');
        drawerBtn.click();
        expect(toggleClicks).toBe(1);
        expect(content.style.display).toBe('block');
        expect(document.activeElement).toBe(drawerSelect);
        expect(drawerWrap.classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Click token with token.onActivate returning true (no local target exists; short-circuits adapter onTokenActivate)
        const countBeforeFn = adapterActivateCalls.length;
        const fnBtn = summary.el.querySelector('[data-bsum-fields="nonExistentLocal"]');
        expect(() => fnBtn.click()).not.toThrow();
        expect(tokenActivateCalls).toEqual([['nonExistentLocal']]);
        expect(adapterActivateCalls).toHaveLength(countBeforeFn);

        // Click token with adapter onTokenActivate returning true (no local target exists)
        const extBtn = summary.el.querySelector('[data-bsum-fields="externalAdapter"]');
        expect(() => extBtn.click()).not.toThrow();
        expect(adapterActivateCalls.slice(countBeforeFn)).toEqual([{ fields: ['externalAdapter'], type: 'click' }]);

        // destroy() cleans up pulse timers and removes pulse classes immediately
        summary.destroy();
        expect(detailsWrap.classList.contains('luker-bsum-field-pulse')).toBe(false);
        expect(drawerWrap.classList.contains('luker-bsum-field-pulse')).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('dormantFields marks field wrappers with .luker-bsum-field-dormant and clears them on update()', () => {
        const section = document.createElement('div');
        const { wrap: w1 } = makeField('alpha', 'input');
        const { wrap: w2 } = makeField('beta', 'input');
        section.append(w1, w2);

        let dormant = ['alpha', 'beta'];
        const summary = createBehaviorSummary({
            scopeEl: section,
            build: () => ({
                tone: dormant.length ? 'dormant' : 'active',
                dormantFields: dormant,
                rows: [
                    {
                        role: 'Config',
                        template: '${a} ${b}',
                        tokens: {
                            a: { text: 'A', field: 'alpha' },
                            b: { text: 'B', field: 'beta' },
                        },
                    },
                ],
            }),
        });

        document.body.append(summary.el, section);
        expect(w1.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(w2.classList.contains('luker-bsum-field-dormant')).toBe(true);

        dormant = ['beta'];
        summary.update();
        expect(w1.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(w2.classList.contains('luker-bsum-field-dormant')).toBe(true);

        dormant = [];
        summary.update();
        expect(w1.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(w2.classList.contains('luker-bsum-field-dormant')).toBe(false);

        summary.destroy();
    });

    test('renders interactive button for onActivate-only token and honors prefers-reduced-motion on local container scroll', () => {
        const parts = renderTemplateParts('Action: ${act}', {
            act: { text: 'Jump', tone: 'accent', onActivate: () => true },
        });
        expect(parts[1].tagName).toBe('BUTTON');
        expect(parts[1].classList.contains('is-readonly')).toBe(false);
        expect(parts[1].hasAttribute('data-bsum-fields')).toBe(false);

        const savedMatchMedia = globalThis.matchMedia;
        globalThis.matchMedia = jest.fn().mockReturnValue({ matches: true });
        try {
            const section = document.createElement('div');
            section.style.overflowY = 'auto';
            Object.defineProperty(section, 'clientHeight', { value: 200, configurable: true });
            Object.defineProperty(section, 'scrollHeight', { value: 800, configurable: true });
            section.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200 });
            section.scrollTo = jest.fn();
            const { wrap, ctl } = makeField('target', 'input', { type: 'text' });
            ctl.getBoundingClientRect = () => ({ top: 420, bottom: 450, left: 0, right: 200, width: 200, height: 30 });
            ctl.scrollIntoView = jest.fn();
            section.appendChild(wrap);

            const summary = createBehaviorSummary({
                scopeEl: section,
                build: () => ({
                    tone: 'active',
                    rows: [{ role: 'Go', template: '${t}', tokens: { t: { text: 'Target', field: 'target' } } }],
                }),
            });
            document.body.append(summary.el, section);

            summary.el.querySelector('[data-bsum-fields="target"]').click();
            expect(section.scrollTo).not.toHaveBeenCalled();
            expect(section.scrollTop).toBe(250);
            expect(ctl.scrollIntoView).not.toHaveBeenCalled();

            summary.destroy();
        } finally {
            globalThis.matchMedia = savedMatchMedia;
        }
    });

    test('mountBehaviorSummary supports before/after/append positions, input refresh, and highlight wrappers', () => {
        const root = document.createElement('div');
        const anchor = document.createElement('div');
        anchor.className = 'anchor';

        const row = document.createElement('div');
        row.className = 'field-row';
        const input = document.createElement('input');
        input.id = 'limit_input';
        input.type = 'number';
        input.value = '10';
        input.scrollIntoView = jest.fn();
        row.appendChild(input);

        root.append(anchor, row);
        document.body.appendChild(root);

        const mounted = mountBehaviorSummary({
            id: 'pos-test',
            root,
            anchor,
            position: 'after',
            fields: { limit: { selector: '#limit_input', highlight: '.field-row' } },
            readState: (el) => Number(el.querySelector('#limit_input')?.value || 0),
            build: (limit) => ({
                tone: limit === 0 ? 'dormant' : 'active',
                dormantFields: limit === 0 ? ['limit'] : [],
                rows: [{
                    role: 'Limit',
                    template: 'Max ${limit}',
                    tokens: { limit: { text: String(limit), tone: limit === 0 ? 'off' : 'on', field: 'limit' } },
                }],
            }),
        });

        expect(anchor.nextElementSibling).toBe(mounted.el);
        expect(mounted.el.querySelector('[data-bsum-fields="limit"]')?.textContent).toBe('10');

        // Hovering #limit_input applies .luker-bsum-field-linked to .field-row (not just input)
        input.dispatchEvent(new Event('pointerenter'));
        expect(row.classList.contains('luker-bsum-field-linked')).toBe(true);
        input.dispatchEvent(new Event('pointerleave'));
        expect(row.classList.contains('luker-bsum-field-linked')).toBe(false);

        // Input event synchronously refreshes summary and marks dormant wrapper
        input.value = '0';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(mounted.el.classList.contains('is-dormant')).toBe(true);
        expect(row.classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Clicking token focuses #limit_input and pulses .field-row
        mounted.el.querySelector('[data-bsum-fields="limit"]').click();
        expect(document.activeElement).toBe(input);
        expect(row.classList.contains('luker-bsum-field-pulse')).toBe(true);

        mounted.destroy();
        expect(row.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(row.classList.contains('luker-bsum-field-pulse')).toBe(false);

        const beforeMount = mountBehaviorSummary({
            id: 'pos-before',
            root,
            anchor,
            position: 'before',
            readState: () => 1,
            build: () => ({ tone: 'active', rows: [] }),
        });
        expect(anchor.previousElementSibling).toBe(beforeMount.el);
        beforeMount.destroy();

        const appendMount = mountBehaviorSummary({
            id: 'pos-append',
            root,
            anchor,
            position: 'append',
            readState: () => 1,
            build: () => ({ tone: 'active', rows: [] }),
        });
        expect(anchor.lastElementChild).toBe(appendMount.el);
        appendMount.destroy();

        expect(() => mountBehaviorSummary({
            id: 'pos-invalid',
            root,
            anchor,
            position: 'inside',
            readState: () => 1,
            build: () => ({ tone: 'active', rows: [] }),
        })).toThrow('invalid mount position');
    });

    test('update() clears stale summaryFocusFields and summaryHoverFields when summary tokens are replaced or removed', () => {
        const section = document.createElement('div');
        const { wrap: alphaWrap, ctl: alphaInput } = makeField('alpha', 'input');
        const { wrap: betaWrap } = makeField('beta', 'input');
        section.append(alphaWrap, betaWrap);

        let label = 'v1';
        let showBeta = false;
        const summary = createBehaviorSummary({
            scopeEl: section,
            build: () => ({
                tone: 'active',
                rows: [
                    {
                        role: 'Field',
                        template: showBeta ? '${b}' : '${a}',
                        tokens: showBeta
                            ? { b: { text: `Beta ${label}`, field: 'beta' } }
                            : { a: { text: `Alpha ${label}`, field: 'alpha' } },
                    },
                ],
            }),
        });

        document.body.append(summary.el, section);

        // 1. Focus on a summary token, then update() replaces the DOM node for the same field.
        const firstTok = summary.el.querySelector('[data-bsum-fields="alpha"]');
        firstTok.focus();
        expect(document.activeElement).toBe(firstTok);
        expect(firstTok.classList.contains('is-hot')).toBe(true);
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);

        label = 'v2';
        summary.update();

        expect(summary.el.contains(document.activeElement)).toBe(false);
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(false);
        expect(summary.el.querySelector('.luker-bsum-tok.is-hot')).toBeNull();
        expect(summary.el.querySelector('.luker-bsum-row.is-row-hot')).toBeNull();

        // 2. Hover on a summary token, then update() removes it; stale summaryHoverFields
        // must not remain stuck or override subsequent focus on another field.
        const secondTok = summary.el.querySelector('[data-bsum-fields="alpha"]');
        secondTok.dispatchEvent(new Event('pointerenter'));
        expect(secondTok.classList.contains('is-hot')).toBe(true);
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);

        showBeta = true;
        summary.update();

        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(false);
        expect(summary.el.querySelector('.luker-bsum-tok.is-hot')).toBeNull();

        // Switching back to alpha must NOT resurrect the stale hover or focus highlight.
        showBeta = false;
        summary.update();
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(false);
        expect(summary.el.querySelector('.luker-bsum-tok.is-hot')).toBeNull();

        // Focusing scope input works cleanly with no stale summaryHoverFields interference.
        alphaInput.focus();
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
        expect(summary.el.querySelector('[data-bsum-fields="alpha"]')?.classList.contains('is-hot')).toBe(true);

        summary.destroy();
    });

    test('update() prunes removed fields from scopeHoverFields so focus highlights remain active', () => {
        const section = document.createElement('div');
        const { wrap: alphaWrap } = makeField('alpha', 'input');
        const { wrap: betaWrap, ctl: betaInput } = makeField('beta', 'input');
        section.append(alphaWrap, betaWrap);

        let includeAlpha = true;
        const summary = createBehaviorSummary({
            scopeEl: section,
            build: () => ({
                tone: 'active',
                rows: [
                    {
                        role: 'Fields',
                        template: includeAlpha ? '${a} ${b}' : '${b}',
                        tokens: includeAlpha
                            ? {
                                a: { text: 'Alpha', field: 'alpha' },
                                b: { text: 'Beta', field: 'beta' },
                            }
                            : {
                                b: { text: 'Beta', field: 'beta' },
                            },
                    },
                ],
            }),
        });

        document.body.append(summary.el, section);

        // Hover alpha, then remove alpha via update() before pointerleave can fire.
        alphaWrap.dispatchEvent(new Event('pointerenter'));
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
        expect(summary.el.querySelector('[data-bsum-fields="alpha"]')?.classList.contains('is-hot')).toBe(true);

        includeAlpha = false;
        summary.update();
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(false);

        // Focusing beta must highlight beta immediately (not locked out by orphaned alpha in scopeHoverFields).
        betaInput.focus();
        expect(betaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
        expect(summary.el.querySelector('[data-bsum-fields="beta"]')?.classList.contains('is-hot')).toBe(true);

        // Re-adding alpha later must not resurrect orphaned hover or lock out focus.
        includeAlpha = true;
        summary.update();
        expect(alphaWrap.classList.contains('luker-bsum-field-linked')).toBe(false);
        expect(betaWrap.classList.contains('luker-bsum-field-linked')).toBe(true);
        expect(summary.el.querySelector('[data-bsum-fields="beta"]')?.classList.contains('is-hot')).toBe(true);

        summary.destroy();
    });

    test('honors SummaryWarning.severity and SummaryRow.tone classes', () => {
        const summary = createBehaviorSummary({
            build: () => ({
                tone: 'warn',
                rows: [
                    { role: 'Off', template: 'Disabled feature', tone: 'off' },
                    { role: 'Warn', template: 'Potential overlap', tone: 'warn' },
                ],
                warnings: [
                    { severity: 'danger', text: 'Critical conflict.' },
                    { severity: 'warn', text: 'Minor caveat.' },
                ],
            }),
        });

        const rows = summary.el.querySelectorAll('.luker-bsum-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].classList.contains('is-off')).toBe(true);
        expect(rows[1].classList.contains('is-warn')).toBe(true);

        const warnings = summary.el.querySelectorAll('.luker-bsum-warn');
        expect(warnings).toHaveLength(2);
        expect(warnings[0].classList.contains('is-danger')).toBe(true);
        expect(warnings[1].classList.contains('is-warn')).toBe(true);

        summary.destroy();
    });
});
