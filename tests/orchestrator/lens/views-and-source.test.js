/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, jest } from '@jest/globals';
import { renderSections } from '../../../public/scripts/extensions/orchestrator/lens/views/sections.js';
import { createHistoryView } from '../../../public/scripts/extensions/orchestrator/lens/views/history-view.js';
import { createRunView } from '../../../public/scripts/extensions/orchestrator/lens/views/run-view.js';
import { mountOrchestraLens } from '../../../public/scripts/extensions/orchestrator/lens/app.js';

const ROOT = path.resolve(process.cwd(), '..');
const LENS_DIR = path.join(ROOT, 'public/scripts/extensions/orchestrator/lens');

function listJsFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) out.push(...listJsFiles(full));
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

describe('orchestrator/lens/views/sections.js — no silent truncation', () => {
    test('does not truncate long tool call arguments, dispatch tasks, or > 12 kv entries', () => {
        const longTask = 'A'.repeat(900);
        const longArgVal = 'B'.repeat(700);
        const longRawArgs = 'C'.repeat(1600);
        const manyArgs = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i === 0 ? longArgVal : `v${i}`]));

        const list = renderSections([
            { kind: 'tool_call', title: 'Tool: dispatch_subagent', status: 'done', meta: { args: { subagentId: 'scout', task: longTask } } },
            { kind: 'tool_call', title: 'Tool: chat_search', status: 'done', meta: { args: manyArgs } },
            { kind: 'tool_call', title: 'Tool: custom_raw', status: 'done', body: longRawArgs },
        ], { mode: 'director', agentId: 'main' });

        expect(list.textContent).toContain(longTask);
        expect(list.textContent).toContain(longArgVal);
        expect(list.textContent).toContain('v15');
        expect(list.textContent).toContain(longRawArgs);
    });
});

describe('orchestrator/lens/views/history-view.js — pagination and composite keys', () => {
    test('paginates anchors with Load more instead of silent slice(0, 50)', () => {
        const anchors = Array.from({ length: 65 }, (_, i) => ({
            floor: i + 1,
            capsuleText: `Capsule #${i + 1}`,
            stageOutputs: [],
        }));
        const app = {
            snapshot: () => ({ chatId: 'c1', anchors }),
            recorder: { history: () => [], currents: () => [], removeWhere: jest.fn() },
            runKey: (r) => `${r.source || 'orchestrator'}:${r.runId}`,
            openRun: jest.fn(),
            showText: jest.fn(),
        };
        const view = createHistoryView(app);
        view.render();

        expect(view.el.querySelectorAll('.ol-hrow.is-anchor').length).toBe(50);
        const loadMore = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('加载更多') || b.textContent.includes('Load more'));
        expect(loadMore).toBeTruthy();

        loadMore.click();
        expect(view.el.querySelectorAll('.ol-hrow.is-anchor').length).toBe(65);
    });

    test('Clear records removes by composite source:runId key without wiping other sources sharing runId', () => {
        const runs = [
            { runId: 'r1', source: 'orchestrator', chatId: 'c1', mode: 'spec', status: 'done', startedAtWall: 1000, rounds: [] },
            { runId: 'r1', source: 'search', chatId: 'c2', mode: 'search', status: 'done', startedAtWall: 1000, rounds: [] },
        ];
        const removed = [];
        const origConfirm = globalThis.confirm;
        globalThis.confirm = () => true;
        try {
            const app = {
                snapshot: () => ({ chatId: 'c1', anchors: [] }),
                recorder: {
                    history: () => runs,
                    currents: () => [],
                    removeWhere: (pred) => {
                        for (const item of runs) if (pred(item)) removed.push(`${item.source}:${item.runId}`);
                    },
                },
                runKey: (r) => `${r.source || 'orchestrator'}:${r.runId}`,
                openRun: jest.fn(),
                showText: jest.fn(),
            };
            const view = createHistoryView(app);
            view.render();

            const clearBtn = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('清空') || b.textContent.includes('Clear'));
            clearBtn.click();

            expect(removed).toEqual(['orchestrator:r1']);
        } finally {
            globalThis.confirm = origConfirm;
        }
    });
});

