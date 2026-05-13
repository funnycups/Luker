/**
 * End-to-end integration tests for orchestrator loop mode (Plan Task 15).
 *
 * Each scenario drives the real `runLoopOrchestration` driver and exercises
 * the full multi-round messages-array contract: scripted `sendLlm` returns
 * tool calls, the runtime dispatches them through `executeTool` (production
 * `executeLoopTool` for happy paths or a small mock for failure injection),
 * and assertions cover capsule body, runtimeTrace events, prompt-injected
 * notes, lorebook activated-set dedup, and the abort path.
 *
 * Mock fixture style mirrors `loop-runtime.test.js`: dependency injection
 * via `deps.sendLlm` / `deps.executeTool`, in-memory floor-state adapter
 * for note persistence (matches the production `makeNotesAdapter` shape so
 * `attachNotesFloorState` does not get reached). Real `loop-tools` registry
 * is exercised for chat / lorebook / memory paths via injected fixtures
 * (`__getSortedEntriesFn`, `__memoryStore`, `__memoryDeps`,
 * `__floorStateForNotes`) — no `lib.js` dependency is touched, so tests
 * run on the Node-based jest config.
 */

import { describe, test, expect, jest } from '@jest/globals';

import {
    runLoopOrchestration,
} from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeProfile(overrides = {}) {
    return {
        mode: 'loop',
        apiPresetName: '',
        promptPresetName: '',
        system_prompt: 'You are a research assistant for the autumn-festival saga.',
        tools: {
            note: { add: true },
            chat: { read_range: true, search: true },
            lorebook: { search: true, get: true },
            memory: { search: true, list_recent: true, get: true },
            finalize: true,
        },
        max_rounds: 10,
        wall_clock_budget_ms: 60000,
        capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        ...overrides,
    };
}

function makeFakeFloorStateNotes(initialEntries = []) {
    // Mirrors the in-memory shape exposed by `loop-tools-note.test.js`'s
    // fixture; production `makeNotesAdapter` exposes the same call names so
    // the tool itself doesn't know which path it's on. Keeping this mock
    // close to the production adapter lets us exercise note_add through the
    // real registry without touching floor-state.
    let counter = 0;
    const mintId = () => `t_${++counter}`;
    const stored = initialEntries.map(text => ({ floor: 0, id: mintId(), text: String(text) }));
    return {
        stored,
        appendForFloor: async (floor, text) => {
            const id = mintId();
            stored.push({ floor, id, text: String(text) });
            return id;
        },
        listAcrossFloors: async () => stored.map(s => ({ id: s.id, text: s.text })),
        pruneOldest: async (n) => {
            if (n > 0) stored.splice(0, Math.min(n, stored.length));
        },
        deleteByIds: async (ids) => {
            const target = new Set(Array.isArray(ids) ? ids.map(s => String(s)) : []);
            const present = new Set(stored.map(s => s.id));
            let removed = 0;
            for (let i = stored.length - 1; i >= 0; i -= 1) {
                if (target.has(stored[i].id)) {
                    stored.splice(i, 1);
                    removed += 1;
                }
            }
            const missing = [];
            for (const id of target) {
                if (!present.has(id)) missing.push(id);
            }
            return { removed, missing };
        },
    };
}

function makeChatContext({ chat = [], notesAdapter = null, sortedEntries = null, memoryStore = null, memoryDeps = null, activatedEntryKeys = null, targetFloorForNote = null } = {}) {
    // Loose context object that matches what the orchestrator hands the
    // runtime in production: a plain object with `chat`, plus the optional
    // run-scoped helpers loop-runtime reads through `Object.create(context)`.
    const ctx = { chat: chat.slice() };
    if (notesAdapter !== null) {
        ctx.__floorStateForNotes = notesAdapter;
        // Pre-populate the loaded notes so buildInitialMessages sees them
        // (production attachNotesFloorState does the same eager load).
        ctx.__loopNotes = [];
        // Snapshot starts empty too — note_add / note_delete keep it in sync
        // as the test progresses. Matches production attachNotesFloorState.
        ctx.__noteIdSnapshot = [];
    }
    if (sortedEntries !== null) {
        ctx.__getSortedEntriesFn = async () => sortedEntries;
    }
    if (memoryStore !== null) {
        ctx.__memoryStore = memoryStore;
    }
    if (memoryDeps !== null) {
        ctx.__memoryDeps = memoryDeps;
    }
    if (activatedEntryKeys !== null) {
        ctx.__lukerLoop = { activatedEntryKeys };
    }
    if (targetFloorForNote !== null) {
        ctx.__targetFloorForNote = targetFloorForNote;
    }
    return ctx;
}

