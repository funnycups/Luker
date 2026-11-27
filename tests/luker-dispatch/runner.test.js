import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';

function fakeRequest({ requestId, body = {}, handle = 'alice' } = {}) {
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

describe('runLukerDispatch', () => {
    test('missing x-luker-request-id header: server auto-mints and returns via x-luker-generation-id', async () => {
        const req = fakeRequest({ requestId: null });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(200);
        const mintedId = res.state.headers['x-luker-generation-id'];
        expect(typeof mintedId).toBe('string');
        expect(mintedId.length).toBeGreaterThan(10);
    });

    test('body.luker_generation.job_id overrides header (client-supplied uuid path)', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'header-id-should-lose', body: { luker_generation: { job_id: 'body-id-wins' } } });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.headers['x-luker-generation-id']).toBe('body-id-wins');
        await new Promise(r => setTimeout(r, 20));
        // Job must be findable by the body id (what /jobs/status?id= will use).
        expect(getTaskByRequestId('body-id-wins', 'alice')).not.toBeNull();
    });

    test('400 when select throws', async () => {
        const req = fakeRequest({ requestId: 'select-err-1', body: { unknown: true } });
        const res = fakeResponse();
        const select = () => { throw new Error('unsupported provider'); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(400);
        expect(res.state.body).toEqual({ error: 'unsupported provider' });
    });

    test('200 immediately with x-luker headers, dispatch runs in background', async () => {
        const req = fakeRequest({ requestId: 'ok-1' });
        const res = fakeResponse();
        let ranAt = null;
        const select = () => async (ctx) => {
            ranAt = 'dispatch-ran';
            ctx.emit.chunk(new Uint8Array([65]));  // 'A'
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(200);
        expect(res.state.headers['x-luker-generation-id']).toBe('ok-1');
        expect(res.state.headers['x-luker-server-persisted']).toBe('0');
        expect(res.state.body).toEqual({});
        // dispatch runs via setImmediate; wait a tick
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        expect(ranAt).toBe('dispatch-ran');
    });

    test('background dispatch throw routed to emit.error', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'err-in-dispatch-1' });
        const res = fakeResponse();
        const select = () => async () => { throw new Error('upstream 500'); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        // Wait for background
        await new Promise(r => setTimeout(r, 20));
        const job = getTaskByRequestId('err-in-dispatch-1', 'alice');
        expect(job).not.toBeNull();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('upstream 500');
    });

    test('runner completes request-inspector entry on dispatch success (regression: stuck-on-running)', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({ requestId: 'inspect-success-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        // Dispatch simulates calling ctx.inspection.start() at entry (as real
        // providers do) then emitting the reply.
        const select = () => async (ctx) => {
            ctx.inspection.start();
            ctx.emit.chunk(new TextEncoder().encode(
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
                + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n'
                + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
                + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const buf = getBufferForHandle('alice');
        const entry = buf.find(e => e.id === req.__inspectorId);
        expect(entry).toBeDefined();
        // Regression: inspector previously stuck on 'running' because no
        // dispatch called completeInspection. Runner now covers it.
        expect(entry.status).toBe('success');
        expect(entry.httpStatus).toBe(200);
        expect(typeof entry.durationMs).toBe('number');
    });

    test('runner fails request-inspector entry when HTTP 200 streaming body contains no SSE frames', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({ requestId: 'inspect-non-sse-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.inspection.start();
            ctx.emit.chunk(new TextEncoder().encode('<html>proxy error page</html>'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const buf = getBufferForHandle('alice');
        const entry = buf.find(e => e.id === req.__inspectorId);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('error');
        expect(entry.parseError?.stage).toBe('sse');
    });

    test('runner fails request-inspector entry on dispatch throw', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({ requestId: 'inspect-fail-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.inspection.start();
            throw new Error('upstream 401');
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const buf = getBufferForHandle('alice');
        const entry = buf.find(e => e.id === req.__inspectorId);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('error');
        expect(entry.error).toContain('upstream 401');
        // Explicit 500: an unhandled dispatch throw is not an upstream 4xx.
        // Before the fix, failInspection was called without httpStatus and
        // the inspector UI showed httpStatus=null which rendered as a blank
        // status column — indistinguishable from a still-running entry.
        expect(entry.httpStatus).toBe(500);
    });

    test('runner marks generation job as failed when dispatch throws (Task 2G regression)', async () => {
        // Guards the zombie-job path: pre-fix, dispatch throws surfaced via
        // emit.error but the job stayed status='running' until the 2h TTL
        // reaper, leaving /api/generation/active handing out dead ids.
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'inspect-fail-job-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.inspection.start();
            throw new Error('boom');
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const job = getTaskByRequestId('inspect-fail-job-1', 'alice');
        expect(job).not.toBeNull();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('boom');
        expect(job.finishedAt).toBeGreaterThan(0);
    });

    test('runner advances job to awaiting_ack after dispatch success (regression: stuck-on-running)', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'complete-job-1', body: { model: 'test-model' } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('hi'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));
        const job = getTaskByRequestId('complete-job-1', 'alice');
        expect(job).not.toBeNull();
        // Was 'running' pre-fix — auto-persist grace timer never armed,
        // /jobs/status never reached terminal state, client SSE hung.
        expect(job.status).toBe('awaiting_ack');
        expect(job.modelName).toBe('test-model');
        // Cancel the persistence timer so this test doesn't leak a setTimeout.
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('runner attaches job to request so getJobFromRequest works downstream', async () => {
        const { getJobFromRequest } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'attach-job-1' });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        // Should be attached even before the setImmediate background fires
        // — attachJobToRequest is on the sync path before response.json.
        const attached = getJobFromRequest(req);
        expect(attached).not.toBeNull();
        expect(attached.id).toBe('attach-job-1');
        await new Promise(r => setTimeout(r, 20));
        // Cleanup timer.
        if (attached.persistenceTimer) { clearTimeout(attached.persistenceTimer); attached.persistenceTimer = null; }
    });

    test('runner emits out-of-band meta envelope before end without injecting synthetic luker bytes into chunks', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'meta-test-1', body: { stream: true } });
        const res = fakeResponse();
        const emittedChunks = [];
        const emittedMeta = [];
        const select = () => async (ctx) => {
            const origChunk = ctx.emit.chunk;
            ctx.emit.chunk = (bytes) => {
                emittedChunks.push(bytes);
                origChunk(bytes);
            };
            const origMeta = ctx.emit.meta;
            ctx.emit.meta = (meta) => {
                emittedMeta.push(meta);
                origMeta(meta);
            };
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));

        const decoded = emittedChunks.map(b => new TextDecoder().decode(b)).join('');
        expect(decoded).toBe('data: {"delta":"hi"}\n\n');
        expect(decoded).not.toContain('"luker":');
        expect(emittedMeta).toEqual([
            expect.objectContaining({
                generation_id: 'meta-test-1',
                persisted: expect.any(Boolean),
                status: expect.any(String),
            }),
        ]);

        const job = getTaskByRequestId('meta-test-1', 'alice');
        expect(job.events.map(e => e.data?.kind)).toEqual(['chunk', 'meta', 'end']);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('normalizes 2xx head content-type to application/json for non-streaming text generation when upstream omits or mislabels it', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const reqMissing = fakeRequest({ requestId: 'head-ct-nonstream-1', body: { stream: false } });
        const resMissing = fakeResponse();
        await runLukerDispatch(reqMissing, resMissing, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.emit.head({ status: 200, headers: {} });
                ctx.emit.chunk(new TextEncoder().encode('{"choices":[]}'));
                ctx.emit.end();
            },
        });

        const reqPlain = fakeRequest({ requestId: 'head-ct-nonstream-2', body: { stream: false } });
        const resPlain = fakeResponse();
        await runLukerDispatch(reqPlain, resPlain, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.emit.head({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
                ctx.emit.chunk(new TextEncoder().encode('{"choices":[]}'));
                ctx.emit.end();
            },
        });

        await new Promise(r => setTimeout(r, 25));

        const jobMissing = getTaskByRequestId('head-ct-nonstream-1', 'alice');
        const headMissing = jobMissing.events.find(e => e.data?.kind === 'head');
        expect(headMissing.data.data.headers['content-type']).toBe('application/json; charset=utf-8');
        if (jobMissing.persistenceTimer) { clearTimeout(jobMissing.persistenceTimer); jobMissing.persistenceTimer = null; }

        const jobPlain = getTaskByRequestId('head-ct-nonstream-2', 'alice');
        const headPlain = jobPlain.events.find(e => e.data?.kind === 'head');
        expect(headPlain.data.data.headers['content-type']).toBe('application/json; charset=utf-8');
        if (jobPlain.persistenceTimer) { clearTimeout(jobPlain.persistenceTimer); jobPlain.persistenceTimer = null; }
    });

    test('normalizes 2xx head content-type to text/event-stream for streaming text generation when upstream omits or mislabels it', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'head-ct-stream-1', body: { stream: true } });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'text-completions',
            select: () => async (ctx) => {
                ctx.emit.head({ status: 200, headers: { 'content-type': 'application/x-ndjson' } });
                ctx.emit.chunk(new TextEncoder().encode('data: {"choices":[]}\n\n'));
                ctx.emit.end();
            },
        });

        await new Promise(r => setTimeout(r, 25));
        const job = getTaskByRequestId('head-ct-stream-1', 'alice');
        const head = job.events.find(e => e.data?.kind === 'head');
        expect(head.data.data.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('leaves head content-type untouched for image-generation endpoints', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'head-ct-sd-1', body: { prompt: 'mountain' } });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'sd',
            select: () => async (ctx) => {
                ctx.emit.head({ status: 200, headers: { 'content-type': 'image/png' } });
                ctx.emit.end();
            },
        });

        await new Promise(r => setTimeout(r, 25));
        const job = getTaskByRequestId('head-ct-sd-1', 'alice');
        const head = job.events.find(e => e.data?.kind === 'head');
        expect(head.data.data.headers['content-type']).toBe('image/png');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('fails generation job when provider emits ctx.emit.error without throwing', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'emit-err-no-throw-1', body: { model: 'test-model' } });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.emit.error(new Error('network reset'));
            },
        });
        await new Promise(r => setTimeout(r, 25));
        const job = getTaskByRequestId('emit-err-no-throw-1', 'alice');
        expect(job).not.toBeNull();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('network reset');
        expect(job.persistenceTimer).toBeNull();
    });

    test('fails generation job and running inspector entry on non-2xx upstream head status', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({
            requestId: 'upstream-429-1',
            body: { chat_completion_source: 'makersuite', model: 'gemini-2.5-flash', stream: true },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                ctx.emit.head({ status: 429, headers: { 'content-type': 'application/json' } });
                ctx.emit.chunk(new TextEncoder().encode('{"error":{"message":"rate limited"}}'));
                ctx.emit.end();
            },
        });
        await new Promise(r => setTimeout(r, 25));
        const job = getTaskByRequestId('upstream-429-1', 'alice');
        expect(job).not.toBeNull();
        expect(job.status).toBe('failed');
        expect(job.persistenceTimer).toBeNull();
        expect(job.events.map(e => e.data?.kind)).toEqual(['head', 'chunk', 'meta', 'end']);
        const metaEvent = job.events.find(e => e.data?.kind === 'meta');
        expect(metaEvent.data.data.status).toBe('failed');

        const entry = getBufferForHandle('alice').find(e => e.id === req.__inspectorId);
        expect(entry.status).toBe('error');
        expect(entry.httpStatus).toBe(429);
    });

    test('fails generation job and never arms auto-persist on HTTP 200 in-stream provider_error or malformed SSE', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const { getBufferForHandle } = await import('../../src/request-inspector.js');

        // Case 1: HTTP 200 stream with partial text followed by in-stream provider_error.
        const reqProviderErr = fakeRequest({
            requestId: 'stream-provider-err-1',
            body: { chat_completion_source: 'claude', model: 'claude-sonnet-4-6', stream: true },
        });
        const resProviderErr = fakeResponse();
        await runLukerDispatch(reqProviderErr, resProviderErr, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
                ctx.emit.chunk(new TextEncoder().encode(
                    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
                    + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
                    + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
                ));
                ctx.emit.end();
            },
        });

        // Case 2: HTTP 200 streaming body containing HTML instead of SSE frames.
        const reqMalformedSse = fakeRequest({
            requestId: 'stream-malformed-sse-1',
            body: { chat_completion_source: 'claude', model: 'claude-sonnet-4-6', stream: true },
        });
        const resMalformedSse = fakeResponse();
        await runLukerDispatch(reqMalformedSse, resMalformedSse, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
                ctx.emit.chunk(new TextEncoder().encode('<html>proxy error</html>'));
                ctx.emit.end();
            },
        });

        await new Promise(r => setTimeout(r, 30));

        const job1 = getTaskByRequestId('stream-provider-err-1', 'alice');
        expect(job1.status).toBe('failed');
        expect(job1.persistenceTimer).toBeNull();
        expect(job1.parseError?.stage).toBe('provider_error');
        expect(job1.error).toContain('Overloaded');
        const meta1 = job1.events.find(e => e.data?.kind === 'meta');
        expect(meta1.data.data.status).toBe('failed');
        const entry1 = getBufferForHandle('alice').find(e => e.id === reqProviderErr.__inspectorId);
        expect(entry1.status).toBe('error');

        const job2 = getTaskByRequestId('stream-malformed-sse-1', 'alice');
        expect(job2.status).toBe('failed');
        expect(job2.persistenceTimer).toBeNull();
        expect(job2.parseError?.stage).toBe('sse');
        const meta2 = job2.events.find(e => e.data?.kind === 'meta');
        expect(meta2.data.data.status).toBe('failed');
    });

    test('client-aborted job never transitions from failed back to awaiting_ack even if dispatch returns normally', async () => {
        const { getTaskByRequestId, failGenerationJob } = await import('../../src/endpoints/backends/luker-generation.js');
        const { getBufferForHandle } = await import('../../src/request-inspector.js');

        const req = fakeRequest({
            requestId: 'client-abort-race-1',
            body: { chat_completion_source: 'openai', model: 'gpt-4o', stream: false },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                ctx.emit.head({ status: 200, headers: { 'content-type': 'application/json' } });
                ctx.emit.chunk(new TextEncoder().encode(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'too late' }, finish_reason: 'stop' }],
                })));
                // Simulate POST /api/generation/:id/abort arriving before dispatch finishes.
                const activeJob = getTaskByRequestId('client-abort-race-1', 'alice');
                activeJob.abortController?.abort('client abort');
                failGenerationJob(activeJob, 'aborted by client');
                ctx.emit.end();
            },
        });

        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('client-abort-race-1', 'alice');
        expect(job.status).toBe('failed');
        expect(job.error).toBe('aborted by client');
        expect(job.persistenceTimer).toBeNull();
        const meta = job.events.find(e => e.data?.kind === 'meta');
        expect(meta.data.data.status).toBe('failed');
        const entry = getBufferForHandle('alice').find(e => e.id === req.__inspectorId);
        expect(entry.status).toBe('aborted');
    });

    test('transient session malformed non-streaming JSON fails cleanly without running plain-text tool retries', async () => {
        const { createTransientSession, closeTransientSession, TRANSIENT_SESSION_HEADER } = await import('../../src/transient-sessions.js');
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const { currentScopeForResources } = await import('../harness/storage-scope.js');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');

        const tmpDir = (await currentScopeForResources().directory('luker-runner-transient')).path;
        const userImages = path.join(tmpDir, 'images');
        await fs.mkdir(userImages, { recursive: true });
        let session;
        try {
            session = await createTransientSession({ userHandle: 'alice', directories: { userImages }, owner: {} });
            let dispatchCalls = 0;
            const req = {
                headers: {
                    'x-luker-request-id': 'transient-bad-json-1',
                    [TRANSIENT_SESSION_HEADER.toLowerCase()]: session.id,
                },
                body: {
                    chat_completion_source: 'openai',
                    model: 'gpt-4o',
                    stream: false,
                    messages: [{ role: 'user', content: 'hi' }],
                    luker_plain_text_tools: {
                        mode: 'prompt_xml',
                        tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
                        toolChoice: 'required',
                        triggerSignal: '<Function_Test_Start/>',
                        retry: { enabled: true, maxAttempts: 3 },
                    },
                },
                user: { profile: { handle: 'alice' }, directories: { userImages } },
            };
            const res = fakeResponse();
            await runLukerDispatch(req, res, {
                endpoint: 'chat-completions',
                select: () => async (ctx) => {
                    dispatchCalls += 1;
                    ctx.inspection.start();
                    ctx.emit.head({ status: 200, headers: { 'content-type': 'application/json' } });
                    ctx.emit.chunk(new TextEncoder().encode('<html>malformed proxy body</html>'));
                    ctx.emit.end();
                },
            });

            await new Promise(r => setTimeout(r, 40));

            expect(dispatchCalls).toBe(1);
            const job = getTaskByRequestId('transient-bad-json-1', 'alice', session.id);
            expect(job.status).toBe('failed');
            expect(job.parseError?.stage).toBe('json');
            expect(job.persistenceTimer).toBeNull();
            const ptMetas = job.events
                .filter(e => e.data?.kind === 'meta' && e.data?.data?.plain_text_function_call)
                .map(e => e.data.data.plain_text_function_call);
            expect(ptMetas.every(m => m.status === 'pending')).toBe(true);
        } finally {
            if (session) await closeTransientSession(session).catch(() => {});
        }
    });

    test('AI21 forced non-streaming keeps JSON content-type, inspector state, and job parsing consistent when client requested stream:true', async () => {
        const { dispatchAI21 } = await import('../../src/luker-dispatch/providers/chat-completions/ai21.js');
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const { getBufferForHandle } = await import('../../src/request-inspector.js');

        const req = fakeRequest({
            requestId: 'ai21-forced-nonstream-1',
            body: {
                chat_completion_source: 'ai21',
                model: 'jamba-1.5-large',
                stream: true,
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
            },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.secrets.read = () => 'ai21-key';
                ctx.fetch = async () => new Response(JSON.stringify({
                    id: 'ai21-nonstream',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'Forced JSON reply' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
                }), { status: 200, headers: { 'content-type': 'application/json' } });
                return dispatchAI21(ctx);
            },
        });

        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('ai21-forced-nonstream-1', 'alice');
        expect(job.status).toBe('awaiting_ack');
        expect(job.parseError).toBeFalsy();
        expect(job.text).toBe('Forced JSON reply');
        const head = job.events.find(e => e.data?.kind === 'head');
        expect(head.data.data.headers['content-type']).toBe('application/json');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }

        const entry = getBufferForHandle('alice').find(e => e.id === req.__inspectorId);
        expect(entry.status).toBe('success');
        expect(entry.stream).toBe(false);
        expect(entry.responseText).toBe('Forced JSON reply');
    });

    test('pipeResponseBodyToEmit / emit.error without throwing finalizes Request Inspector entry instead of leaving it running', async () => {
        const { relayUpstreamResponse } = await import('../../src/luker-dispatch/providers/chat-completions/upstream-relay.js');
        const { getBufferForHandle } = await import('../../src/request-inspector.js');

        const reqNoBody = fakeRequest({
            requestId: 'pipe-nobody-inspect-1',
            body: { chat_completion_source: 'openai', model: 'gpt-4o', stream: true },
        });
        const resNoBody = fakeResponse();
        await runLukerDispatch(reqNoBody, resNoBody, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                await relayUpstreamResponse(ctx, {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'content-type': 'text/event-stream' },
                    body: null,
                }, { label: 'OpenAI', stream: true });
            },
        });

        const reqDirectErr = fakeRequest({
            requestId: 'direct-emit-err-inspect-1',
            body: { chat_completion_source: 'openai', model: 'gpt-4o', stream: true },
        });
        const resDirectErr = fakeResponse();
        await runLukerDispatch(reqDirectErr, resDirectErr, {
            endpoint: 'chat-completions',
            select: () => async (ctx) => {
                ctx.inspection.start();
                ctx.emit.error(new Error('stream dropped'));
            },
        });

        await new Promise(r => setTimeout(r, 30));

        const entryNoBody = getBufferForHandle('alice').find(e => e.id === reqNoBody.__inspectorId);
        expect(entryNoBody.status).toBe('error');
        expect(entryNoBody.error).toContain('no body');

        const entryDirectErr = getBufferForHandle('alice').find(e => e.id === reqDirectErr.__inspectorId);
        expect(entryDirectErr.status).toBe('error');
        expect(entryDirectErr.error).toContain('stream dropped');
    });

    test('transient non-streaming HTTP 200 SSE-framed response fails with ProtocolParseError and does not complete with text', async () => {
        const { createTransientSession, closeTransientSession, TRANSIENT_SESSION_HEADER } = await import('../../src/transient-sessions.js');
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const { currentScopeForResources } = await import('../harness/storage-scope.js');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');

        const tmpDir = (await currentScopeForResources().directory('luker-runner-transient-sse')).path;
        const userImages = path.join(tmpDir, 'images');
        await fs.mkdir(userImages, { recursive: true });
        let session;
        try {
            session = await createTransientSession({ userHandle: 'alice', directories: { userImages }, owner: {} });
            let dispatchCalls = 0;
            const sseBody = 'data: {"choices":[{"delta":{"content":"leaked sse text"}}]}\n\ndata: [DONE]\n\n';
            const req = {
                headers: {
                    'x-luker-request-id': 'transient-nonstream-sse-1',
                    [TRANSIENT_SESSION_HEADER.toLowerCase()]: session.id,
                },
                body: {
                    chat_completion_source: 'openai',
                    model: 'gpt-4o',
                    stream: false,
                    messages: [{ role: 'user', content: 'hi' }],
                    luker_plain_text_tools: {
                        mode: 'prompt_xml',
                        tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
                        toolChoice: 'required',
                        triggerSignal: '<Function_Test_Start/>',
                        retry: { enabled: true, maxAttempts: 3 },
                    },
                },
                user: { profile: { handle: 'alice' }, directories: { userImages } },
            };
            const res = fakeResponse();
            await runLukerDispatch(req, res, {
                endpoint: 'chat-completions',
                select: () => async (ctx) => {
                    dispatchCalls += 1;
                    ctx.inspection.start();
                    ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
                    ctx.emit.chunk(new TextEncoder().encode(sseBody));
                    ctx.emit.end();
                },
            });

            // Also verify runner strict validation clears SSE-populated turn/text if stream mode flips to non-streaming before end.
            const reqLateFlip = {
                headers: {
                    'x-luker-request-id': 'transient-nonstream-sse-late-flip-1',
                    [TRANSIENT_SESSION_HEADER.toLowerCase()]: session.id,
                },
                body: {
                    chat_completion_source: 'openai',
                    model: 'gpt-4o',
                    stream: true,
                    messages: [{ role: 'user', content: 'hi' }],
                },
                user: { profile: { handle: 'alice' }, directories: { userImages } },
            };
            const resLateFlip = fakeResponse();
            await runLukerDispatch(reqLateFlip, resLateFlip, {
                endpoint: 'chat-completions',
                select: () => async (ctx) => {
                    ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
                    ctx.emit.chunk(new TextEncoder().encode(sseBody));
                    ctx.setStreamMode(false);
                    ctx.emit.end();
                },
            });

            await new Promise(r => setTimeout(r, 40));

            expect(dispatchCalls).toBe(1);
            const job = getTaskByRequestId('transient-nonstream-sse-1', 'alice', session.id);
            expect(job.status).toBe('failed');
            expect(job.parseError?.stage).toBe('json');
            expect(job.text).toBe('');
            expect(job.parsedTurn ?? null).toBeNull();
            expect(job.persistenceTimer).toBeNull();
            const meta = job.events.find(e => e.data?.kind === 'meta' && !e.data?.data?.plain_text_function_call);
            expect(meta.data.data.status).toBe('failed');
            const ptMetas = job.events
                .filter(e => e.data?.kind === 'meta' && e.data?.data?.plain_text_function_call)
                .map(e => e.data.data.plain_text_function_call);
            expect(ptMetas.every(m => m.status === 'pending')).toBe(true);

            const lateJob = getTaskByRequestId('transient-nonstream-sse-late-flip-1', 'alice', session.id);
            expect(lateJob.status).toBe('failed');
            expect(lateJob.parseError?.stage).toBe('json');
            expect(lateJob.text).toBe('');
            expect(lateJob.parsedTurn).toBeNull();
        } finally {
            if (session) await closeTransientSession(session).catch(() => {});
        }
    });

    test('runner outer catch finalizes running image Request Inspector entries on throw and abort', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');

        const reqThrow = fakeRequest({ requestId: 'image-throw-inspect-1', body: { prompt: 'coastal lighthouse' } });
        const resThrow = fakeResponse();
        await runLukerDispatch(reqThrow, resThrow, {
            endpoint: 'sd',
            select: () => async (ctx) => {
                ctx.inspection.startImage({ provider: 'webui', prompt: 'coastal lighthouse' });
                throw new Error('image backend crashed');
            },
        });

        const reqAbort = fakeRequest({ requestId: 'image-abort-inspect-1', body: { prompt: 'coastal lighthouse' } });
        const resAbort = fakeResponse();
        await runLukerDispatch(reqAbort, resAbort, {
            endpoint: 'sd',
            select: () => async (ctx) => {
                ctx.inspection.startImage({ provider: 'webui', prompt: 'coastal lighthouse' });
                ctx.abort();
                const abortErr = new Error('The user aborted a request.');
                abortErr.name = 'AbortError';
                throw abortErr;
            },
        });

        await new Promise(r => setTimeout(r, 30));

        const buf = getBufferForHandle('alice');
        const throwEntry = buf.find(e => e.id === reqThrow.__inspectorId);
        expect(throwEntry).toBeDefined();
        expect(throwEntry.type).toBe('image');
        expect(throwEntry.status).toBe('error');
        expect(throwEntry.httpStatus).toBe(500);
        expect(throwEntry.error).toContain('image backend crashed');
        expect(getTaskByRequestId('image-throw-inspect-1', 'alice').status).toBe('failed');

        const abortEntry = buf.find(e => e.id === reqAbort.__inspectorId);
        expect(abortEntry).toBeDefined();
        expect(abortEntry.type).toBe('image');
        expect(abortEntry.status).toBe('aborted');
        expect(getTaskByRequestId('image-abort-inspect-1', 'alice').status).toBe('failed');
    });

    test('strips luker_streaming_tool_reply from request.body before dispatch and exposes normalized ctx.streamingToolReply', async () => {
        let seenBody = null;
        let seenStreamingToolReply = null;
        const req = fakeRequest({
            requestId: 'strip-streaming-tool-reply-1',
            body: {
                chat_completion_source: 'openai',
                model: 'gpt-4o',
                stream: true,
                messages: [{ role: 'user', content: 'hi' }],
                luker_streaming_tool_reply: { name: ' reply ', argument: 'payload.body' },
            },
        });
        const res = fakeResponse();
        await runLukerDispatch(req, res, {
            endpoint: 'chat-completions',
            select: (body) => {
                expect(body).not.toHaveProperty('luker_streaming_tool_reply');
                return async (ctx) => {
                    seenBody = { ...ctx.body };
                    seenStreamingToolReply = ctx.streamingToolReply;
                    ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
                    ctx.emit.chunk(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
                    ctx.emit.end();
                };
            },
        });
        await new Promise(r => setTimeout(r, 30));
        expect(seenBody).not.toHaveProperty('luker_streaming_tool_reply');
        expect(seenStreamingToolReply).toEqual({
            name: 'reply',
            argument: 'payload.body',
            path: ['payload', 'body'],
        });
    });
});
