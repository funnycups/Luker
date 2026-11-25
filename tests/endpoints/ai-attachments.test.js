// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { describe, expect } from '@jest/globals';

import { testWithResources } from '../harness/jest.js';
import { router as imagesRouter, AI_ATTACHMENTS_DIRECTORY } from '../../src/endpoints/images.js';

function createTestApp(root) {
    const userImages = path.join(root, 'user', 'images');
    fs.mkdirSync(userImages, { recursive: true });
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: 'test-user' },
            directories: { root, userImages },
        };
        next();
    });
    app.use('/api/images', imagesRouter);
    return { app, userImages };
}

async function startServer(app) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

describe('POST /api/images internal AI attachments endpoints', () => {
    testWithResources('hides _ai_attachments from /folders and forbids listing it via /list', async (scope) => {
        const dir = await scope.directory('ai-att-list');
        const { app, userImages } = createTestApp(dir.path);
        const srv = await startServer(app);
        try {
            fs.mkdirSync(path.join(userImages, AI_ATTACHMENTS_DIRECTORY), { recursive: true });
            fs.mkdirSync(path.join(userImages, 'Alice'), { recursive: true });
            fs.writeFileSync(path.join(userImages, AI_ATTACHMENTS_DIRECTORY, 'secret.png'), 'png');
            fs.writeFileSync(path.join(userImages, 'Alice', 'visible.png'), 'png');

            const foldersRes = await fetch(`${srv.baseUrl}/api/images/folders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(foldersRes.status).toBe(200);
            const folders = await foldersRes.json();
            expect(folders).toContain('Alice');
            expect(folders).not.toContain(AI_ATTACHMENTS_DIRECTORY);

            const listRes = await fetch(`${srv.baseUrl}/api/images/list`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder: AI_ATTACHMENTS_DIRECTORY }),
            });
            expect(listRes.status).toBe(403);
        } finally {
            await srv.close();
        }
    });

    testWithResources('upload -> copy (lossless bytes) -> delete-batch lifecycle works and handles missing idempotently', async (scope) => {
        const dir = await scope.directory('ai-att-lifecycle');
        const { app } = createTestApp(dir.path);
        const srv = await startServer(app);
        try {
            const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);
            const upRes = await fetch(`${srv.baseUrl}/api/images/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: rawBytes.toString('base64'),
                    format: 'png',
                    ch_name: AI_ATTACHMENTS_DIRECTORY,
                }),
            });
            expect(upRes.status).toBe(200);
            const { path: uploadedPath } = await upRes.json();
            expect(uploadedPath).toMatch(/^\/user\/images\/_ai_attachments\/.+\.png$/);

            const copyRes = await fetch(`${srv.baseUrl}/api/images/copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paths: [uploadedPath, `/user/images/${AI_ATTACHMENTS_DIRECTORY}/nonexistent.png`],
                }),
            });
            expect(copyRes.status).toBe(200);
            const copied = await copyRes.json();
            const copiedPath = copied.copies[uploadedPath];
            expect(copiedPath).toMatch(/^\/user\/images\/_ai_attachments\/.+\.png$/);
            expect(copiedPath).not.toBe(uploadedPath);
            expect(copied.missing).toEqual([`/user/images/${AI_ATTACHMENTS_DIRECTORY}/nonexistent.png`]);

            const origDisk = path.join(dir.path, uploadedPath.replace(/^\/+/, ''));
            const copyDisk = path.join(dir.path, copiedPath.replace(/^\/+/, ''));
            expect(fs.readFileSync(copyDisk).equals(rawBytes)).toBe(true);

            // Deleting original leaves forked copy intact
            const delRes = await fetch(`${srv.baseUrl}/api/images/delete-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    paths: [uploadedPath, `/user/images/${AI_ATTACHMENTS_DIRECTORY}/already-gone.png`],
                }),
            });
            expect(delRes.status).toBe(200);
            const delBody = await delRes.json();
            expect(delBody.deleted).toEqual([uploadedPath]);
            expect(delBody.missing).toEqual([`/user/images/${AI_ATTACHMENTS_DIRECTORY}/already-gone.png`]);
            expect(delBody.failed).toEqual([]);
            expect(fs.existsSync(origDisk)).toBe(false);
            expect(fs.existsSync(copyDisk)).toBe(true);
        } finally {
            await srv.close();
        }
    });

    testWithResources('delete-batch refuses paths outside _ai_attachments and copy refuses escaping paths', async (scope) => {
        const dir = await scope.directory('ai-att-security');
        const { app, userImages } = createTestApp(dir.path);
        const srv = await startServer(app);
        try {
            const refDir = path.join(userImages, '_references');
            fs.mkdirSync(refDir, { recursive: true });
            const refFile = path.join(refDir, 'keep.png');
            fs.writeFileSync(refFile, 'keep');

            const delRef = await fetch(`${srv.baseUrl}/api/images/delete-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: ['/user/images/_references/keep.png'] }),
            });
            expect(delRef.status).toBe(400);
            expect(fs.existsSync(refFile)).toBe(true);

            const copyEscape = await fetch(`${srv.baseUrl}/api/images/copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths: ['/user/images/../../etc/passwd'] }),
            });
            expect(copyEscape.status).toBe(400);
        } finally {
            await srv.close();
        }
    });
});
