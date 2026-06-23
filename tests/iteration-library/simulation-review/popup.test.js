/**
 * @jest-environment jsdom
 *
 * popup-host.js IS mocked here on purpose: the production module wraps
 * SillyTavern's `Popup` (a DOM-mount chain that pulls power-user.js /
 * textgen-models.js — both touch `document` at module-load and cannot
 * be evaluated outside a built browser bundle). The wrapper file even
 * states "kept in its own file so the rest of the simulation-review
 * module can be unit-tested under jsdom by mocking this single module."
 *
 * The mock supplies the user-gesture signal (calling `onSubmit()`) that
 * the real popup would supply when the user clicks the Submit button.
 * Every other surface — the simulation-review module itself, the
 * annotation engine, the section collapse logic, the re-run flow —
 * runs against the real implementation.
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

test('annotation toggle starts off; clicking flips host data-annot-mode and aria title', async () => {
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
    const toggle = capturedRoot.querySelector('.sim-review-annot-toggle');
    expect(toggle).toBeTruthy();
    // The host's data-annot-mode flag gates the pointerup listener so
    // selecting text only annotates when the toggle is on.
    const host = capturedRoot.querySelector('.luker-sim-review');
    expect(host.dataset.annotMode).toBe('off');
    expect(toggle.dataset.state).toBe('off');
    toggle.click();
    expect(host.dataset.annotMode).toBe('on');
    expect(toggle.dataset.state).toBe('on');
    expect(toggle.classList.contains('is-on')).toBe(true);
    toggle.click();
    expect(host.dataset.annotMode).toBe('off');
    expect(toggle.dataset.state).toBe('off');
    expect(toggle.classList.contains('is-on')).toBe(false);
});

test('with annotation mode on, pointerup on a selection wraps the text in <mark[data-ann-id]>', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        const toggle = contentRoot.querySelector('.sim-review-annot-toggle');
        toggle.click();
        // Select a span of text inside the final-output <pre>.
        const pre = contentRoot.querySelector('.luker-sim-pre');
        const textNode = pre.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 5); // "Hello"
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // Fire pointerup on the host — same listener path that mouse,
        // touch, and pen all share.
        const host = contentRoot.querySelector('.luker-sim-review');
        host.dispatchEvent(new Event('pointerup', { bubbles: true }));
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Hello world.',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    const mark = capturedRoot.querySelector('mark[data-ann-id]');
    expect(mark).toBeTruthy();
    // textContent includes the inline × control; check that the
    // annotated snippet is present (the × is appended at the end).
    expect(mark.textContent).toContain('Hello');
    // The × control lives inside the <mark>.
    const removeBtn = mark.querySelector('.sim-review-annot-remove');
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.textContent).toBe('×');
});

test('with annotation mode off, pointerup on a selection does NOT create a mark', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        // Leave the toggle off — selection alone must NOT annotate.
        const pre = contentRoot.querySelector('.luker-sim-pre');
        const textNode = pre.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 5);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const host = contentRoot.querySelector('.luker-sim-review');
        host.dispatchEvent(new Event('pointerup', { bubbles: true }));
        return onSubmit();
    });
    await openSimulationReview({
        kind: 'cea',
        payload: {
            finalOutput: 'Hello world.',
            reasoning: '',
            assembledPrompt: { systemPrompt: 'sys', messages: [] },
            worldInfoHits: [],
        },
        i18n: (k, fb) => fb,
    });
    expect(capturedRoot.querySelector('mark[data-ann-id]')).toBeNull();
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

test('clicking the inline × inside a mark removes the annotation: mark gone, engine state drained', async () => {
    let capturedRoot = null;
    fakePopupHost.open.mockImplementationOnce(async ({ contentRoot, onSubmit }) => {
        document.body.appendChild(contentRoot);
        capturedRoot = contentRoot;
        // Turn annotation mode on and create a mark via the
        // pointerup path so the wiring matches the production flow.
        const toggle = contentRoot.querySelector('.sim-review-annot-toggle');
        toggle.click();
        const pre = contentRoot.querySelector('.luker-sim-pre');
        const textNode = pre.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 5);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const host = contentRoot.querySelector('.luker-sim-review');
        host.dispatchEvent(new Event('pointerup', { bubbles: true }));
        // Click the × — the mark is unwrapped and the chain segments
        // submitted via onSubmit lose the annotationId.
        const removeBtn = host.querySelector('.sim-review-annot-remove');
        removeBtn.click();
        return onSubmit();
    });
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
    expect(capturedRoot.querySelector('mark[data-ann-id]')).toBeNull();
    expect(result.annotations).toEqual([]);
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
