/**
 * Guards the orchestrator's system-prompt lorebook guidance against the
 * old "do not modify" wording slipping back in, and asserts the new write
 * tools are introduced to the model.
 *
 * `LOREBOOK_READ_GUIDANCE_LINES` is spliced into every iter-studio system
 * prompt by `main.js` (`buildAiIterationSystemPrompt`). If the line says
 * "do NOT modify" but the catalog hands the model write tools, the model
 * gets contradictory instructions — these assertions pin the contract.
 *
 * The defaults.js module transitively imports SillyTavern's `script.js`
 * for `extension_prompt_roles` and `world-info.js` for
 * `world_info_position`. Both are stubbed at the module boundary because
 * we only care about the frozen `LOREBOOK_READ_GUIDANCE_LINES` constant.
 */

import { describe, test, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../public/script.js', () => ({
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 },
}));

const { LOREBOOK_READ_GUIDANCE_LINES } = await import('../../public/scripts/extensions/orchestrator/defaults.js');

const fullText = LOREBOOK_READ_GUIDANCE_LINES.join('\n');

describe('LOREBOOK_READ_GUIDANCE_LINES', () => {
    test('drops the legacy "do not modify / edit" prohibitions', () => {
        // Pre-write-tools wording flatly forbade edits. With the new write
        // tools live in the catalog the prompt must allow targeted edits.
        expect(fullText).not.toMatch(/do not modify/i);
        expect(fullText).not.toMatch(/do not edit/i);
        expect(fullText).not.toMatch(/never modify/i);
        expect(fullText).not.toMatch(/never edit/i);
    });

    test('keeps the "do not copy lorebook content into prompts" rule', () => {
        // This one is unchanged — runtime auto-injects active world-info
        // into every sub-agent, so duplicating it into systemPrompts wastes
        // context window.
        expect(fullText).toMatch(/do not copy lorebook/i);
    });

    test('introduces lorebook_update_entry to the model', () => {
        expect(fullText).toMatch(/lorebook_update_entry/);
    });

    test('introduces lorebook_str_replace_in_entry to the model', () => {
        expect(fullText).toMatch(/lorebook_str_replace_in_entry/);
    });

    test('prefers disable over delete as the default repair', () => {
        // Disable preserves the entry text so the user can re-enable later;
        // delete is irreversible. The prompt must reflect that bias so the
        // model defaults to the safer action when reconciling format conflicts.
        expect(fullText).toMatch(/prefer disabling/i);
    });
});
