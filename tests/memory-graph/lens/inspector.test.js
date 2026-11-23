/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import cytoscape from '../../../node_modules/cytoscape/dist/cytoscape.esm.min.mjs';
import { mountMemoryLens } from '../../../public/scripts/extensions/memory-graph/lens/app.js';

function makeSource(snapshotFactory, { editable = true } = {}) {
    const editFns = editable
        ? {
            forChat: () => ({
                updateNode: jest.fn(async () => ({})),
                createNode: jest.fn(async () => ({})),
                removeNode: jest.fn(async () => ({})),
                addEdge: jest.fn(async () => ({})),
                updateEdge: jest.fn(async () => ({})),
                removeEdge: jest.fn(async () => ({})),
                restore: jest.fn(async () => {}),
            }),
        }
        : null;
    return {
        load: jest.fn(async () => snapshotFactory()),
        ...(editFns ? { edit: editFns } : {}),
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
                types: [],
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

function makeThreadMultiEdgeSnapshot() {
    return {
        chatKey: 'chat-multi-edge',
        chatLabel: 'Multi-edge test',
        nodes: [
            { id: 't_1', type: 'thread', level: 'semantic', title: '航线争夺', seq_to: 50, fields: { status: 'active', note: '轮替值守' } },
            { id: 'e_1', type: 'event', level: 'semantic', title: '初次交锋', seq_to: 20, fields: { summary: '时间: 首日\n地点: 山谷\n\n初次交锋。' } },
            { id: 'e_2', type: 'event', level: 'semantic', title: '定下轮替', seq_to: 30, fields: { summary: '时间: 次日\n地点: 偏厅\n\n定下轮替。' } },
            { id: 'e_3', type: 'event', level: 'semantic', title: '夜间突袭', seq_to: 50, fields: { summary: '时间: 三日\n地点: 码头\n\n夜间突袭。' } },
        ],
        edges: [
            { from: 'e_1', to: 't_1', type: 'advances' },
            { from: 'e_2', to: 't_1', type: 'advances' },
            { from: 'e_2', to: 't_1', type: 'updates' },
            { from: 'e_3', to: 't_1', type: 'advances' },
            { from: 't_1', to: 'e_3', type: 'advances' },
            { from: 'e_3', to: 't_1', type: 'updates' },
            { from: 't_1', to: 'e_3', type: 'updates' },
        ],
        schema: {
            types: [
                { id: 'event', tableColumns: ['summary'] },
                { id: 'thread', tableColumns: ['title', 'status', 'note'] },
            ],
        },
    };
}

function makeManyEventsSnapshot(count = 15) {
    const nodes = [
        { id: 't_long', type: 'thread', level: 'semantic', title: '长线任务', seq_to: count * 10, fields: { status: 'active', note: '持续推进' } },
    ];
    const edges = [];
    for (let i = 1; i <= count; i++) {
        const id = `e_${i}`;
        nodes.push({
            id,
            type: 'event',
            level: 'semantic',
            title: `阶段事件 ${i}`,
            seq_to: i * 10,
            fields: { summary: `时间: 第 ${i} 日\n地点: 营地\n\n阶段事件 ${i}。` },
        });
        edges.push({ from: id, to: 't_long', type: 'advances' });
        if (i % 2 === 0) edges.push({ from: id, to: 't_long', type: 'updates' });
    }
    return {
        chatKey: 'chat-many-events',
        chatLabel: 'Many events test',
        nodes,
        edges,
        schema: {
            types: [
                { id: 'event', tableColumns: ['summary'] },
                { id: 'thread', tableColumns: ['title', 'status', 'note'] },
            ],
        },
    };
}

describe('Memory Lens inspector entity events view', () => {
    let lens = null;
    let host = null;
    let origCytoscape;
    let origScrollIntoView;

    beforeEach(() => {
        document.body.innerHTML = '';
        if (typeof globalThis.structuredClone !== 'function') {
            globalThis.structuredClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
        }
        globalThis.localStorage?.clear?.();
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        origScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = jest.fn();
        origCytoscape = globalThis.cytoscape;
        globalThis.cytoscape = (opts) => cytoscape({ ...opts, container: undefined, headless: true });

        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        lens?.destroy?.();
        lens = null;
        if (origCytoscape === undefined) delete globalThis.cytoscape;
        else globalThis.cytoscape = origCytoscape;
        Element.prototype.scrollIntoView = origScrollIntoView;
    });

    test('deduplicates events with multiple relation edges and displays aggregated relation tags', async () => {
        lens = mountMemoryLens({ source: makeSource(makeThreadMultiEdgeSnapshot), container: host, opts: { subview: 'graph' } });
        await flushAsync();

        lens.app.select('t_1');
        const items = [...host.querySelectorAll('.ml-insp-eventlist > li')];
        expect(items.length).toBe(3);

        const sectionTitles = [...host.querySelectorAll('.ml-insp-block .lw-sec-title')].map(el => el.textContent);
        expect(sectionTitles.some(text => text.includes('事件 · 3'))).toBe(true);

        const rows = items.map(li => ({
            title: li.querySelector('.ml-nodelink-title')?.textContent,
            tags: [...li.querySelectorAll('.ml-nodelink-tags .ml-tag-muted')].map(el => el.textContent),
            meta: li.querySelector('.ml-nodelink-meta')?.textContent,
        }));
        expect(rows).toEqual([
            { title: '夜间突袭', tags: ['推进', '更新'], meta: '第 50 轮' },
            { title: '定下轮替', tags: ['推进', '更新'], meta: '第 30 轮' },
            { title: '初次交锋', tags: ['推进'], meta: '第 20 轮' },
        ]);
    });

    test('provides View in timeline action for threads and focuses timeline on the thread', async () => {
        lens = mountMemoryLens({ source: makeSource(makeThreadMultiEdgeSnapshot), container: host, opts: { subview: 'graph' } });
        await flushAsync();

        lens.app.select('t_1');
        const timelineBtn = [...host.querySelectorAll('.ml-insp-block .ml-linkbtn')].find(btn => btn.textContent.includes('在时间线中查看'));
        expect(timelineBtn).toBeDefined();

        timelineBtn.click();
        expect(lens.app.state().view).toBe('timeline');
        expect(lens.app.state().filters.focusEntityId).toBe('t_1');
    });

    test('expands beyond 12 unique linked events when clicking Show more', async () => {
        lens = mountMemoryLens({ source: makeSource(() => makeManyEventsSnapshot(15)), container: host, opts: { subview: 'graph' } });
        await flushAsync();

        lens.app.select('t_long');
        expect(host.querySelectorAll('.ml-insp-eventlist > li').length).toBe(12);

        const showMoreBtn = [...host.querySelectorAll('.ml-insp-block button')].find(btn => btn.textContent.includes('显示更多'));
        expect(showMoreBtn).toBeDefined();
        expect(showMoreBtn.textContent).toContain('3');

        showMoreBtn.click();
        expect(host.querySelectorAll('.ml-insp-eventlist > li').length).toBe(15);
        expect([...host.querySelectorAll('.ml-insp-block button')].some(btn => btn.textContent.includes('显示更多'))).toBe(false);
    });

    test('clicking the header degree chip opens the Relationships modal when editable', async () => {
        lens = mountMemoryLens({ source: makeSource(makeThreadMultiEdgeSnapshot, { editable: true }), container: host, opts: { subview: 'graph' } });
        await flushAsync();

        lens.app.select('t_1');
        const degreeBtn = [...host.querySelectorAll('.ml-insp-meta button.ml-chip-btn')].find(btn => btn.title === '关系');
        expect(degreeBtn).toBeDefined();
        expect(degreeBtn.textContent).toContain('5');

        degreeBtn.click();
        expect(host.querySelector('.ml-edge-list')).not.toBeNull();
    });

    test('renders degree chip as non-interactive span in read-only mode and deduplicates location multi-edges', async () => {
        const snap = () => ({
            chatKey: 'chat-readonly',
            chatLabel: 'Read-only test',
            nodes: [
                { id: 'loc_1', type: 'location_state', level: 'semantic', title: '外围洞府', seq_to: 20, fields: { state: '已弃置' } },
                { id: 'e_1', type: 'event', level: 'semantic', title: '初入洞府', seq_to: 10, fields: { summary: '初入洞府。' } },
                { id: 'e_2', type: 'event', level: 'semantic', title: '离开洞府', seq_to: 20, fields: { summary: '离开洞府。' } },
            ],
            edges: [
                { from: 'e_1', to: 'loc_1', type: 'occurred_at' },
                { from: 'e_1', to: 'loc_1', type: 'related' },
                { from: 'e_2', to: 'loc_1', type: 'occurred_at' },
            ],
            schema: {
                types: [
                    { id: 'event', tableColumns: ['summary'] },
                    { id: 'location_state', tableColumns: ['title', 'state'] },
                ],
            },
        });
        lens = mountMemoryLens({ source: makeSource(snap, { editable: false }), container: host, opts: { subview: 'graph' } });
        await flushAsync();

        lens.app.select('loc_1');
        expect(host.querySelector('.ml-insp-meta button[title="关系"]')).toBeNull();
        const degreeSpan = host.querySelector('.ml-insp-meta span.ml-chip[title="关系"]');
        expect(degreeSpan).not.toBeNull();
        expect(degreeSpan.textContent).toContain('3');

        const rows = [...host.querySelectorAll('.ml-insp-eventlist > li')].map(li => ({
            title: li.querySelector('.ml-nodelink-title')?.textContent,
            tags: [...li.querySelectorAll('.ml-nodelink-tags .ml-tag-muted')].map(el => el.textContent),
        }));
        expect(rows).toEqual([
            { title: '离开洞府', tags: ['发生于'] },
            { title: '初入洞府', tags: ['发生于', '相关'] },
        ]);
    });
});