function makePayload({ signal = new AbortController().signal, activatedEntryKeys = null } = {}) {
    const payload = { signal, coreChat: [] };
    if (activatedEntryKeys !== null) {
        payload.__lukerLoop = { activatedEntryKeys };
    }
    return payload;
}

function eventTypes(trace) {
    return (trace?.events || []).map(e => e.type);
}

describe('loop mode end-to-end: complete 6-round happy path (Task 15a)', () => {
    test('model -> note_add -> lorebook_search -> lorebook_get -> memory_search -> finalize', async () => {
        // Scripted six-round trajectory. Each `mockImplementationOnce` reads
        // the messages array we observed at that round so we can assert
        // tool-result threading at the boundary; the final round commits
        // the capsule body that snapshot-cache / capsule-injection consumes
        // at the orchestrator dispatcher layer (exercised in main.js path,
        // not here — we assert capsule shape + trace ordering instead).
        const observedRounds = [];
        const sendLlm = jest.fn()
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 1, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc1', name: 'note_add', args: { text: 'Lyra mentioned the festival opens at dusk.' } },
                    ],
                    assistantText: 'I will start by recording the festival timing.',
                };
            })
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 2, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc2', name: 'lorebook_search', args: { query: 'festival', limit: 3 } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 3, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc3', name: 'lorebook_get', args: { entry_key: 'autumn-fest' } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 4, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc4', name: 'memory_search', args: { query: 'Lyra', limit: 3 } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 5, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc5', name: 'memory_get', args: { node_id: 'lyra-vow' } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async ({ messages }) => {
                observedRounds.push({ round: 6, messageCount: messages.length });
                return {
                    toolCalls: [
                        { id: 'tc6', name: 'finalize', args: {
                            capsule_text: 'Dusk opening at the autumn festival; Lyra recalls her vow before entering.',
                        } },
                    ],
                    assistantText: '',
                };
            });

        const sortedEntries = [
            { world: 'global', uid: 1, key: ['festival'],     content: 'The autumn festival is the largest gathering of the season.' },
            { world: 'global', uid: 2, key: ['autumn-fest'],  content: 'Autumn-fest opens at dusk on the first cold night.' },
            { world: 'global', uid: 3, key: ['winter-feast'], content: 'Winter feast unrelated.' },
        ];
        const memoryStore = { nodes: { 'lyra-vow': { id: 'lyra-vow', title: 'Lyra\'s vow' } } };
        const memoryDeps = {
            searchNodesLexical: () => ({ nodes: [{ id: 'lyra-vow', preview: 'Lyra swore a vow at the last festival.' }] }),
            listRecentNodes: () => ({ nodes: [] }),
            getNodeById: () => ({
                node: { id: 'lyra-vow', title: 'Lyra\'s vow', summary: 'Lyra promises to return at autumn.' },
                neighbors: [{ id: 'autumn-festival-node', edgeType: 'mentioned_at' }],
            }),
            getCurrentlyInjectedNodeIds: () => ({ alwaysInjectIds: new Set(), recallSelectedIds: new Set() }),
        };
        const notesAdapter = makeFakeFloorStateNotes();

        const context = makeChatContext({
            chat: [
                { mes: 'Tell me about the festival opening.', is_user: true },
            ],
            notesAdapter,
            sortedEntries,
            memoryStore,
            memoryDeps,
            activatedEntryKeys: new Set(),
            targetFloorForNote: 0,
        });

        const result = await runLoopOrchestration(context, makePayload(), makeProfile(), { sendLlm });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('Dusk opening at the autumn festival; Lyra recalls her vow before entering.');
        expect(result.total_rounds).toBe(6);
        expect(sendLlm).toHaveBeenCalledTimes(6);

        // Each subsequent round's messages array should grow as
        // assistant + tool result entries get appended, proving the
        // tool-message threading works end-to-end. Round 1 starts at
        // 1 (system prompt) and each round adds 2 (assistant + tool).
        const counts = observedRounds.map(r => r.messageCount);
        expect(counts[0]).toBe(1);
        expect(counts[1]).toBe(3);
        expect(counts[2]).toBe(5);
        expect(counts[3]).toBe(7);
        expect(counts[4]).toBe(9);
        expect(counts[5]).toBe(11);

        // The note we wrote in round 1 made it through the adapter; this
        // is what would be injected into the next run's system prompt.
        const persistedNotes = await notesAdapter.listAcrossFloors();
        expect(persistedNotes).toHaveLength(1);
        expect(persistedNotes[0].text).toMatch(/Lyra mentioned the festival opens at dusk/);

        // Trace coverage: every key event type fired in order.
        const types = eventTypes(result.runtimeTrace);
        expect(types).toContain('run_started');
        expect(types).toContain('llm_request');
        expect(types).toContain('tool_call');
        expect(types).toContain('tool_result');
        expect(types).toContain('run_finished');
        expect(result.runtimeTrace.status).toBe('completed');
        expect(result.runtimeTrace.capsuleText).toBe(result.capsule);
        // Six rounds means six tool_call events for the dispatched tools.
        const toolCallEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_call');
        expect(toolCallEvents).toHaveLength(6);
        expect(toolCallEvents.map(e => e.name)).toEqual([
            'note_add', 'lorebook_search', 'lorebook_get', 'memory_search', 'memory_get', 'finalize',
        ]);
    });
});

