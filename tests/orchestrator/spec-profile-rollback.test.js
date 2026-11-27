// Pure normalization contract. Application approve/rollback is exercised by
// iterstudio/98 against the real mounted target and persisted card/settings.
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
