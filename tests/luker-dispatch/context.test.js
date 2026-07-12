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

    describe('emit.error propagates err.cause', () => {
        // Several SD providers throw `new Error(msg, { cause: … })` or set
        // `err.cause = errText` after reading an upstream error body. The
        // cause carries the actionable validation detail (fal.ai loc/msg
        // pair, workersai raw text, aimlapi upstream text, sdcpp/webui
        // text). Without appending cause here, the client-side ws-delivery
        // reads `msg.message` which only carries the generic prefix.
        test('string cause appended after ": "', () => {
            const { ctx, emitted } = baseFixture();
            const err = new Error('Cloudflare Workers AI returned an error');
            err.cause = '{"errors":[{"message":"invalid model"}]}';
            ctx.emit.error(err);
            expect(emitted).toHaveLength(1);
            expect(emitted[0].data.message).toBe(
                'Cloudflare Workers AI returned an error: {"errors":[{"message":"invalid model"}]}',
            );
        });

        test('cause option constructor form (new Error(msg, {cause}))', () => {
            const { ctx, emitted } = baseFixture();
            const err = new Error('FAL.AI failed to generate image.', {
                cause: 'prompt: field required',
            });
            ctx.emit.error(err);
            expect(emitted[0].data.message).toBe(
                'FAL.AI failed to generate image.: prompt: field required',
            );
        });

        test('object cause serializes to JSON', () => {
            const { ctx, emitted } = baseFixture();
            const err = new Error('BFL failed to generate image.', {
                cause: { status: 'failed', reason: 'nsfw' },
            });
            ctx.emit.error(err);
            expect(emitted[0].data.message).toBe(
                'BFL failed to generate image.: {"status":"failed","reason":"nsfw"}',
            );
        });

        test('nested Error cause uses its message', () => {
            const { ctx, emitted } = baseFixture();
            const inner = new Error('ECONNREFUSED 127.0.0.1:1234');
            const err = new Error('SD dispatch upstream unreachable', { cause: inner });
            ctx.emit.error(err);
            expect(emitted[0].data.message).toBe(
                'SD dispatch upstream unreachable: ECONNREFUSED 127.0.0.1:1234',
            );
        });

        test('no cause → message unchanged (backwards compat)', () => {
            const { ctx, emitted } = baseFixture();
            ctx.emit.error(new Error('bare error'));
            expect(emitted[0].data.message).toBe('bare error');
        });

        test('null / undefined cause treated as absent', () => {
            const { ctx, emitted } = baseFixture();
            const err = new Error('with null cause');
            err.cause = null;
            ctx.emit.error(err);
            expect(emitted[0].data.message).toBe('with null cause');
        });

        test('empty string cause does not append trailing ": "', () => {
            const { ctx, emitted } = baseFixture();
            const err = new Error('empty cause');
            err.cause = '';
            ctx.emit.error(err);
            expect(emitted[0].data.message).toBe('empty cause');
        });

        test('non-Error thrown values still serialize', () => {
            const { ctx, emitted } = baseFixture();
            ctx.emit.error('raw string throw');
            expect(emitted[0].data.message).toBe('raw string throw');
        });
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
