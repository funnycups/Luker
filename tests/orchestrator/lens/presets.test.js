import { test, expect, jest } from '@jest/globals';

const settings = { presetLibraries: { spec: { a: { name: 'A', spec: { stages: [] }, presets: {} } } }, activePresetIds: { spec: 'a' } };
const save = jest.fn(async () => {});
const persist = jest.fn(async () => true);
const ext = { presetLibraries: { spec: { c: { name: 'Card' } } }, activePresetIds: { spec: 'c' } };
const ctx = {
    extensionSettings: { orchestrator: settings },
    characters: [{ avatar: 'x.png', data: { extensions: { orchestrator: ext } } }],
    saveSettings: save,
    saveSettingsDebounced: () => {},
    getExtensionApi: () => ({}),
    getCurrentLocale: () => 'en',
};

const preset = {
    createPreset: jest.fn(() => 'new1'),
    deletePreset: jest.fn(() => true),
    duplicatePreset: jest.fn(() => 'dup1'),
    renamePreset: jest.fn(() => true),
    setActivePresetId: jest.fn(() => true),
    getActivePreset: jest.fn(() => ({ ok: true, state: { name: 'A', spec: {} } })),
    getActivePresetId: jest.fn(() => 'a'),
    getPreset: jest.fn(() => ({ name: 'A', spec: { stages: [] }, presets: {} })),
    listPresets: jest.fn(() => [{ id: 'a', name: 'A' }]),
    sanitizePresetEntry: jest.fn((_, e) => e),
    writeActivePreset: jest.fn(() => ({ ok: true })),
};
const O = '../../../public/scripts/extensions/orchestrator';
const hooks = { copyOrchPresetSkills: jest.fn(), renameOrchPresetSkills: jest.fn(), emitOrchPresetDeleted: jest.fn(), emitOrchPresetExportReady: jest.fn(), emitOrchPresetImportReady: jest.fn() };
const overrides = {
    applyCharacterExecutionModeForAvatar: jest.fn(),
    clearCharacterExtensionForMode: jest.fn(() => ({ cleared: true })),
    getCharacterActivePresetId: jest.fn(() => ''),
    getCharacterExtensionDataByAvatar: jest.fn(() => ext),
    getCharacterIndexByAvatar: jest.fn(() => 0),
    getCharacterPresetLibrary: jest.fn(() => ext.presetLibraries.spec),
};
globalThis.Luker = { getContext: () => ({ ...ctx, addLocaleData: () => {}, translate: s => s }) };
jest.unstable_mockModule(`${O}/preset-library.js`, () => preset);
jest.unstable_mockModule(`${O}/preset-lifecycle-hooks.js`, () => hooks);
jest.unstable_mockModule(`${O}/character-overrides.js`, () => overrides);
jest.unstable_mockModule(`${O}/editor-state.js`, () => ({ initializeUiState: jest.fn(), loadGlobalAgendaEditorState: jest.fn(), loadGlobalDirectorEditorState: jest.fn(), loadGlobalEditorState: jest.fn(() => ({})), loadGlobalLoopEditorState: jest.fn() }));
jest.unstable_mockModule(`${O}/editor-persist.js`, () => ({ persistCharacterAgendaEditor: jest.fn(), persistCharacterDirectorEditor: jest.fn(), persistCharacterEditor: jest.fn(async () => true), persistCharacterLoopEditor: jest.fn(), persistCustomToolsPatch: jest.fn(async () => true), persistOrchestratorCharacterExtension: persist, persistRuntimeLimitsPatch: jest.fn(async () => true) }));
jest.unstable_mockModule(`${O}/preset-io.js`, () => ({
    buildPortablePayloadForMode: jest.fn(() => ({})),
    copyAgendaAgentsIntoSpecEditor: jest.fn(),
    copySpecPresetsIntoAgendaEditor: jest.fn(),
    extractImportedProfileForMode: jest.fn(() => ({ name: 'Imported', spec: {} })),
    parseImportedProfilePayload: jest.fn(() => ({ mode: 'spec', spec: {} })),
}));
jest.unstable_mockModule(`${O}/persistence.js`, () => ({ sanitizeAgentToolFlags: jest.fn(() => ({})) }));
jest.unstable_mockModule(`${O}/agent-resolution.js`, () => ({ sanitizeConnectionProfileName: s => String(s) }));
jest.unstable_mockModule(`${O}/capsule-injection.js`, () => ({ normalizeCapsuleInjectPosition: Number }));
jest.unstable_mockModule(`${O}/editable-spec.js`, () => ({ sanitizeIdentifierToken: s => String(s) }));
jest.unstable_mockModule(`${O}/director-default-prompt.js`, () => ({ buildDirectorDefaultSystemPrompt: () => '' }));
jest.unstable_mockModule(`${O}/prompt-embed-unembedded.js`, () => ({ promptEmbedUnembeddedPresetsForCharacterApply: jest.fn(async () => ({ proceed: true })) }));
jest.unstable_mockModule(`${O}/defaults.js`, () => ({ DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT: 'SYS', DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE: 'USR' }));
jest.unstable_mockModule('../../../public/scripts/iteration-library/runner.js', () => ({ requestToolCallsWithRetry: jest.fn() }));
jest.unstable_mockModule('../../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({ getChatCompletionConnectionProfiles: () => [] }));

const { createPresetAccess, createSettingsAccess, createProfileAccess } = await import(`${O}/lens/source-write.js`);
const host = () => ({ ctx, settings });
const presets = createPresetAccess(host);
const global = { mode: 'spec', scope: 'global', presetId: 'a', avatar: 'x.png' };
const card = { ...global, scope: 'character', presetId: 'c' };

test('create activates the preset and saves settings', async () => {
    await presets.create(global, 'New');
    expect(preset.createPreset).toHaveBeenCalledWith(settings, 'spec', 'global', { name: 'New' }, expect.anything());
    expect(preset.setActivePresetId).toHaveBeenCalledWith(settings, 'spec', 'global', 'new1', expect.anything());
    expect(save).toHaveBeenCalled();
});

test('character scope persists to the card', async () => {
    persist.mockClear();
    await presets.rename(card, 'Renamed');
    expect(preset.renamePreset).toHaveBeenCalledWith(settings, 'spec', 'character', 'c', { name: 'Renamed' }, expect.anything());
    expect(hooks.renameOrchPresetSkills).toHaveBeenCalledWith(ctx, { mode: 'spec', oldName: 'Card', newName: 'Renamed' });
    expect(persist).toHaveBeenCalled();
});

test('picking a global preset clears the card slot', async () => {
    overrides.getCharacterActivePresetId.mockReturnValueOnce('c');
    persist.mockClear();
    await presets.select(card, 'global', 'a');
    expect(preset.setActivePresetId).toHaveBeenCalledWith(settings, 'spec', 'character', '', expect.anything());
    expect(persist).toHaveBeenCalled();
});

test('a stale preset id is reported', async () => {
    preset.setActivePresetId.mockReturnValueOnce(false);
    await expect(presets.select(global, 'global', 'gone')).rejects.toThrow();
});

test('delete fires the lifecycle event', async () => {
    await presets.remove(card);
    expect(preset.deletePreset).toHaveBeenCalled();
    expect(hooks.emitOrchPresetDeleted).toHaveBeenCalledWith(ctx, { mode: 'spec', name: 'Card' });
});

test('duplicate copies skills', async () => {
    await presets.duplicate(card, 'Copy');
    expect(hooks.copyOrchPresetSkills).toHaveBeenCalledWith(ctx, { mode: 'spec', oldName: 'Card', newName: 'Copy' });
});

test('import writes into a new preset and emits', async () => {
    const parsed = presets.parseImport(global, '{"extensions":{"luker":1}}');
    expect(parsed.defaultName).toBe('Imported');
    await presets.importParsed(global, parsed, 'Mine');
    expect(preset.writeActivePreset).toHaveBeenCalled();
    expect(hooks.emitOrchPresetImportReady).toHaveBeenCalledWith(ctx, expect.objectContaining({ mode: 'spec', name: 'Mine', data: expect.objectContaining({ extensions: { luker: 1 } }) }));
});

test('import rejects another mode', () => {
    expect(() => presets.parseImport({ ...global, mode: 'loop' }, '{}')).toThrow();
});

test('clear card and pin', async () => {
    persist.mockClear();
    await presets.clearCharacter(card);
    expect(persist).toHaveBeenCalledWith(ctx, 0, { cleared: true });
    await presets.pinMode(card, 'loop');
    expect(persist.mock.calls.at(-1)[2].override.mode).toBe('loop');
    await presets.pinMode(card, '');
    expect(persist.mock.calls.at(-1)[2].override.mode).toBeUndefined();
});

test('single reset restores both prompts', async () => {
    await presets.resetSingle();
    expect(settings.singleAgentSystemPrompt).toBe('SYS');
    expect(settings.singleAgentUserPromptTemplate).toBe('USR');
});

test('settings are normalized like the native controls', () => {
    const access = createSettingsAccess(host);
    access.set('maxRecentMessages', '0');
    expect(settings.maxRecentMessages).toBe(14);
    access.set('rpmLimit', '-3');
    expect(settings.rpmLimit).toBe(0);
    access.set('capsuleCustomInstruction', '  x ');
    expect(settings.capsuleCustomInstruction).toBe('x');
    access.set('notASetting', 1);
    expect(settings.notASetting).toBeUndefined();
});

test('save runs structural validation', async () => {
    const access = createProfileAccess(host);
    const changes = [{ agentId: '@profile', field: 'spec/stages', before: '[]', after: '[{"id":"s","nodes":[{"id":"x","preset":"missing"}]}]' }];
    await expect(access.save(global, changes, {})).rejects.toThrow(/missing/);
});

test('a failed card write is reported', async () => {
    persist.mockResolvedValueOnce(false);
    await expect(presets.create(card, 'X')).rejects.toThrow();
    overrides.getCharacterIndexByAvatar.mockReturnValueOnce(-1);
    await expect(presets.rename(card, 'Y')).rejects.toThrow();
});

test('a failed preset creation on import is reported', async () => {
    preset.createPreset.mockReturnValueOnce('');
    const parsed = presets.parseImport(global, '{}');
    await expect(presets.importParsed(global, parsed, 'Z')).rejects.toThrow();
});
