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
                inverseAvailable: true,
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
        const cloneEntry = bus.listEntries().find(e => e.kind === 'preset-clone');
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

        // Legacy auto:true and legacy toolCalls dropped while assistant reasoning metadata is preserved
        expect(sentPayloads[0].some(m => m.content === 'AUTO CONTINUE')).toBe(false);
        expect(sentPayloads[0][1]).toEqual({ role: 'user', content: 'Old user msg' });
        expect(sentPayloads[0][2]).toEqual({ role: 'assistant', content: 'Old AI msg', reasoning: 'Old reasoning' });

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

        // (d) Re-opening with explicit o.ws === ws and o.scope === scope (without seedPrompt or new hook) fires onCancelWithoutApply once before discarding session.
        {
            const { wb } = makeHarness();
            const cancelSpy = jest.fn(async () => {});
            await wb.open({
                page: 'ai',
                ws: 'card',
                scope: 'character',
                seedPrompt: 'SEED_REOPEN_CASE',
                hideSeedFromUi: true,
                autoSend: true,
                onCancelWithoutApply: cancelSpy,
            });
            await flushMicrotasks();
            await flushMicrotasks();
            expect(cancelSpy).not.toHaveBeenCalled();

            await wb.open({ page: 'ai', ws: 'card', scope: 'character' });
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);

            wb.close();
            await flushMicrotasks();
            expect(cancelSpy).toHaveBeenCalledTimes(1);
        }
    });

    test('upgrades default scope from global to character when a character is selected, while preserving explicit user choice', async () => {
        document.body.innerHTML = '';
        const sessions = createMemorySessionStore();
        const registry = createWorkbenchRegistry();
        let activeChar = null;
        const listeners = new Set();
        const loadedScopes = [];

        registry.registerIterateTarget({
            id: 'orch',
            label: 'Orchestration',
            tone: 'orch',
            scopes: async () => ({ global: true, character: Boolean(activeChar) }),
            load: async (scopeArg) => {
                loadedScopes.push(scopeArg);
                return {
                    live: { mode: 'loop' },
                    target: scopeArg === 'character'
                        ? { scope: 'character', avatar: activeChar.avatar }
                        : { scope: 'global' },
                    title: scopeArg === 'character' ? activeChar.name : 'Global',
                };
            },
            prompt: async () => 'orch sys',
            tools: async () => [],
            isRead: () => true,
            runRead: async () => ({}),
            runEdit: async (_c, live) => live,
            units: () => new Map(),
            rebuild: (_b, ai) => ai,
            commit: async () => ({ applied: [], skipped: [], failure: '' }),
        });

        const source = {
            readSettings: () => ({ builtinPrompt: false, reviewChanges: true, pill: false }),
            writeSettings: () => {},
            loadSnapshot: async () => ({
                chat: activeChar ? { label: 'Chat 1', character: activeChar } : null,
                card: activeChar,
            }),
            subscribe: (fn) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            createSessions: () => sessions,
            historyStorage: () => null,
            runRules: () => [],
            lastReply: async () => '',
            aiRequest: jest.fn(async () => ({ text: 'ok', calls: [] })),
        };

        const wb = mountWorkbench({ source, registry, startCollapsed: true });
        await flushMicrotasks();
        await flushMicrotasks();

        // Booted with no character selected -> page boot snapshot had only global allowed.
        // Now user selects a character BEFORE opening AI Iteration (without explicit scope).
        activeChar = { avatar: 'iris.png', name: 'Iris' };
        for (const fn of listeners) fn();
        await flushMicrotasks();
        await flushMicrotasks();

        await wb.open({ page: 'ai', ws: 'orch' });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(document.querySelector('.wb-scope-seg .lw-seg-btn[aria-pressed="true"]')?.textContent).toContain('Iris');

        const textarea = document.querySelector('textarea.wb-input');
        const sendBtn = document.querySelector('button.wb-send');
        textarea.value = 'Check scope';
        sendBtn.click();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(loadedScopes.at(-1)).toBe('character');

        // Start a fresh conversation so scope controls unlock, then explicitly click Global.
        const newChatBtn = [...document.querySelectorAll('.wb-sess-head button')].find(b => b.textContent.includes('New conversation'));
        newChatBtn.click();
        await flushMicrotasks();

        const globalBtn = [...document.querySelectorAll('.wb-scope-seg .lw-seg-btn')].find(b => b.textContent.includes('Global'));
        expect(globalBtn).toBeTruthy();
        globalBtn.click();
        await flushMicrotasks();
        expect(document.querySelector('.wb-scope-seg .lw-seg-btn[aria-pressed="true"]')?.textContent).toContain('Global');

        for (const fn of listeners) fn();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(document.querySelector('.wb-scope-seg .lw-seg-btn[aria-pressed="true"]')?.textContent).toContain('Global');

        wb.close();
    });

    test('continues a character-scope conversation across Turn 2 after Turn 1 apply creates character override', async () => {
        const sessions = createMemorySessionStore();
        const registry = createWorkbenchRegistry();
        let activeChar = { avatar: 'iris.png', name: 'Iris' };
        let hasOverride = false;
        let savedVal = 'v0';
        const toasts = [];

        registry.registerIterateTarget({
            id: 'orch',
            label: 'Orchestration',
            tone: 'orch',
            targetKey: (t) => (
                t?.scope === 'character'
                    ? `orch:character:${t.mode || ''}:${t.avatar || ''}`
                    : `orch:global:${t?.mode || ''}:${t?.presetId || ''}`
            ),
            scopes: async () => ({ global: true, character: Boolean(activeChar) }),
            load: async (scopeArg) => ({
                live: { val: savedVal },
                target: scopeArg === 'character'
                    ? {
                        scope: 'character',
                        mode: 'director',
                        avatar: activeChar.avatar,
                        presetId: hasOverride ? 'default' : 'global-active',
                        hasOverride,
                    }
                    : { scope: 'global', mode: 'director', presetId: 'global-active', hasOverride: false },
                title: scopeArg === 'character' ? activeChar.name : 'Global',
            }),
            prompt: async () => 'orch sys',
            tools: async () => [{ type: 'function', function: { name: 'set_val' } }],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (call) => ({ val: call.args.val }),
            units: (doc) => new Map([['val', { group: 'Prompt', label: 'Value', text: String(doc.val) }]]),
            rebuild: (_b, ai) => ai,
            commit: async (_targetRef, _base, next) => {
                hasOverride = true;
                savedVal = next.val;
                return { applied: ['val'], skipped: [], failure: '' };
            },
        });

        let turnNum = 0;
        const source = {
            readSettings: () => ({ builtinPrompt: false, reviewChanges: true, pill: false }),
            writeSettings: () => {},
            loadSnapshot: async () => ({
                chat: { label: 'Chat 1', character: activeChar },
                card: activeChar,
            }),
            subscribe: () => () => {},
            createSessions: () => sessions,
            historyStorage: () => null,
            runRules: () => [],
            lastReply: async () => '',
            aiRequest: jest.fn(async () => {
                turnNum += 1;
                if (turnNum === 1) return { text: '', calls: [{ id: 'c1', name: 'set_val', args: { val: 'v1' } }] };
                if (turnNum === 2) return { text: 'Turn 1 ready.', calls: [] };
                if (turnNum === 3) return { text: '', calls: [{ id: 'c2', name: 'set_val', args: { val: 'v2' } }] };
                return { text: 'Turn 2 ready.', calls: [] };
            }),
        };

        const wb = mountWorkbench({ source, registry, startCollapsed: true });
        await wb.open({ page: 'ai', ws: 'orch', scope: 'character' });
        await flushMicrotasks();
        await flushMicrotasks();

        const textarea = document.querySelector('textarea.wb-input');
        const sendBtn = document.querySelector('button.wb-send');

        // Turn 1 (before character override exists: hasOverride=false, presetId='global-active')
        textarea.value = 'First refinement';
        sendBtn.click();
        for (let i = 0; i < 6; i++) await flushMicrotasks();
        expect(document.body.textContent).toContain('Turn 1 ready.');

        const applyBtn = [...document.querySelectorAll('.wb-chg-foot button')].find(b => b.textContent.includes('Apply selected'));
        expect(applyBtn).toBeTruthy();
        applyBtn.click();
        for (let i = 0; i < 6; i++) await flushMicrotasks();
        expect(hasOverride).toBe(true);
        expect(savedVal).toBe('v1');

        // Turn 2 in the SAME session after override creation (hasOverride=true, presetId='default')
        textarea.value = 'Second refinement';
        sendBtn.click();
        for (let i = 0; i < 6; i++) await flushMicrotasks();
        expect(document.body.textContent).toContain('Turn 2 ready.');
        expect(document.body.textContent).not.toContain('This chat was editing something else');
        expect(toasts).toEqual([]);

        wb.close();
    });

    test('reserves the preview column with a loading state while initial target work loads and hides it on load error', async () => {
        const sessions = createMemorySessionStore();
        let resolveLoad;
        let rejectLoad;
        let loadAttempt = 0;

        const target = {
            id: 'preset',
            label: 'Preset',
            tone: 'preset',
            scopes: async () => ({ global: true }),
            load: () => new Promise((resolve, reject) => {
                loadAttempt += 1;
                resolveLoad = resolve;
                rejectLoad = reject;
            }),
            renderPreview: ({ ai }) => {
                if (!ai) return null;
                const el = document.createElement('div');
                el.className = 'wb-test-preview';
                el.textContent = `Preview:${ai.name}`;
                return el;
            },
            prompt: async () => 'sys',
            tools: async () => [],
            isRead: () => false,
            runRead: async () => ({}),
            runEdit: async (_c, live) => live,
            units: () => new Map(),
            rebuild: (_b, ai) => ai,
            commit: async () => ({ applied: [], skipped: [], failure: '' }),
        };

        const app = {
            sessions,
            history: { record: () => 'h1', canUndo: () => false, undo: async () => {} },
            iterateTargets: () => [target],
            snapshot: () => ({}),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            saveSettings: () => {},
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: { lastReply: async () => '', aiRequest: jest.fn() },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'preset', scope: 'global' });

        const previewPane = page.el.querySelector('.wb-iter-preview');
        expect(loadAttempt).toBe(1);
        expect(previewPane.hidden).toBe(false);
        expect(previewPane.querySelector('.wb-loading')).not.toBeNull();

        resolveLoad({ live: { name: 'Default' }, target: { scope: 'global' }, title: 'Preset "Default"' });
        await flushMicrotasks();

        expect(previewPane.hidden).toBe(false);
        expect(previewPane.querySelector('.wb-loading')).toBeNull();
        expect(previewPane.querySelector('.wb-test-preview')?.textContent).toBe('Preview:Default');

        // Reload with a failing load hides the preview pane once loadError is set.
        const failingPage = createIteratePage(app);
        document.body.appendChild(failingPage.el);
        await failingPage.show({ ws: 'preset', scope: 'global' });
        const failingPreview = failingPage.el.querySelector('.wb-iter-preview');
        expect(failingPreview.hidden).toBe(false);
        expect(failingPreview.querySelector('.wb-loading')).not.toBeNull();

        rejectLoad(new Error('Preset unreadable'));
        await flushMicrotasks();

        expect(failingPreview.hidden).toBe(true);
    });

    test('lazy-loads sessions only when AI iteration is opened, skipping reads while collapsed or on another tab', async () => {
        const sessions = createMemorySessionStore();
        await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Saved Card Session',
            turns: [{ role: 'user', text: 'Q', at: 1 }, { role: 'ai', text: 'A', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });
        sessions.list.mockClear();
        sessions.get.mockClear();

        const registry = createWorkbenchRegistry();
        const listeners = new Set();
        let activeChar = { avatar: 'alice.png', name: 'Alice' };

        registry.registerIterateTarget({
            id: 'card',
            label: 'Character card',
            tone: 'card',
            scopes: async () => ({ character: Boolean(activeChar) }),
            load: async () => ({ live: { description: 'Init' }, target: { scope: 'character', avatar: activeChar.avatar }, title: activeChar.name }),
            prompt: async () => 'sys',
            tools: async () => [],
            isRead: () => true,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: () => new Map(),
            rebuild: (_b, a) => a,
            commit: async () => ({ applied: [], skipped: [], failure: '' }),
        });

        const source = {
            readSettings: () => ({ builtinPrompt: false, reviewChanges: true, pill: true }),
            writeSettings: () => {},
            loadSnapshot: async () => ({
                chat: activeChar ? { label: 'Chat 1', character: activeChar } : null,
                card: activeChar,
            }),
            subscribe: (fn) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            createSessions: () => sessions,
            historyStorage: () => null,
            runRules: () => [],
            lastReply: async () => '',
            aiRequest: jest.fn(async () => ({ text: 'ok', calls: [] })),
        };

        // Mounted collapsed (startup pill mode) -> must NOT read sessions on mount or snapshot events
        const wb = mountWorkbench({ source, registry, startCollapsed: true });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(sessions.list).not.toHaveBeenCalled();
        expect(sessions.get).not.toHaveBeenCalled();

        for (const fn of listeners) fn();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(sessions.list).not.toHaveBeenCalled();

        // Opening Overview tab still must NOT read AI iteration sessions
        await wb.open({ page: 'home' });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(sessions.list).not.toHaveBeenCalled();

        // Switching to AI iteration lazily reads session index (not body)
        await wb.open({ page: 'ai', ws: 'card' });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(sessions.list).toHaveBeenCalledTimes(1);
        expect(sessions.get).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('Saved Card Session');

        // Clicking the session lazily fetches its body
        const openBtn = [...document.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Saved Card Session'));
        openBtn.click();
        await flushMicrotasks();
        expect(sessions.get).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('A');

        wb.close();
    });

    test('deletes single sessions (aborting in-flight runs without resurrection) and clears only current target conversations', async () => {
        const sessions = createMemorySessionStore();
        sessions.removeMany = jest.fn(async (ids, opts = {}) => {
            for (const id of ids) await sessions.remove(id, opts);
            return { removed: ids };
        });
        const cardA = await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Card Alpha',
            turns: [{ role: 'user', text: 'Q A', at: 1 }, { role: 'ai', text: 'Reply Alpha', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });
        const cardB = await sessions.create({
            kind: 'iterate',
            ws: 'card',
            scope: 'character',
            title: 'Card Beta',
            turns: [{ role: 'user', text: 'Q B', at: 1 }, { role: 'ai', text: 'Reply Beta', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });
        const otherTarget = await sessions.create({
            kind: 'iterate',
            ws: 'world',
            scope: 'character',
            title: 'World Keep',
            turns: [{ role: 'user', text: 'Q W', at: 1 }, { role: 'ai', text: 'Reply World', at: 2 }],
        }, { scope: 'character', avatar: 'alice.png' });

        let abortSignalObserved = null;
        let resolveAi;
        const cardTarget = {
            id: 'card',
            label: 'Character card',
            tone: 'card',
            scopes: async () => ({ character: true }),
            load: async () => ({ live: { description: 'Init' }, target: { scope: 'character', avatar: 'alice.png' }, title: 'Alice' }),
            prompt: async () => 'sys',
            tools: async () => [{ type: 'function', function: { name: 'noop' } }],
            isRead: () => true,
            runRead: async () => ({}),
            runEdit: async (_c, l) => l,
            units: () => new Map(),
            rebuild: (_b, a) => a,
            commit: async () => ({ applied: [], skipped: [], failure: '' }),
        };

        const app = {
            sessions,
            layer: document.body,
            iterateTargets: () => [cardTarget],
            snapshot: () => ({ chat: { character: { avatar: 'alice.png', name: 'Alice' } }, card: { name: 'Alice', avatar: 'alice.png' } }),
            settings: () => ({ builtinPrompt: false, reviewChanges: true }),
            history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {
                aiRequest: jest.fn((_ws, { signal }) => {
                    abortSignalObserved = signal;
                    return new Promise((r) => { resolveAi = r; });
                }),
            },
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'card', scope: 'character' });
        await flushMicrotasks();

        // Open Card Alpha and start an in-flight AI turn
        const openAlpha = [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Card Alpha'));
        openAlpha.click();
        await flushMicrotasks();
        const textarea = page.el.querySelector('textarea.wb-input');
        const sendBtn = page.el.querySelector('button.wb-send');
        textarea.value = 'In-flight edit';
        sendBtn.click();
        await flushMicrotasks();
        expect(abortSignalObserved).not.toBeNull();
        expect(abortSignalObserved.aborted).toBe(false);

        // 1) Click delete on Card Alpha -> cancel confirmation keeps session and run intact
        const delAlphaBtn = page.el.querySelector(`.wb-sess-row[data-session-id="${cardA.id}"] .wb-sess-del`);
        delAlphaBtn.click();
        await flushMicrotasks();
        document.body.querySelector('.lw-dialog-foot .lw-btn.is-ghost').click();
        await flushMicrotasks();
        expect(sessions.remove).not.toHaveBeenCalled();
        expect(abortSignalObserved.aborted).toBe(false);

        // 2) Click delete on Card Alpha -> confirm aborts run, removes session, resets open view, and settling AI never resurrects it
        delAlphaBtn.click();
        await flushMicrotasks();
        document.body.querySelector('.lw-dialog-foot .lw-btn.is-danger').click();
        await flushMicrotasks();
        await flushMicrotasks();

        expect(abortSignalObserved.aborted).toBe(true);
        expect(sessions.remove).toHaveBeenCalledWith(cardA.id, { scope: 'character', avatar: 'alice.png' });
        expect(page.el.querySelector(`.wb-sess-row[data-session-id="${cardA.id}"]`)).toBeNull();
        expect(page.el.textContent).not.toContain('Reply Alpha');

        resolveAi({ text: 'Late reply after delete', calls: [] });
        await flushMicrotasks();
        await flushMicrotasks();
        expect(await sessions.get(cardA.id, { scope: 'character', avatar: 'alice.png' })).toBeNull();

        // 3) Clear conversations removes remaining Card Beta via removeMany without touching World Keep in same character scope
        const clearBtn = page.el.querySelector('.wb-sess-clear');
        expect(clearBtn).not.toBeNull();
        clearBtn.click();
        await flushMicrotasks();
        document.body.querySelector('.lw-dialog-foot .lw-btn.is-danger').click();
        await flushMicrotasks();
        await flushMicrotasks();

        expect(sessions.removeMany).toHaveBeenCalledWith([cardB.id], { scope: 'character', avatar: 'alice.png' });
        expect(page.el.querySelectorAll('.wb-sess-row')).toHaveLength(0);
        expect(await sessions.get(cardB.id, { scope: 'character', avatar: 'alice.png' })).toBeNull();
        expect(await sessions.get(otherTarget.id, { scope: 'character', avatar: 'alice.png' })).not.toBeNull();
    });

    test('discard() rebases later pending turn onto current saved state (preserving intervening applied turn) instead of stale draft.base', async () => {
        const savedLuker = globalThis.Luker;
        delete globalThis.Luker;
        try {
            let disk = { a: 'a0', b: 'b0', c: 'c0' };
            const clone = (v) => JSON.parse(JSON.stringify(v));
            const target = {
                id: 'card',
                label: 'Card',
                tone: 'card',
                scopes: async () => ({ global: true }),
                load: async () => ({ live: clone(disk), target: { scope: 'global', id: 'same' }, title: 'Doc' }),
                targetKey: (t) => t?.id || 'same',
                prompt: async () => 'sys',
                tools: async () => [{ type: 'function', function: { name: 'set_field' } }],
                isRead: () => false,
                runRead: async () => ({}),
                runEdit: async (call, live) => ({ ...live, [call.args.k]: call.args.v }),
                units: (live) => new Map(Object.entries(live || {}).map(([k, v]) => [k, { key: k, label: k, group: 'Fields', text: String(v), raw: v }])),
                rebuild: (base, ai, keys) => {
                    const out = clone(base);
                    for (const k of keys) out[k] = ai[k];
                    return out;
                },
                commit: async (_t, base, next, keys) => {
                    const prev = clone(disk);
                    for (const k of keys) {
                        if (disk[k] !== base[k]) {
                            throw new Error(`Conflict on ${k}: disk=${disk[k]} base=${base[k]}`);
                        }
                        disk[k] = next[k];
                    }
                    return { applied: keys, skipped: [], failure: '', undo: async () => { disk = prev; } };
                },
            };

            const sessions = createMemorySessionStore();
            const historyUndo = new Map();
            let histSeq = 0;
            const scriptedEdits = [
                { k: 'a', v: 'a1' },
                { k: 'b', v: 'b1' },
                { k: 'c', v: 'c1' },
            ];
            let reqIdx = 0;
            let editPhase = true;
            const app = {
                sessions,
                layer: document.body,
                iterateTargets: () => [target],
                snapshot: () => ({}),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: {
                    record: (entry) => {
                        const id = `h_${++histSeq}`;
                        if (entry.undo) historyUndo.set(id, entry.undo);
                        return id;
                    },
                    canUndo: (id) => historyUndo.has(id),
                    undo: async (id) => { await historyUndo.get(id)?.(); historyUndo.delete(id); },
                },
                toast: jest.fn(),
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: {
                    aiRequest: jest.fn(async () => {
                        if (editPhase) {
                            editPhase = false;
                            const e = scriptedEdits[reqIdx++];
                            return { text: '', calls: [{ id: `c_${reqIdx}`, name: 'set_field', args: e }] };
                        }
                        editPhase = true;
                        return { text: `Done ${reqIdx}`, calls: [] };
                    }),
                },
            };

            const page = createIteratePage(app);
            document.body.appendChild(page.el);
            await page.show({ ws: 'card', scope: 'global' });
            await flushMicrotasks();

            const sendMsg = async (msg) => {
                const ta = page.el.querySelector('textarea.wb-input');
                const btn = page.el.querySelector('button.wb-send');
                ta.value = msg;
                btn.click();
                await flushMicrotasks();
                await flushMicrotasks();
            };

            // Stack 3 pending turns: Turn 1 edits a, Turn 2 edits b, Turn 3 edits c
            await sendMsg('edit a');
            await sendMsg('edit b');
            await sendMsg('edit c');

            // Apply Turn 2 (writes b: 'b1' to disk while Turn 1 and Turn 3 stay pending)
            const changeCardsBefore = [...page.el.querySelectorAll('.wb-chg')];
            expect(changeCardsBefore).toHaveLength(3);
            changeCardsBefore[1].querySelector('.wb-chg-foot button.is-primary').click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(disk).toEqual({ a: 'a0', b: 'b1', c: 'c0' });

            // Discard Turn 1 -> Turn 3 must rebase onto { a: 'a0', b: 'b1', c: 'c0' } (NOT stale b: 'b0'!)
            const cardsAfterApply = [...page.el.querySelectorAll('.wb-chg')];
            cardsAfterApply[0].querySelector('.wb-chg-foot button.is-ghost').click();
            await flushMicrotasks();
            await flushMicrotasks();

            // Verify Turn 3's persisted draft has base.b === 'b1' and Apply succeeds cleanly
            const listed = await sessions.list('iterate', { scope: 'global' });
            const fullSess = await sessions.get(listed[0].id, { scope: 'global' });
            const turn3 = fullSess.turns[5];
            expect(turn3.state).toBe('pending');
            expect(turn3.draft.base).toEqual({ a: 'a0', b: 'b1', c: 'c0' });
            expect(turn3.draft.ai).toEqual({ a: 'a0', b: 'b1', c: 'c1' });

            const cardsAfterDiscard = [...page.el.querySelectorAll('.wb-chg')];
            cardsAfterDiscard[2].querySelector('.wb-chg-foot button.is-primary').click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(disk).toEqual({ a: 'a0', b: 'b1', c: 'c1' });
            page.destroy();
        } finally {
            if (savedLuker !== undefined) globalThis.Luker = savedLuker;
        }
    });

    test('guards concurrent deletion in send(), completes reviews on onSnapshot scope change, and guards + cleans bus entries in undoTurn()', async () => {
        const savedLuker = globalThis.Luker;
        delete globalThis.Luker;
        try {
            // 1) Concurrent session deletion returning null from store.update in send() exits cleanly without crashing
            const baseSession = { id: 's_del', kind: 'iterate', ws: 'card', scope: 'global', title: 'Del', turns: [], messages: [], updatedAt: Date.now() };
            const delToast = jest.fn();
            const delAi = jest.fn();
            const delTarget = {
                id: 'card',
                label: 'Card',
                tone: 'card',
                scopes: async () => ({ global: true }),
                load: async () => ({ live: { a: 1 }, target: { scope: 'global' }, title: 'Doc' }),
                prompt: async () => 'sys',
                tools: async () => [{ type: 'function', function: { name: 'noop' } }],
                isRead: () => true,
                runRead: async () => ({}),
                runEdit: async (_c, l) => l,
                units: () => new Map(),
                rebuild: (_b, a) => a,
                commit: async () => ({ applied: [], skipped: [], failure: '' }),
            };
            const delPage = createIteratePage({
                sessions: {
                    list: async () => [baseSession],
                    get: async () => baseSession,
                    create: async () => baseSession,
                    update: async () => null,
                },
                layer: document.body,
                iterateTargets: () => [delTarget],
                snapshot: () => ({}),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
                toast: delToast,
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: { aiRequest: delAi },
            });
            document.body.appendChild(delPage.el);
            await delPage.show({ ws: 'card', scope: 'global', sessionId: 's_del' });
            await flushMicrotasks();
            delPage.el.querySelector('textarea.wb-input').value = 'Edit deleted';
            delPage.el.querySelector('button.wb-send').click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(delAi).not.toHaveBeenCalled();
            expect(delToast).not.toHaveBeenCalled();
            delPage.destroy();

            // 2) onSnapshot scope change completes active review (fires onCancelWithoutApply & resolves waitForClose)
            let activeChar = { avatar: 'alice.png', name: 'Alice' };
            const onCancel = jest.fn();
            const reviewTarget = {
                ...delTarget,
                scopes: async () => ({ character: true }),
                load: async () => ({ live: {}, target: { scope: 'character', avatar: activeChar.avatar }, title: activeChar.name }),
            };
            const revPage = createIteratePage({
                sessions: createMemorySessionStore(),
                layer: document.body,
                iterateTargets: () => [reviewTarget],
                snapshot: () => ({ chat: { character: activeChar }, card: activeChar }),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
                toast: jest.fn(),
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: { aiRequest: jest.fn() },
            });
            document.body.appendChild(revPage.el);
            const reviewDone = revPage.show({ ws: 'card', scope: 'character', onCancelWithoutApply: onCancel, waitForClose: true });
            await flushMicrotasks();
            expect(onCancel).not.toHaveBeenCalled();

            activeChar = { avatar: 'bob.png', name: 'Bob' };
            revPage.onSnapshot();
            await reviewDone;
            expect(onCancel).toHaveBeenCalledTimes(1);
            revPage.destroy();

            // 3) undoTurn applies applying guard against concurrent double-click AND discards later pending turn's bus entries
            let disk = { a: 'v0' };
            let resolveUndo;
            const undoMock = jest.fn(() => new Promise((r) => { resolveUndo = r; }));
            const historyUndo = new Map();
            let hSeq = 0;
            const proposalTarget = {
                id: 'preset',
                label: 'Preset',
                tone: 'preset',
                proposalKinds: {
                    'skill-author': {
                        ...skillAuthor,
                        inverseAvailable: false,
                        targetHandler: {
                            read: async () => ({ skill: 's' }),
                            write: async () => {},
                            describe: () => 's',
                        },
                    },
                },
                scopes: async () => ({ global: true }),
                load: async () => ({ live: { ...disk }, target: { scope: 'global', id: 'p1' }, title: 'P1' }),
                targetKey: (t) => t?.id || 'p1',
                prompt: async () => 'sys',
                tools: async () => [
                    { type: 'function', function: { name: 'edit_a' } },
                    { type: 'function', function: { name: 'propose_skill' } },
                ],
                isRead: () => false,
                runRead: async () => ({}),
                runEdit: async (call, live, helpers) => {
                    if (call.name === 'edit_a') return { ...live, a: call.args.v };
                    await helpers.propose({
                        kind: 'skill-author',
                        target: { type: 'skill-registry', name: 'later-skill', path: 'SKILL.md' },
                        before: { skill: 'later-skill' },
                        after: { skill: 'later-skill' },
                        meta: { kind: 'create', skillName: 'later-skill', before: '', after: 'body' },
                    });
                    return live;
                },
                units: (live) => new Map([['a', { key: 'a', label: 'A', group: 'Fields', text: String(live.a), raw: live.a }]]),
                rebuild: (base, ai, keys) => ({ ...base, ...(keys.includes('a') ? { a: ai.a } : {}) }),
                commit: async (_t, _b, next, keys) => {
                    const prev = { ...disk };
                    disk = { ...next };
                    return {
                        applied: keys,
                        skipped: [],
                        failure: '',
                        undo: async () => { await undoMock(); disk = prev; },
                    };
                },
            };

            const undoSessions = createMemorySessionStore();
            let step = 0;
            const undoPage = createIteratePage({
                sessions: undoSessions,
                layer: document.body,
                iterateTargets: () => [proposalTarget],
                snapshot: () => ({}),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: {
                    record: (entry) => {
                        const id = `hu_${++hSeq}`;
                        if (entry.undo) historyUndo.set(id, entry.undo);
                        return id;
                    },
                    canUndo: (id) => historyUndo.has(id),
                    undo: async (id) => { await historyUndo.get(id)?.(); historyUndo.delete(id); },
                },
                toast: jest.fn(),
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: {
                    aiRequest: jest.fn(async () => {
                        step++;
                        if (step === 1) return { text: '', calls: [{ id: 'ea1', name: 'edit_a', args: { v: 'v1' } }] };
                        if (step === 2) return { text: 'Turn 1', calls: [] };
                        if (step === 3) return { text: '', calls: [{ id: 'ps2', name: 'propose_skill', args: {} }] };
                        return { text: 'Turn 2', calls: [] };
                    }),
                },
            });
            document.body.appendChild(undoPage.el);
            await undoPage.show({ ws: 'preset', scope: 'global' });
            await flushMicrotasks();

            const sendU = async (msg) => {
                undoPage.el.querySelector('textarea.wb-input').value = msg;
                undoPage.el.querySelector('button.wb-send').click();
                await flushMicrotasks();
                await flushMicrotasks();
            };

            // Turn 1 edits `a`, apply Turn 1; then Turn 2 creates a pending skill-author proposal
            await sendU('change a');
            undoPage.el.querySelector('.wb-chg-foot button.is-primary').click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(disk.a).toBe('v1');

            await sendU('add skill');
            const undoBtn = [...undoPage.el.querySelectorAll('.wb-chg button')].find(b => b.textContent.includes('Undo'));
            expect(undoBtn).toBeTruthy();

            // Double-click Undo rapidly -> applying guard ensures history.undo runs only once
            undoBtn.click();
            undoBtn.click();
            await flushMicrotasks();
            expect(undoMock).toHaveBeenCalledTimes(1);

            resolveUndo();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(disk.a).toBe('v0');

            // Later pending turn (Turn 2) is discarded and its proposal bus entry cleaned up
            const [sSummary] = await undoSessions.list('iterate', { scope: 'global' });
            const savedAfterUndo = await undoSessions.get(sSummary.id, { scope: 'global' });
            expect(savedAfterUndo.turns[1].state).toBe('discarded');
            expect(savedAfterUndo.turns[3].state).toBe('discarded');
            expect(savedAfterUndo.turns[3].draft).toBeNull();
            undoPage.destroy();
        } finally {
            if (savedLuker !== undefined) globalThis.Luker = savedLuker;
        }
    });

    test('locks existing session pre-run via pendingSessions so rapid double-send and Enter cannot start duplicate runs', async () => {
        const savedLuker = globalThis.Luker;
        delete globalThis.Luker;
        try {
            const sessions = createMemorySessionStore();
            const sessionA = await sessions.create({
                kind: 'iterate',
                ws: 'card',
                scope: 'global',
                title: 'Existing A',
                turns: [{ role: 'user', text: 'A0', at: 1 }, { role: 'ai', text: 'A0 reply', at: 2 }],
                messages: [{ role: 'user', content: 'A0' }, { role: 'assistant', content: 'A0 reply' }],
            }, { scope: 'global' });
            const sessionB = await sessions.create({
                kind: 'iterate',
                ws: 'card',
                scope: 'global',
                title: 'Existing B',
                turns: [{ role: 'user', text: 'B0', at: 1 }, { role: 'ai', text: 'B0 reply', at: 2 }],
                messages: [{ role: 'user', content: 'B0' }, { role: 'assistant', content: 'B0 reply' }],
            }, { scope: 'global' });

            let deferNextLoad = false;
            let resolveDeferredLoad;
            let sendLoadCalls = 0;
            const target = {
                id: 'card',
                label: 'Card',
                tone: 'card',
                scopes: async () => ({ global: true }),
                load: jest.fn(async () => {
                    if (deferNextLoad) {
                        sendLoadCalls += 1;
                        return new Promise((resolve) => { resolveDeferredLoad = resolve; });
                    }
                    return { live: { description: 'Init' }, target: { scope: 'global', id: 'doc1' }, title: 'Doc 1' };
                }),
                targetKey: (t) => t?.id || 'doc1',
                prompt: async () => 'sys',
                tools: async () => [],
                isRead: () => false,
                runRead: async () => ({}),
                runEdit: async (_c, l) => l,
                units: () => new Map(),
                rebuild: (_b, a) => a,
                commit: async () => ({ applied: [], skipped: [], failure: '' }),
            };

            const aiRequest = jest.fn(async () => ({ text: 'Single reply', calls: [] }));
            const page = createIteratePage({
                sessions,
                layer: document.body,
                iterateTargets: () => [target],
                snapshot: () => ({}),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: { record: jest.fn(), canUndo: () => false, undo: jest.fn() },
                toast: jest.fn(),
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: { aiRequest },
            });
            document.body.appendChild(page.el);
            await page.show({ ws: 'card', scope: 'global' });
            await flushMicrotasks();

            const openA = () => [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Existing A'));
            const openB = () => [...page.el.querySelectorAll('.wb-sess-item')].find(b => b.textContent.includes('Existing B'));
            openA().click();
            await flushMicrotasks();

            const textarea = page.el.querySelector('textarea.wb-input');
            const sendBtn = page.el.querySelector('button.wb-send');
            deferNextLoad = true;
            textarea.value = 'Refine once';
            sendBtn.click();

            // Synchronously locked before target.load() settles
            expect(sendBtn.disabled).toBe(true);
            expect(textarea.disabled).toBe(true);

            // Second click + Enter keydown must not start a duplicate send
            sendBtn.click();
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await flushMicrotasks();
            expect(sendLoadCalls).toBe(1);
            expect(aiRequest).not.toHaveBeenCalled();

            // Switching to session B must remain unblocked; returning to session A keeps busy state
            openB().click();
            await flushMicrotasks();
            expect(sendBtn.disabled).toBe(false);
            expect(textarea.disabled).toBe(false);

            openA().click();
            await flushMicrotasks();
            expect(sendBtn.disabled).toBe(true);
            expect(textarea.disabled).toBe(true);

            deferNextLoad = false;
            resolveDeferredLoad({ live: { description: 'Init' }, target: { scope: 'global', id: 'doc1' }, title: 'Doc 1' });
            await flushMicrotasks();
            await flushMicrotasks();

            expect(sendLoadCalls).toBe(1);
            expect(aiRequest).toHaveBeenCalledTimes(1);
            expect(sendBtn.disabled).toBe(false);
            expect(textarea.disabled).toBe(false);
            const updatedA = await sessions.get(sessionA.id, { scope: 'global' });
            expect(updatedA.turns).toHaveLength(4);
            expect(updatedA.turns[3].text).toBe('Single reply');
            const untouchedB = await sessions.get(sessionB.id, { scope: 'global' });
            expect(untouchedB.turns).toHaveLength(2);
            page.destroy();
        } finally {
            if (savedLuker !== undefined) globalThis.Luker = savedLuker;
        }
    });

    test('regenerate() holds applying across truncation, stages bus/draft mutation until store.update persists, bails on null update, and clears undoTurn note', async () => {
        const savedLuker = globalThis.Luker;
        delete globalThis.Luker;
        try {
            let disk = { a: 'v0' };
            let diskSkill = { skill: 'old' };
            const skillWriteSpy = jest.fn(async (_t, next) => { diskSkill = JSON.parse(JSON.stringify(next)); });
            const commitSpy = jest.fn(async (_t, _b, next, keys) => {
                const prev = { ...disk };
                disk = { ...next };
                return { applied: keys, skipped: [], failure: '', undo: async () => { disk = prev; } };
            });
            const target = {
                id: 'preset',
                label: 'Preset',
                tone: 'preset',
                proposalKinds: {
                    'skill-author': {
                        ...skillAuthor,
                        inverseAvailable: true,
                        targetHandler: {
                            read: async () => JSON.parse(JSON.stringify(diskSkill)),
                            write: skillWriteSpy,
                            describe: () => 'skill:demo',
                        },
                    },
                },
                scopes: async () => ({ global: true }),
                load: async () => ({ live: { ...disk }, target: { scope: 'global', id: 'p_reg' }, title: 'Preset Reg' }),
                targetKey: (t) => t?.id || 'p_reg',
                prompt: async () => 'sys',
                tools: async () => [
                    { type: 'function', function: { name: 'edit_a' } },
                    { type: 'function', function: { name: 'propose_skill' } },
                ],
                isRead: () => false,
                runRead: async () => ({}),
                runEdit: async (call, live, helpers) => {
                    if (call.name === 'edit_a') return { ...live, a: call.args.v };
                    await helpers.propose({
                        kind: 'skill-author',
                        target: { type: 'skill-registry', name: 'demo', path: 'SKILL.md' },
                        before: { skill: 'old' },
                        after: { skill: 'new' },
                        meta: { kind: 'content', skillName: 'demo', before: 'old', after: 'new' },
                    });
                    return live;
                },
                units: (live) => new Map([['a', { key: 'a', label: 'A', group: 'Fields', text: String(live.a), raw: live.a }]]),
                rebuild: (base, ai, keys) => ({ ...base, ...(keys.includes('a') ? { a: ai.a } : {}) }),
                commit: commitSpy,
            };

            const sessions = createMemorySessionStore();
            const historyUndo = new Map();
            let hSeq = 0;
            const sentMessages = [];
            let round = 0;
            const aiRequest = jest.fn(async (_ws, { messages }) => {
                sentMessages.push(JSON.parse(JSON.stringify(messages)));
                round += 1;
                if (round === 1) {
                    return {
                        text: '',
                        calls: [
                            { id: 'c1', name: 'edit_a', args: { v: 'v1' } },
                            { id: 'c2', name: 'propose_skill', args: {} },
                        ],
                    };
                }
                if (round === 2) return { text: 'Initial proposal', calls: [] };
                return { text: 'Regenerated answer', calls: [] };
            });

            const toast = jest.fn();
            const page = createIteratePage({
                sessions,
                layer: document.body,
                iterateTargets: () => [target],
                snapshot: () => ({}),
                settings: () => ({ builtinPrompt: false, reviewChanges: true }),
                history: {
                    record: (entry) => {
                        const id = `hr_${++hSeq}`;
                        if (entry.undo) historyUndo.set(id, entry.undo);
                        return id;
                    },
                    canUndo: (id) => historyUndo.has(id),
                    undo: async (id) => { await historyUndo.get(id)?.(); historyUndo.delete(id); },
                },
                toast,
                reload: jest.fn(),
                refreshBadges: jest.fn(),
                source: { aiRequest },
            });
            document.body.appendChild(page.el);
            await page.show({ ws: 'preset', scope: 'global' });
            await flushMicrotasks();

            const textarea = page.el.querySelector('textarea.wb-input');
            const sendBtn = page.el.querySelector('button.wb-send');
            textarea.value = 'Refine field a';
            sendBtn.click();
            await flushMicrotasks();
            await flushMicrotasks();

            // 1) Hold store.update pending during regenerate() on a pending turn:
            //    applying lock must block concurrent delete/apply/regenerate, and rejection must preserve live bus & draft.
            const origUpdate = sessions.update;
            let rejectRegenUpdate;
            let interceptedUpdates = 0;
            sessions.update = jest.fn((id, patch, opts) => {
                interceptedUpdates += 1;
                return new Promise((_resolve, reject) => { rejectRegenUpdate = reject; });
            });

            const findRegenBtn = () => [...page.el.querySelectorAll('.wb-msg-acts button')].find(b => b.textContent.includes('Answer again'));
            const findApplyBtn = () => [...page.el.querySelectorAll('.wb-chg-foot button')].find(b => b.textContent.includes('Apply selected'));
            findRegenBtn().click();
            await Promise.resolve();

            expect(interceptedUpdates).toBe(1);
            expect(page.el.querySelector('.wb-sess-del')?.disabled).toBe(true);

            // Concurrent regenerate & apply while store.update is in flight must be ignored
            findRegenBtn().click();
            findApplyBtn().click();
            await flushMicrotasks();
            expect(interceptedUpdates).toBe(1);
            expect(commitSpy).not.toHaveBeenCalled();

            // Fail store.update: live proposal bus and turn draft must remain intact so Apply still commits both
            sessions.update = origUpdate;
            rejectRegenUpdate(new Error('storage offline'));
            await flushMicrotasks();
            await flushMicrotasks();
            expect(toast).toHaveBeenCalledWith(expect.stringContaining('storage offline'), expect.objectContaining({ error: true }));
            expect(page.el.querySelector('.wb-sess-del')?.disabled).toBe(false);

            findApplyBtn().click();
            await flushMicrotasks();
            await flushMicrotasks();
            expect(disk.a).toBe('v1');
            expect(skillWriteSpy).toHaveBeenCalledTimes(1);

            // 2) Regenerate an applied turn: undoTurn runs, regenerate clears undoTurn's note, and re-sent user message has no undo note prepended
            const preRegenSentCount = sentMessages.length;
            sessions.update.mockClear();
            findRegenBtn().click();
            await flushMicrotasks();
            await flushMicrotasks();
            await flushMicrotasks();

            expect(disk.a).toBe('v0');
            expect(diskSkill).toEqual({ skill: 'old' });
            expect(sentMessages.length).toBeGreaterThan(preRegenSentCount);
            const regenMessages = sentMessages[preRegenSentCount];
            const lastUserMsg = regenMessages.filter(m => m.role === 'user').at(-1);
            expect(lastUserMsg.content).toBe('Refine field a');
            const clearingCall = sessions.update.mock.calls.find(([, patch]) => patch.note === '' && Array.isArray(patch.messages));
            expect(clearingCall).toBeTruthy();

            // 3) Regenerate when store.update returns null (concurrently deleted session): bail without overwriting input.value or calling send()
            const aiCallsBeforeNull = aiRequest.mock.calls.length;
            sessions.update = jest.fn(async () => null);
            textarea.value = 'User draft must survive';
            findRegenBtn().click();
            await flushMicrotasks();
            await flushMicrotasks();

            expect(textarea.value).toBe('User draft must survive');
            expect(aiRequest).toHaveBeenCalledTimes(aiCallsBeforeNull);
            page.destroy();
        } finally {
            if (savedLuker !== undefined) globalThis.Luker = savedLuker;
        }
    });
});
