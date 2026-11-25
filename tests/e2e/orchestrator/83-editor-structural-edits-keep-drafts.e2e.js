// #83 — Structural edits in Orchestra Lens keep unsaved drafts.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    editOrchAgentField,
    enableOrchestratorMode,
    readOrchAgentField,
    saveOrchDrafts,
} from '../_lib/ui-orchestrator.js';
import { closeWorkbench, openOrchWorkspace, setOrchEnabled } from '../_lib/ui-workbench.js';

let server;

const SPEC_PROMPT = 'You keep the harbour lookout log, one line per bell.';
const SPEC_NEW_PRESET = 'harbour_clerk';
const AGENDA_PROMPT = 'Plan the night watch rota before the tide turns.';
const AGENDA_NEW_AGENT = 'tide_reader';
const DIRECTOR_PROMPT = 'Direct the lighthouse crew through the storm, one order at a time.';

function readSettings() {
    return JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
}

function readActiveEntry(mode) {
    const orch = readSettings()?.extension_settings?.orchestrator;
    const activeId = orch?.activePresetIds?.[mode] || '';
    return activeId ? (orch?.presetLibraries?.[mode]?.[activeId] || null) : null;
}

async function promptDialogOk(lens, text) {
    const dialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('input.ol-input').first().fill(text);
    await dialog.locator('.ol-dialog-foot button.is-primary').first().click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'orchestrator',
        scenarioId: '83-editor-structural-edits-keep-drafts',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.describe('#83 — structural edits in Orchestra Lens keep unsaved drafts', () => {
    test.setTimeout(120_000);

    test('flow agent selection follows the current state across repeated clicks', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'agenda', { closeAfter: false });
        const lens = await openOrchWorkspace(page, 'flow');
        await page.locator('.wbench .wb-ctl-max').click();
        await expect(lens).not.toHaveClass(/\bis-compact\b/);
        const card = lens.locator('button.ol-card[data-agent="agenda_planner"]');
        await expect(card).toHaveAttribute('aria-pressed', 'false');
        for (const selected of [true, false, true, false]) {
            await card.click();
            await expect(card).toHaveAttribute('aria-pressed', String(selected));
        }
    });

    test('an active field edit survives an orchestration enable-state refresh', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'agenda', { closeAfter: false });
        const lens = await openOrchWorkspace(page, 'flow');
        await page.locator('.wbench .wb-ctl-max').click();
        await expect(lens).not.toHaveClass(/\bis-compact\b/);
        await lens.locator('button.ol-card[data-agent="agenda_planner"]').click();
        const field = lens.locator('aside.ol-inspector section.ol-field').filter({
            has: page.locator('.ol-section-title', { hasText: /Role prompt|角色提示/i }),
        });
        await field.getByRole('button', { name: /^(Edit field|编辑字段|編輯欄位)$/ }).click();
        const textarea = field.locator('textarea.ol-field-input');
        await textarea.fill(AGENDA_PROMPT);
        await setOrchEnabled(page, false);
        await expect(textarea).toHaveValue(AGENDA_PROMPT);
        await setOrchEnabled(page, true);
        await expect(textarea).toHaveValue(AGENDA_PROMPT);
        await field.getByRole('button', { name: /^(Done|完成)$/ }).click();
        await expect.poll(() => readOrchAgentField(page, 'agenda_planner')).toBe(AGENDA_PROMPT);
        await saveOrchDrafts(page);
        await expect.poll(() => readActiveEntry('agenda')?.planner?.systemPrompt || '').toBe(AGENDA_PROMPT);
    });

    test('a selected agent reopens after folding the compact workbench', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'agenda', { closeAfter: false });
        const lens = await openOrchWorkspace(page, 'flow');
        await expect(lens).toHaveClass(/\bis-compact\b/);
        const card = lens.locator('button.ol-card[data-agent="agenda_planner"]');
        const inspector = lens.locator('aside.ol-inspector');
        await card.click();
        await expect(inspector).toBeVisible();
        await closeWorkbench(page);
        await openOrchWorkspace(page, 'flow');
        await expect(card).toHaveAttribute('aria-pressed', 'true');
        await expect(inspector).toBeHidden();
        await card.click();
        await expect(inspector).toBeVisible();
        await expect(card).toHaveAttribute('aria-pressed', 'true');
    });

    test('spec: add preset, node and stage keep an unsaved preset prompt edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'spec', { closeAfter: false });
        await expect.poll(() => readSettings()?.extension_settings?.orchestrator?.executionMode || '', { timeout: 10_000 }).toBe('spec');

        const lens = await openOrchWorkspace(page, 'setup');
        const firstPresetDetails = lens.locator('details.ol-setup-node[data-detail-key^="spec-preset:"]').first();
        await expect(firstPresetDetails).toBeVisible({ timeout: 10_000 });
        const detailKey = String(await firstPresetDetails.getAttribute('data-detail-key'));
        const editedPresetId = detailKey.replace(/^spec-preset:/, '');
        if (!(await firstPresetDetails.evaluate(el => el.open))) {
            await firstPresetDetails.locator('summary').first().click();
        }

        const promptArea = () => lens.locator(`details.ol-setup-node[data-detail-key="spec-preset:${editedPresetId}"] textarea.ol-textarea`).first();
        const stages = () => lens.locator('.ol-setup-stage');
        const firstStageNodes = () => lens.locator('.ol-setup-stage').first().locator('details.ol-setup-node[data-detail-key^="spec-node:0:"]');

        const initialStageCount = await stages().count();
        const initialNodeCount = await firstStageNodes().count();
        await promptArea().fill(SPEC_PROMPT);
        await promptArea().press('Tab');

        await lens.locator('button', { hasText: /Add agent preset|添加 Agent 预设|新增 Agent 預設/i }).first().click();
        await promptDialogOk(lens, SPEC_NEW_PRESET);
        await expect(lens.locator(`details.ol-setup-node[data-detail-key="spec-preset:${SPEC_NEW_PRESET}"]`)).toHaveCount(1);
        await expect(promptArea()).toHaveValue(SPEC_PROMPT);

        await lens.locator('.ol-setup-stage').first().locator('button', { hasText: /Add node|添加节点|新增節點/i }).first().click();
        await expect(firstStageNodes()).toHaveCount(initialNodeCount + 1);
        await expect(lens.locator(`details.ol-setup-node[data-detail-key="spec-preset:${SPEC_NEW_PRESET}"]`)).toHaveCount(1);
        await expect(promptArea()).toHaveValue(SPEC_PROMPT);

        await lens.locator('button', { hasText: /Add stage|添加阶段|新增階段/i }).first().click();
        await expect(stages()).toHaveCount(initialStageCount + 1);
        await expect(firstStageNodes()).toHaveCount(initialNodeCount + 1);
        await expect(promptArea()).toHaveValue(SPEC_PROMPT);

        await saveOrchDrafts(page);
        await expect.poll(() => readActiveEntry('spec')?.presets?.[editedPresetId]?.systemPrompt || '', { timeout: 15_000 }).toBe(SPEC_PROMPT);
        const saved = readActiveEntry('spec');
        expect(Object.keys(saved.presets)).toContain(SPEC_NEW_PRESET);
        expect(saved.spec.stages).toHaveLength(initialStageCount + 1);
        expect(saved.spec.stages[0].nodes).toHaveLength(initialNodeCount + 1);
    });

    test('agenda: adding an agent keeps an unsaved planner prompt edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'agenda', { closeAfter: false });
        await expect.poll(() => readSettings()?.extension_settings?.orchestrator?.executionMode || '', { timeout: 10_000 }).toBe('agenda');

        await editOrchAgentField(page, 'agenda_planner', AGENDA_PROMPT);
        const lens = await openOrchWorkspace(page, 'setup');
        await lens.locator('button', { hasText: /Add agent|添加 Agent|新增 Agent/i }).first().click();
        await promptDialogOk(lens, AGENDA_NEW_AGENT);

        await expect(lens.locator(`details.ol-setup-node[data-detail-key="agent:${AGENDA_NEW_AGENT}"]`)).toHaveCount(1);
        await expect.poll(() => readOrchAgentField(page, 'agenda_planner')).toBe(AGENDA_PROMPT);

        await saveOrchDrafts(page);
        await expect.poll(() => readActiveEntry('agenda')?.planner?.systemPrompt || '', { timeout: 15_000 }).toBe(AGENDA_PROMPT);
        expect(Object.keys(readActiveEntry('agenda').agents)).toContain(AGENDA_NEW_AGENT);
    });

    test('director: resetting the main agent tools override keeps an unsaved main prompt edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await enableOrchestratorMode(page, 'director', { closeAfter: false });
        await expect.poll(() => readSettings()?.extension_settings?.orchestrator?.executionMode || '', { timeout: 10_000 }).toBe('director');

        await editOrchAgentField(page, 'main', DIRECTOR_PROMPT);
        const lens = await openOrchWorkspace(page, 'setup');
        const mainDetails = lens.locator('details.ol-setup-node[data-detail-key="agent:main"]').first();
        await expect(mainDetails).toBeVisible({ timeout: 10_000 });
        if (!(await mainDetails.evaluate(el => el.open))) {
            await mainDetails.locator('summary').first().click();
        }
        const overrideSwitch = mainDetails.locator('.ol-setup-override [role="switch"]').first();
        await expect(overrideSwitch).toBeVisible({ timeout: 10_000 });
        if ((await overrideSwitch.getAttribute('aria-checked')) !== 'true') {
            await overrideSwitch.click();
        }
        await expect(overrideSwitch).toHaveAttribute('aria-checked', 'true');
        await overrideSwitch.click();
        await expect(overrideSwitch).toHaveAttribute('aria-checked', 'false');

        await expect.poll(() => readOrchAgentField(page, 'main')).toBe(DIRECTOR_PROMPT);

        await saveOrchDrafts(page);
        await expect.poll(() => readActiveEntry('director')?.mainAgent?.systemPrompt || '', { timeout: 15_000 }).toBe(DIRECTOR_PROMPT);
        expect(readActiveEntry('director').mainAgent.tools ?? null).toBeNull();
    });
});
