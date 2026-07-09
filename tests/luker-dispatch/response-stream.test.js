// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from 'node:stream';
import { pipeResponseBodyToEmit } from '../../src/luker-dispatch/response-stream.js';

function makeCtx() {
    const emitted = [];
    const ac = new AbortController();
    const ctx = {
        signal: ac.signal,
        emit: {
            chunk: (bytes) => emitted.push({ kind: 'chunk', data: bytes }),
            end: () => emitted.push({ kind: 'end' }),
            error: (err) => emitted.push({ kind: 'error', data: { message: String(err?.message || err) } }),
        },
    };
    return { ctx, emitted, ac };
}

describe('pipeResponseBodyToEmit', () => {
    test('Node Readable body: emits chunks then end', async () => {
        const { ctx, emitted } = makeCtx();
        const body = Readable.from([
            Buffer.from('hello '),
            Buffer.from('world'),
        ]);
        await pipeResponseBodyToEmit({ body }, ctx);
        expect(emitted.filter(e => e.kind === 'chunk').length).toBe(2);
        expect(emitted[emitted.length - 1]).toEqual({ kind: 'end' });
        const merged = Buffer.concat(emitted.filter(e => e.kind === 'chunk').map(e => Buffer.from(e.data))).toString('utf8');
        expect(merged).toBe('hello world');
    });

    test('Web ReadableStream body: emits chunks then end', async () => {
        const { ctx, emitted } = makeCtx();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5]));
                controller.close();
            },
        });
        await pipeResponseBodyToEmit({ body }, ctx);
        const chunks = emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBe(2);
        expect(chunks[0].data).toEqual(new Uint8Array([1, 2, 3]));
        expect(chunks[1].data).toEqual(new Uint8Array([4, 5]));
        expect(emitted[emitted.length - 1]).toEqual({ kind: 'end' });
    });

    test('abort mid-Node-stream: body destroyed, no end emitted', async () => {
        const { ctx, emitted, ac } = makeCtx();
        // A stream that never ends on its own.
        let pushed = 0;
        const body = new Readable({
            read() {
                if (pushed++ < 1) {
                    this.push(Buffer.from('first'));
                }
                // Otherwise leave pending until destroyed.
            },
        });
        const p = pipeResponseBodyToEmit({ body }, ctx);
        // Give the stream a tick to emit 'first', then abort.
        await new Promise(r => setImmediate(r));
        ac.abort();
        await expect(p).rejects.toThrow(/aborted/);
        expect(body.destroyed).toBe(true);
        // No 'end' should have been emitted after abort.
        expect(emitted.find(e => e.kind === 'end')).toBeUndefined();
    });

    test('no body: emits error', async () => {
        const { ctx, emitted } = makeCtx();
        await pipeResponseBodyToEmit({ body: null }, ctx);
        expect(emitted.length).toBe(1);
        expect(emitted[0].kind).toBe('error');
        expect(emitted[0].data.message).toMatch(/no body/);
    });

    test('unknown body shape: emits error', async () => {
        const { ctx, emitted } = makeCtx();
        await pipeResponseBodyToEmit({ body: { foo: 'bar' } }, ctx);
        expect(emitted.length).toBe(1);
        expect(emitted[0].kind).toBe('error');
        expect(emitted[0].data.message).toMatch(/neither Web ReadableStream nor Node Readable/);
    });
});
