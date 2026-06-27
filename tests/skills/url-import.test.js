import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { importFromUrl } from '../../src/skills/url-import.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('url-import (validation paths)', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-url-'));
        repo = createSkillRepository(tmpRoot);
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('rejects non-https URL', async () => {
        await expect(importFromUrl({
            url: 'http://example.com/SKILL.md',
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/https/i);
        await expect(importFromUrl({
            url: 'file:///etc/passwd',
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/https/i);
    });

    test('rejects non-string URL', async () => {
        await expect(importFromUrl({
            url: null,
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/https/i);
    });
});

// Real-fetch (HTTPS network) testing is intentionally out of scope here. The
// HTTPS-only check makes a unit test fixture awkward (would require a local
// HTTPS server with a self-signed cert), so happy-path coverage is provided
// by the integration smoke and manual testing.

describe('url-import (body validation via fetch stub)', () => {
    let tmpRoot, repo, originalFetch;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-url-stub-'));
        repo = createSkillRepository(tmpRoot);
        originalFetch = global.fetch;
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    test('rejects non-frontmatter body', async () => {
        global.fetch = async () => ({
            ok: true, status: 200,
            text: async () => '<html>not a skill</html>',
        });
        await expect(importFromUrl({
            url: 'https://example.com/x.md',
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/frontmatter/i);
    });

    test('rejects oversized body', async () => {
        const huge = '---\nname: x\ndescription: y\n---\n' + 'x'.repeat(600 * 1024);
        global.fetch = async () => ({
            ok: true, status: 200,
            text: async () => huge,
        });
        await expect(importFromUrl({
            url: 'https://example.com/x.md',
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/exceeds/);
    });

    test('propagates non-2xx HTTP status', async () => {
        global.fetch = async () => ({
            ok: false, status: 404,
            text: async () => 'not found',
        });
        await expect(importFromUrl({
            url: 'https://example.com/missing.md',
            targetScope: { kind: 'global' },
            repository: repo,
        })).rejects.toThrow(/HTTP 404/);
    });

    test('installs valid SKILL.md', async () => {
        global.fetch = async () => ({
            ok: true, status: 200,
            text: async () => '---\nname: from-url\ndescription: imported\n---\nbody\n',
        });
        const result = await importFromUrl({
            url: 'https://example.com/skill.md',
            targetScope: { kind: 'global' },
            repository: repo,
        });
        expect(result.name).toBe('from-url');
        expect(result.conflict).toBe('new');
        const got = await repo.get('from-url', { kind: 'global' });
        expect(got).toBeTruthy();
    });
});
