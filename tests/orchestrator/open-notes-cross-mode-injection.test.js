// tests/orchestrator/open-notes-cross-mode-injection.test.js
//
// Regression contract for the cross-mode Open Notes injection fix.
//
// Before the fix, only loop-mode and director-mode surfaced the
// persistent `## Open Notes` block into agent prompts. Spec worker
// nodes AND agenda planner + agenda text-agent (both single-round and
// multi-round paths) silently dropped it — an agent instructed to
// "check the open notes before dispatching agent 1" would report "no
// notes are open" regardless of what the notes store actually held,
// because the block was never in its prompt.
//
// The fix routes the shared `open-notes-injection` helper through
// every mode's task-message assembly so the invariant "every agent
// sees the Open Notes block, regardless of mode or note-tool
// permission" holds uniformly.
//
// These tests drive spec + agenda runtimes with an installed notes
// floor-state adapter and verify the system message going to the LLM
// contains `## Open Notes` + `- [id] text` per open entry. The LLM
// call itself is the only mock surface (per the project's testing
// contract: only upstream LLM API is legitimately mocked; adapters /
// registry / handlers run real).

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// ─── Ambient ST globals (same shape as skill-resolution-runtime-plumbing.test.js) ──
const __sillyTavernSettings = {
    orchestrator: {
        agendaPlannerMaxRounds: 4,
        agendaMaxConcurrentAgents: 2,
        agendaMaxTotalRuns: 12,
        nodeIterationMaxRounds: 3,
    },
};
globalThis.Luker = {
    __settings: __sillyTavernSettings,
    getContext: () => ({
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: {
            yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
        },
        extensionSettings: __sillyTavernSettings,
    }),
};

jest.unstable_mockModule('../../public/lib.js', () => ({
    Popper: {},
    lodash: {},
    yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) },
    default: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: __sillyTavernSettings,
    getContext: () => ({}),
    writeExtensionField: () => {},
    UNSET_VALUE: Symbol('unset'),
}));

jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => {},
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: (s) => s,
    chat_metadata: {},
    this_chid: 0,
    characters: [],
    getRequestHeaders: () => ({}),
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1 },
    wi_anchor_position: {},
}));

jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

// ─── LLM stub — captures taskMessages so we can assert the system
//     prompt carries the Open Notes block ────────────────────────────────
const capturedCalls = [];

jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/tool-calling.js', () => ({
    appendStandardToolRoundMessages: () => {},
    requestToolCallsWithRetry: async (_ctx, _settings, opts) => {
        capturedCalls.push({ path: 'multi', taskMessages: opts?.taskMessages || [] });
        // Return the next queued response.
        if (llmResponses.length === 0) throw new Error('requestToolCallsWithRetry stub exhausted');
        return llmResponses.shift();
    },
    requestToolCallWithRetry: async (_ctx, _settings, opts) => {
        capturedCalls.push({ path: 'single', taskMessages: opts?.taskMessages || [] });
        if (llmResponses.length === 0) throw new Error('requestToolCallWithRetry stub exhausted');
        return llmResponses.shift();
    },
    serializeToolResultContent: (r) => JSON.stringify(r),
    makeRuntimeToolCallId: () => `tc_${Math.random().toString(36).slice(2, 10)}`,
}));

// Skip real skill resolution (irrelevant to this contract; loading it
// pulls in more of the extensions surface than we need to stub).
jest.unstable_mockModule('../../public/scripts/extensions/orchestrator/skill-resolution.js', () => ({
    buildSkillRuntimeContext: () => ({}),
    resolveAgentVisibleSkills: async () => [],
    buildAvailableSkillsBlock: () => '',
    invalidateSkillInventory: () => {},
}));

// Notes adapter that returns a fixed list of open + closed entries. The
// production `attachNotesFloorState` opens a floor-state instance from
// the extension context's `createFloorState` factory — bypassed here by
// pre-populating `context.__floorStateForNotes` (the undefined-gate in
// attachNotesFloorState / attachToolContext short-circuits when the
// field is already set). This mirrors how loop-tools-note.test.js
// stubs the adapter.
function makeNotesContext() {
    return {
        __floorStateForNotes: {
            listAcrossFloors: async () => ([
                { id: 'note_alpha', text: 'planted foreshadowing about the storm', status: 'open' },
                { id: 'note_beta', text: 'promise: reunion by chapter 5', status: 'open' },
                { id: 'note_closed', text: 'already-paid-off thread', status: 'closed' },
            ]),
        },
        // Sentinel so we can detect if attachNotesFloorState (which we
        // want to bypass because it would replace our stub) accidentally
        // ran anyway — it clobbers this to a real adapter object.
        __openNotes: [
            { id: 'note_alpha', text: 'planted foreshadowing about the storm' },
            { id: 'note_beta', text: 'promise: reunion by chapter 5' },
        ],
    };
}

