// Sanitizer contract test for the flat director profile shape.
//
// Background: the director profile used to carry an outer `director:` wrapper
// key — `{ mode: 'director', director: { mainAgent, subAgents, maxRounds, ... } }`
// — while loop and agenda profiles are flat. The wrapper was the source of a
// load-side trap where bare-director input fed into `sanitizeDirectorProfile`
// silently returned defaults instead of preserving fields (see
// `character-override-load.test.js`). The shape is being unified: every
// director profile is now flat, and the sanitizer auto-detects legacy
// wrapped input so existing on-disk data migrates transparently on read.

import { describe, expect, test } from '@jest/globals';
import {
    createDefaultDirectorProfile,
    sanitizeDirectorProfile,
    ORCH_EXECUTION_MODE_DIRECTOR,
} from '../../../public/scripts/extensions/orchestrator/director-defaults.js';

describe('director profile flat-shape contract', () => {
    test('sanitizeDirectorProfile with flat input returns flat output', () => {
        const input = {
            mode: ORCH_EXECUTION_MODE_DIRECTOR,
            mainAgent: {
                systemPrompt: 'flat-prompt',
                apiPresetName: 'flat-api',
                promptPresetName: 'flat-prompt-preset',
            },
            subAgents: [
                {
                    id: 'flat_sub',
                    description: 'a flat sub-agent',
                    systemPrompt: 'flat-sub-body',
                    apiPresetName: '',
                    promptPresetName: '',
                },
            ],
            maxRounds: 7,
            maxConcurrentSubagents: 2,
            maxTotalSubagentRuns: 9,
            tools: { chat: { read_range: true } },
            discardOnAbort: true,
        };

        const after = sanitizeDirectorProfile(input);

        expect(after.mode).toBe(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(after).not.toHaveProperty('director');
        expect(after.mainAgent.systemPrompt).toBe('flat-prompt');
        expect(after.mainAgent.apiPresetName).toBe('flat-api');
        expect(after.mainAgent.promptPresetName).toBe('flat-prompt-preset');
        expect(after.subAgents).toHaveLength(1);
        expect(after.subAgents[0]).toMatchObject({
            id: 'flat_sub',
            description: 'a flat sub-agent',
            systemPrompt: 'flat-sub-body',
        });
        expect(after.maxRounds).toBe(7);
        expect(after.maxConcurrentSubagents).toBe(2);
        expect(after.maxTotalSubagentRuns).toBe(9);
        expect(after.tools.chat.read_range).toBe(true);
        // finalize forced false on every layer.
        expect(after.tools.finalize).toBe(false);
        expect(after.discardOnAbort).toBe(true);
    });

    test('sanitizeDirectorProfile accepts legacy wrapped input (auto-migrates)', () => {
        // Existing `settings.directorProfile` blobs on disk + V3 portable
        // exports use the wrapped shape. Reading them through the sanitizer
        // must lift to flat output so the migration is transparent.
        const legacyWrapped = {
            mode: ORCH_EXECUTION_MODE_DIRECTOR,
            director: {
                mainAgent: {
                    systemPrompt: 'legacy-prompt',
                    apiPresetName: 'legacy-api',
                    promptPresetName: 'legacy-prompt-preset',
                },
                subAgents: [
                    {
                        id: 'legacy_sub',
                        description: 'legacy sub',
                        systemPrompt: 'legacy-body',
                        apiPresetName: '',
                        promptPresetName: '',
                    },
                ],
                maxRounds: 11,
                maxConcurrentSubagents: 3,
                maxTotalSubagentRuns: 15,
                tools: { lorebook: { get: true } },
                discardOnAbort: false,
            },
        };

        const after = sanitizeDirectorProfile(legacyWrapped);

        expect(after).not.toHaveProperty('director');
        expect(after.mainAgent.systemPrompt).toBe('legacy-prompt');
        expect(after.mainAgent.apiPresetName).toBe('legacy-api');
        expect(after.subAgents).toHaveLength(1);
        expect(after.subAgents[0].id).toBe('legacy_sub');
        expect(after.maxRounds).toBe(11);
        expect(after.maxConcurrentSubagents).toBe(3);
        expect(after.maxTotalSubagentRuns).toBe(15);
        expect(after.tools.lorebook.get).toBe(true);
    });

    test('sanitizeDirectorProfile accepts bare director sub-object (auto-migrates)', () => {
        // Character-card overrides store the BARE director sub-object on the
        // card — `{ mainAgent, subAgents, maxRounds, ... }` with no outer
        // `director:` key (see persistCharacterDirectorEditor). When the
        // loader reads it back, that bare shape must survive sanitize.
        const bareOverride = {
            mainAgent: { systemPrompt: 'override-prompt' },
            subAgents: [
                {
                    id: 'override_sub',
                    description: 'd',
                    systemPrompt: 'b',
                    apiPresetName: '',
                    promptPresetName: '',
                },
            ],
            maxRounds: 6,
            enabled: true,
        };

        const after = sanitizeDirectorProfile(bareOverride);

        expect(after.mainAgent.systemPrompt).toBe('override-prompt');
        expect(after.maxRounds).toBe(6);
        expect(after.subAgents[0].id).toBe('override_sub');
    });

    test('createDefaultDirectorProfile returns flat shape', () => {
        const def = createDefaultDirectorProfile();
        expect(def).not.toHaveProperty('director');
        expect(def.mode).toBe(ORCH_EXECUTION_MODE_DIRECTOR);
        expect(def.mainAgent).toBeDefined();
        expect(typeof def.mainAgent.systemPrompt).toBe('string');
        expect(def.mainAgent.systemPrompt.length).toBeGreaterThan(0);
        expect(Array.isArray(def.subAgents)).toBe(true);
        expect(def.subAgents.length).toBeGreaterThan(0);
        expect(typeof def.maxRounds).toBe('number');
        expect(typeof def.maxConcurrentSubagents).toBe('number');
        expect(typeof def.maxTotalSubagentRuns).toBe('number');
        expect(def.tools).toBeDefined();
        expect(def.tools.finalize).toBe(false);
        expect(typeof def.discardOnAbort).toBe('boolean');
    });

    test('sanitizer is idempotent on flat output', () => {
        const once = sanitizeDirectorProfile(createDefaultDirectorProfile());
        const twice = sanitizeDirectorProfile(once);
        expect(twice).toEqual(once);
    });
});
