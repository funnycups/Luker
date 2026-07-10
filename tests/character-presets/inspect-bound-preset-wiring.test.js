// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Consumer-wiring integration coverage for the shared iter-studio
// `inspect_bound_preset` tool. Verifies:
//
//   1. `iteration-library/tools/index.js` re-exports the shared module as
//      `characterPresetsReads` (so orchestrator iter-studio's destructure
//      `ITER_TOOLS.characterPresetsReads` keeps working).
//
//   2. CEA's editor-iteration tool catalog advertises `inspect_bound_preset`
//      and classifies it as a read tool (so the unified editor routes calls
//      through `runCeaEditorReadTool`, which then reaches the helper API).
//
// The shared executor itself is covered exhaustively in
// `inspect-bound-preset-tool.test.js`; this file only proves both consumer
// surfaces see the tool.

import { jest } from '@jest/globals';

// -- 1. iteration-library/tools/index.js aggregation --

test('iteration-library/tools/index.js re-exports characterPresetsReads namespace', async () => {
    const mod = await import('/scripts/iteration-library/tools/index.js');
    expect(mod.characterPresetsReads).toBeDefined();
    expect(mod.characterPresetsReads.CHARACTER_PRESET_READ_TOOL_NAMES).toContain('inspect_bound_preset');
    expect(typeof mod.characterPresetsReads.isCharacterPresetReadTool).toBe('function');
    expect(typeof mod.characterPresetsReads.runCharacterPresetReadTool).toBe('function');
    expect(Array.isArray(mod.characterPresetsReads.CHARACTER_PRESET_READ_TOOL_DEFS)).toBe(true);
});

// -- 2. CEA editor-iteration tool catalog --

// tools.js imports `runCharacterEditorHelperToolCall` from ../main.js, which
// transitively hits the whole ST bootstrap graph. Mock ../main.js and the
// shared preset-reads module before importing tools.js so we can drive the
// catalog without loading production main.js.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/main.js', () => ({
    runCharacterEditorHelperToolCall: jest.fn(),
}));

const { buildCeaEditorToolSet, isCeaEditorReadTool } = await import(
    '/scripts/extensions/character-editor-assistant/editor-iteration/tools.js'
);

test('CEA editor tool catalog advertises inspect_bound_preset', () => {
    const tools = buildCeaEditorToolSet({}, {}, { hasSearchTools: false });
    const names = tools.map(t => t?.function?.name).filter(Boolean);
    expect(names).toContain('inspect_bound_preset');
});

test('CEA editor classifies inspect_bound_preset as a read tool', () => {
    expect(isCeaEditorReadTool('inspect_bound_preset')).toBe(true);
    // Sanity — obvious non-read names stay classified as non-read so the
    // predicate isn't broadly true.
    expect(isCeaEditorReadTool('cea_set_card_field')).toBe(false);
    expect(isCeaEditorReadTool('nonsense_tool')).toBe(false);
});
