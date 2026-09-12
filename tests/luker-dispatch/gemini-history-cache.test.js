// SPDX-License-Identifier: AGPL-3.0-or-later
/* eslint-disable playwright/no-standalone-expect, playwright/no-duplicate-hooks -- Jest test.each and timer hooks are not Playwright tests. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { GeminiHistoryCache } from '../../src/luker-dispatch/gemini-history-cache.js';

const options = { scope: 'alice/credential-a', session: 'chat-a' };
function conversation(turns = 8) {
    const messages = [
        { role: 'system', content: 'Stable character and generation rules.' },
        { role: 'assistant', content: '<story_echo_summary>Archived history.</story_echo_summary>' },
    ];
    for (let i = 0; i < turns; i++) {
        messages.push({ role: 'user', content: `Question ${i}` });
        messages.push({ role: 'assistant', content: `Answer ${i}` });
    }
    messages.push({ role: 'user', content: 'Current input' });
    return { model: 'google/gemini-test', messages };
}
function marked(request) {
    return request.messages.flatMap((message, i) => message.content?.some?.(part => part.cache_control) ? [i] : []);
}
function withoutMarker(request) {
    const copy = structuredClone(request);
    for (const message of copy.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) delete part.cache_control;
        if (message.content.length === 1 && message.content[0].type === 'text') message.content = message.content[0].text;
    }
    return copy;
}

describe('Gemini explicit history caching', () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));

    afterEach(() => jest.useRealTimers());

    test('covers summaries and old history, preserving roles/text and two recent turns', () => {
        const cache = new GeminiHistoryCache();
        const original = conversation();
        const request = structuredClone(original);
        expect(cache.apply(request, options)).toEqual({ reason: 'created', messageIndex: 13 });
        expect(marked(request)).toEqual([13]);
        expect(withoutMarker(request)).toEqual(original);
    });

    test('appends and recent depth-based regex changes reuse the same prefix, then advance after five minutes', () => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), options);
        const next = conversation(9);
        next.messages[15].content += ' Depth-based removal of old details.';
        next.messages[17].content += '<details>New recent metadata</details>';
        expect(cache.apply(next, options)).toEqual({ reason: 'reused', messageIndex: 13 });
        expect(marked(next)).toEqual([13]);
        jest.advanceTimersByTime(5 * 60 * 1000);
        expect(cache.apply(conversation(10), options)).toEqual({ reason: 'refreshed', messageIndex: 17 });
    });

    test.each(['system', 'summary', 'old-message', 'tools', 'late-system', 'signature'])('%s changes invalidate the old anchor', change => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), options);
        const next = conversation(9);
        if (change === 'system') next.messages[0].content += ' Updated rule.';
        if (change === 'summary') next.messages[1].content += ' Revised summary.';
        if (change === 'old-message') next.messages[4].content += ' Edited history.';
        if (change === 'tools') next.tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        if (change === 'late-system') next.messages.push({ role: 'system', content: 'New system injection.' });
        if (change === 'signature') next.messages[3].reasoning_details = [{ type: 'reasoning.encrypted', data: 'new-signature' }];
        expect(cache.apply(next, options)).toEqual({ reason: 'refreshed', messageIndex: 15 });
    });

    test('summary compression, branch rollback and a larger uncached tail never retain an out-of-range anchor', () => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), options);
        const compressed = conversation(4);
        compressed.messages[1].content = '<story_echo_summary>More compact history.</story_echo_summary>';
        expect(cache.apply(compressed, options)).toEqual({ reason: 'refreshed', messageIndex: 5 });
        expect(cache.apply(conversation(4), { ...options, keepRecentTurns: 3 })).toEqual({ reason: 'refreshed', messageIndex: 3 });
    });

    test.each([{ scope: 'bob/credential-a' }, { scope: 'alice/credential-b' }, { session: 'chat-b' }])('isolates anchor ownership: %j', override => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), options);
        expect(cache.apply(conversation(9), { ...options, ...override }).reason).toBe('created');
        expect(cache.apply(conversation(9), options).messageIndex).toBe(13);
    });

    test('keeps independent conversations isolated without a client session ID', () => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), { scope: options.scope });
        const next = conversation(9);
        next.messages[2].content = 'Different opening';
        expect(cache.apply(next, { scope: options.scope }).reason).toBe('created');
    });

    test('preserves explicit caller breakpoints rather than introducing a later competing one', () => {
        const cache = new GeminiHistoryCache();
        const request = conversation();
        request.messages[2].content = [{ type: 'text', text: 'Manually cached', cache_control: { type: 'ephemeral' } }];
        const original = structuredClone(request);
        expect(cache.apply(request, options).reason).toBe('external-breakpoint');
        expect(request).toEqual(original);
    });

    test('does not split pending tool calls and preserves multimodal parts', () => {
        const cache = new GeminiHistoryCache();
        const request = conversation(4);
        request.messages.splice(6, 0,
            { role: 'assistant', content: '', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-a', content: 'Tool result' },
            { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }, { type: 'text', text: 'Tool conclusion' }] },
        );
        const original = structuredClone(request);
        expect(cache.apply(request, options).messageIndex).toBe(8);
        delete request.messages[8].content[1].cache_control;
        expect(request).toEqual(original);
        const pending = structuredClone(original);
        pending.messages.splice(7, 1); // Missing result: all following messages stay outside the cache.
        expect(cache.apply(pending, options).messageIndex).toBe(5);
    });

    test('short requests have no history boundary and invalid tail settings fail fast', () => {
        const cache = new GeminiHistoryCache();
        expect(cache.apply(conversation(0), options).reason).toBe('no-history');
        for (const keepRecentTurns of [0, -1, 1.5, NaN, '2']) {
            expect(() => cache.apply(conversation(), { ...options, keepRecentTurns })).toThrow('positive integer');
        }
    });

    test('server restart loses only the optimization; it never needs a persisted cache object', () => {
        const cache = new GeminiHistoryCache();
        cache.apply(conversation(), options);
        expect(new GeminiHistoryCache().apply(conversation(9), options)).toEqual({ reason: 'created', messageIndex: 15 });
    });
});
