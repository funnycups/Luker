/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { clearRegistry } from '../../public/scripts/iteration-library/storage/target-registry.js';
import { skillAuthor, presetClone } from '../../public/scripts/iteration-library/proposal-bus/index.js';
import {
    runIterateTurn,
    createIterateBus,
    buildTurnChanges,
    commitTurnBatch,
    trimMessages,
} from '../../public/scripts/workbench/model/iterate.js';
import { createIteratePage } from '../../public/scripts/workbench/pages/iterate.js';
import { mountWorkbench } from '../../public/scripts/workbench/app.js';
import { createWorkbenchRegistry } from '../../public/scripts/workbench/registry.js';
import { aiRequest } from '../../public/scripts/workbench/source-luker.js';

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createMemorySessionStore() {
    const byScope = new Map();
    const scopeKey = (opts = {}) => JSON.stringify(opts || { scope: 'global' });
    const ensure = (opts) => {
        const k = scopeKey(opts);
        if (!byScope.has(k)) byScope.set(k, []);
        return byScope.get(k);
    };
    return {
        list: jest.fn(async (kind = null, opts = {}) => ensure(opts).filter(s => !kind || s.kind === kind).map(s => JSON.parse(JSON.stringify(s))).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))),
        get: jest.fn(async (id, opts = {}) => {
            for (const list of (opts ? [ensure(opts)] : [...byScope.values()])) {
                const hit = list.find(s => s.id === id);
                if (hit) return JSON.parse(JSON.stringify(hit));
            }
            return null;
        }),
        create: jest.fn(async (fields, opts = {}) => {
            const now = Date.now();
            const s = { id: `it_${Math.random().toString(36).slice(2, 8)}`, title: '', createdAt: now, updatedAt: now, turns: [], ...JSON.parse(JSON.stringify(fields)) };
            ensure(opts).unshift(s);
            return JSON.parse(JSON.stringify(s));
        }),
        update: jest.fn(async (id, patch, opts = {}) => {
            const buckets = opts ? [ensure(opts)] : [...byScope.values()];
            for (const list of buckets) {
                const idx = list.findIndex(s => s.id === id);
                if (idx >= 0) {
                    const next = { ...list[idx], ...JSON.parse(JSON.stringify(patch)), updatedAt: Date.now() };
                    list[idx] = next;
                    return JSON.parse(JSON.stringify(next));
                }
            }
            return null;
        }),
        remove: jest.fn(async (id, opts = {}) => {
            const list = ensure(opts);
            const idx = list.findIndex(s => s.id === id);
            if (idx >= 0) list.splice(idx, 1);
        }),
    };
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
    clearRegistry();
});

afterEach(() => {
    clearRegistry();
    jest.restoreAllMocks();
});

