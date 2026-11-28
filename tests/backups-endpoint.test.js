import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { ensureRun, trackScope } from './harness/jest-run.js';
import { currentScopeForResources } from './harness/storage-scope.js';
import { setConfigFilePath } from '../src/util.js';

let backupsRouter;

function makeApp(backupsDir) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: 'tester' },
            directories: { backups: backupsDir },
        };
        next();
    });
    app.use('/api/backups', backupsRouter);
    return app;
}

describe('backups endpoint /api/backups/chat/*', () => {
    beforeAll(async () => {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'scenario', label: 'backups-endpoint-config' }));
        const cfgDir = (await scope.directory('cfg')).path;
        const cfgPath = path.join(cfgDir, 'config.yaml');
        fs.writeFileSync(cfgPath, 'backups:\n  chat:\n    enabled: true\n', 'utf8');
        setConfigFilePath(cfgPath);
        ({ router: backupsRouter } = await import('../src/endpoints/backups.js'));
    });

    let caseDir;

    beforeEach(async () => {
        caseDir = (await currentScopeForResources().directory('case')).path;
    });

    test('returns an empty list when the backups directory does not exist', async () => {
        const missingDir = path.join(caseDir, 'does-not-exist');
        const app = makeApp(missingDir);
        const res = await request(app).post('/api/backups/chat/get').send({});
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    test('returns 500 with an error payload when the backups path is not a directory', async () => {
        const fileNotDir = path.join(caseDir, 'backups-file');
        fs.writeFileSync(fileNotDir, 'not a directory', 'utf8');
        const app = makeApp(fileNotDir);
        const res = await request(app).post('/api/backups/chat/get').send({});
        expect(res.status).toBe(500);
        expect(typeof res.body?.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
    });

    test('skips an unreadable backup file and still returns readable chat backups', async () => {
        const backupsDir = path.join(caseDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const goodFile = path.join(backupsDir, 'chat_alice_20260101-120000.jsonl');
        const unreadableFile = path.join(backupsDir, 'chat_bob_20260101-120001.jsonl');
        fs.writeFileSync(
            goodFile,
            '{"chat_metadata":{}}\n{"name":"Alice","is_user":false,"mes":"hello","send_date":"2026-01-01T12:00:00.000Z"}\n',
            'utf8',
        );
        fs.writeFileSync(unreadableFile, '{"chat_metadata":{}}\n', 'utf8');
        fs.chmodSync(unreadableFile, 0o000);
        try {
            const app = makeApp(backupsDir);
            const res = await request(app).post('/api/backups/chat/get').send({});
            expect(res.status).toBe(200);
            expect(res.body.map(item => item.file_name)).toEqual(['chat_alice_20260101-120000.jsonl']);
        } finally {
            fs.chmodSync(unreadableFile, 0o644);
        }
    });

    test('returns 400 when name is missing or non-string on delete and download', async () => {
        const backupsDir = path.join(caseDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const app = makeApp(backupsDir);

        expect((await request(app).post('/api/backups/chat/delete').send({})).status).toBe(400);
        expect((await request(app).post('/api/backups/chat/delete').send({ name: 123 })).status).toBe(400);
        expect((await request(app).post('/api/backups/chat/download').send({})).status).toBe(400);
        expect((await request(app).post('/api/backups/chat/download').send({ name: null })).status).toBe(400);
    });
});
