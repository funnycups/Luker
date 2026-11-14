import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { diffSchemas, applyChanges, changeMarks, changeTarget } from '../../../public/scripts/extensions/memory-graph/lens/ai/schema-diff.js';

const TODO = {
    id: 'todo', label: '待办与约定', extractHint: '记录待办。',
    tableColumns: ['title', 'who', 'kind'], embeddingColumns: ['title', 'who'],
    columnHints: { title: '显示名：当事人·事项', who: '事项的当事人', kind: '待办 / 约定 / 誓言 四选一。' },
    requiredColumns: ['title'], alwaysInject: false, latestOnly: true, compression: { mode: 'none' },
};

test('diffSchemas lists item-level changes in plain Chinese', () => {
    const after = structuredClone([TODO]);
    const t = after[0];
    t.tableColumns = ['title', 'kind', 'due'];
    t.columnHints.due = '截止时间：完整日期 + 钟点';
    t.columnHints.kind = '待办 / 约定 / 誓言 / 系统任务 四选一。';
    delete t.columnHints.who;
    t.requiredColumns = ['title', 'kind'];
    t.alwaysInject = true;
    after.push({ id: 'item', label: '物品', tableColumns: ['title'], columnHints: { title: '物品名称' } });
    const changes = diffSchemas([TODO], after);
    const texts = changes.map(c => c.text);
    expect(texts.includes('新增记录项「截止时间」')).toBeTruthy();
    expect(texts.includes('删除记录项「事项的当事人」')).toBeTruthy();
    expect(texts.some(x => /的提示改了$/.test(x))).toBeTruthy();
    expect(texts.some(x => /改为必填$/.test(x))).toBeTruthy();
    expect(texts.includes('「待办与约定」开启「一直让 AI 看到」')).toBeTruthy();
    expect(texts.includes('新建类型「物品」')).toBeTruthy();
    expect(!/[a-z_]{3,}/.test(texts.join(''))).toBeTruthy();
    const hint = changes.find(c => c.kind === 'hint');
    expect(hint.before).toBe(TODO.columnHints.kind);
});

test('applyChanges applies any subset independently', () => {
    const after = structuredClone([TODO]);
    after[0].tableColumns.push('due');
    after[0].columnHints.due = '截止时间';
    after[0].latestOnly = false;
    after[0].columnHints.who = '当事人，写全名';
    const changes = diffSchemas([TODO], after);
    const onlyAdd = applyChanges([TODO], changes.filter(c => c.kind === 'addColumn')).specs[0];
    expect(onlyAdd.tableColumns).toEqual(['title', 'who', 'kind', 'due']);
    expect(onlyAdd.latestOnly).toBe(true);
    expect(onlyAdd.columnHints.who).toBe('事项的当事人');
    expect(onlyAdd.embeddingColumns.includes('due')).toBeTruthy();
    const all = applyChanges([TODO], changes).specs;
    expect(JSON.stringify(diffSchemas(after, all))).toBe('[]');
});

test('remove / reorder / new type round-trip', () => {
    const after = [{ ...structuredClone(TODO), tableColumns: ['kind', 'title'] }, { id: 'x', label: '新', tableColumns: ['title'] }];
    const changes = diffSchemas([TODO], after);
    const result = applyChanges([TODO], changes).specs;
    expect(result.map(s => s.id)).toEqual(['todo', 'x']);
    expect(result[0].tableColumns).toEqual(['kind', 'title']);
    expect(diffSchemas([TODO], []).at(-1).kind).toBe('removeType');
});

test('changeMarks and targets', () => {
    const after = structuredClone([TODO]);
    after[0].tableColumns.push('due');
    after[0].columnHints.kind = '新';
    const changes = diffSchemas([TODO], after);
    const marks = changeMarks(changes);
    expect(marks.todo.count).toBe(2);
    expect(marks.todo.columns).toEqual({ due: 'added', kind: 'changed' });
    expect(changes.map(changeTarget).sort()).toEqual(['todo:due', 'todo:kind']);
});
