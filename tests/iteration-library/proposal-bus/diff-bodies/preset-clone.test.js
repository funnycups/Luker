import { describe, test, expect } from '@jest/globals';
import { renderPresetCloneBody } from '../../../../public/scripts/iteration-library/proposal-bus/diff-bodies/preset-clone.js';

describe('preset-clone diff body', () => {
    const helpers = { i18n: (s, ...args) => args.reduce((acc, a, i) => acc.replaceAll('${' + i + '}', String(a)), String(s)) };

    test('summary names source and destination when op carries both', () => {
        const html = renderPresetCloneBody(null, { sourceName: 'A', newName: 'B' }, helpers);
        expect(html).toContain('A');
        expect(html).toContain('B');
        expect(html).toContain('Will fork');
    });

    test('summary falls back to the generic phrasing when op is missing fields', () => {
        const html = renderPresetCloneBody(null, {}, helpers);
        expect(html).toContain('Will fork the current preset');
    });

    test('warning line is always emitted so the user sees non-rollbackability up-front', () => {
        const html = renderPresetCloneBody(null, { sourceName: 'A', newName: 'B' }, helpers);
        expect(html).toContain('Cannot be auto-rolled back');
    });

    test('source / destination names are HTML-escaped', () => {
        const html = renderPresetCloneBody(null, { sourceName: '<x>', newName: '"y"' }, helpers);
        expect(html).not.toContain('<x>');
        expect(html).toContain('&lt;x&gt;');
        expect(html).toContain('&quot;y&quot;');
    });

    test('snapshot arg is unused — passing null does not throw', () => {
        expect(() => renderPresetCloneBody(null, { sourceName: 'A', newName: 'B' }, helpers)).not.toThrow();
    });
});
