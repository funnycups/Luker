import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// template.js imports i18n.js — mock it as identity.
jest.unstable_mockModule('../../public/scripts/iteration-studio/i18n.js', () => ({
    i18n: (k) => k,
    i18nFormat: (k, ...args) => `${k}:${args.join('|')}`,
}));

let buildIterationStudioPopupHtml;

beforeAll(async () => {
    ({ buildIterationStudioPopupHtml } = await import('../../public/scripts/iteration-studio/template.js'));
});

describe('buildIterationStudioPopupHtml', () => {
    test('split layout has preview pane slot', () => {
        const html = buildIterationStudioPopupHtml({ popupId: 'p1', layout: 'split', title: 'T' });
        expect(html).toContain('luker-iter-studio--split');
        expect(html).toContain('data-iter-preview-pane');
        expect(html).toContain('data-iter-chat');
        expect(html).toContain('data-iter-reference-select');
    });
    test('popup layout has no preview pane', () => {
        const html = buildIterationStudioPopupHtml({ popupId: 'p2', layout: 'popup', title: 'T' });
        expect(html).toContain('luker-iter-studio--popup');
        expect(html).not.toContain('data-iter-preview-pane');
        expect(html).toContain('data-iter-chat');
    });
    test('escapes title', () => {
        const html = buildIterationStudioPopupHtml({ popupId: 'p3', layout: 'popup', title: '<x>' });
        expect(html).toContain('&lt;x&gt;');
        expect(html).not.toContain('<x>');
    });
});
