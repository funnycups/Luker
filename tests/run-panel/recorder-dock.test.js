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
    attachDock,
    openRunDock,
    toggleRunDock,
    getRunRecorder,
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
