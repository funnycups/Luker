import './_mocks/luker-zh.js';
import { test, expect, jest } from '@jest/globals';
import { parseTag, parseTagList, addToList, buildScripts, filterText, inspectText, planWarnings, invalidTokens } from '../../../public/scripts/extensions/memory-graph/lens/filter/tag-filter.js';

jest.unstable_mockModule('../../../public/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: {},
    getRegexScripts: () => [],
    getScriptsByType: () => [],
    registerRegexProvider: () => null,
}));

const { readFilterSettings, activePlan, isPromptRule, collapse, depthOf, previewFloor } = await import('../../../public/scripts/extensions/memory-graph/lens/filter/filter-runtime.js');

const REPLY = `<think>
先想一想……很长很长的思维链
</think>
<content>
雨停了。林栖推开灯塔的门。
</content>
<!-- 作者备注 -->
<statusbar>体力 80</statusbar>`;

test('parses the three tag forms', () => {
    expect(parseTag('<think>')).toEqual({ kind: 'angle', name: 'think', label: 'think' });
    expect(parseTag('[时间]')).toEqual({ kind: 'square', name: '时间', label: '[时间]' });
    expect(parseTag('!--').kind).toBe('comment');
    expect(parseTag('<!--').kind).toBe('comment');
    expect(parseTag('a b')).toBe(null);
    expect(parseTagList('think, Think、[时间] ；details').map(t => t.label)).toEqual(['think', '[时间]', 'details']);
    expect(invalidTokens('think, <<x')).toEqual(['<<x']);
    expect(addToList('think', 'details')).toBe('think, details');
    expect(addToList('think, details', 'THINK')).toBe('think, details');
});

test('blacklist removes tags and their content', () => {
    const out = filterText(REPLY, { black: 'think, !--, statusbar' });
    expect(out).toBe('<content>\n雨停了。林栖推开灯塔的门。\n</content>');
});

test('blacklist handles a thought missing its opener or closer', () => {
    expect(filterText('思考过程……\n</think>\n正文在这里', { black: 'think' })).toBe('正文在这里');
    expect(filterText('正文在这里\n<think>没写完的思考', { black: 'think' })).toBe('正文在这里');
});

test('whitelist keeps only listed blocks, without the tags', () => {
    const out = filterText(REPLY, { white: 'content, statusbar' });
    expect(out).toBe('雨停了。林栖推开灯塔的门。\n\n体力 80');
});

test('whitelist runs after the blacklist, so fake tags inside a thought do not survive', () => {
    const text = '<think>草稿：<content>假的</content></think><content>真的</content>';
    expect(filterText(text, { black: 'think', white: 'content' })).toBe('真的');
});

test('square tags: paired blocks and single-line markers', () => {
    expect(filterText('[歌曲]晴天[/歌曲]\n正文', { black: '[歌曲]' })).toBe('正文');
    expect(filterText('[时间] 第三天傍晚\n多余的话', { white: '[时间]' })).toBe('[时间] 第三天傍晚');
});

test('whitelist on a bare reply deletes everything and is flagged', () => {
    const bare = '雨停了。林栖推开灯塔的门，海风灌进来。';
    expect(filterText(bare, { white: 'content' })).toBe('');
    expect(planWarnings({ white: 'content' }, bare)).toEqual(['empty']);
    expect(planWarnings({ black: 'think' }, bare)).toEqual([]);
});

test('scripts target only the plugin request lane', () => {
    const scripts = buildScripts({ black: 'think', white: 'content' });
    expect(scripts.length > 2).toBeTruthy();
    for (const s of scripts) {
        expect(s.pluginLanes).toEqual(['request']);
        expect(s.promptOnly).toBe(false);
        expect('pluginOnly' in s).toBe(false);
        expect(s.placement).toEqual([2]);
        expect(s.id.startsWith('memory-lens-tagfilter-')).toBeTruthy();
    }
    expect(buildScripts({ enabled: false, black: 'think' })).toEqual([]);
    expect(buildScripts({ black: '', white: '' })).toEqual([]);
});

