// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import * as values from '../../public/scripts/macros/util/variable-values.js';

describe('variable values from an explicit data map', () => {
    test.each([
        [{ note: '  Keep this text.\n' }, 'note', {}, {}, '  Keep this text.\n'],
        [{}, 'missing', {}, {}, ''],
        [{ score: '12.5' }, 'score', {}, {}, 12.5],
        [{ score: '  ' }, 'score', {}, {}, '  '],
        [{ record: '{"score":4,"appearance":{"hair":"silver"}}' }, 'record', { index: 'score' }, {}, 4],
        [{ record: '{"appearance":{"hair":"silver"}}' }, 'record', { index: 'appearance' }, {}, '{"hair":"silver"}'],
        [{ entries: '["first","second"]' }, 'entries', { index: '1' }, {}, 'second'],
        [{ record: '{"score":4}' }, 'record.score', {}, { dotted: true }, 4],
        [{ 'record.score': '7' }, 'record.score', {}, { dotted: true }, 7],
        [{ note: 'stored' }, 'unused', { key: 'note' }, {}, 'stored'],
    ])('reads %j at %s with explicit options', (data, name, args, options, expected) => {
        expect(typeof values.readVariableValue).toBe('function');
        const before = structuredClone(data);
        expect(values.readVariableValue(data, name, args, options)).toBe(expected);
        expect(data).toEqual(before);
    });
});