const llmResponses = [];

let runAgendaPlannerStep;
let runAgendaTextAgent;
let runWorkerNode;

beforeAll(async () => {
    ({ runAgendaPlannerStep, runAgendaTextAgent } = await import('../../public/scripts/extensions/orchestrator/agenda-runtime.js'));
    ({ runWorkerNode } = await import('../../public/scripts/extensions/orchestrator/spec-runtime.js'));
});

beforeEach(() => {
    llmResponses.length = 0;
    capturedCalls.length = 0;
});

describe('agenda mode: Open Notes reach planner + agent (single-round path)', () => {
    test('agenda planner receives the ## Open Notes block inlined at the tail of userText (cache-aligned)', async () => {
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'Plan the round.', userPromptTemplate: 'plan' },
            agents: { writer: { systemPrompt: 'Write.', userPromptTemplate: 'user' } },
            finalAgentId: 'writer',
            limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
        };
        llmResponses.push({ finalize: 'done.' });

        await runAgendaPlannerStep(
            makeNotesContext(),
            { signal: new AbortController().signal },
            [],
            profile,
            { plannerRounds: 0, todos: [], runs: [] },
        );

        expect(capturedCalls.length).toBe(1);
        // Cache-alignment: system prefix stays byte-identical (Open
        // Notes NOT in system), volatile block rides on the trailing
        // user message.
        const sys = capturedCalls[0].taskMessages.find(m => m.role === 'system');
        expect(sys).toBeDefined();
        expect(sys.content).toBe('Plan the round.');
        expect(sys.content).not.toContain('## Open Notes');

        const userMsg = capturedCalls[0].taskMessages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toContain('## Open Notes');
        expect(userMsg.content).toContain('[note_alpha] planted foreshadowing about the storm');
        expect(userMsg.content).toContain('[note_beta] promise: reunion by chapter 5');
        expect(userMsg.content).not.toContain('already-paid-off');
    });

    test('agenda single-round agent receives the ## Open Notes block inlined at the tail of userText (cache-aligned)', async () => {
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'Plan.', userPromptTemplate: 'plan' },
            agents: {
                writer: {
                    systemPrompt: 'Write the scene.',
                    userPromptTemplate: 'user',
                },
            },
            finalAgentId: 'writer',
            limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
        };
        llmResponses.push({ text: 'writer output' });

        await runAgendaTextAgent(
            makeNotesContext(),
            { signal: new AbortController().signal },
            [],
            profile,
            { plannerRounds: 1, todos: [], runs: [] },
            { todoId: 'main', agent: 'writer', taskBrief: 'do it', inputRunIds: [] },
            { kind: 'agent' },
        );

        expect(capturedCalls.length).toBe(1);
        expect(capturedCalls[0].path).toBe('single');
        const sys = capturedCalls[0].taskMessages.find(m => m.role === 'system');
        expect(sys).toBeDefined();
        expect(sys.content).toContain('Write the scene.');
        // System prefix must NOT carry Open Notes anymore — cache
        // alignment goal is a stable system prefix across dispatches.
        expect(sys.content).not.toContain('## Open Notes');

        const userMsg = capturedCalls[0].taskMessages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toContain('## Open Notes');
        expect(userMsg.content).toContain('[note_alpha]');
        expect(userMsg.content).toContain('[note_beta]');
        expect(userMsg.content).not.toContain('already-paid-off');
        // Tail is still user role (not consecutive same-role) — Open
        // Notes are inlined into the existing user message, not pushed
        // as a new one.
        const last = capturedCalls[0].taskMessages[capturedCalls[0].taskMessages.length - 1];
        expect(last.role).toBe('user');
    });

    test('agenda agent does NOT see the ## Open Notes block when the store is empty', async () => {
        const profile = {
            mode: 'agenda',
            planner: { systemPrompt: 'Plan.', userPromptTemplate: 'plan' },
            agents: { writer: { systemPrompt: 'Write.', userPromptTemplate: 'user' } },
            finalAgentId: 'writer',
            limits: { plannerMaxRounds: 2, maxConcurrentAgents: 1, maxTotalRuns: 4 },
        };
        llmResponses.push({ text: 'writer output' });

        const emptyCtx = {
            __floorStateForNotes: {
                listAcrossFloors: async () => ([]),
            },
        };

        await runAgendaTextAgent(
            emptyCtx,
            { signal: new AbortController().signal },
            [],
            profile,
            { plannerRounds: 1, todos: [], runs: [] },
            { todoId: 'main', agent: 'writer', taskBrief: 'do it', inputRunIds: [] },
            { kind: 'agent' },
        );

        expect(capturedCalls.length).toBe(1);
        const sys = capturedCalls[0].taskMessages.find(m => m.role === 'system');
        expect(sys).toBeDefined();
        expect(sys.content).not.toContain('## Open Notes');
        const userMsg = capturedCalls[0].taskMessages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).not.toContain('## Open Notes');
    });
});

