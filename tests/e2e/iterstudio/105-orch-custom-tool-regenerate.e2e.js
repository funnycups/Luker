import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { editOrchAgentField, enableOrchestratorMode, readOrchAgentField } from '../_lib/ui-orchestrator.js';
import { applyWorkbenchChanges, selectOrchPreset, setOrchMode, undoWorkbenchChangeCard } from '../_lib/ui-workbench.js';

let server, mock;
const tool = {
    name: 'tide_ledger', displayName: 'Tide ledger', description: 'Read the current tide ledger.',
    mode: 'read', parameters: { type: 'object', properties: {} }, body: 'return { tide: "ebb" };',
};
const sibling = { name: 'Spare watch', system_prompt: 'Keep the spare watch.', max_rounds: 7 };
const existingTool = { ...tool, name: 'read_watch', displayName: 'Read watch', body: 'return { bell: "dusk" };', simulateBody: '' };

function readOrchestrator() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'))).extension_settings.orchestrator;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'iterstudio', scenarioId: '105-custom-tool-regenerate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    const path = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(path));
    Object.assign(settings.extension_settings.orchestrator, {
        presetLibrariesMigrationDone: 1,
        executionMode: 'spec',
        presetLibraries: {
            spec: { watch: {
                name: 'Watch', spec: { stages: [{ id: 'watch', mode: 'serial', nodes: [{ id: 'keeper', preset: 'keeper' }] }], customTools: [existingTool], seededDefaultCustomTools: true },
                presets: { keeper: { systemPrompt: 'Keep the watch.', userPromptTemplate: 'Continue the watch.' } },
            } },
            loop: { spare: sibling }, agenda: {}, director: {},
        },
        activePresetIds: { spec: 'watch', loop: 'spare', agenda: '', director: '' },
    });
    settings.extension_settings.orchestrator.presetLibraries.spec.queued = {
        ...structuredClone(settings.extension_settings.orchestrator.presetLibraries.spec.watch),
        name: 'Queued watch',
    };
    for (const decision of ['apply', 'discard']) {
        settings.extension_settings.orchestrator.presetLibraries.spec[`${decision}-receipt`] = {
            ...structuredClone(settings.extension_settings.orchestrator.presetLibraries.spec.watch),
            name: `${decision} receipt`,
        };
    }
    writeFileSync(path, JSON.stringify(settings));
});

test.afterAll(async () => {  await mock?.stop(); });

function rejectFirstReviewDecision(wanted) {
    let rejected = false;
    return {
        get rejected() { return rejected; },
        async handle(route) {
            const body = route.request().postDataJSON();
            const isSessionNamespace = body.namespace === 'workbench_sessions' || String(body.namespace || '').startsWith('workbench_session_');
            const matches = isSessionNamespace && body.operations.some(op =>
                op.path.endsWith('/state') && op.value === wanted
                || op.value?.state === wanted
                || Array.isArray(op.value?.turns) && op.value.turns.some(turn => turn?.state === wanted));
            if (matches && !rejected) {
                rejected = true;
                await route.abort('failed');
            } else await route.continue();
        },
    };
}

async function verifyAppliedDecisionBeforeRetry(page, win, id, prompt) {
    await expect(page.locator('.wbench .wb-toast')).toContainText('Changes saved');
    expect(readOrchestrator().presetLibraries.spec[id].presets.keeper.systemPrompt).toBe(prompt);
    const completions = mock.requests.filter(request => request.url.includes('/chat/completions')).length;
    await win.getByRole('button', { name: /^(Answer again|重新回答|再次回答)$/ }).last().click();
    await expect(page.locator('.wbench .wb-toast')).toContainText('Save the pending review decision before continuing.');
    expect(mock.requests.filter(request => request.url.includes('/chat/completions'))).toHaveLength(completions);
}

async function verifyDiscardedDecisionBeforeRetry(_page, _win, id) {
    expect(readOrchestrator().presetLibraries.spec[id].spec.customTools).toEqual([existingTool]);
    expect(readOrchestrator().presetLibraries.spec[id].presets.keeper.systemPrompt).toBe('Keep the watch.');
}

