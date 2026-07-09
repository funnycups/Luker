// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipe an upstream fetch response body to ctx.emit.chunk / ctx.emit.end.
 *
 * Handles both node-fetch v3 (which returns a Node Readable / PassThrough for
 * `resp.body`) and Web fetch implementations (undici / bun / whatwg fetch)
 * whose `resp.body` is a WHATWG ReadableStream with `.getReader()`.
 *
 * Aborts cleanly on ctx.signal by destroying the Node stream (Web streams
 * abort via the fetch AbortController wired into the request).
 *
 * @param {import('node-fetch').Response} resp
 * @param {import('./context.js').DispatchContext} ctx
 * @returns {Promise<void>}
 */
export async function pipeResponseBodyToEmit(resp, ctx) {
    const body = resp?.body;
    if (!body) {
        ctx.emit.error(new Error('upstream response has no body'));
        return;
    }

    // Web ReadableStream case (undici / bun's built-in / whatwg fetch)
    if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) ctx.emit.chunk(value);
            }
            ctx.emit.end();
        } finally {
            try { reader.releaseLock(); } catch { /* best-effort */ }
        }
        return;
    }

    // Node stream case (node-fetch v3 PassThrough / Readable)
    if (typeof body.on === 'function') {
        await new Promise((resolve, reject) => {
            const onData = (chunk) => {
                if (chunk && chunk.length) {
                    ctx.emit.chunk(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
                }
            };
            const onEnd = () => {
                cleanup();
                ctx.emit.end();
                resolve();
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const onAbort = () => {
                try { body.destroy?.(new Error('aborted')); } catch { /* best-effort */ }
            };
            const cleanup = () => {
                try { body.off?.('data', onData); } catch { /* best-effort */ }
                try { body.off?.('end', onEnd); } catch { /* best-effort */ }
                try { body.off?.('error', onError); } catch { /* best-effort */ }
                try { ctx.signal?.removeEventListener?.('abort', onAbort); } catch { /* best-effort */ }
            };
            body.on('data', onData);
            body.on('end', onEnd);
            body.on('error', onError);
            ctx.signal?.addEventListener?.('abort', onAbort);
        });
        return;
    }

    ctx.emit.error(new Error('upstream response body is neither Web ReadableStream nor Node Readable'));
}
