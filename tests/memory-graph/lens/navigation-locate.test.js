/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import cytoscape from '../../../node_modules/cytoscape/dist/cytoscape.esm.min.mjs';
import { mountMemoryLens } from '../../../public/scripts/extensions/memory-graph/lens/app.js';
import { createMockSnapshot } from './_mocks/mock-data.js';

function makeFakeSource(snapshotFactory = createMockSnapshot) {
    return {
        load: jest.fn(async () => snapshotFactory()),
        settings: {
            read: () => ({
                values: {},
                options: { connections: [], presets: [], positions: {}, roles: {}, compressibleTypes: [] },
                advanced: { values: {}, defaults: {}, scope: 'global', hasAvatar: false, hasOverride: false, avatar: '', characterName: '' },
            }),
            set: (_k, v) => v,
            subscribe: () => () => {},
        },
        schema: {
            read: async () => ({
                avatar: '',
                hasAvatar: false,
                characterName: '',
                hasOverride: false,
                scope: 'global',
                types: createMockSnapshot().schema.types,
            }),
        },
        ops: {
            status: () => '',
            onStatus: () => () => {},
            stats: () => ({ nodeCount: 0, edgeCount: 0, messageCount: 0, sourceMessageCount: 0, levelCount: { semantic: 0 } }),
        },
    };
}

async function flushAsync() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

function searchAndClick(host, query, expectedTitle) {
    const searchBtn = host.querySelector('.ml-searchbtn') || [...host.querySelectorAll('.ml-bn-btn')].find(btn => btn.textContent.includes('搜索'));
    expect(searchBtn).not.toBeNull();
    searchBtn.click();
    const input = host.querySelector('.ml-palette-input');
    expect(input).not.toBeNull();
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const options = [...host.querySelectorAll('.ml-palette-item[role="option"]')];
    const target = options.find(opt => opt.querySelector('.ml-palette-title')?.textContent?.includes(expectedTitle));
    expect(target).toBeDefined();
    target.click();
}