const decisionCases = [
    {
        decision: 'apply', wanted: 'applied',
        decide: pending => pending.locator('.wb-chg-foot button.is-primary').click(),
        verifyBeforeRetry: verifyAppliedDecisionBeforeRetry,
    },
    {
        decision: 'discard', wanted: 'discarded',
        decide: pending => pending.getByRole('button', { name: /^(Discard everything|全部放弃|全部放棄)$/ }).click(),
        verifyBeforeRetry: verifyDiscardedDecisionBeforeRetry,
    },
];

for (const { decision, wanted, decide, verifyBeforeRetry } of decisionCases) {
    test(`${decision} retains its executable association when review-state acknowledgement fails`, async ({ page }) => {
        const id = `${decision}-receipt`;
        const prompt = `Record the ${decision} receipt beside the tide ledger.`;
        mock.scriptCompletion(({ turn }) => turn === 0 ? {
            toolCalls: [
                { name: 'luker_orch_set_custom_tool', arguments: tool },
                { name: 'luker_orch_set_preset', arguments: { preset_id: 'keeper', systemPrompt: prompt, userPromptTemplate: 'Continue the watch.' } },
            ],
        } : { text: 'The receipt draft is ready.' });
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'spec');
        await selectOrchPreset(page, id, { scope: 'global' });
        const win = await openIterStudio(page, 'orch', { scope: 'global' });
        await sendIterPrompt(page, 'orch', `Prepare the ${decision} receipt.`);
        await expect(win.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(2);
        const fault = rejectFirstReviewDecision(wanted);
        const failDecision = fault.handle;
        await page.route('**/api/state/patch', failDecision);
        try {
            const pending = win.locator('.wb-chg.is-pending');
            await decide(pending);
            await expect.poll(() => fault.rejected).toBe(true);
            await expect(page.locator('.wbench .wb-toast')).toContainText(/Could not save the review decision/);
            await verifyBeforeRetry(page, win, id, prompt);
            await expect(pending).toHaveCount(1);
            await applyWorkbenchChanges(page);
            const expectedTools = [existingTool, { ...tool, simulateBody: '' }];
            await expect.poll(() => readOrchestrator().presetLibraries.spec[id].spec.customTools).toEqual(expectedTools);
            expect(readOrchestrator().presetLibraries.spec[id].presets.keeper.systemPrompt).toBe(prompt);
            const history = await page.evaluate(async () => {
                const { createLukerSource } = await import('/scripts/workbench/source-luker.js');
                return JSON.parse(createLukerSource().historyStorage().getItem('workbench.history.v1'));
            });
            expect(history.filter(entry => entry.title.startsWith(`Prepare the ${decision} receipt`))).toHaveLength(1);
            await undoWorkbenchChangeCard(page);
            await expect.poll(() => readOrchestrator().presetLibraries.spec[id].presets.keeper.systemPrompt).toBe('Keep the watch.');
            expect(readOrchestrator().presetLibraries.spec[id].spec.customTools).toEqual(expectedTools);
            await closeIterStudio(page);
            await server.restart();
            await reloadAndAwait(page, server.baseURL);
            expect(readOrchestrator().presetLibraries.spec[id].presets.keeper.systemPrompt).toBe('Keep the watch.');
            expect(readOrchestrator().presetLibraries.spec[id].spec.customTools).toEqual(expectedTools);
            await selectOrchPreset(page, 'watch', { scope: 'global' });
            await closeIterStudio(page);
        } finally {
            await page.unroute('**/api/state/patch', failDecision);
        }
    });
}

