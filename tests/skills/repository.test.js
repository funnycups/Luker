import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createSkillRepository } from '../../src/skills/repository.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, 'fixtures', 'repo-root');

describe('SkillRepository - list / get', () => {
    const repo = createSkillRepository(ROOT);

    test('list returns global skills', async () => {
        const entries = await repo.list({ scope: { kind: 'global' } });
        expect(entries.map(e => e.name).sort()).toEqual(['test-skill-a', 'test-skill-b']);
    });

    test('list returns preset-scoped skills', async () => {
        const entries = await repo.list({ scope: { kind: 'preset', name: 'test-preset' } });
        expect(entries.map(e => e.name)).toEqual(['preset-skill']);
    });

    test('list returns character-scoped skills', async () => {
        const entries = await repo.list({ scope: { kind: 'character', characterFile: 'alice.png' } });
        expect(entries.map(e => e.name)).toEqual(['char-skill']);
    });

    test('list all returns 4 skills across scopes', async () => {
        const entries = await repo.list({ scope: 'all' });
        expect(entries).toHaveLength(4);
        const labels = entries.map(e => `${e.scope.kind}:${e.name}`).sort();
        expect(labels).toEqual([
            'character:char-skill',
            'global:test-skill-a',
            'global:test-skill-b',
            'preset:preset-skill',
        ]);
    });

    test('list returns empty for non-existent scope', async () => {
        const entries = await repo.list({ scope: { kind: 'character', characterFile: 'nonexistent.png' } });
        expect(entries).toEqual([]);
    });

    test('get returns entry with metadata', async () => {
        const entry = await repo.get('test-skill-b', { kind: 'global' });
        expect(entry.name).toBe('test-skill-b');
        expect(entry.description).toBe('Global test skill B');
        expect(entry.metadata.author).toBe('Tester');
        expect(entry.installedHash).toBeTruthy();
        expect(entry.fileCount).toBeGreaterThan(0);
    });

    test('get returns null for missing skill', async () => {
        expect(await repo.get('nope', { kind: 'global' })).toBeNull();
    });
});

describe('SkillRepository - install / conflict', () => {
    let tmpRoot;
    let repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
    });

    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    const SAMPLE = {
        files: [
            { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: fresh\ndescription: a fresh skill\n---\nbody\n' },
            { path: 'references/extra.md', encoding: 'utf8', content: 'extra\n' },
        ],
    };

    test('installs a new skill (conflict=new)', async () => {
        const preview = await repo.previewInstall({ scope: { kind: 'global' }, payload: SAMPLE });
        expect(preview.conflict).toBe('new');

        const result = await repo.install({ scope: { kind: 'global' }, payload: SAMPLE });
        expect(result.action).toBe('installed');
        expect(result.name).toBe('fresh');

        const got = await repo.get('fresh', { kind: 'global' });
        expect(got.fileCount).toBe(2);
    });

    test('detects same when reinstalling identical content', async () => {
        await repo.install({ scope: { kind: 'global' }, payload: SAMPLE });
        const preview = await repo.previewInstall({ scope: { kind: 'global' }, payload: SAMPLE });
        expect(preview.conflict).toBe('same');
    });

    test('detects different on hash mismatch', async () => {
        await repo.install({ scope: { kind: 'global' }, payload: SAMPLE });
        const modified = JSON.parse(JSON.stringify(SAMPLE));
        modified.files[1].content = 'extra MODIFIED\n';
        const preview = await repo.previewInstall({ scope: { kind: 'global' }, payload: modified });
        expect(preview.conflict).toBe('different');
    });

    test('rejects install on different without conflictStrategy', async () => {
        await repo.install({ scope: { kind: 'global' }, payload: SAMPLE });
        const modified = JSON.parse(JSON.stringify(SAMPLE));
        modified.files[1].content = 'changed\n';
        await expect(repo.install({ scope: { kind: 'global' }, payload: modified }))
            .rejects.toThrow(/conflict.*strategy/i);
    });

    test('replaces on different with conflictStrategy=replace', async () => {
        await repo.install({ scope: { kind: 'global' }, payload: SAMPLE });
        const modified = JSON.parse(JSON.stringify(SAMPLE));
        modified.files[1].content = 'changed\n';
        const result = await repo.install({
            scope: { kind: 'global' },
            payload: modified,
            conflictStrategy: 'replace',
        });
        expect(result.action).toBe('replaced');
        const got = await fs.readFile(pjoin(tmpRoot, 'skills/global/fresh/references/extra.md'), 'utf8');
        expect(got).toBe('changed\n');
    });

    test('enforces file size limits', async () => {
        const huge = {
            files: [
                { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: huge\ndescription: x\n---\n' },
                { path: 'big.txt', encoding: 'utf8', content: 'x'.repeat(5 * 1024 * 1024) },  // 5 MB
            ],
        };
        await expect(repo.install({ scope: { kind: 'global' }, payload: huge }))
            .rejects.toThrow(/file size/i);
    });
});

