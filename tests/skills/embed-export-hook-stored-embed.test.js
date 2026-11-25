import { createSkillRepository } from '../../src/skills/repository.js';
import { maybeAttachSkillsToPresetExport, maybeAttachSkillsToOrchPresetExport } from '../../public/scripts/skills/embed-export-hook.js';
import { currentScopeForResources } from '../harness/storage-scope.js';

const STALE = { version: 1, items: [{ bundleFormat: 'inline-files-v1', name: 'stale', files: [] }] };
const stored = () => ({ temperature: 0.7, extensions: { luker: { embedded_skills_source: STALE, keep: 1 } } });
let skills;
beforeEach(async () => {
    const root = (await currentScopeForResources().directory('export-stored-embed')).path;
    skills = createSkillRepository(root);
});

test('an empty real preset repository removes stored skills and preserves unrelated extensions', async () => {
    const data = stored();
    expect(await maybeAttachSkillsToPresetExport({ context: { skills }, data, presetName: 'p' })).toBe(false);
    expect(data).toEqual({ temperature: 0.7, extensions: { luker: { keep: 1 } } });
});

test('a context without a skills API still strips stored skills', async () => {
    const data = stored();
    expect(await maybeAttachSkillsToPresetExport({ context: {}, data, presetName: 'p' })).toBe(false);
    expect(data.extensions.luker).toEqual({ keep: 1 });
});

test('an empty real orchestrator repository strips stored skills without a confirmation API', async () => {
    const payload = { ...stored(), mode: 'loop', name: 'watch' };
    expect(await maybeAttachSkillsToOrchPresetExport({ context: { skills }, payload })).toBe(false);
    expect(payload.extensions.luker).toEqual({ keep: 1 });
});

test('plugin-unavailable fallback without a confirmation API refuses actual scope inventory', async () => {
    const scope = { kind: 'orch-preset', mode: 'loop', name: 'watch' };
    await skills.install({ scope, payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: tide-log\ndescription: Keep the tide log.\n---\nMark the bell.\n' }] } });
    expect((await skills.list({ scope })).map(skill => skill.name)).toEqual(['tide-log']);
    const payload = { ...stored(), mode: 'loop', name: 'watch' };
    expect(await maybeAttachSkillsToOrchPresetExport({ context: { skills }, payload })).toBe(false);
    expect(payload.extensions.luker).toEqual({ keep: 1 });
});
