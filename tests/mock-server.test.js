import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { MockServer } from './util/mock-server.js';

describe('MockServer tests', () => {
    // Port 0 = OS-assigned ephemeral port. The literal 3000 raced against
    // any other process (or a lingering test-run) that already grabbed
    // 3000, surfacing as intermittent EADDRINUSE flakes under jest's
    // default multi-worker execution. MockServer.start() populates
    // `port` from server.address() after bind so the fetch URL below
    // targets the actual bound port.
    /** @type {MockServer} */
    const mockServer = new MockServer({ port: 0, host: '127.0.0.1' });

    beforeAll(async () => {
        await mockServer.start();
    });

    afterAll(async () => {
        await mockServer.stop();
    });

    test('should provide OpenAI-compatible endpoint', async () => {
        const requestBody = {
            model: 'gpt-4o',
            max_tokens: 400,
            messages: [
                { role: 'user', content: 'Hello, world!' },
            ],
        };
        const response = await fetch(`http://127.0.0.1:${mockServer.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        const expectedResponse = { 'choices': [{ 'finish_reason': 'stop', 'index': 0, 'message': { 'role': 'assistant', 'reasoning_content': 'gpt-4o\n1\n400', 'content': 'Hello, world!' } }], 'created': 0, 'model': 'gpt-4o' };
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual(expectedResponse);
    });
});
