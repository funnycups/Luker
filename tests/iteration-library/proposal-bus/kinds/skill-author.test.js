import { describe, test, expect, jest } from '@jest/globals';
import { createSkillAuthorHandler } from '../../../../public/scripts/iteration-library/proposal-bus/kinds/skill-author.js';

describe('skill-author KindHandler', () => {
    test('fingerprint is deterministic over snapshot', async () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(async () => {}),
            readFile: jest.fn(async () => 'live content'),
        });
        const a = await h.fingerprint({ content: 'live content' });
        const b = await h.fingerprint({ content: 'live content' });
        expect(a).toBe(b);
    });

    test('readCurrent for update_content reads target file', async () => {
        const readFile = jest.fn(async () => 'live body');
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile,
        });
        const op = { name: 'skill_update_content', args: { scope: 'user', name: 'skl', path: 'SKILL.md' } };
        const { snapshot, fingerprint } = await h.readCurrent(op);
        expect(readFile).toHaveBeenCalledWith({ scope: 'user', name: 'skl', path: 'SKILL.md' });
        expect(snapshot).toEqual({ content: 'live body' });
        expect(fingerprint).toBe(await h.fingerprint({ content: 'live body' }));
    });

    test('readCurrent for skill_update_frontmatter reads SKILL.md regardless of args.path', async () => {
        const readFile = jest.fn(async () => 'live md');
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile,
        });
        const op = { name: 'skill_update_frontmatter', args: { scope: 'user', name: 'skl', patch: {} } };
        const { snapshot } = await h.readCurrent(op);
        expect(readFile).toHaveBeenCalledWith({ scope: 'user', name: 'skl', path: 'SKILL.md' });
        expect(snapshot).toEqual({ content: 'live md' });
    });

    test('readCurrent for skill_edit_content reads target file', async () => {
        const readFile = jest.fn(async () => 'live');
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile,
        });
        const op = { name: 'skill_edit_content', args: { scope: 'user', name: 'skl', path: 'a.txt', oldString: 'x', newString: 'y' } };
        const { snapshot } = await h.readCurrent(op);
        expect(readFile).toHaveBeenCalledWith({ scope: 'user', name: 'skl', path: 'a.txt' });
        expect(snapshot).toEqual({ content: 'live' });
    });

    test('readCurrent for ops without file-level before returns null snapshot', async () => {
        const readFile = jest.fn();
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile,
        });
        for (const name of ['skill_create', 'skill_rename', 'skill_change_scope', 'skill_delete']) {
            const op = { name, args: {} };
            const { snapshot, fingerprint } = await h.readCurrent(op);
            expect(snapshot).toBeNull();
            expect(fingerprint).toBe(await h.fingerprint(null));
        }
        expect(readFile).not.toHaveBeenCalled();
    });

    test('readCurrent returns null snapshot when readFile throws not-found', async () => {
        const readFile = jest.fn(async () => { throw new Error('404 not found'); });
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile,
        });
        const op = { name: 'skill_update_content', args: { scope: 'user', name: 'skl', path: 'a.txt' } };
        const { snapshot } = await h.readCurrent(op);
        expect(snapshot).toBeNull();
    });

    test('commit forwards op to commitOp', async () => {
        const commitOp = jest.fn(async () => ({ ok: true }));
        const h = createSkillAuthorHandler({
            commitOp,
            readFile: jest.fn(),
        });
        const op = { name: 'skill_update_content', args: { scope: 'user', name: 'skl', path: 'a.txt', content: 'new' } };
        await h.commit(op);
        expect(commitOp).toHaveBeenCalledWith(op);
    });

    test('inverse for skill_update_content / skill_edit_content / skill_update_frontmatter rebuilds writeFile op restoring snapshot', () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
        });
        const snapshot = { content: 'original' };
        for (const name of ['skill_update_content', 'skill_edit_content', 'skill_update_frontmatter']) {
            const args = name === 'skill_update_frontmatter'
                ? { scope: 'user', name: 'skl', patch: {} }
                : { scope: 'user', name: 'skl', path: 'a.txt' };
            const expectedPath = name === 'skill_update_frontmatter' ? 'SKILL.md' : 'a.txt';
            const inv = h.inverse({ name, args }, snapshot);
            expect(inv).toEqual({
                name: 'skill_update_content',
                args: { scope: 'user', name: 'skl', path: expectedPath, content: 'original' },
            });
        }
    });

    test('inverse for non-file ops returns null', () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
        });
        for (const name of ['skill_create', 'skill_rename', 'skill_change_scope', 'skill_delete']) {
            expect(h.inverse({ name, args: {} }, null)).toBeNull();
        }
    });

    test('inverse returns null when snapshot is missing', () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
        });
        const op = { name: 'skill_update_content', args: { scope: 'user', name: 'skl', path: 'a.txt' } };
        expect(h.inverse(op, null)).toBeNull();
        expect(h.inverse(op, undefined)).toBeNull();
    });

    test('label / icon / target produce strings, target includes scope/name/path when relevant', () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
        });
        const entry = { op: { name: 'skill_update_content', args: { scope: 'user', name: 'foo', path: 'bar.md' } } };
        expect(typeof h.label(entry)).toBe('string');
        expect(typeof h.icon(entry)).toBe('string');
        const tgt = h.target(entry);
        expect(tgt).toContain('foo');
        expect(tgt).toContain('bar.md');
    });

    test('renderDiffCard delegates to injected renderer', () => {
        const renderDiff = jest.fn(() => '<x/>');
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
            renderDiff,
        });
        const entry = { snapshot: { content: 'b' }, op: { name: 'skill_update_content', args: { content: 'a' } } };
        const out = h.renderDiffCard(entry, { escapeHtml: (s) => s });
        expect(out).toBe('<x/>');
        expect(renderDiff).toHaveBeenCalledWith(entry.snapshot, entry.op, expect.any(Object));
    });

    test('inverseAvailable is false for ops without inverse capability', () => {
        const h = createSkillAuthorHandler({
            commitOp: jest.fn(),
            readFile: jest.fn(),
        });
        expect(h.inverseAvailable).toBe(true);
    });
});
