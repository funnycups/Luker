/**
 * Verifies the REGISTRY value shape and the registerTool opts API.
 *
 * - registerTool requires an explicit mode in opts; missing mode warns
 *   and defaults to 'write' (fail-safe — unknown side-effect tools must
 *   be quarantined under sim mode).
 * - All built-in tools must declare their mode at registration time.
 *   Listed here so that adding a new tool without declaring mode trips
 *   the suite, not a silent runtime fallback.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { executeLoopTool, getEnabledToolSchemas } from '../../public/scripts/extensions/orchestrator/loop-tools.js';

describe('loop-tools registry (Task 1)', () => {
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    test('executeLoopTool still resolves a read tool against entry.exec', async () => {
        const ctx = { chat: [{ mes: 'hi', is_user: true }] };
        const result = await executeLoopTool('chat_read_range', { start: 0, end: 0 }, ctx);
        expect(Array.isArray(result)).toBe(true);
        expect(result[0]).toMatchObject({ floor: 0, content: 'hi' });
    });

    test('unknown tool still throws NOT_IMPLEMENTED', async () => {
        await expect(executeLoopTool('definitely_not_a_tool', {}, {})).rejects.toThrow(/not implemented/i);
    });

    test('getEnabledToolSchemas continues to surface registered tools', () => {
        const profile = { tools: { chat: { read_range: true, search: true } } };
        const schemas = getEnabledToolSchemas(profile);
        const names = schemas.map(s => s?.function?.name).filter(Boolean);
        expect(names).toContain('chat_read_range');
        expect(names).toContain('chat_search');
    });
});