describe('SkillRepository - delete / rename / moveScope', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: target\ndescription: x\n---\n' }] },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('deletes', async () => {
        await repo.delete('target', { kind: 'global' });
        expect(await repo.get('target', { kind: 'global' })).toBeNull();
    });

    test('renames within scope and updates frontmatter name', async () => {
        await repo.rename({ scope: { kind: 'global' }, fromName: 'target', toName: 'renamed' });
        expect(await repo.get('target', { kind: 'global' })).toBeNull();
        const got = await repo.get('renamed', { kind: 'global' });
        expect(got).toBeTruthy();
        expect(got.name).toBe('renamed');
        const md = await fs.readFile(pjoin(tmpRoot, 'skills/global/renamed/SKILL.md'), 'utf8');
        expect(md).toMatch(/^---\nname: renamed/);
    });

    test('rejects rename collision', async () => {
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: other\ndescription: x\n---\n' }] },
        });
        await expect(repo.rename({ scope: { kind: 'global' }, fromName: 'target', toName: 'other' }))
            .rejects.toThrow(/collision/i);
    });

    test('rejects rename to invalid name', async () => {
        await expect(repo.rename({ scope: { kind: 'global' }, fromName: 'target', toName: 'BAD NAME' }))
            .rejects.toThrow(/illegal skill name|invalid/i);
    });

    test('moves scope global to character', async () => {
        await repo.moveScope({
            name: 'target',
            fromScope: { kind: 'global' },
            toScope: { kind: 'character', characterFile: 'alice.png' },
        });
        expect(await repo.get('target', { kind: 'global' })).toBeNull();
        expect(await repo.get('target', { kind: 'character', characterFile: 'alice.png' })).toBeTruthy();
    });

    test('moveScope rejects when destination already has same name', async () => {
        await repo.install({
            scope: { kind: 'character', characterFile: 'alice.png' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: target\ndescription: x\n---\n' }] },
        });
        await expect(repo.moveScope({
            name: 'target',
            fromScope: { kind: 'global' },
            toScope: { kind: 'character', characterFile: 'alice.png' },
        })).rejects.toThrow(/already has/i);
    });
});