describe('workbench iterate engine', () => {
    test('executes >10 rounds when model keeps calling tools and stops cleanly on AbortController.abort()', async () => {
        let roundCount = 0;
        const result = await runIterateTurn({
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'do 12 edits' },
            ],
            live: { count: 0 },
            tools: [{ type: 'function', function: { name: 'bump' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_call, live) => ({ count: live.count + 1 }),
            request: async () => {
                roundCount++;
                if (roundCount <= 12) {
                    return { text: '', calls: [{ id: `c_${roundCount}`, name: 'bump', args: {} }] };
                }
                return { text: 'All 12 done.', calls: [] };
            },
        });

        expect(roundCount).toBe(13);
        expect(result.live.count).toBe(12);
        expect(result.edits).toHaveLength(12);
        expect(result.text).toBe('All 12 done.');

        // Now test clean abort mid-loop
        const controller = new AbortController();
        let abortRounds = 0;
        await expect(runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'loop' }],
            live: { count: 0 },
            tools: [{ type: 'function', function: { name: 'bump' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_call, live) => ({ count: live.count + 1 }),
            request: async () => {
                abortRounds++;
                if (abortRounds === 3) controller.abort();
                return { text: '', calls: [{ id: `ab_${abortRounds}`, name: 'bump', args: {} }] };
            },
            signal: controller.signal,
        })).rejects.toThrow(/Stopped/);
        expect(abortRounds).toBe(3);

        // trimMessages keeps arbitrarily large payloads intact by default
        const huge = 'X'.repeat(100_000);
        const trimmed = trimMessages([{ role: 'system', content: 's' }, { role: 'user', content: huge }]);
        expect(trimmed[1].content).toBe(huge);
    });

    test('captures full untruncated reasoning and tool call args/results/errors across rounds and avoids duplicate target warnings', async () => {
        const bigArg = 'A'.repeat(20_000);
        const bigRes = 'R'.repeat(25_000);
        let round = 0;
        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'inspect' }],
            live: { v: 1 },
            tools: [
                { type: 'function', function: { name: 'read_big' } },
                { type: 'function', function: { name: 'edit_fail' } },
            ],
            isRead: (n) => n === 'read_big',
            runRead: async (call) => ({ payload: bigRes, echoed: call.args.blob }),
            runEdit: async () => { throw new Error('Anchor not found'); },
            request: async () => {
                round++;
                if (round === 1) {
                    return {
                        text: '',
                        reasoning: 'First thought',
                        calls: [
                            { id: 'tc1', name: 'read_big', args: { blob: bigArg } },
                            { id: 'tc2', name: 'edit_fail', args: { target: 'x' } },
                        ],
                    };
                }
                return { text: 'Checked.', reasoning: 'Second thought', calls: [] };
            },
        });

        expect(turnRes.reasoning).toBe('First thought\n\nSecond thought');
        expect(turnRes.toolCalls).toHaveLength(2);
        expect(turnRes.toolCalls[0]).toMatchObject({
            id: 'tc1',
            name: 'read_big',
            args: { blob: bigArg },
            result: { payload: bigRes, echoed: bigArg },
        });
        expect(turnRes.toolCalls[1]).toMatchObject({
            id: 'tc2',
            name: 'edit_fail',
            args: { target: 'x' },
            error: 'Anchor not found',
        });

        // Creating a second bus with the same targetHandler reference does not warn about overwrite
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const sharedHandler = { read: async () => ({}), write: async () => {}, describe: () => 'x' };
        const kinds = [{ ...skillAuthor, targetHandler: sharedHandler }];
        createIterateBus({ proposalKinds: kinds });
        createIterateBus({ proposalKinds: kinds });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('aiRequest preserves reasoning fields returned by requestToolCallsWithRetry', async () => {
        const runnerSpy = jest.fn(async () => ({
            toolCalls: [],
            assistantText: 'Answer text',
            reasoning: 'Deep reasoning text',
            reasoningBlocks: [{ type: 'thinking', text: 'block' }],
            reasoningDetails: [{ id: 'd1' }],
        }));
        globalThis.Luker = {
            getContext: () => ({
                extensionSettings: { workbench: { ai: { default: { connection: 'c1', preset: 'p1' } } } },
                iterationLibrary: { runner: { requestToolCallsWithRetry: runnerSpy } },
            }),
        };
        try {
            const res = await aiRequest('card', {
                messages: [{ role: 'user', content: 'hi' }],
                tools: [{ type: 'function', function: { name: 't1' } }],
            });
            expect(res.reasoning).toBe('Deep reasoning text');
            expect(res.reasoningBlocks).toEqual([{ type: 'thinking', text: 'block' }]);
            expect(res.reasoningDetails).toEqual([{ id: 'd1' }]);
        } finally {
            delete globalThis.Luker;
        }
    });

    test('multi-kind proposal (field-diff + skill-author / preset-clone) previews, commits selectively, and rolls back field edits on commit error', async () => {
        let diskProfile = { description: 'Original description' };
        let diskSkills = { 'my-skill': { content: 'old skill' } };
        let clonedPresets = [];
        let failSkillWrite = false;

        const fieldUnits = (live) => new Map([
            ['card:description', {
                key: 'card:description',
                label: 'Description',
                group: 'Character card',
                text: live.description,
                fields: { description: live.description },
            }],
        ]);

        const proposalKinds = [
            {
                ...skillAuthor,
                targetHandler: {
                    read: async () => JSON.parse(JSON.stringify(diskSkills)),
                    write: async (_target, next) => {
                        if (failSkillWrite) throw new Error('Skill disk write denied');
                        diskSkills = JSON.parse(JSON.stringify(next));
                    },
                    describe: (t) => `skill:${t.name || 'registry'}`,
                },
                label: (entry) => `Skill ${entry.meta?.skillName || 'edit'}`,
                group: () => 'Skills',
            },
            {
                ...presetClone,
                targetHandler: {
                    read: async (t) => ({ sourceName: t.sourceName, cloned: clonedPresets.slice() }),
                    write: async (t) => { clonedPresets.push(t.newName); },
                    describe: (t) => `${t.sourceName} -> ${t.newName}`,
                },
                label: (entry) => `Clone preset -> ${entry.target?.newName}`,
                group: () => 'Preset',
            },
        ];

        const bus = createIterateBus({ proposalKinds });
        const base = { description: 'Original description' };
        let step = 0;

        const turnRes = await runIterateTurn({
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'improve card + skill + clone' }],
            live: JSON.parse(JSON.stringify(base)),
            tools: [
                { type: 'function', function: { name: 'edit_desc' } },
                { type: 'function', function: { name: 'propose_skill' } },
                { type: 'function', function: { name: 'propose_clone' } },
            ],
            bus,
            proposalKinds,
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (call, live, { propose }) => {
                if (call.name === 'edit_desc') {
                    return { ...live, description: 'Sharper description' };
                }
                if (call.name === 'propose_skill') {
                    await propose({
                        kind: 'skill-author',
                        target: { type: 'skill-registry', name: 'my-skill' },
                        before: diskSkills,
                        after: { 'my-skill': { content: 'new skill' } },
                        meta: { skillName: 'my-skill', before: 'old skill', after: 'new skill' },
                    });
                    return live;
                }
                if (call.name === 'propose_clone') {
                    await propose({
                        kind: 'preset-clone',
                        target: { type: 'preset', sourceName: 'Base', newName: 'Base Copy' },
                        before: { sourceName: 'Base', cloned: [] },
                        after: { sourceName: 'Base', cloned: ['Base Copy'] },
                        op: { sourceName: 'Base', newName: 'Base Copy' },
                    });
                    return live;
                }
                return live;
            },
            request: async () => {
                step++;
                if (step === 1) {
                    return {
                        text: '',
                        calls: [
                            { id: 'c1', name: 'edit_desc', args: {} },
                            { id: 'c2', name: 'propose_skill', args: {} },
                            { id: 'c3', name: 'propose_clone', args: {} },
                        ],
                    };
                }
                return { text: 'Proposed all 3.', calls: [] };
            },
        });

        expect(turnRes.edits).toHaveLength(3);
        expect(turnRes.proposalIds).toHaveLength(2);

        const preview = buildTurnChanges({
            base,
            ai: turnRes.live,
            units: fieldUnits,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: proposalKinds,
        });
        expect(preview).toHaveLength(3);
        expect(preview.map(c => c.proposalKind)).toEqual(['field-diff', 'skill-author', 'preset-clone']);
        expect(preview[2].inverseAvailable).toBe(false);

        const targetObj = {
            units: fieldUnits,
            rebuild: (_b, ai) => JSON.parse(JSON.stringify(ai)),
            commit: async (_ref, prev, next, keys) => {
                const saved = JSON.parse(JSON.stringify(diskProfile));
                diskProfile = JSON.parse(JSON.stringify(next));
                return {
                    applied: keys,
                    skipped: [],
                    failure: '',
                    undo: async () => {
                        diskProfile = saved;
                    },
                };
            },
        };

        // 1) Failure in proposal-bus commit MUST roll back already-committed field edits!
        failSkillWrite = true;
        const selectedKeys = [preview[0].key, preview[1].key];
        await expect(commitTurnBatch({
            target: targetObj,
            targetRef: { scope: 'character', avatar: 'alice.png' },
            base,
            ai: turnRes.live,
            keys: selectedKeys,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: proposalKinds,
        })).rejects.toThrow(/Skill disk write denied/);
        expect(diskProfile.description).toBe('Original description');
        expect(diskSkills['my-skill'].content).toBe('old skill');
        expect(clonedPresets).toEqual([]);

        // 2) Now allow write and commit ONLY field-diff + skill-author (leave preset-clone unselected)
        // Reset parked conflict entry to pending via a fresh proposal or bus retry:
        // Note: bus.approve on 'conflict' re-attempts approval cleanly!
        failSkillWrite = false;
        const handle = await commitTurnBatch({
            target: targetObj,
            targetRef: { scope: 'character', avatar: 'alice.png' },
            base,
            ai: turnRes.live,
            keys: selectedKeys,
            bus,
            proposalIds: turnRes.proposalIds,
            kindAdapters: proposalKinds,
        });

        expect(handle.applied).toEqual(selectedKeys);
        expect(diskProfile.description).toBe('Sharper description');
        expect(diskSkills['my-skill'].content).toBe('new skill');
        expect(clonedPresets).toEqual([]); // preset-clone was NOT selected -> rejected
        const cloneEntry = bus._testOnly_entries().find(e => e.kind === 'preset-clone');
        expect(cloneEntry.status).toBe('rejected');

        // 3) Undo reverses both skill-author and field-diff
        await handle.undo();
        expect(diskProfile.description).toBe('Original description');
        expect(diskSkills['my-skill'].content).toBe('old skill');
    });
});

