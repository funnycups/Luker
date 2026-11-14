import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import {
    buildModel, parseEventSummary, isPlaceholderTitle, searchNodes, visibleSubgraph, buildChapters,
    defaultFilters, neighborsOf, entitiesOfEvent, contextState, formatFloor, isDefaultFilters,
} from '../../../public/scripts/extensions/memory-graph/lens/model.js';
import { forceLayout, chronoLayout, nodeRadius } from '../../../public/scripts/extensions/memory-graph/lens/graph/layout.js';
import { createMockSnapshot, createLargeSnapshot } from './_mocks/mock-data.js';

test('parseEventSummary extracts anchors, prose and optional sections', () => {
    const parsed = parseEventSummary([
        '时间: 霜月三日 深夜',
        '地点：第七灯塔',
        '',
        '第一段。',
        '仍是第一段。',
        '',
        '第二段。',
        '',
        '不可逆:',
        '- 叶舟左腿留下长疤',
        '',
        '未结:',
        '- → thread "父亲的航海日志能否找到"',
        '- 普通未结项',
        '',
        '原文摘录:',
        '- 林栖: "三短，是父亲的暗号。"',
    ].join('\n'));
    expect(parsed.time).toBe('霜月三日 深夜');
    expect(parsed.place).toBe('第七灯塔');
    expect(parsed.prose).toEqual(['第一段。\n仍是第一段。', '第二段。']);
    expect(parsed.irreversible).toEqual(['叶舟左腿留下长疤']);
    expect(parsed.open[0].threadTitle).toBe('父亲的航海日志能否找到');
    expect(parsed.open[1].threadTitle).toBe(undefined);
    expect(parsed.open[1].text).toBe('普通未结项');
    expect(parsed.quotes).toEqual([{ label: '林栖', quote: '三短，是父亲的暗号。' }]);
});

test('parseEventSummary tolerates free-form text', () => {
    const parsed = parseEventSummary('Just a plain summary without headers.');
    expect(parsed.time).toBe('');
    expect(parsed.prose).toEqual(['Just a plain summary without headers.']);
    expect(parseEventSummary(null).prose).toEqual([]);
});

test('buildModel indexes nodes, edges, hierarchy and injection', () => {
    const model = buildModel(createMockSnapshot());
    expect(model.nodes.size > 30).toBeTruthy();
    expect(model.typeList[0]).toBe('event');
    const rollup = model.nodes.get('r2_a');
    expect(rollup.isRollup).toBe(true);
    expect(rollup.depth).toBe(2);
    expect(model.nodes.get('r1_a').parentId).toBe('r2_a');
    expect(model.nodes.get('e01').parentId).toBe('r1_a');
    expect(model.nodes.get('e01').parsed.place).toBe('第七灯塔');
    expect(contextState(model, 'e13')).toBe('recalled');
    expect(contextState(model, 't_log')).toBe('pinned');
    expect(contextState(model, 'e01')).toBe('');
    expect(formatFloor(model.nodes.get('e01'))).toBe('第 1–4 楼');
});

test('buildModel drops dangling edges, recall diagnostics and self loops', () => {
    const model = buildModel({
        nodes: [
            { id: 'a', type: 'character_sheet', title: 'A' },
            { id: 'b', type: 'character_sheet', title: 'B' },
            { id: 'r', type: 'recall_trace', title: 'diag' },
        ],
        edges: [
            { from: 'a', to: 'b', type: 'allied_with' },
            { from: 'a', to: 'missing', type: 'related' },
            { from: 'a', to: 'a', type: 'related' },
            { from: 'a', to: 'r', type: 'related' },
        ],
    });
    expect(model.nodes.size).toBe(2);
    expect(model.edges.length).toBe(1);
    expect(model.edges[0].directed).toBe(false);
    expect(model.edges[0].category).toBe('bond');
    expect(model.nodes.get('a').degree).toBe(1);
});

test('mirrored edge pairs collapse into one undirected edge', () => {
    const model = buildModel({
        nodes: [
            { id: 'ev', type: 'event', title: 'E', fields: {} },
            { id: 'c', type: 'character_sheet', title: 'C' },
            { id: 'd', type: 'character_sheet', title: 'D' },
        ],
        edges: [
            { from: 'ev', to: 'c', type: 'involved_in' },
            { from: 'c', to: 'ev', type: 'involved_in' },
            { from: 'ev', to: 'c', type: 'involved_in' },
            { from: 'c', to: 'd', type: 'mentor_of' },
        ],
    });
    expect(model.edges.length).toBe(2);
    const involve = model.edges.find(e => e.type === 'involved_in');
    expect(involve.directed).toBe(false);
    expect(model.edges.find(e => e.type === 'mentor_of').directed).toBe(true);
    expect(model.nodes.get('ev').degree).toBe(1);
    expect(neighborsOf(model, 'c').length).toBe(2);
});

test('event titles fall back to the first prose sentence', () => {
    const model = buildModel({ nodes: [{ id: 'x', type: 'event', fields: { summary: '时间: 早上\n地点: 港口\n\n林栖醒来。然后出门。' } }] });
    expect(model.nodes.get('x').title).toBe('林栖醒来。');
});

