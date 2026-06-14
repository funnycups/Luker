import { describe, expect, test } from '@jest/globals';
import { GenerateTaskError, resolveProfile, resolveWorldInfo, assembleMessages, renderForApi, generateTask, applyMacroSubstitution } from '../../public/scripts/generate-task.js';

describe('GenerateTaskError', () => {
    test('stores code, message, cause, details', () => {
        const cause = new Error('underlying');
        const e = new GenerateTaskError('network', 'fetch failed', { cause, details: { status: 500 } });
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('GenerateTaskError');
        expect(e.code).toBe('network');
        expect(e.message).toBe('fetch failed');
        expect(e.cause).toBe(cause);
        expect(e.details).toEqual({ status: 500 });
    });

    test('cause and details default to null', () => {
        const e = new GenerateTaskError('aborted', 'user cancel');
        expect(e.cause).toBeNull();
        expect(e.details).toBeNull();
    });
});

describe('resolveProfile', () => {
    test('returns default when apiPresetName empty', () => {
        const fakeResolver = ({ profileName }) => {
            expect(profileName).toBe('');
            return { profile: null, requestApi: 'openai', apiSettingsOverride: null };
        };
        const result = resolveProfile('', { resolver: fakeResolver, defaultApi: 'openai', defaultSource: '' });
        expect(result.requestApi).toBe('openai');
        expect(result.apiSettingsOverride).toBeNull();
    });

    test('passes apiPresetName through to resolver', () => {
        let captured = null;
        const fakeResolver = (args) => {
            captured = args;
            return { profile: { name: 'MyProfile' }, requestApi: 'kobold', apiSettingsOverride: { reverse_proxy: 'http://x' } };
        };
        const result = resolveProfile('MyProfile', { resolver: fakeResolver, defaultApi: 'openai', defaultSource: 'openai' });
        expect(captured.profileName).toBe('MyProfile');
        expect(captured.defaultApi).toBe('openai');
        expect(captured.defaultSource).toBe('openai');
        expect(result.requestApi).toBe('kobold');
        expect(result.apiSettingsOverride).toEqual({ reverse_proxy: 'http://x' });
    });

    test('throws GenerateTaskError when no resolver available and SillyTavern absent', () => {
        // jest.setup.js installs a SillyTavern stub by default; this test
        // needs the no-host fallback path, so clear it for the duration.
        const prev = { Luker: globalThis.Luker, st: globalThis.st, SillyTavern: globalThis.SillyTavern };
        delete globalThis.Luker; delete globalThis.st; delete globalThis.SillyTavern;
        try {
            expect(() => resolveProfile('AnyName', { resolver: null }))
                .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'unknown' }));
        } finally {
            Object.assign(globalThis, prev);
        }
    });
});

