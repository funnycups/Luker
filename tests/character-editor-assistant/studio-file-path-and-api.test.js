// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, afterEach, jest } from '@jest/globals';
import {
    cardAppFileEditPath,
    parseCardAppFilePath,
} from '../../public/scripts/extensions/character-editor-assistant/studio/file-path.js';

const origLuker = globalThis.Luker;
const origFetch = globalThis.fetch;

afterEach(() => {
    globalThis.Luker = origLuker;
    globalThis.fetch = origFetch;
});

describe('CardApp Studio file-path codec', () => {
    test('roundtrips JSON-quoted bracket paths and rejects malformed bracket paths', () => {
        const encoded = cardAppFileEditPath('views/hero "quoted".js');
        expect(parseCardAppFilePath(encoded)).toBe('views/hero "quoted".js');
        expect(parseCardAppFilePath('plain/file.js')).toBe('plain/file.js');
        expect(() => parseCardAppFilePath('files[unquoted.js]')).toThrow();
        expect(() => parseCardAppFilePath('files[123]')).toThrow('Invalid CardApp file edit path');
    });
});

describe('CardApp Studio file-api HTTP status propagation', () => {
    test('attaches numeric HTTP status to errors from non-OK responses', async () => {
        globalThis.Luker = { getContext: () => ({ getRequestHeaders: () => ({}) }) };
        globalThis.fetch = jest.fn(async (url) => {
            if (String(url).includes('missing.js')) {
                return { ok: false, status: 404, text: async () => 'Not found' };
            }
            return { ok: false, status: 500, text: async () => 'Disk error' };
        });

        const { fetchFileContent } = await import('../../public/scripts/extensions/character-editor-assistant/studio/file-api.js');

        await expect(fetchFileContent('char1', 'missing.js')).rejects.toMatchObject({ status: 404 });
        await expect(fetchFileContent('char1', 'broken.js')).rejects.toMatchObject({ status: 500 });
    });
});
