// #100 — Orchestrator iter-studio: `luker_orch_list_preset_routing` returns
// the connection profiles and chat completion presets that exist on the
// running server, on demand.
//
// Regression guard for B14: the read-first refactor removed the up-front
// routing dump while the iteration prompts kept telling the AI to pick
// apiPresetName / promptPresetName from it.
//
// REAL USER-GESTURE flow:
//   1. Fixtures (before the page loads): an extra connection profile and an
//      extra chat completion preset file.
//   2. In the orchestrator drawer: enable, switch to director mode, and pick
//      both as the global agent API / prompt preset on the General tab.
//   3. Open the director iter-studio and send a prompt. The mock LLM calls
//      the routing tool in round 1 and answers with text in round 2.
//   4. Expand the tool chip's Result block: the JSON the user sees lists
//      exactly the profiles in settings.json and the preset files on disk,
//      and the round-2 request replays the same JSON to the model.
//   5. Restart the server, reload, load the session from history: the chip
//      still shows the result and the next round replays it unchanged.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writePreset } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { enableOrchestratorMode, setOrchestratorDefaultApiProfile } from '../_lib/ui-orchestrator.js';
import { closeWorkbench, openOrchWorkspace } from '../_lib/ui-workbench.js';
import { normalizeIterStudioSettings, readGlobalWorkbenchBodies } from './_helpers.js';

const TOOL = 'luker_orch_list_preset_routing';
const ROUTE_PROFILE = 'Lighthouse Relay';
const ROUTE_PRESET = 'Harbor Watch';
const FIRST_PROMPT = 'Before the tide-watch sub-agent gets its own route, check which connections and chat presets the keeper has set up.';
const FIRST_REPLY = 'The keeper runs two connections, Lighthouse Relay and the mock line, and Harbor Watch is the default chat preset for every agent.';
const SECOND_PROMPT = 'If we leave the tide-watch routing empty, which connection does it inherit?';
const SECOND_REPLY = 'Left empty, the tide-watch sub-agent inherits Lighthouse Relay from the orchestration defaults.';

let server, mock;

function settingsPath() {
    return resolve(server.dataRoot, 'default-user', 'settings.json');
}

function readSettings() {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
}

function chatCompletionProfileNamesOnDisk() {
    return (readSettings().extension_settings?.connectionManager?.profiles || [])
        .filter((profile) => profile?.mode === 'cc')
        .map((profile) => String(profile.name || '').trim())
        .filter(Boolean)
        .sort();
}

function chatCompletionPresetNamesOnDisk() {
    return readdirSync(resolve(server.dataRoot, 'default-user', 'OpenAI Settings'))
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .sort();
}

function routingRequests() {
    return mock.requests.filter((r) => String(r.url || '').includes('chat/completions')
        && Array.isArray(r.body?.tools)
        && r.body.tools.some((t) => t?.function?.name === TOOL));
}

function toolMessages(request) {
    return (Array.isArray(request?.body?.messages) ? request.body.messages : []).filter((m) => m?.role === 'tool');
}

function parseToolContent(message) {
    return typeof message?.content === 'string' ? JSON.parse(message.content) : message?.content;
}

function routingChip(page) {
    return page.locator('.wbench .wb-tool-entry').filter({
        has: page.locator('.wb-tool-name', { hasText: TOOL }),
    }).first();
}

async function readChipResult(page) {
    const trace = page.locator('.wbench .wb-tool-trace').first();
    if ((await trace.getAttribute('open')) === null) {
        await trace.locator('> summary').click();
    }
    const chip = routingChip(page);
    await chip.waitFor({ state: 'visible', timeout: 30_000 });
    const pre = chip.locator('pre:last-child');
    await pre.waitFor({ state: 'visible', timeout: 5000 });
    return JSON.parse(await pre.textContent());
}

