import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import {
    toDrafts, fromDraft, newColumn, newTypeDraft, labelsFromDrafts, validateDrafts,
    describeChanges, draftsEqual, cloneDrafts, buildLabelMaps, columnDisplayName, typeDisplayName,
} from '../../../public/scripts/extensions/memory-graph/lens/schema/schema-model.js';
import { setDisplayLabels, typeLabel, fieldLabel, depthLabel } from '../../../public/scripts/extensions/memory-graph/lens/i18n.js';

const LONG_HINT = 'Canonical character name only. Do not include aliases, English names, titles, translations, or any parenthetical clarification here.';

const DEFAULTS = [
    {
        id: 'event', label: 'Event', tableName: 'event_table', tableColumns: ['summary'], embeddingColumns: ['summary'],
        columnHints: { summary: 'A prose body covering event skeleton…' }, requiredColumns: ['summary'],
        extractHint: 'Critical plot events…', extractionInstructions: 'LONG EVENT RULES', alwaysInject: true, latestOnly: false,
        primaryKeyColumns: [], compression: { mode: 'hierarchical', threshold: 5, fanIn: 3, maxDepth: 10, keepRecentLeaves: 3, summarizeInstruction: 'LONG COMPRESS' },
    },
    {
        id: 'character_sheet', label: 'Character Sheet', tableName: 'character_table',
        tableColumns: ['title', 'aliases', 'identity', 'goal'], embeddingColumns: ['title', 'aliases', 'identity'],
        columnHints: { title: LONG_HINT, aliases: 'Nicknames…', identity: 'Long-term identity…', goal: 'Long-term goal…' },
        requiredColumns: ['title'], extractHint: 'Stable character facts…', extractionInstructions: 'LONG CHAR RULES',
        alwaysInject: false, latestOnly: true, primaryKeyColumns: ['title', 'aliases'], extractEveryN: 1, keywords: ['character'],
        compression: { mode: 'none', threshold: 2, fanIn: 2, maxDepth: 1, keepRecentLeaves: 1, summarizeInstruction: '' },
    },
];

const CUSTOM = {
    id: 'storyline', label: '剧情线', tableName: 'storyline_table',
    tableColumns: ['name', 'track', 'status', 'stage'], embeddingColumns: ['name', 'track', 'status'],
    columnHints: { name: '剧情线名称，简短可指认，不带前缀', track: '主线|支线', status: '进行中/已完结', stage: 'current stage' },
    requiredColumns: ['name', 'track', 'status'], extractHint: '追踪剧情线', alwaysInject: true, latestOnly: true,
    primaryKeyColumns: ['name'], compression: { mode: 'none' }, extractionInstructions: '自定义规则',
};

const fresh = () => toDrafts([...structuredClone(DEFAULTS), structuredClone(CUSTOM)], {}, DEFAULTS);

test('built-in English labels become Chinese, custom labels stay', () => {
    expect(typeDisplayName(DEFAULTS[0])).toBe('事件');
    expect(typeDisplayName(DEFAULTS[1])).toBe('角色');
    expect(typeDisplayName(CUSTOM)).toBe('剧情线');
    expect(typeDisplayName({ id: 'custom_3', label: 'Custom Type 3' })).toBe('自定义类型 3');
});

test('column names: built-in translation, then Chinese hint head, then key', () => {
    expect(columnDisplayName('character_sheet', 'identity', 'Long-term identity…', {})).toBe('身份');
    expect(columnDisplayName('storyline', 'name', CUSTOM.columnHints.name, {})).toBe('名称');
    expect(columnDisplayName('storyline', 'track', '主线|支线', {})).toBe('主线');
    expect(columnDisplayName('storyline', 'stage', 'current stage', {})).toBe('未命名项');
    expect(columnDisplayName('todo', 'kind', '待办 / 约定 / 誓言 / 系统任务 四选一。', {})).toBe('待办');
    expect(columnDisplayName('char', 'core_note', '上海半岛酒店半岛套房专属高颜值管家，业务熟练', {})).toBe('上海半岛酒店半岛套房');
    expect(columnDisplayName('storyline', 'stage', 'x', { storyline: { stage: '阶段' } })).toBe('阶段');
});

