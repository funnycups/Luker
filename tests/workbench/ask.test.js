// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { askTools, runAsk, readsSummary, clip, buildAskHistory } from '../../public/scripts/workbench/model/ask.js';
import { attribute, groupByGeneration, describeRequest } from '../../public/scripts/workbench/model/requests.js';
import { askReaders, listAiChoices } from '../../public/scripts/workbench/source-luker.js';

describe('workbench Ask model & source readers', () => {
    beforeEach(() => {
        delete globalThis.Luker;
    });

    afterEach(() => {
        delete globalThis.Luker;
        jest.restoreAllMocks();
    });

    test('buildAskHistory omits failed turns with empty answer', () => {
        const history = buildAskHistory([
            { role: 'user', text: 'First question' },
            { role: 'ai', answer: 'First answer' },
            { role: 'user', text: 'Failed question' },
            { role: 'ai', answer: '', error: 'Could not ask: 500' },
            { role: 'user', text: 'Empty answer question' },
            { role: 'ai', answer: '' },
            { role: 'user', text: 'Second question' },
            { role: 'ai', answer: 'Second answer' },
        ]);

        expect(history).toEqual([
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Second question' },
            { role: 'assistant', content: 'Second answer' },
        ]);
        expect(history.some(m => m.role === 'assistant' && m.content === '')).toBe(false);
    });

    test('ask.floors controls chatMessages() window size including numeric caps and "all"', async () => {
        const chat = Array.from({ length: 15 }, (_, i) => ({
            mes: `Floor ${i}`,
            is_user: i % 2 === 0,
            name: i % 2 === 0 ? 'User' : 'Alice',
        }));

        const ctxWithFloors = (floors) => ({
            chat,
            extensionSettings: { workbench: { ask: { floors } } },
        });

        globalThis.Luker = { getContext: () => ctxWithFloors(0) };
        const onlyOne = await askReaders({ redactText: false }).wb_read_chat({});
        expect(onlyOne.total).toBe(15);
        expect(onlyOne.messages).toHaveLength(1);
        expect(onlyOne.messages[0].floor).toBe(14);

        globalThis.Luker = { getContext: () => ctxWithFloors(2) };
        const twoEachSide = await askReaders({ redactText: false }).wb_read_chat({});
        expect(twoEachSide.messages).toHaveLength(5);
        expect(twoEachSide.messages.map(m => m.floor)).toEqual([10, 11, 12, 13, 14]);

        // Numeric cap also bounds explicit broad ranges
        const cappedRange = await askReaders({ redactText: false }).wb_read_chat({ from: 0, to: 14 });
        expect(cappedRange.messages).toHaveLength(5);
        expect(cappedRange.messages.map(m => m.floor)).toEqual([0, 1, 2, 3, 4]);

        globalThis.Luker = { getContext: () => ctxWithFloors(5) };
        const fiveEachSide = await askReaders({ redactText: false }).wb_read_chat({});
        expect(fiveEachSide.messages).toHaveLength(11);
        expect(fiveEachSide.messages[0].floor).toBe(4);
        expect(fiveEachSide.messages.at(-1).floor).toBe(14);

        globalThis.Luker = { getContext: () => ctxWithFloors('all') };
        const allFloors = await askReaders({ redactText: false }).wb_read_chat({});
        expect(allFloors.messages).toHaveLength(15);
        expect(allFloors.messages[0].floor).toBe(0);
        expect(allFloors.messages.at(-1).floor).toBe(14);

        // null, undefined, and empty string fall back to default 2 (5 floors), never 0
        for (const unsetVal of [null, undefined, '']) {
            globalThis.Luker = { getContext: () => ctxWithFloors(unsetVal) };
            const defaulted = await askReaders({ redactText: false }).wb_read_chat({});
            expect(defaulted.messages).toHaveLength(5);
        }
    });

    test('wb_read_world_info stops across outer books at 60 entries and surfaces load errors', async () => {
        const makeEntries = (prefix, count) => Object.fromEntries(
            Array.from({ length: count }, (_, i) => [i, { uid: i, key: [`${prefix}_${i}`], comment: `${prefix} ${i}`, content: 'body' }]),
        );
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        globalThis.Luker = {
            getContext: () => ({
                chat: [],
                characters: [],
                chatWorldInfo: {
                    getNames: () => ['BrokenBook', 'BookA', 'BookB'],
                    globalSelection: [],
                },
                loadWorldInfo: async (name) => {
                    if (name === 'BrokenBook') throw new Error('disk read error');
                    if (name === 'BookA') return { entries: makeEntries('a', 55) };
                    return { entries: makeEntries('b', 20) };
                },
                extensionSettings: {},
            }),
        };

        const res = await askReaders({ redactText: false }).wb_read_world_info({});
        expect(res.entries).toHaveLength(60);
        expect(res.errors).toEqual([{ book: 'BrokenBook', error: 'disk read error' }]);
        expect(warnSpy).toHaveBeenCalled();
    });

    test('runAsk executes read calls then wb_answer, respects MAX_ROUNDS, and handles plain text', async () => {
        const script = [
            { text: '', calls: [{ id: 'c1', name: 'wb_list_requests', args: { limit: 5 } }, { id: 'c2', name: 'wb_read_frontend_logs', args: {} }] },
            { text: '', calls: [{ id: 'c3', name: 'wb_answer', args: { text: 'Slow in planner', suggest: 'orch', fix_prompt: 'Use faster model', request_ids: ['r3'] } }] },
        ];
        const seen = [];
        const result = await runAsk({
            question: 'Why slow?',
            overview: { chat: 'x' },
            readers: { wb_list_requests: async () => [{ id: 'r3' }], wb_read_frontend_logs: async () => 'log' },
            request: async (messages, tools) => {
                seen.push({ messages: [...messages], tools: tools.map(t => t.function.name) });
                return script.shift();
            },
        });
        expect(result.answer).toBe('Slow in planner');
        expect(result.suggest).toBe('orch');
        expect(result.requestIds).toEqual(['r3']);
        expect(result.reads).toHaveLength(2);
        expect(seen[1].messages.filter(m => m.role === 'tool')).toHaveLength(2);
        expect(readsSummary(result.reads)).toContain('Request list');

        let calls = 0;
        const offered = [];
        const r = await runAsk({
            question: 'q',
            overview: {},
            readers: { wb_read_chat: async () => 'x' },
            request: async (_m, tools) => {
                calls++;
                offered.push(tools.length);
                return { text: '', calls: [{ id: `c${calls}`, name: 'wb_read_chat', args: {} }] };
            },
        });
        expect(calls).toBe(6);
        expect(offered[5]).toBe(1);
        expect(r.answer).toMatch(/specific/i);

        const plain = await runAsk({ question: 'q', overview: {}, readers: {}, request: async () => ({ text: 'Direct answer', calls: [] }) });
        expect(plain.answer).toBe('Direct answer');
    });

    test('request attribution, grouping, clip, and tools filtering', () => {
        expect(askTools({ inspector: false }).map(t => t.function.name)).not.toContain('wb_list_requests');
        expect(attribute({ searchText: 'You are a memory recall planner' }).kind).toBe('memory');
        expect(attribute({ id: 'a' }, { mainReplyIds: new Set(['a']) }).guessed).toBe(false);
        expect(attribute({ messageCount: 30 }).kind).toBe('main');
        expect(attribute({ messageCount: 2 }).kind).toBe('other');

        const g = groupByGeneration([{ timestamp: 0, durationMs: 1000 }, { timestamp: 5000 }, { timestamp: 500000 }]);
        expect(g).toHaveLength(2);
        expect(g[1].items).toHaveLength(2);
        const d = describeRequest({ id: 'x', timestamp: 0, status: 'error', httpStatus: 429, error: 'rate' });
        expect(d.status).toContain('429');
        expect(clip('x'.repeat(20000))).toMatch(/truncated|已截断/);
    });

    test('listAiChoices preserves presets when connectionProfiles.list() throws and surfaces error', async () => {
        globalThis.Luker = {
            getContext: () => ({
                connectionProfiles: {
                    list: () => { throw new Error('Connection resolver failed'); },
                },
                getPresetManager: () => ({
                    getAllPresets: () => ['plugin-only', 'Default'],
                }),
                extensionSettings: {},
            }),
        };

        const choices = await listAiChoices();
        expect(choices.connections).toEqual([]);
        expect(choices.presets).toEqual(['plugin-only', 'Default']);
        expect(choices.hasPluginOnly).toBe(true);
        expect(choices.errors?.connections).toContain('Connection resolver failed');
    });
});
