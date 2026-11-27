// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { askSystemPrompt, askUserMessage, askTools, runAsk, readsSummary, readLabel, buildAskHistory } from '../../public/scripts/workbench/model/ask.js';
import { attribute, groupByGeneration, describeRequest } from '../../public/scripts/workbench/model/requests.js';
import { SourceError, aiRequest, askOverview, askReaders, listAiChoices, loadSnapshot } from '../../public/scripts/workbench/source-luker.js';
import { createMemoryAskProvider } from '../../public/scripts/extensions/memory-graph/lens/providers.js';
import { createOrchAskProvider } from '../../public/scripts/extensions/orchestrator/lens/providers.js';

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

        // null, empty string, and boolean from/to must NOT coerce to floor 0
        globalThis.Luker = { getContext: () => ctxWithFloors(2) };
        for (const badRange of [{ from: null, to: null }, { from: '', to: '' }, { from: false, to: false }]) {
            const trailing = await askReaders({ redactText: false }).wb_read_chat(badRange);
            expect(trailing.messages.map(m => m.floor)).toEqual([10, 11, 12, 13, 14]);
        }
    });

    test('wb_read_world_info returns all entries across outer books without silent cap and surfaces load errors', async () => {
        const makeEntries = (prefix, count) => Object.fromEntries(
            Array.from({ length: count }, (_, i) => [i, { uid: i, key: [`${prefix}_${i}`], comment: `${prefix} ${i}`, content: 'body' }]),
        );
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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
        expect(res.entries).toHaveLength(75);
        expect(res.errors).toEqual([{ book: 'BrokenBook', error: 'disk read error' }]);
        expect(errSpy).toHaveBeenCalled();

        // Explicit caller limit is honored without an artificial ceiling
        const paged = await askReaders({ redactText: false }).wb_read_world_info({ offset: 10, limit: 15 });
        expect(paged.entries).toHaveLength(15);
        expect(paged.totalMatched).toBe(75);
    });

    test('runAsk executes unbounded read rounds until wb_answer or plain text, without truncating tool outputs', async () => {
        const hugePayload = 'X'.repeat(25000);
        const script = [
            { text: '', calls: [{ id: 'c1', name: 'wb_list_requests', args: { limit: 5 } }, { id: 'c2', name: 'wb_read_frontend_logs', args: {} }] },
            { text: '', calls: [{ id: 'c3', name: 'wb_answer', args: { text: 'Slow in planner', suggest: 'orch', fix_prompt: 'Use faster model', request_ids: ['r3'] } }] },
        ];
        const seen = [];
        const result = await runAsk({
            question: 'Why slow?',
            overview: { chat: 'x' },
            readers: { wb_list_requests: async () => [{ id: 'r3' }], wb_read_frontend_logs: async () => hugePayload },
            request: async (messages, tools) => {
                seen.push({ messages: [...messages], tools: tools.map(t => t.function.name) });
                return script.shift();
            },
        });
        expect(result.answer).toBe('Slow in planner');
        expect(result.suggest).toBe('orch');
        expect(result.requestIds).toEqual(['r3']);
        expect(result.reads).toHaveLength(2);
        const toolMsgs = seen[1].messages.filter(m => m.role === 'tool');
        expect(toolMsgs).toHaveLength(2);
        expect(toolMsgs[1].content).toBe(hugePayload);

        // Runs past 10 rounds naturally without cutting the model off
        let calls = 0;
        const r = await runAsk({
            question: 'q',
            overview: {},
            readers: { wb_read_chat: async () => 'x' },
            request: async () => {
                calls++;
                if (calls <= 12) {
                    return { text: '', calls: [{ id: `c${calls}`, name: 'wb_read_chat', args: {} }] };
                }
                return { text: '', calls: [{ id: 'c_done', name: 'wb_answer', args: { text: 'Done after 12 reads' } }] };
            },
        });
        expect(calls).toBe(13);
        expect(r.reads).toHaveLength(12);
        expect(r.answer).toBe('Done after 12 reads');

        const plain = await runAsk({ question: 'q', overview: {}, readers: {}, request: async () => ({ text: 'Direct answer', calls: [] }) });
        expect(plain.answer).toBe('Direct answer');
    });

    test('request attribution, grouping, clip, and tools filtering', () => {
        expect(askTools({ inspector: false }).map(t => t.function.name)).not.toContain('wb_list_requests');
        const answerTool = askTools().find(t => t.function.name === 'wb_answer');
        expect(answerTool.function.parameters.properties.suggest.enum).toEqual(
            expect.arrayContaining(['memory', 'memory_graph']),
        );

        // Real Ask first-round & multi-round searchText must attribute to workbench, not orch/search/image/memory
        const askRound1Search = [
            'openai',
            'claude-sonnet-4',
            askSystemPrompt(),
            askUserMessage('为什么刚才报错了？', { 编排: { 启用: true, 模式: 'agenda' } }),
        ].join(' ').slice(0, 8192);
        expect(attribute({ searchText: askRound1Search })).toEqual({ kind: 'workbench', label: '工作台', guessed: true });

        const askMultiRoundSearch = [
            'openai',
            'claude-sonnet-4',
            askSystemPrompt(),
            askUserMessage('帮我查一下编排和联网搜索', {}),
            '{"tool":"wb_read_luker_env","search_tools":{"enabled":true},"luker_orch":true,"sd_read_run":"x","memory recall planner":"y"}',
        ].join(' ').slice(0, 8192);
        expect(attribute({ searchText: askMultiRoundSearch })).toEqual({ kind: 'workbench', label: '工作台', guessed: true });

        expect(attribute({
            searchText: '你是「工作台」插件的只读助手「问问」。orchestrator search_tools',
        })).toEqual({ kind: 'workbench', label: '工作台', guessed: true });

        expect(attribute({
            searchText: 'openai gpt-4o 这是连接测试。调用 wb_ok 工具一次，不要输出别的。 测试连接',
        })).toEqual({ kind: 'workbench', label: '工作台', guessed: true });

        // Normal domain and AI-iteration requests remain unaffected
        expect(attribute({ searchText: 'You are a memory recall planner' }).kind).toBe('memory');
        expect(attribute({ searchText: 'call mg_config_set_fields to tune extraction' }).label).toBe('AI 迭代 · 记忆图配置');
        expect(attribute({ searchText: 'call mg_graph_edit_node to fix character state' }).label).toBe('AI 迭代 · 记忆图内容');
        expect(attribute({ searchText: 'You are the agenda_planner for luker_orch' }).kind).toBe('orch');
        expect(attribute({ searchText: 'luker_search_agent using search_tools' }).kind).toBe('search');
        expect(attribute({ searchText: 'Call add_image_prompt and explore_characters for visualInspection' })).toEqual({
            kind: 'image',
            label: 'AI 插图 / 画室',
            guessed: true,
        });
        expect(attribute({ searchText: 'Call sd_read_run and sd_update_preset for illustration_prompt' })).toEqual({
            kind: 'iterate',
            label: 'AI 迭代 · 图像生成',
            guessed: true,
        });
        expect(attribute({
            searchText: '## This session edits world books only. Use cea_read_world_entry to inspect.',
        })).toEqual({
            kind: 'iterate',
            label: 'AI 迭代 · 世界书',
            guessed: true,
        });
        expect(attribute({
            searchText: 'Use cea_read_card_field as Character Editor Assistant',
        })).toEqual({
            kind: 'iterate',
            label: 'AI 迭代 · 角色卡',
            guessed: true,
        });
        expect(attribute({
            searchText: '【工作台说明】你在 Luker「工作台」里帮用户修改「预设」 cpa_list_entries',
        }).kind).toBe('iterate');
        expect(attribute({ id: 'a' }, { mainReplyIds: new Set(['a']) }).guessed).toBe(false);
        expect(attribute({ messageCount: 30 }).kind).toBe('main');
        expect(attribute({ messageCount: 2 }).kind).toBe('other');

        const g = groupByGeneration([{ timestamp: 0, durationMs: 1000 }, { timestamp: 5000 }, { timestamp: 500000 }]);
        expect(g).toHaveLength(2);
        expect(g[1].items).toHaveLength(2);
        const d = describeRequest({ id: 'x', timestamp: 0, status: 'error', httpStatus: 429, error: 'rate' });
        expect(d.status).toContain('429');
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

    test('askTools uses AskProvider JSON Schema parameters directly and falls back for flat property maps', () => {
        const schemaTool = {
            name: 'wb_custom_schema',
            description: 'Reads custom data',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false,
            },
        };
        const propertiesOnlySchemaTool = {
            name: 'wb_custom_props_schema',
            description: 'Has properties object inside parameters',
            parameters: {
                properties: { limit: { type: 'integer' } },
            },
        };
        const flatPropsTool = {
            name: 'wb_custom_flat',
            description: 'Flat properties map',
            properties: { id: { type: 'string' } },
            required: ['id'],
        };
        const flatParamsTool = {
            name: 'wb_custom_flat_params',
            description: 'Flat parameters map',
            parameters: { key: { type: 'string' } },
            required: ['key'],
        };

        const tools = askTools(
            { inspector: false, frontLogs: false, serverLogs: false, content: false, plugins: true },
            [schemaTool, propertiesOnlySchemaTool, flatPropsTool, flatParamsTool],
        );

        const byName = Object.fromEntries(tools.map(t => [t.function.name, t]));
        expect(byName.wb_custom_schema.function.parameters).toBe(schemaTool.parameters);
        expect(byName.wb_custom_props_schema.function.parameters).toBe(propertiesOnlySchemaTool.parameters);
        expect(byName.wb_custom_flat.function.parameters).toEqual({
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
        });
        expect(byName.wb_custom_flat_params.function.parameters).toEqual({
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
            additionalProperties: false,
        });
    });

    test('wb_read_character, wb_read_preset, and wb_read_world_info return full untruncated content', async () => {
        const longDesc = 'D'.repeat(7500);
        const longPreset = 'P'.repeat(9500);
        const longWorld = 'W'.repeat(2500);

        globalThis.Luker = {
            getContext: () => ({
                chat: [],
                characterId: 0,
                characters: [{
                    avatar: 'alice.png',
                    name: 'Alice',
                    description: longDesc,
                    data: { name: 'Alice', description: longDesc, extensions: { world: 'Book1' } },
                }],
                chatWorldInfo: { getNames: () => ['Book1'], globalSelection: [] },
                loadWorldInfo: async () => ({
                    entries: {
                        0: { uid: 0, key: ['lore'], comment: 'Long lore', content: longWorld },
                    },
                }),
                presets: {
                    getLive: () => ({
                        ref: { name: 'MainPreset' },
                        body: {
                            prompt_order: [{ character_id: 100001, order: [{ identifier: 'p1', enabled: true }] }],
                            prompts: [{ identifier: 'p1', name: 'Main Prompt', role: 'system', content: longPreset }],
                        },
                    }),
                },
                extensionSettings: {},
            }),
        };

        const readers = askReaders({ redactText: false });
        const charRes = await readers.wb_read_character({ fields: ['description'] });
        expect(charRes.description).toBe(longDesc);

        const presetRes = await readers.wb_read_preset({ entry: 'Main Prompt' });
        expect(presetRes.content).toBe(longPreset);

        const worldRes = await readers.wb_read_world_info({ search: 'lore' });
        expect(worldRes.entries[0].content).toBe(longWorld);
    });

    test('askSystemPrompt returns non-empty prompt and readLabel maps all read tools', () => {
        const prompt = askSystemPrompt();
        expect(typeof prompt).toBe('string');
        expect(prompt.trim().length).toBeGreaterThan(0);
        for (const toolName of [
            'wb_read_orch',
            'wb_read_world_info_trace',
            'wb_read_connections',
            'wb_read_skills',
            'wb_list_luker_docs',
            'wb_read_luker_doc',
        ]) {
            const label = readLabel(toolName);
            expect(typeof label).toBe('string');
            expect(label.length).toBeGreaterThan(0);
            expect(label).not.toBe(toolName);
        }
        expect(readsSummary([{ name: 'wb_list_requests', args: {}, chars: 10 }]).length).toBeGreaterThan(0);
    });

    test('runAsk preserves raw reasoning, unified signature, and extra_content across tool rounds; buildAskHistory keeps requestIds', async () => {
        const seen = [];
        const rawReasoning = '  step 1: check logs\n  step 2: verify 429  \n';
        const script = [
            {
                text: 'Checking logs',
                reasoning: rawReasoning,
                reasoningBlocks: [{ type: 'thinking', thinking: 'abc', signature: 'sig-1' }],
                reasoningDetails: [{ type: 'reasoning.text', text: 'abc' }],
                calls: [{
                    id: 'c1',
                    name: 'wb_list_requests',
                    args: { limit: 5 },
                    signature: 'gem-sig-1',
                    extra_content: { google: { thought_signature: 'proxy-sig-1' } },
                }],
            },
            {
                text: '',
                calls: [{ id: 'c2', name: 'wb_answer', args: { text: 'Found 429', suggest: 'memory_graph', request_ids: ['req-429'] } }],
            },
        ];
        const res = await runAsk({
            question: 'Why 429?',
            overview: {},
            readers: { wb_list_requests: async () => [{ id: 'req-429', status: '失败 429' }] },
            request: async (messages) => {
                seen.push(structuredClone(messages));
                return script.shift();
            },
        });
        expect(res.answer).toBe('Found 429');
        expect(res.suggest).toBe('memory_graph');
        expect(res.requestIds).toEqual(['req-429']);
        const assistantTurn = seen[1].find(m => m.role === 'assistant');
        // Reasoning must be preserved verbatim without .trim()
        expect(assistantTurn.reasoning).toBe(rawReasoning);
        expect(assistantTurn.reasoning_blocks).toEqual([{ type: 'thinking', thinking: 'abc', signature: 'sig-1' }]);
        expect(assistantTurn.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'abc' }]);
        expect(assistantTurn.tool_calls[0].signature).toBe('gem-sig-1');
        expect(assistantTurn.tool_calls[0].thoughtSignature).toBeUndefined();
        expect(assistantTurn.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'proxy-sig-1' } });

        const history = buildAskHistory([
            { role: 'user', text: 'Why 429?' },
            { role: 'ai', answer: 'Found 429', requestIds: ['req-429'] },
        ]);
        expect(history[1].content).toContain('req-429');
    });

    test('aiRequest for ask omits character card while honoring preset envelope, normalizes signature from raw.signature/raw.thoughtSignature, and keeps raw reasoning', async () => {
        const rawReasoning = '\n  keep leading & trailing spaces  ';
        const runnerMock = jest.fn(async () => ({
            assistantText: 'ok',
            reasoning: rawReasoning,
            toolCalls: [
                { id: 't1', name: 'wb_read_chat', args: {}, raw: { thoughtSignature: 'gem-ts-9', extra_content: { google: { thought_signature: 'ec-1' } } } },
                { id: 't2', name: 'wb_read_preset', args: {}, raw: { signature: 'or-sig-2' } },
            ],
        }));
        globalThis.Luker = {
            getContext: () => ({
                iterationLibrary: { runner: { requestToolCallsWithRetry: runnerMock } },
                extensionSettings: {},
            }),
        };

        const out = await aiRequest('ask', {
            messages: [{ role: 'user', content: 'hi' }],
            tools: askTools({ content: false, plugins: false, inspector: false, frontLogs: false, serverLogs: false }),
        });
        expect(runnerMock).toHaveBeenCalledTimes(1);
        const callOpts = runnerMock.mock.calls[0][2];
        expect(callOpts.includeCharacterCard).toBe(false);
        expect(out.reasoning).toBe(rawReasoning);
        expect(out.calls[0].signature).toBe('gem-ts-9');
        expect(out.calls[0].thoughtSignature).toBeUndefined();
        expect(out.calls[0].extra_content).toEqual({ google: { thought_signature: 'ec-1' } });
        expect(out.calls[1].signature).toBe('or-sig-2');
        expect(out.calls[1].thoughtSignature).toBeUndefined();
    });

    test('runAsk defers wb_answer when mixed with read calls in original order and propagates request errors', async () => {
        const seen = [];
        const readSpy = jest.fn(async () => ({ messages: [{ floor: 3, text: 'actual floor' }] }));
        const mixedScript = [
            {
                text: 'Let me check first.',
                calls: [
                    // Deliberately put wb_answer first with signature to verify order & signature preservation
                    { id: 'c_ans_early', name: 'wb_answer', args: { text: 'Premature guess' }, signature: 'first-call-sig' },
                    { id: 'c_read_1', name: 'wb_read_chat', args: {} },
                ],
            },
            {
                text: '',
                calls: [{ id: 'c_ans_final', name: 'wb_answer', args: { text: 'Verified from floor 3' } }],
            },
        ];

        const mixedRes = await runAsk({
            question: 'What happened on floor 3?',
            overview: {},
            readers: { wb_read_chat: readSpy },
            request: async (messages) => {
                seen.push(structuredClone(messages));
                return mixedScript.shift();
            },
        });
        expect(readSpy).toHaveBeenCalledTimes(1);
        expect(mixedRes.answer).toBe('Verified from floor 3');
        expect(mixedRes.reads).toHaveLength(1);

        const round2Msgs = seen[1];
        const assistantMsg = round2Msgs.find(m => m.role === 'assistant');
        expect(assistantMsg.tool_calls.map(tc => tc.function.name)).toEqual(['wb_answer', 'wb_read_chat']);
        expect(assistantMsg.tool_calls[0].signature).toBe('first-call-sig');
        const toolMsgs = round2Msgs.filter(m => m.role === 'tool');
        expect(toolMsgs).toHaveLength(2);
        expect(toolMsgs[0].tool_call_id).toBe('c_ans_early');
        expect(JSON.parse(toolMsgs[0].content)).toMatchObject({ deferred: true });
        expect(toolMsgs[1].tool_call_id).toBe('c_read_1');
        expect(toolMsgs[1].content).toContain('actual floor');

        // Abort and API errors propagate directly without silent degradation
        const abortErr = Object.assign(new Error('request aborted'), { name: 'GenerateTaskError', code: 'aborted' });
        await expect(runAsk({
            question: 'Abort error',
            overview: {},
            readers: {},
            request: async () => { throw abortErr; },
        })).rejects.toBe(abortErr);

        const apiErr = new Error('HTTP 429: rate limit exceeded');
        await expect(runAsk({
            question: 'Rate limit error',
            overview: {},
            readers: {},
            request: async () => { throw apiErr; },
        })).rejects.toBe(apiErr);
    });

    test('wb_read_request reads real inspector responseParts, wireRequest tools, image/embedding types, and rejects empty/boolean message_index', async () => {
        globalThis.Luker = {
            getContext: () => ({
                chat: [],
                getRequestHeaders: () => ({}),
                extensionSettings: {},
            }),
        };

        const longMsg = 'M'.repeat(12000);
        globalThis.fetch = jest.fn(async (url) => {
            const target = String(url);
            if (target.includes('/api/request-inspector/req-long')) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-long',
                        type: 'chat',
                        status: 'success',
                        fullMessages: [{ role: 'system', content: longMsg }],
                        responseText: 'ok',
                    }),
                };
            }
            if (target.includes('/api/request-inspector/req-chat')) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-chat',
                        type: 'chat',
                        source: 'openai',
                        model: 'claude-sonnet-4',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 1200,
                        fullMessages: [
                            { role: 'system', content: 'sys 0' },
                            {
                                role: 'user',
                                content: [
                                    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(5000)}` } },
                                    { type: 'text', text: 'visible caption after image' },
                                ],
                            },
                            { role: 'tool', name: 'wb_read_chat', tool_call_id: 'call_42', content: 'tool result 2' },
                            { role: 'user', content: 'msg 3 latest' },
                        ],
                        responseText: 'final reply',
                        responseParts: [
                            { type: 'reasoning', kind: 'thinking', text: 'Step one plaintext.' },
                            { type: 'reasoning', kind: 'redacted_thinking', data: 'CIPHERTEXT_REDACTED_MUST_SKIP' },
                            { type: 'reasoning', kind: 'signature', signature: 'SIGNATURE_MUST_SKIP' },
                            {
                                type: 'reasoning',
                                kind: 'details',
                                details: [
                                    { type: 'reasoning.text', text: 'Step two detail text.' },
                                    { type: 'reasoning.encrypted', id: 'rs_9', data: 'ENCRYPTED_DETAIL_MUST_SKIP' },
                                ],
                            },
                            { type: 'tool_call', id: 'tc_1', name: 'wb_read_preset', args: { entry: 'Main' } },
                        ],
                        wireRequest: {
                            tools: [
                                { type: 'function', function: { name: 'wb_answer', description: 'Submit answer' } },
                                { type: 'function', function: { name: 'wb_read_preset', description: 'Inspect preset' } },
                            ],
                            tool_choice: 'auto',
                        },
                    }),
                };
            }
            if (target.includes('/api/request-inspector/req-image')) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-image',
                        type: 'image',
                        source: 'comfyui',
                        model: 'flux-dev',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 4800,
                        prompt: 'moonlit silver tower, painterly',
                        negativePrompt: 'blurry, lowres',
                        width: 1024,
                        height: 1536,
                        steps: 28,
                        sampler: 'euler_ancestral',
                    }),
                };
            }
            if (target.includes('/api/request-inspector/req-embed-query')) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-embed-query',
                        type: 'embedding',
                        source: 'openai',
                        model: 'text-embedding-3-large',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 210,
                        operation: 'embed',
                        routeKind: 'query',
                        collectionId: 'chat-42',
                        collectionIds: null,
                        query: '',
                        inputCount: 1,
                        inputCharTotal: 16,
                        inputTexts: [{ index: 0, text: 'silver key vault' }],
                        topK: 10,
                        threshold: 0,
                        resultCount: 1,
                        vectorDim: 3072,
                        hits: [
                            { collectionId: 'chat-42', hash: 'h1', score: 0.91, text: 'The silver key unlocks the clocktower vault.' },
                        ],
                    }),
                };
            }
            if (target.includes('/api/request-inspector/req-embed-rerank')) {
                const longDoc = 'R'.repeat(500);
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-embed-rerank',
                        type: 'embedding',
                        source: 'cohere',
                        model: 'rerank-v3.5',
                        status: 'success',
                        httpStatus: 200,
                        durationMs: 185,
                        operation: 'rerank',
                        routeKind: 'rerank',
                        collectionId: null,
                        collectionIds: null,
                        query: 'clocktower promise',
                        inputCount: 15,
                        inputCharTotal: 1200,
                        inputTexts: Array.from({ length: 15 }, (_, idx) => ({ index: idx, text: idx === 0 ? longDoc : `doc ${idx}` })),
                        topK: 5,
                        threshold: null,
                        resultCount: 1,
                        vectorDim: null,
                        hits: [
                            { index: 3, hash: 'h2', score: 0.95, text: 'We promised to meet at the clocktower.' },
                        ],
                    }),
                };
            }
            if (target.includes('/api/request-inspector/req-array')) {
                return {
                    ok: true,
                    json: async () => [{ id: 'unexpected-list-item' }],
                };
            }
            return { ok: false, status: 404 };
        });

        const readers = askReaders({ redactText: true });

        const reqTail = await readers.wb_read_request({
            id: 'req-chat',
            tail_messages: 2,
            include_reasoning: true,
            include_tools: true,
        });
        expect(reqTail.type).toBe('chat');
        expect(reqTail.omittedHeadMessages).toBe(2);
        expect(reqTail.messages.map(m => m.index)).toEqual([2, 3]);
        expect(reqTail.reasoning).toContain('Step one plaintext.');
        expect(reqTail.reasoning).toContain('Step two detail text.');
        expect(reqTail.reasoning).not.toContain('CIPHERTEXT_REDACTED_MUST_SKIP');
        expect(reqTail.reasoning).not.toContain('SIGNATURE_MUST_SKIP');
        expect(reqTail.reasoning).not.toContain('ENCRYPTED_DETAIL_MUST_SKIP');
        expect(reqTail.replyToolCalls).toEqual([
            { id: 'tc_1', name: 'wb_read_preset', args: '{"entry":"Main"}' },
        ]);
        expect(reqTail.tools).toEqual([
            { name: 'wb_answer', description: 'Submit answer' },
            { name: 'wb_read_preset', description: 'Inspect preset' },
        ]);
        expect(reqTail.toolChoice).toBe('auto');

        // Empty string and boolean message_index must NOT coerce to 0
        const emptyIdxRes = await readers.wb_read_request({ id: 'req-chat', message_index: '' });
        expect(emptyIdxRes.messages).toHaveLength(4);
        const boolIdxRes = await readers.wb_read_request({ id: 'req-chat', message_index: false });
        expect(boolIdxRes.messages).toHaveLength(4);
        // Multimodal base64 image blocks are replaced by [image] so text is not truncated, and tool_call_id/name are preserved
        expect(emptyIdxRes.messages[1].content).toBe('[image]\nvisible caption after image');
        expect(emptyIdxRes.messages[1].content).not.toContain('AAAA');
        expect(emptyIdxRes.messages[2].toolCallId).toBe('call_42');
        expect(emptyIdxRes.messages[2].name).toBe('wb_read_chat');
        // Numeric 0 DOES select only message 0; message_index returns full untruncated content (>10000 chars)
        const zeroIdxRes = await readers.wb_read_request({ id: 'req-chat', message_index: 0 });
        expect(zeroIdxRes.messages).toHaveLength(1);
        expect(zeroIdxRes.messages[0].index).toBe(0);
        expect(zeroIdxRes.messages[0].content).toBe('sys 0');

        const longFull = await readers.wb_read_request({ id: 'req-long', message_index: 0 });
        expect(longFull.messages[0].content).toBe(longMsg);
        const longList = await readers.wb_read_request({ id: 'req-long' });
        expect(longList.messages[0].content).toBe(longMsg);
        const longTail = await readers.wb_read_request({ id: 'req-long', tail_messages: 1 });
        expect(longTail.messages[0].content).toBe(longMsg);

        // Non-chat request types: image & embedding
        const imgRes = await readers.wb_read_request({ id: 'req-image' });
        expect(imgRes).toMatchObject({
            id: 'req-image',
            type: 'image',
            prompt: 'moonlit silver tower, painterly',
            negativePrompt: 'blurry, lowres',
            width: 1024,
            height: 1536,
            steps: 28,
            sampler: 'euler_ancestral',
        });

        const embQueryRes = await readers.wb_read_request({ id: 'req-embed-query' });
        expect(embQueryRes).toMatchObject({
            id: 'req-embed-query',
            type: 'embedding',
            operation: 'embed',
            routeKind: 'query',
            collectionId: 'chat-42',
            inputCount: 1,
            inputCharTotal: 16,
            inputTexts: [{ index: 0, text: 'silver key vault' }],
            topK: 10,
            threshold: 0,
            resultCount: 1,
            vectorDim: 3072,
            hits: [{ collectionId: 'chat-42', hash: 'h1', score: 0.91, text: 'The silver key unlocks the clocktower vault.' }],
        });
        expect(embQueryRes.query).toBeUndefined();

        const embRerankRes = await readers.wb_read_request({ id: 'req-embed-rerank' });
        expect(embRerankRes).toMatchObject({
            id: 'req-embed-rerank',
            type: 'embedding',
            operation: 'rerank',
            routeKind: 'rerank',
            query: 'clocktower promise',
            inputCount: 15,
            inputCharTotal: 1200,
            topK: 5,
            resultCount: 1,
            hits: [{ index: 3, hash: 'h2', score: 0.95, text: 'We promised to meet at the clocktower.' }],
        });
        expect(embRerankRes.inputTexts).toHaveLength(15);
        expect(embRerankRes.inputTexts[0]).toEqual({ index: 0, text: 'R'.repeat(500) });

        // Reject invalid/reserved/traversal IDs before calling fetch, and reject array payloads
        globalThis.fetch.mockClear();
        for (const badId of ['', '   ', '.', '..', '../x', 'list', 'LIST', 'foo/bar', 'a\\b', 'req?x=1', 'req#hash', 'bad id', 'a\u0007b']) {
            await expect(readers.wb_read_request({ id: badId })).rejects.toThrow(SourceError);
        }
        expect(globalThis.fetch).not.toHaveBeenCalled();

        await expect(readers.wb_read_request({ id: 'req-array' })).rejects.toThrow(SourceError);
    });

    test('wb_read_preset, wb_read_regex, wb_read_variables, wb_read_world_info_trace, and wb_read_chat use real Luker runtime structures', async () => {
        const globalScript = { id: 'r-global', scriptName: 'Global Strip', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '', disabled: false, markdownOnly: true };
        const longStatusBarHtml = `<div class="status">${'<span>stat</span>'.repeat(40)}</div>`;
        const longDisabledScript = { id: 'r-status-html', scriptName: 'Status Bar HTML', findRegex: '/<sb>([\\s\\S]*?)<\\/sb>/g', replaceString: longStatusBarHtml, disabled: true, markdownOnly: true };
        const charAllowed = { id: 'r-char-ok', scriptName: 'Char Format Allowed', findRegex: '/foo/g', replaceString: 'bar', disabled: false };
        const charBlocked = { id: 'r-char-no', scriptName: 'Char Format Unapproved', findRegex: '/baz/g', replaceString: 'qux', disabled: false };
        const presetAllowed = { id: 'r-pre-ok', scriptName: 'Preset Allowed', findRegex: '/a/g', replaceString: 'b', disabled: false };
        const presetBlocked = { id: 'r-pre-no', scriptName: 'Preset Unapproved', findRegex: '/c/g', replaceString: 'd', disabled: false };
        const pluginScript = { id: 'r-mg-hide', scriptName: 'Hide Memory Block', findRegex: '/<mem>/g', replaceString: '', disabled: false, pluginOnly: true, __runtime_owner: 'memory-graph' };

        const getPluginLanesSpy = jest.fn((s) => (s.pluginOnly ? ['request', 'reply'] : []));

        globalThis.Luker = {
            getContext: () => ({
                chat: [
                    { mes: 'First floor hello', is_user: true },
                    {
                        mes: 'We made a promise about the silver key.',
                        is_user: false,
                        name: 'Alice',
                        swipes: ['a', 'b'],
                        swipe_id: 1,
                        extra: {
                            var_ops: [
                                { op: 'set', key: 'hp', value: 80 },
                                { op: 'set', key: 'roster', path: 'alice.hp', value: 50 },
                            ],
                        },
                    },
                    { mes: 'Latest floor', is_user: false, name: 'Alice' },
                ],
                chatMetadata: { variables: { hp: 80, roster: { alice: { hp: 50 } } } },
                characters: [{ avatar: 'alice.png', name: 'Alice', data: { extensions: { world: 'LoreA' } } }],
                characterId: 0,
                chatWorldInfo: {
                    getNames: () => ['LoreA', 'PresetBook'],
                    globalSelection: ['PresetBook'],
                    getActivationTrace: async () => ({
                        scopeKey: 'chat:1',
                        entries: [
                            {
                                world: 'LoreA',
                                uid: 1,
                                lastActivatedAt: 1700000000000,
                                lastActivation: { reason: 'keyword', matchedKey: 'silver key' },
                                recentScans: [{ activated: true, lastActivation: { reason: 'keyword', matchedKey: 'silver key' }, attempts: [] }],
                            },
                            {
                                world: 'LoreA',
                                uid: 2,
                                lastActivatedAt: 1699999000000,
                                lastActivation: { reason: 'keyword', matchedKey: 'old_dragon_hit' },
                                recentScans: [{ activated: false, attempts: [{ reason: 'no_keyword_match', scanDepth: 4 }] }],
                            },
                        ],
                    }),
                },
                loadWorldInfo: async () => ({
                    entries: {
                        1: { uid: 1, key: ['silver key'], comment: 'Silver Key Lore', content: 'Unlocks the vault.' },
                        2: { uid: 2, key: ['dragon'], comment: 'Dragon Lore', content: 'Sleeps under the mountain.' },
                    },
                }),
                presets: {
                    getLive: () => ({
                        ref: { name: 'CardBoundPreset', origin: { kind: 'character' } },
                        body: {
                            // Dual-key OpenAI fallback fields without primary keys
                            temp_openai: 0.85,
                            top_p_openai: 0.92,
                            top_k_openai: 40,
                            freq_pen_openai: 0.15,
                            pres_pen_openai: 0.25,
                            reasoning_effort: 'high',
                            show_thoughts: true,
                            function_calling: true,
                            extensions: {
                                preset_lorebook: {
                                    version: 1,
                                    name: 'PresetBook',
                                    data: {
                                        entries: {
                                            0: { uid: 0, content: 'SECRET_EMBEDDED_LORE_BODY_NEVER_DUMP' },
                                            1: { uid: 1, content: 'SECOND_LORE_BODY_NEVER_DUMP' },
                                        },
                                    },
                                },
                            },
                            prompt_order: [{ character_id: 100001, order: [{ identifier: 'style_rule', enabled: true }] }],
                            prompts: [{ identifier: 'style_rule', name: 'Writing Style Rules', role: 'system', content: 'Be vivid.' }],
                        },
                    }),
                },
                regex: {
                    SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
                    getScriptsByType: (type, { allowedOnly = false } = {}) => {
                        if (type === 0) return [globalScript, longDisabledScript];
                        if (type === 1) return allowedOnly ? [charAllowed] : [charAllowed, charBlocked];
                        if (type === 2) return allowedOnly ? [presetAllowed] : [presetAllowed, presetBlocked];
                        return [];
                    },
                    getScripts: () => [globalScript, charAllowed, charBlocked, presetAllowed, presetBlocked, pluginScript],
                    getPluginLanes: getPluginLanesSpy,
                },
                extensionSettings: {
                    workbench: { ask: { floors: 2 } },
                    variables: { global: { theme: 'dark' } },
                },
            }),
        };

        const readers = askReaders({ redactText: true });

        // wb_read_chat search
        const chatSearch = await readers.wb_read_chat({ search: 'silver key' });
        expect(chatSearch.totalMatches).toBe(1);
        expect(chatSearch.messages[0].floor).toBe(1);
        expect(chatSearch.messages[0].swipes).toBe(2);
        expect(chatSearch.messages[0].varOpsCount).toBe(2);

        // wb_read_world_info_trace: unactivated entry has activation: null (distinct from historical lastActivation) & search matches attempts
        const traceAll = await readers.wb_read_world_info_trace({});
        expect(traceAll.activatedCount).toBe(1);
        const unactivated = traceAll.entries.find(e => e.uid === 2);
        expect(unactivated.activated).toBe(false);
        expect(unactivated.activation).toBeNull();
        expect(unactivated.lastActivation).toEqual({ reason: 'keyword', matchedKey: 'old_dragon_hit' });
        const traceByAttempt = await readers.wb_read_world_info_trace({ search: 'no_keyword_match' });
        expect(traceByAttempt.entries).toHaveLength(1);
        expect(traceByAttempt.entries[0].uid).toBe(2);

        // wb_read_variables: search matches op.path
        const varsBySubpath = await readers.wb_read_variables({ search: 'alice', include_global: true });
        expect(varsBySubpath.recentFloorOps).toHaveLength(1);
        expect(varsBySubpath.recentFloorOps[0].ops).toEqual([
            { op: 'set', key: 'roster', path: 'alice.hp', value: 50 },
        ]);
        const varsAll = await readers.wb_read_variables({ include_global: true });
        expect(varsAll.localVariables.hp).toBe(80);
        expect(varsAll.globalVariables.theme).toBe('dark');

        // wb_read_regex: scope='plugin' strictly filters by __runtime_owner; character/preset report allowed; getPluginLanes invoked
        const pluginOnly = await readers.wb_read_regex({ scope: 'plugin' });
        expect(pluginOnly.scripts).toHaveLength(1);
        expect(pluginOnly.scripts[0]).toMatchObject({
            scope: 'plugin',
            id: 'r-mg-hide',
            owner: 'memory-graph',
            pluginLanes: ['request', 'reply'],
        });
        expect(getPluginLanesSpy).toHaveBeenCalled();

        const charRegex = await readers.wb_read_regex({ scope: 'character' });
        expect(charRegex.scripts.map(s => ({ id: s.id, allowed: s.allowed }))).toEqual([
            { id: 'r-char-ok', allowed: true },
            { id: 'r-char-no', allowed: false },
        ]);

        const presetRegex = await readers.wb_read_regex({ scope: 'preset' });
        expect(presetRegex.scripts.map(s => ({ id: s.id, allowed: s.allowed }))).toEqual([
            { id: 'r-pre-ok', allowed: true },
            { id: 'r-pre-no', allowed: false },
        ]);

        // Both list mode and id mode return full untruncated replaceString
        const globalListAll = await readers.wb_read_regex({ scope: 'global', only_enabled: false });
        const longListRow = globalListAll.scripts.find(s => s.id === 'r-status-html');
        expect(longListRow.replaceString).toBe(longStatusBarHtml);

        const fullById = await readers.wb_read_regex({ id: 'r-status-html' });
        expect(fullById.scripts).toHaveLength(1);
        expect(fullById.scripts[0].enabled).toBe(false);
        expect(fullById.scripts[0].replaceString).toBe(longStatusBarHtml);

        // wb_read_preset: real preset_lorebook metadata only, origin='character', dual-key sampling fallbacks
        const presetSummary = await readers.wb_read_preset({});
        expect(presetSummary.origin).toBe('character');
        expect(presetSummary.settings).toMatchObject({
            temperature: 0.85,
            top_p: 0.92,
            top_k: 40,
            frequency_penalty: 0.15,
            presence_penalty: 0.25,
            reasoning_effort: 'high',
        });
        expect(presetSummary.presetLorebook).toEqual({
            name: 'PresetBook',
            entryCount: 2,
            activeInGlobal: true,
        });
        expect(JSON.stringify(presetSummary)).not.toContain('SECRET_EMBEDDED_LORE_BODY_NEVER_DUMP');
        expect(JSON.stringify(presetSummary)).not.toContain('SECOND_LORE_BODY_NEVER_DUMP');
        const presetFuzzy = await readers.wb_read_preset({ entry: 'style' });
        expect(presetFuzzy.content).toBe('Be vivid.');
    });

    test('wb_read_luker_env, wb_read_connections, wb_read_skills, and askOverview handle Search Tools dual switch, real Sync fields, and safe Connections', async () => {
        globalThis.Luker = {
            getContext: () => ({
                chat: [],
                chatCompletionSettings: { chat_completion_source: 'openai' },
                connectionProfiles: {
                    list: () => [
                        {
                            name: 'MainAPI',
                            api: 'openai',
                            model: 'gemini-2.5-pro',
                            proxy: 'MyReverseProxy',
                            'function-calling-plain-text': 'false',
                            'rpm-limit': 30,
                            'request-timeout': 60000,
                            'max-request-retries': 3,
                            'api-url': 'https://private-gateway.internal/v1',
                            'network-proxy': 'http://alice:pw@proxy.internal:7890',
                            apiKey: 'sk-should-never-appear-12345678',
                        },
                        {
                            name: 'PlainTextAPI',
                            api: 'openai',
                            model: 'deepseek-r1',
                            'function-calling-plain-text': true,
                        },
                    ],
                },
                listExtensionNames: () => ['memory-graph', 'orchestrator', 'regex', 'search-tools'],
                skills: {
                    list: async () => [
                        { name: 'anti-cliche', scope: { kind: 'global' }, description: 'Avoid repetition' },
                        { name: 'orch-helper', scope: { kind: 'orch-preset', presetId: 'p1' }, description: 'Orch preset skill' },
                        { name: 'alice-private', scope: { kind: 'character', avatar: 'alice.png' }, description: 'Card skill' },
                        { name: 'rp-preset-skill', scope: { kind: 'preset', presetName: 'Main' }, description: 'Preset skill' },
                    ],
                },
                getRequestHeaders: () => ({}),
                extensionSettings: {
                    workbench: {},
                    // Tool mode OFF, pre-request agent mode ON
                    search_tools: {
                        enabled: false,
                        preRequestEnabled: true,
                        provider: 'tavily',
                        lorebookPosition: 2,
                        lorebookDepth: 4,
                        apiKey: 'sk-secret-search-99999999',
                    },
                    disabledExtensions: ['tts'],
                },
            }),
        };

        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                backends: {
                    s3_primary: {
                        kind: 's3',
                        label: 'Primary S3',
                        running: true,
                        lastSync: { at: 1700000005000, error: 'etag conflict', stalled: ['chat_a.jsonl', 'chat_b.jsonl'] },
                        pendingError: { message: 'retrying in 30s' },
                    },
                },
                conflicts: [{ id: 'cf-1' }],
                notices: [{ id: 'nt-1' }, { id: 'nt-2' }],
                errors: { s3_primary: { code: 'E_SYNC', message: 'timeout' } },
            }),
        }));

        // askOverview recognizes search_tools as ON when only preRequestEnabled is true
        const overview = await askOverview({
            sources: { content: false, plugins: true, inspector: false, frontLogs: false },
            redactText: true,
        });
        expect(overview.环境.联网搜索).toBe('开');

        const fullReaders = askReaders({ redactText: true });

        const searchTools = await fullReaders.wb_read_luker_env({ part: 'search_tools' });
        expect(searchTools).toEqual({
            installed: true,
            enabled: false,
            preRequestEnabled: true,
            provider: 'tavily',
            lorebookPosition: 2,
            lorebookDepth: 4,
        });

        const envConns = await fullReaders.wb_read_connections({});
        expect(envConns.profiles[0]).toEqual({
            name: 'MainAPI',
            api: 'openai',
            model: 'gemini-2.5-pro',
            proxy: 'MyReverseProxy',
            plainTextFunctionCalling: false,
            rpmLimit: 30,
            requestTimeout: 60000,
            maxRetries: 3,
            hasCustomUrl: true,
            hasNetworkProxy: true,
        });
        expect(envConns.profiles[1].plainTextFunctionCalling).toBe(true);
        expect(envConns.profiles[1].hasCustomUrl).toBe(false);
        expect(envConns.profiles[1].hasNetworkProxy).toBe(false);
        expect(JSON.stringify(envConns)).not.toContain('private-gateway.internal');
        expect(JSON.stringify(envConns)).not.toContain('proxy.internal');
        expect(JSON.stringify(envConns)).not.toContain('sk-should-never-appear');

        const skillsRes = await fullReaders.wb_read_skills({});
        expect(skillsRes.available).toBe(true);
        expect(skillsRes.total).toBe(4);
        expect(skillsRes.skills.map(s => s.name)).toEqual(['anti-cliche', 'orch-helper', 'alice-private', 'rp-preset-skill']);

        const envSync = await fullReaders.wb_read_luker_env({ part: 'sync' });
        expect(envSync).toEqual({
            available: true,
            backendCount: 1,
            backends: [{
                id: 's3_primary',
                kind: 's3',
                label: 'Primary S3',
                running: true,
                lastSyncAt: 1700000005000,
                lastError: 'etag conflict',
                pendingError: 'retrying in 30s',
                stalledCount: 2,
            }],
            pendingConflicts: 1,
            pendingNotices: 2,
            errors: [{ backendId: 's3_primary', code: 'E_SYNC', message: 'timeout' }],
        });

        const envSummary = await fullReaders.wb_read_luker_env({ part: 'summary' });
        expect(envSummary.activeConnection).toBeUndefined();
        expect(envSummary.connectionProfileCount).toBeUndefined();
        expect(envSummary.workbenchAskTarget).toBeUndefined();
        expect(envSummary.enabledExtensionsCount).toBe(4);
    });

    test('wb_read_memory uses real read-api node shape, schema shape, settings keys, recency sort, seq_to=-1, and preserves full fields', async () => {
        const longDetail = 'D'.repeat(450);
        const longSummarize = 'S'.repeat(300);
        const memProvider = createMemoryAskProvider(() => null, {
            getSettings: () => ({
                enabled: true,
                recallMethod: 'rag',
                recallEnabled: true,
                autoExtractionEnabled: false,
                updateEvery: 5,
            }),
            ensureMemoryStoreLoaded: async () => ({}),
            getMemoryGraphReadApi: () => ({
                // Deliberately supply in oldest-first / scrambled order to verify descending recency sort
                listNodes: () => [
                    {
                        id: 'n_unwatermarked',
                        type: 'character',
                        level: 'semantic',
                        title: '爱丽丝',
                        fields: { summary: '主角同伴', note: '无楼层水位背景卡' },
                        seq_to: -1,
                        parent_id: null,
                        children_ids: ['n_old'],
                        archived: false,
                        semantic_rollup: true,
                        semantic_depth: 1,
                    },
                    {
                        id: 'n_old',
                        type: 'event',
                        level: 'episodic',
                        title: '酒馆初遇',
                        fields: { summary: '在酒馆遇见爱丽丝' },
                        seq_to: 5,
                        floor_range: { start: 3, end: 5 },
                        parent_id: null,
                        children_ids: [],
                        archived: true,
                        semantic_rollup: false,
                        semantic_depth: 0,
                    },
                    {
                        id: 'n_new',
                        type: 'event',
                        level: 'episodic',
                        title: '约定见面',
                        fields: { summary: '昨天约好去钟楼见面', detail: longDetail },
                        seq_to: 12,
                        floor_range: { start: 10, end: 14 },
                        parent_id: 'n_unwatermarked',
                        children_ids: [],
                        archived: false,
                        semantic_rollup: false,
                        semantic_depth: 0,
                    },
                ],
            }),
        });

        const memCtx = {
            chat: Array.from({ length: 20 }, () => ({ mes: 'x' })),
            getCurrentChatId: () => 'chat-1',
            getExtensionApi: () => ({
                getAdvancedScopeInfo: () => ({
                    scope: 'character',
                    settings: { persistentInjectionMaxSeqDistance: 80, updateEvery: 2 },
                }),
                getSchemaScopeInfo: () => ({
                    scope: 'character',
                    schema: [{
                        id: 'event',
                        label: '事件',
                        alwaysInject: true,
                        extractHint: '提取关键剧情事件与承诺',
                        extractionInstructions: '仅记录已发生的重要事件',
                        tableColumns: ['summary', 'location', 'participants'],
                        columnHints: { summary: '一句话概括事件', location: '发生地点' },
                        compression: { mode: 'hierarchical', threshold: 20, summarizeInstruction: longSummarize },
                    }],
                }),
                getLastRecallProjection: async () => ({ at: Date.now(), blocks: { corePacket: 'core', focusPacket: 'focus' } }),
            }),
        };

        const memSummary = await memProvider.readers.wb_read_memory({ part: 'summary' }, memCtx);
        expect(memSummary.recallMethod).toBe('rag');
        expect(memSummary.recallEnabled).toBe(true);
        expect(memSummary.autoExtractionEnabled).toBe(false);
        // adv.settings.updateEvery (2) overrides settings.updateEvery (5)
        expect(memSummary.updateEvery).toBe(2);
        expect(memSummary.maxSeqDistance).toBe(80);
        expect(memSummary.countsByType.event).toEqual({ total: 2, active: 1, archived: 1 });
        expect(memSummary.countsByType.character).toEqual({ total: 1, active: 1, archived: 0 });

        const memNodes = await memProvider.readers.wb_read_memory({ part: 'nodes' }, memCtx);
        expect(memNodes.nodes.map(n => n.id)).toEqual(['n_new', 'n_old', 'n_unwatermarked']);
        expect(memNodes.nodes[0]).toMatchObject({
            id: 'n_new',
            type: 'event',
            level: 'episodic',
            title: '约定见面',
            summary: '昨天约好去钟楼见面',
            seqTo: 12,
            floorRange: { start: 10, end: 14 },
            parentId: 'n_unwatermarked',
            semanticRollup: false,
            depth: 0,
        });
        expect(memNodes.nodes[0].fields.detail).toBe(longDetail);
        expect(memNodes.nodes[2]).toMatchObject({
            id: 'n_unwatermarked',
            seqTo: null,
            floorRange: null,
            semanticRollup: true,
            depth: 1,
        });

        const memSearch = await memProvider.readers.wb_read_memory({ part: 'search', query: '钟楼' }, memCtx);
        expect(memSearch.matched).toBe(1);
        expect(memSearch.nodes[0].id).toBe('n_new');

        const longExtract = 'E'.repeat(420);
        const memSchema = await memProvider.readers.wb_read_memory({ part: 'schema' }, memCtx);
        expect(memSchema.scope).toBe('character');
        expect(memSchema.types[0]).toEqual({
            id: 'event',
            label: '事件',
            extractHint: '提取关键剧情事件与承诺',
            extractionInstructions: '仅记录已发生的重要事件',
            alwaysInject: true,
            tableColumns: ['summary', 'location', 'participants'],
            columnHints: { summary: '一句话概括事件', location: '发生地点' },
            compression: {
                mode: 'hierarchical',
                threshold: 20,
                summarizeInstruction: longSummarize,
            },
        });

        // Passing type to part="schema" filters to that type and returns full untruncated instructions
        const fullSchemaCtx = {
            ...memCtx,
            getExtensionApi: () => ({
                getAdvancedScopeInfo: () => ({ scope: 'global', settings: {} }),
                getSchemaScopeInfo: () => ({
                    scope: 'global',
                    schema: [
                        {
                            id: 'event',
                            label: '事件',
                            alwaysInject: true,
                            extractHint: longExtract,
                            extractionInstructions: longExtract,
                            tableColumns: ['summary'],
                            columnHints: { summary: longExtract },
                            compression: { mode: 'hierarchical', threshold: 20, summarizeInstruction: longSummarize },
                        },
                        {
                            id: 'thread',
                            label: '伏笔',
                            alwaysInject: true,
                            extractHint: 'short',
                            extractionInstructions: 'short',
                            tableColumns: ['title'],
                            columnHints: {},
                            compression: null,
                        },
                    ],
                }),
                getLastRecallProjection: async () => null,
            }),
        };
        const singleSchema = await memProvider.readers.wb_read_memory({ part: 'schema', type: 'event' }, fullSchemaCtx);
        expect(singleSchema.types).toHaveLength(1);
        expect(singleSchema.types[0].id).toBe('event');
        expect(singleSchema.types[0].extractHint).toBe(longExtract);
        expect(singleSchema.types[0].extractionInstructions).toBe(longExtract);
        expect(singleSchema.types[0].columnHints.summary).toBe(longExtract);
        expect(singleSchema.types[0].compression.summarizeInstruction).toBe(longSummarize);

        // Omitted settings.enabled defaults to false (matching memory-graph defaultSettings.enabled = false)
        const defaultDisabledProvider = createMemoryAskProvider(() => null, {
            getSettings: () => ({}),
        });
        const disabledSnap = await defaultDisabledProvider.getSnapshot(fullSchemaCtx);
        expect(disabledSnap.enabled).toBe(false);
    });

    test('wb_read_orch reads notes purely via readFloorStateSnapshot without polluting ctx and filters last_run by chatId with hyphenated Agenda agents', async () => {
        const readSnapshotSpy = jest.fn(async () => ({
            ok: true,
            state: {
                entries: [
                    { id: 'note-1', status: 'open', text: '追查银钥匙下落' },
                    { id: 'note-2', status: 'closed', text: '酒馆接头', closure_reason: '已完成' },
                    '旧格式裸字符串笔记',
                ],
            },
        }));
        const createFloorStateSpy = jest.fn(() => {
            throw new Error('wb_read_orch(part="notes") must never call createFloorState');
        });

        const orchProvider = createOrchAskProvider(() => null, {
            getSettings: () => ({ enabled: true, executionMode: 'agenda' }),
            getActivePreset: () => ({
                state: {
                    name: 'MyAgenda',
                    planner: { systemPrompt: 'plan' },
                    agents: {
                        'story-scout': { systemPrompt: 'scout clues' },
                        'plot-writer': { systemPrompt: 'write' },
                    },
                    finalAgentId: 'plot-writer',
                },
            }),
        });

        const orchCtx = {
            getCurrentChatId: () => 'chat-current',
            extensionSettings: { orchestrator: { enabled: true, executionMode: 'agenda' } },
            readFloorStateSnapshot: readSnapshotSpy,
            createFloorState: createFloorStateSpy,
            runPanel: {
                getRunRecorder: () => ({
                    history: () => [
                        {
                            runId: 'run-other-chat',
                            chatId: 'chat-other',
                            source: 'orchestrator',
                            mode: 'agenda',
                            status: 'done',
                            startedAt: 5000,
                            endedAt: 6000,
                            rounds: [{ id: 'node-plot-writer-final', status: 'done', startedAt: 5000, endedAt: 6000, sections: [{ kind: 'output', title: 'Other', body: 'wrong chat' }] }],
                        },
                        {
                            runId: 'run-cur-chat',
                            chatId: 'chat-current',
                            source: 'orchestrator',
                            mode: 'agenda',
                            status: 'error',
                            error: 'timeout',
                            startedAt: 1000,
                            endedAt: 4000,
                            rounds: [{
                                id: 'node-story-scout-investigate-1',
                                status: 'failed',
                                startedAt: 1000,
                                endedAt: 4000,
                                sections: [
                                    { id: 'node-story-scout', kind: 'text', title: 'Text', status: 'failed', body: '', meta: { err: 'Upstream 504' } },
                                    { id: 'tool-result-0', kind: 'tool_result', title: 'Tool result: finalize', status: 'failed', body: '', meta: { ok: false, err: 'finalize requires a non-empty capsule_text.', code: 'FINALIZE_EMPTY' } },
                                    { id: 'tool-0', kind: 'tool_call', title: 'Tool: chat_search', status: 'done', body: '', meta: { args: { query: 'silver key', limit: 5 }, source: 'native' } },
                                    { id: 'planner', kind: 'note', title: 'Note', status: 'done', body: '', meta: { output: { finalize: false, dispatches: [{ agent: 'story-scout', task_brief: 'X'.repeat(400) }] } } },
                                    { id: 'text-partial', kind: 'text', title: 'Text', status: 'failed', body: 'Draft without tool', meta: { err: 'no tool call' } },
                                ],
                            }],
                        },
                    ],
                }),
            },
        };

        const notesRes = await orchProvider.readers.wb_read_orch({ part: 'notes' }, orchCtx);
        expect(readSnapshotSpy).toHaveBeenCalledWith({ namespace: 'luker_orch_loop_notes' });
        expect(createFloorStateSpy).not.toHaveBeenCalled();
        expect('__floorStateForNotes' in orchCtx).toBe(false);
        expect('__openNotes' in orchCtx).toBe(false);
        expect(notesRes).toEqual({
            total: 3,
            openCount: 2,
            notes: [
                { id: 'note-1', status: 'open', text: '追查银钥匙下落' },
                { id: 'note-2', status: 'closed', text: '酒馆接头', closureReason: '已完成' },
                { id: '', status: 'open', text: '旧格式裸字符串笔记' },
            ],
        });

        // No open chat -> safely returns unavailable without calling readFloorStateSnapshot
        const noChatSnapSpy = jest.fn();
        const noChatRes = await orchProvider.readers.wb_read_orch(
            { part: 'notes' },
            {
                getCurrentChatId: () => '',
                extensionSettings: { orchestrator: { enabled: true } },
                readFloorStateSnapshot: noChatSnapSpy,
            },
        );
        expect(noChatRes).toEqual({ available: false, notes: [] });
        expect(noChatSnapSpy).not.toHaveBeenCalled();

        // last_run filters by chatId, resolves hyphenated Agenda agent id ('story-scout'), and extracts real store.js meta previews
        const lastRun = await orchProvider.readers.wb_read_orch({ part: 'last_run' }, orchCtx);
        expect(lastRun.runId).toBe('run-cur-chat');
        expect(lastRun.lanes[0].agentId).toBe('story-scout');
        const contents = lastRun.lanes[0].segments[0].sections.map(s => s.content);
        expect(contents[0]).toBe('Upstream 504');
        expect(contents[1]).toBe('[FINALIZE_EMPTY] finalize requires a non-empty capsule_text.');
        expect(contents[2]).toContain('"query":"silver key"');
        expect(contents[3]).toContain('"agent":"story-scout"');
        expect(contents[3]).toContain('X'.repeat(400));
        expect(contents[4]).toContain('no tool call');
        expect(contents[4]).toContain('Draft without tool');
    });

    test('wb_list_luker_docs and wb_read_luker_doc query /api/docs without redacting documentation URLs', async () => {
        globalThis.Luker = {
            getContext: () => ({
                getRequestHeaders: () => ({ 'X-CSRF-Token': 'tok' }),
            }),
        };
        globalThis.fetch = jest.fn(async (url) => {
            const target = String(url);
            if (target === '/api/docs/list') {
                return {
                    ok: true,
                    json: async () => ({
                        files: [
                            { path: 'features/memory-graph.md', size: 1200 },
                            { path: 'zh-CN/features/memory-graph.md', size: 1300 },
                            { path: 'features/orchestrator/index.md', size: 800 },
                        ],
                    }),
                };
            }
            if (target === '/api/docs/file?path=features%2Fmemory-graph.md') {
                return {
                    ok: true,
                    json: async () => ({
                        path: 'features/memory-graph.md',
                        size: 64,
                        content: '# Memory Graph\nSee https://luker.cups.moe/features/memory-graph',
                    }),
                };
            }
            return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
        });

        const readers = askReaders({ redactText: true });
        const filtered = await readers.wb_list_luker_docs({ filter: 'memory' });
        expect(filtered.ok).toBe(true);
        expect(filtered.files.map(f => f.path)).toEqual(['features/memory-graph.md']);
        expect(filtered.hiddenTranslations).toBe(1);

        const withTranslations = await readers.wb_list_luker_docs({ filter: 'memory', include_translations: true });
        expect(withTranslations.files.map(f => f.path)).toEqual([
            'features/memory-graph.md',
            'zh-CN/features/memory-graph.md',
        ]);

        const doc = await readers.wb_read_luker_doc({ path: 'features/memory-graph.md' });
        expect(doc.ok).toBe(true);
        expect(doc.content).toContain('https://luker.cups.moe/features/memory-graph');
    });

    test('wb_answer.suggest includes memory_graph and memory, and ask page renders distinct jump labels plus clickable requestIds chips', async () => {
        const answerTool = askTools({}).find(t => t.function.name === 'wb_answer');
        const suggestEnum = answerTool.function.parameters.properties.suggest.enum;
        expect(suggestEnum).toContain('memory_graph');
        expect(suggestEnum).toContain('memory');

        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        const prevWindow = globalThis.window;
        const prevDocument = globalThis.document;
        const prevHTMLElement = globalThis.HTMLElement;
        const prevNode = globalThis.Node;
        const prevRAF = globalThis.requestAnimationFrame;
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
        globalThis.Node = dom.window.Node;
        globalThis.requestAnimationFrame = (cb) => cb();
        try {
            const { createAskPage } = await import('../../public/scripts/workbench/pages/ask.js');
            const openSpy = jest.fn(async () => {});
            const goSpy = jest.fn();
            const sessionObj = {
                id: 's1',
                kind: 'ask',
                title: '429 and memory check',
                updatedAt: Date.now(),
                turns: [
                    { role: 'user', text: 'Why 429 and missing node?' },
                    {
                        role: 'ai',
                        answer: 'Edit current chat memory node.',
                        suggest: 'memory_graph',
                        fixPrompt: 'Add clocktower promise node',
                        requestIds: ['req_abc123', 'req_abc123', 'req_def456'],
                        reads: [{ name: 'wb_read_orch', args: {}, chars: 120 }],
                        sent: 400,
                    },
                    { role: 'user', text: 'How to change schema?' },
                    {
                        role: 'ai',
                        answer: 'Edit memory schema rules.',
                        suggest: 'memory',
                        fixPrompt: 'Adjust event tableColumns',
                    },
                ],
            };
            const app = {
                sessions: {
                    list: async () => [sessionObj],
                    get: async () => sessionObj,
                    create: async () => sessionObj,
                    update: async () => sessionObj,
                },
                source: {
                    listRequests: async () => [],
                    frontendLogCount: () => 0,
                    debugLoggingOn: () => true,
                    openRequestInspector: openSpy,
                },
                snapshot: () => ({ chat: { label: 'Alice', floors: 4 }, card: { name: 'Alice', books: ['B1'] }, preset: { name: 'Default' }, connection: 'Main' }),
                settings: () => ({ ask: { sources: {} } }),
                suggestions: () => [],
                askProviders: () => [],
                iterateTargets: () => [{ id: 'memory_graph' }, { id: 'memory' }],
                go: goSpy,
                toast: jest.fn(),
                saveSettings: jest.fn(),
            };
            const page = createAskPage(app);
            dom.window.document.body.appendChild(page.el);
            await page.show();
            const sel = page.el.querySelector('.wb-chat-hist');
            sel.value = 's1';
            sel.dispatchEvent(new dom.window.Event('change'));
            await new Promise(r => setTimeout(r, 10));

            const links = [...page.el.querySelectorAll('.wb-req-link')];
            expect(links).toHaveLength(2);
            expect(links[0].textContent).toContain('req_abc123');
            links[0].click();
            expect(openSpy).toHaveBeenCalledWith('req_abc123');
            expect(page.el.querySelector('.wb-reads').textContent.trim().length).toBeGreaterThan(0);

            const jumpBtns = [...page.el.querySelectorAll('.wb-ans-acts button')];
            expect(jumpBtns).toHaveLength(2);
            expect(jumpBtns[0].textContent.trim().length).toBeGreaterThan(0);
            expect(jumpBtns[1].textContent.trim().length).toBeGreaterThan(0);
            expect(jumpBtns[0].textContent.trim()).not.toBe(jumpBtns[1].textContent.trim());
            jumpBtns[0].click();
            expect(goSpy).toHaveBeenCalledWith('ai', expect.objectContaining({ ws: 'memory_graph', draft: 'Add clocktower promise node' }));
            jumpBtns[1].click();
            expect(goSpy).toHaveBeenCalledWith('ai', expect.objectContaining({ ws: 'memory', draft: 'Adjust event tableColumns' }));

            page.destroy();

            // When no chat is open, memory_graph jump button is hidden while memory remains available;
            // loadSnapshot() populates variables/regex respecting allowedOnly: true and disabledExtensions.includes('regex'),
            // and ask page renders them purely from app.snapshot().
            const getScriptsSpy = jest.fn(({ allowedOnly } = {}) => (
                allowedOnly
                    ? [{ id: 'g1', disabled: false }, { id: 'g2', disabled: true }]
                    : [{ id: 'g1', disabled: false }, { id: 'g2', disabled: true }, { id: 'unapproved', disabled: false }]
            ));
            let disabledExts = [];
            globalThis.Luker = {
                getContext: () => ({
                    chat: [],
                    characters: [],
                    chatMetadata: { variables: { hp: 100, mood: 'calm' } },
                    regex: { getScripts: getScriptsSpy },
                    extensionSettings: { disabledExtensions: disabledExts },
                }),
            };

            const overviewEnabled = await askOverview({
                sources: { content: true, plugins: false, inspector: false, frontLogs: false },
                redactText: false,
            });
            expect(getScriptsSpy).toHaveBeenCalledWith({ allowedOnly: true });
            expect(overviewEnabled.正则).toBe('启用 1 条');

            let currentSnap = await loadSnapshot();
            expect(currentSnap.variables).toEqual({ count: 2, opFloors: 0 });
            expect(currentSnap.regex).toEqual({ disabled: false, enabledCount: 1 });

            // Clear globalThis.Luker before rendering ask page to prove paintSide reads from app.snapshot() only
            const savedLuker = globalThis.Luker;
            delete globalThis.Luker;
            const noChatApp = {
                ...app,
                snapshot: () => currentSnap,
            };
            const noChatPage = createAskPage(noChatApp);
            dom.window.document.body.appendChild(noChatPage.el);
            await noChatPage.show();
            const noChatSel = noChatPage.el.querySelector('.wb-chat-hist');
            noChatSel.value = 's1';
            noChatSel.dispatchEvent(new dom.window.Event('change'));
            await new Promise(r => setTimeout(r, 10));

            const noChatJumpBtns = [...noChatPage.el.querySelectorAll('.wb-ans-acts button')];
            expect(noChatJumpBtns).toHaveLength(1);
            goSpy.mockClear();
            noChatJumpBtns[0].click();
            expect(goSpy).toHaveBeenCalledWith('ai', expect.objectContaining({ ws: 'memory', draft: 'Adjust event tableColumns' }));

            const sideItemsBefore = [...noChatPage.el.querySelectorAll('.wb-src-item')];
            const sideValueTextsBefore = sideItemsBefore.map(el => el.querySelector('.wb-src-n')?.textContent || '');
            expect(sideValueTextsBefore.some(text => /\b2\b/.test(text))).toBe(true);
            const regexItemIdx = sideItemsBefore.findIndex(el => /\b1\b/.test(el.querySelector('.wb-src-n')?.textContent || '') && !el.querySelector('.wb-src-st')?.classList.contains('is-off'));
            expect(regexItemIdx).toBeGreaterThanOrEqual(0);
            const regexLabelBefore = sideItemsBefore[regexItemIdx].querySelector('.wb-src-n').textContent;

            // Disabling the regex extension marks overview as '扩展已关闭', loadSnapshot regex.disabled as true, and side panel row as is-off
            globalThis.Luker = savedLuker;
            disabledExts = ['regex'];
            getScriptsSpy.mockClear();
            const overviewDisabled = await askOverview({
                sources: { content: true, plugins: false, inspector: false, frontLogs: false },
                redactText: false,
            });
            expect(overviewDisabled.正则).toBe('扩展已关闭');
            expect(getScriptsSpy).not.toHaveBeenCalled();

            currentSnap = await loadSnapshot();
            expect(currentSnap.regex).toEqual({ disabled: true, enabledCount: null });
            delete globalThis.Luker;

            noChatPage.onSnapshot();
            const sideItemsAfter = [...noChatPage.el.querySelectorAll('.wb-src-item')];
            const sideRegexOff = sideItemsAfter[regexItemIdx];
            expect(sideRegexOff.querySelector('.wb-src-n').textContent).not.toBe(regexLabelBefore);
            expect(sideRegexOff.querySelector('.wb-src-n').textContent.trim().length).toBeGreaterThan(0);
            expect(sideRegexOff.querySelector('.wb-src-st').classList.contains('is-off')).toBe(true);
            expect(getScriptsSpy).not.toHaveBeenCalled();

            noChatPage.destroy();
        } finally {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
            globalThis.HTMLElement = prevHTMLElement;
            globalThis.Node = prevNode;
            globalThis.requestAnimationFrame = prevRAF;
        }
    });

    test('runAsk checks signal.aborted right after request() resolves and around async readers', async () => {
        // 1) Aborted while request() is in flight -> throws Stopped without running readers or returning answer
        const ac1 = new AbortController();
        const readerSpy = jest.fn(async () => ({ ok: true }));
        await expect(runAsk({
            question: 'Check abort after request',
            overview: {},
            sources: { content: true },
            readers: { wb_read_chat: readerSpy },
            signal: ac1.signal,
            request: async () => {
                ac1.abort();
                return { text: '', calls: [{ id: 'c1', name: 'wb_read_chat', args: {} }] };
            },
        })).rejects.toThrow(/Stopped/);
        expect(readerSpy).not.toHaveBeenCalled();

        // 2) Aborted while first reader is running -> stops before second reader and onStep
        const ac2 = new AbortController();
        const onStep = jest.fn();
        const secondReader = jest.fn(async () => ({ ok: true }));
        await expect(runAsk({
            question: 'Check abort during readers',
            overview: {},
            sources: { content: true },
            readers: {
                wb_read_chat: async () => {
                    ac2.abort();
                    return { messages: [] };
                },
                wb_read_character: secondReader,
            },
            signal: ac2.signal,
            onStep,
            request: async () => ({
                text: '',
                calls: [
                    { id: 'c1', name: 'wb_read_chat', args: {} },
                    { id: 'c2', name: 'wb_read_character', args: {} },
                ],
            }),
        })).rejects.toThrow(/Stopped/);
        expect(secondReader).not.toHaveBeenCalled();
        expect(onStep).not.toHaveBeenCalled();
    });

    test('ask page guards concurrent session deletion in send() and increments selectionVersion on scope change even when session is null', async () => {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        const prevWindow = globalThis.window;
        const prevDocument = globalThis.document;
        const prevHTMLElement = globalThis.HTMLElement;
        const prevNode = globalThis.Node;
        const prevRAF = globalThis.requestAnimationFrame;
        const prevLuker = globalThis.Luker;
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
        globalThis.Node = dom.window.Node;
        globalThis.requestAnimationFrame = (cb) => cb();
        delete globalThis.Luker;
        try {
            const { createAskPage } = await import('../../public/scripts/workbench/pages/ask.js');

            // 1) Scope change while session === null and send() is awaiting overview:
            //    syncScopeChange must increment selectionVersion so Chat B isn't stuck busy or hijacked.
            let activeChat = { chatId: 'chatA.jsonl', label: 'Chat A', floors: 1, target: { is_group: false, avatar_url: 'a.png', file_name: 'chatA.jsonl' } };
            let resolveOverview;
            const createdInA = { id: 'sess_A', kind: 'ask', title: 'From A', turns: [], updatedAt: Date.now() };
            const byId = new Map();
            const aiRequestSpy = jest.fn(async () => ({ text: 'Reply A', calls: [] }));
            const app = {
                sessions: {
                    list: jest.fn(async () => []),
                    get: jest.fn(async (id) => byId.get(id) ?? null),
                    create: jest.fn(async (fields) => {
                        const s = { ...createdInA, ...fields };
                        byId.set(s.id, s);
                        return s;
                    }),
                    update: jest.fn(async (id, patch) => {
                        const cur = byId.get(id);
                        if (!cur) return null;
                        const next = { ...cur, ...patch };
                        byId.set(id, next);
                        return next;
                    }),
                },
                source: {
                    listRequests: async () => [],
                    frontendLogCount: () => 0,
                    debugLoggingOn: () => true,
                    askOverview: jest.fn(() => new Promise((r) => { resolveOverview = r; })),
                    askReaders: () => ({}),
                    askToolsForProviders: () => [],
                    aiRequest: aiRequestSpy,
                },
                snapshot: () => ({ chat: activeChat, card: { name: 'A', books: [] }, preset: { name: 'P' }, connection: 'C' }),
                settings: () => ({ ask: { sources: {} } }),
                suggestions: () => [],
                askProviders: () => [],
                iterateTargets: () => [],
                go: jest.fn(),
                toast: jest.fn(),
                saveSettings: jest.fn(),
            };

            const page = createAskPage(app);
            dom.window.document.body.appendChild(page.el);
            await page.show();

            const input = page.el.querySelector('textarea.wb-input');
            const sendBtn = page.el.querySelector('button.wb-send');
            input.value = 'Question in Chat A';
            sendBtn.click();
            await Promise.resolve();
            expect(sendBtn.disabled).toBe(true);

            // Switch to Chat B while session === null and overview is still pending
            activeChat = { chatId: 'chatB.jsonl', label: 'Chat B', floors: 1, target: { is_group: false, avatar_url: 'b.png', file_name: 'chatB.jsonl' } };
            page.onSnapshot();
            await new Promise(r => setTimeout(r, 10));
            expect(sendBtn.disabled).toBe(false);

            // Chat A's send finishes; it must NOT hijack Chat B's empty view
            resolveOverview({});
            await new Promise(r => setTimeout(r, 20));
            expect(page.el.textContent).not.toContain('Reply A');
            page.destroy();

            // 2) Concurrent deletion before store.update(userTurn) returns null -> exits cleanly without calling aiRequest or toasting TypeError
            const aiSpy2 = jest.fn(async () => ({ text: 'Should not run', calls: [] }));
            const toastSpy2 = jest.fn();
            const existing = { id: 'del_sess', kind: 'ask', title: 'Soon deleted', turns: [], updatedAt: Date.now() };
            const app2 = {
                ...app,
                sessions: {
                    list: jest.fn(async () => [existing]),
                    get: jest.fn(async () => existing),
                    create: jest.fn(async () => existing),
                    update: jest.fn(async () => null),
                },
                source: {
                    ...app.source,
                    askOverview: jest.fn(async () => ({})),
                    aiRequest: aiSpy2,
                },
                toast: toastSpy2,
            };
            const page2 = createAskPage(app2);
            dom.window.document.body.appendChild(page2.el);
            await page2.show();
            const hist = page2.el.querySelector('.wb-chat-hist');
            hist.value = 'del_sess';
            hist.dispatchEvent(new dom.window.Event('change'));
            await new Promise(r => setTimeout(r, 10));

            const input2 = page2.el.querySelector('textarea.wb-input');
            const sendBtn2 = page2.el.querySelector('button.wb-send');
            input2.value = 'After delete';
            sendBtn2.click();
            await new Promise(r => setTimeout(r, 20));
            expect(aiSpy2).not.toHaveBeenCalled();
            expect(toastSpy2).not.toHaveBeenCalled();
            expect(input2.value).toBe('After delete');
            page2.destroy();
        } finally {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
            globalThis.HTMLElement = prevHTMLElement;
            globalThis.Node = prevNode;
            globalThis.requestAnimationFrame = prevRAF;
            if (prevLuker === undefined) delete globalThis.Luker;
            else globalThis.Luker = prevLuker;
        }
    });

    test('ask page locks existing session pre-run via pendingSessions and bails regenerate() when store.update returns null', async () => {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        const prevWindow = globalThis.window;
        const prevDocument = globalThis.document;
        const prevHTMLElement = globalThis.HTMLElement;
        const prevNode = globalThis.Node;
        const prevRAF = globalThis.requestAnimationFrame;
        const prevLuker = globalThis.Luker;
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
        globalThis.Node = dom.window.Node;
        globalThis.requestAnimationFrame = (cb) => cb();
        delete globalThis.Luker;
        try {
            const { createAskPage } = await import('../../public/scripts/workbench/pages/ask.js');

            const byId = new Map();
            const existing = {
                id: 'ask_existing',
                kind: 'ask',
                title: 'Existing Ask',
                updatedAt: Date.now(),
                turns: [
                    { role: 'user', text: 'First Q', at: 1 },
                    { role: 'ai', answer: 'First A', reads: [], at: 2 },
                ],
            };
            byId.set(existing.id, JSON.parse(JSON.stringify(existing)));

            let resolveOverview;
            const askOverviewSpy = jest.fn(() => new Promise((resolve) => { resolveOverview = resolve; }));
            const aiRequestSpy = jest.fn(async () => ({ text: 'Second A', calls: [] }));
            const updateSpy = jest.fn(async (id, patch) => {
                const cur = byId.get(id);
                if (!cur) return null;
                const next = { ...cur, ...JSON.parse(JSON.stringify(patch)), updatedAt: Date.now() };
                byId.set(id, next);
                return JSON.parse(JSON.stringify(next));
            });

            const app = {
                sessions: {
                    list: jest.fn(async () => [...byId.values()].map(s => JSON.parse(JSON.stringify(s)))),
                    get: jest.fn(async (id) => (byId.has(id) ? JSON.parse(JSON.stringify(byId.get(id))) : null)),
                    create: jest.fn(async (fields) => ({ id: 'unexpected', turns: [], ...fields })),
                    update: updateSpy,
                },
                source: {
                    listRequests: async () => [],
                    frontendLogCount: () => 0,
                    debugLoggingOn: () => true,
                    askOverview: askOverviewSpy,
                    askReaders: () => ({}),
                    askToolsForProviders: () => [],
                    aiRequest: aiRequestSpy,
                },
                snapshot: () => ({ chat: { label: 'Chat 1', floors: 2 }, card: { name: 'Alice', books: [] }, preset: { name: 'Default' }, connection: 'Main' }),
                settings: () => ({ ask: { sources: {} } }),
                suggestions: () => [],
                askProviders: () => [],
                iterateTargets: () => [],
                go: jest.fn(),
                toast: jest.fn(),
                saveSettings: jest.fn(),
            };

            const page = createAskPage(app);
            dom.window.document.body.appendChild(page.el);
            await page.show();

            const hist = page.el.querySelector('.wb-chat-hist');
            hist.value = existing.id;
            hist.dispatchEvent(new dom.window.Event('change'));
            await new Promise(r => setTimeout(r, 10));

            const input = page.el.querySelector('textarea.wb-input');
            const sendBtn = page.el.querySelector('button.wb-send');
            input.value = 'Second Q';
            sendBtn.click();

            // Existing session must lock immediately while askOverview() is pending
            expect(sendBtn.disabled).toBe(true);
            expect(input.disabled).toBe(true);

            // Second click + Enter keydown must NOT trigger a second concurrent send()
            sendBtn.click();
            input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await Promise.resolve();
            expect(askOverviewSpy).toHaveBeenCalledTimes(1);
            expect(aiRequestSpy).not.toHaveBeenCalled();

            resolveOverview({});
            await new Promise(r => setTimeout(r, 20));
            expect(askOverviewSpy).toHaveBeenCalledTimes(1);
            expect(aiRequestSpy).toHaveBeenCalledTimes(1);
            expect(sendBtn.disabled).toBe(false);
            expect(input.disabled).toBe(false);
            expect(byId.get(existing.id).turns).toHaveLength(4);

            // regenerate() must bail cleanly without overwriting input.value or calling send() when store.update returns null
            updateSpy.mockResolvedValueOnce(null);
            aiRequestSpy.mockClear();
            input.value = 'Keep my unsent draft';
            const regenBtn = [...page.el.querySelectorAll('.wb-msg-acts button')].find(b => b.textContent.includes('Answer again'));
            expect(regenBtn).toBeTruthy();
            regenBtn.click();
            await new Promise(r => setTimeout(r, 20));

            expect(input.value).toBe('Keep my unsent draft');
            expect(aiRequestSpy).not.toHaveBeenCalled();
            expect(sendBtn.disabled).toBe(false);

            // regenerate() restores stripped turns if user switches session while store.update() is in flight
            let releaseStripUpdate;
            const origUpdateImpl = updateSpy.getMockImplementation();
            updateSpy.mockImplementationOnce(async (id, patch) => {
                await new Promise((resolve) => { releaseStripUpdate = resolve; });
                return origUpdateImpl(id, patch);
            });
            aiRequestSpy.mockClear();
            const regenBtn2 = [...page.el.querySelectorAll('.wb-msg-acts button')].find(b => b.textContent.includes('Answer again'));
            regenBtn2.click();
            await Promise.resolve();
            // Switch away to a new chat while strip store.update is still pending
            hist.value = '';
            hist.dispatchEvent(new dom.window.Event('change'));
            releaseStripUpdate();
            await new Promise(r => setTimeout(r, 20));

            expect(aiRequestSpy).not.toHaveBeenCalled();
            expect(byId.get(existing.id).turns).toHaveLength(4);
            page.destroy();
        } finally {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
            globalThis.HTMLElement = prevHTMLElement;
            globalThis.Node = prevNode;
            globalThis.requestAnimationFrame = prevRAF;
            if (prevLuker === undefined) delete globalThis.Luker;
            else globalThis.Luker = prevLuker;
        }
    });
});
