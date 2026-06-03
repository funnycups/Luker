import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createSkillsRouter } from '../../src/endpoints/skills.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Build a minimal Express app with no auth so we can drive the router
 * directly via supertest. `getRepository` always returns the same fixed-root
 * repo, mirroring what the wired server would do per-request but without
 * needing to mock the auth + session stack.
 */
function buildApp(repo, opts = {}) {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    if (opts.lukerDefaultRoot) {
        app.set('lukerDefaultRoot', opts.lukerDefaultRoot);
    }
    app.use('/api/skills', createSkillsRouter({
        getRepository: () => repo,
        getMemoryIndex: () => opts.memoryIndex || null,
    }));
    return app;
}

async function installSimpleSkill(app, scope, name, extra = '') {
    return await request(app)
        .post('/api/skills/' + encodeURIComponent(scope))
        .send({
            payload: {
                files: [{
                    path: 'SKILL.md',
                    encoding: 'utf8',
                    content: `---\nname: ${name}\ndescription: test\n---\n${extra}`,
                }],
            },
        });
}

describe('REST /api/skills', () => {
    let app, tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-rest-'));
        repo = createSkillRepository(tmpRoot);
        app = buildApp(repo);
    });

    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    describe('list / read / install / delete', () => {
        test('GET /api/skills?scope=global returns empty', async () => {
            const res = await request(app).get('/api/skills?scope=global');
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        test('GET /api/skills with no scope defaults to all', async () => {
            const res = await request(app).get('/api/skills');
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        test('POST /api/skills/global installs a skill', async () => {
            const res = await installSimpleSkill(app, 'global', 'api-test');
            expect(res.status).toBe(200);
            expect(res.body.action).toBe('installed');
            expect(res.body.name).toBe('api-test');

            const list = await request(app).get('/api/skills?scope=global');
            expect(list.body.map(e => e.name)).toEqual(['api-test']);
        });

        test('GET /api/skills/global/api-test/file returns SKILL.md', async () => {
            await installSimpleSkill(app, 'global', 'api-test', 'body line\n');
            const res = await request(app).get('/api/skills/global/api-test/file');
            expect(res.status).toBe(200);
            expect(res.body.content).toContain('body line');
            expect(res.body.totalLines).toBeGreaterThan(0);
        });

        test('GET file honors offset and limit', async () => {
            await installSimpleSkill(app, 'global', 'api-test', 'l1\nl2\nl3\nl4\nl5\n');
            const res = await request(app).get('/api/skills/global/api-test/file')
                .query({ offset: 5, limit: 2 });
            expect(res.status).toBe(200);
            expect(res.body.content).toContain('l1');
            expect(res.body.content).toContain('l2');
        });

        test('DELETE removes', async () => {
            await installSimpleSkill(app, 'global', 'api-test');
            const res = await request(app).delete('/api/skills/global/api-test');
            expect(res.status).toBe(204);
            const list = await request(app).get('/api/skills?scope=global');
            expect(list.body).toEqual([]);
        });

        test('GET on unknown scope path returns 400', async () => {
            const res = await request(app).get('/api/skills?scope=invalid/x');
            expect(res.status).toBe(400);
        });

        test('returns 404 when reading missing file', async () => {
            await installSimpleSkill(app, 'global', 'api-test');
            const res = await request(app).get('/api/skills/global/api-test/file')
                .query({ path: 'missing.md' });
            expect(res.status).toBe(404);
        });

        test('rejects traversal in name on DELETE', async () => {
            const res = await request(app)
                .delete('/api/skills/global/' + encodeURIComponent('../etc'));
            expect(res.status).toBe(400);
        });

        test('install on preset scope works with URL-encoded slashes', async () => {
            const scope = 'preset/openai/my-preset';
            const res = await request(app)
                .post('/api/skills/' + encodeURIComponent(scope))
                .send({
                    payload: {
                        files: [{
                            path: 'SKILL.md',
                            encoding: 'utf8',
                            content: '---\nname: scoped\ndescription: x\n---\n',
                        }],
                    },
                });
            expect(res.status).toBe(200);
            expect(res.body.action).toBe('installed');

            const list = await request(app)
                .get(`/api/skills?scope=${encodeURIComponent(scope)}`);
            expect(list.body.map(e => e.name)).toEqual(['scoped']);
        });

        test('install conflict without strategy returns 4xx', async () => {
            await installSimpleSkill(app, 'global', 'api-test', 'v1\n');
            const res = await request(app)
                .post('/api/skills/' + encodeURIComponent('global'))
                .send({
                    payload: {
                        files: [{
                            path: 'SKILL.md',
                            encoding: 'utf8',
                            content: '---\nname: api-test\ndescription: x\n---\nv2\n',
                        }],
                    },
                });
            expect([400, 409]).toContain(res.status);
        });

        test('install conflict with replace strategy succeeds', async () => {
            await installSimpleSkill(app, 'global', 'api-test', 'v1\n');
            const res = await request(app)
                .post('/api/skills/' + encodeURIComponent('global'))
                .send({
                    payload: {
                        files: [{
                            path: 'SKILL.md',
                            encoding: 'utf8',
                            content: '---\nname: api-test\ndescription: x\n---\nv2\n',
                        }],
                    },
                    conflictStrategy: 'replace',
                });
            expect(res.status).toBe(200);
            expect(res.body.action).toBe('replaced');
        });
    });

    describe('rename / move-scope / writeFile / editFile / search', () => {
        beforeEach(async () => {
            await installSimpleSkill(app, 'global', 'target', 'Line A\nLine B\nLine C\n');
        });

        test('rename succeeds and updates list', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/rename')
                .send({ toName: 'renamed' });
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
            const list = await request(app).get('/api/skills?scope=global');
            expect(list.body.map(e => e.name)).toEqual(['renamed']);
        });

        test('rename to illegal name returns 400', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/rename')
                .send({ toName: '../etc' });
            expect(res.status).toBe(400);
        });

        test('move-scope relocates skill between scopes', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/move-scope')
                .send({ toScope: { kind: 'character', characterFile: 'a.png' } });
            expect(res.status).toBe(200);

            const global = await request(app).get('/api/skills?scope=global');
            expect(global.body).toEqual([]);
            const char = await request(app)
                .get(`/api/skills?scope=${encodeURIComponent('character/a.png')}`);
            expect(char.body.map(e => e.name)).toEqual(['target']);
        });

        test('writeFile creates a new file', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/file/write')
                .send({ path: 'references/note.md', content: 'noted\n' });
            expect(res.status).toBe(200);
            expect(typeof res.body.sha256).toBe('string');
            expect(res.body.sha256).toHaveLength(64);
        });

        test('editFile applies a single replacement', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/file/edit')
                .send({
                    path: 'SKILL.md',
                    oldString: 'Line B',
                    newString: 'Line BBB',
                });
            expect(res.status).toBe(200);
            expect(res.body.changesApplied).toBe(1);
        });

        test('editFile with empty oldString returns 400', async () => {
            const res = await request(app)
                .post('/api/skills/global/target/file/edit')
                .send({
                    path: 'SKILL.md',
                    oldString: '',
                    newString: 'x',
                });
            expect(res.status).toBe(400);
        });

        test('search returns matching lines', async () => {
            const res = await request(app)
                .get('/api/skills/global/target/search')
                .query({ q: 'Line' });
            expect(res.status).toBe(200);
            expect(res.body.hits.length).toBeGreaterThanOrEqual(3);
        });

        test('search with empty query returns 400', async () => {
            const res = await request(app)
                .get('/api/skills/global/target/search')
                .query({ q: '' });
            expect(res.status).toBe(400);
        });

        test('list-files returns metadata for every file (no buffers)', async () => {
            // Install a reference file so the skill has more than just SKILL.md
            await request(app)
                .post('/api/skills/global/target/file/write')
                .send({ path: 'references/note.md', content: 'noted\n' });
            const res = await request(app).get('/api/skills/global/target/files');
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.files)).toBe(true);
            // SKILL.md is sorted first as the skill's root manifest, then the
            // rest in localeCompare order.
            const paths = res.body.files.map(f => f.path);
            expect(paths[0]).toBe('SKILL.md');
            expect(paths).toContain('references/note.md');
            for (const f of res.body.files) {
                expect(typeof f.path).toBe('string');
                expect(typeof f.size).toBe('number');
                expect(typeof f.isBinary).toBe('boolean');
                // Server must NOT leak buffers / contents in the metadata listing.
                expect(f).not.toHaveProperty('buffer');
                expect(f).not.toHaveProperty('content');
            }
        });

        test('list-files returns 404 for missing skill', async () => {
            const res = await request(app).get('/api/skills/global/no-such-skill/files');
            expect(res.status).toBe(404);
        });

        test('delete-file removes a non-SKILL.md file', async () => {
            // Set up an extra file we can delete
            await request(app)
                .post('/api/skills/global/target/file/write')
                .send({ path: 'references/extra.md', content: 'gone soon\n' });
            const res = await request(app)
                .delete('/api/skills/global/target/file')
                .query({ path: 'references/extra.md' });
            expect(res.status).toBe(204);
            // Verify it's gone from the file listing
            const list = await request(app).get('/api/skills/global/target/files');
            expect(list.body.files.map(f => f.path)).not.toContain('references/extra.md');
        });

        test('delete-file refuses to delete SKILL.md', async () => {
            const res = await request(app)
                .delete('/api/skills/global/target/file')
                .query({ path: 'SKILL.md' });
            expect(res.status).toBe(400);
        });

        test('delete-file rejects path traversal', async () => {
            const res = await request(app)
                .delete('/api/skills/global/target/file')
                .query({ path: '../../etc/passwd' });
            expect(res.status).toBe(400);
        });
    });

    describe('pack-for-embed / extract / bundled / url-import', () => {
        beforeEach(async () => {
            await installSimpleSkill(app, 'global', 'packable');
        });

        test('pack-for-embed returns embed payload', async () => {
            const res = await request(app)
                .post('/api/skills/pack-for-embed')
                .send({
                    scope: { kind: 'global' },
                    names: ['packable'],
                    mode: 'inline-files-v1',
                });
            expect(res.status).toBe(200);
            expect(res.body.version).toBe(1);
            expect(res.body.items).toHaveLength(1);
            expect(res.body.items[0].name).toBe('packable');
            expect(res.body.items[0].bundleFormat).toBe('inline-files-v1');
        });

        test('extract-embed/preview reports new/same/different per spec', async () => {
            const pack = await request(app)
                .post('/api/skills/pack-for-embed')
                .send({
                    scope: { kind: 'global' },
                    names: ['packable'],
                    mode: 'inline-files-v1',
                });

            // Preview into empty character scope → 'new'.
            const preview1 = await request(app)
                .post('/api/skills/extract-embed/preview')
                .send({
                    payload: pack.body,
                    targetScope: { kind: 'character', characterFile: 'b.png' },
                });
            expect(preview1.status).toBe(200);
            expect(preview1.body.items[0].conflict).toBe('new');

            // Materialize, then preview the same payload again → 'same'.
            const exec = await request(app)
                .post('/api/skills/extract-embed/execute')
                .send({
                    payload: pack.body,
                    targetScope: { kind: 'character', characterFile: 'b.png' },
                });
            expect(exec.status).toBe(200);
            expect(exec.body.installed).toEqual(['packable']);

            const preview2 = await request(app)
                .post('/api/skills/extract-embed/preview')
                .send({
                    payload: pack.body,
                    targetScope: { kind: 'character', characterFile: 'b.png' },
                });
            expect(preview2.body.items[0].conflict).toBe('same');

            // Modify the source, repack, preview → 'different'.
            await request(app)
                .post('/api/skills/global/packable/file/write')
                .send({ path: 'SKILL.md', content: '---\nname: packable\ndescription: MODIFIED\n---\n' });
            const pack2 = await request(app)
                .post('/api/skills/pack-for-embed')
                .send({
                    scope: { kind: 'global' },
                    names: ['packable'],
                    mode: 'inline-files-v1',
                });
            const preview3 = await request(app)
                .post('/api/skills/extract-embed/preview')
                .send({
                    payload: pack2.body,
                    targetScope: { kind: 'character', characterFile: 'b.png' },
                });
            expect(preview3.body.items[0].conflict).toBe('different');
        });

        test('extract-embed/preview rejects malformed payload', async () => {
            const res = await request(app)
                .post('/api/skills/extract-embed/preview')
                .send({
                    payload: { version: 2 },
                    targetScope: { kind: 'global' },
                });
            expect(res.status).toBe(400);
        });

        test('import-bundled returns 500 when lukerDefaultRoot is not configured', async () => {
            // buildApp was called without lukerDefaultRoot
            const res = await request(app).post('/api/skills/import-bundled');
            expect(res.status).toBe(500);
        });

        test('bundled-manifest lists each skill in default/skills/global/ with name+installedHash', async () => {
            // Build a fake defaultRoot with two bundled skills so the test
            // doesn't depend on the project's real bundled content.
            const fakeDefault = await fs.mkdtemp(join(tmpdir(), 'bundled-manifest-default-'));
            try {
                await fs.mkdir(join(fakeDefault, 'skills/global/alpha-skill'), { recursive: true });
                await fs.writeFile(
                    join(fakeDefault, 'skills/global/alpha-skill/SKILL.md'),
                    '---\nname: alpha-skill\ndescription: first bundled\n---\nbody A\n',
                );
                await fs.mkdir(join(fakeDefault, 'skills/global/beta-skill'), { recursive: true });
                await fs.writeFile(
                    join(fakeDefault, 'skills/global/beta-skill/SKILL.md'),
                    '---\nname: beta-skill\ndescription: second bundled\n---\nbody B\n',
                );
                const app2 = buildApp(repo, { lukerDefaultRoot: fakeDefault });
                const res = await request(app2).get('/api/skills/bundled-manifest');
                expect(res.status).toBe(200);
                expect(Array.isArray(res.body)).toBe(true);
                // Sorted by name (importBundledSkills sorts readdir output too).
                expect(res.body.map(e => e.name)).toEqual(['alpha-skill', 'beta-skill']);
                for (const entry of res.body) {
                    expect(typeof entry.installedHash).toBe('string');
                    expect(entry.installedHash).toHaveLength(64);
                    expect(typeof entry.fileCount).toBe('number');
                    expect(entry.fileCount).toBeGreaterThanOrEqual(1);
                    expect(typeof entry.totalBytes).toBe('number');
                    expect(entry.totalBytes).toBeGreaterThan(0);
                    expect(typeof entry.description).toBe('string');
                }
            } finally {
                await fs.rm(fakeDefault, { recursive: true, force: true });
            }
        });

        test('bundled-manifest returns empty array when defaultRoot missing skills dir', async () => {
            const missing = join(tmpdir(), 'bundled-manifest-missing-' + Date.now());
            const app2 = buildApp(repo, { lukerDefaultRoot: missing });
            const res = await request(app2).get('/api/skills/bundled-manifest');
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        test('bundled-manifest installedHash matches importBundled-installed skill hash', async () => {
            // Build a fake defaultRoot, install via importBundled, then verify
            // the manifest hash equals the freshly-installed skill's hash.
            const fakeDefault = await fs.mkdtemp(join(tmpdir(), 'bundled-manifest-hash-'));
            try {
                await fs.mkdir(join(fakeDefault, 'skills/global/check-hash'), { recursive: true });
                await fs.writeFile(
                    join(fakeDefault, 'skills/global/check-hash/SKILL.md'),
                    '---\nname: check-hash\ndescription: x\n---\ncontent for hash\n',
                );
                const app2 = buildApp(repo, { lukerDefaultRoot: fakeDefault });
                const manifestRes = await request(app2).get('/api/skills/bundled-manifest');
                const bundled = manifestRes.body.find(e => e.name === 'check-hash');
                expect(bundled).toBeTruthy();

                const importRes = await request(app2).post('/api/skills/import-bundled');
                expect(importRes.status).toBe(200);

                const list = await request(app2).get('/api/skills?scope=global');
                const installed = list.body.find(e => e.name === 'check-hash');
                expect(installed).toBeTruthy();
                expect(installed.installedHash).toBe(bundled.installedHash);
            } finally {
                await fs.rm(fakeDefault, { recursive: true, force: true });
            }
        });

        test('bundled-manifest returns 500 when lukerDefaultRoot not configured', async () => {
            const res = await request(app).get('/api/skills/bundled-manifest');
            expect(res.status).toBe(500);
        });

        test('import-bundled returns 0/0 when defaultRoot points at missing dir', async () => {
            const missing = join(tmpdir(), 'skill-rest-default-missing-' + Date.now());
            const app2 = buildApp(repo, { lukerDefaultRoot: missing });
            const res = await request(app2).post('/api/skills/import-bundled');
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ installed: 0, replaced: 0 });
        });

        test('import-from-url rejects http://', async () => {
            const res = await request(app)
                .post('/api/skills/import-from-url')
                .send({
                    url: 'http://example.com/SKILL.md',
                    targetScope: { kind: 'global' },
                });
            expect(res.status).toBe(400);
        });

        test('import-from-url rejects non-string URL', async () => {
            const res = await request(app)
                .post('/api/skills/import-from-url')
                .send({
                    url: 12345,
                    targetScope: { kind: 'global' },
                });
            expect(res.status).toBe(400);
        });
    });

    describe('error -> status code mapping', () => {
        // These tests pin the regex in httpStatusForError so the documented
        // 4xx contract for repository / parser / readFile failures doesn't
        // silently regress to 500. Each test exercises one user-reachable
        // error path that previously fell through to the default bucket.

        beforeEach(async () => {
            // Install a baseline skill so binary-read tests have a target.
            await request(app)
                .post('/api/skills/global')
                .send({
                    payload: {
                        files: [
                            { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: existing\ndescription: x\n---\n' },
                            { path: 'assets/bin.dat', encoding: 'base64', content: Buffer.from([0, 1, 2, 0, 3]).toString('base64') },
                        ],
                    },
                });
        });

        test('413 on total size over limit', async () => {
            // 4 MB per-file cap is fine; we need total > 16 MB. Five 4-MB
            // files (just under the per-file limit) sum to 20 MB.
            const big = 'x'.repeat(4 * 1024 * 1024 - 1024);
            const res = await request(app)
                .post('/api/skills/global')
                .send({
                    payload: {
                        files: [
                            { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: huge\ndescription: x\n---\n' },
                            { path: 'a.txt', encoding: 'utf8', content: big },
                            { path: 'b.txt', encoding: 'utf8', content: big },
                            { path: 'c.txt', encoding: 'utf8', content: big },
                            { path: 'd.txt', encoding: 'utf8', content: big },
                            { path: 'e.txt', encoding: 'utf8', content: big },
                        ],
                    },
                });
            expect(res.status).toBe(413);
            expect(res.body.error).toMatch(/total skill size/i);
        });

        test('400 on binary file read', async () => {
            const res = await request(app)
                .get('/api/skills/global/existing/file')
                .query({ path: 'assets/bin.dat' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/binary/i);
        });

        test('400 on malformed SKILL.md missing frontmatter', async () => {
            const res = await request(app)
                .post('/api/skills/global')
                .send({
                    payload: {
                        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '# Not a frontmatter\n' }],
                    },
                });
            expect(res.status).toBe(400);
        });

        test('400 on SKILL.md missing name field', async () => {
            const res = await request(app)
                .post('/api/skills/global')
                .send({
                    payload: {
                        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\ndescription: no name\n---\n' }],
                    },
                });
            expect(res.status).toBe(400);
        });

        test('400 on SKILL.md missing description', async () => {
            const res = await request(app)
                .post('/api/skills/global')
                .send({
                    payload: {
                        files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: nodesc\n---\n' }],
                    },
                });
            expect(res.status).toBe(400);
        });
    });

    describe('memoryIndex invalidation', () => {
        test('invalidate is called after writes', async () => {
            let calls = 0;
            const memoryIndex = { invalidate: async () => { calls++; } };
            const app2 = buildApp(repo, { memoryIndex });

            await installSimpleSkill(app2, 'global', 'idx-test');
            expect(calls).toBe(1);

            await request(app2)
                .post('/api/skills/global/idx-test/rename')
                .send({ toName: 'idx-renamed' });
            expect(calls).toBe(2);

            await request(app2).delete('/api/skills/global/idx-renamed');
            expect(calls).toBe(3);
        });

        test('invalidate is not called on read-only routes', async () => {
            const memoryIndex = { invalidate: async () => { throw new Error('should not be called'); } };
            const app2 = buildApp(repo, { memoryIndex: null });
            await installSimpleSkill(app2, 'global', 'ro-test');

            const app3 = buildApp(repo, { memoryIndex });
            const res = await request(app3).get('/api/skills?scope=global');
            expect(res.status).toBe(200);
            const read = await request(app3).get('/api/skills/global/ro-test/file');
            expect(read.status).toBe(200);
            const search = await request(app3).get('/api/skills/global/ro-test/search').query({ q: 'name' });
            expect(search.status).toBe(200);
        });
    });
});
