import { test, expect } from '@jest/globals';
import http from 'node:http';
import '../../src/fetch-patch.js';
import { createResponseReadOwner } from '../e2e/_lib/response-reads.js';

test('an owned response read records actual text before final settlement', async () => {
    const server = http.createServer((_request, response) => response.end('complete response payload'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const owner = createResponseReadOwner();
    try {
        owner.observe(await fetch(`http://127.0.0.1:${server.address().port}`));
        expect(await owner.settle()).toEqual(['complete response payload']);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an interrupted response is observed immediately and final settlement preserves an earlier assertion failure', async () => {
    let interrupt;
    const barrier = new Promise(resolve => { interrupt = resolve; });
    const server = http.createServer(async (_request, response) => {
        response.writeHead(200, { 'Content-Length': '1000' });
        response.write('partial body');
        await barrier;
        response.destroy();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const owner = createResponseReadOwner();
    const unhandled = [];
    const observe = error => unhandled.push(error);
    process.on('unhandledRejection', observe);
    try {
        owner.observe(await fetch(`http://127.0.0.1:${server.address().port}`));
        interrupt();
        await new Promise(resolve => setImmediate(resolve));
        const primary = new Error('earlier assertion failure');
        const outcome = await owner.settle(primary).then(value => ({ value }), error => ({ error }));
        expect(outcome.error).toBeInstanceOf(globalThis.AggregateError);
        expect(outcome.error.errors[0]).toBe(primary);
        expect(outcome.error.errors).toHaveLength(2);
        expect(unhandled).toEqual([]);
    } finally {
        interrupt();
        await owner.settle().catch(error => { expect(error).toBeInstanceOf(globalThis.AggregateError); });
        process.off('unhandledRejection', observe);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
