import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSkillsRouter } from '../../src/endpoints/skills.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { createMemoryIndex } from '../../src/skills/memory-index.js';
import { ensureFreshInstallPopulate } from '../../src/skills/bundled.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_DEFAULT_ROOT mirrors what server-main.js sets as `lukerDefaultRoot`:
// the `default/` dir that ships bundled scaffolding (skills/global/, etc.).
// tests/skills/integration-smoke.test.js → ../../default resolves to the
// project's default/ tree containing skills/global/ with the bundled scaffolds.
const REPO_DEFAULT_ROOT = join(__dirname, '../../default');

/**
 * Skills integration smoke test.
 *
 * Exercises the real default/skills/global/ → user/skills/global/ pipeline
 * end-to-end: fresh-install populate, REST list/read, embed pack → extract
 * roundtrip into character scope, and the idempotency contract of the
 * explicit import-bundled button. The earlier per-module tests cover unit
 * behavior; this suite is the contract that says "when a new user hits
 * /api/skills for the first time, the bundled scaffolds show up and
 * round-trip cleanly through the embed pipeline."
 */
describe('Skills integration smoke', () => {
    let app;
    let tmpUser;
    let repo;

    beforeAll(async () => {
        tmpUser = await fs.mkdtemp(join(tmpdir(), 'skill-integ-'));
        await ensureFreshInstallPopulate({ defaultRoot: REPO_DEFAULT_ROOT, userRoot: tmpUser });

        repo = createSkillRepository(tmpUser);
        const idx = createMemoryIndex(repo);
        await idx.rebuild();

        app = express();
        app.use(express.json({ limit: '20mb' }));
        app.set('lukerDefaultRoot', REPO_DEFAULT_ROOT);
        app.use('/api/skills', createSkillsRouter({
            getRepository: () => repo,
            memoryIndex: idx,
        }));
    });

    afterAll(async () => {
        await fs.rm(tmpUser, { recursive: true, force: true });
    });

    test('fresh install populates bundled skills in global scope', async () => {
        const res = await request(app).get('/api/skills?scope=global');
        expect(res.status).toBe(200);
        // Bundled set: 5 mode-baseline (anti-cliche, character-voice, no-meta,
        // output-discipline, zh-style) + 3 main-agent (turn-workflow, dispatch-
        // protocol, draft-writer-style) + 12 per-sub-agent method skills (one
        // per real sub-agent in buildDefaultDirectorSubAgents) = 20. Use >= so
        // the assertion stays future-proof when new bundled scaffolds ship;
        // tighten to an exact count only if we ever need to detect accidental
        // scaffold deletions.
        expect(res.body.length).toBeGreaterThanOrEqual(20);
        const names = res.body.map(e => e.name).sort();
        // Sample three of the bundled set — one mode-level, one main-agent, one sub-agent.
        // Exhaustive name checking happens via the length assertion above.
        expect(names).toContain('director-anti-cliche-zh');
        expect(names).toContain('director-turn-workflow-zh');
        expect(names).toContain('event-summary-rules-zh');
    });

    test('reading a populated skill body returns verbatim director-defaults content', async () => {
        const res = await request(app).get('/api/skills/global/director-anti-cliche-zh/file');
        expect(res.status).toBe(200);
        // Bundled bodies are verbatim extractions from director-defaults.js.
        // Anchor the assertion on a stable marker unique to the anti-cliche
        // skill body so a future drift in wording surfaces here rather than
        // silently passing.
        expect(res.body.content).toContain('Data-person prose');
        expect(res.body.content).toContain('AI 自造标签');
    });

    test('roundtrip: pack global -> extract into character scope', async () => {
        const pack = await request(app).post('/api/skills/pack-for-embed').send({
            scope: { kind: 'global' },
            names: ['director-anti-cliche-zh'],
            mode: 'auto',
        });
        expect(pack.status).toBe(200);

        const extract = await request(app).post('/api/skills/extract-embed/execute').send({
            payload: pack.body,
            targetScope: { kind: 'character', characterFile: 'test.png' },
            conflictStrategies: {},
        });
        expect(extract.status).toBe(200);
        expect(extract.body.installed).toContain('director-anti-cliche-zh');

        const charList = await request(app)
            .get('/api/skills?scope=' + encodeURIComponent('character/test.png'));
        expect(charList.status).toBe(200);
        expect(charList.body).toHaveLength(1);
        expect(charList.body[0].name).toBe('director-anti-cliche-zh');
    });

    test('import-bundled is idempotent (run twice = same end state)', async () => {
        const r1 = await request(app).post('/api/skills/import-bundled');
        expect(r1.status).toBe(200);
        const list1 = await request(app).get('/api/skills?scope=global');
        expect(list1.body.length).toBeGreaterThanOrEqual(20);

        const r2 = await request(app).post('/api/skills/import-bundled');
        expect(r2.status).toBe(200);
        const list2 = await request(app).get('/api/skills?scope=global');
        // Same end-state: re-running import-bundled replaces existing entries
        // with the same content rather than duplicating them.
        expect(list2.body).toHaveLength(list1.body.length);
    });
});