test('approving a later field edit keeps an earlier custom-tool proposal executable', async ({ page }) => {
    mock.scriptCompletion(null);
    await awaitMainUI(page, server.baseURL);
    await enableOrchestratorMode(page, 'spec');
    await selectOrchPreset(page, 'queued', { scope: 'global' });
    const win = await openIterStudio(page, 'orch', { scope: 'global' });
    mock.scriptToolCall({ name: 'luker_orch_set_custom_tool', arguments: tool });
    mock.scriptReply('The tide ledger proposal is ready.');
    await sendIterPrompt(page, 'orch', 'Prepare the tide ledger tool without applying it.');
    mock.scriptToolCall({ name: 'luker_orch_set_preset', arguments: { preset_id: 'keeper', systemPrompt: 'Record the watch beside the tide ledger.', userPromptTemplate: 'Continue the watch.' } });
    mock.scriptReply('The watch prompt is ready.');
    await sendIterPrompt(page, 'orch', 'Revise the watch prompt separately.');
    await expect(win.locator('.wb-chg.is-pending')).toHaveCount(2);
    await applyWorkbenchChanges(page, { index: 1 });
    expect(readOrchestrator().presetLibraries.spec.queued.spec.customTools).toEqual([existingTool]);
    await closeIterStudio(page);
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    await openIterStudio(page, 'orch', { scope: 'global' });
    await win.locator('.wb-sess-item', { hasText: 'Prepare the tide ledger' }).first().click();
    await expect(win.locator('.wb-chg.is-pending')).toHaveCount(1);
    await applyWorkbenchChanges(page);
    await expect.poll(() => readOrchestrator().presetLibraries.spec.queued.spec.customTools).toEqual([existingTool, { ...tool, simulateBody: '' }]);
    expect(readOrchestrator().presetLibraries.spec.queued.presets.keeper.systemPrompt).toBe('Record the watch beside the tide ledger.');
    await closeIterStudio(page);
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    expect(readOrchestrator().presetLibraries.spec.queued.spec.customTools).toEqual([existingTool, { ...tool, simulateBody: '' }]);
    expect(readOrchestrator().presetLibraries.spec.queued.presets.keeper.systemPrompt).toBe('Record the watch beside the tide ledger.');
    await selectOrchPreset(page, 'watch', { scope: 'global' });
    await closeIterStudio(page);
});

test('custom-tool author approval persists once and regenerate retains the irreversible commit', async ({ page }) => {
    mock.scriptCompletion(({ turn }) => turn === 0
        ? { toolCalls: [
            { name: 'luker_orch_set_custom_tool', arguments: tool },
            { name: 'luker_orch_patch_custom_tool_body', arguments: { name: 'read_watch', oldString: '"dusk"', newString: '"midnight"' } },
        ] }
        : { text: turn === 1 ? 'The tide ledger is ready.' : 'The tide ledger remains ready for the watch.' });
    await awaitMainUI(page, server.baseURL);
    await enableOrchestratorMode(page, 'loop', { closeAfter: false });
    await editOrchAgentField(page, 'loop_agent', 'Keep the unsent observations in the spare ledger.');
    await setOrchMode(page, 'spec');
    await openIterStudio(page, 'orch', { scope: 'global' });
    await sendIterPrompt(page, 'orch', 'Prepare a tool for reading the tide ledger.');
    const wbWin = page.locator('.wbench .wb-win').first();
    await expect(wbWin.locator('.wb-chg.is-pending .wb-chg-line')).toHaveCount(2);
    await expect(wbWin).toContainText('The tide ledger is ready.');
    expect(readOrchestrator().presetLibraries.spec.watch.spec.customTools).toEqual([existingTool]);
    await applyIterBatch(page, 'orch');
    await expect.poll(() => readOrchestrator().presetLibraries.spec.watch.spec.customTools).toEqual([
        { ...existingTool, body: 'return { bell: "midnight" };' }, { ...tool, simulateBody: '' },
    ]);
    const approved = readOrchestrator().presetLibraries;
    expect(approved.loop.spare).toEqual(sibling);
    const count = () => mock.requests.filter(r => String(r.url).includes('/chat/completions')).length;
    const before = count();
    const answerAgain = wbWin.locator('.wb-msg-acts button.wb-msg-act', { hasText: /Answer again|重新回答/i }).last();
    await expect(answerAgain).toBeVisible({ timeout: 10_000 });
    await expect(answerAgain).toBeEnabled({ timeout: 10_000 });
    await answerAgain.click();
    await expect.poll(count).toBeGreaterThan(before);
    await expect(wbWin).toContainText('The tide ledger remains ready for the watch.');
    await expect(page.locator('.wbench .wb-toast.is-error')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast-error')).toHaveCount(0);
    expect(readOrchestrator().presetLibraries).toEqual(approved);
    await setOrchMode(page, 'loop');
    await expect.poll(() => readOrchAgentField(page, 'loop_agent')).toBe('Keep the unsent observations in the spare ledger.');
    expect(readOrchestrator().presetLibraries.loop.spare).toEqual(sibling);
    await closeIterStudio(page);
    await server.restart();
    await reloadAndAwait(page, server.baseURL);
    expect(readOrchestrator().presetLibraries).toEqual(approved);
});