describe('workbench iterate page (scopes, controls, preview, runId isolation)', () => {
    test('supports global/character/preset/chat scopes, target renderControls & renderPreview slots, and runId/selectionVersion isolation', async () => {
        const sessions = createMemorySessionStore();
        const sessionA = await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Card Session A',
            turns: [{ role: 'user', text: 'A1', at: 1 }, { role: 'ai', text: 'A1 ok', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });
        const sessionB = await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Card Session B',
            turns: [{ role: 'user', text: 'B1', at: 1 }, { role: 'ai', text: 'B1 ok', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });

        let resolveFirstAi;
        let controlReloadCalls = 0;
        const cardTarget = {
            id: 'card',
            label: 'Character card',
            tone: 'card',
            order: 1,
            scopes: async () => ({ character: true, chat: true }),
            load: async (scope) => ({
                live: { description: `Loaded (${scope})` },
                target: { scope, avatar: 'alice.png' },
                title: `Alice (${scope})`,
            }),
            prompt: async () => 'card system prompt',
            tools: async () => [{ type: 'function', function: { name: 'edit_desc' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_call, live) => ({ ...live, description: 'Updated' }),
            units: (live) => new Map([['card:description', { key: 'card:description', label: 'Description', group: 'Card', text: live.description, fields: { description: live.description } }]]),
            rebuild: (_base, ai) => ai,
            commit: async () => ({ applied: ['card:description'], skipped: [], failure: '', undo: async () => {} }),
            renderControls: ({ scope, onReload }) => {
                const btn = document.createElement('button');
                btn.className = 'test-target-ctrl';
                btn.textContent = `Ctrl:${scope}`;
                btn.addEventListener('click', () => { controlReloadCalls++; onReload(); });
                return btn;
            },
            renderPreview: ({ ai }) => {
                const div = document.createElement('div');
                div.className = 'test-target-preview';
                div.textContent = `Preview:${ai?.description || ''}`;
                return div;
            },
        };

        const presetTarget = {
            id: 'preset',
            label: 'Preset',
            tone: 'preset',
            order: 2,
            scopes: async () => ({ preset: true }),
            load: async () => ({ live: { temp: 1 }, target: { scope: 'preset', ref: { collection: 'openai', name: 'Main' } }, title: 'Preset Main' }),
            prompt: async () => 'preset prompt',
            tools: async () => [],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: () => new Map(),
            rebuild: (b) => b,
            commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
        };

        const app = {
            sessions,
            iterateTargets: () => [cardTarget, presetTarget],
            snapshot: () => ({
                chat: { chatId: 'c1.jsonl', label: 'Chat 1', floors: 5, character: { avatar: 'alice.png', name: 'Alice' }, target: { is_group: false, avatar_url: 'alice.png', file_name: 'c1.jsonl' } },
                card: { name: 'Alice', avatar: 'alice.png', books: [] },
                preset: { name: 'Main', ref: { collection: 'openai', name: 'Main' } },
            }),
            settings: () => ({ builtinPrompt: true, reviewChanges: true }),
            history: { record: jest.fn(() => 'h1'), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: jest.fn(() => new Promise((r) => { resolveFirstAi = r; })),
            },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'card', scope: 'character' });
        await flushMicrotasks();

        // Scope chips include character & chat; renderControls & renderPreview are mounted
        const scopeButtons = [...page.el.querySelectorAll('.wb-scope-seg .lw-seg-btn')].map(b => b.textContent);
        expect(scopeButtons.some(t => t.includes('Alice'))).toBe(true);
        expect(scopeButtons.some(t => t.includes('Chat 1'))).toBe(true);

        const ctrlBtn = page.el.querySelector('.test-target-ctrl');
        expect(ctrlBtn).not.toBeNull();
        expect(ctrlBtn.textContent).toBe('Ctrl:character');
        ctrlBtn.click();
        expect(controlReloadCalls).toBe(1);

        const previewPane = page.el.querySelector('.wb-iter-preview');
        expect(previewPane.hidden).toBe(false);
        expect(previewPane.textContent).toContain('Preview:Loaded (character)');

        // Open Session A and send a request
        const openBtnA = [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Card Session A'));
        openBtnA.click();
        await flushMicrotasks();

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Edit description for A';
        sendBtn.click();
        await flushMicrotasks();

        expect(page.el.querySelector('.wb-reads.is-live')).not.toBeNull();
        expect(textarea.disabled).toBe(true);

        // Switch to Session B mid-flight: Session B must NOT show Session A's busy spinner or disable input
        const openBtnB = [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes(sessionB.title));
        openBtnB.click();
        await flushMicrotasks();

        expect(page.el.textContent).toContain('B1 ok');
        expect(page.el.querySelector('.wb-reads.is-live')).toBeNull();
        expect(textarea.disabled).toBe(false);

        // Populated session locks target switch until starting a new conversation
        const presetTabLocked = [...page.el.querySelectorAll('.wb-ws-seg .lw-seg-btn')].find(b => b.textContent.includes('Preset'));
        expect(presetTabLocked.disabled).toBe(true);

        const newChatBtn = [...page.el.querySelectorAll('.wb-sess-head button')].find(b => b.textContent.includes('New conversation'));
        newChatBtn.click();
        await flushMicrotasks();

        // Switch target via segmented control to 'preset': shows 'preset' scope chip and hides preview pane
        const presetTab = [...page.el.querySelectorAll('.wb-ws-seg .lw-seg-btn')].find(b => b.textContent.includes('Preset'));
        expect(presetTab.disabled).toBe(false);
        presetTab.click();
        await flushMicrotasks();

        const presetScopes = [...page.el.querySelectorAll('.wb-scope-seg .lw-seg-btn')].map(b => b.textContent);
        expect(presetScopes.some(t => t.includes('Main'))).toBe(true);
        expect(page.el.querySelector('.wb-iter-preview').hidden).toBe(true);

        // Complete Session A's in-flight request while user is on 'preset': must NOT hijack view back to A or crash
        resolveFirstAi({ text: 'Done A', calls: [] });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(page.el.querySelector('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').textContent).toContain('Preset');
        const updatedA = await sessions.get(sessionA.id, { scope: 'character', avatar: 'alice.png' });
        expect(updatedA.turns.at(-1).text).toBe('Done A');
    });

    test('applies and undoes changes in UI, reports pendingCount/pendingInfo, and replays legacy-imported messages safely', async () => {
        const sessions = createMemorySessionStore();
        await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Imported Card Chat',
            messages: [
                { role: 'user', content: 'Old user msg' },
                { role: 'user', auto: true, content: 'AUTO CONTINUE' },
                { role: 'assistant', content: 'Old AI msg', reasoning: 'Old reasoning', toolCalls: [{ id: 't1', name: 'read' }] },
            ],
            turns: [
                { role: 'user', text: 'Old user msg', at: 1 },
                { role: 'ai', text: 'Old AI msg', reasoning: 'Old reasoning', reads: 1, at: 2 },
            ],
        }, { scope: 'character', avatar: 'alice.png' });

        let diskDesc = 'Before';
        let recordedUndo = null;
        const sentPayloads = [];
        const cardTarget = {
            id: 'card',
            label: 'Character card',
            tone: 'card',
            scopes: async () => ({ character: true }),
            load: async () => ({ live: { description: diskDesc }, target: { scope: 'character', avatar: 'alice.png' }, title: 'Alice' }),
            prompt: async () => 'card sys',
            tools: async () => [{ type: 'function', function: { name: 'edit_desc' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, live) => ({ ...live, description: 'After' }),
            units: (live) => new Map([['card:description', { key: 'card:description', label: 'Description', group: 'Card', text: live.description, fields: { description: live.description } }]]),
            rebuild: (_b, ai) => ai,
            commit: async (_t, _b, next, keys) => {
                const prev = diskDesc;
                diskDesc = next.description;
                return { applied: keys, skipped: [], failure: '', undo: async () => { diskDesc = prev; } };
            },
        };

        let callIdx = 0;
        const app = {
            sessions,
            iterateTargets: () => [cardTarget],
            snapshot: () => ({ chat: { character: { avatar: 'alice.png', name: 'Alice' } }, card: { name: 'Alice', avatar: 'alice.png' } }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: {
                record: jest.fn(({ undo }) => { recordedUndo = undo; return 'hist_1'; }),
                canUndo: (id) => id === 'hist_1' && typeof recordedUndo === 'function',
                undo: jest.fn(async () => { await recordedUndo(); recordedUndo = null; }),
            },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: jest.fn(async (_role, { messages }) => {
                    sentPayloads.push(JSON.parse(JSON.stringify(messages)));
                    callIdx++;
                    if (callIdx === 1) return { text: '', calls: [{ id: 'e1', name: 'edit_desc', args: {} }] };
                    return { text: 'Updated description.', calls: [] };
                }),
            },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'card', scope: 'character' });
        await flushMicrotasks();

        const openImported = [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Imported Card Chat'));
        openImported.click();
        await flushMicrotasks();
        expect(page.el.textContent).toContain('Old reasoning');

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Refine again';
        sendBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();

        // Legacy auto:true dropped, toolCalls/reasoning normalized to clean {role, content}
        expect(sentPayloads[0].some(m => m.content === 'AUTO CONTINUE')).toBe(false);
        expect(sentPayloads[0][1]).toEqual({ role: 'user', content: 'Old user msg' });
        expect(sentPayloads[0][2]).toEqual({ role: 'assistant', content: 'Old AI msg' });

        expect(page.pendingCount()).toBe(1);
        expect(page.pendingInfo()).toMatchObject({ pending: 1, sessionTitle: 'Imported Card Chat' });

        // Click Apply selected in changeList
        const applyBtn = [...page.el.querySelectorAll('.wb-chg-foot button')].find(b => b.textContent.includes('Apply selected'));
        applyBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();

        expect(diskDesc).toBe('After');
        expect(page.pendingCount()).toBe(0);
        expect(page.pendingInfo()).toBeNull();

        // Click Undo on the applied card
        const undoBtn = [...page.el.querySelectorAll('.wb-chg-foot button')].find(b => b.textContent.includes('Undo'));
        undoBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(diskDesc).toBe('Before');
    });

    test('renders reasoning, edits-only summary pill, expandable untruncated tool trace, and drops empty legacy assistant turns on follow-up', async () => {
        const sessions = createMemorySessionStore();
        const hugeLegacyArg = 'L'.repeat(15_000);
        const hugeLiveRes = 'Z'.repeat(18_000);
        await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Tool Trace Session',
            messages: [
                { role: 'user', content: 'Old Q' },
                { role: 'assistant', content: '', toolCalls: [{ id: 'leg1', name: 'legacy_read', args: { blob: hugeLegacyArg }, result: 'leg ok' }] },
                { role: 'assistant', content: 'Final legacy reply' },
            ],
            turns: [
                { role: 'user', text: 'Old Q', at: 1 },
                { role: 'ai', text: 'Final legacy reply', toolCalls: [{ id: 'leg1', name: 'legacy_read', args: { blob: hugeLegacyArg }, result: 'leg ok' }], at: 2 },
            ],
        }, { scope: 'character', avatar: 'alice.png' });

        const sentPayloads = [];
        let round = 0;
        const cardTarget = {
            id: 'card',
            label: 'Character card',
            tone: 'card',
            scopes: async () => ({ character: true }),
            load: async () => ({ live: { description: 'Init' }, target: { scope: 'character', avatar: 'alice.png' }, title: 'Alice' }),
            prompt: async () => 'sys',
            tools: async () => [{ type: 'function', function: { name: 'edit_only' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, live) => ({ ...live, description: `Changed:${hugeLiveRes}` }),
            units: (live) => new Map([['card:description', { key: 'card:description', label: 'Desc', group: 'Card', text: live.description, fields: { description: live.description } }]]),
            rebuild: (_b, ai) => ai,
            commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
        };

        const app = {
            sessions,
            iterateTargets: () => [cardTarget],
            snapshot: () => ({ chat: { character: { avatar: 'alice.png', name: 'Alice' } }, card: { name: 'Alice', avatar: 'alice.png' } }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: { record: jest.fn(() => 'h1'), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: jest.fn(async (_r, { messages }) => {
                    sentPayloads.push(JSON.parse(JSON.stringify(messages)));
                    round++;
                    if (round === 1) {
                        return {
                            text: '',
                            reasoning: 'Thought step 1',
                            calls: [{ id: 'ed1', name: 'edit_only', args: { detail: hugeLiveRes } }],
                        };
                    }
                    return { text: 'Done.', reasoning: 'Thought step 2', calls: [] };
                }),
            },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'card', scope: 'character' });
        await flushMicrotasks();

        const openBtn = [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Tool Trace Session'));
        openBtn.click();
        await flushMicrotasks();

        // Legacy toolCalls expandable trace displays complete untruncated args
        const traceBefore = page.el.querySelector('.wb-tool-trace');
        expect(traceBefore).not.toBeNull();
        expect(traceBefore.textContent).toContain('legacy_read');
        expect(traceBefore.textContent).toContain(hugeLegacyArg);

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Edit directly without reading';
        sendBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();

        // Empty assistant message from legacy import must NOT be sent to API
        expect(sentPayloads[0].some(m => m.role === 'assistant' && !m.tool_calls && m.content === '')).toBe(false);
        expect(sentPayloads[0].some(m => m.role === 'assistant' && m.content === 'Final legacy reply')).toBe(true);

        // Live turn renders reasoning, edits-only pill (0 reads, 1 edit), and full untruncated tool call trace
        expect(page.el.textContent).toContain('Thought step 1');
        expect(page.el.textContent).toContain('Thought step 2');
        const pills = [...page.el.querySelectorAll('.wb-reads')].map(el => el.textContent);
        expect(pills.some(t => t.includes('Edited 1 times'))).toBe(true);
        const traces = [...page.el.querySelectorAll('.wb-tool-trace')];
        expect(traces.at(-1).textContent).toContain('edit_only');
        expect(traces.at(-1).textContent).toContain(hugeLiveRes);
        expect(traces.at(-1).textContent).toContain('pending_review');
    });

    test('guards show(sessionId), onSnapshot scope identity changes, and send scope isolation against stale async completions', async () => {
        const byScope = new Map();
        const scopeKey = (opts) => JSON.stringify(opts);
        const sessions = {
            list: jest.fn(async (_k, opts) => (byScope.get(scopeKey(opts)) || []).map(s => JSON.parse(JSON.stringify(s)))),
            get: jest.fn(async (id, opts) => {
                if (opts == null) {
                    for (const list of byScope.values()) {
                        const hit = list.find(s => s.id === id);
                        if (hit) return JSON.parse(JSON.stringify(hit));
                    }
                    return null;
                }
                const hit = (byScope.get(scopeKey(opts)) || []).find(s => s.id === id);
                return hit ? JSON.parse(JSON.stringify(hit)) : null;
            }),
            create: jest.fn(async (fields, opts) => {
                const s = { id: 's_created', turns: [], createdAt: 1, updatedAt: 1, ...fields };
                const k = scopeKey(opts);
                byScope.set(k, [s, ...(byScope.get(k) || [])]);
                return JSON.parse(JSON.stringify(s));
            }),
            update: jest.fn(async (id, patch, opts) => {
                const list = byScope.get(scopeKey(opts)) || [];
                const idx = list.findIndex(s => s.id === id);
                if (idx < 0) return null;
                list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
                return JSON.parse(JSON.stringify(list[idx]));
            }),
        };

        byScope.set(scopeKey({ scope: 'preset', target: { collection: 'openai', name: 'P1' } }), [
            { id: 's_p1', kind: 'iterate', ws: 'preset', scope: 'preset', title: 'P1 Chat', updatedAt: 10, turns: [{ role: 'user', text: 'Q1', at: 1 }, { role: 'ai', text: 'A1', at: 2 }] },
        ]);
        byScope.set(scopeKey({ scope: 'preset', target: { collection: 'openai', name: 'P2' } }), [
            { id: 's_p2', kind: 'iterate', ws: 'preset', scope: 'preset', title: 'P2 Chat', updatedAt: 20, turns: [{ role: 'user', text: 'Q2', at: 1 }, { role: 'ai', text: 'A2', at: 2 }] },
        ]);

        let activePreset = 'P1';
        let loadCall = 0;
        let rejectLoadP1;
        const presetTarget = {
            id: 'preset',
            label: 'Preset',
            tone: 'preset',
            scopes: async () => ({ preset: true }),
            load: jest.fn(async () => {
                loadCall++;
                if (loadCall === 2) {
                    return new Promise((_r, reject) => { rejectLoadP1 = reject; });
                }
                return { live: { name: activePreset }, target: { scope: 'preset', ref: { collection: 'openai', name: activePreset } }, title: activePreset };
            }),
            prompt: async () => 'sys',
            tools: async () => [],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: () => new Map(),
            rebuild: (b) => b,
            commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
        };

        const app = {
            sessions,
            iterateTargets: () => [presetTarget],
            snapshot: () => ({ preset: { name: activePreset, ref: { collection: 'openai', name: activePreset } } }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: { aiRequest: jest.fn() },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        // show(sessionId) works even when sessionScopes has not been populated (passes null so store resolves via idToScope)
        await page.show({ sessionId: 's_p1' });
        await flushMicrotasks();
        expect(sessions.get).toHaveBeenCalledWith('s_p1', null);
        expect(page.el.textContent).toContain('A1');

        // Trigger a send() on P1 whose load() hangs and will reject
        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Update P1';
        sendBtn.click();
        await flushMicrotasks();

        // Switch Luker preset P1 -> P2 via onSnapshot() while P1 load() is still pending
        activePreset = 'P2';
        page.onSnapshot();
        await flushMicrotasks();
        await flushMicrotasks();

        // P1's stale session A1 must be cleared, P2's work reloaded, and P2 session list shown
        expect(page.el.textContent).not.toContain('A1');
        expect(page.el.textContent).toContain('P2 Chat');

        // Now reject P1's stale load(): must NOT overwrite P2's view with loadError
        rejectLoadP1(new Error('P1 read timed out'));
        await flushMicrotasks();
        await flushMicrotasks();
        expect(page.el.textContent).not.toContain('P1 read timed out');
    });

    test('onSnapshot scopeChanged clears pendingNewSelection busy state, recentSessions, and prevents brand-new session hijack when stale load resolves', async () => {
        const byScope = new Map();
        const scopeKey = (opts) => JSON.stringify(opts);
        const sessions = {
            list: jest.fn(async (_k, opts) => (byScope.get(scopeKey(opts)) || []).map(s => JSON.parse(JSON.stringify(s)))),
            get: jest.fn(async (id, opts) => {
                const hit = (byScope.get(scopeKey(opts)) || []).find(s => s.id === id);
                return hit ? JSON.parse(JSON.stringify(hit)) : null;
            }),
            create: jest.fn(async (fields, opts) => {
                const s = { id: 's_p1_new', turns: [], createdAt: 1, updatedAt: 1, ...fields };
                const k = scopeKey(opts);
                byScope.set(k, [s, ...(byScope.get(k) || [])]);
                return JSON.parse(JSON.stringify(s));
            }),
            update: jest.fn(async (id, patch, opts) => {
                const list = byScope.get(scopeKey(opts)) || [];
                const idx = list.findIndex(s => s.id === id);
                if (idx < 0) return null;
                list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
                return JSON.parse(JSON.stringify(list[idx]));
            }),
        };

        byScope.set(scopeKey({ scope: 'preset', target: { collection: 'openai', name: 'P1' } }), [
            { id: 's_p1_old', kind: 'iterate', ws: 'preset', scope: 'preset', title: 'P1 Old Chat', updatedAt: 10, turns: [{ role: 'user', text: 'Q', at: 1 }, { role: 'ai', text: 'A', at: 2 }] },
        ]);

        let activePreset = 'P1';
        let resolveLoadP1;
        let loadCount = 0;
        let resolveListP2;
        const origList = sessions.list;
        sessions.list = jest.fn(async (k, opts) => {
            if (opts?.target?.name === 'P2') {
                return new Promise((r) => { resolveListP2 = r; });
            }
            return origList(k, opts);
        });

        const presetTarget = {
            id: 'preset',
            label: 'Preset',
            tone: 'preset',
            scopes: async () => ({ preset: true }),
            load: jest.fn(async () => {
                loadCount++;
                if (loadCount === 2) {
                    return new Promise((r) => { resolveLoadP1 = r; });
                }
                return { live: { name: activePreset }, target: { scope: 'preset', ref: { collection: 'openai', name: activePreset } }, title: activePreset };
            }),
            prompt: async () => 'sys',
            tools: async () => [],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: () => new Map(),
            rebuild: (b) => b,
            commit: async () => ({ applied: [], skipped: [], failure: '', undo: async () => {} }),
        };

        const app = {
            sessions,
            iterateTargets: () => [presetTarget],
            snapshot: () => ({ preset: { name: activePreset, ref: { collection: 'openai', name: activePreset } } }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: { aiRequest: jest.fn(async () => ({ text: 'P1 reply', calls: [] })) },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'preset', scope: 'preset' });
        await flushMicrotasks();

        // Starting from brand-new conversation (session === null), P1 Old Chat is in sidebar
        expect(page.el.textContent).toContain('P1 Old Chat');
        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'New chat on P1';
        sendBtn.click();
        await flushMicrotasks();
        expect(textarea.disabled).toBe(true);

        // Switch preset P1 -> P2 via onSnapshot() while load() for P1 is still pending (and P2 list is pending)
        activePreset = 'P2';
        page.onSnapshot();
        await flushMicrotasks();

        // New scope P2 must NOT stay busy from P1's pendingNewSelection and must clear P1 Old Chat from recentSessions
        expect(textarea.disabled).toBe(false);
        expect(sendBtn.disabled).toBe(false);
        expect(page.el.textContent).not.toContain('P1 Old Chat');

        // Resolve P2 session list
        resolveListP2([]);
        await flushMicrotasks();

        // Now resolve stale P1 load(): must NOT hijack P2's view with P1's newly created session
        resolveLoadP1({ live: { name: 'P1' }, target: { scope: 'preset', ref: { collection: 'openai', name: 'P1' } }, title: 'P1' });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(page.el.textContent).not.toContain('P1 reply');
        expect(page.el.textContent).not.toContain('New chat on P1');
    });

    test('targetById does not fall back to getTargets()[0] for unknown explicit target IDs in openSession or apply', async () => {
        const sessions = createMemorySessionStore();
        const orphanMeta = await sessions.create({
            kind: 'iterate',
            ws: 'preset',
            scope: 'preset',
            title: 'Orphaned Session',
            turns: [{ role: 'user', text: 'Old', at: 1 }, { role: 'ai', text: 'Old reply', at: 2 }],
        }, { scope: 'preset', target: { collection: 'openai', name: 'Main' } });

        const origGet = sessions.get;
        sessions.get = jest.fn(async (id, opts) => {
            const res = await origGet(id, opts);
            if (res && id === orphanMeta.id) {
                return { ...res, ws: 'removed_target' };
            }
            return res;
        });

        const cardUnitsSpy = jest.fn((live) => new Map([
            ['card:description', { key: 'card:description', label: 'Description', group: 'Card', text: live.description, fields: { description: live.description } }],
        ]));
        const cardCommitSpy = jest.fn(async () => ({ applied: ['card:description'], skipped: [], failure: '', undo: async () => {} }));
        const cardTarget = {
            id: 'card',
            label: 'Character card',
            tone: 'card',
            scopes: async () => ({ character: true }),
            load: async () => ({ live: { description: 'Alice' }, target: { scope: 'character', avatar: 'alice.png' }, title: 'Alice' }),
            prompt: async () => 'card sys',
            tools: async () => [],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: cardUnitsSpy,
            rebuild: (_b, ai) => ai,
            commit: cardCommitSpy,
        };

        const presetTarget = {
            id: 'preset',
            label: 'Preset',
            tone: 'preset',
            scopes: async () => ({ preset: true }),
            load: async () => ({ live: { temp: 0.7 }, target: { scope: 'preset', ref: { collection: 'openai', name: 'Main' } }, title: 'Main' }),
            prompt: async () => 'preset sys',
            tools: async () => [{ type: 'function', function: { name: 'edit_temp' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, live) => ({ ...live, temp: 1.0 }),
            units: (live) => new Map([['preset:temp', { key: 'preset:temp', label: 'Temp', group: 'Preset', text: String(live.temp), fields: { temp: live.temp } }]]),
            rebuild: (_b, ai) => ai,
            commit: async () => ({ applied: ['preset:temp'], skipped: [], failure: '', undo: async () => {} }),
        };

        let targets = [cardTarget, presetTarget];
        let round = 0;
        const app = {
            sessions,
            iterateTargets: () => targets,
            snapshot: () => ({
                chat: { character: { avatar: 'alice.png', name: 'Alice' } },
                card: { name: 'Alice', avatar: 'alice.png' },
                preset: { name: 'Main', ref: { collection: 'openai', name: 'Main' } },
            }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: { record: jest.fn(() => 'h1'), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: jest.fn(async () => {
                    round++;
                    if (round === 1) return { text: '', calls: [{ id: 'e1', name: 'edit_temp', args: {} }] };
                    return { text: 'Updated temp.', calls: [] };
                }),
            },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'preset', scope: 'preset' });
        await flushMicrotasks();

        // 1) openSession with loaded.ws === 'removed_target' must NOT overwrite ws or flip active target to cardTarget
        const orphanBtn = [...page.el.querySelectorAll('.wb-sess-item')].find((b) => b.textContent.includes('Orphaned Session'));
        orphanBtn.click();
        await flushMicrotasks();
        expect(page.el.querySelector('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').textContent).toContain('Preset');

        // 2) Start a fresh preset session, produce a pending draft, then remove presetTarget before clicking Apply
        const newChatBtn = [...page.el.querySelectorAll('.wb-sess-head button')].find((b) => b.textContent.includes('New conversation'));
        newChatBtn.click();
        await flushMicrotasks();

        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'Raise temp';
        sendBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();

        targets = [cardTarget];
        cardUnitsSpy.mockClear();
        cardCommitSpy.mockClear();
        app.toast.mockClear();

        const applyBtn = [...page.el.querySelectorAll('.wb-chg-foot button')].find((b) => b.textContent.includes('Apply selected'));
        applyBtn.click();
        await flushMicrotasks();

        expect(cardUnitsSpy).not.toHaveBeenCalled();
        expect(cardCommitSpy).not.toHaveBeenCalled();
        expect(app.toast).toHaveBeenCalledWith(
            expect.stringContaining('This draft is no longer available'),
            expect.objectContaining({ error: true }),
        );
    });

    test('supports seedPrompt + hideSeedFromUi + autoSend + onCancelWithoutApply across collapse, close, and apply', async () => {
        function makeHarness() {
            const sessions = createMemorySessionStore();
            const registry = createWorkbenchRegistry();
            let diskDesc = 'Before';
            let aiCallCount = 0;
            const sentMessages = [];

            const cardTarget = {
                id: 'card',
                label: 'Character card',
                tone: 'card',
                scopes: async () => ({ character: true }),
                load: async () => ({
                    live: { description: diskDesc },
                    target: { scope: 'character', avatar: 'alice.png' },
                    title: 'Alice',
                }),
                prompt: async () => 'card sys',
                tools: async () => [{ type: 'function', function: { name: 'edit_desc' } }],
                isRead: () => false,
                runRead: async () => ({}),
                runEdit: async (_c, live) => ({ ...live, description: 'After' }),
                units: (live) => new Map([[
                    'card:description',
                    {
                        key: 'card:description',
                        label: 'Description',
                        group: 'Card',
                        text: live.description,
                        fields: { description: live.description },
                    },
                ]]),
                rebuild: (_b, ai) => ai,
                commit: async (_t, _b, next, keys) => {
                    const prev = diskDesc;
                    diskDesc = next.description;
                    return { applied: keys, skipped: [], failure: '', undo: async () => { diskDesc = prev; } };
                },
            };
            registry.registerIterateTarget(cardTarget);

            const source = {
                readSettings: () => ({ builtinPrompt: false, reviewChanges: true, pill: false }),
                writeSettings: () => {},
                loadSnapshot: async () => ({
                    chat: { label: 'Chat 1', character: { avatar: 'alice.png', name: 'Alice' } },
                    card: { name: 'Alice', avatar: 'alice.png' },
                }),
                subscribe: () => () => {},
                createSessions: () => sessions,
                historyStorage: () => null,
                runRules: () => [],
                lastReply: async () => '',
                aiRequest: jest.fn(async (_ws, { messages }) => {
                    sentMessages.push(JSON.parse(JSON.stringify(messages)));
                    aiCallCount++;
                    if (aiCallCount === 1) {
                        return { text: '', calls: [{ id: 'e1', name: 'edit_desc', args: {} }] };
                    }
                    return { text: 'Summary of diff.', calls: [] };
                }),
            };

            const wb = mountWorkbench({ source, registry, startCollapsed: false });
            return { wb, sessions, sentMessages, getDiskDesc: () => diskDesc };
        }

        // (a) seedPrompt + hideSeedFromUi + autoSend triggers turn automatically, hides user seed bubble,
        // preserves seed in messages for turn 2, and invokes onCancelWithoutApply once on collapse+close.
        {
            const { wb, sentMessages } = makeHarness();
            const cancelSpy = jest.fn(async () => {});
            await wb.open({
                page: 'ai',
                ws: 'card',
                scope: 'character',
                seedPrompt: 'SEED_DIFF_FOR_AI',
                hideSeedFromUi: true,
                autoSend: true,
                onCancelWithoutApply: cancelSpy,
            });
            await flushMicrotasks();
            await flushMicrotasks();

            expect(sentMessages.length).toBeGreaterThanOrEqual(1);
            expect(sentMessages[0].some(m => m.role === 'user' && m.content.includes('SEED_DIFF_FOR_AI'))).toBe(true);
            // Hidden seed user bubble must NOT render in UI, while AI reply renders.
            const userBubbles = [...document.querySelectorAll('.wb-msg-me')].map(el => el.textContent);
            expect(userBubbles.some(t => t.includes('SEED_DIFF_FOR_AI'))).toBe(false);
            expect(document.body.textContent).toContain('Summary of diff.');

            // Follow-up user turn still replays the hidden seed message in API history.
            const textarea = wb.layer?.querySelector?.('textarea.wb-input') || document.querySelector('textarea.wb-input');
            const sendBtn = document.querySelector('button.wb-send');
            textarea.value = 'Proceed with migration';
            sendBtn.click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(sentMessages.at(-1).some(m => m.role === 'user' && m.content.includes('SEED_DIFF_FOR_AI'))).toBe(true);
            expect(sentMessages.at(-1).some(m => m.role === 'user' && m.content.includes('Proceed with migration'))).toBe(true);

            // Collapse without applying -> fires cancelSpy once; subsequent close must NOT fire again.
            wb.collapse();
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);
            wb.close();
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);
        }

        // (b) Applying at least once suppresses onCancelWithoutApply on collapse + close.
        {
            const { wb, getDiskDesc } = makeHarness();
            const cancelSpy = jest.fn(async () => {});
            await wb.open({
                page: 'ai',
                ws: 'card',
                scope: 'character',
                seedPrompt: 'SEED_APPLY_CASE',
                hideSeedFromUi: true,
                autoSend: true,
                onCancelWithoutApply: cancelSpy,
            });
            await flushMicrotasks();
            await flushMicrotasks();

            const applyBtn = [...document.querySelectorAll('.wb-chg-foot button')].find(b => b.textContent.includes('Apply selected'));
            expect(applyBtn).toBeTruthy();
            applyBtn.click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(getDiskDesc()).toBe('After');

            wb.collapse();
            await flushMicrotasks();
            wb.close();
            await flushMicrotasks();
            expect(cancelSpy).not.toHaveBeenCalled();
        }

        // (c) Starting a new chat without applying invokes onCancelWithoutApply once (and not again on close).
        {
            const { wb } = makeHarness();
            const cancelSpy = jest.fn(async () => {});
            await wb.open({
                page: 'ai',
                ws: 'card',
                scope: 'character',
                seedPrompt: 'SEED_ABANDON_CASE',
                hideSeedFromUi: true,
                autoSend: true,
                onCancelWithoutApply: cancelSpy,
            });
            await flushMicrotasks();
            await flushMicrotasks();

            const newChatBtn = [...document.querySelectorAll('.wb-sess-head button')].find(b => b.textContent.includes('New conversation'));
            expect(newChatBtn).toBeTruthy();
            newChatBtn.click();
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);

            wb.close();
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);
        }
    });
});
