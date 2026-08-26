// SPDX-License-Identifier: AGPL-3.0-or-later
import { startMockLLM } from './mockLLM.js';

describe('mockLLM /v1/responses', () => {
    let mock;

    afterEach(async () => {
        await mock?.stop();
    });

    test('streams semantic events for a scripted text reply', async () => {
        mock = await startMockLLM({});
        mock.scriptReply('Hello world');
        const resp = await fetch(`${mock.baseURL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', input: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        expect(resp.ok).toBe(true);
        const raw = await resp.text();
        const types = raw.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice('event: '.length));
        expect(types[0]).toBe('response.created');
        expect(types.filter((t) => t === 'response.output_text.delta').length).toBeGreaterThan(0);
        expect(types.at(-1)).toBe('response.completed');
        const completed = JSON.parse(raw.split('\n\n').find((f) => f.includes('"response.completed"')).split('\ndata: ')[1]);
        expect(completed.response.status).toBe('completed');
        expect(mock.requests[0].url).toContain('/responses');
    });

    test('non-streaming returns full response object with output_text', async () => {
        mock = await startMockLLM({});
        mock.scriptReply('Plain answer');
        const resp = await fetch(`${mock.baseURL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', input: [{ role: 'user', content: 'hi' }], stream: false }),
        });
        const json = await resp.json();
        expect(json.status).toBe('completed');
        const message = json.output.find((o) => o.type === 'message');
        expect(message.content[0].text).toBe('Plain answer');
    });

    test('scripted tool call emits function_call item with serialized arguments', async () => {
        mock = await startMockLLM({});
        mock.scriptToolCall({ name: 'get_weather', arguments: { city: 'Paris' } });
        const resp = await fetch(`${mock.baseURL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', input: [{ role: 'user', content: 'weather?' }], stream: true }),
        });
        const raw = await resp.text();
        expect(raw).toContain('"type":"function_call"');
        expect(raw).toContain('mock-call-1');
        expect(raw).toContain(JSON.stringify(JSON.stringify({ city: 'Paris' })).slice(1, -1));
    });

    test('scripted reasoning streams summary deltas before text', async () => {
        mock = await startMockLLM({});
        // Direct scripted-shape check through the generic route:
        mock.scriptCompletion(({ body }) => ({ reasoning: 'thinking', text: 'Answer2' }));
        const resp = await fetch(`${mock.baseURL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'mock-gpt-4o', input: [{ role: 'user', content: 'hi' }], stream: true }),
        });
        const raw = await resp.text();
        const firstReasoning = raw.indexOf('response.reasoning_summary_text.delta');
        const firstText = raw.indexOf('response.output_text.delta');
        expect(firstReasoning).toBeGreaterThan(-1);
        expect(firstReasoning).toBeLessThan(firstText);
        expect(raw).toContain('thinking');
    });
});
