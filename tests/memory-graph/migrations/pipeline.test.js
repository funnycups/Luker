import { describe, test, expect } from '@jest/globals';
import { runMigrationPipeline } from '../../../public/scripts/extensions/memory-graph/migrations/index.js';

describe('runMigrationPipeline driver basics', () => {
    test('returns input unchanged when registry has no matching detect', async () => {
        const input = { data: null, meta: null, log: null };
        const ctx = makeMinimalCtx();
        const result = await runMigrationPipeline(input, ctx);
        expect(result.changed).toBe(false);
        expect(result.migrations).toEqual([]);
        expect(result.data).toBeNull();
        expect(result.meta).toBeNull();
        expect(result.log).toBeNull();
    });
});

function makeMinimalCtx() {
    return {
        chat: [],
        isExtractableAssistantMessage: () => false,
        applyMemoryLogEntryToStore: () => {},
        buildObjectPatchOperationsAsync: async () => [],
        FLOOR_STATE_LOG_VERSION: 1,
        SCHEMA_VERSION: 2,
    };
}
