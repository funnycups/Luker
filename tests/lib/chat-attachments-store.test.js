// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';

import {
    isAiAttachmentPath,
    uploadChatAttachments,
    copyChatAttachments,
    deleteChatAttachments,
    rewriteAttachmentsWithCopyMap,
} from '../../public/scripts/lib/chat-attachments-store.js';

describe('lib/chat-attachments-store', () => {
    test('isAiAttachmentPath strictly confines to /user/images/_ai_attachments/', () => {
        expect(isAiAttachmentPath('/user/images/_ai_attachments/a.png')).toBe(true);
        expect(isAiAttachmentPath('/user/images/_references/a.png')).toBe(false);
        expect(isAiAttachmentPath('/user/images/_ai_attachments/../_references/a.png')).toBe(false);
        expect(isAiAttachmentPath('https://example.com/a.png')).toBe(false);
    });

    test('uploadChatAttachments rolls back already uploaded files when a later file fails', async () => {
        const calls = [];
        let uploadCount = 0;
        const fetchFn = jest.fn(async (url, init) => {
            const body = JSON.parse(init.body);
            calls.push({ url, body });
            if (url === '/api/images/upload') {
                uploadCount += 1;
                if (uploadCount === 1) {
                    return { ok: true, status: 200, json: async () => ({ path: '/user/images/_ai_attachments/ok1.png' }) };
                }
                return { ok: false, status: 500, statusText: 'Boom', text: async () => 'disk full' };
            }
            if (url === '/api/images/delete-batch') {
                return { ok: true, status: 200, json: async () => ({ deleted: body.paths, missing: [], failed: [] }) };
            }
            throw new Error(`Unexpected url ${url}`);
        });

        const f1 = new File([Uint8Array.from([1, 2, 3])], 'one.png', { type: 'image/png' });
        const f2 = new File([Uint8Array.from([4, 5, 6])], 'two.png', { type: 'image/png' });

        await expect(uploadChatAttachments({ getRequestHeaders: () => ({}) }, [f1, f2], { fetchFn }))
            .rejects.toThrow(/disk full/);

        expect(calls.some(c => c.url === '/api/images/delete-batch' && c.body.paths[0] === '/user/images/_ai_attachments/ok1.png')).toBe(true);
    });

    test('copyChatAttachments and deleteChatAttachments ignore non-attachment paths and rewrite copy maps', async () => {
        const receivedRequests = [];
        const fetchFn = jest.fn(async (url, init) => {
            const body = JSON.parse(init.body);
            receivedRequests.push({ url, paths: body.paths });
            if (url === '/api/images/copy') {
                return { ok: true, status: 200, json: async () => ({ copies: { '/user/images/_ai_attachments/a.png': '/user/images/_ai_attachments/a_copy.png' }, missing: [] }) };
            }
            if (url === '/api/images/delete-batch') {
                return { ok: true, status: 200, json: async () => ({ deleted: body.paths, missing: [], failed: [] }) };
            }
            throw new Error(`Unexpected url ${url}`);
        });

        const map = await copyChatAttachments(null, [
            '/user/images/_ai_attachments/a.png',
            '/user/images/_references/other.png',
        ], { fetchFn });
        expect(map.get('/user/images/_ai_attachments/a.png')).toBe('/user/images/_ai_attachments/a_copy.png');

        const rewritten = rewriteAttachmentsWithCopyMap([
            { path: '/user/images/_ai_attachments/a.png', name: 'a.png' },
            { path: '/user/images/_references/other.png', name: 'other.png' },
        ], map);
        expect(rewritten).toEqual([
            { path: '/user/images/_ai_attachments/a_copy.png', name: 'a.png' },
            { path: '/user/images/_references/other.png', name: 'other.png' },
        ]);

        const delRes = await deleteChatAttachments(null, [
            '/user/images/_ai_attachments/a_copy.png',
            '/user/images/_references/other.png',
        ], { fetchFn });
        expect(delRes.deleted).toEqual(['/user/images/_ai_attachments/a_copy.png']);
        expect(receivedRequests).toEqual([
            { url: '/api/images/copy', paths: ['/user/images/_ai_attachments/a.png'] },
            { url: '/api/images/delete-batch', paths: ['/user/images/_ai_attachments/a_copy.png'] },
        ]);
    });
});
