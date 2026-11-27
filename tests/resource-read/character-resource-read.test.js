// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { loadCharacterResource } from '../../public/scripts/character/resource-read.js';
import { resetResourceReads } from '../../public/scripts/resource-read.js';
import { BULK_RESOURCE_READ_CONCURRENCY } from '../../public/scripts/util/concurrent-map.js';

describe('loadCharacterResource bounded concurrency and conflict abort', () => {
    const origFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = origFetch;
        resetResourceReads();
    });

    test('bounds concurrent character field GETs to BULK_RESOURCE_READ_CONCURRENCY', async () => {
        const fieldCount = BULK_RESOURCE_READ_CONCURRENCY + 20;
        const fields = Array.from({ length: fieldCount }, (_, index) => ({
            path: `/f${index}`,
            etag: `W/"e${index}"`,
        }));
        const rawLayout = ['{'];
        fields.forEach((field, index) => {
            if (index > 0) rawLayout.push(',');
            rawLayout.push(`"f${index}":`, { path: field.path });
        });
        rawLayout.push('}');

        let inFlightFields = 0;
        let maxInFlightFields = 0;

        globalThis.fetch = jest.fn(async (url) => {
            const urlText = String(url);
            if (urlText.startsWith('/api/bootstrap/metadata')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({ account: 'default-user' }),
                };
            }
            if (urlText.startsWith('/api/characters/fields?')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: 'W/"dir"' }),
                    text: async () => JSON.stringify({
                        rawLayout,
                        fields,
                        projection: { etag: 'W/"proj"' },
                    }),
                };
            }
            if (urlText.startsWith('/api/characters/field?')) {
                const parsed = new URL(urlText, 'http://127.0.0.1');
                const path = parsed.searchParams.get('path');
                const index = Number(path.slice(2));
                inFlightFields += 1;
                maxInFlightFields = Math.max(maxInFlightFields, inFlightFields);
                await new Promise((resolve) => setTimeout(resolve, 2));
                inFlightFields -= 1;
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: `W/"e${index}"` }),
                    text: async () => JSON.stringify(index),
                };
            }
            if (urlText.startsWith('/api/characters/projection?')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: 'W/"proj"' }),
                    text: async () => JSON.stringify({
                        patch: [],
                        keyOrder: ['f0', 'json_data'],
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL: ${urlText}`);
        });

        const character = await loadCharacterResource('sample.png');
        expect(character.f0).toBe(0);
        expect(character[`f${fieldCount - 1}`]).toBe(fieldCount - 1);
        expect(maxInFlightFields).toBeGreaterThan(1);
        expect(maxInFlightFields).toBeLessThanOrEqual(BULK_RESOURCE_READ_CONCURRENCY);
    });

    test('aborts in-flight sibling field fetches when one field returns a validator conflict', async () => {
        const fields = [
            { path: '/bad', etag: 'W/"expected"' },
            { path: '/slow', etag: 'W/"slow"' },
        ];
        const rawLayout = ['{"bad":', { path: '/bad' }, ',"slow":', { path: '/slow' }, '}'];
        let slowAborted = false;

        globalThis.fetch = jest.fn(async (url, init = {}) => {
            const urlText = String(url);
            if (urlText.startsWith('/api/bootstrap/metadata')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({ account: 'default-user' }),
                };
            }
            if (urlText.startsWith('/api/characters/fields?')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: 'W/"dir"' }),
                    text: async () => JSON.stringify({
                        rawLayout,
                        fields,
                        projection: { etag: 'W/"proj"' },
                    }),
                };
            }
            if (urlText.startsWith('/api/characters/field?')) {
                const parsed = new URL(urlText, 'http://127.0.0.1');
                const path = parsed.searchParams.get('path');
                if (path === '/bad') {
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers({ 'content-type': 'application/json', etag: 'W/"stale"' }),
                        text: async () => '"mismatch"',
                    };
                }
                return new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        slowAborted = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                });
            }
            throw new Error(`Unexpected fetch URL: ${urlText}`);
        });

        await expect(loadCharacterResource('sample.png')).rejects.toMatchObject({
            code: 'read_conflict',
            path: '/bad',
            expected: 'W/"expected"',
            actual: 'W/"stale"',
        });
        expect(slowAborted).toBe(true);
    });
});