describe('loop mode end-to-end: tool failure -> agent self-correction (Task 15b)', () => {
    test('first lorebook_search has empty query -> ToolError -> agent retries with non-empty query and finalizes', async () => {
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'lorebook_search', args: { query: '' } },
                ],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                // Deep-copy so subsequent mutations to the shared messages
                // array (the runtime keeps appending tool results) do not
                // leak into our assertion.
                secondRoundMessages = JSON.parse(JSON.stringify(messages));
                return {
                    toolCalls: [
                        { id: 'tc2', name: 'lorebook_search', args: { query: 'autumn', limit: 3 } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc3', name: 'finalize', args: { capsule_text: 'Recovered: festival opens at dusk.' } },
                ],
                assistantText: '',
            }));

        const sortedEntries = [
            { world: 'global', uid: 10, key: ['autumn'], content: 'Autumn arrives in three phases.' },
        ];

        const context = makeChatContext({
            chat: [{ mes: 'Find autumn lore.', is_user: true }],
            sortedEntries,
            activatedEntryKeys: new Set(),
        });

        const result = await runLoopOrchestration(context, makePayload(), makeProfile({
            tools: {
                note: { add: false },
                chat: { read_range: false, search: false },
                lorebook: { search: true, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), { sendLlm });

        expect(result.status).toBe('completed');
        expect(result.capsule).toBe('Recovered: festival opens at dusk.');
        expect(sendLlm).toHaveBeenCalledTimes(3);

        // Round 2 must have observed the structured ToolError from round 1
        // sitting in the messages array as a `role: tool` entry.
        const errMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(errMsg).toBeTruthy();
        const errPayload = typeof errMsg.content === 'string' ? JSON.parse(errMsg.content) : errMsg.content;
        expect(errPayload.ok).toBe(false);
        expect(String(errPayload.error || '')).toMatch(/non-empty/i);

        // Round 2's tool_result should include the recovered ok-shaped message.
        const okMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc2');
        // The retry result lands AFTER the round-2 sendLlm observation, so
        // it isn't in secondRoundMessages — but we can confirm the trace.
        expect(okMsg).toBeUndefined();
        const errorEvents = result.runtimeTrace.events.filter(e => e.type === 'tool_error');
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].name).toBe('lorebook_search');
    });
});

