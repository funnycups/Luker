/**
 * Skill embed export helper.
 *
 * Tests `packSkillsForExport`, `attachEmbeddedSkillsSource`, and the
 * convenience wrapper `packAndAttachSkillsForExport`.
 */

import { describe, test, expect, jest } from '@jest/globals';

describe('embed-export-helper — pure helpers', () => {
    test('packSkillsForExport rejects missing scope/context', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        await expect(mod.packSkillsForExport({}))
            .rejects.toThrow(/context.skills missing/);
        await expect(mod.packSkillsForExport({ context: { skills: {} } }))
            .rejects.toThrow(/targetScope missing/);
    });

    test('packSkillsForExport returns null when scope has no skills', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const skills = {
            list: jest.fn(async () => []),
            packForEmbed: jest.fn(),
        };
        const ctx = { skills };
        const out = await mod.packSkillsForExport({
            context: ctx,
            targetScope: { kind: 'character', characterFile: 'A.png' },
        });
        expect(out).toBeNull();
        expect(skills.list).toHaveBeenCalledWith({ scope: { kind: 'character', characterFile: 'A.png' } });
        expect(skills.packForEmbed).not.toHaveBeenCalled();
    });

    test('packSkillsForExport packs all skills from the scope', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const payload = { version: 1, items: [{ name: 'a' }, { name: 'b' }] };
        const skills = {
            list: jest.fn(async () => [
                { name: 'a', scope: { kind: 'global' } },
                { name: 'b', scope: { kind: 'global' } },
            ]),
            packForEmbed: jest.fn(async () => payload),
        };
        const out = await mod.packSkillsForExport({
            context: { skills },
            targetScope: { kind: 'global' },
        });
        expect(out).toBe(payload);
        const callArgs = skills.packForEmbed.mock.calls[0][0];
        expect(callArgs.scope).toEqual({ kind: 'global' });
        expect(callArgs.names).toEqual(['a', 'b']);
        expect(callArgs.mode).toBe('auto');
    });

    test('packSkillsForExport respects explicit mode', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const skills = {
            list: jest.fn(async () => [{ name: 'x', scope: { kind: 'global' } }]),
            packForEmbed: jest.fn(async () => ({ version: 1, items: [] })),
        };
        await mod.packSkillsForExport({
            context: { skills },
            targetScope: { kind: 'global' },
            mode: 'inline-files-v1',
        });
        expect(skills.packForEmbed.mock.calls[0][0].mode).toBe('inline-files-v1');
    });

    test('packSkillsForExport filters out malformed list entries', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const skills = {
            list: jest.fn(async () => [
                { name: 'ok' },
                null,
                { name: '' },
                { name: 123 },
                undefined,
                { name: 'also-ok' },
            ]),
            packForEmbed: jest.fn(async () => ({ version: 1, items: [] })),
        };
        await mod.packSkillsForExport({
            context: { skills },
            targetScope: { kind: 'global' },
        });
        expect(skills.packForEmbed.mock.calls[0][0].names).toEqual(['ok', 'also-ok']);
    });

    test('attachEmbeddedSkillsSource writes payload to canonical path', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const target = {};
        const payload = { version: 1, items: [{ name: 'x' }] };
        const ret = mod.attachEmbeddedSkillsSource(target, payload);
        expect(ret).toBe(target);
        expect(target.extensions.luker.embedded_skills_source).toBe(payload);
    });

    test('attachEmbeddedSkillsSource preserves sibling extensions namespaces', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const target = {
            extensions: {
                chub: { id: '123' },
                luker: { other_field: 'preserved' },
            },
        };
        mod.attachEmbeddedSkillsSource(target, { version: 1, items: [] });
        expect(target.extensions.chub.id).toBe('123');
        expect(target.extensions.luker.other_field).toBe('preserved');
        expect(target.extensions.luker.embedded_skills_source).toBeTruthy();
    });

    test('attachEmbeddedSkillsSource is a no-op on null payload', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const target = {};
        mod.attachEmbeddedSkillsSource(target, null);
        expect(target.extensions).toBeUndefined();
    });

    test('packAndAttachSkillsForExport: scope empty → no mutation', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const skills = {
            list: jest.fn(async () => []),
            packForEmbed: jest.fn(),
        };
        const target = {};
        const ret = await mod.packAndAttachSkillsForExport({
            context: { skills },
            targetScope: { kind: 'global' },
            attachTo: target,
        });
        expect(ret).toBeNull();
        expect(target.extensions).toBeUndefined();
    });

    test('packAndAttachSkillsForExport: scope has skills → attaches', async () => {
        const mod = await import('../../public/scripts/skills/embed-export-helper.js');
        const payload = { version: 1, items: [{ name: 'a' }] };
        const skills = {
            list: jest.fn(async () => [{ name: 'a', scope: { kind: 'global' } }]),
            packForEmbed: jest.fn(async () => payload),
        };
        const target = {};
        const ret = await mod.packAndAttachSkillsForExport({
            context: { skills },
            targetScope: { kind: 'global' },
            attachTo: target,
        });
        expect(ret).toBe(payload);
        expect(target.extensions.luker.embedded_skills_source).toBe(payload);
    });
});
