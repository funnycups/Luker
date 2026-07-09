import { describe, test, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
    createGenerationJob,
    getTaskByRequestId,
} from '../../src/endpoints/backends/luker-generation.js';
import { generationControlRouter } from '../../src/endpoints/generation-control.js';

/**
 * Build a minimal Express app that mounts the generation-control router
 * with a stub auth middleware to inject `req.user.profile.handle`.
 */
function makeApp(handle) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle }, directories: {} };
        next();
    });
    app.use('/api/generation', generationControlRouter);
    return app;
}

function makeRequestForOwner(handle) {
    return { user: { profile: { handle }, directories: {} }, body: {} };
}

describe('POST /api/generation/:request_id/abort', () => {
    beforeEach(() => {
        // No global store reset — each test uses unique job_ids.
    });

    test('happy path: owner aborts existing job, returns 200 and sets status=failed', async () => {
        const req = makeRequestForOwner('alice');
        const job = createGenerationJob(req, {
            job_id: 'abort-happy-1',
            persist_target: { avatar_url: 'alice.png', file_name: 'chat.jsonl' },
        });
        expect(job).not.toBeNull();
        expect(job.status).toBe('running');

        const app = makeApp('alice');
        const res = await request(app).post('/api/generation/abort-happy-1/abort').send();

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ aborted: true });
        expect(job.status).toBe('failed');
        expect(job.error).toBe('aborted by client');
    });

    test('non-owner receives 403', async () => {
        const req = makeRequestForOwner('alice');
        createGenerationJob(req, { job_id: 'abort-owner-1', persist_target: null });

        const app = makeApp('mallory');
        const res = await request(app).post('/api/generation/abort-owner-1/abort').send();

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden' });
        // Owner still sees the job as running.
        const job = getTaskByRequestId('abort-owner-1', 'alice');
        expect(job.status).toBe('running');
    });

    test('unknown request_id returns 404', async () => {
        const app = makeApp('alice');
        const res = await request(app).post('/api/generation/does-not-exist-xyz/abort').send();
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'not_found' });
    });

    test('calls job.abortController.abort() when present', async () => {
        const req = makeRequestForOwner('alice');
        const job = createGenerationJob(req, { job_id: 'abort-ac-1', persist_target: null });
        const controller = new AbortController();
        job.abortController = controller;
        let abortReason = null;
        controller.signal.addEventListener('abort', () => {
            abortReason = controller.signal.reason;
        });

        const app = makeApp('alice');
        const res = await request(app).post('/api/generation/abort-ac-1/abort').send();

        expect(res.status).toBe(200);
        expect(controller.signal.aborted).toBe(true);
        expect(abortReason).toBe('client abort');
    });
});

describe('GET /api/generation/active', () => {
    test('returns the caller\'s active jobs for the given chat', async () => {
        const alice = makeRequestForOwner('alice');
        const job = createGenerationJob(alice, {
            job_id: 'active-list-1',
            persist_target: { avatar_url: 'alice.png', file_name: 'chatA.jsonl' },
        });
        expect(job.status).toBe('running');

        const app = makeApp('alice');
        const res = await request(app)
            .get('/api/generation/active')
            .query({ avatar_url: 'alice.png', file_name: 'chatA.jsonl' });

        expect(res.status).toBe(200);
        const ids = res.body.jobs.map(j => j.id);
        expect(ids).toContain('active-list-1');
    });

    test('returns empty list when nothing matches the chat key', async () => {
        const alice = makeRequestForOwner('alice');
        createGenerationJob(alice, {
            job_id: 'active-empty-src',
            persist_target: { avatar_url: 'alice.png', file_name: 'chatA.jsonl' },
        });

        const app = makeApp('alice');
        const res = await request(app)
            .get('/api/generation/active')
            .query({ avatar_url: 'alice.png', file_name: 'other-chat.jsonl' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ jobs: [] });
    });
});