describe('spec mode: Open Notes reach every worker node', () => {
    test('spec worker node receives the ## Open Notes block inlined at the tail of iterationPrompt (cache-aligned)', async () => {
        const nodeSpec = { id: 'n1', preset: 'p1', type: 'worker' };
        const preset = {
            id: 'p1',
            systemPrompt: 'You are a spec worker.',
            userPromptTemplate: 'user',
        };
        const runtime = {
            stages: [{ id: 's1', mode: 'serial', nodes: [nodeSpec] }],
            stageOutputs: [],
            reviewRerunCount: 0,
            approvedReviewFeedbackEntries: [],
            trace: null,
            runId: null,
            specDefaultTools: null,
            spec: { stages: [] },
            customToolRegistry: null,
            activeOrchPresetName: 'test',
            contextForNotes: makeNotesContext(),
        };
        llmResponses.push({
            toolCalls: [{ id: 'tc1', name: 'luker_orch_final_guidance', args: { text: 'done' } }],
            assistantText: '',
            reasoning: '',
        });

        await runWorkerNode(
            {},
            { signal: new AbortController().signal },
            nodeSpec,
            preset,
            [],
            new Map(),
            null,
            { runtime, stageIndex: 0, nodeIndex: 0, isFinalStage: true },
        );

        expect(capturedCalls.length).toBe(1);
        const sys = capturedCalls[0].taskMessages.find(m => m.role === 'system');
        expect(sys).toBeDefined();
        expect(sys.content).toContain('You are a spec worker.');
        // System prefix stays stable across rounds — Open Notes must
        // NOT be there.
        expect(sys.content).not.toContain('## Open Notes');

        const userMsg = capturedCalls[0].taskMessages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toContain('## Open Notes');
        expect(userMsg.content).toContain('[note_alpha]');
        expect(userMsg.content).toContain('[note_beta]');
        expect(userMsg.content).not.toContain('already-paid-off');
        // Tail is still user role.
        const last = capturedCalls[0].taskMessages[capturedCalls[0].taskMessages.length - 1];
        expect(last.role).toBe('user');
    });

    test('spec worker does NOT see the ## Open Notes block when the store is empty', async () => {
        const nodeSpec = { id: 'n1', preset: 'p1', type: 'worker' };
        const preset = {
            id: 'p1',
            systemPrompt: 'You are a spec worker.',
            userPromptTemplate: 'user',
        };
        const runtime = {
            stages: [{ id: 's1', mode: 'serial', nodes: [nodeSpec] }],
            stageOutputs: [],
            reviewRerunCount: 0,
            approvedReviewFeedbackEntries: [],
            trace: null,
            runId: null,
            specDefaultTools: null,
            spec: { stages: [] },
            customToolRegistry: null,
            activeOrchPresetName: 'test',
            contextForNotes: {
                __floorStateForNotes: {
                    listAcrossFloors: async () => ([]),
                },
            },
        };
        llmResponses.push({
            toolCalls: [{ id: 'tc1', name: 'luker_orch_final_guidance', args: { text: 'done' } }],
            assistantText: '',
            reasoning: '',
        });

        await runWorkerNode(
            {},
            { signal: new AbortController().signal },
            nodeSpec,
            preset,
            [],
            new Map(),
            null,
            { runtime, stageIndex: 0, nodeIndex: 0, isFinalStage: true },
        );

        const sys = capturedCalls[0].taskMessages.find(m => m.role === 'system');
        expect(sys.content).toBe('You are a spec worker.');
        expect(sys.content).not.toContain('## Open Notes');
        const userMsg = capturedCalls[0].taskMessages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).not.toContain('## Open Notes');
    });
});
