// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';

import {
    normalizeImageAttachments,
    extractTextContent,
    buildAttachmentSummaryLabel,
    collectAttachmentPathsFromRecords,
    loadManagedImageDataUrl,
    hydrateMessagesForLlm,
} from '../../public/scripts/lib/multimodal-messages.js';
import { applyMacroSubstitution } from '../../public/scripts/generate-task.js';

describe('lib/multimodal-messages', () => {
    test('normalizes, deduplicates, and extracts attachment paths cleanly', () => {
        const list = normalizeImageAttachments([
            '  /user/images/_ai_attachments/a.png  ',
            { path: '/user/images/_ai_attachments/a.png', name: 'first.png', mime: 'image/png' },
            { path: '/user/images/_ai_attachments/b.webp', name: 'second.webp', mime: 'image/webp' },
            { path: '   ', name: 'empty' },
            null,
        ]);
        expect(list).toEqual([
            { path: '/user/images/_ai_attachments/a.png', name: 'first.png', mime: 'image/png' },
            { path: '/user/images/_ai_attachments/b.webp', name: 'second.webp', mime: 'image/webp' },
        ]);

        expect(collectAttachmentPathsFromRecords([
            { role: 'user', attachments: list },
            { role: 'assistant', text: 'ok' },
            { role: 'user', attachments: [{ path: '/user/images/_ai_attachments/b.webp' }, { path: '/user/images/_references/c.png' }] },
        ], { filter: p => p.includes('/_ai_attachments/') })).toEqual([
            '/user/images/_ai_attachments/a.png',
            '/user/images/_ai_attachments/b.webp',
        ]);
    });

    test('extractTextContent and buildAttachmentSummaryLabel handle string and array content', () => {
        expect(extractTextContent('hello')).toBe('hello');
        expect(extractTextContent([
            { type: 'text', text: 'line 1' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'text', text: 'line 2' },
        ])).toBe('line 1\nline 2');

        expect(buildAttachmentSummaryLabel('  hello  ', [{ path: '/user/images/_ai_attachments/a.png' }], '[图片]')).toBe('hello');
        expect(buildAttachmentSummaryLabel('', [{ path: '/user/images/_ai_attachments/a.png' }], '[图片]')).toBe('[图片]');
        expect(buildAttachmentSummaryLabel('', [
            { path: '/user/images/_ai_attachments/a.png' },
            { path: '/user/images/_ai_attachments/b.png' },
        ], '[图片]')).toBe('[图片] (2)');
    });

    test('loadManagedImageDataUrl preserves exact raw bytes losslessly and caches per map', async () => {
        const rawBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30, 40]);
        const fetchFn = jest.fn(async () => ({
            ok: true,
            status: 200,
            blob: async () => new Blob([rawBytes], { type: 'image/png' }),
        }));
        const cache = new Map();
        const url1 = await loadManagedImageDataUrl('/user/images/_ai_attachments/x.png', {
            context: { getRequestHeaders: () => ({ 'X-Test': '1' }) },
            cache,
            fetchFn,
        });
        const url2 = await loadManagedImageDataUrl('/user/images/_ai_attachments/x.png', {
            context: { getRequestHeaders: () => ({ 'X-Test': '1' }) },
            cache,
            fetchFn,
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(url1).toBe(url2);
        const expectedB64 = Buffer.from(rawBytes).toString('base64');
        expect(url1).toBe(`data:image/png;base64,${expectedB64}`);
    });

    test('hydrateMessagesForLlm expands all historical turns without mutating source messages and supports path annotations', async () => {
        const messages = [
            { role: 'system', content: 'sys' },
            {
                role: 'user',
                content: 'turn 1',
                attachments: [{ path: '/user/images/_ai_attachments/first.png', name: 'first.png' }],
            },
            { role: 'assistant', content: 'reply 1' },
            {
                role: 'user',
                content: '',
                attachments: [{ path: '/user/images/_ai_attachments/second.webp' }],
            },
        ];
        const loader = jest.fn(async (p) => `data:image/png;base64,${Buffer.from(p).toString('base64')}`);

        const hydrated = await hydrateMessagesForLlm(messages, {
            loadDataUrl: loader,
            includePathAnnotations: true,
        });

        // Source messages remain lightweight and unmodified
        expect(messages[1].content).toBe('turn 1');
        expect(messages[1].attachments).toHaveLength(1);
        expect(messages[3].content).toBe('');

        // Hydrated messages carry image_url for BOTH historical turn 1 and current turn 2
        expect(hydrated[1]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'turn 1\n\n[Attached image #1: /user/images/_ai_attachments/first.png]' },
                { type: 'image_url', image_url: { url: loader.mock.results[0].value ? await loader.mock.results[0].value : '' } },
            ],
        });
        expect('attachments' in hydrated[1]).toBe(false);
        expect(hydrated[3].content).toEqual([
            { type: 'text', text: '[Attached image #1: /user/images/_ai_attachments/second.webp]' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('/user/images/_ai_attachments/second.webp').toString('base64')}` } },
        ]);
    });

    test('applyMacroSubstitution substitutes text parts inside multimodal content arrays while leaving image_url intact', () => {
        const input = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Hello {{user}}' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,{{user}}' } },
                ],
            },
        ];
        const out = applyMacroSubstitution(input, text => text.replaceAll('{{user}}', 'Alice'));
        expect(out[0].content).toEqual([
            { type: 'text', text: 'Hello Alice' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,{{user}}' } },
        ]);
    });
});