describe('SkillRepository - writeFile / editFile', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: edit-target\ndescription: x\n---\nLine one\nLine two\nLine three\n' },
                ],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('writeFile overwrites existing file', async () => {
        const out = await repo.writeFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'references/new.md',
            content: 'hello\n',
        });
        expect(out.sha256).toBeTruthy();
        const got = await fs.readFile(pjoin(tmpRoot, 'skills/global/edit-target/references/new.md'), 'utf8');
        expect(got).toBe('hello\n');
    });

    test('writeFile honors expectedSha256 optimistic lock', async () => {
        await expect(repo.writeFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            content: 'x', expectedSha256: 'wronghash',
        })).rejects.toThrow(/sha256 mismatch/i);
    });

    test('editFile replaces exact match', async () => {
        const out = await repo.editFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            oldString: 'Line two', newString: 'Line TWO',
        });
        expect(out.changesApplied).toBe(1);
        const md = await fs.readFile(pjoin(tmpRoot, 'skills/global/edit-target/SKILL.md'), 'utf8');
        expect(md).toContain('Line TWO');
        expect(md).not.toContain('Line two');
    });

    test('editFile rejects oldString not found', async () => {
        await expect(repo.editFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            oldString: 'NOT THERE', newString: 'x',
        })).rejects.toThrow(/not found/i);
    });

    test('editFile rejects multiple matches without replaceAll', async () => {
        await repo.writeFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            content: '---\nname: edit-target\ndescription: x\n---\nhello\nhello\nhello\n',
        });
        await expect(repo.editFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            oldString: 'hello', newString: 'world',
        })).rejects.toThrow(/multiple matches/i);
    });

    test('editFile with replaceAll handles multiple matches', async () => {
        await repo.writeFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            content: '---\nname: edit-target\ndescription: x\n---\nhello\nhello\n',
        });
        const out = await repo.editFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            oldString: 'hello', newString: 'world', replaceAll: true,
        });
        expect(out.changesApplied).toBe(2);
    });

    test('editFile rejects empty oldString', async () => {
        await expect(repo.editFile({
            scope: { kind: 'global' }, name: 'edit-target', path: 'SKILL.md',
            oldString: '', newString: 'x',
        })).rejects.toThrow(/non-empty/);
    });
});

describe('SkillRepository - renameFile', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: rn-target\ndescription: x\n---\n' },
                    { path: 'old.md', encoding: 'utf8', content: 'body\n' },
                    { path: 'references/nested.md', encoding: 'utf8', content: 'nested\n' },
                ],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('renames file in place', async () => {
        const r = await repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: 'new.md',
        });
        expect(r.ok).toBe(true);
        expect(r.path).toBe('new.md');
        expect(r.sha256).toBeTruthy();
        const exists = await fs.stat(pjoin(tmpRoot, 'skills/global/rn-target/new.md')).then(() => true).catch(() => false);
        expect(exists).toBe(true);
        const oldExists = await fs.stat(pjoin(tmpRoot, 'skills/global/rn-target/old.md')).then(() => true).catch(() => false);
        expect(oldExists).toBe(false);
    });

    test('moves file across subdirectories, creating the target dir', async () => {
        await repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: 'archive/2024/old.md',
        });
        const moved = await fs.readFile(pjoin(tmpRoot, 'skills/global/rn-target/archive/2024/old.md'), 'utf8');
        expect(moved).toBe('body\n');
    });

    test('prunes empty source directories', async () => {
        await repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'references/nested.md', toPath: 'flat.md',
        });
        const refDirExists = await fs.stat(pjoin(tmpRoot, 'skills/global/rn-target/references')).then(() => true).catch(() => false);
        expect(refDirExists).toBe(false);
    });

    test('rejects SKILL.md as source', async () => {
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'SKILL.md', toPath: 'other.md',
        })).rejects.toThrow(/SKILL\.md/);
    });

    test('rejects SKILL.md as target', async () => {
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: 'SKILL.md',
        })).rejects.toThrow(/SKILL\.md/);
    });

    test('rejects when destination already exists', async () => {
        await repo.writeFile({
            scope: { kind: 'global' }, name: 'rn-target',
            path: 'taken.md', content: 'x',
        });
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: 'taken.md',
        })).rejects.toThrow(/already exists/);
    });

    test('rejects when source does not exist', async () => {
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'missing.md', toPath: 'new.md',
        })).rejects.toThrow(/not found/);
    });

    test('rejects path traversal in either path', async () => {
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: '../../etc/passwd', toPath: 'evil.md',
        })).rejects.toThrow();
        await expect(repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: '../../etc/passwd',
        })).rejects.toThrow();
    });

    test('same fromPath / toPath is a no-op returning current sha256', async () => {
        const r = await repo.renameFile({
            scope: { kind: 'global' }, name: 'rn-target',
            fromPath: 'old.md', toPath: 'old.md',
        });
        expect(r.ok).toBe(true);
        expect(r.sha256).toBeTruthy();
        const stillThere = await fs.readFile(pjoin(tmpRoot, 'skills/global/rn-target/old.md'), 'utf8');
        expect(stillThere).toBe('body\n');
    });
});

