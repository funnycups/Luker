// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MAX_ROUNDS, askSystemPrompt, askUserMessage, askTools, runAsk, readsSummary, readLabel, clip, buildAskHistory } from '../../public/scripts/workbench/model/ask.js';
import { searchLukerDocs, listLukerDocTopics } from '../../public/scripts/workbench/model/luker-docs.js';
import { attribute, groupByGeneration, describeRequest } from '../../public/scripts/workbench/model/requests.js';
import { SourceError, aiRequest, askOverview, askReaders, listAiChoices } from '../../public/scripts/workbench/source-luker.js';
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
        expect(calls).toBe(MAX_ROUNDS);
        expect(offered[MAX_ROUNDS - 1]).toBe(1);
        expect(r.answer).toMatch(/specific/i);

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
        expect(attribute({ searchText: 'Call sd_read_run to inspect illustration_prompt' }).kind).toBe('image');
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

    test('wb_read_character, wb_read_preset, and wb_read_world_info do not apply inner truncation before clip()', async () => {
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

    test('askSystemPrompt covers Luker features & diagnostics, and readLabel maps wb_read_orch and new tools', () => {
        const prompt = askSystemPrompt();
        expect(prompt).toContain('Luker 原生「工作台」');
        expect(prompt).toContain('激活链路追踪');
        expect(prompt).toContain('逐楼层变量');
        expect(prompt).toContain('wb_search_luker_docs');
        expect(prompt).toContain('wb_read_world_info_trace');
        expect(prompt).toContain('wb_read_variables');
        expect(prompt).toContain('wb_read_regex');
        expect(readLabel('wb_read_orch')).toBe('Orchestration');
        expect(readLabel('wb_read_world_info_trace')).toBe('World book trace');
        expect(readLabel('wb_search_luker_docs')).toBe('Luker docs');
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

    test('aiRequest for ask bypasses preset envelope, normalizes signature from raw.signature/raw.thoughtSignature, and keeps raw reasoning', async () => {
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
        expect(callOpts.bypassPresetEnvelope).toBe(true);
        expect(out.reasoning).toBe(rawReasoning);
        expect(out.calls[0].signature).toBe('gem-ts-9');
        expect(out.calls[0].thoughtSignature).toBeUndefined();
        expect(out.calls[0].extra_content).toEqual({ google: { thought_signature: 'ec-1' } });
        expect(out.calls[1].signature).toBe('or-sig-2');
        expect(out.calls[1].thoughtSignature).toBeUndefined();
    });

    test('runAsk defers wb_answer when mixed with read calls in original order and gracefully degrades if final round throws', async () => {
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

        // Final-round request() throwing degrades gracefully without losing accumulated reads/text
        let roundCount = 0;
        let lastRoundTools = null;
        let lastRoundMessages = null;
        const degraded = await runAsk({
            question: 'Deep diagnostic',
            overview: {},
            readers: { wb_read_chat: async () => ({ floor: 1 }) },
            request: async (messages, tools) => {
                roundCount++;
                if (roundCount === MAX_ROUNDS) {
                    lastRoundTools = tools.map(t => t.function.name);
                    lastRoundMessages = messages;
                    throw new Error('Model response did not contain any matching tool calls.');
                }
                return {
                    text: roundCount === MAX_ROUNDS - 1 ? 'Partial finding before limit' : '',
                    calls: [{ id: `r_${roundCount}`, name: 'wb_read_chat', args: {} }],
                };
            },
        });
        expect(roundCount).toBe(MAX_ROUNDS);
        expect(lastRoundTools).toEqual(['wb_answer']);
        expect(lastRoundMessages.at(-1).role).toBe('user');
        expect(lastRoundMessages.at(-1).content).toContain('wb_answer');
        expect(degraded.answer).toBe('Partial finding before limit');
        expect(degraded.reads).toHaveLength(MAX_ROUNDS - 1);

        // Final-round abort with GenerateTaskError('aborted') shape must rethrow instead of degrading
        let abortRound = 0;
        const abortErr = Object.assign(new Error('request aborted'), { name: 'GenerateTaskError', code: 'aborted' });
        await expect(runAsk({
            question: 'Abort on last round',
            overview: {},
            readers: { wb_read_chat: async () => ({ floor: 1 }) },
            request: async () => {
                abortRound++;
                if (abortRound === MAX_ROUNDS) throw abortErr;
                return { text: 'Partial before abort', calls: [{ id: `ab_${abortRound}`, name: 'wb_read_chat', args: {} }] };
            },
        })).rejects.toBe(abortErr);
    });

    test('wb_read_request reads real inspector responseParts, wireRequest tools, image/embedding types, and rejects empty/boolean message_index', async () => {
        globalThis.Luker = {
            getContext: () => ({
                chat: [],
                getRequestHeaders: () => ({}),
                extensionSettings: {},
            }),
        };

        globalThis.fetch = jest.fn(async (url) => {
            const target = String(url);
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
                            { role: 'user', content: 'msg 1' },
                            { role: 'assistant', content: 'msg 2' },
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
            { id: 'tc_1', name: 'wb_read_preset', argsPreview: '{"entry":"Main"}' },
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
        // Numeric 0 DOES select only message 0
        const zeroIdxRes = await readers.wb_read_request({ id: 'req-chat', message_index: 0 });
        expect(zeroIdxRes.messages).toHaveLength(1);
        expect(zeroIdxRes.messages[0].index).toBe(0);
        expect(zeroIdxRes.messages[0].content).toBe('sys 0');

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
        expect(embRerankRes.inputTexts).toHaveLength(12);
        expect(embRerankRes.inputTexts[0]).toEqual({ index: 0, text: 'R'.repeat(400) });

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
                        if (type === 0) return [globalScript];
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

    test('wb_read_luker_env and askOverview handle Search Tools dual switch, real Sync fields, safe Connections, and content gating', async () => {
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

        const envConns = await fullReaders.wb_read_luker_env({ part: 'connections' });
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

        // Content disabled + plugins enabled: reject connections, hide summary connection info, filter character/preset skills
        const noContentReaders = askReaders({
            redactText: true,
            sources: { content: false, plugins: true, inspector: false, frontLogs: false, serverLogs: false },
        });
        expect(await noContentReaders.wb_read_luker_env({ part: 'connections' })).toEqual({ error: 'Source disabled: content' });
        const gatedSummary = await noContentReaders.wb_read_luker_env({ part: 'summary' });
        expect(gatedSummary.activeConnection).toBeUndefined();
        expect(gatedSummary.connectionProfileCount).toBeUndefined();
        const gatedSkills = await noContentReaders.wb_read_luker_env({ part: 'skills' });
        expect(gatedSkills.skills.map(s => s.name)).toEqual(['anti-cliche', 'orch-helper']);
    });

    test('wb_read_memory uses real read-api node shape, schema shape, settings keys, recency sort, seq_to=-1, and field truncation', async () => {
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
            summaryPreview: '昨天约好去钟楼见面',
            seqTo: 12,
            floorRange: { start: 10, end: 14 },
            parentId: 'n_unwatermarked',
            semanticRollup: false,
            depth: 0,
        });
        expect(memNodes.nodes[0].fields.detail).toHaveLength(300);
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
                summarizeInstruction: longSummarize.slice(0, 240),
            },
        });
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
        const previews = lastRun.lanes[0].segments[0].sections.map(s => s.preview);
        expect(previews[0]).toBe('Upstream 504');
        expect(previews[1]).toBe('[FINALIZE_EMPTY] finalize requires a non-empty capsule_text.');
        expect(previews[2]).toContain('"query":"silver key"');
        expect(previews[3]).toContain('"agent":"story-scout"');
        expect(previews[3].length).toBeLessThanOrEqual(320);
        expect(previews[4]).toContain('no tool call');
        expect(previews[4]).toContain('Draft without tool');
    });

    test('searchLukerDocs accurately ranks tricky colloquial queries and enforces word boundaries for short ASCII tokens', () => {
        const docsDir = searchLukerDocs({});
        expect(docsDir.mode).toBe('directory');
        expect(docsDir.items.length).toBe(listLukerDocTopics().length);

        expect(searchLukerDocs({ query: '逐楼层变量' }).items[0].id).toBe('variable-op-log');
        expect(searchLukerDocs({ query: 'AI 怎么记住以前的事' }).items[0].id).toBe('memory-graph');

        const embedHits = searchLukerDocs({ query: 'embedding 在哪设置' }).items.map(i => i.id);
        expect(embedHits[0]).toBe('connections-and-generation');
        expect(embedHits).toContain('memory-graph');
        expect(embedHits[0]).not.toBe('user-settings-and-clients');

        expect(searchLukerDocs({ query: '仅保留破限是什么' }).items[0].id).toBe('preset-assistant');
        expect(searchLukerDocs({ query: '画中画保活在哪开' }).items[0].id).toBe('user-settings-and-clients');

        // Short ASCII tokens must use word boundaries (no false substring matches)
        const wiIds = searchLukerDocs({ query: 'wi', limit: 10 }).items.map(i => i.id);
        expect(wiIds[0]).toBe('world-info-and-trace');
        expect(wiIds).not.toContain('chat-management');
        expect(wiIds).not.toContain('variable-op-log');

        const lanIds = searchLukerDocs({ query: 'lan', limit: 10 }).items.map(i => i.id);
        expect(lanIds[0]).toBe('sync');
        expect(lanIds).not.toContain('regex-scope-provider');

        const ragIds = searchLukerDocs({ query: 'rag', limit: 10 }).items.map(i => i.id);
        expect(ragIds[0]).toBe('memory-graph');
        expect(ragIds).not.toContain('state-and-storage');
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
            expect(page.el.querySelector('.wb-reads').textContent).toContain('Orchestration');

            const jumpBtns = [...page.el.querySelectorAll('.wb-ans-acts button')];
            expect(jumpBtns).toHaveLength(2);
            expect(jumpBtns[0].textContent).toContain('Memory graph content');
            expect(jumpBtns[1].textContent).toContain('Memory graph config');
            jumpBtns[0].click();
            expect(goSpy).toHaveBeenCalledWith('ai', expect.objectContaining({ ws: 'memory_graph', draft: 'Add clocktower promise node' }));
            jumpBtns[1].click();
            expect(goSpy).toHaveBeenCalledWith('ai', expect.objectContaining({ ws: 'memory', draft: 'Adjust event tableColumns' }));

            page.destroy();

            // When no chat is open, memory_graph jump button is hidden while memory remains available;
            // side panel regex stats honor allowedOnly: true and disabledExtensions.includes('regex').
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
                    chatMetadata: { variables: {} },
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

            const noChatApp = {
                ...app,
                snapshot: () => ({ chat: { chatId: '', label: '', floors: 0 }, card: { name: '', books: [] }, preset: { name: 'Default' }, connection: 'Main' }),
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
            expect(noChatJumpBtns[0].textContent).toContain('Memory graph config');

            const sideRegexItem = [...noChatPage.el.querySelectorAll('.wb-src-item')]
                .find(el => el.querySelector('.wb-src-name')?.textContent === 'Regex scripts');
            expect(sideRegexItem.querySelector('.wb-src-n').textContent).toBe('1 enabled');

            // Disabling the regex extension marks overview as '扩展已关闭' and side panel as 'Off'
            disabledExts = ['regex'];
            getScriptsSpy.mockClear();
            const overviewDisabled = await askOverview({
                sources: { content: true, plugins: false, inspector: false, frontLogs: false },
                redactText: false,
            });
            expect(overviewDisabled.正则).toBe('扩展已关闭');
            expect(getScriptsSpy).not.toHaveBeenCalled();

            noChatPage.onSnapshot();
            const sideRegexOff = [...noChatPage.el.querySelectorAll('.wb-src-item')]
                .find(el => el.querySelector('.wb-src-name')?.textContent === 'Regex scripts');
            expect(sideRegexOff.querySelector('.wb-src-n').textContent).toBe('Off');
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
});
