// SPDX-License-Identifier: AGPL-3.0-or-later
import { startMockLLM } from './mockLLM.js';

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('waitFor: condition not met');
}

describe('mockLLM chat-completions close tracking', () => {
    let mock;

    afterEach(async () => {
        await mock?.stop();
    });

    test('a completed reply records responseCompleted true', async () => {
        mock = await startMockLLM({ scriptedReplies: ['*Ash marks the reef line in red.* "There. Mind the shelf."'] });
        const resp = await fetch(`${mock.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'Mark the reef for me.' }], stream: false }),
        });
        await resp.json();
        await waitFor(() => mock.requests[0] && Number.isFinite(mock.requests[0].closedAt));
        expect(mock.requests[0].responseCompleted).toBe(true);
    });

    test('a client abort during latency records responseCompleted false', async () => {
        mock = await startMockLLM({ latencyMs: 30_000 });
        const controller = new AbortController();
        const pending = fetch(`${mock.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', messages: [{ role: 'user', content: 'Read the tide for me.' }], stream: false }),
            signal: controller.signal,
        }).catch(error => error);
        await waitFor(() => mock.requests.length === 1);
        controller.abort();
        const error = await pending;
        expect(error.name).toBe('AbortError');
        await waitFor(() => mock.requests[0].closedAt !== null);
        expect(mock.requests[0].responseCompleted).toBe(false);
        expect(mock.requests[0].firstByteAt).toBeNull();
    });
});