describe('Memory Lens search & locate view navigation', () => {
    let lens = null;
    let host = null;
    let animateCalls = [];
    let origCytoscape;
    let origScrollIntoView;
    let origGetBoundingClientRect;

    function stubLocalScroll(scroller, targetSelector) {
        Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
        Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
        scroller.scrollTop = 0;
        scroller.scrollTo = jest.fn(({ top }) => { scroller.scrollTop = top; });
        Element.prototype.getBoundingClientRect = function () {
            if (this === scroller) return { top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200 };
            if (this.matches?.(targetSelector)) {
                const top = 450 - scroller.scrollTop;
                return { top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40 };
            }
            return origGetBoundingClientRect.call(this);
        };
    }

    beforeEach(() => {
        document.body.innerHTML = '';
        if (typeof globalThis.structuredClone !== 'function') {
            globalThis.structuredClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
        }
        globalThis.localStorage?.clear?.();
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        animateCalls = [];
        origScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = jest.fn();
        origGetBoundingClientRect = Element.prototype.getBoundingClientRect;

        origCytoscape = globalThis.cytoscape;
        // Real Cytoscape instance in headless mode (jsdom has no canvas 2D context),
        // spying on animate() to observe locate() pan/zoom calls.
        globalThis.cytoscape = (opts) => {
            const cy = cytoscape({ ...opts, container: undefined, headless: true });
            const origAnimate = cy.animate.bind(cy);
            cy.animate = (spec, animOpts) => {
                animateCalls.push({ spec, animOpts });
                return origAnimate(spec, animOpts);
            };
            return cy;
        };

        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        lens?.destroy?.();
        lens = null;
        if (origCytoscape === undefined) delete globalThis.cytoscape;
        else globalThis.cytoscape = origCytoscape;
        Element.prototype.scrollIntoView = origScrollIntoView;
        Element.prototype.getBoundingClientRect = origGetBoundingClientRect;
    });

    test('searching and clicking a character node from timeline switches to graph and locates it', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'timeline' } });
        await flushAsync();
        expect(lens.app.state().view).toBe('timeline');
        expect(host.querySelector('.ml-view[data-view="timeline"]').hidden).toBe(false);
        expect(host.querySelector('.ml-view[data-view="graph"]').hidden).toBe(true);

        searchAndClick(host, '林栖', '林栖');
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(lens.app.state().selectedId).toBe('c_lin');
        expect(host.querySelector('.ml-view[data-view="graph"]').hidden).toBe(false);
        expect(host.querySelector('.ml-view[data-view="timeline"]').hidden).toBe(true);
        // Must actually locate (zoom >= 1.1) even though graph was lazily initialized on view switch.
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching and clicking a character node from timeline in compact mode closes drawer, switches to graph, and locates it', async () => {
        const hostApp = { isCompact: () => true, toast: jest.fn() };
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, hostApp, opts: { subview: 'timeline' } });
        await flushAsync();
        expect(lens.app.state().compact).toBe(true);
        expect(lens.app.state().view).toBe('timeline');

        searchAndClick(host, '温澜', '温澜');
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(lens.app.state().selectedId).toBe('c_wen');
        expect(lens.app.state().drawer).toBe('');
        expect(host.querySelector('.ml-view[data-view="graph"]').hidden).toBe(false);
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching a visible event from timeline stays in timeline, expands collapsed chapters, and scrolls to card', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'timeline' } });
        await flushAsync();

        const scroller = host.querySelector('.ml-tl-scroll');
        stubLocalScroll(scroller, '.ml-tl-card[data-id="e01"]');

        // Collapse top-level chapter r2_a so e01 is hidden inside it.
        const toggle = host.querySelector('.ml-tl-chapter .ml-tl-toggle');
        expect(toggle).not.toBeNull();
        toggle.click();
        expect(host.querySelector('.ml-tl-card[data-id="e01"]')).toBeNull();

        searchAndClick(host, '雾夜里的求救信号', '雾夜里的求救信号');
        await flushAsync();

        expect(lens.app.state().view).toBe('timeline');
        expect(lens.app.state().selectedId).toBe('e01');
        const card = host.querySelector('.ml-tl-card[data-id="e01"]');
        expect(card).not.toBeNull();
        expect(card.getAttribute('aria-selected')).toBe('true');
        expect(scroller.scrollTop).toBe(290);
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });

    test('searching an event excluded by timeline focusEntityId switches to graph and locates it', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'timeline' } });
        await flushAsync();

        // Focus timeline on 小满 (only e10 and e15 appear in timeline).
        lens.app.focusEntity('c_xiao');
        expect(host.querySelector('.ml-tl-card[data-id="e01"]')).toBeNull();

        searchAndClick(host, '雾夜里的求救信号', '雾夜里的求救信号');
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(lens.app.state().selectedId).toBe('e01');
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching any node from schema or settings full-view switches to graph and locates it', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'settings' } });
        await flushAsync();
        expect(lens.app.state().view).toBe('settings');
        expect(host.querySelector('.mlens').classList.contains('is-full-view')).toBe(true);

        searchAndClick(host, '林栖', '林栖');
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(lens.app.state().selectedId).toBe('c_lin');
        expect(host.querySelector('.mlens').classList.contains('is-full-view')).toBe(false);
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching a character node from table stays in table, switches type tab, and scrolls to row', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'table' } });
        await flushAsync();

        const scroller = host.querySelector('.ml-table-scroll');
        stubLocalScroll(scroller, '.ml-table tr[data-id="c_wen"]');

        searchAndClick(host, '温澜', '温澜');
        await flushAsync();

        expect(lens.app.state().view).toBe('table');
        expect(lens.app.state().selectedId).toBe('c_wen');
        const row = host.querySelector('.ml-table tr[data-id="c_wen"]');
        expect(row).not.toBeNull();
        expect(row.getAttribute('aria-selected')).toBe('true');
        expect(scroller.scrollTop).toBe(290);
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });

    test('clicking "Locate in graph" in inspector switches from timeline or table to graph and locates node', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'timeline' } });
        await flushAsync();

        // Click an event card on timeline, then click "在图谱中定位" in inspector.
        const eventCard = host.querySelector('.ml-tl-card[data-id="e13"]');
        expect(eventCard).not.toBeNull();
        eventCard.click();
        expect(lens.app.state().selectedId).toBe('e13');
        expect(lens.app.state().view).toBe('timeline');

        const locateBtn = host.querySelector('.ml-inspector button[aria-label="在图谱中定位"]');
        expect(locateBtn).not.toBeNull();
        locateBtn.click();
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);

        // Also verify from table view.
        animateCalls.length = 0;
        lens.app.setState({ view: 'table' });
        const row = host.querySelector('.ml-table tr[data-id="e13"]');
        expect(row).not.toBeNull();
        const locateBtn2 = host.querySelector('.ml-inspector button[aria-label="在图谱中定位"]');
        locateBtn2.click();
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching a loose event beyond initial timeline page expands loose list and stays on timeline', async () => {
        const bigSnap = () => {
            const snap = createMockSnapshot();
            for (let i = 0; i < 95; i++) {
                snap.nodes.push({
                    id: `loose_extra_${i}`,
                    type: 'event',
                    level: 'semantic',
                    title: `远期散落事件 ${i}`,
                    fields: { summary: `时间: 第 ${i} 天\n地点: 北码头\n\n事件正文 ${i}` },
                    seq_to: 100 + i,
                    semantic_depth: 0,
                });
            }
            return snap;
        };
        lens = mountMemoryLens({ source: makeFakeSource(bigSnap), container: host, opts: { subview: 'timeline' } });
        await flushAsync();
        expect(host.querySelector('.ml-tl-card[data-id="loose_extra_90"]')).toBeNull();

        searchAndClick(host, '远期散落事件 90', '远期散落事件 90');
        await flushAsync();

        expect(lens.app.state().view).toBe('timeline');
        const card = host.querySelector('.ml-tl-card[data-id="loose_extra_90"]');
        expect(card).not.toBeNull();
        expect(card.getAttribute('aria-selected')).toBe('true');
    });

    test('switching from graph to timeline and searching a character switches back to graph and locates it with warm cytoscape', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'graph' } });
        await flushAsync();
        expect(lens.app.state().view).toBe('graph');

        // User switches to timeline tab via topbar segmented control.
        const timelineTab = [...host.querySelectorAll('.ml-viewswitch .lw-seg-btn')].find(btn => btn.textContent.includes('时间线'));
        expect(timelineTab).toBeDefined();
        timelineTab.click();
        expect(lens.app.state().view).toBe('timeline');

        animateCalls.length = 0;
        searchAndClick(host, '沈既白', '沈既白');
        await flushAsync();

        expect(lens.app.state().view).toBe('graph');
        expect(lens.app.state().selectedId).toBe('c_shen');
        expect(host.querySelector('.ml-view[data-view="graph"]').hidden).toBe(false);
        expect(animateCalls.some(call => typeof call.spec?.zoom === 'number' && call.spec.zoom >= 1.1)).toBe(true);
    });

    test('searching an already-selected character after switching table type sub-tab returns to its table row', async () => {
        lens = mountMemoryLens({ source: makeFakeSource(), container: host, opts: { subview: 'table' } });
        await flushAsync();

        searchAndClick(host, '温澜', '温澜');
        await flushAsync();
        expect(lens.app.state().selectedId).toBe('c_wen');
        expect(host.querySelector('.ml-table tr[data-id="c_wen"]')).not.toBeNull();

        // Switch table sub-tab to Event while c_wen remains selected.
        const eventSubTab = [...host.querySelectorAll('.ml-table-head .lw-seg-btn')].find(btn => btn.textContent.includes('事件'));
        expect(eventSubTab).toBeDefined();
        eventSubTab.click();
        expect(host.querySelector('.ml-table tr[data-id="c_wen"]')).toBeNull();

        // Search and click the same character again -> table.locate() switches sub-tab back and scrolls.
        const scroller = host.querySelector('.ml-table-scroll');
        stubLocalScroll(scroller, '.ml-table tr[data-id="c_wen"]');
        Element.prototype.scrollIntoView.mockClear();
        searchAndClick(host, '温澜', '温澜');
        await flushAsync();

        expect(lens.app.state().view).toBe('table');
        const row = host.querySelector('.ml-table tr[data-id="c_wen"]');
        expect(row).not.toBeNull();
        expect(row.getAttribute('aria-selected')).toBe('true');
        expect(scroller.scrollTop).toBe(290);
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });
});