test('auto-generated event titles are replaced, real ones kept', () => {
    expect(isPlaceholderTitle('Summary 1')).toBeTruthy();
    expect(isPlaceholderTitle('摘要 12')).toBeTruthy();
    expect(isPlaceholderTitle('event Summary L1 #3')).toBeTruthy();
    expect(isPlaceholderTitle('Event Summary L2 #10')).toBeTruthy();
    expect(!isPlaceholderTitle('Summary of the battle')).toBeTruthy();
    expect(!isPlaceholderTitle('第一卷总结')).toBeTruthy();
    const model = buildModel({ nodes: [
        { id: 'a', type: 'event', title: 'Summary 4', fields: { summary: 'Time: dusk Place: Glade Seraphina found the traveler. Then left.' } },
        { id: 'b', type: 'event', title: '雾夜里的求救信号', fields: { summary: '…' } },
        { id: 'c', type: 'character_sheet', title: 'Summary 1', fields: {} },
    ] });
    expect(model.nodes.get('a').title).toBe('Seraphina found the traveler.');
    expect(model.nodes.get('a').autoTitle).toBe('Summary 4');
    expect(model.nodes.get('b').title).toBe('雾夜里的求救信号');
    expect(model.nodes.get('c').title).toBe('Summary 1');
});

test('flattened summaries (whitespace-collapsed by memory-graph) still parse', () => {
    const flat = '时间: 霜月三日 深夜 地点: 第七灯塔 林栖在例行巡灯时看到海面上闪了三下红光。她独自记下了方位。 不可逆: - 叶舟左腿留下长疤 - 灯塔地下室被打开 未结: - → thread "父亲的航海日志能否找到" 原文摘录: - 林栖: "三短，是父亲的暗号。"';
    const parsed = parseEventSummary(flat);
    expect(parsed.time).toBe('霜月三日 深夜');
    expect(parsed.place).toBe('第七灯塔');
    expect(parsed.prose.length).toBe(1);
    expect(parsed.prose[0].startsWith('林栖在例行巡灯时')).toBeTruthy();
    expect(parsed.irreversible).toEqual(['叶舟左腿留下长疤', '灯塔地下室被打开']);
    expect(parsed.open[0].threadTitle).toBe('父亲的航海日志能否找到');
    expect(parsed.quotes).toEqual([{ label: '林栖', quote: '三短，是父亲的暗号。' }]);

    const en = parseEventSummary('Time: dusk Place: Eldoria Glade Seraphina found the traveler collapsed near the glade. 不可逆: - The traveler now knows the glade location');
    expect(en.time).toBe('dusk');
    expect(en.place).toBe('Eldoria Glade');
    expect(en.prose[0]).toBe('Seraphina found the traveler collapsed near the glade.');
    expect(en.irreversible).toEqual(['The traveler now knows the glade location']);

    const plain = parseEventSummary('A plain one-line summary - with a dash inside.');
    expect(plain.time).toBe('');
    expect(plain.prose.length).toBe(1);
});

test('neighbors and event entities', () => {
    const model = buildModel(createMockSnapshot());
    const { characters, locations } = entitiesOfEvent(model, 'e14');
    expect(characters.map(c => c.id).sort()).toEqual(['c_lin', 'c_mo', 'c_qiao', 'c_wen']);
    expect(locations.map(l => l.id)).toEqual(['l_guild']);
    const linNeighbors = neighborsOf(model, 'c_lin');
    expect(linNeighbors.some(n => n.node.id === 'c_wen' && n.direction === 'both')).toBeTruthy();
    expect(linNeighbors.some(n => n.node.id === 'c_gu' && n.edge.type === 'deceiving' && n.direction === 'in')).toBeTruthy();
    expect(!neighborsOf(model, 'r1_a').some(n => n.edge.internal)).toBeTruthy();
});

test('filters: types, depth, archived, context, hierarchy', () => {
    const model = buildModel(createMockSnapshot());
    const filters = defaultFilters();
    expect(isDefaultFilters(filters)).toBeTruthy();
    const all = visibleSubgraph(model, filters);
    expect(!all.ids.has('c_lin_old')).toBeTruthy();
    expect(all.edges.some(e => e.internal)).toBeTruthy();

    const noEvents = visibleSubgraph(model, { ...filters, hiddenTypes: new Set(['event']) });
    expect([...noEvents.nodes].every(n => n.type !== 'event')).toBeTruthy();

    const leaves = visibleSubgraph(model, { ...filters, depth: 'leaf' });
    expect(leaves.nodes.every(n => !n.isRollup)).toBeTruthy();

    const ctx = visibleSubgraph(model, { ...filters, onlyContext: true });
    expect(ctx.nodes.length > 0 && ctx.nodes.every(n => model.injection.recalled.has(n.id) || model.injection.pinned.has(n.id))).toBeTruthy();

    const flat = visibleSubgraph(model, { ...filters, showHierarchy: false });
    expect(flat.edges.every(e => !e.internal)).toBeTruthy();
    const noAllies = visibleSubgraph(model, { ...filters, hiddenRelations: new Set(['allied_with']) });
    expect(noAllies.edges.every(e => e.type !== 'allied_with')).toBeTruthy();
});