describe('SkillRepository - readFile', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: `---\nname: rr\ndescription: x\n---\n${lines}\n` },
                    { path: 'references/numbered.md', encoding: 'utf8', content: `${lines}\n` },
                    { path: 'references/big.md', encoding: 'utf8', content: 'x'.repeat(80 * 1024) },
                ],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('reads full SKILL.md by default', async () => {
        const out = await repo.readFile({ scope: { kind: 'global' }, name: 'rr' });
        expect(out.content).toContain('Line 100');
        expect(out.totalLines).toBeGreaterThan(100);
    });

    test('reads line range with offset/limit', async () => {
        // Range is 1-based file-line offset. references/numbered.md has body
        // starting at line 1, so offset=10 lands directly on "Line 10".
        const out = await repo.readFile({
            scope: { kind: 'global' }, name: 'rr',
            path: 'references/numbered.md',
            offset: 10, limit: 3,
        });
        expect(out.content).toContain('Line 10');
        expect(out.content).toContain('Line 12');
        expect(out.content).not.toContain('Line 13');
    });

    test('returns full file content even when large (no arbitrary character cap)', async () => {
        // Regression: a previous 50 KB response cap silently truncated reads
        // and broke `skill_edit_content` calls whose oldString lived past
        // the cut-off — the edit endpoint did a literal string match against
        // the full file, but the model only ever saw the truncated head.
        const out = await repo.readFile({ scope: { kind: 'global' }, name: 'rr', path: 'references/big.md' });
        expect(out.content.length).toBe(80 * 1024);
    });

    test('rejects binary file', async () => {
        await fs.mkdir(pjoin(tmpRoot, 'skills/global/rr/assets'), { recursive: true });
        await fs.writeFile(pjoin(tmpRoot, 'skills/global/rr/assets/bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
        await expect(repo.readFile({ scope: { kind: 'global' }, name: 'rr', path: 'assets/bin.dat' }))
            .rejects.toThrow(/binary/i);
    });

    test('readFile rejects negative offset/limit', async () => {
        await expect(repo.readFile({ scope: { kind: 'global' }, name: 'rr', offset: 0 })).rejects.toThrow(/offset/);
        await expect(repo.readFile({ scope: { kind: 'global' }, name: 'rr', offset: -1 })).rejects.toThrow(/offset/);
        await expect(repo.readFile({ scope: { kind: 'global' }, name: 'rr', limit: -1 })).rejects.toThrow(/limit/);
    });
});

describe('SkillRepository - listFiles', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-listfiles-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: lf\ndescription: x\n---\nbody\n' },
                    { path: 'references/r.md', encoding: 'utf8', content: 'reference\n' },
                ],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('listFiles returns all files sorted', async () => {
        const files = await repo.listFiles({ scope: { kind: 'global' }, name: 'lf' });
        expect(files).toHaveLength(2);
        // walkSkillFiles sorts by localeCompare, which is case-insensitive:
        // 'references/r.md' < 'SKILL.md' under that ordering.
        expect(files.map(f => f.path)).toEqual(['references/r.md', 'SKILL.md']);
        const skillMd = files.find(f => f.path === 'SKILL.md');
        expect(skillMd.buffer.toString('utf8')).toContain('name: lf');
        expect(skillMd.isBinary).toBe(false);
    });

    test('listFiles rejects path traversal in name', async () => {
        await expect(repo.listFiles({ scope: { kind: 'global' }, name: '../etc' }))
            .rejects.toThrow(/illegal skill name/);
    });

    test('listFiles throws on missing skill', async () => {
        await expect(repo.listFiles({ scope: { kind: 'global' }, name: 'missing' }))
            .rejects.toThrow(/skill not found/);
    });
});