test('inspectText tells wrapped replies from bare ones', () => {
    const wrapped = inspectText(REPLY);
    expect(wrapped.tags.some(t => t.label === 'content')).toBeTruthy();
    expect(wrapped.tags.some(t => t.label === 'think')).toBeTruthy();
    expect(wrapped.bareChars).toBe(0);
    const bare = inspectText('<think>想</think>\n雨停了，林栖推门出去。');
    expect(bare.bareChars > 5).toBeTruthy();
});

import { readDiagnosis, diagnoseUserPrompt } from '../../../public/scripts/extensions/memory-graph/lens/filter/filter-ai.js';

test('AI diagnosis: bare body never gets a whitelist', () => {
    const bare = '<think>想</think>\n雨停了，林栖推门出去。';
    const plan = readDiagnosis({ body: 'bare', black: ['think'], white: ['content'], reason: 'x' }, bare);
    expect(plan.white).toBe('');
    expect(plan.black).toBe('think');
    expect(plan.notes.length).toBe(1);
    // Claims "wrapped" but the whitelist would empty the sample → dropped too.
    const wrong = readDiagnosis({ body: 'wrapped', black: [], white: ['content'], reason: '' }, bare);
    expect(wrong.white).toBe('');
    const ok = readDiagnosis({ body: 'wrapped', black: ['think'], white: ['content'] }, '<think>a</think><content>正文</content>');
    expect(ok.white).toBe('content');
    expect(diagnoseUserPrompt('<content>正文</content>')).toMatch(/content（尖括号）/);
});

test('filter settings default and active plan', () => {
    const s = readFilterSettings({ extensionSettings: {} });
    expect(s.enabled).toBe(false);
    expect(s.presets.length).toBe(1);
    const ctx = { extensionSettings: { memory_lens: { tagFilter: { enabled: true, active: 'b', presets: [{ id: 'a', black: 'x' }, { id: 'b', black: 'think', white: 'content' }] } } } };
    expect(activePlan(readFilterSettings(ctx))).toEqual({ enabled: true, black: 'think', white: 'content', mirrorPrompt: true });
});

test('square markers stop at the next tag once newlines are collapsed', () => {
    const flat = collapse('[时间] 第三天傍晚\n<content>\n雨停了。\n</content>');
    expect(flat).toBe('[时间] 第三天傍晚 <content> 雨停了。 </content>');
    expect(filterText(flat, { black: '[时间]' })).toBe('<content> 雨停了。 </content>');
    expect(filterText(flat, { white: '[时间], content' })).toBe('[时间] 第三天傍晚 \n 雨停了。');
});

test('which of the user\'s rules get mirrored onto the memory-graph lane', () => {
    const base = { promptOnly: true, placement: [2], findRegex: '/x/g', replaceString: '' };
    expect(isPromptRule(base)).toBe(true);
    expect(isPromptRule({ ...base, findRegex: '/<think>[\\s\\S]*?<\\/think>/g', minDepth: 1 })).toBe(true);
    expect(isPromptRule({ ...base, findRegex: '/[\\s\\S]*/g', minDepth: 5 })).toBe(false);
    expect(isPromptRule({ ...base, pluginOnly: true })).toBe(false);
    expect(isPromptRule({ ...base, pluginLanes: ['request'] })).toBe(false);
    expect(isPromptRule({ ...base, pluginLanes: [] })).toBe(true);
    expect(isPromptRule({ ...base, promptOnly: false })).toBe(false);
    expect(isPromptRule({ ...base, disabled: true })).toBe(false);
    expect(isPromptRule({ ...base, placement: [1] })).toBe(false);
});

test('preview falls back to local filtering without Luker', () => {
    const chat = [{ is_user: true, mes: 'hi' }, { is_user: false, mes: '<think>a\nb</think>\n正文' }, { is_system: true, mes: 's' }];
    expect(depthOf(chat, 1)).toBe(0);
    expect(depthOf(chat, 0)).toBe(1);
    const r = previewFloor({ chat }, 1, { black: 'think' });
    expect(r.real).toBe(false);
    expect(r.before).toBe('<think>a b</think> 正文');
    expect(r.after).toBe('正文');
});
