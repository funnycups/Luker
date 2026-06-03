import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { importBundledSkills, ensureFreshInstallPopulate } from '../../src/skills/bundled.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bundled skills', () => {
    let userRoot, defaultRoot, repo;

    beforeEach(async () => {
        userRoot = await fs.mkdtemp(join(tmpdir(), 'skill-user-'));
        defaultRoot = await fs.mkdtemp(join(tmpdir(), 'skill-default-'));
        await fs.mkdir(join(defaultRoot, 'skills/global/bundled-a'), { recursive: true });
        await fs.writeFile(
            join(defaultRoot, 'skills/global/bundled-a/SKILL.md'),
            '---\nname: bundled-a\ndescription: bundled test\n---\nbody\n',
        );
        repo = createSkillRepository(userRoot);
    });

    afterEach(async () => {
        await fs.rm(userRoot, { recursive: true, force: true });
        await fs.rm(defaultRoot, { recursive: true, force: true });
    });

    test('ensureFreshInstallPopulate copies bundled when user global empty', async () => {
        const result = await ensureFreshInstallPopulate({ defaultRoot, userRoot });
        expect(result.installed + result.replaced).toBeGreaterThanOrEqual(1);
        const got = await repo.get('bundled-a', { kind: 'global' });
        expect(got).toBeTruthy();
    });

    test('ensureFreshInstallPopulate does nothing when user global already populated', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: existing\ndescription: x\n---\n' },
                ],
            },
        });
        const result = await ensureFreshInstallPopulate({ defaultRoot, userRoot });
        expect(result.populated).toBe(false);
        // bundled-a should NOT have been installed
        expect(await repo.get('bundled-a', { kind: 'global' })).toBeNull();
    });

    test('importBundledSkills overwrites same-named', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: bundled-a\ndescription: old version\n---\n' },
                ],
            },
        });
        const result = await importBundledSkills({ defaultRoot, repository: repo });
        expect(result.replaced).toBe(1);
        const got = await repo.get('bundled-a', { kind: 'global' });
        expect(got.description).toBe('bundled test');  // new bundled version
    });

    test('importBundledSkills installs new skills (no conflict)', async () => {
        const result = await importBundledSkills({ defaultRoot, repository: repo });
        expect(result.installed).toBe(1);
        expect(result.replaced).toBe(0);
    });

    test('importBundledSkills handles binary files via base64', async () => {
        await fs.mkdir(join(defaultRoot, 'skills/global/bundled-bin/assets'), { recursive: true });
        await fs.writeFile(
            join(defaultRoot, 'skills/global/bundled-bin/SKILL.md'),
            '---\nname: bundled-bin\ndescription: with binary\n---\n',
        );
        await fs.writeFile(
            join(defaultRoot, 'skills/global/bundled-bin/assets/bin.dat'),
            Buffer.from([0, 1, 2, 0]),
        );
        const result = await importBundledSkills({ defaultRoot, repository: repo });
        expect(result.installed).toBeGreaterThanOrEqual(2);
        const got = await repo.get('bundled-bin', { kind: 'global' });
        expect(got.hasBinary).toBe(true);
    });

    test('ensureFreshInstallPopulate unified return shape in both branches', async () => {
        // Populated branch
        const r1 = await ensureFreshInstallPopulate({ defaultRoot, userRoot });
        expect(r1).toHaveProperty('populated');
        expect(r1).toHaveProperty('installed');
        expect(r1).toHaveProperty('replaced');
        expect(r1.populated).toBe(true);

        // No-op branch (user dir now populated)
        const r2 = await ensureFreshInstallPopulate({ defaultRoot, userRoot });
        expect(r2.populated).toBe(false);
        expect(r2.installed).toBe(0);
        expect(r2.replaced).toBe(0);
    });
});
