/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

import {
    createRunStore,
    createRecorder,
    createDock,
    HISTORY_KEY,
    parseRunKey,
    attachDock,
    openRunDock,
    toggleRunDock,
    getRunRecorder,
    getRunDockPrefs,
    setRunDockPrefs,
    resetRunDockPosition,
    subscribeRunDockPrefs,
} from '../../public/scripts/run-panel/index.js';
import { registerRunPanelLocaleData } from '../../public/scripts/run-panel/locale-data.js';
import { accountLocalStorage } from '../../public/scripts/lens-shared/current-account.js';

function createMemoryStorage() {
    const map = new Map();
    return {
        map,
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
    };
}

function setAccountContext({ accountsEnabled = false, handle = null, settingsReady = true, translate = (s) => s } = {}) {
    globalThis.Luker = {
        getContext: () => ({
            accountsEnabled,
            currentUser: handle ? { handle } : null,
            settingsReady,
            translate,
            getCurrentLocale: () => 'en',
        }),
    };
}

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
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => `\\${c}`);
    }
});

describe('run-panel recorder & dock', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        globalThis.localStorage.clear();
        setAccountContext({ accountsEnabled: true, handle: 'alice', settingsReady: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('two stores emitting identical runIds are keyed by composite ${source}:${runId} without collision', () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
        const orchStore = createRunStore();
        const searchStore = createRunStore();
        const storage = accountLocalStorage();
        const recorder = createRecorder({ storage });
        recorder.attach(orchStore, 'orchestrator');
        recorder.attach(searchStore, 'search');

        const stopOrch = jest.fn();
        const stopSearch = jest.fn();

        const orchRunId = orchStore.startRun({ mode: 'spec', stopFn: stopOrch });
        const searchRunId = searchStore.startRun({ mode: 'search', stopFn: stopSearch });
        expect(orchRunId).toBe(searchRunId);

        expect(recorder.stop(`search:${searchRunId}`)).toBe(true);
        expect(stopSearch).toHaveBeenCalledTimes(1);
        expect(stopOrch).not.toHaveBeenCalled();

        orchStore.finishRun({ runId: orchRunId, status: 'committed', finalText: 'orch-output' });
        searchStore.finishRun({ runId: searchRunId, status: 'committed', finalText: 'search-output' });

        const history = recorder.history();
        expect(history).toHaveLength(2);
        expect(history.map(r => r.runKey).sort()).toEqual([
            `orchestrator:${orchRunId}`,
            `search:${searchRunId}`,
        ]);
        expect(recorder.getRun(`orchestrator:${orchRunId}`)?.finalText).toBe('orch-output');
        expect(recorder.getRun(`search:${searchRunId}`)?.finalText).toBe('search-output');

        recorder.removeRun(`search:${searchRunId}`);
        const remaining = recorder.history();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].source).toBe('orchestrator');
        expect(remaining[0].runId).toBe(orchRunId);

        const persisted = JSON.parse(globalThis.localStorage.getItem(`${HISTORY_KEY}::alice`));
        expect(persisted).toHaveLength(1);
        expect(persisted[0].source).toBe('orchestrator');

        recorder.detach();
        nowSpy.mockRestore();
    });

    test('dock exportTrace selects the exact ${source}:${runId} run when runIds collide', () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
        const orchStore = createRunStore();
        const searchStore = createRunStore();
        const recorder = createRecorder({ storage: accountLocalStorage() });
        recorder.attach(orchStore, 'orchestrator');
        recorder.attach(searchStore, 'search');

        const orchRunId = orchStore.startRun({ mode: 'spec' });
        orchStore.finishRun({ runId: orchRunId, status: 'committed', finalText: 'orch-only-text' });
        const searchRunId = searchStore.startRun({ mode: 'search' });
        searchStore.finishRun({ runId: searchRunId, status: 'committed', finalText: 'search-only-text' });
        expect(orchRunId).toBe(searchRunId);

        let capturedBlob = null;
        globalThis.URL.createObjectURL = jest.fn((blob) => {
            capturedBlob = blob;
            return 'blob:test';
        });
        globalThis.URL.revokeObjectURL = jest.fn();
        jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        const dock = createDock({ recorder });
        dock.open();
        // Latest started run is search, so dock displays search:${searchRunId}
        const moreBtn = document.querySelector('.rp-dock-more');
        moreBtn.click();
        const exportBtn = [...document.querySelectorAll('.rp-menu-item')].find(el => el.textContent.includes('Export trace'));
        exportBtn.click();

        expect(capturedBlob).not.toBeNull();
        const serialized = dock.serializeCurrentTrace();
        const parsed = JSON.parse(serialized);
        expect(parsed.source).toBe('search');
        expect(parsed.finalText).toBe('search-only-text');

        dock.destroy();
        recorder.detach();
        nowSpy.mockRestore();
    });

    test('accountsEnabled: true without handle returns empty history and never writes to storage', () => {
        setAccountContext({ accountsEnabled: true, handle: null, settingsReady: true });
        const store = createRunStore();
        const recorder = createRecorder({ storage: accountLocalStorage() });
        recorder.attach(store, 'orchestrator');

        const runId = store.startRun({ mode: 'loop' });
        store.finishRun({ runId, status: 'committed', finalText: 'secret-chat-text' });

        expect(globalThis.localStorage.length).toBe(0);
        expect(recorder.history()).toEqual([]);

        recorder.detach();
    });

    test('corrupted localStorage JSON surfaces error and never overwrites existing entry with [snap]', () => {
        const corruptedRaw = '{not valid json!!!';
        globalThis.localStorage.setItem(`${HISTORY_KEY}::alice`, corruptedRaw);

        const errors = [];
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const store = createRunStore();
        const recorder = createRecorder({
            storage: accountLocalStorage(),
            onError: (err) => errors.push(err),
        });
        recorder.attach(store, 'orchestrator');

        const runId = store.startRun({ mode: 'loop' });
        store.finishRun({ runId, status: 'committed', finalText: 'new-run' });

        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0].type).toBe('parse');
        expect(recorder.getStorageError()?.type).toBe('parse');
        expect(consoleSpy).toHaveBeenCalled();
        expect(globalThis.localStorage.getItem(`${HISTORY_KEY}::alice`)).toBe(corruptedRaw);

        recorder.detach();
    });

    test('localStorage quota error surfaces error and preserves existing stored history intact', () => {
        const backing = createMemoryStorage();
        let throwQuota = false;
        const quotaStorage = {
            getHandle: () => 'alice',
            getItem: (k) => backing.getItem(k),
            setItem: (k, v) => {
                if (throwQuota) {
                    throw new DOMException('Quota exceeded', 'QuotaExceededError');
                }
                backing.setItem(k, v);
            },
            removeItem: (k) => backing.removeItem(k),
        };

        const errors = [];
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const store = createRunStore();
        const recorder = createRecorder({
            storage: quotaStorage,
            onError: (err) => errors.push(err),
        });
        recorder.attach(store, 'orchestrator');

        for (let i = 1; i <= 3; i++) {
            const id = store.startRun({ mode: 'loop' });
            store.finishRun({ runId: id, status: 'committed', finalText: `run-${i}` });
        }
        const beforeFailure = backing.getItem(HISTORY_KEY);
        expect(JSON.parse(beforeFailure)).toHaveLength(3);

        throwQuota = true;
        const id4 = store.startRun({ mode: 'loop' });
        store.finishRun({ runId: id4, status: 'committed', finalText: 'run-4' });

        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0].type).toBe('quota');
        expect(recorder.getStorageError()?.type).toBe('quota');
        expect(consoleSpy).toHaveBeenCalled();
        expect(backing.getItem(HISTORY_KEY)).toBe(beforeFailure);

        recorder.detach();
    });

    test('unbounded trace data stays completely intact in history, dock details, and export', () => {
        const longFinal = 'F'.repeat(60000);
        const longSection = 'B'.repeat(60000);
        const longParamValue = 'P'.repeat(2500);
        const argsObj = {};
        for (let i = 1; i <= 20; i++) {
            argsObj[`param_${i}`] = `${i}:${longParamValue}`;
        }

        const store = createRunStore();
        const recorder = createRecorder({ storage: accountLocalStorage() });
        recorder.attach(store, 'orchestrator');

        const runId = store.startRun({ mode: 'loop' });
        const roundId = store.appendRound({ runId, round: { id: 'agent-1', label: 'Round 1' } });
        const tcId = store.ensureSection({
            runId,
            roundId,
            section: { id: 'tool-1', kind: 'tool_call', title: 'Tool: search_tool', meta: { args: argsObj } },
        });
        store.appendToSection({ runId, roundId, sectionId: tcId, delta: JSON.stringify(argsObj) });
        store.setSectionStatus({ runId, roundId, sectionId: tcId, status: 'done' });

        const trId = store.ensureSection({
            runId,
            roundId,
            section: { id: 'tool-result-1', kind: 'tool_result', title: 'Tool: search_tool', meta: { ok: true } },
        });
        store.appendToSection({ runId, roundId, sectionId: trId, delta: longSection });
        store.setSectionStatus({ runId, roundId, sectionId: trId, status: 'done' });

        store.finishRun({ runId, status: 'committed', finalText: longFinal });

        const saved = recorder.history()[0];
        expect(saved.finalText).toBe(longFinal);
        expect(saved.rounds[0].sections[1].body).toBe(longSection);

        const dock = createDock({ recorder });
        dock.open();
        const exported = JSON.parse(dock.serializeCurrentTrace());
        expect(exported.finalText).toBe(longFinal);
        expect(exported.rounds[0].sections[1].body).toBe(longSection);
        expect(exported.rounds[0].sections[0].meta.args.param_20).toBe(`20:${longParamValue}`);

        // Expand the agent row in dock and confirm all 20 parameters and full text are rendered untruncated
        const agentHead = document.querySelector('.rp-dock-agent-head');
        agentHead.click();
        const dts = [...document.querySelectorAll('.rp-dock-detail .rp-kv dt')];
        const dds = [...document.querySelectorAll('.rp-dock-detail .rp-kv dd')];
        expect(dts).toHaveLength(20);
        expect(dts[19].textContent).toBe('param_20');
        expect(dds[19].textContent).toBe(`20:${longParamValue}`);
        expect(document.querySelector('.rp-dock-detail').textContent).not.toContain('…and');

        const resultTextBlock = [...document.querySelectorAll('.rp-dock-detail .rp-textblock')].find(el => el.textContent.startsWith('BBBB'));
        expect(resultTextBlock.textContent).toBe(longSection);

        dock.destroy();
        recorder.detach();
    });

    test('attachDock, openRunDock, toggleRunDock, getRunRecorder load styles idempotently and render safely without innerHTML', async () => {
        const store = createRunStore();
        attachDock(store, { source: 'test-source' });
        attachDock(store, { source: 'test-source' });

        expect(document.querySelectorAll('link[href*="tokens.css"]')).toHaveLength(1);
        expect(document.querySelectorAll('link[href*="dock.css"]')).toHaveLength(1);

        const recorder = getRunRecorder();
        expect(recorder.hasSource('test-source')).toBe(true);

        await openRunDock();
        const dockEl = document.querySelector('.rp-dock');
        expect(dockEl).not.toBeNull();
        expect(dockEl.dataset.state).toBe('open');

        const runId = store.startRun({ mode: 'loop' });
        store.finishRun({ runId, status: 'committed', finalText: '<img src=x onerror="alert(1)"><script>boom()</script>' });
        await new Promise((r) => setTimeout(r, 80));
        expect(dockEl.querySelector('img')).toBeNull();
        expect(dockEl.querySelector('script')).toBeNull();
        expect(dockEl.textContent).toContain('<img src=x onerror="alert(1)"><script>boom()</script>');

        await toggleRunDock();
        expect(dockEl.dataset.state).toBe('closed');
        await toggleRunDock();
        expect(dockEl.dataset.state).toBe('open');
    });

    test('createDock before sign-in lazily reloads prefs on handle change and does not clobber signed-in prefs', () => {
        // Alice previously saved autoOpen: false and a custom position
        globalThis.localStorage.setItem('orchestraLens.dock.v1::alice', JSON.stringify({
            autoOpen: false,
            pos: { right: 88, bottom: 140 },
        }));
        globalThis.localStorage.setItem('orchestraLens.dock.v1::bob', JSON.stringify({
            autoOpen: true,
            pos: { right: 32, bottom: 96 },
        }));

        // Construct dock BEFORE sign-in (accountsEnabled: true, handle: null)
        setAccountContext({ accountsEnabled: true, handle: null, settingsReady: false });
        const store = createRunStore();
        const recorder = createRecorder({ storage: accountLocalStorage() });
        recorder.attach(store, 'orchestrator');

        const dock = createDock({ recorder });

        // Pre-sign-in toggle/save attempts must not clobber Alice's stored prefs
        dock.open();
        const moreBtn = document.querySelector('.rp-dock-more');
        moreBtn?.click();
        const autoItem = [...document.querySelectorAll('.rp-menu-item')].find(el => el.textContent.includes('Open automatically on run'));
        autoItem?.click();
        dock.close();
        expect(JSON.parse(globalThis.localStorage.getItem('orchestraLens.dock.v1::alice'))).toEqual({
            autoOpen: false,
            pos: { right: 88, bottom: 140 },
        });

        // Sign in as Alice -> starting a run respects Alice's autoOpen: false (goes to pill, not open)
        setAccountContext({ accountsEnabled: true, handle: 'alice', settingsReady: true });
        const runId = store.startRun({ mode: 'spec' });
        expect(dock.isOpen()).toBe(false);
        expect(document.querySelector('.rp-dock').dataset.state).toBe('pill');

        // Opening dock applies Alice's saved position and autoOpen: false
        dock.open();
        expect(document.querySelector('.rp-dock').style.right).toBe('88px');
        expect(document.querySelector('.rp-dock').style.bottom).toBe('140px');
        document.querySelector('.rp-dock-more').click();
        const aliceToggle = [...document.querySelectorAll('.rp-menu-item')].find(el => el.textContent.includes('Open automatically on run'));
        expect(aliceToggle.getAttribute('aria-checked')).toBe('false');
        document.querySelector('.rp-dock-more').click(); // close menu

        // Switch account to Bob -> refresh/open reloads Bob's prefs
        setAccountContext({ accountsEnabled: true, handle: 'bob', settingsReady: true });
        dock.open();
        expect(document.querySelector('.rp-dock').style.right).toBe('32px');
        expect(document.querySelector('.rp-dock').style.bottom).toBe('96px');
        document.querySelector('.rp-dock-more').click();
        const bobToggle = [...document.querySelectorAll('.rp-menu-item')].find(el => el.textContent.includes('Open automatically on run'));
        expect(bobToggle.getAttribute('aria-checked')).toBe('true');

        store.finishRun({ runId, status: 'committed', finalText: 'done' });
        dock.destroy();
        recorder.detach();
    });

    test('recorder resets owner, history, and storageError when signed out and reloads on re-sign-in', () => {
        globalThis.localStorage.setItem(`${HISTORY_KEY}::alice`, '{corrupted');
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const recorder = createRecorder({ storage: accountLocalStorage() });

        expect(recorder.history()).toEqual([]);
        expect(recorder.getStorageError()?.type).toBe('parse');

        // Sign out: history and storageError both clear
        setAccountContext({ accountsEnabled: true, handle: null, settingsReady: true });
        expect(recorder.history()).toEqual([]);
        expect(recorder.getStorageError()).toBeNull();

        // Storage gets repaired and same user signs back in: must reload from storage
        globalThis.localStorage.setItem(`${HISTORY_KEY}::alice`, JSON.stringify([
            { source: 'orchestrator', runId: 7, status: 'committed', finalText: 'fresh' },
        ]));
        setAccountContext({ accountsEnabled: true, handle: 'alice', settingsReady: true });
        expect(recorder.history()).toHaveLength(1);
        expect(recorder.getRun('orchestrator:7')?.finalText).toBe('fresh');
        expect(recorder.getStorageError()).toBeNull();
        consoleSpy.mockRestore();
    });

    test('parseRunKey handles { source, runKey } without runId', () => {
        expect(parseRunKey({ source: 'orchestrator', runKey: 'orchestrator:42' })).toEqual({
            source: 'orchestrator',
            runId: '42',
            runKey: 'orchestrator:42',
        });
        expect(parseRunKey({ source: 'search', runKey: '7' })).toEqual({
            source: 'search',
            runId: '7',
            runKey: 'search:7',
        });
    });

    test('dock.destroy cancels pending toastTimer and renderSoon timers', async () => {
        jest.useFakeTimers();
        try {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: jest.fn(async () => {}) },
            });
            const store = createRunStore();
            const recorder = createRecorder({ storage: accountLocalStorage() });
            recorder.attach(store, 'orchestrator');
            const dock = createDock({ recorder });
            dock.open();

            const run1 = store.startRun({ mode: 'spec' });
            store.finishRun({ runId: run1, status: 'committed', finalText: 'done' });
            jest.advanceTimersByTime(60); // flush renderSoon so finalEl + copy button render

            // Click copy button to schedule toastTimer (1600ms)
            const copyBtn = document.querySelector('.rp-dock-final .lw-ibtn');
            expect(copyBtn).not.toBeNull();
            copyBtn.click();
            await Promise.resolve();
            await Promise.resolve();
            const toastEl = document.querySelector('.rp-dock-toast');
            expect(toastEl.hidden).toBe(false);

            // Now schedule a fresh renderSoon (60ms) before destroy
            const run2 = store.startRun({ mode: 'spec' });
            store.appendRound({ runId: run2, round: { id: 'r1', label: 'R1' } });
            jest.advanceTimersByTime(20); // flush recorder.emitSoon rAF (~16ms) -> schedules dock renderSoon (60ms)

            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(3); // ticker + toastTimer + renderSoon

            dock.destroy();
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(5000);
            expect(toastEl.hidden).toBe(false); // toastTimer never fired after destroy
            recorder.detach();
        } finally {
            jest.useRealTimers();
        }
    });

    test('mobile compact viewport uses floating window (small & large), honors defaultSize prefs, and keeps mobilePos separate from desktop pos', () => {
        const origMatchMedia = globalThis.matchMedia;
        const origW = globalThis.innerWidth;
        const origH = globalThis.innerHeight;
        let isCompactViewport = true;
        globalThis.matchMedia = (q) => ({
            matches: q === '(max-width: 860px)' ? isCompactViewport : false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        globalThis.innerWidth = 390;
        globalThis.innerHeight = 844;

        try {
            globalThis.localStorage.setItem('orchestraLens.dock.v1::alice', JSON.stringify({
                autoOpen: true,
                pos: { right: 64, bottom: 110 },
                mobilePos: { right: 18, bottom: 92 },
            }));

            const orchStore = createRunStore();
            const searchStore = createRunStore();
            const recorder = createRecorder({ storage: accountLocalStorage() });
            recorder.attach(orchStore, 'orchestrator');
            recorder.attach(searchStore, 'search');

            const seenPrefs = [];
            const unsub = subscribeRunDockPrefs((p) => seenPrefs.push(p));

            const dock = createDock({ recorder });
            const searchRun = searchStore.startRun({ mode: 'search' });

            const dockEl = document.querySelector('.rp-dock');
            const scrimEl = document.querySelector('.rp-dock-scrim');
            expect(dock.isOpen()).toBe(true);
            expect(dockEl.classList.contains('is-float')).toBe(true);
            expect(dockEl.classList.contains('is-compact')).toBe(true);
            expect(dockEl.dataset.size).toBe('small');
            expect(scrimEl.hidden).toBe(true);
            expect(dockEl.style.right).toBe('18px');
            expect(dockEl.style.bottom).toBe('92px');

            // Switch defaultSize to large via shared prefs API -> live dock updates and shows centered floating modal
            setRunDockPrefs({ defaultSize: 'large' });
            expect(getRunDockPrefs().defaultSize).toBe('large');
            expect(seenPrefs[seenPrefs.length - 1]?.defaultSize).toBe('large');
            expect(dockEl.dataset.size).toBe('large');
            expect(scrimEl.hidden).toBe(false);
            expect(dockEl.style.right).toBe('');
            expect(dockEl.style.left).toBe('12px');

            // User temporarily shrinks to small during search run, then collapses to pill
            dock.setSize('small');
            expect(dockEl.dataset.size).toBe('small');
            searchStore.finishRun({ runId: searchRun, status: 'committed', finalText: 'found' });
            dock.close();

            // Starting a new orchestrator run re-opens in configured defaultSize ('large')
            const orchRun = orchStore.startRun({ mode: 'spec' });
            expect(dock.isOpen()).toBe(true);
            expect(dockEl.dataset.size).toBe('large');
            orchStore.finishRun({ runId: orchRun, status: 'committed', finalText: 'planned' });

            // Desktop pos remained untouched while on mobile; resetRunDockPosition clears both
            const beforeReset = JSON.parse(globalThis.localStorage.getItem('orchestraLens.dock.v1::alice'));
            expect(beforeReset.pos).toEqual({ right: 64, bottom: 110 });
            expect(beforeReset.mobilePos).toEqual({ right: 18, bottom: 92 });

            resetRunDockPosition();
            const afterReset = JSON.parse(globalThis.localStorage.getItem('orchestraLens.dock.v1::alice'));
            expect(afterReset.pos).toBeUndefined();
            expect(afterReset.mobilePos).toBeUndefined();

            // Reset defaultSize back to small and test touch double-tap on header + pill drag without accidental open
            setRunDockPrefs({ defaultSize: 'small' });
            dock.open();
            expect(dockEl.dataset.size).toBe('small');

            const headEl = dockEl.querySelector('.rp-dock-head');
            const firePtr = (el, type, props = {}) => {
                const ev = new Event(type, { bubbles: true, cancelable: true });
                Object.assign(ev, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 180, clientY: 560, ...props });
                el.dispatchEvent(ev);
            };

            // Micro-jitter (<6px) does not drag; second tap within 320ms toggles size small -> large
            const initialRight = dockEl.style.right;
            firePtr(headEl, 'pointerdown', { clientX: 180, clientY: 560 });
            firePtr(headEl, 'pointermove', { clientX: 182, clientY: 561 });
            firePtr(headEl, 'pointerup', { clientX: 182, clientY: 561 });
            expect(dockEl.style.right).toBe(initialRight);
            expect(dockEl.dataset.size).toBe('small');

            firePtr(headEl, 'pointerdown', { clientX: 181, clientY: 560 });
            firePtr(headEl, 'pointerup', { clientX: 181, clientY: 560 });
            expect(dockEl.dataset.size).toBe('large');

            // Double-tap again toggles large -> small
            firePtr(headEl, 'pointerdown', { clientX: 180, clientY: 100 });
            firePtr(headEl, 'pointerup', { clientX: 180, clientY: 100 });
            firePtr(headEl, 'pointerdown', { clientX: 181, clientY: 100 });
            firePtr(headEl, 'pointerup', { clientX: 181, clientY: 100 });
            expect(dockEl.dataset.size).toBe('small');

            // Collapse to pill and test pill drag (>=6px) saves mobilePillPos and suppresses accidental click-to-open
            const collapseBtn = [...headEl.querySelectorAll('button')].find(b => b.title === 'Collapse');
            collapseBtn.click();
            const pillEl = document.querySelector('.rp-dock-pill');
            expect(pillEl.hidden).toBe(false);

            firePtr(pillEl, 'pointerdown', { clientX: 300, clientY: 740 });
            firePtr(pillEl, 'pointermove', { clientX: 240, clientY: 660 });
            firePtr(pillEl, 'pointerup', { clientX: 240, clientY: 660 });
            pillEl.querySelector('.rp-dock-pill-main').click(); // synthetic post-drag click must be ignored
            expect(dock.isOpen()).toBe(false);
            const savedAfterPillDrag = JSON.parse(globalThis.localStorage.getItem('orchestraLens.dock.v1::alice'));
            expect(savedAfterPillDrag.mobilePillPos).toBeDefined();

            // Clean tap on pill opens dock normally
            pillEl.querySelector('.rp-dock-pill-main').click();
            expect(dock.isOpen()).toBe(true);

            resetRunDockPosition();
            expect(JSON.parse(globalThis.localStorage.getItem('orchestraLens.dock.v1::alice')).mobilePillPos).toBeUndefined();

            unsub();
            dock.destroy();
            recorder.detach();
        } finally {
            globalThis.matchMedia = origMatchMedia;
            globalThis.innerWidth = origW;
            globalThis.innerHeight = origH;
        }
    });
});