test('unchanged drafts round-trip to the same spec (nothing lost)', () => {
    const drafts = fresh();
    const specs = drafts.map(fromDraft);
    const originals = [...DEFAULTS, CUSTOM];
    for (let i = 0; i < specs.length; i++) {
        for (const key of ['extractionInstructions', 'tableName', 'columnHints', 'requiredColumns', 'embeddingColumns', 'primaryKeyColumns', 'extractHint', 'keywords']) {
            expect(specs[i][key]).toEqual(originals[i][key]);
        }
        expect(specs[i].compression.summarizeInstruction).toBe(originals[i].compression.summarizeInstruction);
        expect(specs[i].compression.mode).toBe(originals[i].compression.mode);
    }
    expect(draftsEqual(drafts, fresh())).toBeTruthy();
});

test('long default English hints are hidden in the editor but kept on save', () => {
    const [, character] = fresh();
    const title = character.columns.find(c => c.key === 'title');
    expect(title.hint).toBe('');
    expect(title.label).toBe('名称');
    expect(character.intro).toBe('');
    expect(fromDraft(character).columnHints.title).toBe(LONG_HINT);
    title.hint = '角色的正式名字';
    expect(fromDraft(character).columnHints.title).toBe('角色的正式名字');
});

test('adding, renaming, requiring and deleting items keeps every list in sync', () => {
    const drafts = fresh();
    const story = drafts[2];
    const added = newColumn(story, '关键人物');
    added.hint = '这条线上最重要的几个人';
    added.required = true;
    story.columns.push(added);
    story.columns = story.columns.filter(c => c.key !== 'track');
    story.columns.find(c => c.key === 'stage').label = '阶段';
    const spec = fromDraft(story);
    expect(spec.tableColumns).toEqual(['name', 'status', 'stage', added.key]);
    expect(!spec.requiredColumns.includes('track')).toBeTruthy();
    expect(spec.requiredColumns.includes(added.key)).toBeTruthy();
    expect(!spec.embeddingColumns.includes('track')).toBeTruthy();
    expect(spec.embeddingColumns.includes(added.key)).toBeTruthy();
    expect(!spec.embeddingColumns.includes('stage')).toBeTruthy();
    expect(spec.columnHints[added.key]).toBe('这条线上最重要的几个人');
    expect(!('track' in spec.columnHints)).toBeTruthy();
    expect(spec.extractionInstructions).toBe('自定义规则');
    expect(labelsFromDrafts(drafts)).toEqual({ storyline: { stage: '阶段', [added.key]: '关键人物' } });
});

test('new item keys are unique ASCII and never shown', () => {
    const drafts = fresh();
    const a = newColumn(drafts[2], '甲');
    drafts[2].columns.push(a);
    const b = newColumn(drafts[2], '乙');
    expect(a.key).toMatch(/^custom_\d+$/);
    expect(a.key).not.toBe(b.key);
});

test('latestOnly gets an identity column automatically', () => {
    const type = newTypeDraft(fresh());
    type.name = '物品';
    type.columns.push(newColumn(type, '持有者'));
    type.latestOnly = true;
    const spec = fromDraft(type);
    expect(spec.primaryKeyColumns).toEqual(['title']);
    type.columns = type.columns.filter(c => c.key !== 'title');
    expect(fromDraft(type).primaryKeyColumns).toEqual([type.columns[0].key]);
});

test('event summary cannot be dropped from required', () => {
    const [event] = fresh();
    const summary = event.columns.find(c => c.key === 'summary');
    expect(summary.locked && summary.required).toBeTruthy();
    summary.required = false;
    expect(fromDraft(event).requiredColumns).toEqual(['summary']);
    expect(event.deletable).toBe(false);
});

