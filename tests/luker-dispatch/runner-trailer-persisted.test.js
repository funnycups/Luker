// Isolated trailer test — mocks `completeGenerationJobFromText` at
// module-import time so we can prove the runner reads `job.persisted` /
// `job.status` from the job AFTER completeGenerationJobFromText runs,
// not before. In prod the flag stays false until the 15s auto-persist
// grace timer fires; here we short-circuit and flip it synchronously.
//
// Kept in its own file because the mock must be registered before any
// import of the mocked module and applies to every test in the file —
// mixing mocked and non-mocked runs of luker-generation.js under one
// describe block trips over jest.resetModules + src/util.js's config
// path init in tests/jest.setup.js.

import { describe, test, expect, jest } from '@jest/globals';

// Mock BEFORE importing anything downstream that would pull the real
// luker-generation.js. We hand-list only the symbols runner.js consumes.
// If runner.js gains a new import from this module, add a matching key
// here or the mock will resolve `undefined` and the runner will throw.
jest.unstable_mockModule('../../src/endpoints/backends/luker-generation.js', () => ({
    createGenerationJob: (request, { job_id, persist_target }) => ({
        id: String(job_id || 'mock-id'),
        handle: request?.user?.profile?.handle || '',
        status: 'running',
        text: '',
        events: [],
        lastSeq: 0,
        persisted: false,
        persistTarget: persist_target || null,
        modelName: String(request?.body?.model || ''),
        persistenceTimer: null,
        persistenceInFlight: false,
        updatedAt: Date.now(),
        finishedAt: null,
        abortController: null,
        requestMeta: { api: '', model: '', directories: {}, char_name: '' },
    }),
    attachJobToRequest: (request, job) => { request.lukerGenerationJob = job || null; },
    getJobFromRequest: (request) => request?.lukerGenerationJob || null,
    appendGenerationEvent: (job, rawData) => {
        if (!job) return;
        const seq = Number(job.lastSeq || 0) + 1;
        job.lastSeq = seq;
        job.events.push({ seq, data: rawData, ts: Date.now() });
    },
    failGenerationJob: (job, err) => { if (job) { job.status = 'failed'; job.error = String(err || ''); } },
    // The whole point of this test file: force-complete synchronously
    // with persisted=true so the trailer envelope carries a real value.
    completeGenerationJobFromText: async (_req, job) => {
        if (job) {
            job.status = 'completed';
            job.persisted = true;
        }
        return true;
    },
}));

const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');

function fakeRequest({ requestId, body = {}, handle = 'trailer-persisted-alice' } = {}) {
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

describe('runLukerDispatch — trailer reads job.persisted AFTER completeGenerationJobFromText', () => {
    test('persisted=true + status=completed round-trip into the trailer envelope', async () => {
        const req = fakeRequest({ requestId: 'trailer-persisted-1', body: { stream: true } });
        const res = fakeResponse();
        const trailerFrames = [];
        const select = () => async (ctx) => {
            const orig = ctx.emit.trailer;
            ctx.emit.trailer = (bytes) => { trailerFrames.push(bytes); orig(bytes); };
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"y"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        expect(trailerFrames).toHaveLength(1);
        const decoded = new TextDecoder().decode(trailerFrames[0]);
        expect(decoded.startsWith('data: ')).toBe(true);
        expect(decoded.endsWith('\n\n')).toBe(true);
        const payload = JSON.parse(decoded.slice(6).trim());
        expect(payload.luker.persisted).toBe(true);
        expect(payload.luker.status).toBe('completed');
        expect(payload.luker.generation_id).toBe('trailer-persisted-1');
    });
});
