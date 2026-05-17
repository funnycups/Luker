import { describe, expect, test } from '@jest/globals';
import { createContentPayloadCache } from '../../../public/scripts/extensions/orchestrator/director-content-payload.js';

describe('content-payload cache', () => {
    test('starts empty; populate and read; clear', () => {
        const cache = createContentPayloadCache();
        expect(cache.get()).toBeNull();
        cache.set({ messages: [{ role: 'system', content: 'x' }] });
        expect(cache.get()).toEqual({ messages: [{ role: 'system', content: 'x' }] });
        cache.clear();
        expect(cache.get()).toBeNull();
    });

    test('set twice replaces the value (last writer wins)', () => {
        const cache = createContentPayloadCache();
        cache.set({ messages: [{ role: 'system', content: 'first' }] });
        cache.set({ messages: [{ role: 'system', content: 'second' }] });
        expect(cache.get().messages[0].content).toBe('second');
    });
});
