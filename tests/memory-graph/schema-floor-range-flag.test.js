/**
 * Verifies the `recordsFloorRange` flag on node-type schemas:
 *   - default `event` type ships with recordsFloorRange:true
 *   - other built-in types are falsy
 *   - normalizeNodeTypeSchema preserves an explicitly-true value
 *   - normalizeNodeTypeSchema defaults a missing value to false
 *
 * main.js transitively pulls script.js / lib.js / popup.js etc. at module
 * load. The shared mock stack at `./_mocks/main-module-stack.js` registers
 * the jest.unstable_mockModule calls at import time so main.js loads under
 * jest. That side-effect import MUST come before any SUT import.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

// ---- SUT import ----
let getDefaultNodeTypeSchema;
let normalizeNodeTypeSchema;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/main.js');
    getDefaultNodeTypeSchema = mod.getDefaultNodeTypeSchema;
    normalizeNodeTypeSchema = mod.normalizeNodeTypeSchema;
});

describe('node-type schema: recordsFloorRange flag', () => {
    test('event type ships with recordsFloorRange:true', () => {
        const schema = getDefaultNodeTypeSchema();
        const event = schema.find(t => t.id === 'event');
        expect(event).toBeDefined();
        expect(event.recordsFloorRange).toBe(true);
    });

    test('other built-in types ship with recordsFloorRange falsy', () => {
        const schema = getDefaultNodeTypeSchema();
        for (const t of schema) {
            if (t.id === 'event') continue;
            expect(Boolean(t.recordsFloorRange)).toBe(false);
        }
    });

    test('normalizeNodeTypeSchema preserves recordsFloorRange:true when present', () => {
        const input = [{ id: 'custom', label: 'Custom', recordsFloorRange: true, tableName: 'custom' }];
        const out = normalizeNodeTypeSchema(input);
        const custom = out.find(t => t.id === 'custom');
        expect(custom?.recordsFloorRange).toBe(true);
    });

    test('normalizeNodeTypeSchema defaults missing recordsFloorRange to false', () => {
        const input = [{ id: 'custom', label: 'Custom', tableName: 'custom' }];
        const out = normalizeNodeTypeSchema(input);
        const custom = out.find(t => t.id === 'custom');
        expect(Boolean(custom?.recordsFloorRange)).toBe(false);
    });
});
