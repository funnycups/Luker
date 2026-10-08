/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';
import { createRunStore } from '../../public/scripts/run-panel/store.js';
import { createRunPanel } from '../../public/scripts/run-panel/panel.js';

const t = (s) => String(s);

beforeAll(() => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => `\\${c}`);
    }
});

describe('createRunPanel', () => {
    test('auto-opens on a non-quiet RUN_STARTED and renders a round', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel' });
        panel.init();
        const runId = store.startRun({ mode: 'search' });
        const root = document.getElementById('test-run-panel');
        expect(root).not.toBeNull();
        expect(root.dataset.state).toBe('open');
        store.appendRound({ runId, round: { id: 'round-1', label: 'Round 1' } });
        expect(root.querySelectorAll('.round')).toHaveLength(1);
        panel.destroy();
    });

    test('does not auto-open on a quiet run', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel-quiet' });
        panel.init();
        store.startRun({ mode: 'search', quiet: true });
        expect(document.getElementById('test-run-panel-quiet')).toBeNull();
        panel.destroy();
    });

    test('open() with no run paints an empty state', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel-empty' });
        panel.open();
        const body = document.querySelector('#test-run-panel-empty .panel-body');
        expect(body.querySelector('.empty-state')).not.toBeNull();
        panel.destroy();
    });

    test('destroy() removes the panel DOM and pill', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel-destroy' });
        panel.init();
        store.startRun({ mode: 'search' });
        expect(document.getElementById('test-run-panel-destroy')).not.toBeNull();
        panel.destroy();
        expect(document.getElementById('test-run-panel-destroy')).toBeNull();
        expect(document.getElementById('test-run-panel-destroy-pill')).toBeNull();
    });

    test('destroy() tears down renderer timers', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel-teardown' });
        const clearSpy = jest.spyOn(globalThis, 'clearInterval');
        panel.init();
        store.startRun({ mode: 'search' });
        panel.destroy();
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    test('renderer streams section bytes and auto-folds on done', async () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'test-run-panel-render' });
        panel.init();
        const runId = store.startRun({ mode: 'search' });
        const roundId = store.appendRound({ runId, round: { id: 'round-1', label: 'Round 1' } });
        const sectionId = store.ensureSection({ runId, roundId, section: { id: 'text', kind: 'text', title: 'Text' } });
        store.appendToSection({ runId, roundId, sectionId, delta: 'hello ' });
        store.appendToSection({ runId, roundId, sectionId, delta: 'world' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const pre = document.querySelector('#test-run-panel-render [data-section-id="text"] pre');
        expect(pre.textContent).toBe('hello world');
        store.setSectionStatus({ runId, roundId, sectionId, status: 'done' });
        const details = document.querySelector('#test-run-panel-render [data-section-id="text"] > details');
        expect(details.open).toBe(false);
        panel.destroy();
    });
});