describe('resolveWorldInfo', () => {
    const mockWi = { worldInfoBeforeEntries: [{ id: 'wi1' }] };

    test("source='none' returns empty object without calling resolver", async () => {
        let called = false;
        const result = await resolveWorldInfo({
            worldInfoSource: 'none',
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { worldInfoResolver: async () => { called = true; return mockWi; } });
        expect(called).toBe(false);
        expect(result).toEqual({});
    });

    test("source='task' passes taskMessages with fallbackToCurrentChat=false", async () => {
        let captured = null;
        const result = await resolveWorldInfo({
            worldInfoSource: 'task',
            taskMessages: [{ role: 'user', content: 'analyze X' }],
            worldInfoType: 'quiet',
        }, { worldInfoResolver: async (msgs, opts) => { captured = { msgs, opts }; return mockWi; } });
        expect(captured.msgs).toEqual([{ role: 'user', content: 'analyze X' }]);
        expect(captured.opts.fallbackToCurrentChat).toBe(false);
        expect(captured.opts.type).toBe('quiet');
        expect(result).toBe(mockWi);
    });

    test("source='chat' passes empty messages with fallbackToCurrentChat=true", async () => {
        let captured = null;
        await resolveWorldInfo({
            worldInfoSource: 'chat',
            taskMessages: [{ role: 'user', content: 'irrelevant' }],
        }, { worldInfoResolver: async (msgs, opts) => { captured = { msgs, opts }; return mockWi; } });
        expect(captured.msgs).toEqual([]);
        expect(captured.opts.fallbackToCurrentChat).toBe(true);
    });

    test("source='custom' uses customWorldInfoMessages", async () => {
        let captured = null;
        await resolveWorldInfo({
            worldInfoSource: 'custom',
            taskMessages: [{ role: 'user', content: 'task' }],
            customWorldInfoMessages: [{ role: 'user', content: 'curated' }],
        }, { worldInfoResolver: async (msgs, opts) => { captured = { msgs, opts }; return mockWi; } });
        expect(captured.msgs).toEqual([{ role: 'user', content: 'curated' }]);
        expect(captured.opts.fallbackToCurrentChat).toBe(false);
    });

    test("source='custom' without customWorldInfoMessages throws invalid_input", async () => {
        await expect(resolveWorldInfo({
            worldInfoSource: 'custom',
            customWorldInfoMessages: null,
        }, { worldInfoResolver: async () => mockWi })).rejects.toMatchObject({
            name: 'GenerateTaskError',
            code: 'invalid_input',
        });
    });

    test('runtimeWorldInfo short-circuits when present and not forced', async () => {
        let called = false;
        const result = await resolveWorldInfo({
            worldInfoSource: 'task',
            taskMessages: [{ role: 'user', content: 'task' }],
            runtimeWorldInfo: mockWi,
            forceWorldInfoResimulate: false,
        }, { worldInfoResolver: async () => { called = true; return {}; } });
        expect(called).toBe(false);
        expect(result).toBe(mockWi);
    });

    test('forceWorldInfoResimulate=true ignores runtimeWorldInfo and re-resolves', async () => {
        let called = false;
        await resolveWorldInfo({
            worldInfoSource: 'task',
            taskMessages: [{ role: 'user', content: 'task' }],
            runtimeWorldInfo: mockWi,
            forceWorldInfoResimulate: true,
        }, { worldInfoResolver: async () => { called = true; return mockWi; } });
        expect(called).toBe(true);
    });
});

describe('assembleMessages', () => {
    test('passes taskMessages + envelopeOptions through to builder', () => {
        let captured = null;
        const fakeBuilder = (args) => { captured = args; return [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }]; };
        const wi = { worldInfoBeforeEntries: [] };
        const out = assembleMessages({
            taskMessages: [{ role: 'user', content: 'hi' }],
            includeCharacterCard: true,
            llmPresetName: 'MyPreset',
            requestApi: 'openai',
            runtimeWorldInfo: wi,
        }, { builder: fakeBuilder });

        expect(captured.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(captured.envelopeOptions.includeCharacterCard).toBe(true);
        expect(captured.envelopeOptions.api).toBe('openai');
        expect(captured.envelopeOptions.promptPresetName).toBe('MyPreset');
        expect(captured.runtimeWorldInfo).toBe(wi);
        expect(out).toEqual([{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }]);
    });

    test('forces envelopeApi=openai when llmPresetName is set even on non-openai requestApi', () => {
        let captured = null;
        const fakeBuilder = (args) => { captured = args; return []; };
        assembleMessages({
            taskMessages: [],
            llmPresetName: 'P1',
            requestApi: 'kobold',
        }, { builder: fakeBuilder });
        expect(captured.envelopeOptions.api).toBe('openai');
    });

    test('uses requestApi as envelope api when llmPresetName empty', () => {
        let captured = null;
        const fakeBuilder = (args) => { captured = args; return []; };
        assembleMessages({
            taskMessages: [],
            llmPresetName: '',
            requestApi: 'kobold',
        }, { builder: fakeBuilder });
        expect(captured.envelopeOptions.api).toBe('kobold');
    });

    test('throws GenerateTaskError when builder is not a function', () => {
        expect(() => assembleMessages({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { builder: null })).toThrow(expect.objectContaining({
            name: 'GenerateTaskError',
            code: 'unknown',
        }));
    });
});

describe('renderForApi', () => {
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
    ];

    test("openai → returns messages unchanged", () => {
        const out = renderForApi('openai', messages, { rawPromptBuilder: () => 'should-not-be-called' });
        expect(out).toBe(messages);
    });

    test('kobold → calls rawPromptBuilder with api kobold', () => {
        let capturedApi = null;
        const builder = (msgs, api) => { capturedApi = api; return 'folded text'; };
        const out = renderForApi('kobold', messages, { rawPromptBuilder: builder });
        expect(capturedApi).toBe('kobold');
        expect(out).toBe('folded text');
    });

    test('koboldhorde → folded text via rawPromptBuilder', () => {
        const out = renderForApi('koboldhorde', messages, { rawPromptBuilder: () => 'horde text' });
        expect(out).toBe('horde text');
    });

    test('novel → folded text', () => {
        const out = renderForApi('novel', messages, { rawPromptBuilder: () => 'novel text' });
        expect(out).toBe('novel text');
    });

    test('textgenerationwebui → folded text', () => {
        const out = renderForApi('textgenerationwebui', messages, { rawPromptBuilder: () => 'tg text' });
        expect(out).toBe('tg text');
    });

    test('unsupported requestApi → throws unsupported_api', () => {
        expect(() => renderForApi('unknown', messages, { rawPromptBuilder: () => '' }))
            .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'unsupported_api' }));
    });

    test('non-openai requestApi without rawPromptBuilder and no globalThis → throws unsupported_api', () => {
        // jest.setup.js installs a SillyTavern stub by default; this test
        // needs the no-host fallback path, so clear it for the duration.
        const prev = { Luker: globalThis.Luker, st: globalThis.st, SillyTavern: globalThis.SillyTavern };
        delete globalThis.Luker; delete globalThis.st; delete globalThis.SillyTavern;
        try {
            expect(() => renderForApi('kobold', messages, { rawPromptBuilder: null }))
                .toThrow(expect.objectContaining({ name: 'GenerateTaskError', code: 'unsupported_api' }));
        } finally {
            Object.assign(globalThis, prev);
        }
    });
});