describe('loop mode end-to-end: lorebook activated-entry dedup (Task 15c)', () => {
    test('payload.__lukerLoop.activatedEntryKeys propagates to lorebook_search and excludes pre-injected entries', async () => {
        // The orchestrator main.js seeds payload.__lukerLoop with the World
        // Info entries already activated for this turn; the runtime forwards
        // those into toolContext so lorebook_search can dedup. Here we
        // simulate that by passing the activated set on the payload and
        // letting the runtime hand it to the tool.
        let toolResultObserved = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'lorebook_search', args: { query: 'autumn', limit: 5 } },
                ],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                // Round 2 sees the dedup result on its messages array.
                // Snapshot the array to insulate from later mutations.
                const frozen = JSON.parse(JSON.stringify(messages));
                const okMsg = frozen.find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1') || null;
                toolResultObserved = okMsg
                    ? (typeof okMsg.content === 'string' ? JSON.parse(okMsg.content) : okMsg.content)
                    : null;
                return {
                    toolCalls: [
                        { id: 'tc2', name: 'finalize', args: { capsule_text: 'Saw deduped lorebook entries.' } },
                    ],
                    assistantText: '',
                };
            });

        const sortedEntries = [
            // Already activated this turn — must be excluded.
            { world: 'global', uid: 1, key: ['autumn-rite'], content: 'The rite of autumn precedes the feast.' },
            { world: 'global', uid: 2, key: ['autumn-vow'],  content: 'Autumn vows are sworn under the harvest moon.' },
            // Not activated — must appear.
            { world: 'global', uid: 3, key: ['autumn-end'],  content: 'Autumn ends with the first deep frost.' },
        ];

        const activatedEntryKeys = new Set(['global.1', 'global.2']);
        const context = makeChatContext({
            chat: [{ mes: 'Look up autumn lore.', is_user: true }],
            sortedEntries,
        });

        const result = await runLoopOrchestration(context, makePayload({ activatedEntryKeys }), makeProfile({
            tools: {
                note: { add: false },
                chat: { read_range: false, search: false },
                lorebook: { search: true, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), { sendLlm });

        expect(result.status).toBe('completed');
        expect(toolResultObserved).toBeTruthy();
        // Tool results land under `data` when normalizeToolOk wraps a non-{ok}
        // payload (lorebook_search returns { entries, excluded_active_count }).
        const payload = toolResultObserved.data || toolResultObserved;
        expect(payload.excluded_active_count).toBe(2);
        expect(payload.entries).toHaveLength(1);
        expect(payload.entries[0].key).toContain('autumn-end');
    });
});

