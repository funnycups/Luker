// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    RESTORE_UPLOAD_ID_PATTERN,
    createRestoreUploadSession,
    readRestoreUploadMeta,
    writeRestoreUploadChunk,
    finalizeRestoreUpload,
    deleteRestoreUploadSession,
    sweepStaleRestoreUploadSessions,
    getRestoreUploadSessionDir,
    getRestoreUploadArchivePath,
} from '../src/restore-upload-sessions.js';

describe('restore upload sessions', () => {
    let dataRoot;

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-sessions-'));
    });

    afterEach(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    async function init(size, { handle = 'u', fileName = 'backup.zip' } = {}) {
        const { uploadId } = await createRestoreUploadSession({ dataRoot, handle, fileName, size });
        return uploadId;
    }

    function chunk(offset, offsetBytes, totalSize) {
        return writeRestoreUploadChunk({
            dataRoot,
            uploadId: current,
            offset,
            stream: Readable.from([offsetBytes]),
            declaredSize: totalSize,
        });
    }

    let current;

    test('create + read meta roundtrip', async () => {
        current = await init(10);
        expect(RESTORE_UPLOAD_ID_PATTERN.test(current)).toBe(true);
        const meta = await readRestoreUploadMeta(dataRoot, current);
        expect(meta).toMatchObject({ handle: 'u', fileName: 'backup.zip', size: 10 });
    });

    test('rejects malformed upload ids', () => {
        expect(getRestoreUploadSessionDir(dataRoot, '../evil')).toBeNull();
        expect(getRestoreUploadSessionDir(dataRoot, 'ABCDEF')).toBeNull();
        expect(getRestoreUploadArchivePath(dataRoot, 'nope')).toBeNull();
    });

    test('chunk write lands as <offset>.chunk without a .part leftover', async () => {
        current = await init(10);
        const result = await chunk(0, Buffer.from('abcd'), 10);
        expect(result.bytes).toBe(4);
        const chunksDir = path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks');
        expect(fs.existsSync(path.join(chunksDir, '0.chunk'))).toBe(true);
        expect(fs.existsSync(path.join(chunksDir, '0.part'))).toBe(false);
    });

    test('retrying the same offset overwrites idempotently', async () => {
        current = await init(10);
        await chunk(4, Buffer.from('AAAA'), 10);
        await chunk(4, Buffer.from('BB'), 10);
        const chunkPath = path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks', '4.chunk');
        expect(fs.readFileSync(chunkPath, 'utf8')).toBe('BB');
    });

    test('chunk overrun is rejected and leaves no chunk behind', async () => {
        current = await init(5);
        await expect(chunk(0, Buffer.from('123456'), 5)).rejects.toThrow('chunk_exceeds_declared_size');
        const chunksDir = path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks');
        expect(fs.readdirSync(chunksDir)).toEqual([]);
    });

    test('empty chunks are rejected', async () => {
        current = await init(5);
        await expect(chunk(0, Buffer.alloc(0), 5)).rejects.toThrow('empty_chunk');
    });

    test('finalize concatenates chunks in offset order and drops the chunks dir', async () => {
        current = await init(10);
        await chunk(6, Buffer.from('cccc'), 10);
        await chunk(0, Buffer.from('aaaaaa'), 10);
        const progress = [];
        const result = await finalizeRestoreUpload({
            dataRoot,
            uploadId: current,
            meta: { handle: 'u', fileName: 'backup.zip', size: 10 },
            onProgress: (event) => progress.push(event),
        });
        expect(result.size).toBe(10);
        const archivePath = getRestoreUploadArchivePath(dataRoot, current);
        expect(fs.readFileSync(archivePath, 'utf8')).toBe('aaaaaacccc');
        expect(fs.existsSync(path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks'))).toBe(false);
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toEqual({ copied: 10, total: 10 });
    });

    test('finalize is idempotent once the archive is complete', async () => {
        current = await init(4);
        await chunk(0, Buffer.from('abcd'), 4);
        await finalizeRestoreUpload({ dataRoot, uploadId: current, meta: { size: 4 } });
        // A stray chunk added after completion must not trigger a rebuild.
        const chunksDir = path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks');
        fs.mkdirSync(chunksDir, { recursive: true });
        fs.writeFileSync(path.join(chunksDir, '99.chunk'), 'junk');
        const again = await finalizeRestoreUpload({ dataRoot, uploadId: current, meta: { size: 4 } });
        expect(again.size).toBe(4);
        expect(fs.readFileSync(getRestoreUploadArchivePath(dataRoot, current), 'utf8')).toBe('abcd');
    });

    test('finalize assembles many chunks without leaking stream listeners', () => {
        // Each per-chunk `pipeline(read, counter, writeStream, { end: false })`
        // leaves its end-of-stream listeners attached to the shared write
        // stream (2 error + 2 close + 1 finish + 1 end), so past ~10 listeners
        // Node fires MaxListenersExceededWarning — and the count grows with
        // the number of chunks. A single-pipeline assembly must stay quiet.
        //
        // This has to run in a real child Node process: Jest's node
        // environment hands tests a copied `process` whose `warning` listener
        // never sees the warnings Node internals emit on the real process, so
        // an in-process capture would pass even while the warning fires.
        const moduleUrl = new URL('../src/restore-upload-sessions.js', import.meta.url).href;
        const runner = `
            import fs from 'node:fs';
            import os from 'node:os';
            import path from 'node:path';
            import { Readable } from 'node:stream';
            import {
                createRestoreUploadSession,
                writeRestoreUploadChunk,
                finalizeRestoreUpload,
                getRestoreUploadArchivePath,
            } from ${JSON.stringify(moduleUrl)};

            const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-leak-'));
            const chunkCount = 14;
            const part = Buffer.from('chunk-data-');
            const size = chunkCount * part.length;
            const { uploadId } = await createRestoreUploadSession({ dataRoot, handle: 'u', fileName: 'backup.zip', size });
            for (let i = 0; i < chunkCount; i += 1) {
                await writeRestoreUploadChunk({
                    dataRoot,
                    uploadId,
                    offset: i * part.length,
                    stream: Readable.from([part]),
                    declaredSize: size,
                });
            }

            const warnings = [];
            process.on('warning', (warning) => warnings.push(warning.name + ': ' + warning.message));
            const result = await finalizeRestoreUpload({ dataRoot, uploadId, meta: { size } });
            await new Promise((resolve) => setTimeout(resolve, 50));

            const expected = Buffer.concat(Array.from({ length: chunkCount }, () => part));
            const actual = fs.readFileSync(getRestoreUploadArchivePath(dataRoot, uploadId));
            fs.rmSync(dataRoot, { recursive: true, force: true });

            if (result.size !== size || !actual.equals(expected)) {
                console.error('ASSEMBLY_MISMATCH');
                process.exit(2);
            }
            if (warnings.length > 0) {
                console.error(warnings.join('\\n'));
                process.exit(3);
            }
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], { encoding: 'utf8' });
        // Pre-fix the runner exits 3 with the MaxListenersExceededWarning
        // text on stderr; the message names the leaked event(s).
        expect(result.stderr.trim()).toBe('');
        expect(result.status).toBe(0);
    });

    test('finalize rejects a gap in the offset chain', async () => {
        current = await init(10);
        await chunk(0, Buffer.from('aaaa'), 10);
        await chunk(6, Buffer.from('cccc'), 10);
        await expect(finalizeRestoreUpload({ dataRoot, uploadId: current, meta: { size: 10 } }))
            .rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE', missingOffset: 4 });
    });

    test('finalize rejects a total-size mismatch', async () => {
        current = await init(10);
        await chunk(0, Buffer.from('aaaaaa'), 10);
        await expect(finalizeRestoreUpload({ dataRoot, uploadId: current, meta: { size: 10 } }))
            .rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE', missingOffset: 6 });
    });

    test('finalize ignores .part files', async () => {
        current = await init(4);
        await chunk(0, Buffer.from('abcd'), 4);
        const chunksDir = path.join(getRestoreUploadSessionDir(dataRoot, current), 'chunks');
        fs.writeFileSync(path.join(chunksDir, '4.part'), 'ignored');
        const result = await finalizeRestoreUpload({ dataRoot, uploadId: current, meta: { size: 4 } });
        expect(result.size).toBe(4);
    });

    test('delete removes the session', async () => {
        current = await init(4);
        expect(await deleteRestoreUploadSession({ dataRoot, uploadId: current })).toBe(true);
        expect(await readRestoreUploadMeta(dataRoot, current)).toBeNull();
    });

    test('sweep removes stale sessions and keeps fresh ones', async () => {
        const stale = await init(4);
        const fresh = await init(4);
        const staleDir = getRestoreUploadSessionDir(dataRoot, stale);
        const old = new Date(Date.now() - 48 * 3600 * 1000);
        fs.utimesSync(staleDir, old, old);
        fs.utimesSync(path.join(staleDir, 'chunks'), old, old);
        const counts = await sweepStaleRestoreUploadSessions({ dataRoot, maxAgeMs: 24 * 3600 * 1000 });
        expect(counts.removed).toBe(1);
        expect(await readRestoreUploadMeta(dataRoot, stale)).toBeNull();
        expect(await readRestoreUploadMeta(dataRoot, fresh)).not.toBeNull();
    });
});