describe('SkillRepository - path traversal hardening', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-traversal-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: present\ndescription: x\n---\n' }] },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('get rejects traversal in name', async () => {
        await expect(repo.get('../etc/passwd', { kind: 'global' })).rejects.toThrow(/illegal skill name/);
        await expect(repo.get('..', { kind: 'global' })).rejects.toThrow(/illegal skill name/);
    });

    test('delete rejects traversal in name', async () => {
        await expect(repo.delete('../etc/passwd', { kind: 'global' })).rejects.toThrow(/illegal skill name/);
    });

    test('readFile rejects traversal in name and path', async () => {
        await expect(repo.readFile({ scope: { kind: 'global' }, name: '../etc' })).rejects.toThrow(/illegal skill name/);
        await expect(repo.readFile({ scope: { kind: 'global' }, name: 'present', path: '../../../etc/passwd' })).rejects.toThrow(/illegal file path/);
    });

    test('writeFile rejects traversal in name and path', async () => {
        await expect(repo.writeFile({ scope: { kind: 'global' }, name: '../etc', path: 'x', content: 'x' })).rejects.toThrow(/illegal skill name/);
        await expect(repo.writeFile({ scope: { kind: 'global' }, name: 'present', path: '../escape', content: 'x' })).rejects.toThrow(/illegal file path/);
    });

    test('editFile rejects traversal in name and path', async () => {
        await expect(repo.editFile({ scope: { kind: 'global' }, name: '../etc', path: 'x', oldString: 'a', newString: 'b' })).rejects.toThrow(/illegal skill name/);
        await expect(repo.editFile({ scope: { kind: 'global' }, name: 'present', path: '../escape', oldString: 'a', newString: 'b' })).rejects.toThrow(/illegal file path/);
    });

    test('rename rejects traversal in fromName/toName', async () => {
        await expect(repo.rename({ scope: { kind: 'global' }, fromName: '../etc', toName: 'foo' })).rejects.toThrow(/illegal skill name/);
        await expect(repo.rename({ scope: { kind: 'global' }, fromName: 'present', toName: '../escape' })).rejects.toThrow(/illegal skill name|invalid/);
    });

    test('moveScope rejects traversal in name', async () => {
        await expect(repo.moveScope({
            name: '../etc',
            fromScope: { kind: 'global' },
            toScope: { kind: 'character', characterFile: 'a.png' },
        })).rejects.toThrow(/illegal skill name/);
    });
});

