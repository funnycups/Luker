import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createMemoryIndex } from '../../src/skills/memory-index.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SkillMemoryIndex', () => {
    let tmpRoot, repo, idx;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-idx-'));
        repo = createSkillRepository(tmpRoot);
        idx = createMemoryIndex(repo);
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('returns empty when nothing installed', async () => {
        await idx.rebuild();
        expect(idx.getVisible({ presetApiId: null, presetName: null, characterFile: null })).toEqual([]);
    });

    test('returns installed skills after rebuild', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: g1\ndescription: x\n---\n' }] },
        });
        await idx.rebuild();
        expect(idx.getVisible({}).map(e => e.name)).toEqual(['g1']);
    });

    test('character scope overrides global on same name (later-wins)', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: shared\ndescription: global version\n---\n' }] },
        });
        await repo.install({
            scope: { kind: 'character', characterFile: 'a.png' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: shared\ndescription: char version\n---\n' }] },
        });
        await idx.rebuild();
        const visible = idx.getVisible({ characterFile: 'a.png' });
        expect(visible.find(e => e.name === 'shared').description).toBe('char version');
    });

    test('preset scope overrides global on same name', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: shared\ndescription: global version\n---\n' }] },
        });
        await repo.install({
            scope: { kind: 'preset', apiId: 'openai', name: 'rp4' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: shared\ndescription: preset version\n---\n' }] },
        });
        await idx.rebuild();
        const visible = idx.getVisible({ presetApiId: 'openai', presetName: 'rp4' });
        expect(visible.find(e => e.name === 'shared').description).toBe('preset version');
    });

    test('invalidate triggers re-walk', async () => {
        await idx.rebuild();
        expect(idx.getVisible({})).toHaveLength(0);
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: late\ndescription: x\n---\n' }] },
        });
        await idx.invalidate();
        expect(idx.getVisible({}).map(e => e.name)).toEqual(['late']);
    });
});
