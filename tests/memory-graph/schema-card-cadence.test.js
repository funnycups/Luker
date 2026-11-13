/**
 * Verifies that force-update node types do not carry an extraction cadence:
 *   - the default `event` type (force-update) ships without `extractEveryN`
 *   - `normalizeNodeTypeSchema` does not synthesize `extractEveryN` for
 *     force-update types, but leaves an already-persisted value untouched
 *
 * main.js transitively pulls script.js / lib.js / popup.js etc. at module
 * load. The shared mock stack at `./_mocks/main-module-stack.js` registers
 * the jest.unstable_mockModule calls at import time so main.js loads under
 * jest. That side-effect import MUST come before any SUT import.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

let normalizeNodeTypeSchema;
let getDefaultNodeTypeSchema;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/main.js');
    normalizeNodeTypeSchema = mod.normalizeNodeTypeSchema;
    getDefaultNodeTypeSchema = mod.getDefaultNodeTypeSchema;
});

describe('default node-type schema — event carries no cadence', () => {
    test('event ships without extractEveryN', () => {
        const event = getDefaultNodeTypeSchema().find(t => t.id === 'event');
        expect(event).toBeDefined();
        expect('extractEveryN' in event).toBe(false);
    });
});

describe('normalizeNodeTypeSchema — cadence guard for force-update types', () => {
    test('force-update entry without extractEveryN comes out without the key', () => {
        const out = normalizeNodeTypeSchema([
            { id: 'event', forceUpdate: true, tableName: 'event_table' },
        ]);
        const event = out.find(t => t.id === 'event');
        expect(event).toBeDefined();
        expect('extractEveryN' in event).toBe(false);
    });

    test('force-update entry with a persisted extractEveryN keeps its value', () => {
        const out = normalizeNodeTypeSchema([
            { id: 'event', forceUpdate: true, extractEveryN: 4, tableName: 'event_table' },
        ]);
        const event = out.find(t => t.id === 'event');
        expect(event.extractEveryN).toBe(4);
    });

    test('non-force-update entry still gets extractEveryN filled', () => {
        const out = normalizeNodeTypeSchema([
            { id: 'custom', forceUpdate: false, tableName: 'custom_table' },
        ]);
        const custom = out.find(t => t.id === 'custom');
        expect(custom.extractEveryN).toBe(1);
    });
});
