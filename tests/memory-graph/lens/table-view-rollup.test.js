/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import cytoscape from '../../../node_modules/cytoscape/dist/cytoscape.esm.min.mjs';
import { mountMemoryLens } from '../../../public/scripts/extensions/memory-graph/lens/app.js';

function makeSource(snapshotFactory, { updateNode = jest.fn(async () => ({})) } = {}) {
    return {
        load: jest.fn(async () => snapshotFactory()),
        edit: {
            forChat: () => ({
                updateNode,
                createNode: jest.fn(async () => ({})),
                removeNode: jest.fn(async () => ({})),
                addEdge: jest.fn(async () => ({})),
                updateEdge: jest.fn(async () => ({})),
                removeEdge: jest.fn(async () => ({})),
                restore: jest.fn(async () => {}),
            }),
        },
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

function switchTableTab(host, labelText) {
    const tab = [...host.querySelectorAll('.ml-table-head .lw-seg-btn')]
        .find(btn => btn.querySelector('.lw-seg-label')?.textContent === labelText);
    expect(tab).toBeDefined();
    tab.click();
}

describe('Memory Lens table view non-event rollups', () => {
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

    test('renders non-event rollup row with spanning summary cell and leaf row with separate columns', async () => {
        const snap = () => ({
            chatKey: 'chat-table-moment',
            chatLabel: 'Table moment test',
            nodes: [
                {
                    id: 'e_1',
                    type: 'event',
                    level: 'semantic',
                    title: '开场事件',
                    seq_to: 5,
                    fields: { summary: '开场。' },
                },
                {
                    id: 'm_r1',
                    type: 'moment',
                    level: 'semantic',
                    semantic_rollup: true,
                    semantic_depth: 1,
                    title: '灯塔顶层盟约',
                    seq_to: 20,
                    children_ids: ['m_1'],
                    fields: { summary: '两人在灯塔顶层立下长约并交换信物。' },
                },
                {
                    id: 'm_1',
                    type: 'moment',
                    level: 'semantic',
                    title: '交换铜匙',
                    seq_to: 20,
                    fields: { when: '首日入夜', detail: '递出铜匙', meaning: '互信起点' },
                },
            ],
            edges: [],
            schema: {
                types: [
                    { id: 'event', tableColumns: ['summary'] },
                    { id: 'moment', label: '瞬间', tableColumns: ['title', 'when', 'detail', 'meaning'] },
                ],
            },
        });

        lens = mountMemoryLens({ source: makeSource(snap), container: host, opts: { subview: 'table' } });
        await flushAsync();

        switchTableTab(host, '瞬间');

        const rollupRow = host.querySelector('.ml-table tbody tr[data-id="m_r1"]');
        expect(rollupRow).not.toBeNull();
        expect(rollupRow.querySelector('.ml-td-title .ml-tl-tag')).not.toBeNull();
        const rollupBodyCells = [...rollupRow.querySelectorAll('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)')];
        expect(rollupBodyCells).toHaveLength(1);
        expect(rollupBodyCells[0].colSpan).toBe(3);
        expect(rollupBodyCells[0].textContent).toContain('两人在灯塔顶层立下长约并交换信物。');
        expect(rollupBodyCells[0].classList.contains('ml-editable')).toBe(true);

        const leafRow = host.querySelector('.ml-table tbody tr[data-id="m_1"]');
        expect(leafRow).not.toBeNull();
        const leafBodyCells = [...leafRow.querySelectorAll('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)')];
        expect(leafBodyCells).toHaveLength(3);
        expect(leafBodyCells.map(td => td.textContent)).toEqual(['首日入夜', '递出铜匙', '互信起点']);
    });

    test('appends summary column for title-only custom type when visible rows contain a rollup', async () => {
        const snap = () => ({
            chatKey: 'chat-table-tagnote',
            chatLabel: 'Table tag note test',
            nodes: [
                {
                    id: 'tn_r1',
                    type: 'tag_note',
                    level: 'semantic',
                    semantic_rollup: true,
                    semantic_depth: 1,
                    title: '旧标签合集',
                    seq_to: 15,
                    children_ids: ['tn_1'],
                    fields: { summary: '汇总早期线索标记与对应地点。' },
                },
                {
                    id: 'tn_1',
                    type: 'tag_note',
                    level: 'semantic',
                    title: '港口标记',
                    seq_to: 10,
                    fields: { title: '港口标记' },
                },
            ],
            edges: [],
            schema: {
                types: [
                    { id: 'tag_note', label: '标签笔记', tableColumns: ['title'] },
                ],
            },
        });

        lens = mountMemoryLens({ source: makeSource(snap), container: host, opts: { subview: 'table' } });
        await flushAsync();

        switchTableTab(host, '标签笔记');

        expect(host.querySelectorAll('.ml-table thead th')).toHaveLength(4);
        const rollupRow = host.querySelector('.ml-table tbody tr[data-id="tn_r1"]');
        expect(rollupRow).not.toBeNull();
        const rollupBodyCells = [...rollupRow.querySelectorAll('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)')];
        expect(rollupBodyCells).toHaveLength(1);
        expect(rollupBodyCells[0].colSpan).toBe(1);
        expect(rollupBodyCells[0].textContent).toContain('汇总早期线索标记与对应地点。');
    });

    test('dblclick on spanning rollup summary cell opens inline editor and saves updated summary via Ctrl+Enter', async () => {
        const updateNode = jest.fn(async () => ({}));
        const snap = () => ({
            chatKey: 'chat-table-rollup-edit',
            chatLabel: 'Table rollup inline edit test',
            nodes: [
                {
                    id: 'm_r1',
                    type: 'moment',
                    level: 'semantic',
                    semantic_rollup: true,
                    semantic_depth: 1,
                    title: '灯塔顶层盟约',
                    seq_to: 20,
                    children_ids: ['m_1'],
                    fields: { summary: '两人在灯塔顶层立下长约并交换信物。' },
                },
                {
                    id: 'm_1',
                    type: 'moment',
                    level: 'semantic',
                    title: '交换铜匙',
                    seq_to: 20,
                    fields: { when: '首日入夜', detail: '递出铜匙', meaning: '互信起点' },
                },
            ],
            edges: [],
            schema: {
                types: [
                    { id: 'moment', label: '瞬间', tableColumns: ['title', 'when', 'detail', 'meaning'] },
                ],
            },
        });

        lens = mountMemoryLens({ source: makeSource(snap, { updateNode }), container: host, opts: { subview: 'table' } });
        await flushAsync();

        switchTableTab(host, '瞬间');

        const rollupRow = host.querySelector('.ml-table tbody tr[data-id="m_r1"]');
        expect(rollupRow).not.toBeNull();
        const summaryCell = rollupRow.querySelector('td:not(.ml-td-title):not(.ml-td-num):not(.ml-td-ctx)');
        expect(summaryCell).not.toBeNull();
        expect(summaryCell.colSpan).toBe(3);

        summaryCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const editor = summaryCell.querySelector('textarea.ml-inline-input');
        expect(editor).not.toBeNull();
        editor.value = '修改后的阶段聚合摘要。';
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        await flushAsync();

        expect(updateNode).toHaveBeenCalledTimes(1);
        expect(updateNode).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'm_r1' }),
            { fields: { summary: '修改后的阶段聚合摘要。' } },
        );
    });
});
