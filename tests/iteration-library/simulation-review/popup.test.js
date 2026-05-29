/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';

const fakePopupHost = { open: jest.fn() };

jest.unstable_mockModule('../../../public/scripts/iteration-library/simulation-review/popup-host.js', () => ({
    openHostPopup: fakePopupHost.open.mockImplementation(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        return onSubmit();
    }),
}));

const { openSimulationReview } = await import('../../../public/scripts/iteration-library/simulation-review/index.js');

test('openSimulationReview opens popup, submits with no annotations, returns ok+chainText', async () => {
    const result = await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Hello world.',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.annotations).toEqual([]);
    expect(result.chainText).toContain('Hello world.');
});
