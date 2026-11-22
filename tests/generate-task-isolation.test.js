// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { expect as waitFor, request } from '@playwright/test';
import WebSocket from 'ws';
import * as generateTaskModule from '../public/scripts/generate-task.js';
import { createLukerDelivery, installFetchProxy } from '../public/scripts/ws-delivery.js';
import { startServer, tearDownServer } from './e2e/_lib/server.js';
import { startMockLLM } from './e2e/_lib/mockLLM.js';

const SESSION_HEADER = 'X-Luker-Transient-Session';
let server;
let upstream;
let client;
let csrf;
const sockets = new Set();
const owners = new Set();

function post(url, data = {}, headers = {}) {
    return client.post(url, { data, headers: { 'X-CSRF-Token': csrf, ...headers } });
}

async function openDelivery() {
    const ticketResponse = await post('/api/ws-ticket');
    expect(ticketResponse.status()).toBe(200);
    const { ticket } = await ticketResponse.json();
    const socket = new WebSocket(server.baseURL.replace(/^http/, 'ws') + '/api/ws-delivery', [
        `luker-ws-ticket.${ticket}`,
    ]);
    sockets.add(socket);
    const frames = [];
    const waiters = new Set();
    socket.on('message', raw => {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: frame.ts }));
        frames.push(frame);
        for (const waiter of waiters) {
            if (waiter.matches(frame)) {
                waiters.delete(waiter);
                waiter.resolve(frame);
            }
        }
    });
    const rejectWaiters = error => {
        for (const waiter of waiters) waiter.reject(error);
        waiters.clear();
    };
    socket.on('error', rejectWaiters);
    socket.on('close', () => rejectWaiters(new Error('Delivery closed before the expected frame.')));
    await once(socket, 'open');
    return {
        socket,
        frames,
        send: frame => socket.send(JSON.stringify(frame)),
        waitFor(matches) {
            const existing = frames.find(matches);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => waiters.add({ matches, resolve, reject }));
        },
    };
}

async function openOwner() {
    const delivery = await openDelivery();
    delivery.send({ type: 'session_open' });
    const opened = await delivery.waitFor(frame => frame.type === 'session_opened' || frame.type === 'session_error');
    expect(opened.type).toBe('session_opened');
    const owner = {
        ...delivery,
        sessionId: opened.session_id,
        headers: { [SESSION_HEADER]: opened.session_id },
    };
    owners.add(owner);
    return owner;
}

async function closeOwner(owner) {
    const response = await post('/api/transient-sessions/close', {}, owner.headers);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
}

async function startGeneration({ owner, stream = false, content = 'Describe a quiet shoreline.', persistTarget, upstreamUrl = upstream.baseURL } = {}) {
    const id = randomUUID();
    const response = await post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'custom',
        custom_url: upstreamUrl,
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content }],
        stream,
        luker_generation: { job_id: id, ...(persistTarget ? { persist_target: persistTarget } : {}) },
    }, owner?.headers);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-luker-generation-id']).toBe(id);
    return id;
}

