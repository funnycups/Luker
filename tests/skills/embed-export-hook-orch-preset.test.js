import { mergePackedSkillItems } from '../../public/scripts/skills/packed-skill-items.js';
import { maybeAttachSkillsToOrchPresetExport } from '../../public/scripts/skills/embed-export-hook.js';

// Pure composition fixtures: these are already-packed data, not replacement
// implementations of repository packing, installation or popup decisions.
const item = (name, content) => ({ bundleFormat: 'inline-files-v1', name, files: [{ path: 'SKILL.md', encoding: 'utf8', content }] });
const group = (kind, items) => ({ scope: { kind }, payload: { version: 1, items } });

test('merged packed scopes preserve distinct items', () => {
    const global = item('global-skill', 'GLOBAL');
    const orch = item('orch-skill', 'ORCH');
    expect(mergePackedSkillItems([group('global', [global]), group('orch-preset', [orch])])).toEqual([global, orch]);
});

test('cross-scope collision prefers orchestrator over preset over global independent of arrival order', () => {
    const global = item('shared', 'GLOBAL');
    const preset = item('shared', 'PRESET');
    const orch = item('shared', 'ORCH');
    expect(mergePackedSkillItems([group('global', [global]), group('preset', [preset])])).toEqual([preset]);
    expect(mergePackedSkillItems([group('orch-preset', [orch]), group('global', [global]), group('preset', [preset])])).toEqual([orch]);
});

test('character scopes and malformed packed items never enter orchestrator export', () => {
    expect(mergePackedSkillItems([group('character', [item('private', 'PRIVATE')]), group('global', [null, {}, item('valid', 'VALID')])]))
        .toEqual([item('valid', 'VALID')]);
});

test('missing mode or name is a no-op without consulting a repository or popup', async () => {
    for (const payload of [{ mode: 'director' }, { name: 'Watch' }]) {
        expect(await maybeAttachSkillsToOrchPresetExport({ context: { skills: {} }, payload })).toBe(false);
    }
});