describe('generateTask — input validation', () => {
    test('tools + jsonSchema mutex throws invalid_input', async () => {
        await expect(generateTask({
            taskMessages: [{ role: 'user', content: 'x' }],
            tools: [{ type: 'function', function: { name: 'f' } }],
            jsonSchema: { schema: { type: 'object' } },
        })).rejects.toMatchObject({ name: 'GenerateTaskError', code: 'invalid_input' });
    });

    test("worldInfoSource='custom' without customWorldInfoMessages throws invalid_input", async () => {
        await expect(generateTask({
            taskMessages: [{ role: 'user', content: 'x' }],
            worldInfoSource: 'custom',
            customWorldInfoMessages: null,
            apiPresetName: 'X',
        }, {
            _injected: {
                profileResolver: () => ({ requestApi: 'openai', apiSettingsOverride: null }),
                builder: () => [{ role: 'user', content: 'x' }],
                senders: { sendOpenAIRequest: async () => ({ choices: [{ message: { content: 'ok' } }] }) },
            },
        })).rejects.toMatchObject({ name: 'GenerateTaskError', code: 'invalid_input' });
    });

    test('non-openai requestApi + llmPresetName → console.warn', async () => {
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...a) => warns.push(a.join(' '));
        try {
            await generateTask({
                taskMessages: [{ role: 'user', content: 'x' }],
                llmPresetName: 'P1',
                apiPresetName: 'KoboldProfile',
            }, {
                _injected: {
                    profileResolver: () => ({ requestApi: 'kobold', apiSettingsOverride: null }),
                    worldInfoResolver: async () => ({}),
                    builder: ({ messages }) => messages,
                    rawPromptBuilder: () => 'folded',
                    senders: {
                        getKoboldGenerationData: () => ({}),
                        getKoboldRuntime: () => ({ kai_settings: { preset_settings: 'X' }, koboldai_settings: { X: {} }, koboldai_setting_names: { X: 'X' }, amount_gen: 100, max_context: 2000 }),
                        getGenerateUrl: () => 'http://test',
                        getRequestHeaders: () => ({}),
                        fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ text: 'k' }] }) }),
                    },
                },
            });
        } finally {
            console.warn = origWarn;
        }
        expect(warns.some(w => /llmPresetName.*non-openai|non-openai.*llmPresetName|kobold/i.test(w))).toBe(true);
    });
});

