import { createDispatchContext } from '../../src/luker-dispatch/context.js';

// Reset in-memory inspector state between tests. request-inspector keeps a
// module-level Map keyed by user handle; using a unique handle per fixture
// keeps tests isolated.
let handleSeq = 0;

describe('createDispatchContext', () => {
    function baseFixture(overrides = {}) {
        const emitted = [];
        const ac = new AbortController();
        const handle = `alice-${++handleSeq}`;
        const request = {
            body: { model: 'test-model', ...(overrides.body || {}) },
            user: { profile: { handle }, directories: {} },
            headers: {},
        };
        const task = {
            id: `ctx-test-${handleSeq}`,
            owner: handle,
            abortController: ac,
        };
        const ctx = createDispatchContext({
            request, task, abortController: ac,
            onEmit: (event) => emitted.push(event),
        });
        return { ctx, emitted, ac, task, request, handle };
    }

    test('body/user/signal/fetch exposed', () => {
        const { ctx, ac, handle } = baseFixture();
        expect(ctx.body.model).toBe('test-model');
        expect(ctx.user.handle).toBe(handle);
        expect(ctx.signal).toBe(ac.signal);
        expect(typeof ctx.fetch).toBe('function');
    });

    test('emit.head then chunk then end appends events in order', () => {
        const { ctx, emitted } = baseFixture();
        ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
        ctx.emit.chunk(new Uint8Array([1, 2, 3]));
        ctx.emit.end();
        expect(emitted.map(e => e.kind)).toEqual(['head', 'chunk', 'end']);
        expect(emitted[0].data).toEqual({ status: 200, headers: { 'content-type': 'text/event-stream' } });
        expect(Array.from(emitted[1].data)).toEqual([1, 2, 3]);
    });

    test('emit.error terminates and rejects subsequent emit', () => {
        const { ctx, emitted } = baseFixture();
        ctx.emit.error(new Error('boom'));
        expect(emitted).toHaveLength(1);
        expect(emitted[0].kind).toBe('error');
        // subsequent emits are no-op (already terminal)
        ctx.emit.chunk(new Uint8Array([9]));
        expect(emitted).toHaveLength(1);
    });

    test('emit.end after emit.end is no-op', () => {
        const { ctx, emitted } = baseFixture();
        ctx.emit.end();
        ctx.emit.end();
        expect(emitted).toHaveLength(1);
    });

    describe('inspection (image)', () => {
        test('startImage sets request.__inspectorId; completeImage marks success', () => {
            const { ctx, request } = baseFixture();
            expect(request.__inspectorId).toBeUndefined();
            ctx.inspection.startImage({ source: 'sd_webui', prompt: 'a cat', model: 'sd15', width: 512, height: 512 });
            expect(typeof request.__inspectorId).toBe('string');
            // Should not throw.
            ctx.inspection.completeImage({ format: 'png', sizeBytes: 1024 });
        });

        test('failImage accepts Error object', () => {
            const { ctx } = baseFixture();
            ctx.inspection.startImage({ source: 'sd_webui', prompt: 'x' });
            expect(() => ctx.inspection.failImage(new Error('boom'), 500)).not.toThrow();
        });

        test('failImage accepts string', () => {
            const { ctx } = baseFixture();
            ctx.inspection.startImage({ source: 'sd_webui', prompt: 'x' });
            expect(() => ctx.inspection.failImage('bad', 500)).not.toThrow();
        });

        test('abort is safe to call without a running inspection', () => {
            const { ctx } = baseFixture();
            expect(() => ctx.inspection.abort()).not.toThrow();
        });

        test('attach accepts extra apiKey/wirePayload args (backwards-compatible)', () => {
            const { ctx } = baseFixture();
            ctx.inspection.startImage({ source: 'sd_webui', prompt: 'x' });
            expect(() => ctx.inspection.attach('https://example.test/txt2img', 'sk-x', { prompt: 'x' })).not.toThrow();
            // Also OK with just url (old signature).
            expect(() => ctx.inspection.attach('https://example.test/txt2img')).not.toThrow();
        });
    });
});
