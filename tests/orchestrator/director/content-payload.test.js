import { describe, expect, test } from '@jest/globals';
import { createContentPayloadCache } from '../../../public/scripts/extensions/orchestrator/director-content-payload.js';

describe('content-payload cache', () => {
    test('starts empty; populate and read; clear', () => {
        const cache = createContentPayloadCache();
        expect(cache.get()).toBeNull();
        const eventData = { generateData: { prompt: [{ role: 'system', content: 'x' }] } };
        cache.set({ eventData });
        expect(cache.get()).toEqual({ messages: [{ role: 'system', content: 'x' }] });
        cache.clear();
        expect(cache.get()).toBeNull();
    });

    test('set twice replaces the source (last writer wins)', () => {
        const cache = createContentPayloadCache();
        cache.set({ eventData: { generateData: { prompt: [{ role: 'system', content: 'first' }] } } });
        cache.set({ eventData: { generateData: { prompt: [{ role: 'system', content: 'second' }] } } });
        expect(cache.get().messages[0].content).toBe('second');
    });

    test('lazy resolution: a post-set replacement of generateData.prompt is visible to get()', () => {
        // Models the takeover protocol: this listener fires on
        // GENERATE_TAKEOVER_DISPATCH and pins the eventData reference, then
        // CHAT_COMPLETION_SETTINGS_READY fires from the same branch and a
        // hook (e.g. ST-Prompt-Template's @INJECT splicing) replaces
        // generate_data.prompt with a new array. Director agents reading
        // the cache later in the turn must see the new array.
        const cache = createContentPayloadCache();
        const eventData = { generateData: { prompt: [{ role: 'system', content: 'before' }] } };
        cache.set({ eventData });
        eventData.generateData.prompt = [{ role: 'system', content: 'after' }];
        expect(cache.get().messages[0].content).toBe('after');
    });

    test('lazy resolution: in-place message mutation is visible to get()', () => {
        // The common case: a chat-completion hook mutates message.content
        // in place without replacing the array reference. The cache must
        // see the mutated content.
        const cache = createContentPayloadCache();
        const msg = { role: 'system', content: 'before' };
        const eventData = { generateData: { prompt: [msg] } };
        cache.set({ eventData });
        msg.content = 'after';
        expect(cache.get().messages[0].content).toBe('after');
    });

    test('get returns null when generateData.prompt is missing or non-array', () => {
        const cache = createContentPayloadCache();
        cache.set({ eventData: { generateData: {} } });
        expect(cache.get()).toBeNull();
        cache.set({ eventData: { generateData: { prompt: null } } });
        expect(cache.get()).toBeNull();
        cache.set({ eventData: {} });
        expect(cache.get()).toBeNull();
    });
});
