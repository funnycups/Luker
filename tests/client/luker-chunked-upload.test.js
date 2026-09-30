// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, jest, test } from '@jest/globals';

import {
    RestoreUploadError,
    uploadFileInChunks,
} from '../../public/scripts/luker-chunked-upload.js';

function makeFile(size) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    return new File([bytes], 'backup.zip', { type: 'application/zip' });
}

describe('uploadFileInChunks', () => {
    test('uploads sequential chunks and reports monotonic progress', async () => {
        const file = makeFile(20);
        const calls = [];
        const progress = [];
        const result = await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            createSession: async () => 'a'.repeat(32),
            sendChunk: async ({ offset, blob }) => {
                calls.push({ offset, length: blob.size });
                return { ok: true, status: 200 };
            },
            onProgress: (event) => progress.push(event.loaded),
        });
        expect(calls).toEqual([
            { offset: 0, length: 8 },
            { offset: 8, length: 8 },
            { offset: 16, length: 4 },
        ]);
        expect(result).toEqual({ uploadId: 'a'.repeat(32), uploadedBytes: 20 });
        expect(progress.at(-1)).toBe(20);
        expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    });

    test('retries a failed chunk with backoff then succeeds', async () => {
        const file = makeFile(8);
        let attempts = 0;
        const retries = [];
        const result = await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            retryDelaysMs: [0, 0, 0],
            createSession: async () => 'a'.repeat(32),
            sendChunk: async () => {
                attempts += 1;
                if (attempts < 3) throw new Error('boom');
                return { ok: true, status: 200 };
            },
            onRetry: (info) => retries.push(info),
        });
        expect(attempts).toBe(3);
        expect(retries.length).toBe(2);
        expect(result.uploadedBytes).toBe(8);
    });

    test('halves the chunk on 413 down to the floor', async () => {
        const file = makeFile(8);
        const calls = [];
        await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            minChunkSize: 2,
            retryDelaysMs: [0, 0, 0],
            createSession: async () => 'a'.repeat(32),
            sendChunk: async ({ offset, blob }) => {
                calls.push({ offset, length: blob.size });
                return blob.size > 2
                    ? { ok: false, status: 413 }
                    : { ok: true, status: 200 };
            },
        });
        expect(calls).toEqual([
            { offset: 0, length: 8 },
            { offset: 0, length: 4 },
            { offset: 0, length: 2 },
            { offset: 2, length: 2 },
            { offset: 4, length: 2 },
            { offset: 6, length: 2 },
        ]);
    });

    test('throws when 413 persists at the minimum chunk size', async () => {
        const file = makeFile(4);
        await expect(uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 4,
            minChunkSize: 2,
            retryDelaysMs: [0, 0, 0],
            createSession: async () => 'a'.repeat(32),
            sendChunk: async () => ({ ok: false, status: 413 }),
        })).rejects.toBeInstanceOf(RestoreUploadError);
    });

    test('exhausts retries and reports the acknowledged offset', async () => {
        const file = makeFile(16);
        let attempts = 0;
        const error = await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            retryDelaysMs: [0, 0, 0],
            createSession: async () => 'a'.repeat(32),
            sendChunk: async ({ offset }) => {
                if (offset === 0) {
                    attempts += 1;
                    return { ok: true, status: 200 };
                }
                throw new Error('boom');
            },
        }).catch((err) => err);
        expect(error).toBeInstanceOf(RestoreUploadError);
        expect(error.uploadedBytes).toBe(8);
        expect(attempts).toBe(1);
    });

    test('resume skips the acknowledged bytes without creating a session', async () => {
        const file = makeFile(12);
        const createSession = jest.fn(async () => 'a'.repeat(32));
        const calls = [];
        const result = await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            createSession,
            resume: { uploadId: 'b'.repeat(32), uploadedBytes: 8 },
            sendChunk: async ({ offset, blob }) => {
                calls.push({ offset, length: blob.size });
                return { ok: true, status: 200 };
            },
        });
        expect(createSession).not.toHaveBeenCalled();
        expect(calls).toEqual([{ offset: 8, length: 4 }]);
        expect(result).toEqual({ uploadId: 'b'.repeat(32), uploadedBytes: 12 });
    });

    test('restarts the session once when the server lost it (404)', async () => {
        const file = makeFile(4);
        const ids = ['a'.repeat(32), 'b'.repeat(32)];
        const calls = [];
        const result = await uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 4,
            createSession: async () => ids.shift(),
            sendChunk: async ({ url, offset, blob }) => {
                calls.push({ url, offset, length: blob.size });
                return url.includes(`/${'a'.repeat(32)}/`)
                    ? { ok: false, status: 404 }
                    : { ok: true, status: 200 };
            },
        });
        expect(calls.length).toBe(2);
        expect(calls[calls.length - 1].offset).toBe(0);
        expect(result.uploadId).toBe('b'.repeat(32));
    });

    test('propagates abort without retrying', async () => {
        const file = makeFile(8);
        let calls = 0;
        const controller = new AbortController();
        controller.abort();
        await expect(uploadFileInChunks(file, {
            handle: 'u',
            chunkSize: 8,
            signal: controller.signal,
            createSession: async () => 'a'.repeat(32),
            sendChunk: async () => { calls += 1; return { ok: true, status: 200 }; },
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toBe(0);
    });
});
