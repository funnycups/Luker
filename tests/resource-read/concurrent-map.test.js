// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import {
    BACKGROUND_PRELOAD_CONCURRENCY,
    BULK_RESOURCE_READ_CONCURRENCY,
    mapWithConcurrency,
} from '../../public/scripts/util/concurrent-map.js';

describe('mapWithConcurrency', () => {
    test('preserves input order while enforcing worker ceiling', async () => {
        const items = Array.from({ length: 12 }, (_, i) => i);
        let active = 0;
        let peak = 0;

        const results = await mapWithConcurrency(items, 3, async (item) => {
            active += 1;
            peak = Math.max(peak, active);
            try {
                await new Promise(resolve => setTimeout(resolve, (12 - item) * 2));
                return item * 10;
            } finally {
                active -= 1;
            }
        });

        expect(peak).toBe(3);
        expect(results).toEqual(items.map(i => i * 10));
        expect(BULK_RESOURCE_READ_CONCURRENCY).toBe(64);
        expect(BACKGROUND_PRELOAD_CONCURRENCY).toBeLessThan(6);
    });

    test('aborts siblings and skips queued items on first error when abortOnError is true', async () => {
        const started = [];
        const aborted = [];
        let releaseFirst;
        const gate = new Promise(resolve => { releaseFirst = resolve; });

        const promise = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item, _idx, signal) => {
            started.push(item);
            if (item === 1) {
                throw new Error('boom-1');
            }
            return await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    aborted.push(item);
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
                gate.then(() => resolve(item));
            });
        });

        await expect(promise).rejects.toThrow('boom-1');
        releaseFirst();
        expect(started).toEqual([0, 1]);
        expect(aborted).toEqual([0]);
    });

    test('rejects immediately and stops queued items when external signal aborts', async () => {
        const controller = new AbortController();
        const started = [];
        let firstEntered;
        const entered = new Promise(resolve => { firstEntered = resolve; });

        const pending = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item, _idx, signal) => {
            started.push(item);
            firstEntered();
            return await new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        }, { signal: controller.signal });

        await entered;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(started.length).toBeLessThanOrEqual(2);
    });

    test('rejects pre-aborted signal even on empty input', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(mapWithConcurrency([], 2, async () => 1, { signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
});