async function openPendingUpstream() {
    let release;
    let requestStarted;
    let responseClosed;
    const released = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { requestStarted = resolve; });
    const closed = new Promise(resolve => { responseClosed = resolve; });
    const endpoint = http.createServer(async (incoming, outgoing) => {
        const requestEnd = once(incoming, 'end');
        incoming.resume();
        await requestEnd;
        outgoing.once('close', responseClosed);
        requestStarted();
        await released;
        if (!outgoing.destroyed) {
            outgoing.writeHead(200, { 'Content-Type': 'application/json' });
            outgoing.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The shoreline is quiet.' }, finish_reason: 'stop' }] }));
        }
    });
    await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${endpoint.address().port}/v1`,
        started,
        closed,
        async stop() {
            release();
            await new Promise((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
        },
    };
}

async function receiveGeneration(delivery, id, owner) {
    delivery.send({
        type: 'resume',
        request_id: id,
        from_seq: 1,
        ...(owner ? { transient_session_id: owner.sessionId } : {}),
    });
    const terminal = await delivery.waitFor(frame => frame.request_id === id && ['end', 'error'].includes(frame.type));
    expect(terminal.type).toBe('end');
    return delivery.frames.filter(frame => frame.request_id === id);
}

async function inspectionIds() {
    const response = await client.get('/api/request-inspector/list');
    expect(response.status()).toBe(200);
    return (await response.json()).map(entry => entry.id);
}

beforeAll(async () => {
    upstream = await startMockLLM();
    upstream.scriptCompletion(() => ({ text: 'The shoreline is quiet.' }));
    server = await startServer({
        batchKey: 'extensions',
        scenarioId: 'generation-isolation',
        extraConfig: {
            enableUserAccounts: false,
            // Use the existing minimum acknowledgement grace to observe the
            // real recovery write. This does not time out model requests.
            generationAckGraceMs: 1000,
        },
    });
    client = await request.newContext({ baseURL: server.baseURL });
    csrf = (await (await client.get('/csrf-token')).json()).token;
    // Matches the existing real-server fixture's startup readiness budget.
}, 60_000);

afterEach(async () => {
    try {
        for (const owner of owners) await closeOwner(owner);
    } finally {
        owners.clear();
        await Promise.all([...sockets].map(async socket => {
            if (socket.readyState === socket.CLOSED) return;
            const closed = once(socket, 'close');
            socket.close();
            await closed;
        }));
        sockets.clear();
    }
});

afterAll(async () => {
    await client?.dispose();
    await tearDownServer(server);
    await upstream?.stop();
});

describe('real isolated task transport', () => {
    test.each([false, true])('private stream=%s does not enter request inspection', async stream => {
        const owner = await openOwner();
        const delivery = await openDelivery();
        const before = await inspectionIds();
        const privateText = `A private visual request ${randomUUID()}`;
        const id = await startGeneration({ owner, stream, content: privateText });
        const frames = await receiveGeneration(delivery, id, owner);
        expect(frames.some(frame => frame.type === 'chunk')).toBe(true);
        expect(await inspectionIds()).toEqual(before);
        expect(server.output).not.toContain(privateText);
        expect(upstream.requests.at(-1).headers['x-luker-transient-session']).toBeUndefined();
    });

    test('releasesTransientTransportJobs without removing ordinary recovery', async () => {
        const delivery = await openDelivery();
        const ordinary = await startGeneration();
        await receiveGeneration(delivery, ordinary);
        const owner = await openOwner();
        const isolated = await startGeneration({ owner });
        await receiveGeneration(delivery, isolated, owner);
        await closeOwner(owner);
        const missing = await post('/api/backends/chat-completions/jobs/status', { id: isolated });
        expect(missing.status()).toBe(404);
        const recovered = await post('/api/backends/chat-completions/jobs/status', { id: ordinary });
        expect(recovered.status()).toBe(200);
        expect((await recovered.json()).text).toBe('The shoreline is quiet.');
    });

    test('private rounds do not consume the ordinary recovery retention budget', async () => {
        const delivery = await openDelivery();
        const ordinary = await startGeneration();
        await receiveGeneration(delivery, ordinary);
        const owner = await openOwner();
        // The existing ordinary recovery store retains 128 jobs. Private jobs
        // must instead remain owned by their explicit session lifecycle.
        for (let round = 0; round < 128; round++) {
            const isolated = await startGeneration({ owner });
            await receiveGeneration(delivery, isolated, owner);
        }
        const recovered = await post('/api/backends/chat-completions/jobs/status', { id: ordinary });
        expect(recovered.status()).toBe(200);
        expect((await recovered.json()).text).toBe('The shoreline is quiet.');
    });

    test('ordinary unacknowledged replies persist without persisting private replies', async () => {
        const userRoot = path.join(server.dataRoot, 'default-user');
        const avatar = readdirSync(path.join(userRoot, 'characters')).find(name => name.endsWith('.png'));
        expect(avatar).toBeDefined();
        const avatarDirectory = path.parse(avatar).name;
        const ordinaryName = `ordinary-recovery-${randomUUID()}`;
        const privateName = `private-attempt-${randomUUID()}`;
        const ordinaryPath = path.join(userRoot, 'chats', avatarDirectory, `${ordinaryName}.jsonl`);
        const privatePath = path.join(userRoot, 'chats', avatarDirectory, `${privateName}.jsonl`);
        const owner = await openOwner();
        const privateId = await startGeneration({
            owner,
            persistTarget: { kind: 'character', avatar_url: avatar, file_name: privateName },
        });
        await receiveGeneration(owner, privateId, owner);
        const delivery = await openDelivery();
        const ordinaryId = await startGeneration({
            persistTarget: { kind: 'character', avatar_url: avatar, file_name: ordinaryName },
        });
        await receiveGeneration(delivery, ordinaryId);
        let recovered;
        await waitFor.poll(async () => {
            const response = await post('/api/backends/chat-completions/jobs/status', { id: ordinaryId });
            expect(response.status()).toBe(200);
            recovered = await response.json();
            return recovered;
        }).toMatchObject({ status: 'completed', persisted: true });
        const messages = readFileSync(ordinaryPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        expect(messages.filter(message => message.is_user === false))
            .toEqual([expect.objectContaining({ mes: recovered.text, extra: expect.objectContaining({ luker_server_persisted: true }) })]);
        expect(existsSync(privatePath)).toBe(false);
        const status = await post('/api/backends/chat-completions/jobs/status', { id: privateId }, owner.headers);
        expect(await status.json()).toMatchObject({ status: 'completed', persisted: false });
    });

    test('a private task cannot be subscribed to without its session authority', async () => {
        const owner = await openOwner();
        const id = await startGeneration({ owner });
        const unrelated = await openDelivery();
        unrelated.send({ type: 'resume', request_id: id, from_seq: 1 });
        const terminal = await unrelated.waitFor(frame => frame.request_id === id && ['end', 'error'].includes(frame.type));
        expect(terminal).toMatchObject({ type: 'error', code: 'forbidden' });
        expect(unrelated.frames.filter(frame => frame.type === 'chunk')).toEqual([]);
        await receiveGeneration(owner, id, owner);
    });

    test('private task status requires the matching session', async () => {
        const owner = await openOwner();
        const other = await openOwner();
        const id = await startGeneration({ owner });
        await receiveGeneration(owner, id, owner);
        const ordinaryLookup = await post('/api/backends/chat-completions/jobs/status', { id });
        expect(ordinaryLookup.status()).toBe(404);
        const wrongScope = await post('/api/backends/chat-completions/jobs/status', { id }, other.headers);
        expect(wrongScope.status()).toBe(404);
        const matching = await post('/api/backends/chat-completions/jobs/status', { id }, owner.headers);
        expect(matching.status()).toBe(200);
        expect((await matching.json()).text).toBe('The shoreline is quiet.');
    });

    test.each([
        { label: 'job cancellation', path: () => '/api/backends/chat-completions/jobs/cancel', deniedStatus: 404 },
        { label: 'delivery abort', path: id => `/api/generation/${id}/abort`, deniedStatus: 403 },
    ])('$label requires its owner and aborts the actual upstream request', async ({ path: controlPath, deniedStatus }) => {
        const pending = await openPendingUpstream();
        try {
            const owner = await openOwner();
            const other = await openOwner();
            const id = await startGeneration({ owner, upstreamUrl: pending.url });
            await pending.started;
            owner.send({ type: 'resume', request_id: id, from_seq: 1, transient_session_id: owner.sessionId });
            const unscoped = await post(controlPath(id), { id });
            expect(unscoped.status()).toBe(deniedStatus);
            const foreign = await post(controlPath(id), { id }, other.headers);
            expect(foreign.status()).toBe(deniedStatus);
            const cancelled = await post(controlPath(id), { id }, owner.headers);
            expect(cancelled.status()).toBe(200);
            const terminal = await owner.waitFor(frame => frame.request_id === id && frame.type === 'error');
            expect(terminal.code).toBe('aborted');
            await pending.closed;
            const status = await post('/api/backends/chat-completions/jobs/status', { id }, owner.headers);
            expect((await status.json()).status).toBe('cancelled');
        } finally {
            await pending.stop();
        }
    });

    test.each(['unregistered-session', ''])('an invalid explicit session %j fails before dispatching upstream', async sessionId => {
        const before = upstream.requests.length;
        const response = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: 'custom',
            custom_url: upstream.baseURL,
            model: 'mock-gpt-4o',
            messages: [{ role: 'user', content: 'Describe a quiet shoreline.' }],
        }, { [SESSION_HEADER]: sessionId });
        expect(response.status()).toBe(403);
        expect(upstream.requests).toHaveLength(before);
    });

    test('a job id cannot be rebound to another temporary session', async () => {
        const owner = await openOwner();
        const other = await openOwner();
        const id = await startGeneration({ owner });
        await receiveGeneration(owner, id, owner);
        const before = upstream.requests.length;
        const response = await post('/api/backends/chat-completions/generate', {
            chat_completion_source: 'custom',
            custom_url: upstream.baseURL,
            model: 'mock-gpt-4o',
            messages: [{ role: 'user', content: 'Describe a quiet shoreline.' }],
            luker_generation: { job_id: id },
        }, other.headers);
        expect(response.status()).toBe(409);
        expect(upstream.requests).toHaveLength(before);
        const original = await post('/api/backends/chat-completions/jobs/status', { id }, owner.headers);
        expect(original.status()).toBe(200);
        expect((await original.json()).text).toBe('The shoreline is quiet.');
    });
});

describe('task prompt context, request capture, and delivery scoping', () => {
    test('exposes captureTaskPromptContext synchronously on generate-task module', () => {
        expect(typeof generateTaskModule.captureTaskPromptContext).toBe('function');
    });

    test('isolatesPresetPromptContext in generateTask and generateTaskStream without re-entering live world info or live macros', async () => {
        const promptContext = {
            scope: 'preset',
            envelope: {
                version: 1,
                completionApi: 'openai',
                presetRefs: { completion: 'Default' },
                promptCore: { sysprompt: { cardSystemPrompt: '', cardPostHistory: '' } },
            },
            runtimeWorldInfo: {},
            macroEnv: { names: { user: '', char: '' } },
            regexScripts: [{ id: 'reply-1', scriptName: 'Reply filter', disabled: false }],
        };
        let liveWiCalled = false;
        let liveMacroCalled = false;
        const builderCalls = [];
        const capturedSubstitutions = [];
        const replyRegexCalls = [];

        const injected = {
            profileResolver: () => ({ requestApi: 'openai', apiSettingsOverride: null }),
            worldInfoResolver: async () => {
                liveWiCalled = true;
                return { worldInfoBeforeEntries: ['LIVE_WI_LEAK'] };
            },
            substituteParams: () => {
                liveMacroCalled = true;
                return 'LIVE_MACRO_LEAK';
            },
            substituteCapturedMacros: (content, macroEnv, options) => {
                capturedSubstitutions.push({ content, macroEnv, options });
                return content.replace('{{char}}', macroEnv.names.char);
            },
            applyCapturedReplyRegex: (text, ctx) => {
                replyRegexCalls.push({ text, scripts: ctx.regexScripts });
                return `${text} [isolated-reply]`;
            },
            builder: args => {
                builderCalls.push(args);
                return args.messages;
            },
            senders: {
                sendOpenAIRequest: async (_type, payload, _signal, opts) => {
                    if (opts.allowStreamingForQuiet) {
                        return async function* () {
                            yield { text: 'streamed answer', toolCalls: [], state: { reasoning: '', finishReason: 'stop' } };
                        };
                    }
                    return { choices: [{ message: { content: `echo:${payload[0].content}` }, finish_reason: 'stop' }] };
                },
            },
        };

        const nonStream = await generateTaskModule.generateTask({
            taskMessages: [{ role: 'user', content: 'Hello {{char}}' }],
            worldInfoSource: 'chat',
            includeCharacterCard: true,
            promptContext,
        }, { _injected: injected });

        expect(liveWiCalled).toBe(false);
        expect(liveMacroCalled).toBe(false);
        expect(capturedSubstitutions).toHaveLength(1);
        expect(capturedSubstitutions[0].macroEnv).toBe(promptContext.macroEnv);
        expect(builderCalls[0]).toMatchObject({
            envelope: promptContext.envelope,
            runtimeWorldInfo: {},
            promptContext,
        });
        expect(builderCalls[0].envelopeOptions.includeCharacterCard).toBe(false);
        expect(nonStream.assistantText).toBe('echo:Hello  [isolated-reply]');
        expect(replyRegexCalls).toEqual([{ text: 'echo:Hello ', scripts: promptContext.regexScripts }]);

        const { stream, result } = generateTaskModule.generateTaskStream({
            taskMessages: [{ role: 'user', content: 'Stream {{char}}' }],
            worldInfoSource: 'chat',
            promptContext,
        }, { _injected: injected });
        const deltas = [];
        for await (const chunk of stream) deltas.push(chunk.delta);
        expect(deltas.join('')).toBe('streamed answer');
        const streamedFinal = await result;
        expect(streamedFinal.assistantText).toBe('streamed answer [isolated-reply]');
        expect(liveWiCalled).toBe(false);
        expect(liveMacroCalled).toBe(false);
    });

    test.each([
        { requestApi: 'kobold', reply: { results: [{ text: 'kobold ok' }] } },
        { requestApi: 'novel', reply: { output: 'unused', results: [{ text: 'novel ok' }] } },
        { requestApi: 'textgenerationwebui', reply: { choices: [{ text: 'textgen ok' }] } },
    ])('capturesFinalTaskRequests and forwards transientSessionId for $requestApi', async ({ requestApi, reply }) => {
        const owner = await openOwner();
        const prepared = [];
        const wireCalls = [];
        const out = await generateTaskModule.generateTask({
            taskMessages: [{ role: 'user', content: 'Describe a lantern.' }],
            transientSessionId: owner.sessionId,
            onPreparedRequest: record => prepared.push(record),
        }, {
            _injected: {
                profileResolver: () => ({ requestApi, apiSettingsOverride: null }),
                builder: ({ messages }) => messages,
                rawPromptBuilder: msgs => msgs.map(m => m.content).join('\n'),
                senders: {
                    getKoboldGenerationData: prompt => ({ prompt, sampler_order: [6, 0] }),
                    getKoboldRuntime: () => ({ kai_settings: { preset_settings: 'Default' }, koboldai_settings: { Default: {} }, koboldai_setting_names: { Default: 'Default' }, amount_gen: 64, max_context: 2048 }),
                    getNovelGenerationData: input => ({ input, model: 'kayra-v1' }),
                    getNovelRuntime: () => ({ nai_settings: { preset_settings_novel: 'Default' }, novelai_settings: { Default: {} }, novelai_setting_names: { Default: 'Default' }, amount_gen: 64 }),
                    getTextGenGenerationData: async prompt => ({ prompt, max_tokens: 64 }),
                    getGenerateUrl: api => `http://test.local/${api}`,
                    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'tok' }),
                    fetchImpl: async (url, init) => {
                        wireCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
                        return { ok: true, json: async () => reply };
                    },
                },
            },
        });
        expect(out.assistantText).toContain('ok');
        expect(prepared).toHaveLength(1);
        expect(prepared[0]).toEqual({ requestApi, payload: wireCalls[0].body });
        expect(wireCalls[0].headers[SESSION_HEADER]).toBe(owner.sessionId);
    });

    test('forwards transientSessionId and onPreparedRequest to openai and koboldhorde senders', async () => {
        const owner = await openOwner();
        const openaiSeen = [];
        const onPreparedOpenai = record => openaiSeen.push(record);
        await generateTaskModule.generateTask({
            taskMessages: [{ role: 'user', content: 'OpenAI check' }],
            substituteMacros: false,
            transientSessionId: owner.sessionId,
            onPreparedRequest: onPreparedOpenai,
        }, {
            _injected: {
                profileResolver: () => ({ requestApi: 'openai', apiSettingsOverride: null }),
                builder: ({ messages }) => messages,
                senders: {
                    sendOpenAIRequest: async (_type, payload, _signal, opts) => {
                        opts.onPreparedRequest?.({ requestApi: 'openai', payload: { messages: payload } });
                        expect(opts.transientSessionId).toBe(owner.sessionId);
                        return { choices: [{ message: { content: 'openai ok' }, finish_reason: 'stop' }] };
                    },
                },
            },
        });
        expect(openaiSeen).toEqual([{ requestApi: 'openai', payload: { messages: [{ role: 'user', content: 'OpenAI check' }] } }]);

        const hordeSeen = [];
        await generateTaskModule.generateTask({
            taskMessages: [{ role: 'user', content: 'Horde check' }],
            substituteMacros: false,
            transientSessionId: owner.sessionId,
            onPreparedRequest: record => hordeSeen.push(record),
        }, {
            _injected: {
                profileResolver: () => ({ requestApi: 'koboldhorde', apiSettingsOverride: null }),
                builder: ({ messages }) => messages,
                rawPromptBuilder: msgs => msgs.map(m => m.content).join('\n'),
                senders: {
                    getKoboldGenerationData: prompt => ({ prompt, max_length: 64 }),
                    getKoboldRuntime: () => ({ kai_settings: { preset_settings: 'Default' }, koboldai_settings: { Default: {} }, koboldai_setting_names: { Default: 'Default' }, amount_gen: 64, max_context: 2048 }),
                    generateHorde: async (prompt, params, _signal, reportProgress, options) => {
                        expect(reportProgress).toBe(false);
                        expect(options?.transientSessionId).toBe(owner.sessionId);
                        options?.onPreparedRequest?.({ requestApi: 'koboldhorde', payload: { prompt, params } });
                        return { results: [{ text: 'horde ok' }] };
                    },
                },
            },
        });
        expect(hordeSeen).toEqual([{ requestApi: 'koboldhorde', payload: { prompt: 'Horde check', params: { prompt: 'Horde check', max_length: 64 } } }]);
    });

    test('installFetchProxy forwards transient session authority to WS delivery and server abort', async () => {
        const pending = await openPendingUpstream();
        const parsedServerUrl = new URL(server.baseURL);
        const prevLocation = globalThis.location;
        const prevWebSocket = globalThis.WebSocket;
        globalThis.location = { protocol: parsedServerUrl.protocol, host: parsedServerUrl.host };
        globalThis.WebSocket = WebSocket;
        const delivery = createLukerDelivery({ reconnectBackoffMs: 50 });
        try {
            await delivery.connect(async () => {
                const ticketRes = await post('/api/ws-ticket');
                return (await ticketRes.json()).ticket;
            });
            const state = await client.storageState();
            const cookieHeader = state.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const owner = await openOwner();
            const fakeWindow = {
                Response,
                Headers,
                fetch: async (url, init = {}) => fetch(new URL(url, server.baseURL), {
                    ...init,
                    headers: {
                        ...(init.headers || {}),
                        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                    },
                }),
            };
            installFetchProxy(delivery, {
                targetWindow: fakeWindow,
                getExtraHeaders: () => ({ 'X-CSRF-Token': csrf }),
            });

            // Complete a private streaming generation through the real proxiedFetch + WS delivery
            const okResp = await fakeWindow.fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                    ...owner.headers,
                },
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: upstream.baseURL,
                    model: 'mock-gpt-4o',
                    messages: [{ role: 'user', content: 'Proxied private generation.' }],
                    stream: false,
                }),
            });
            expect(okResp.status).toBe(200);
            const okData = await okResp.json();
            expect(okData.choices[0].message.content).toBe('The shoreline is quiet.');

            // Abort an in-flight private generation through AbortSignal and verify server upstream socket closes
            const controller = new AbortController();
            const pendingFetch = fakeWindow.fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                    ...owner.headers,
                },
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: pending.url,
                    model: 'mock-gpt-4o',
                    messages: [{ role: 'user', content: 'Pending private generation.' }],
                    stream: false,
                }),
                signal: controller.signal,
            });
            await pending.started;
            controller.abort();
            await expect(pendingFetch).rejects.toMatchObject({ name: 'AbortError' });
            await pending.closed;
        } finally {
            delivery.close();
            globalThis.location = prevLocation;
            globalThis.WebSocket = prevWebSocket;
            await pending.stop();
        }
    });
});