describe('module exports', () => {
    test('generate-task.js exports the public API surface', async () => {
        const mod = await import('../../public/scripts/generate-task.js');
        expect(typeof mod.generateTask).toBe('function');
        expect(typeof mod.GenerateTaskError).toBe('function');
        expect(typeof mod.resolveProfile).toBe('function');
        expect(typeof mod.resolveWorldInfo).toBe('function');
        expect(typeof mod.assembleMessages).toBe('function');
        expect(typeof mod.renderForApi).toBe('function');
        expect(typeof mod.dispatchToSender).toBe('function');
        expect(typeof mod.normalizeResponse).toBe('function');
        expect(typeof mod.applyMacroSubstitution).toBe('function');
    });
});

describe('applyMacroSubstitution', () => {
    const fakeSubstitute = (content, options) => {
        // Mirror the script.js skipSideEffects contract: strip side-effect macros first.
        const cleaned = options?.skipSideEffects
            ? content.replace(/\{\{(setvar|addvar|incvar|decvar|deletevar)::[^}]*\}\}/g, '')
            : content;
        return cleaned.replace(/\{\{user\}\}/g, 'Alice').replace(/\{\{char\}\}/g, 'Bob');
    };

    test('substitutes string content of each message', () => {
        const out = applyMacroSubstitution(
            [
                { role: 'system', content: 'You are {{char}}.' },
                { role: 'user', content: 'Hi {{char}}, I am {{user}}.' },
            ],
            fakeSubstitute,
        );
        expect(out[0].content).toBe('You are Bob.');
        expect(out[1].content).toBe('Hi Bob, I am Alice.');
    });

    test('passes skipSideEffects:true so {{setvar::}} is stripped', () => {
        const out = applyMacroSubstitution(
            [{ role: 'user', content: 'before {{setvar::x::1}} after' }],
            fakeSubstitute,
        );
        expect(out[0].content).toBe('before  after');
    });

    test('preserves non-string content unchanged (e.g. tool_calls)', () => {
        const toolCallMessage = {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        };
        const out = applyMacroSubstitution([toolCallMessage], fakeSubstitute);
        expect(out[0]).toEqual(toolCallMessage);
    });

    test('returns input unchanged when substituteParamsFn is not a function', () => {
        const input = [{ role: 'user', content: 'Hi {{user}}' }];
        expect(applyMacroSubstitution(input, null)).toBe(input);
        expect(applyMacroSubstitution(input, undefined)).toBe(input);
    });

    test('returns input unchanged for empty array or non-array', () => {
        const empty = [];
        expect(applyMacroSubstitution(empty, fakeSubstitute)).toBe(empty);
        expect(applyMacroSubstitution(null, fakeSubstitute)).toBeNull();
    });

    test('does not mutate input messages', () => {
        const input = [{ role: 'user', content: '{{user}}' }];
        const out = applyMacroSubstitution(input, fakeSubstitute);
        expect(input[0].content).toBe('{{user}}');
        expect(out[0].content).toBe('Alice');
        expect(out[0]).not.toBe(input[0]);
    });
});
