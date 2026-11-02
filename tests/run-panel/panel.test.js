/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';
import { createRunStore, createRunPanel } from '../../public/scripts/run-panel/index.js';
import { createActivityPill } from '../../public/scripts/activity-pill.js';

const t = (s) => String(s);
const flushActivations = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const publicPrefixes = ['luker-orch-run-panel', 'luker-search-tools-run-panel'];
const stopThroughControl = ({ root }) => root.querySelector('[data-action="stop"]').click();
const disposalExits = [
    { name: 'destroy running', exit: () => {}, status: 'running', calls: [] },
    { name: 'finish then destroy', exit: ({ store, runId }) => store.finishRun({ runId, status: 'committed' }), status: 'committed', calls: [] },
    { name: 'clear then destroy', exit: ({ store }) => store.clearCurrentRun(), status: null, calls: [] },
    { name: 'stop then destroy', exit: stopThroughControl, status: 'aborted', calls: ['stop'] },
    { name: 'abort then destroy', exit: stopThroughControl, status: 'aborted', calls: ['abort'] },
    { name: 'onStop then destroy', exit: stopThroughControl, status: 'aborted', calls: ['onStop'] },
];

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
    test.each(publicPrefixes.flatMap(idPrefix => disposalExits.map(scenario => ({ idPrefix, ...scenario }))))('$idPrefix queued activation cannot remount after $name', async scenario => {
        const { idPrefix } = scenario;
        const store = createRunStore();
        const liveStore = createRunStore();
        const controlCalls = [];
        let runId;
        const stop = source => () => {
            controlCalls.push(source);
            store.finishRun({ runId, status: 'aborted' });
        };
        const panel = createRunPanel({ store, t, idPrefix, onStop: scenario.name === 'onStop then destroy' ? stop('onStop') : undefined });
        const livePanel = createRunPanel({ store: liveStore, t, idPrefix: 'surviving-run-panel' });
        try {
            panel.init();
            livePanel.init();
            runId = store.startRun({ mode: 'search', stopFn: scenario.name === 'stop then destroy' ? stop('stop') : null, abortFn: stop('abort') });
            const liveRunId = liveStore.startRun({ mode: 'search' });
            const root = document.getElementById(idPrefix);
            const liveRoot = document.getElementById('surviving-run-panel');
            root.querySelector('[data-action="close"]').click();
            liveRoot.querySelector('[data-action="close"]').click();
            const pill = document.getElementById(`${idPrefix}-pill`);
            const livePill = document.getElementById('surviving-run-panel-pill');
            const host = livePill.parentElement;
            const css = document.querySelector('link[href="/css/activity-pill.css"]');
            pill.click();
            scenario.exit({ store, runId, root });
            panel.destroy();
            expect(document.getElementById(idPrefix)).toBeNull();
            expect(document.getElementById(`${idPrefix}-pill`)).toBeNull();
            await flushActivations();
            expect(document.getElementById(idPrefix)).toBeNull();
            expect(document.getElementById(`${idPrefix}-pill`)).toBeNull();
            expect(document.getElementById(`${idPrefix}-css`)).toBeNull();
            expect(store.getCurrentRun()?.status ?? null).toBe(scenario.status);
            expect(controlCalls).toEqual(scenario.calls);
            expect(livePill.isConnected).toBe(true);
            expect(document.querySelector('.activity-pill-host')).toBe(host);
            expect(document.querySelector('link[href="/css/activity-pill.css"]')).toBe(css);
            expect(host.hidden).toBe(false);
            liveStore.appendRound({ runId: liveRunId, round: { id: 'still-subscribed', label: 'Live work' } });
            expect(liveRoot.querySelectorAll('.round')).toHaveLength(1);
            livePill.click();
            await flushActivations();
            expect(liveRoot.dataset.state).toBe('open');
            store.clearCurrentRun();
            store.startRun({ mode: 'search' });
            expect(document.getElementById(idPrefix)).toBeNull();
        } finally {
            panel.destroy();
            livePanel.destroy();
        }
    });

    test.each(publicPrefixes)('%s can explicitly initialize and open a new owner after queued-owner destruction', async idPrefix => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix });
        try {
            panel.init();
            store.startRun({ mode: 'search' });
            const oldRoot = document.getElementById(idPrefix);
            oldRoot.querySelector('[data-action="close"]').click();
            document.getElementById(`${idPrefix}-pill`).click();
            panel.destroy();
            panel.init();
            panel.open();
            const newRoot = document.getElementById(idPrefix);
            expect(newRoot).not.toBe(oldRoot);
            await flushActivations();
            expect(document.getElementById(idPrefix)).toBe(newRoot);
            expect(newRoot.dataset.state).toBe('open');
            store.clearCurrentRun();
            const runId = store.startRun({ mode: 'search' });
            store.appendRound({ runId, round: { id: 'new-owner', label: 'New work' } });
            expect(newRoot.querySelectorAll('.round')).toHaveLength(1);
            expect(document.querySelectorAll('.activity-pill-host')).toHaveLength(1);
        } finally { panel.destroy(); }
    });

    test.each(['luker-orch-run-panel', 'luker-search-tools-run-panel'])('%s close/reopen/finish shares placement without stale pills', async idPrefix => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix, autoOpen: true });
        const sync = createActivityPill({ id: 'sync-test', onOpen: () => {}, onError: error => { throw error; } });
        sync.update({ visible: true, text: 'Syncing Cloud', tone: 'running', loading: true });
        panel.init();
        const runId = store.startRun({ mode: 'search' });
        const root = document.getElementById(idPrefix);
        const pill = document.getElementById(`${idPrefix}-pill`);
        expect(pill.hidden).toBe(true);
        root.querySelector('[data-action="close"]').click();
        expect(pill.hidden).toBe(false);
        expect(pill.classList.contains('luker-run-panel-pill')).toBe(true);
        expect(pill.parentElement).toBe(sync.element.parentElement);
        pill.click();
        await Promise.resolve();
        expect(root.dataset.state).toBe('open');
        expect(pill.hidden).toBe(true);
        root.querySelector('.panel-backdrop').click();
        expect(pill.hidden).toBe(false);
        store.finishRun({ runId, status: 'committed' });
        expect(pill.hidden).toBe(true);
        panel.destroy();
        expect(sync.element.isConnected).toBe(true);
        sync.destroy();
    });

    test.each(['finish', 'clear'])('%s hides a closed running entry and leaves no timers after destruction', action => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'terminal-panel' });
        panel.init();
        const runId = store.startRun({ mode: 'director' });
        document.querySelector('#terminal-panel [data-action="close"]').click();
        const pill = document.getElementById('terminal-panel-pill');
        if (action === 'finish') store.finishRun({ runId, status: 'error', error: 'request failed' });
        else store.clearCurrentRun();
        expect(pill.hidden).toBe(true);
        panel.destroy();
        store.clearCurrentRun();
        expect(document.getElementById('terminal-panel')).toBeNull();
        expect(document.querySelector('.activity-pill-host')).toBeNull();
    });

    test('autoOpen false remains lazy and explicit opening hides a running capsule', () => {
        const store = createRunStore();
        const panel = createRunPanel({ store, t, idPrefix: 'manual-panel', autoOpen: false });
        panel.init();
        store.startRun({ mode: 'search' });
        expect(document.getElementById('manual-panel')).toBeNull();
        panel.open();
        document.querySelector('#manual-panel [data-action="close"]').click();
        panel.open();
        expect(document.getElementById('manual-panel-pill').hidden).toBe(true);
        panel.destroy();
    });
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
