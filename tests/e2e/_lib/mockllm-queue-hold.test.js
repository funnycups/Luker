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

function postChat(mock, content, signal) {
    return fetch(`${mock.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock-gpt-4o', messages: [{ role: 'user', content }], stream: false }),
        signal,
    });
}

describe('mockLLM queue holds', () => {
    let mock;

    afterEach(async () => {
        await mock?.stop();
    });

    test('a held request answers from the queue only after release', async () => {
        mock = await startMockLLM({ scriptedReplies: ['*Ash pockets the compass.* "North, then."'] });
        const hold = mock.holdNextQueuedRequest();
        let settled = false;
        const pending = postChat(mock, 'Which way?').then(async (resp) => { settled = true; return resp.json(); });
        const record = await hold.requested;
        expect(record).toBe(mock.requests[0]);
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        hold.release();
        const body = await pending;
        expect(body.choices[0].message.content).toBe('*Ash pockets the compass.* "North, then."');
    });

    test('release with an error answers the held request with that status', async () => {
        mock = await startMockLLM({ scriptedReplies: ['*Ash shakes her head.* "Not this one."'] });
        const hold = mock.holdNextQueuedRequest();
        const pending = postChat(mock, 'Will it hold?');
        await hold.requested;
        hold.release({ status: 500, message: 'upstream overloaded' });
        const resp = await pending;
        expect(resp.status).toBe(500);
        expect((await resp.json()).error.message).toBe('upstream overloaded');
        const next = await (await postChat(mock, 'And now?')).json();
        expect(next.choices[0].message.content).toBe('*Ash shakes her head.* "Not this one."');
    });

    test('a client abort while held closes the request without a response', async () => {
        mock = await startMockLLM({});
        const hold = mock.holdNextQueuedRequest();
        const controller = new AbortController();
        const pending = postChat(mock, 'Hold the line.', controller.signal).catch(error => error);
        const record = await hold.requested;
        controller.abort();
        const error = await pending;
        expect(error.name).toBe('AbortError');
        await waitFor(() => record.closedAt !== null);
        expect(record.responseCompleted).toBe(false);
        expect(record.firstByteAt).toBeNull();
    });
});
