import { createSkillRepository } from '../../src/skills/repository.js';
import { confirmCharacterSkillsExport } from '../../public/scripts/skills/embed-export-hook.js';
import { currentScopeForResources } from '../harness/storage-scope.js';

test('an empty real character repository exports without asking', async () => {
    const root = (await currentScopeForResources().directory('character-export-empty')).path;
    const skills = createSkillRepository(root);
    expect(await confirmCharacterSkillsExport({ context: { skills }, characterFile: 'card.png' })).toBe(false);
    expect(await confirmCharacterSkillsExport({ context: { skills }, characterFile: '' })).toBe(false);
});
