// Characterization suite for src/endpoints/backends/luker-generation.js
// Locks in current observable behavior so future refactors surface regressions
// immediately. Do not treat this file as a specification of desired behavior;
// it mirrors what the code does today.
//
// Notes on isolation:
//  - luker-generation.js keeps a module-level `generationJobs` Map and a
//    `jobSubscribers` Map. Every test uses a unique job id (prefix + counter)
//    to avoid cross-test bleed.

import { describe, expect, test } from '@jest/globals';

import {
    createGenerationJob,
    attachJobToRequest,
    getJobFromRequest,
    appendGenerationEvent,
    accumulateChunkTextIntoJob,
    subscribeToJob,
    getPersistChatKey,
    failGenerationJob,
} from '../src/endpoints/backends/luker-generation.js';

let idCounter = 0;
function uniqueJobId(prefix) {
    idCounter += 1;
    return `${prefix}-${process.pid}-${Date.now()}-${idCounter}`;
}

function baseRequest(overrides = {}) {
    return {
        user: { profile: { handle: 'alice' }, directories: {} },
        body: { model: 'test-model' },
        ...overrides,
    };
}

describe('createGenerationJob', () => {
    test('returns null when options is null', () => {
        expect(createGenerationJob(baseRequest(), null)).toBeNull();
    });

    test('returns null when options is undefined', () => {
        expect(createGenerationJob(baseRequest(), undefined)).toBeNull();
    });

    test('returns null when options is not an object', () => {
        expect(createGenerationJob(baseRequest(), 'x')).toBeNull();
        expect(createGenerationJob(baseRequest(), 42)).toBeNull();
    });

    test('returns null when job_id is missing', () => {
        expect(createGenerationJob(baseRequest(), {})).toBeNull();
    });

    test('returns null when job_id is empty or whitespace', () => {
        expect(createGenerationJob(baseRequest(), { job_id: '' })).toBeNull();
        expect(createGenerationJob(baseRequest(), { job_id: '   ' })).toBeNull();
    });

    test('returns null when job_id is not a string', () => {
        expect(createGenerationJob(baseRequest(), { job_id: 123 })).toBeNull();
        expect(createGenerationJob(baseRequest(), { job_id: null })).toBeNull();
    });

    test('creates job with expected initial shape', () => {
        const jobId = uniqueJobId('create-shape');
        const job = createGenerationJob(baseRequest(), { job_id: jobId });
        expect(job).not.toBeNull();
        expect(job).toMatchObject({
            id: jobId,
            handle: 'alice',
            status: 'running',
            text: '',
            lastSeq: 0,
            events: [],
            error: '',
            persisted: false,
            acked: false,
            cancelledByUser: false,
            persistTarget: null,
            chatKey: '',
        });
        expect(typeof job.createdAt).toBe('number');
        expect(typeof job.updatedAt).toBe('number');
        expect(job.abortController).toBeNull();
    });

    test('records requestMeta from request body', () => {
        const jobId = uniqueJobId('create-meta');
        const req = baseRequest({
            body: {
                model: 'gpt-4',
                chat_completion_source: 'openai',
            },
            user: {
                profile: { handle: 'alice' },
                directories: { chats: '/tmp/chats', groupChats: '/tmp/groups' },
            },
        });
        const job = createGenerationJob(req, { job_id: jobId });
        expect(job.requestMeta).toEqual({
            api: 'openai',
            char_name: 'Assistant',
            model: 'gpt-4',
            directories: { chats: '/tmp/chats', groupChats: '/tmp/groups' },
        });
        expect(job.modelName).toBe('gpt-4');
    });

    test('trims job_id whitespace', () => {
        const jobId = uniqueJobId('create-trim');
        const job = createGenerationJob(baseRequest(), { job_id: `  ${jobId}  ` });
        expect(job.id).toBe(jobId);
    });

    test('records persistTarget and derived chatKey when provided', () => {
        const jobId = uniqueJobId('create-persist');
        const persistTarget = { kind: 'group', id: 'g-1' };
        const job = createGenerationJob(baseRequest(), { job_id: jobId, persist_target: persistTarget });
        expect(job.persistTarget).toBe(persistTarget);
        expect(job.chatKey).toBe('group:g-1');
    });

    test('reuses existing job on same job_id', () => {
        const jobId = uniqueJobId('create-reuse');
        const j1 = createGenerationJob(baseRequest(), { job_id: jobId });
        const j2 = createGenerationJob(baseRequest(), { job_id: jobId });
        expect(j1).toBe(j2);
    });

    test('reusing a job resets transient fields but keeps identity', () => {
        const jobId = uniqueJobId('create-reset');
        const j1 = createGenerationJob(baseRequest(), { job_id: jobId });
        j1.status = 'failed';
        j1.error = 'boom';
        j1.acked = true;
        j1.text = 'stale';
        // events array pre-existing is preserved (only replaced if not an array)
        j1.events.push({ seq: 999, data: 'stale', ts: 0 });

        const j2 = createGenerationJob(baseRequest(), { job_id: jobId });
        expect(j2).toBe(j1);
        expect(j2.status).toBe('running');
        expect(j2.error).toBe('');
        expect(j2.acked).toBe(false);
        // text is NOT reset when reusing (documenting current behavior)
        expect(j2.text).toBe('stale');
        // events array is preserved (documenting current behavior)
        expect(j2.events.length).toBe(1);
    });
});

