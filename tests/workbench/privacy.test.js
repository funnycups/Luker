// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { redact, redactValue, redactReaders, finishOverview } from '../../public/scripts/workbench/model/requests.js';
import { askTools, runAsk } from '../../public/scripts/workbench/model/ask.js';
import { askOverview, askReaders } from '../../public/scripts/workbench/source-luker.js';
import { registerAskProvider, resetRegistry } from '../../public/scripts/workbench/registry.js';

describe('workbench privacy and redaction', () => {
    beforeEach(() => {
        resetRegistry();
        delete globalThis.Luker;
    });

    afterEach(() => {
        resetRegistry();
        delete globalThis.Luker;
        jest.restoreAllMocks();
    });

    test('redacts camelCase secret keys, provider prefixes, Basic auth, and ws/wss credentials', () => {
        const samples = [
            'accessToken="secret-access-123"',
            'authToken: secret-auth-456',
            'refreshToken=secret-refresh-789',
            'clientSecret: "super-client-secret"',
            'xApiKey: "xapi-secret-value"',
            'proxyPassword=my-proxy-pass',
            'cookie: session_secret_cookie_value',
            'google=AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBG',
            'hf=hf_AbCdEfGhIjKlMnOpQrSt',
            'gh=ghp_1234567890abcdefABCD',
            'ghp=github_pat_11ABCDEFG_0123456789abcdef',
            'groq=gsk_1234567890abcdefABCD',
            'xai=xai-1234567890abcdefABCD',
            'aws=AKIAIOSFODNN7EXAMPLE',
            'Authorization: Basic dXNlcjpzZWNyZXRwYXNz',
            'wss://alice:s3cr3tPass@stream.internal.example.com/socket?token=abc123',
            'ws://bob:pw1234@localhost:8080/ws',
        ];

        const text = redact(samples.join('\n'));
        for (const secret of [
            'secret-access-123',
            'secret-auth-456',
            'secret-refresh-789',
            'super-client-secret',
            'xapi-secret-value',
            'my-proxy-pass',
            'session_secret_cookie_value',
            'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBG',
            'AbCdEfGhIjKlMnOpQrSt',
            '1234567890abcdefABCD',
            '11ABCDEFG_0123456789abcdef',
            'IOSFODNN7EXAMPLE',
            'dXNlcjpzZWNyZXRwYXNz',
            'alice:s3cr3tPass',
            's3cr3tPass',
            'bob:pw1234',
            'pw1234',
        ]) {
            expect(text).not.toContain(secret);
        }

        // Object keys & nested JSON strings via redactValue
        const obj = redactValue({
            accessToken: 'tok-1',
            authToken: 'tok-2',
            refreshToken: 'tok-3',
            clientSecret: 'sec-1',
            xApiKey: 'key-1',
            proxyPassword: 'pw-1',
            cookie: 'sid=xyz',
            usage: { prompt_tokens: 120, completion_tokens: 45, max_tokens: 4096 },
            nested: JSON.stringify({
                refreshToken: 'nested-tok',
                wsUrl: 'wss://user:pass@relay.example.com/feed',
                auth: 'Authorization: Basic YWRtaW46cGFzcw==',
            }),
        });
        expect(obj.accessToken).toBe('***');
        expect(obj.authToken).toBe('***');
        expect(obj.refreshToken).toBe('***');
        expect(obj.clientSecret).toBe('***');
        expect(obj.xApiKey).toBe('***');
        expect(obj.proxyPassword).toBe('***');
        expect(obj.cookie).toBe('***');
        expect(obj.usage).toEqual({ prompt_tokens: 120, completion_tokens: 45, max_tokens: 4096 });
        const parsedNested = JSON.parse(obj.nested);
        expect(parsedNested.refreshToken).toBe('***');
        expect(parsedNested.wsUrl).not.toContain('user:pass');
        expect(parsedNested.auth).not.toContain('YWRtaW46cGFzcw==');

        // Authorization: Basic inside JSON preserves trailing delimiters and remains valid JSON
        const jsonBasic = redact('{"Authorization":"Basic dXNlcjpwYXNz"}');
        expect(JSON.parse(jsonBasic)).toEqual({ Authorization: 'Basic ***' });
        const escapedBasic = redact('{\\"Authorization\\":\\"Basic dXNlcjpwYXNz\\"}');
        expect(escapedBasic).toBe('{\\"Authorization\\":\\"Basic ***\\"}');
    });

    test('askOverview excludes all disabled source sections when sources are false', async () => {
        globalThis.Luker = {
            getContext: () => ({
                getCurrentChatId: () => 'secret-chat-id',
                chat: [{ mes: 'secret message', is_user: true }],
                characters: [{ avatar: 'secret.png', name: 'Secret Character Name', data: { extensions: { world: 'SecretWorld' } } }],
                characterId: 0,
                chatCompletionSettings: { preset_settings_openai: 'Secret Preset Name', chat_completion_source: 'openai' },
                presets: { getLive: () => ({ ref: { name: 'Secret Preset Name' }, body: { prompts: [] } }) },
                extensionSettings: { workbench: {} },
                getRequestHeaders: () => ({}),
                chatWorldInfo: { globalSelection: [] },
            }),
        };

        registerAskProvider({
            id: 'secret-plugin',
            label: 'Secret Plugin',
            overviewKey: 'SecretPlugin',
            getOverview: async () => ({ status: 'active', secretCount: 42 }),
        });

        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ([{ id: 'req-secret', timestamp: Date.now(), model: 'gpt-secret', status: 'ok' }]),
        }));

        const overview = await askOverview({
            sources: { content: false, plugins: false, frontLogs: false, inspector: false },
            redactText: true,
        });

        const serialized = JSON.stringify(overview);
        expect(serialized).not.toContain('Secret Character Name');
        expect(serialized).not.toContain('Secret Preset Name');
        expect(serialized).not.toContain('SecretPlugin');
        expect(serialized).not.toContain('req-secret');
        expect(overview).toEqual({});

        // finishOverview also strips disabled fields directly
        const stripped = finishOverview({
            聊天: 'MyChat',
            角色卡: 'MyChar',
            预设: 'MyPreset',
            连接: 'openai',
            提示词: { 合计: 1000, 上限: 8000 },
            记忆图: { 节点: 5 },
            编排: { 开启: true },
            最近的请求: [{ id: 'r1' }],
            调试日志开关: '开',
        }, {
            sources: { content: false, plugins: false, frontLogs: false, inspector: false },
            redactText: true,
        });
        expect(stripped).toEqual({});
    });

    test('askTools, askReaders, and runAsk enforce sources gating on read tools', async () => {
        const disabledSources = { content: false, plugins: false, frontLogs: false, serverLogs: false, inspector: false };
        expect(askTools(disabledSources).map(t => t.function.name)).toEqual(['wb_answer']);

        globalThis.Luker = {
            getContext: () => ({
                chat: [{ mes: 'Leaked chat content', is_user: true }],
                characters: [{ avatar: 'a.png', name: 'SecretChar', data: {} }],
                characterId: 0,
                extensionSettings: {},
            }),
        };

        const gatedReaders = askReaders({ sources: disabledSources, suggestions: () => [{ text: 'Leaked suggestion', why: 'secret' }] });
        expect(gatedReaders.wb_read_chat).toBeUndefined();
        expect(gatedReaders.wb_read_character).toBeUndefined();
        expect(gatedReaders.wb_read_world_info_trace).toBeUndefined();
        expect(gatedReaders.wb_read_variables).toBeUndefined();
        expect(gatedReaders.wb_read_regex).toBeUndefined();
        expect(gatedReaders.wb_list_requests).toBeUndefined();
        expect(gatedReaders.wb_read_frontend_logs).toBeUndefined();
        expect(gatedReaders.wb_read_luker_env).toBeUndefined();
        expect(gatedReaders.wb_read_suggestions).toBeUndefined();
        expect(gatedReaders.wb_search_luker_docs).toBeUndefined();

        // Even if someone passes a reader directly to runAsk while sources.content is false, runAsk refuses to invoke it.
        const chatSpy = jest.fn(async () => ({ messages: [{ text: 'Leaked!' }] }));
        const script = [
            { text: '', calls: [{ id: 'c1', name: 'wb_read_chat', args: {} }] },
            { text: '', calls: [{ id: 'c2', name: 'wb_answer', args: { text: 'Done' } }] },
        ];
        const res = await runAsk({
            question: 'Read chat',
            overview: {},
            sources: { content: false },
            readers: { wb_read_chat: chatSpy },
            request: async () => script.shift(),
        });
        expect(chatSpy).not.toHaveBeenCalled();
        expect(res.reads).toEqual([]);
        expect(res.answer).toBe('Done');
    });

    test('redactReaders redacts reader output when enabled', async () => {
        const wrapped = redactReaders({
            wb_read_chat: async () => ({ text: 'Authorization: Basic dXNlcjpwYXNz', accessToken: 'tok-xyz' }),
        }, true);
        const out = await wrapped.wb_read_chat({});
        expect(out.text).not.toContain('dXNlcjpwYXNz');
        expect(out.accessToken).toBe('***');
    });
});
