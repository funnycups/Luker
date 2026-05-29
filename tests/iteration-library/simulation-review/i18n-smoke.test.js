/**
 * @jest-environment jsdom
 *
 * Smoke tests for the simulation-review i18n integration. These exist to
 * catch the regression where plugin executors passed an i18n function that
 * threw when called — the popup would never open and the workbench LLM
 * would see a simulation_failed envelope instead of a user-completed
 * review. The two cases below cover the two real shapes:
 *
 * 1. translate-style: (text, key) => translatedText  (the post-fix path)
 * 2. fallback-only: caller has no live translate() and just returns the
 *    fallback string the popup supplied.
 *
 * Both must complete without throwing so the popup renders to the user.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../public/scripts/iteration-library/simulation-review/popup-host.js', () => ({
    openHostPopup: jest.fn(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        return onSubmit();
    }),
}));

const { openSimulationReview } = await import('../../../public/scripts/iteration-library/simulation-review/index.js');

test('popup tolerates a translate-style i18n function (text first, key second)', async () => {
    const translateStyle = (text, key) => text || key;
    const result = await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Test reply',
            reasoning: 'reasoning trace',
            assembledPrompt: { systemPrompt: 'sys', messages: [{ role: 'user', content: 'q' }] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => translateStyle(fb || k, k),
    });
    expect(result.ok).toBe(true);
    expect(result.toolResultText).toContain('<simulation_result kind="cea" ok="true">');
});

test('popup tolerates a missing translate (fallback-only)', async () => {
    const result = await openSimulationReview({
        kind: 'orch-loop',
        payload: { rounds: [], terminationReason: 'max_rounds' },
        i18n: (_, fb) => fb || '?',
    });
    expect(result.ok).toBe(true);
});