describe('attachJobToRequest + getJobFromRequest', () => {
    test('attach then get round-trips the job', () => {
        const req = baseRequest();
        const job = createGenerationJob(req, { job_id: uniqueJobId('attach-roundtrip') });
        attachJobToRequest(req, job);
        expect(getJobFromRequest(req)).toBe(job);
    });

    test('getJobFromRequest returns null when no job attached', () => {
        expect(getJobFromRequest(baseRequest())).toBeNull();
    });

    test('getJobFromRequest returns null for null/undefined request', () => {
        expect(getJobFromRequest(null)).toBeNull();
        expect(getJobFromRequest(undefined)).toBeNull();
    });

    test('attachJobToRequest with null job clears attachment to null', () => {
        const req = baseRequest();
        const job = createGenerationJob(req, { job_id: uniqueJobId('attach-null') });
        attachJobToRequest(req, job);
        expect(getJobFromRequest(req)).toBe(job);
        attachJobToRequest(req, null);
        expect(getJobFromRequest(req)).toBeNull();
    });

    test('attachJobToRequest is a no-op when request is not an object', () => {
        // Should not throw.
        expect(() => attachJobToRequest(null, {})).not.toThrow();
        expect(() => attachJobToRequest(undefined, {})).not.toThrow();
        expect(() => attachJobToRequest('x', {})).not.toThrow();
    });
});

