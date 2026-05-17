import { describe, expect, test } from '@jest/globals';
import { EditorOpsError } from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

describe('EditorOpsError', () => {
    test('stores code, message, details', () => {
        const e = new EditorOpsError('invalid_offset', 'offset 99 out of range', { details: { offset: 99 } });
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('EditorOpsError');
        expect(e.code).toBe('invalid_offset');
        expect(e.message).toBe('offset 99 out of range');
        expect(e.details).toEqual({ offset: 99 });
    });
});
