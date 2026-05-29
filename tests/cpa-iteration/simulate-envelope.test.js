/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';

// Mock the popup-host so we don't depend on SillyTavern's popup,
// and we drive popup-host's onSubmit / onCancel via direct invocation.
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/popup-host.js', () => ({
    openHostPopup: jest.fn(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        return onSubmit();
    }),
}));

// Mock SillyTavern's script.js so generateQuietPrompt returns a canned reply.
jest.unstable_mockModule('../../public/script.js', () => ({
    generateQuietPrompt: jest.fn(async () => 'mocked model reply'),
    // No other functions from script.js are used in our test path; minimal mock.
}));

const { buildSimulationToolResult } = await import('../../public/scripts/iteration-library/simulation-review/index.js');

// We're not loading the full CPA tools module (which would pull in too much
// SillyTavern surface). Instead this test validates that the simulation-review
// module itself produces a CPA-shaped envelope when fed a SingleShotPayload-like
// input. The end-to-end CPA integration is covered by manual smoke + a future
// Playwright e2e.

test('builds a kind=cpa tagged-text envelope with chain + annotations', () => {
    const out = buildSimulationToolResult({
        kind: 'cpa',
        cancelled: false,
        error: null,
        chainSegments: [
            { text: '# Preset Simulation\n\nResponse: ' },
            { text: 'this is dry', annotationId: 1 },
            { text: '.' },
        ],
        annotations: [
            { id: 1, snippet: 'this is dry', comment: 'wants more flavor', path: 'Final Output' },
        ],
        worldInfoHits: [],
    });
    expect(out).toContain('<simulation_result kind="cpa" ok="true">');
    expect(out).toContain('<<<ANNOTATION id=1>>>this is dry<<</ANNOTATION>>>');
    expect(out).toContain('comment: wants more flavor');
});

test('builds the cpa error envelope on simulation failure', () => {
    const out = buildSimulationToolResult({
        kind: 'cpa',
        cancelled: false,
        error: { reason: 'simulation_failed', message: 'API connection lost' },
    });
    expect(out).toContain('<simulation_result kind="cpa" ok="false">');
    expect(out).toContain('<error reason="simulation_failed">');
});