describe('appendGenerationEvent', () => {
    test('is a no-op when job is null/undefined', () => {
        expect(() => appendGenerationEvent(null, 'data: {}')).not.toThrow();
        expect(() => appendGenerationEvent(undefined, 'data: {}')).not.toThrow();
    });

    test('increments lastSeq starting at 1', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('append-seq') });
        appendGenerationEvent(job, 'first');
        expect(job.lastSeq).toBe(1);
        appendGenerationEvent(job, 'second');
        expect(job.lastSeq).toBe(2);
        appendGenerationEvent(job, 'third');
        expect(job.lastSeq).toBe(3);
    });

    test('pushes { seq, data, ts } entry per call', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('append-entry') });
        appendGenerationEvent(job, 'payload-1');
        expect(job.events).toHaveLength(1);
        const entry = job.events[0];
        expect(entry.seq).toBe(1);
        expect(entry.data).toBe('payload-1');
        expect(typeof entry.ts).toBe('number');
    });

    test('caps events at 8000 by removing oldest entries', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('append-cap') });
        // Push 8001 events; oldest (seq=1) should be evicted.
        for (let i = 0; i < 8001; i += 1) {
            appendGenerationEvent(job, `frame-${i}`);
        }
        expect(job.events.length).toBe(8000);
        // lastSeq keeps counting even after eviction.
        expect(job.lastSeq).toBe(8001);
        // The oldest surviving entry is seq=2 (frame-1); newest is seq=8001 (frame-8000).
        expect(job.events[0].seq).toBe(2);
        expect(job.events[0].data).toBe('frame-1');
        expect(job.events[job.events.length - 1].seq).toBe(8001);
        expect(job.events[job.events.length - 1].data).toBe('frame-8000');
    });

    test('extracts OpenAI-style delta content into job.text', () => {
        const jobId = uniqueJobId('append-openai');
        const req = baseRequest({
            body: { model: 'gpt-4', chat_completion_source: 'openai' },
        });
        const job = createGenerationJob(req, { job_id: jobId });
        expect(job.requestMeta.api).toBe('openai');

        appendGenerationEvent(job, JSON.stringify({
            choices: [{ delta: { content: 'Hello' } }],
        }));
        appendGenerationEvent(job, JSON.stringify({
            choices: [{ delta: { content: ', world' } }],
        }));
        expect(job.text).toBe('Hello, world');
    });

    test('extracts Claude-style delta.text into job.text', () => {
        const jobId = uniqueJobId('append-claude');
        const req = baseRequest({
            body: { model: 'claude-3', chat_completion_source: 'claude' },
        });
        const job = createGenerationJob(req, { job_id: jobId });
        expect(job.requestMeta.api).toBe('claude');

        appendGenerationEvent(job, JSON.stringify({ delta: { text: 'foo' } }));
        appendGenerationEvent(job, JSON.stringify({ delta: { text: 'bar' } }));
        expect(job.text).toBe('foobar');
    });

    test('skips [DONE] sentinel without altering text', () => {
        const jobId = uniqueJobId('append-done');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        appendGenerationEvent(job, JSON.stringify({
            choices: [{ delta: { content: 'abc' } }],
        }));
        expect(job.text).toBe('abc');
        appendGenerationEvent(job, '[DONE]');
        // Event still recorded, but no text delta.
        expect(job.text).toBe('abc');
        expect(job.events).toHaveLength(2);
        expect(job.events[1].data).toBe('[DONE]');
    });

    test('ignores frames wrapped in the luker envelope for text extraction', () => {
        const jobId = uniqueJobId('append-luker-env');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        appendGenerationEvent(job, JSON.stringify({
            luker: { generation_id: 'x', status: 'completed' },
        }));
        // Event recorded but text stays empty (luker envelope short-circuits extractor).
        expect(job.events).toHaveLength(1);
        expect(job.text).toBe('');
    });

    test('records event even when payload is malformed JSON', () => {
        const jobId = uniqueJobId('append-malformed');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        appendGenerationEvent(job, 'not-json-at-all');
        expect(job.events).toHaveLength(1);
        expect(job.text).toBe('');
    });

    test('bumps updatedAt on every append', async () => {
        const jobId = uniqueJobId('append-updated');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        const before = job.updatedAt;
        // Ensure clock advances at least 1ms.
        await new Promise(resolve => setTimeout(resolve, 2));
        appendGenerationEvent(job, 'payload');
        expect(job.updatedAt).toBeGreaterThanOrEqual(before);
    });
});

