import './_mocks/luker-zh.js';
import { test, expect } from '@jest/globals';
import { editRule, toEditText, fromEditText, isChanged, hasParagraphs, commitSkipMessage } from '../../../public/scripts/extensions/memory-graph/lens/edit/edit-model.js';

test('editRule allows everything the native editor allows', () => {
    expect(editRule({ type: 'event', isRollup: true }, 'summary').ok).toBe(true);
    expect(editRule({ type: 'thread', archived: true }, 'state').ok).toBe(true);
    expect(editRule({ type: 'event' }, '').ok).toBe(true);
    expect(editRule(null, 'x').reason).toMatch(/找不到/);
});

test('values round-trip keeping their stored shape', () => {
    expect(toEditText(['阿林', '小林'])).toBe('阿林、小林');
    expect(fromEditText('阿林、小林, 林栖', ['x'])).toEqual(['阿林', '小林', '林栖']);
    expect(fromEditText('  ', ['x'])).toEqual([]);
    expect(fromEditText('12', 3)).toBe(12);
    expect(fromEditText('十二', 3)).toBe('十二');
    expect(fromEditText('  守灯人 \r\n', '旧')).toBe('守灯人');
    expect(fromEditText('{"a":1}', { a: 0 })).toEqual({ a: 1 });
});

test('isChanged ignores whitespace and identical lists', () => {
    expect(isChanged(' 守灯人 ', '守灯人')).toBe(false);
    expect(isChanged('阿林、小林', ['阿林', '小林'])).toBe(false);
    expect(isChanged('阿林', ['阿林', '小林'])).toBe(true);
    expect(isChanged('新的', undefined)).toBe(true);
    expect(isChanged('', undefined)).toBe(false);
});

test('only paragraph text saves with Ctrl+Enter', () => {
    expect(hasParagraphs('summary', '短')).toBe(true);
    expect(hasParagraphs('identity', 'x'.repeat(80))).toBe(false);
    expect(hasParagraphs('note', 'a\nb')).toBe(true);
});

test('a skipped graph commit is reported, a completed one is not', () => {
    expect(commitSkipMessage({ skipped: true, hint: '聊天已切换' })).toMatch('聊天已切换');
    expect(commitSkipMessage({ skipped: true })).not.toBe('');
    expect(commitSkipMessage({ skipped: false })).toBe('');
    expect(commitSkipMessage(undefined)).toBe('');
});
