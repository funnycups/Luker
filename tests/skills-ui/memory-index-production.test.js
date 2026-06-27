import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createSkillsRouter } from '../../src/endpoints/skills.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Production memoryIndex wiring.
 *
 * createSkillsRouter takes a per-request `getMemoryIndex(req)` resolver so
 * each user's index is isolated:
 *   - alice writes → only alice's index.invalidate() runs
 *   - bob's index is untouched
 *   - reads never invalidate either user's index
 *
 * tests/skills/api-rest.test.js is the only other in-tree caller using the
 * shared-instance shortcut.
 */
describe('Production memoryIndex wiring', () => {
    let app, tmpRoot1, tmpRoot2, repo1, repo2, idx1, idx2;

    beforeEach(async () => {
        tmpRoot1 = await fs.mkdtemp(join(tmpdir(), 'skill-user1-'));
        tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-user2-'));
        repo1 = createSkillRepository(tmpRoot1);
        repo2 = createSkillRepository(tmpRoot2);
        idx1 = { invalidate: jest.fn(async () => {}) };
        idx2 = { invalidate: jest.fn(async () => {}) };

        app = express();
        app.use(express.json({ limit: '20mb' }));
        // Mimic per-request user resolution: select repo + index from a header
        // that stands in for `req.user.profile.handle` in the real server.
        function userResources(req) {
            const userHandle = req.header('X-Test-User');
            return userHandle === 'alice'
                ? { repository: repo1, memoryIndex: idx1 }
                : { repository: repo2, memoryIndex: idx2 };
        }
        app.use('/api/skills', createSkillsRouter({
            getRepository: (req) => userResources(req).repository,
            getMemoryIndex: (req) => userResources(req).memoryIndex,
        }));
    });

    afterEach(async () => {
        await fs.rm(tmpRoot1, { recursive: true, force: true });
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('write by user alice invalidates ONLY alice index', async () => {
        const res = await request(app)
            .post('/api/skills/global')
            .set('X-Test-User', 'alice')
            .send({
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf8',
                        content: '---\nname: per-user-x\ndescription: y\n---\n',
                    }],
                },
            });
        expect(res.status).toBe(200);
        expect(idx1.invalidate).toHaveBeenCalledTimes(1);
        expect(idx2.invalidate).not.toHaveBeenCalled();
    });

    test('read by either user does not invalidate either index', async () => {
        const r1 = await request(app).get('/api/skills?scope=global').set('X-Test-User', 'alice');
        const r2 = await request(app).get('/api/skills?scope=global').set('X-Test-User', 'bob');
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(idx1.invalidate).not.toHaveBeenCalled();
        expect(idx2.invalidate).not.toHaveBeenCalled();
    });

    test('null index from getMemoryIndex is treated as no-op (no throw)', async () => {
        const appNull = express();
        appNull.use(express.json({ limit: '20mb' }));
        appNull.use('/api/skills', createSkillsRouter({
            getRepository: () => repo1,
            getMemoryIndex: () => null,
        }));
        const res = await request(appNull)
            .post('/api/skills/global')
            .send({
                payload: {
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf8',
                        content: '---\nname: null-idx-ok\ndescription: y\n---\n',
                    }],
                },
            });
        expect(res.status).toBe(200);
    });
});
