// Verifies that the inspector's per-entry AbortController is threaded into
// the vector provider's upstream fetch. The request inspector abort route
// relies on this: aborting the entry must actually cancel the pending
// embedding HTTP call, not just flip the UI status.

import { describe, expect, test } from '@jest/globals';
import http from 'node:http';
import { startEmbeddingInspection, abortInspectionEntry } from '../../src/request-inspector.js';
import { getOpenAIVector } from '../../src/vectors/openai-vectors.js';

function makeRequest(handle) {
    return {
        user: { profile: { handle }, directories: {} },
        body: {},
    };
}

describe('vector provider inspector abort', () => {
    test('aborting the inspector entry aborts the upstream embedding fetch', async () => {
        let requestReceived = false;
        const server = http.createServer((req, _res) => {
            requestReceived = true;
            // Never respond. The client abort is the only way out.
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;

        const request = makeRequest('vector-abort-provider');
        startEmbeddingInspection(request, {
            source: 'openai',
            model: 'text-embedding-3-small',
            routeKind: 'query',
            inputCount: 1,
            inputCharTotal: 2,
            inputTexts: [{ index: 0, text: 'hi' }],
        });

        try {
            const pending = getOpenAIVector(
                'hi',
                'openai',
                {},
                'text-embedding-3-small',
                { reverseProxy: `http://127.0.0.1:${port}`, proxyPassword: 'test-key' },
                request,
            );

            // Wait until the provider actually reached the upstream server.
            for (let i = 0; i < 50 && !requestReceived; i++) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(requestReceived).toBe(true);

            const aborted = abortInspectionEntry(
                request.user.profile.handle,
                request.__inspectorId,
                'test abort',
            );
            expect(aborted).toBeTruthy();

            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