async function configureOrchestratorRouting(page) {
    await enableOrchestratorMode(page, 'director', { closeAfter: false });
    await setOrchestratorDefaultApiProfile(page, ROUTE_PROFILE, { closeAfter: false });
    await expect.poll(() => readSettings().extension_settings?.orchestrator?.executionMode, { timeout: 15_000 }).toBe('director');
    const lens = await openOrchWorkspace(page, 'settings');
    const section = lens.locator('.ol-setup-section', { has: page.locator('.lw-sec-title', { hasText: 'Default API and prompt preset' }) });
    const presetSelect = section.locator('label.ol-form-row', { has: page.locator('span', { hasText: /^Generation preset$/ }) }).locator('select');
    await expect(presetSelect.locator(`option[value="${ROUTE_PRESET}"]`)).toHaveCount(1, { timeout: 10_000 });
    await presetSelect.selectOption(ROUTE_PRESET);
    // The names the user can pick for an agent's prompt preset.
    const presetChoices = await presetSelect.locator('option').evaluateAll(
        (options) => options.map((option) => option.value).filter(Boolean),
    );

    await expect.poll(() => {
        const orch = readSettings().extension_settings?.orchestrator || {};
        return `${orch.llmNodeApiPresetName}|${orch.llmNodePresetName}|${orch.executionMode}`;
    }, { timeout: 15_000 }).toBe(`${ROUTE_PROFILE}|${ROUTE_PRESET}|director`);
    await closeWorkbench(page);
    return { presetChoices };
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '100-orch-preset-routing-tool',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, name: ROUTE_PROFILE });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writePreset({ dataRoot: server.dataRoot, name: ROUTE_PRESET });
    normalizeIterStudioSettings(server.dataRoot);

    mock.scriptCompletion(({ body, toolNames, userMessages }) => {
        if (!toolNames.includes(TOOL)) return null;
        const lastUser = String(userMessages[userMessages.length - 1] || '');
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const lastUserIndex = messages.map((m) => m?.role).lastIndexOf('user');
        const toolAnswered = messages.slice(lastUserIndex + 1).some((m) => m?.role === 'tool');
        if (lastUser.includes(FIRST_PROMPT)) {
            return toolAnswered ? { text: FIRST_REPLY } : { tool: TOOL, arguments: {} };
        }
        if (lastUser.includes(SECOND_PROMPT)) return { text: SECOND_REPLY };
        return null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#100 — Orchestrator iter-studio: preset routing read tool', () => {
    test.setTimeout(180_000);

    test('the tool chip shows the server\'s profiles and presets and the model receives the same data', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const { presetChoices } = await configureOrchestratorRouting(page);
        await openIterStudio(page, 'orch');

        await sendIterPrompt(page, 'orch', FIRST_PROMPT);
        const popup = page.locator('.wbench .wb-win');
        await expect(popup).toContainText(FIRST_REPLY, { timeout: 60_000 });
        await expect.poll(() => routingRequests().length, { timeout: 30_000 }).toBe(2);

        // The tool is offered with an argument-free schema.
        const offered = routingRequests()[0].body.tools.find((t) => t?.function?.name === TOOL);
        expect(offered.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });

        // What the user sees in the chip.
        const chip = routingChip(page);
        const shown = await readChipResult(page);
        await expect(chip.locator('.wb-tool-name')).toHaveText(TOOL);
        await expect(chip.locator('.is-error')).toHaveCount(0);
        expect(shown.api.global_orchestration_api_preset).toBe(ROUTE_PROFILE);
        expect(shown.api.available_connection_profiles.map((p) => p.name).sort()).toEqual(chatCompletionProfileNamesOnDisk());
        expect(shown.api.available_connection_profiles.map((p) => p.name)).toEqual(expect.arrayContaining([ROUTE_PROFILE, 'e2e-mock']));
        expect(shown.prompt.global_orchestration_prompt_preset).toBe(ROUTE_PRESET);
        // Every preset file on disk, plus the in-memory presets the
        // orchestrator registers (director-pure): the same list the agent
        // prompt preset dropdown offers.
        expect(shown.prompt.available_local_global_chat_completion_presets).toEqual(expect.arrayContaining(chatCompletionPresetNamesOnDisk()));
        expect([...shown.prompt.available_local_global_chat_completion_presets].sort()).toEqual([...presetChoices].sort());
        expect(shown.prompt.available_local_global_chat_completion_presets).toContain(ROUTE_PRESET);
        expect(shown.prompt.available_card_bound_chat_completion_presets).toEqual([]);
        const presetCount = shown.prompt.available_local_global_chat_completion_presets.length
            + shown.prompt.available_card_bound_chat_completion_presets.length;
        expect(shown.api.available_connection_profiles).toHaveLength(chatCompletionProfileNamesOnDisk().length);
        expect(presetCount).toBe(presetChoices.length);
        await expect(chip.locator('pre:last-child')).toHaveText(JSON.stringify(shown, null, 2));

        // What the model receives in round 2.
        const [roundTwoTool] = toolMessages(routingRequests()[1]);
        expect(roundTwoTool?.tool_call_id).toBeTruthy();
        expect(parseToolContent(roundTwoTool)).toEqual(shown);

        // The session (with the tool result) is persisted before the restart.
        await expect.poll(() => {
            const raw = JSON.stringify(readGlobalWorkbenchBodies(server.dataRoot, session => session.ws === 'orch'));
            return raw.includes(FIRST_REPLY) && raw.includes(TOOL);
        }, { timeout: 30_000 }).toBe(true);

        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await openIterStudio(page, 'orch');

        const reopened = page.locator('.wbench .wb-win');
        const pastSession = reopened.locator('.wb-sess-item', { hasText: 'Before the tide-watch' });
        await pastSession.waitFor({ state: 'visible', timeout: 10_000 });
        await pastSession.click();

        await expect(reopened).toContainText(FIRST_REPLY, { timeout: 15_000 });
        expect(await readChipResult(page)).toEqual(shown);

        await sendIterPrompt(page, 'orch', SECOND_PROMPT);
        await expect(reopened).toContainText(SECOND_REPLY, { timeout: 60_000 });
        await expect.poll(() => routingRequests().length, { timeout: 30_000 }).toBe(3);
        const replayed = toolMessages(routingRequests()[2]).find((m) => m.tool_call_id === roundTwoTool.tool_call_id);
        expect(replayed).toBeTruthy();
        expect(parseToolContent(replayed)).toEqual(shown);

        await closeIterStudio(page);
    });
});
