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

test('onRerun re-renders the popup with the new payload and feeds the new worldInfoHits into the tool result', async () => {
    // Drive the popup-host mock to click the re-run button once before
    // submitting. The bar gets prepended at the top of contentRoot, so we
    // look up `.luker-sim-rerun-btn` and dispatch a click; the re-run
    // path replaces contentRoot's children synchronously after onRerun
    // resolves. The mock awaits a microtask to let the re-mount settle
    // before submitting.
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        const btn = contentRoot.querySelector('.luker-sim-rerun-btn');
        btn.click();
        // Allow the async re-run handler to resolve and re-mount.
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        return onSubmit();
    });
    let runCount = 0;
    const onRerun = jest.fn(async () => {
        runCount += 1;
        return {
            payload: {
                finalOutput: `Reply #${runCount + 1}`,
                reasoning: '',
                assembledPrompt: { systemPrompt: 'sys', messages: [] },
                worldInfoHits: [],
            },
            worldInfoHits: [{ book: 'B', entry: 'E', commentOrName: 'note' }],
        };
    });
    const result = await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Reply #1',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        worldInfoHits: [],
        i18n: (k, fb) => fb,
        onRerun,
    });
    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(false);
    // Chain text should reflect the re-run payload, not the initial one.
    expect(result.chainText).toContain('Reply #2');
    expect(result.chainText).not.toContain('Reply #1');
    // World-info hits captured on the latest successful re-run flow into
    // the tool-result envelope.
    expect(result.chainText).toContain('Lorebook "B"');
});