describe('orchestrator/lens zero innerHTML & no legacy dock/ai imports', () => {
    test('zero innerHTML assignments in orchestrator/lens/', () => {
        const files = listJsFiles(LENS_DIR);
        const hits = files.filter(f => /\.innerHTML\s*=/.test(fs.readFileSync(f, 'utf8')));
        expect(hits).toEqual([]);
    });

    test('no extensions.js or dock/ or ai-panel imports in orchestrator/lens/', () => {
        const files = listJsFiles(LENS_DIR);
        const bad = [];
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            if (/from\s+['"][^'"]*extensions\.js['"]/.test(src)) bad.push(f);
            if (/from\s+['"][^'"]*\/dock\//.test(src)) bad.push(f);
            if (/from\s+['"][^'"]*ai-panel\.js['"]/.test(src)) bad.push(f);
        }
        expect(bad).toEqual([]);
    });

    test('mountOrchestraLens does not flash .ol-statelayer spinner when source.load resolves before next animation frame', async () => {
        if (typeof globalThis.ResizeObserver !== 'function') {
            globalThis.ResizeObserver = class { observe() {} disconnect() {} };
        }
        const origRaf = globalThis.requestAnimationFrame;
        const origCaf = globalThis.cancelAnimationFrame;
        const rafCallbacks = new Map();
        let nextId = 1;
        globalThis.requestAnimationFrame = (cb) => {
            const id = nextId++;
            rafCallbacks.set(id, cb);
            return id;
        };
        globalThis.cancelAnimationFrame = (id) => {
            rafCallbacks.delete(id);
        };

        const container = document.createElement('div');
        document.body.appendChild(container);
        try {
            const handle = mountOrchestraLens({
                container,
                embedded: true,
                source: {
                    async load() {
                        return {
                            enabled: false,
                            mode: 'spec',
                            source: 'global',
                            presetName: 'Default',
                            chatKey: 'c1',
                            chatLabel: 'Alice',
                            characterName: 'Alice',
                            settings: { reviewRerunMaxRounds: 1 },
                            profile: { spec: { stages: [] }, presets: {} },
                            target: { scope: 'global', mode: 'spec' },
                        };
                    },
                },
            });

            const stateLayer = container.querySelector('.ol-statelayer');
            expect(stateLayer.hidden).toBe(true);

            await Promise.resolve();
            await Promise.resolve();

            // Flush any remaining rAF callbacks — loading spinner must have been cancelled!
            for (const cb of [...rafCallbacks.values()]) cb(16);
            expect(stateLayer.hidden).toBe(true);
            expect(stateLayer.querySelector('.ol-spinner')).toBeNull();

            handle.destroy();
        } finally {
            globalThis.requestAnimationFrame = origRaf;
            globalThis.cancelAnimationFrame = origCaf;
            container.remove();
        }
    });

    test('run-view omits empty .ol-tl timeline card when run has zero lanes and renders it when lanes exist', () => {
        let activeRun = {
            runId: 'r_empty',
            key: 'orchestrator:r_empty',
            status: 'error',
            mode: 'spec',
            duration: 120,
            tokens: null,
            lanes: [],
            segments: [],
            peakParallel: 0,
            floor: 0,
            error: 'Upstream 502',
            finalText: '',
        };
        const view = createRunView({
            run: () => activeRun,
            state: () => ({ pinnedRunId: '', selectedSegment: '' }),
            setState: jest.fn(),
            flow: () => ({ mode: 'spec' }),
            canAi: () => false,
            notify: jest.fn(),
            inspectAgent: jest.fn(),
        });
        view.render();
        expect(view.el.querySelector('.ol-run-head')).not.toBeNull();
        expect(view.el.querySelector('.ol-tl')).toBeNull();

        const seg = { id: 's1', agentId: 'planner', start: 0, end: 100, duration: 100, status: 'done', sections: [] };
        activeRun = {
            ...activeRun,
            runId: 'r_lanes',
            status: 'committed',
            error: '',
            lanes: [{ agentId: 'planner', totalDuration: 100, segments: [seg] }],
            segments: [seg],
        };
        view.render();
        expect(view.el.querySelector('.ol-tl')).not.toBeNull();

        const runCss = fs.readFileSync(path.join(LENS_DIR, 'css/run.css'), 'utf8');
        expect(runCss).toMatch(/\.olens\s+\.ol-run-head\s*\{[^}]*flex:\s*none;/);
        expect(runCss).toMatch(/\.olens\s+\.ol-run-main\s*\{[^}]*flex:\s*1\s+0\s+auto;/);
    });
});
