// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { selectChatCompletionDispatch } from '../../src/endpoints/backends/chat-completions.js';
import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';
import { dispatchClaude } from '../../src/luker-dispatch/providers/chat-completions/claude.js';
import { dispatchMakerSuite } from '../../src/luker-dispatch/providers/chat-completions/makersuite.js';
import { dispatchOpenAICompatible } from '../../src/luker-dispatch/providers/chat-completions/openai-compatible.js';
import { dispatchCohere } from '../../src/luker-dispatch/providers/chat-completions/cohere.js';
import { dispatchDeepSeek } from '../../src/luker-dispatch/providers/chat-completions/deepseek.js';
import { dispatchXai } from '../../src/luker-dispatch/providers/chat-completions/xai.js';
import { dispatchMistralAI } from '../../src/luker-dispatch/providers/chat-completions/mistralai.js';
import { dispatchAI21 } from '../../src/luker-dispatch/providers/chat-completions/ai21.js';
import { dispatchAimlapi } from '../../src/luker-dispatch/providers/chat-completions/aimlapi.js';
import { dispatchChutes } from '../../src/luker-dispatch/providers/chat-completions/chutes.js';
import { dispatchMinimax } from '../../src/luker-dispatch/providers/chat-completions/minimax.js';
import { dispatchElectronHub } from '../../src/luker-dispatch/providers/chat-completions/electronhub.js';
import { dispatchAzureOpenAI } from '../../src/luker-dispatch/providers/chat-completions/azure-openai.js';
import { dispatchOpenAIResponses } from '../../src/luker-dispatch/providers/chat-completions/openai-responses.js';

function fakeRequest({ requestId = null, body = {}, handle = 'alice' } = {}) {
    return {
        headers: requestId ? { 'x-luker-request-id': requestId } : {},
        body,
        user: { profile: { handle }, directories: {} },
    };
}

function fakeResponse() {
    const state = { statusCode: 200, headers: {}, body: null, ended: false };
    return {
        state,
        status(code) { state.statusCode = code; return this; },
        setHeader(k, v) { state.headers[k.toLowerCase()] = v; },
        json(obj) { state.body = obj; state.ended = true; },
        send(obj) { state.body = obj; state.ended = true; },
    };
}

describe('selectChatCompletionDispatch', () => {
    test('CLAUDE routes to dispatchClaude', () => {
        expect(selectChatCompletionDispatch({ chat_completion_source: 'claude' })).toBe(dispatchClaude);
    });

    test('OPENAI routes to dispatchOpenAICompatible (shared cascade)', () => {
        expect(selectChatCompletionDispatch({ chat_completion_source: 'openai' })).toBe(dispatchOpenAICompatible);
    });

    test('VERTEXAI routes to dispatchMakerSuite (same fn as MAKERSUITE)', () => {
        const vertex = selectChatCompletionDispatch({ chat_completion_source: 'vertexai' });
        const gemini = selectChatCompletionDispatch({ chat_completion_source: 'makersuite' });
        expect(vertex).toBe(dispatchMakerSuite);
        expect(gemini).toBe(dispatchMakerSuite);
        expect(vertex).toBe(gemini);
    });

    test('each self-contained provider routes to its dedicated dispatch', () => {
        const cases = [
            ['claude', dispatchClaude],
            ['ai21', dispatchAI21],
            ['makersuite', dispatchMakerSuite],
            ['vertexai', dispatchMakerSuite],
            ['mistralai', dispatchMistralAI],
            ['cohere', dispatchCohere],
            ['deepseek', dispatchDeepSeek],
            ['xai', dispatchXai],
            ['aimlapi', dispatchAimlapi],
            ['chutes', dispatchChutes],
            ['minimax', dispatchMinimax],
            ['electronhub', dispatchElectronHub],
            ['azure_openai', dispatchAzureOpenAI],
        ];
        for (const [source, fn] of cases) {
            expect(selectChatCompletionDispatch({ chat_completion_source: source })).toBe(fn);
        }
    });

    test('all 13 shared OpenAI-compatible providers route to dispatchOpenAICompatible', () => {
        const shared = ['openai', 'openrouter', 'custom', 'perplexity', 'groq', 'fireworks',
            'nanogpt', 'pollinations', 'moonshot', 'cometapi', 'zai', 'siliconflow', 'workers_ai'];
        for (const source of shared) {
            expect(selectChatCompletionDispatch({ chat_completion_source: source })).toBe(dispatchOpenAICompatible);
        }
    });

    test('OPENAI_RESPONSES routes to dispatchOpenAIResponses', () => {
        expect(selectChatCompletionDispatch({ chat_completion_source: 'openai_responses' })).toBe(dispatchOpenAIResponses);
    });

    test('unknown source throws with descriptive message', () => {
        expect(() => selectChatCompletionDispatch({ chat_completion_source: 'not_a_real_source' }))
            .toThrow(/Unsupported chat_completion_source: not_a_real_source/);
    });

    test('empty body throws (missing chat_completion_source)', () => {
        expect(() => selectChatCompletionDispatch({})).toThrow(/Unsupported chat_completion_source:/);
    });

    test('null body throws', () => {
        expect(() => selectChatCompletionDispatch(null)).toThrow(/Unsupported chat_completion_source:/);
    });
});

describe('/generate handler integration via runLukerDispatch', () => {
    test('missing x-luker-request-id header: runner auto-mints and proceeds (200 with server-supplied id)', async () => {
        const req = fakeRequest({ requestId: null, body: { chat_completion_source: 'openai' } });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: (body) => selectChatCompletionDispatch(body),
        });
        expect(res.state.statusCode).toBe(200);
        expect(typeof res.state.headers['x-luker-generation-id']).toBe('string');
        expect(res.state.headers['x-luker-generation-id'].length).toBeGreaterThan(10);
    });

    test('unknown chat_completion_source → 400 via select() throw path', async () => {
        const req = fakeRequest({
            requestId: 'unknown-src-1',
            body: { chat_completion_source: 'ghost_provider' },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: (body) => selectChatCompletionDispatch(body),
        });
        expect(res.state.statusCode).toBe(400);
        expect(res.state.body).toEqual({ error: 'Unsupported chat_completion_source: ghost_provider' });
    });

    test('valid source → 200 + x-luker-generation-id header; task started; dispatch invoked in background', async () => {
        // Use a stub dispatch so we don't need a real upstream. We wrap
        // selectChatCompletionDispatch to verify integration up to the point
        // where the real dispatch would be invoked, then substitute.
        const stubDispatch = jest.fn(async (ctx) => { ctx.emit.end(); });
        const req = fakeRequest({
            requestId: 'ok-claude-1',
            body: { chat_completion_source: 'claude' },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            // Verify select() picks the real dispatch, then substitute for isolation.
            select: (body) => {
                const picked = selectChatCompletionDispatch(body);
                expect(picked).toBe(dispatchClaude);
                return stubDispatch;
            },
        });
        expect(res.state.statusCode).toBe(200);
        expect(res.state.headers['x-luker-generation-id']).toBe('ok-claude-1');
        expect(res.state.headers['x-luker-server-persisted']).toBe('0');
        expect(res.state.body).toEqual({});
        // Background dispatch runs via setImmediate.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        expect(stubDispatch).toHaveBeenCalledTimes(1);
        const ctx = stubDispatch.mock.calls[0][0];
        expect(typeof ctx.emit.end).toBe('function');
        expect(typeof ctx.emit.chunk).toBe('function');
        expect(typeof ctx.emit.error).toBe('function');
    });
});
