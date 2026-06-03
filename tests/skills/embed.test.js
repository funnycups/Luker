import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { packEmbedPayload, parseEmbedPayload, materializeFromEmbed } from '../../src/skills/embed.js';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('embed pack / extract', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(join(tmpdir(), 'skill-embed-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: pack-me\ndescription: test\n---\nbody\n' },
                    { path: 'references/r.md', encoding: 'utf8', content: 'reference\n' },
                ],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('packs small text skill as inline-files-v1 in auto mode', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'auto',
        });
        expect(payload.version).toBe(1);
        expect(payload.items).toHaveLength(1);
        expect(payload.items[0].bundleFormat).toBe('inline-files-v1');
        expect(payload.items[0].name).toBe('pack-me');
        expect(payload.items[0].files).toHaveLength(2);
        const skillMd = payload.items[0].files.find(f => f.path === 'SKILL.md');
        expect(skillMd.content).toContain('name: pack-me');
    });

    test('forces archive-base64-v1 when mode explicit', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'archive-base64-v1',
        });
        expect(payload.items[0].bundleFormat).toBe('archive-base64-v1');
        expect(payload.items[0].contentBase64).toBeTruthy();
        expect(payload.items[0].sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(payload.items[0].fileName).toBe('pack-me.zip');
    });

    test('forces inline-files-v1 when mode explicit', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'inline-files-v1',
        });
        expect(payload.items[0].bundleFormat).toBe('inline-files-v1');
    });

    test('auto switches to archive when file is too big', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: big-text\ndescription: x\n---\n' },
                    { path: 'huge.md', encoding: 'utf8', content: 'x'.repeat(100 * 1024) },  // 100 KB > 64 KB threshold
                ],
            },
        });
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['big-text'],
            mode: 'auto',
        });
        expect(payload.items[0].bundleFormat).toBe('archive-base64-v1');
    });

    test('auto switches to archive when binary present', async () => {
        await fs.mkdir(join(tmpRoot, 'skills/global/pack-me/assets'), { recursive: true });
        await fs.writeFile(join(tmpRoot, 'skills/global/pack-me/assets/bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'auto',
        });
        expect(payload.items[0].bundleFormat).toBe('archive-base64-v1');
    });

    test('materializes inline-files-v1 back to filesystem', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'inline-files-v1',
        });
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        const result = await materializeFromEmbed({
            repository: repo2,
            payload,
            targetScope: { kind: 'character', characterFile: 'bob.png' },
        });
        expect(result.installed).toEqual(['pack-me']);
        const got = await repo2.get('pack-me', { kind: 'character', characterFile: 'bob.png' });
        expect(got).toBeTruthy();
        expect(got.fileCount).toBe(2);
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('materializes archive-base64-v1 back to filesystem (binary roundtrip)', async () => {
        await fs.mkdir(join(tmpRoot, 'skills/global/pack-me/assets'), { recursive: true });
        const originalBytes = Buffer.from([0, 1, 2, 3, 0, 255, 128, 64]);
        await fs.writeFile(join(tmpRoot, 'skills/global/pack-me/assets/bin.dat'), originalBytes);

        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'archive-base64-v1',
        });
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        await materializeFromEmbed({
            repository: repo2,
            payload,
            targetScope: { kind: 'global' },
        });
        const restored = await fs.readFile(join(tmpRoot2, 'skills/global/pack-me/assets/bin.dat'));
        expect(restored.equals(originalBytes)).toBe(true);
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('rejects unsupported payload version', async () => {
        await expect(parseEmbedPayload({ version: 99, items: [] }))
            .rejects.toThrow(/unsupported.*version/);
    });

    test('rejects archive with sha256 mismatch', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'archive-base64-v1',
        });
        payload.items[0].sha256 = '0'.repeat(64);  // bogus
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        await expect(materializeFromEmbed({
            repository: repo2,
            payload,
            targetScope: { kind: 'global' },
        })).rejects.toThrow(/sha256 mismatch/);
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('honors per-skill conflictStrategy on materialize', async () => {
        const payload = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'inline-files-v1',
        });
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        // First install
        await materializeFromEmbed({ repository: repo2, payload, targetScope: { kind: 'global' } });
        // Modify the original and re-pack
        await repo.writeFile({
            scope: { kind: 'global' },
            name: 'pack-me',
            path: 'references/r.md',
            content: 'CHANGED\n',
        });
        const payload2 = await packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: ['pack-me'],
            mode: 'inline-files-v1',
        });
        // Materialize with skip — should not overwrite
        const result = await materializeFromEmbed({
            repository: repo2,
            payload: payload2,
            targetScope: { kind: 'global' },
            conflictStrategies: { 'pack-me': 'skip' },
        });
        expect(result.skipped).toEqual(['pack-me']);
        const got = await repo2.readFile({
            scope: { kind: 'global' },
            name: 'pack-me',
            path: 'references/r.md',
        });
        expect(got.content.trim()).toBe('reference');  // unchanged
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('honors conflictStrategy=replace', async () => {
        const payload = await packEmbedPayload({
            repository: repo, scope: { kind: 'global' }, names: ['pack-me'], mode: 'inline-files-v1',
        });
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        await materializeFromEmbed({ repository: repo2, payload, targetScope: { kind: 'global' } });
        // Modify and re-pack
        await repo.writeFile({ scope: { kind: 'global' }, name: 'pack-me', path: 'references/r.md', content: 'CHANGED\n' });
        const payload2 = await packEmbedPayload({
            repository: repo, scope: { kind: 'global' }, names: ['pack-me'], mode: 'inline-files-v1',
        });
        const result = await materializeFromEmbed({
            repository: repo2, payload: payload2, targetScope: { kind: 'global' },
            conflictStrategies: { 'pack-me': 'replace' },
        });
        expect(result.installed).toEqual(['pack-me']);
        const got = await repo2.readFile({ scope: { kind: 'global' }, name: 'pack-me', path: 'references/r.md' });
        expect(got.content.trim()).toBe('CHANGED');
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('rejects empty names array', async () => {
        await expect(packEmbedPayload({
            repository: repo,
            scope: { kind: 'global' },
            names: [],
        })).rejects.toThrow(/names/);
    });

    test('materializeFromEmbed exposes partial progress on failure', async () => {
        const payload = await packEmbedPayload({
            repository: repo, scope: { kind: 'global' }, names: ['pack-me'], mode: 'inline-files-v1',
        });
        // Add a bogus second item that will fail at install (no SKILL.md)
        payload.items.push({
            bundleFormat: 'inline-files-v1',
            name: 'broken',
            files: [{ path: 'oops.txt', encoding: 'utf8', content: 'no SKILL.md\n' }],
        });
        const tmpRoot2 = await fs.mkdtemp(join(tmpdir(), 'skill-extract-'));
        const repo2 = createSkillRepository(tmpRoot2);
        let caught;
        try {
            await materializeFromEmbed({ repository: repo2, payload, targetScope: { kind: 'global' } });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeDefined();
        expect(caught.installed).toEqual(['pack-me']);
        expect(caught.failedAt).toBe('broken');
        await fs.rm(tmpRoot2, { recursive: true, force: true });
    });

    test('rejects archive with traversal entry path', async () => {
        const { createHash } = await import('node:crypto');
        const { default: AdmZip } = await import('adm-zip');

        const zip = new AdmZip();
        // adm-zip sanitizes traversal on addFile, so use a placeholder then patch bytes
        zip.addFile('AAAAAAAAAAAA', Buffer.from('escape\n'));
        zip.addFile('SKILL.md', Buffer.from('---\nname: evil\ndescription: x\n---\n'));
        const buf = Buffer.from(zip.toBuffer());
        // Patch placeholder in both local + central directory headers
        const placeholder = 'AAAAAAAAAAAA';
        const traversal = '../escape.bb';
        let i = 0;
        while ((i = buf.indexOf(placeholder, i)) !== -1) {
            buf.write(traversal, i, 'utf8');
            i += traversal.length;
        }
        const payload = {
            version: 1,
            items: [{
                bundleFormat: 'archive-base64-v1',
                name: 'evil',
                contentBase64: buf.toString('base64'),
                sha256: createHash('sha256').update(buf).digest('hex'),
            }],
        };
        await expect(materializeFromEmbed({
            repository: repo, payload, targetScope: { kind: 'global' },
        })).rejects.toThrow(/path traversal|illegal/i);
    });
});