describe('SkillRepository - search', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-search-'));
        repo = createSkillRepository(tmpRoot);
        await repo.install({
            scope: { kind: 'global' },
            payload: {
                files: [{
                    path: 'SKILL.md',
                    encoding: 'utf8',
                    content: '---\nname: sr\ndescription: x\n---\nHello World\nFoo bar baz\nAnother hello\n',
                }],
            },
        });
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    test('search returns matching snippets with line numbers', async () => {
        const out = await repo.search({ scope: { kind: 'global' }, name: 'sr', query: 'hello' });
        expect(out.hits).toHaveLength(2);
        expect(out.hits[0].snippet.toLowerCase()).toContain('hello');
        expect(out.hits[0].lineStart).toBeGreaterThan(0);
        expect(out.hits[0].lineEnd).toBeGreaterThanOrEqual(out.hits[0].lineStart);
        expect(out.hits[0].path).toBe('SKILL.md');
    });

    test('search is case-insensitive', async () => {
        const out = await repo.search({ scope: { kind: 'global' }, name: 'sr', query: 'HELLO' });
        expect(out.hits).toHaveLength(2);
    });

    test('search honors limit', async () => {
        const out = await repo.search({ scope: { kind: 'global' }, name: 'sr', query: 'hello', limit: 1 });
        expect(out.hits).toHaveLength(1);
    });

    test('search returns no hits when query absent', async () => {
        const out = await repo.search({ scope: { kind: 'global' }, name: 'sr', query: 'nonexistent-token' });
        expect(out.hits).toEqual([]);
    });

    test('search rejects empty query', async () => {
        await expect(repo.search({ scope: { kind: 'global' }, name: 'sr', query: '' }))
            .rejects.toThrow(/query/);
    });

    test('search rejects traversal in name', async () => {
        await expect(repo.search({ scope: { kind: 'global' }, name: '../etc', query: 'x' }))
            .rejects.toThrow(/illegal skill name/);
    });

    test('search rejects traversal in path', async () => {
        await expect(repo.search({
            scope: { kind: 'global' },
            name: 'sr',
            query: 'x',
            path: '../../etc/passwd',
        })).rejects.toThrow(/illegal file path/);
    });
});

