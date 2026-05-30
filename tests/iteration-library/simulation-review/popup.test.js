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

test('hint banner is rendered at the top of the popup body', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'X',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    const hint = capturedRoot.querySelector('.luker-sim-hint');
    expect(hint).toBeTruthy();
    // Hint mentions the annotation affordance so a user landing on it
    // knows the popup is interactive.
    expect(hint.textContent).toMatch(/Add note/);
    // The hint sits above the controls bar so users see it before any
    // re-run / expand-all chrome.
    const bar = capturedRoot.querySelector('.luker-sim-rerun-bar');
    expect(bar).toBeTruthy();
    expect(hint.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('process sections are marked data-collapsible="true" and final-output is marked data-sim-final-output', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Final.',
            reasoning: 'thinking...',
            assembledPrompt: { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    // Reasoning + Assembled Prompt are process — both are collapsible.
    const collapsibles = capturedRoot.querySelectorAll('[data-collapsible="true"]');
    expect(collapsibles.length).toBeGreaterThan(0);
    // Every collapsible starts collapsed by default so the popup is not
    // an unscrollable wall on open.
    collapsibles.forEach(s => {
        expect(s.classList.contains('luker-sim-section--collapsed')).toBe(true);
    });
    // Final Output is the one section the user MUST see — never
    // collapsible, always tagged for autoscroll.
    const finalOutputs = capturedRoot.querySelectorAll('[data-sim-final-output="true"]');
    expect(finalOutputs.length).toBe(1);
    expect(finalOutputs[0].getAttribute('data-collapsible')).toBeNull();
    expect(finalOutputs[0].classList.contains('luker-sim-section--collapsed')).toBe(false);
});

test('expand/collapse toggle button flips classes on every collapsible', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Final.',
            reasoning: 'thinking...',
            assembledPrompt: { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    const toggle = capturedRoot.querySelector('.luker-sim-toggle-btn');
    expect(toggle).toBeTruthy();
    // Initially everything is collapsed; clicking expands.
    toggle.click();
    const collapsibles = capturedRoot.querySelectorAll('[data-collapsible="true"]');
    collapsibles.forEach(s => {
        expect(s.classList.contains('luker-sim-section--collapsed')).toBe(false);
    });
    // Clicking again re-collapses.
    toggle.click();
    collapsibles.forEach(s => {
        expect(s.classList.contains('luker-sim-section--collapsed')).toBe(true);
    });
});

test('touchend on the host opens the float "+ Add note" button when a selection is active', async () => {
    let observedFloatBtn = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        // Simulate the user selecting text inside the final output.
        const pre = contentRoot.querySelector('.luker-sim-pre');
        expect(pre).toBeTruthy();
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // Fire touchend on the renderedNode (the annotation host).
        const host = contentRoot.querySelector('.luker-sim-review');
        host.dispatchEvent(new Event('touchend', { bubbles: true }));
        // Capture the float button BEFORE openSimulationReview's
        // `finally` cleanup tears it down — the popup teardown
        // happens after onSubmit returns.
        observedFloatBtn = document.body.querySelector('.luker-sim-float-btn');
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Hello.',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    // jsdom doesn't implement Range#getBoundingClientRect, so the
    // popup falls back to viewport-safe defaults — the button still
    // exists and is positioned via fixed CSS coordinates.
    expect(observedFloatBtn).toBeTruthy();
    expect(observedFloatBtn.classList.contains('luker-sim-float-btn')).toBe(true);
    expect(observedFloatBtn.style.position).toBe('fixed');
});

test('openSimulationReview injects the simulation-review stylesheet exactly once', async () => {
    // First call should add a single <link> tag to <head>.
    await openSimulationReview({
        kind: 'cea',
        payload: { finalOutput: 'x', reasoning: '', assembledPrompt: { systemPrompt: '', messages: [] }, worldInfoHits: [] },
        i18n: (_, fb) => fb,
    });
    const link = document.getElementById('luker_simulation_review_stylesheet');
    expect(link).not.toBeNull();
    expect(link.getAttribute('rel')).toBe('stylesheet');
    expect(link.getAttribute('href')).toBe('/scripts/iteration-library/simulation-review/styles.css');

    // Second call must not duplicate.
    await openSimulationReview({
        kind: 'cea',
        payload: { finalOutput: 'x', reasoning: '', assembledPrompt: { systemPrompt: '', messages: [] }, worldInfoHits: [] },
        i18n: (_, fb) => fb,
    });
    const links = document.querySelectorAll('#luker_simulation_review_stylesheet');
    expect(links.length).toBe(1);
});