test('validation catches empty and duplicate names', () => {
    const drafts = fresh();
    drafts[2].columns[1].label = '名称';
    const type = newTypeDraft(drafts);
    drafts.push(type);
    const messages = validateDrafts(drafts).map(e => e.message);
    expect(messages.some(m => m.includes('两项都叫「名称」'))).toBeTruthy();
    expect(messages.some(m => m.includes('没有名称'))).toBeTruthy();
    expect(validateDrafts(fresh())).toEqual([]);
});

test('describeChanges lists changes in plain Chinese', () => {
    const before = fresh();
    const after = cloneDrafts(before);
    after[2].columns.push(newColumn(after[2], '关键人物'));
    after[2].columns = after[2].columns.filter(c => c.key !== 'stage');
    after[2].alwaysInject = false;
    after[1].columns.find(c => c.key === 'goal').label = '长期目标';
    after.splice(0, 0, after.splice(1, 1)[0]);
    const extra = newTypeDraft(after);
    extra.name = '物品';
    after.push(extra);
    const changes = describeChanges(before, after, new Map([['storyline', 4]]));
    const text = JSON.stringify(changes);
    expect(text.includes('新增 1 项：关键人物')).toBeTruthy();
    expect(text.includes('删除 1 项：未命名项')).toBeTruthy();
    expect(text.includes('关闭「一直让 AI 看到」')).toBeTruthy();
    expect(text.includes('1 项改了名称')).toBeTruthy();
    expect(text.includes('新建类型')).toBeTruthy();
    expect(text.includes('调整了记忆类型的先后顺序')).toBeTruthy();
    expect(!/[a-z]{4,}/.test(changes.flatMap(c => c.lines).join(''))).toBeTruthy();
    const removed = describeChanges(before, before.slice(0, 2), new Map([['storyline', 4]]));
    expect(JSON.stringify(removed).includes('当前聊天有 4 条')).toBeTruthy();
    expect(describeChanges(before, cloneDrafts(before))).toEqual([]);
});

test('display labels flow into the read views', () => {
    const maps = buildLabelMaps([...DEFAULTS, CUSTOM], { storyline: { stage: '阶段' } });
    setDisplayLabels(maps);
    expect(typeLabel('storyline')).toBe('剧情线');
    expect(typeLabel('event')).toBe('事件');
    expect(fieldLabel('stage', 'storyline')).toBe('阶段');
    expect(fieldLabel('track', 'storyline')).toBe('主线');
    expect(fieldLabel('identity', 'character_sheet')).toBe('身份');
    expect(depthLabel(1)).toBe('一级摘要');
    expect(depthLabel(2)).toBe('二级摘要');
    setDisplayLabels({});
});

import { TEMPLATES, buildTemplate } from '../../../public/scripts/extensions/memory-graph/lens/schema/templates.js';

test('templates keep the current event type and produce valid drafts', () => {
    const defaults = [
        { id: 'event', label: 'Event', tableColumns: ['summary'], columnHints: { summary: 'x' } },
        { id: 'character_sheet', label: 'Character Sheet', tableColumns: ['title'] },
        { id: 'location_state', label: 'Location State', tableColumns: ['title'] },
        { id: 'thread', label: 'Thread', tableColumns: ['title', 'status', 'note'] },
    ];
    const current = [{ id: 'event', label: '我的事件', tableColumns: ['summary'], columnHints: { summary: '自定义' } }];
    for (const tpl of TEMPLATES) {
        const { types, labels } = buildTemplate(tpl, current, defaults);
        expect(types[0].label).toBe('我的事件');
        const ids = types.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        const drafts = toDrafts(types, labels, defaults);
        expect(validateDrafts(drafts)).toEqual([]);
        for (const spec of types) for (const key of spec.requiredColumns || []) expect(spec.tableColumns.includes(key)).toBeTruthy();
    }
});