describe('loop mode end-to-end: note persistence across runs (Task 15d)', () => {
    test('first run writes a note; second run starts with system prompt that includes that note', async () => {
        // Persistent floor-state adapter: the second run reuses the same
        // adapter instance so listAcrossFloors() returns the note written
        // in run 1. This proves the production wiring contract: the system
        // prompt builder reads `__loopNotes` (which production
        // attachNotesFloorState pre-populates from the adapter), and any
        // notes written in earlier runs surface for the next loop start.
        const notesAdapter = makeFakeFloorStateNotes();

        // ---- Run 1 (floor F): writes one note, then finalizes.
        const sendLlm1 = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'note_add', args: { text: 'Lyra wears the crimson sash to the rite.' } },
                ],
                assistantText: '',
            }))
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc2', name: 'finalize', args: { capsule_text: 'First-run guidance.' } },
                ],
                assistantText: '',
            }));

        const ctxRun1 = makeChatContext({
            chat: [{ mes: 'Setting the scene.', is_user: true }],
            notesAdapter,
            targetFloorForNote: 5,
        });

        const result1 = await runLoopOrchestration(ctxRun1, makePayload(), makeProfile({
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), { sendLlm: sendLlm1 });

        expect(result1.status).toBe('completed');
        expect((await notesAdapter.listAcrossFloors())[0].text).toMatch(/crimson sash/);

        // ---- Run 2 (floor F+1): observe round-1 messages array; system
        // prompt should already contain the note from run 1.
        let observedRun2Messages = null;
        const sendLlm2 = jest.fn().mockImplementationOnce(async ({ messages }) => {
            observedRun2Messages = JSON.parse(JSON.stringify(messages));
            return {
                toolCalls: [
                    { id: 'tc3', name: 'finalize', args: { capsule_text: 'Second-run guidance.' } },
                ],
                assistantText: '',
            };
        });

        const ctxRun2 = makeChatContext({
            chat: [
                { mes: 'Setting the scene.', is_user: true },
                { mes: 'The rite begins.',   is_user: false },
            ],
            notesAdapter,
            targetFloorForNote: 6,
        });
        // Pre-load __loopNotes the way production attachNotesFloorState does
        // (since we provide a fake adapter, the production loader path is
        // skipped; the runtime expects __loopNotes already populated when
        // __floorStateForNotes is supplied via context).
        ctxRun2.__loopNotes = await notesAdapter.listAcrossFloors();

        const result2 = await runLoopOrchestration(ctxRun2, makePayload(), makeProfile({
            tools: {
                note: { add: true },
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
        }), { sendLlm: sendLlm2 });

        expect(result2.status).toBe('completed');
        expect(observedRun2Messages).toBeTruthy();

        // The first message is the system prompt; loop-runtime weaves the
        // historical notes block in after the user-authored body.
        const sysMsg = observedRun2Messages.find(m => m.role === 'system');
        expect(sysMsg).toBeTruthy();
        expect(sysMsg.content).toMatch(/Previous Notes/);
        expect(sysMsg.content).toMatch(/crimson sash/);
    });
});

describe('loop mode end-to-end: abort path (Task 15e)', () => {
    test('AbortController.abort() between round 1 and round 2 propagates a runtime error and trace finalizes as failed', async () => {
        const aborter = new AbortController();
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => {
                // Schedule the abort to fire after this LLM call resolves but
                // before the runtime re-enters the loop body for round 2;
                // the abort check at the top of the next iteration must
                // throw and surface the error to the caller.
                queueMicrotask(() => aborter.abort());
                return {
                    toolCalls: [
                        { id: 'tc1', name: 'note_add', args: { text: 'first' } },
                    ],
                    assistantText: '',
                };
            })
            .mockImplementationOnce(async () => {
                // Should never run — the round-2 abort check throws first.
                return {
                    toolCalls: [
                        { id: 'tc2', name: 'finalize', args: { capsule_text: 'should not be visible' } },
                    ],
                    assistantText: '',
                };
            });

        const notesAdapter = makeFakeFloorStateNotes();
        const context = makeChatContext({
            chat: [{ mes: 'start.', is_user: true }],
            notesAdapter,
        });

        await expect(
            runLoopOrchestration(context, makePayload({ signal: aborter.signal }), makeProfile({
                tools: {
                    note: { add: true },
                    chat: { read_range: false, search: false },
                    lorebook: { search: false, get: false },
                    memory: { search: false, list_recent: false, get: false },
                    finalize: true,
                },
            }), { sendLlm }),
        ).rejects.toThrow(/aborted/i);

        // Round 1's tool ran (and persisted), but round 2 never reached
        // sendLlm and the post-loop finalize never executed.
        expect(sendLlm).toHaveBeenCalledTimes(1);
        const persisted = await notesAdapter.listAcrossFloors();
        expect(persisted.map(n => n.text)).toEqual(['first']);
    });

    test('pre-aborted signal raises before the first sendLlm call', async () => {
        // Complementary case: the signal is already aborted when the
        // runtime is invoked. No LLM calls, no tool dispatch, no capsule.
        const aborter = new AbortController();
        aborter.abort();
        const sendLlm = jest.fn();

        await expect(
            runLoopOrchestration(makeChatContext({}), makePayload({ signal: aborter.signal }), makeProfile(), { sendLlm }),
        ).rejects.toThrow(/aborted/i);
        expect(sendLlm).not.toHaveBeenCalled();
    });
});
