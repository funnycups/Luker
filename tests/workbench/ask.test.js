// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MAX_ROUNDS, askSystemPrompt, askTools, runAsk, readsSummary, readLabel, clip, buildAskHistory } from '../../public/scripts/workbench/model/ask.js';
import { searchLukerDocs, listLukerDocTopics } from '../../public/scripts/workbench/model/luker-docs.js';
import { attribute, groupByGeneration, describeRequest } from '../../public/scripts/workbench/model/requests.js';
import { aiRequest, askReaders, listAiChoices } from '../../public/scripts/workbench/source-luker.js';
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

    test('runAsk preserves reasoning metadata and thoughtSignature across tool rounds and buildAskHistory keeps requestIds', async () => {
        const seen = [];
        const script = [
            {
                text: 'Checking logs',
                reasoning: 'need to inspect requests',
                reasoningBlocks: [{ type: 'thinking', thinking: 'abc', signature: 'sig-1' }],
                reasoningDetails: [{ type: 'reasoning.text', text: 'abc' }],
                calls: [{ id: 'c1', name: 'wb_list_requests', args: { limit: 5 }, thoughtSignature: 'gem-sig-1' }],
            },
            {
                text: '',
                calls: [{ id: 'c2', name: 'wb_answer', args: { text: 'Found 429', request_ids: ['req-429'] } }],
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
        expect(res.requestIds).toEqual(['req-429']);
        const assistantTurn = seen[1].find(m => m.role === 'assistant');
        expect(assistantTurn.reasoning).toBe('need to inspect requests');
        expect(assistantTurn.reasoning_blocks).toEqual([{ type: 'thinking', thinking: 'abc', signature: 'sig-1' }]);
        expect(assistantTurn.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'abc' }]);
        expect(assistantTurn.tool_calls[0].thoughtSignature).toBe('gem-sig-1');

        const history = buildAskHistory([
            { role: 'user', text: 'Why 429?' },
            { role: 'ai', answer: 'Found 429', requestIds: ['req-429'] },
        ]);
        expect(history[1].content).toContain('req-429');
    });

    test('aiRequest for ask disables character card injection and bypasses RP preset envelope', async () => {
        const runnerMock = jest.fn(async () => ({
            assistantText: 'ok',
            toolCalls: [{ id: 't1', name: 'wb_answer', args: { text: 'done' }, raw: { thoughtSignature: 'ts-9' } }],
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
        expect(out.calls[0].thoughtSignature).toBe('ts-9');
    });

    test('new Ask readers: chat search, world info trace, variables, regex, preset fuzzy match, request tail, env, and docs', async () => {
        globalThis.Luker = {
            getContext: () => ({
                chat: [
                    { mes: 'First floor hello', is_user: true },
                    { mes: 'We made a promise about the silver key.', is_user: false, name: 'Alice', swipes: ['a', 'b'], swipe_id: 1, extra: { var_ops: [{ op: 'set', key: 'hp', value: 80 }] } },
                    { mes: 'Latest floor', is_user: false, name: 'Alice' },
                ],
                chatMetadata: { variables: { hp: 80, gold: 12 } },
                characters: [{ avatar: 'alice.png', name: 'Alice', data: { extensions: { world: 'LoreA' } } }],
                characterId: 0,
                chatWorldInfo: {
                    getNames: () => ['LoreA'],
                    globalSelection: [],
                    getActivationTrace: async () => ({
                        scopeKey: 'chat:1',
                        entries: [
                            { world: 'LoreA', uid: 1, lastActivatedAt: 1700000000000, recentScans: [{ activated: true, lastActivation: { reason: 'keyword', matchedKey: 'silver key' }, attempts: [] }] },
                            { world: 'LoreA', uid: 2, lastActivatedAt: null, recentScans: [{ activated: false, attempts: [{ reason: 'no_keyword_match' }] }] },
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
                        ref: { name: 'MyPreset' },
                        body: {
                            temperature: 0.9,
                            top_p: 0.95,
                            reasoning_effort: 'high',
                            show_thoughts: true,
                            function_calling: true,
                            extensions: { luker: { world_info: ['PresetBook'] } },
                            prompt_order: [{ character_id: 100001, order: [{ identifier: 'style_rule', enabled: true }] }],
                            prompts: [{ identifier: 'style_rule', name: 'Writing Style Rules', role: 'system', content: 'Be vivid.' }],
                        },
                    }),
                },
                regex: {
                    SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
                    getScriptsByType: (t) => (t === 0 ? [{ id: 'r1', scriptName: 'Strip Status Tag', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '', disabled: false, markdownOnly: true }] : []),
                    getScripts: () => [{ id: 'r1', scriptName: 'Strip Status Tag', findRegex: '/<status>[\\s\\S]*?<\\/status>/g', replaceString: '', disabled: false, markdownOnly: true }],
                },
                connectionProfiles: {
                    list: () => [{ name: 'MainAPI', api: 'openai', model: 'gemini-2.5-pro', apiKey: 'sk-should-never-appear-12345678' }],
                },
                listExtensionNames: () => ['memory-graph', 'orchestrator', 'regex', 'search-tools'],
                skills: { list: async () => [{ name: 'anti-cliche', scope: { kind: 'global' }, description: 'Avoid repetition' }] },
                getRequestHeaders: () => ({}),
                extensionSettings: {
                    workbench: { ask: { floors: 2 } },
                    variables: { global: { theme: 'dark' } },
                    search_tools: { enabled: true, mode: 'agent', provider: 'tavily', apiKey: 'sk-secret-search-99999999' },
                    disabledExtensions: ['tts'],
                },
            }),
        };

        globalThis.fetch = jest.fn(async (url) => {
            if (String(url).includes('/api/request-inspector/req-1')) {
                return {
                    ok: true,
                    json: async () => ({
                        id: 'req-1',
                        source: 'openai',
                        model: 'gemini-2.5-pro',
                        status: 'completed',
                        durationMs: 1200,
                        fullMessages: [
                            { role: 'system', content: 'sys 0' },
                            { role: 'user', content: 'msg 1' },
                            { role: 'assistant', content: 'msg 2' },
                            { role: 'user', content: 'msg 3 latest' },
                        ],
                        responseText: 'final reply',
                        reasoningText: 'step by step',
                        tools: [{ function: { name: 'wb_answer', description: 'Answer' } }],
                    }),
                };
            }
            return { ok: true, json: async () => ({ backends: { s3: { type: 's3', enabled: true } }, conflicts: [], notices: [] }) };
        });

        const readers = askReaders({ redactText: true });

        const chatSearch = await readers.wb_read_chat({ search: 'silver key' });
        expect(chatSearch.totalMatches).toBe(1);
        expect(chatSearch.messages[0].floor).toBe(1);
        expect(chatSearch.messages[0].swipes).toBe(2);
        expect(chatSearch.messages[0].varOpsCount).toBe(1);

        const trace = await readers.wb_read_world_info_trace({ only_activated: true });
        expect(trace.activatedCount).toBe(1);
        expect(trace.entries[0].title).toBe('Silver Key Lore');

        const vars = await readers.wb_read_variables({ include_global: true });
        expect(vars.localVariables.hp).toBe(80);
        expect(vars.globalVariables.theme).toBe('dark');
        expect(vars.recentFloorOps).toHaveLength(1);
        expect(vars.recentFloorOps[0].floor).toBe(1);

        const regexRes = await readers.wb_read_regex({});
        expect(regexRes.scripts).toHaveLength(1);
        expect(regexRes.scripts[0].name).toBe('Strip Status Tag');

        const presetSummary = await readers.wb_read_preset({});
        expect(presetSummary.settings.reasoning_effort).toBe('high');
        expect(presetSummary.presetWorldInfo).toEqual(['PresetBook']);
        const presetFuzzy = await readers.wb_read_preset({ entry: 'style' });
        expect(presetFuzzy.content).toBe('Be vivid.');

        const reqTail = await readers.wb_read_request({ id: 'req-1', tail_messages: 2, include_reasoning: true, include_tools: true });
        expect(reqTail.omittedHeadMessages).toBe(2);
        expect(reqTail.messages.map(m => m.index)).toEqual([2, 3]);
        expect(reqTail.reasoning).toBe('step by step');
        expect(reqTail.tools[0].name).toBe('wb_answer');

        const envConns = await readers.wb_read_luker_env({ part: 'connections' });
        expect(envConns.profiles[0].model).toBe('gemini-2.5-pro');
        expect(JSON.stringify(envConns)).not.toContain('sk-should-never-appear');

        const envSkills = await readers.wb_read_luker_env({ part: 'skills' });
        expect(envSkills.skills[0].name).toBe('anti-cliche');

        const envSync = await readers.wb_read_luker_env({ part: 'sync' });
        expect(envSync.backendCount).toBe(1);

        const docsHit = await readers.wb_search_luker_docs({ query: '逐楼层变量' });
        expect(docsHit.items[0].id).toBe('variable-op-log');
        const docsDir = searchLukerDocs({});
        expect(docsDir.mode).toBe('directory');
        expect(docsDir.items.length).toBe(listLukerDocTopics().length);
    });

    test('memory-graph and orchestrator AskProviders support deep node search, schema, detailed last_run, and notes', async () => {
        const memProvider = createMemoryAskProvider(() => null, {
            getSettings: () => ({ enabled: true, recallMode: 'llm', extractionInterval: 3 }),
            ensureMemoryStoreLoaded: async () => ({}),
            getMemoryGraphReadApi: () => ({
                listNodes: () => [
                    { id: 'n1', type: 'event', title: '约定见面', summary: '昨天约好去钟楼见面', last_seq: 12, archived: false },
                    { id: 'n2', type: 'character', title: '爱丽丝', summary: '主角同伴', last_seq: 5, archived: true },
                ],
            }),
        });
        const memCtx = {
            chat: Array.from({ length: 20 }, () => ({ mes: 'x' })),
            getCurrentChatId: () => 'chat-1',
            getExtensionApi: () => ({
                getAdvancedScopeInfo: () => ({ scope: 'global', settings: { persistentInjectionMaxSeqDistance: 100 } }),
                getSchemaScopeInfo: () => ({ scope: 'global', schema: [{ id: 'event', label: '事件', persistent: true, compression: { mode: 'hierarchical', threshold: 20 }, fields: [{ key: 'summary' }] }] }),
                getLastRecallProjection: async () => ({ at: Date.now(), blocks: { corePacket: 'core', focusPacket: 'focus' } }),
            }),
        };

        const memSummary = await memProvider.readers.wb_read_memory({ part: 'summary' }, memCtx);
        expect(memSummary.countsByType.event).toEqual({ total: 1, active: 1, archived: 0 });
        expect(memSummary.countsByType.character).toEqual({ total: 1, active: 0, archived: 1 });

        const memSearch = await memProvider.readers.wb_read_memory({ part: 'search', query: '钟楼' }, memCtx);
        expect(memSearch.matched).toBe(1);
        expect(memSearch.nodes[0].id).toBe('n1');

        const memSchema = await memProvider.readers.wb_read_memory({ part: 'schema' }, memCtx);
        expect(memSchema.types[0].id).toBe('event');

        const orchProvider = createOrchAskProvider(() => null, {
            getSettings: () => ({ enabled: true, executionMode: 'spec' }),
        });
        const orchCtx = {
            extensionSettings: { orchestrator: { enabled: true, executionMode: 'spec' } },
            runPanel: {
                getRunRecorder: () => ({
                    history: () => [{
                        runId: 'run-9',
                        source: 'orchestrator',
                        mode: 'spec',
                        status: 'error',
                        error: 'timeout',
                        startedAt: 1000,
                        endedAt: 4000,
                        rounds: [{
                            id: 'stage-prep',
                            status: 'error',
                            startedAt: 1000,
                            endedAt: 4000,
                            sections: [{ id: 'node-scout', kind: 'output', title: 'Scout', status: 'error', error: 'Upstream 504' }],
                        }],
                    }],
                }),
            },
        };
        const orchLastRun = await orchProvider.readers.wb_read_orch({ part: 'last_run' }, orchCtx);
        expect(orchLastRun.lanes[0].segments[0].sections[0].preview).toContain('Upstream 504');
    });

    test('ask page renders clickable requestIds chips that open the request inspector', async () => {
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
            const sessionObj = {
                id: 's1',
                kind: 'ask',
                title: '429 check',
                updatedAt: Date.now(),
                turns: [
                    { role: 'user', text: 'Why 429?' },
                    { role: 'ai', answer: 'Rate limited.', requestIds: ['req_abc123', 'req_abc123', 'req_def456'], reads: [{ name: 'wb_read_orch', args: {}, chars: 120 }], sent: 400 },
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
                go: jest.fn(),
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
            page.destroy();
        } finally {
            globalThis.window = prevWindow;
            globalThis.document = prevDocument;
            globalThis.HTMLElement = prevHTMLElement;
            globalThis.Node = prevNode;
            globalThis.requestAnimationFrame = prevRAF;
        }
    });
});