test('visibleSubgraph caps size and keeps newest', () => {
    const model = buildModel(createLargeSnapshot(700));
    const sub = visibleSubgraph(model, defaultFilters(), { maxNodes: 200 });
    expect(sub.nodes.length).toBe(200);
    expect(sub.truncated).toBe(true);
    expect(sub.ids.has('bulk_699')).toBeTruthy();
    expect(!sub.ids.has('bulk_0')).toBeTruthy();
});

test('buildChapters nests rollups and collects loose leaves', () => {
    const model = buildModel(createMockSnapshot());
    const { chapters, loose } = buildChapters(model, defaultFilters());
    expect(chapters.length).toBe(1);
    expect(chapters[0].node.id).toBe('r2_a');
    expect(chapters[0].children.length).toBe(4);
    expect(chapters[0].leafCount).toBe(12);
    expect(loose.map(t => t.node.id)).toEqual(['e13', 'e14', 'e15', 'e16']);

    const focused = buildChapters(model, { ...defaultFilters(), focusEntityId: 'c_xiao' });
    const ids = [];
    const walk = (tree) => { if (!tree.node.isRollup) ids.push(tree.node.id); tree.children.forEach(walk); };
    focused.chapters.forEach(walk);
    focused.loose.forEach(walk);
    expect(ids.sort()).toEqual(['e10', 'e15']);
});

test('searchNodes ranks title matches first', () => {
    const model = buildModel(createMockSnapshot());
    const hits = searchNodes(model, '灯塔');
    expect(hits[0].node.title.includes('灯塔')).toBe(true);
    expect(searchNodes(model, '').length).toBe(0);
    expect(searchNodes(model, 'c_wen')[0].node.id).toBe('c_wen');
    expect(searchNodes(model, '林栖 罗盘').every(h => h.node.searchText.includes('罗盘'))).toBeTruthy();
});

test('layouts are deterministic and finite', () => {
    const model = buildModel(createMockSnapshot());
    const sub = visibleSubgraph(model, defaultFilters());
    const a = forceLayout(sub.nodes, sub.edges);
    const b = forceLayout(sub.nodes, sub.edges);
    expect(a.size).toBe(sub.nodes.length);
    for (const [id, pos] of a) {
        expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBeTruthy();
        expect(pos).toEqual(b.get(id));
    }
    const chrono = chronoLayout(sub.nodes, sub.edges);
    expect(chrono.size).toBe(sub.nodes.length);
    expect(chrono.get('e01').x < chrono.get('e12').x).toBeTruthy();
    expect(chrono.get('r2_a').y < chrono.get('r1_a').y).toBeTruthy();
    expect(chrono.get('c_lin').y > 0).toBeTruthy();
});

test('chrono layout never overlaps nodes', () => {
    const model = buildModel(createMockSnapshot());
    const sub = visibleSubgraph(model, defaultFilters());
    const pos = chronoLayout(sub.nodes, sub.edges);
    const list = sub.nodes.map(node => ({ node, p: pos.get(node.id), r: nodeRadius(node) }));
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const dist = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
            expect(dist >= a.r + b.r).toBeTruthy();
        }
    }
});

test('force layout warm start keeps existing nodes stable and seeds new ones nearby', () => {
    const model = buildModel(createMockSnapshot());
    const sub = visibleSubgraph(model, defaultFilters());
    const first = forceLayout(sub.nodes, sub.edges);
    const extra = { id: 'new_c', type: 'character_sheet', title: 'New', degree: 1, isRollup: false, depth: 0 };
    const nodes = [...sub.nodes, extra];
    const edges = [...sub.edges, { from: 'new_c', to: 'c_lin', type: 'allied_with', internal: false }];
    const second = forceLayout(nodes, edges, { initial: first });
    let maxShift = 0;
    for (const node of sub.nodes) {
        const a = first.get(node.id);
        const b = second.get(node.id);
        maxShift = Math.max(maxShift, Math.hypot(a.x - b.x, a.y - b.y));
    }
    expect(maxShift < 120).toBeTruthy();
    // "Near" relative to the drawing: well inside a third of its extent.
    const xs = [...first.values()].map(p => p.x);
    const ys = [...first.values()].map(p => p.y);
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const lin = second.get('c_lin');
    const added = second.get('new_c');
    const dist = Math.hypot(lin.x - added.x, lin.y - added.y);
    expect(dist < extent / 3).toBeTruthy();
});

test('force layout keeps nodes apart', () => {
    const model = buildModel(createMockSnapshot());
    const sub = visibleSubgraph(model, defaultFilters());
    const pos = forceLayout(sub.nodes, sub.edges);
    const list = [...pos.values()];
    let minDist = Infinity;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            minDist = Math.min(minDist, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y));
        }
    }
    expect(minDist > 12).toBeTruthy();
});