describe('accumulateChunkTextIntoJob', () => {
    function makeJob(api = 'openai') {
        const req = baseRequest({ body: { chat_completion_source: api } });
        return createGenerationJob(req, { job_id: uniqueJobId(`chunk-${api}`) });
    }
    const enc = (s) => Buffer.from(s, 'utf8');

    test('no-op when job is null/undefined or chunk is empty', () => {
        expect(() => accumulateChunkTextIntoJob(null, enc('data: {}\n\n'))).not.toThrow();
        expect(() => accumulateChunkTextIntoJob(undefined, enc('x'))).not.toThrow();
        const job = makeJob();
        accumulateChunkTextIntoJob(job, null);
        accumulateChunkTextIntoJob(job, undefined);
        accumulateChunkTextIntoJob(job, '');
        expect(job.text).toBe('');
    });

    test('SSE OpenAI: multiple frames in one chunk accumulate delta content', () => {
        const job = makeJob('openai');
        const sse =
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: { content: ', world' } }] })}\n\n`;
        accumulateChunkTextIntoJob(job, enc(sse));
        expect(job.text).toBe('Hello, world');
    });

    test('SSE Claude: event lines are ignored, data lines feed the extractor', () => {
        const job = makeJob('claude');
        const sse =
            `event: content_block_delta\n` +
            `data: ${JSON.stringify({ delta: { text: 'foo' } })}\n\n` +
            `event: content_block_delta\n` +
            `data: ${JSON.stringify({ delta: { text: 'bar' } })}\n\n`;
        accumulateChunkTextIntoJob(job, enc(sse));
        expect(job.text).toBe('foobar');
    });

    test('SSE partial frame across chunks: buffers tail and flushes on next chunk', () => {
        const job = makeJob('openai');
        const full = `data: ${JSON.stringify({ choices: [{ delta: { content: 'abcdef' } }] })}\n\n`;
        const cut = Math.floor(full.length / 2);
        accumulateChunkTextIntoJob(job, enc(full.slice(0, cut)));
        expect(job.text).toBe('');
        accumulateChunkTextIntoJob(job, enc(full.slice(cut)));
        expect(job.text).toBe('abcdef');
    });

    test('non-streaming: whole JSON object in one chunk extracts final text', () => {
        const job = makeJob('openai');
        const payload = JSON.stringify({
            choices: [{ message: { content: 'Full non-streaming answer.' } }],
        });
        accumulateChunkTextIntoJob(job, enc(payload));
        expect(job.text).toBe('Full non-streaming answer.');
    });

    test('binary/garbage chunk: text unchanged, does not throw', () => {
        const job = makeJob('openai');
        job.text = 'prior';
        const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
        expect(() => accumulateChunkTextIntoJob(job, binary)).not.toThrow();
        expect(job.text).toBe('prior');
    });

    test('SSE [DONE] sentinel is skipped without altering text', () => {
        const job = makeJob('openai');
        const sse =
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n` +
            `data: [DONE]\n\n`;
        accumulateChunkTextIntoJob(job, enc(sse));
        expect(job.text).toBe('hi');
    });
});

describe('subscribeToJob', () => {
    test('receives events emitted after subscription', () => {
        const jobId = uniqueJobId('sub-recv');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        const received = [];
        subscribeToJob(jobId, payload => received.push(payload));

        appendGenerationEvent(job, JSON.stringify({
            choices: [{ delta: { content: 'hi' } }],
        }));

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('event');
        expect(received[0].entry.seq).toBe(1);
    });

    test('receives status frames when failGenerationJob runs', () => {
        const jobId = uniqueJobId('sub-status');
        const job = createGenerationJob(baseRequest(), { job_id: jobId });
        const received = [];
        subscribeToJob(jobId, payload => received.push(payload));

        failGenerationJob(job, 'network down');
        const statusFrames = received.filter(p => p.type === 'status');
        expect(statusFrames).toHaveLength(1);
        expect(statusFrames[0].status).toBe('failed');
        expect(statusFrames[0].error).toBe('network down');
    });

    test('returns an unsubscribe fn that stops delivery', () => {
        const jobId = uniqueJobId('sub-unsub');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        const received = [];
        const unsubscribe = subscribeToJob(jobId, payload => received.push(payload));

        appendGenerationEvent(job, JSON.stringify({ choices: [{ delta: { content: 'a' } }] }));
        expect(received).toHaveLength(1);

        unsubscribe();
        appendGenerationEvent(job, JSON.stringify({ choices: [{ delta: { content: 'b' } }] }));
        expect(received).toHaveLength(1);
    });

    test('multiple subscribers all receive events', () => {
        const jobId = uniqueJobId('sub-multi');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        const a = [];
        const b = [];
        subscribeToJob(jobId, payload => a.push(payload));
        subscribeToJob(jobId, payload => b.push(payload));

        appendGenerationEvent(job, JSON.stringify({ choices: [{ delta: { content: 'x' } }] }));
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });

    test('a throwing subscriber does not break other subscribers', () => {
        const jobId = uniqueJobId('sub-throw');
        const req = baseRequest({ body: { chat_completion_source: 'openai' } });
        const job = createGenerationJob(req, { job_id: jobId });
        const survivor = [];
        subscribeToJob(jobId, () => { throw new Error('bad subscriber'); });
        subscribeToJob(jobId, payload => survivor.push(payload));

        // Should not throw.
        expect(() => appendGenerationEvent(job, JSON.stringify({
            choices: [{ delta: { content: 'ok' } }],
        }))).not.toThrow();
        expect(survivor).toHaveLength(1);
    });

    test('returns a no-op unsubscribe when jobId is empty', () => {
        const unsubscribe = subscribeToJob('', () => {});
        expect(typeof unsubscribe).toBe('function');
        // Should not throw when invoked.
        expect(() => unsubscribe()).not.toThrow();
    });

    test('returns a no-op unsubscribe when callback is not a function', () => {
        const unsubscribe = subscribeToJob('any', /** @type {any} */(null));
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
    });
});

