import { jest } from '@jest/globals';
import lodash from 'lodash';

// Pure normalization contract. Application approve/rollback is exercised by
// iterstudio/98 against the real mounted target and persisted card/settings.
jest.unstable_mockModule('../../public/lib.js', () => ({ lodash }));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({ getChatCompletionConnectionProfiles: () => [] }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ addLocaleData: () => {}, translate: s => s, t: s => s }));
globalThis.Luker = { getContext: () => ({ constants: { promptRoles: {}, wiPosition: {} } }) };
const { sanitizePresetMap } = await import('../../public/scripts/extensions/orchestrator/editable-spec.js');

test('normalizing an already-normalized preset map is lossless', () => {
    const once = sanitizePresetMap({
        distiller: { systemPrompt: 'Distill the scene.', userPromptTemplate: 'Chat:\n{{recent_chat}}' },
        critic: { systemPrompt: 'Audit the draft.', userPromptTemplate: 'Draft:\n{{previous_outputs}}' },
        planner: {
            systemPrompt: 'Plan.', userPromptTemplate: 'Go.', apiPresetName: 'conn-a', promptPresetName: 'prompt-b',
            tools: { lorebook: true }, skills: { visible: ['+', 'x'], deny: ['y'] },
        },
    });
    expect(sanitizePresetMap(once)).toEqual(once);
});
