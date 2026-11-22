// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Tests for the one-shot configuration prompt migration.
 *
 * The migration hands a user-authored legacy schema-iteration prompt over to
 * the new configuration-iteration prompt slot exactly once. After the marker
 * is stamped, clearing the new slot must never let the legacy text flow back.
 */

import { describe, test, expect } from '@jest/globals';

import {
    CONFIG_PROMPT_SCHEMA_VERSION,
    LEGACY_SCHEMA_ITER_SYSTEM_PROMPT,
    migrateConfigIterationPrompt,
} from '../../public/scripts/extensions/memory-graph/config-iteration/prompt-migration.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from '../../public/scripts/extensions/memory-graph/config-iteration/system-prompt.js';

describe('migrateConfigIterationPrompt', () => {
    test('copies a custom legacy prompt into the new slot and stamps the marker', () => {
        const settings = { schemaIterSystemPrompt: 'my custom schema prompt' };

        expect(migrateConfigIterationPrompt(settings)).toBe(true);
        expect(settings.configIterSystemPrompt).toBe('my custom schema prompt');
        expect(settings.configPromptSchemaVersion).toBe(1);
        expect(settings.schemaIterSystemPrompt).toBe('my custom schema prompt');
    });

    test('preserves all bytes of a custom legacy prompt during migration', () => {
        const custom = '  Use the supplied configuration.\n\n';
        const settings = { schemaIterSystemPrompt: custom };

        expect(migrateConfigIterationPrompt(settings)).toBe(true);
        expect(settings.configIterSystemPrompt).toBe(custom);
        expect(settings.schemaIterSystemPrompt).toBe(custom);
    });

    test('leaves the new slot undefined when the legacy prompt is still the old default', () => {
        const seeded = { schemaIterSystemPrompt: LEGACY_SCHEMA_ITER_SYSTEM_PROMPT };

        expect(migrateConfigIterationPrompt(seeded)).toBe(true);
        expect(seeded.configIterSystemPrompt).toBeUndefined();
        expect(seeded.configPromptSchemaVersion).toBe(1);
    });

    test('does not migrate again once the marker is set', () => {
        const reset = {
            schemaIterSystemPrompt: 'my custom schema prompt',
            configIterSystemPrompt: '',
            configPromptSchemaVersion: 1,
        };

        expect(migrateConfigIterationPrompt(reset)).toBe(false);
        expect(reset.configIterSystemPrompt).toBe('');
    });

    test('a fresh settings object gets the marker without a new prompt value', () => {
        const fresh = {};

        expect(migrateConfigIterationPrompt(fresh)).toBe(true);
        expect(fresh.configIterSystemPrompt).toBeUndefined();
        expect(fresh.configPromptSchemaVersion).toBe(1);
    });

    test('exports the migration marker version and a legacy prompt string distinct from the new default', () => {
        expect(CONFIG_PROMPT_SCHEMA_VERSION).toBe(1);
        expect(typeof LEGACY_SCHEMA_ITER_SYSTEM_PROMPT).toBe('string');
        expect(LEGACY_SCHEMA_ITER_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
        expect(typeof DEFAULT_CONFIG_ITER_SYSTEM_PROMPT).toBe('string');
        expect(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG_ITER_SYSTEM_PROMPT).not.toBe(LEGACY_SCHEMA_ITER_SYSTEM_PROMPT);
    });
});