describe('getPersistChatKey', () => {
    test('returns empty string for null/undefined', () => {
        expect(getPersistChatKey(null)).toBe('');
        expect(getPersistChatKey(undefined)).toBe('');
    });

    test('returns empty string for non-object', () => {
        expect(getPersistChatKey('x')).toBe('');
        expect(getPersistChatKey(42)).toBe('');
    });

    test('returns empty string for empty object', () => {
        expect(getPersistChatKey({})).toBe('');
    });

    test('group kind produces group:<id>', () => {
        expect(getPersistChatKey({ kind: 'group', id: 'g1' })).toBe('group:g1');
    });

    test('group kind with missing id still emits group: prefix', () => {
        expect(getPersistChatKey({ kind: 'group' })).toBe('group:');
    });

    test('character-style target produces char:<avatar>:<file_name> raw (no sanitization)', () => {
        expect(getPersistChatKey({ avatar_url: 'a.png', file_name: 'x.jsonl' }))
            .toBe('char:a.png:x.jsonl');
    });

    test('character-style needs both avatar_url and file_name to yield a key', () => {
        expect(getPersistChatKey({ avatar_url: 'a.png' })).toBe('');
        expect(getPersistChatKey({ file_name: 'x.jsonl' })).toBe('');
    });
});

describe('failGenerationJob', () => {
    test('is a no-op when job is null/undefined', () => {
        expect(() => failGenerationJob(null, 'err')).not.toThrow();
        expect(() => failGenerationJob(undefined, 'err')).not.toThrow();
    });

    test('sets status to failed and records error message', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('fail-basic') });
        failGenerationJob(job, 'connection reset');
        expect(job.status).toBe('failed');
        expect(job.error).toBe('connection reset');
        expect(typeof job.finishedAt).toBe('number');
    });

    test('defaults error message when none provided', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('fail-default') });
        failGenerationJob(job);
        expect(job.status).toBe('failed');
        expect(job.error).toBe('Unknown error occurred');
    });

    test('coerces non-string error messages', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('fail-coerce') });
        failGenerationJob(job, { code: 500 });
        expect(job.status).toBe('failed');
        expect(typeof job.error).toBe('string');
        expect(job.error.length).toBeGreaterThan(0);
    });

    test('does nothing to a cancelled job', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('fail-cancelled') });
        job.status = 'cancelled';
        job.error = 'user cancelled';
        failGenerationJob(job, 'network down');
        expect(job.status).toBe('cancelled');
        expect(job.error).toBe('user cancelled');
    });

    test('clears abortController reference', () => {
        const job = createGenerationJob(baseRequest(), { job_id: uniqueJobId('fail-abort') });
        job.abortController = { abort: () => {}, signal: { aborted: false } };
        failGenerationJob(job, 'nope');
        expect(job.abortController).toBeNull();
    });
});