describe('run-panel locale-data and boundary contracts', () => {
    test('locale-data has matching ZH_CN/ZH_TW keys, no unescaped semicolons, and zero overlap with core locale JSONs', () => {
        const captured = {};
        registerRunPanelLocaleData((locale, data) => {
            captured[locale] = data;
        });

        expect(Object.keys(captured)).toEqual(['zh-cn', 'zh-tw']);
        const cnKeys = Object.keys(captured['zh-cn']).sort();
        const twKeys = Object.keys(captured['zh-tw']).sort();
        expect(cnKeys).toEqual(twKeys);

        for (const key of cnKeys) {
            expect(key.replace(/\\;/g, '')).not.toContain(';');
        }

        const zhCnCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-cn.json', import.meta.url)), 'utf8'));
        const zhTwCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-tw.json', import.meta.url)), 'utf8'));
        for (const key of cnKeys) {
            expect(Object.hasOwn(zhCnCore, key)).toBe(false);
            expect(Object.hasOwn(zhTwCore, key)).toBe(false);
        }
    });

    test('public/scripts/run-panel/ has zero imports from public/scripts/extensions/', () => {
        const dir = fileURLToPath(new URL('../../public/scripts/run-panel/', import.meta.url));
        const files = readdirSync(dir).filter(f => f.endsWith('.js'));
        for (const file of files) {
            const src = readFileSync(`${dir}/${file}`, 'utf8');
            expect(src).not.toMatch(/from\s+['"][^'"]*extensions\//);
            expect(src).not.toMatch(/import\s*\(\s*['"][^'"]*extensions\//);
        }
    });
});