describe('SkillRepository - scope-level ops (deleteScope / renameScope / copyScope)', () => {
    let tmpRoot, repo;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(pjoin(tmpdir(), 'skill-test-'));
        repo = createSkillRepository(tmpRoot);
    });

    afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

    async function installSkill(scope, name, desc = 'x') {
        await repo.install({
            scope,
            payload: {
                files: [{
                    path: 'SKILL.md',
                    encoding: 'utf8',
                    content: `---\nname: ${name}\ndescription: ${desc}\n---\n`,
                }],
            },
        });
    }

    describe('deleteScope', () => {
        test('removes an entire orch-preset scope directory including all skills', async () => {
            const scope = { kind: 'orch-preset', mode: 'spec', name: 'test-preset' };
            await installSkill(scope, 'alpha');
            await installSkill(scope, 'beta');
            expect((await repo.list({ scope })).map(s => s.name).sort()).toEqual(['alpha', 'beta']);

            await repo.deleteScope(scope);

            const dir = pjoin(tmpRoot, 'skills', 'orch-preset', 'spec', 'test-preset');
            await expect(fs.access(dir)).rejects.toThrow();
        });

        test('is idempotent on missing scope (no throw)', async () => {
            const scope = { kind: 'orch-preset', mode: 'spec', name: 'never-existed' };
            await expect(repo.deleteScope(scope)).resolves.toBeUndefined();
        });

        test('rejects invalid scope kind for orch-preset (missing mode)', async () => {
            await expect(repo.deleteScope({ kind: 'orch-preset', name: 'x' })).rejects.toThrow();
        });

        test('works for preset scope kind (sanity)', async () => {
            const scope = { kind: 'preset', name: 'my-oai-preset' };
            await installSkill(scope, 'gamma');
            await repo.deleteScope(scope);
            const dir = pjoin(tmpRoot, 'skills', 'preset', 'my-oai-preset');
            await expect(fs.access(dir)).rejects.toThrow();
        });
    });

    describe('renameScope', () => {
        test('renames orch-preset scope preserving all skills', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'old-name' };
            await installSkill(fromScope, 'alpha');

            await repo.renameScope(fromScope, { mode: 'spec', name: 'new-name' });

            const oldDir = pjoin(tmpRoot, 'skills', 'orch-preset', 'spec', 'old-name');
            const newDir = pjoin(tmpRoot, 'skills', 'orch-preset', 'spec', 'new-name');
            await expect(fs.access(oldDir)).rejects.toThrow();
            await expect(fs.access(newDir)).resolves.toBeUndefined();

            const listed = await repo.list({ scope: { kind: 'orch-preset', mode: 'spec', name: 'new-name' } });
            expect(listed.map(s => s.name)).toContain('alpha');
        });

        test('rejects orch-preset cross-mode rename (mode must match)', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'foo' };
            await installSkill(fromScope, 'a');
            await expect(repo.renameScope(fromScope, { mode: 'director', name: 'foo' }))
                .rejects.toThrow(/mode/i);
        });

        test('rejects rename when destination already exists', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'src' };
            const dstScope = { kind: 'orch-preset', mode: 'spec', name: 'dst' };
            await installSkill(fromScope, 'a');
            await installSkill(dstScope, 'b');
            await expect(repo.renameScope(fromScope, { mode: 'spec', name: 'dst' }))
                .rejects.toThrow(/exists|already/i);
        });

        test('rejects rename on missing source scope', async () => {
            await expect(repo.renameScope(
                { kind: 'orch-preset', mode: 'spec', name: 'nope' },
                { mode: 'spec', name: 'new' },
            )).rejects.toThrow();
        });

        test('works for preset scope kind with string newName', async () => {
            const fromScope = { kind: 'preset', name: 'old-oai' };
            await installSkill(fromScope, 'a');
            await repo.renameScope(fromScope, 'new-oai');
            const listed = await repo.list({ scope: { kind: 'preset', name: 'new-oai' } });
            expect(listed.map(s => s.name)).toContain('a');
        });
    });

    describe('copyScope', () => {
        test('copies orch-preset scope with all skills to destination', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'src' };
            const toScope = { kind: 'orch-preset', mode: 'spec', name: 'copy' };
            await installSkill(fromScope, 'alpha');
            await installSkill(fromScope, 'beta');

            await repo.copyScope(fromScope, toScope);

            expect((await repo.list({ scope: fromScope })).map(s => s.name).sort())
                .toEqual(['alpha', 'beta']);
            expect((await repo.list({ scope: toScope })).map(s => s.name).sort())
                .toEqual(['alpha', 'beta']);
        });

        test('rejects copy when destination already exists', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'src' };
            const toScope = { kind: 'orch-preset', mode: 'spec', name: 'dst' };
            await installSkill(fromScope, 'a');
            await installSkill(toScope, 'b');
            await expect(repo.copyScope(fromScope, toScope)).rejects.toThrow(/exists|already/i);
        });

        test('rejects copy on missing source', async () => {
            await expect(repo.copyScope(
                { kind: 'orch-preset', mode: 'spec', name: 'nope' },
                { kind: 'orch-preset', mode: 'spec', name: 'x' },
            )).rejects.toThrow();
        });

        test('rejects cross-kind copy (orch-preset to preset)', async () => {
            const fromScope = { kind: 'orch-preset', mode: 'spec', name: 'src' };
            await installSkill(fromScope, 'a');
            await expect(repo.copyScope(fromScope, { kind: 'preset', name: 'x' }))
                .rejects.toThrow(/kind/i);
        });
    });

    describe('list({scope: "all"}) includes orch-preset skills', () => {
        test('orch-preset skills appear in the "all" enumeration', async () => {
            await repo.install({
                scope: { kind: 'orch-preset', mode: 'spec', name: 'preset-a' },
                payload: { files: [{
                    path: 'SKILL.md', encoding: 'utf8',
                    content: '---\nname: orch-a\ndescription: x\n---\n',
                }] },
            });
            await repo.install({
                scope: { kind: 'orch-preset', mode: 'director', name: 'preset-b' },
                payload: { files: [{
                    path: 'SKILL.md', encoding: 'utf8',
                    content: '---\nname: orch-b\ndescription: y\n---\n',
                }] },
            });
            const all = await repo.list({ scope: 'all' });
            const labels = all
                .filter(e => e.scope.kind === 'orch-preset')
                .map(e => `${e.scope.mode}/${e.scope.name}:${e.name}`)
                .sort();
            expect(labels).toEqual(['director/preset-b:orch-b', 'spec/preset-a:orch-a']);
        });
    });
});
