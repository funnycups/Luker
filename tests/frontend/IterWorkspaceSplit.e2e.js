// tests/frontend/IterWorkspaceSplit.e2e.js
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as frontendTest, expect } from '../harness/frontend.js';
import { startServer } from '../harness/server.js';
import { startMockLLM } from '../e2e/_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded } from '../e2e/_lib/fixtures.js';
import {
    awaitMainUI as awaitApplicationUI,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
} from '../e2e/_lib/page.js';
import { closeWorkbench } from '../e2e/_lib/ui-workbench.js';

let application, mock, profileName;
const test = frontendTest.extend({
    frontendApplication: [async ({ workerResources }, use) => {
        mock = await startMockLLM({});
        try {
            const scope = await workerResources.scenario(fileURLToPath(import.meta.url));
            application = await startServer({ scope, batchKey: 'frontend', scenarioId: 'iter-workspace-split' });
            markOnboarded({ dataRoot: application.dataRoot });
            bootstrapCustomBackend({ dataRoot: application.dataRoot, baseURL: mock.baseURL });
            profileName = appendConnectionProfile({ dataRoot: application.dataRoot, baseURL: mock.baseURL }).name;
            await use(application);
        } finally {
            await mock.stop();
        }
    }, { scope: 'worker' }],
});

async function awaitMainUI(page) {
    await awaitApplicationUI(page, application.baseURL);
}

async function ensureExtensionsDrawerOpen(page) {
    await openExtensionsDrawer(page);
}

async function ensureInlineDrawerOpen(page, hostId) {
    await openInlineDrawer(page, hostId);
}

async function closeWorkbenchIfOpen(page) {
    await closeWorkbench(page);
}

async function ensureAnyCharacterSelected(page) {
    await selectCharacterByName(page, 'Seraphina');
}

async function openWorkbenchIterate(page, targetDotClass) {
    const pill = page.locator('.wbench > button.wb-pill').first();
    const win = page.locator('.wbench .wb-win').first();
    if (!(await win.isVisible())) {
        await expect(pill).toBeVisible({ timeout: 15_000 });
        await pill.click();
        await expect(win).toBeVisible({ timeout: 15_000 });
    }

    const aiTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /AI iteration|AI 迭代/i }).first();
    await expect(aiTab).toBeVisible({ timeout: 10_000 });
    await aiTab.click();

    const TARGET_RX = {
        preset: /^(Preset|预设|預設)$/i,
        'wb-t-preset': /^(Preset|预设|預設)$/i,
        memory: /^(Memory graph config|记忆图配置|記憶圖設定)$/i,
        'wb-t-memory': /^(Memory graph config|记忆图配置|記憶圖設定)$/i,
        orch: /^(Orchestration|编排|編排)$/i,
        'wb-t-orch': /^(Orchestration|编排|編排)$/i,
        card: /^(Character card|角色卡)$/i,
        'wb-t-card': /^(Character card|角色卡)$/i,
    };
    if (targetDotClass) {
        const targetBtn = win.locator('.wb-ws-seg button.lw-seg-btn').filter({
            hasText: TARGET_RX[targetDotClass],
        }).first();
        await expect(targetBtn).toBeVisible({ timeout: 10_000 });
        await targetBtn.click();
        await expect(targetBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
    }
    return win;
}

async function ensureConnectionProfileConfiguredInSettings(page) {
    const win = await openWorkbenchIterate(page);
    const settingsTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /^Settings$|^设置$/i }).first();
    await expect(settingsTab).toBeVisible({ timeout: 10_000 });
    await settingsTab.click();

    const apiSelect = win.locator('.wb-ai-shared select').first();
    await expect(apiSelect).toBeVisible({ timeout: 10_000 });
    const optCount = await apiSelect.locator('option').count();
    expect(optCount, 'managed frontend fixture must expose its connection profile').toBeGreaterThan(1);
    await apiSelect.selectOption(profileName);
}

test.describe('Unified Workbench split workspace — CPA (preset target)', () => {
    test.setTimeout(90000);

    test('CPA: bridge button opens Workbench preset workspace with split layout + composer + suggestions', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const win = page.locator('.wbench .wb-win').first();
        await expect(win).toBeVisible({ timeout: 10000 });

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('aside.wb-sess')).toBeVisible();
        await expect(win.locator('section.wb-chat')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Preset|预设|預設)$/i })).toBeVisible();
        await expect(win.locator('.wb-scope-seg')).toBeVisible();
        await expect(win.locator('.wb-iter-preview')).toBeVisible();
        await expect(win.locator('.wb-iter-preview').getByText('Generation parameters', { exact: true })).toBeVisible();
        await expect(win.getByRole('checkbox', { name: 'Apply automatically', exact: true })).toBeVisible();

        const chatText = await win.locator('.wb-chat-body').textContent();
        expect(chatText || '').toMatch(/Preset|预设|Edit|修改|No edit target|Open a preset/i);

        await closeWorkbenchIfOpen(page);
    });

    test('CPA: the automatic apply preference survives a reload', async ({ page }) => {
        await awaitMainUI(page);
        const win = await openWorkbenchIterate(page, 'wb-t-preset');
        const automatic = win.getByRole('checkbox', { name: 'Apply automatically', exact: true });
        await expect(automatic).toBeVisible();
        const initial = (await automatic.getAttribute('aria-checked')) === 'true';
        const settingsPath = resolve(application.dataRoot, 'default-user', 'settings.json');
        const readReview = () => JSON.parse(readFileSync(settingsPath, 'utf8')).extension_settings.workbench?.reviewChanges;

        await automatic.click();
        await expect(automatic).toHaveAttribute('aria-checked', String(!initial));
        await expect.poll(readReview).toBe(initial);
        await page.reload();
        await awaitMainUI(page);
        await openWorkbenchIterate(page, 'wb-t-preset');
        await expect(automatic).toHaveAttribute('aria-checked', String(!initial));

        await automatic.click();
        await expect(automatic).toHaveAttribute('aria-checked', String(initial));
        await expect.poll(readReview).toBe(!initial);
        await closeWorkbenchIfOpen(page);
    });

    test('CPA: a preset turn receives the configured endpoint reply', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-preset');
        const reply = 'Preset workspace endpoint reply.';
        mock.scriptReply(reply);
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Set temperature to 0.85');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-msg-ai').last()).toContainText(reply, { timeout: 60000 });
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0);
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — MG Schema (memory target)', () => {
    test.setTimeout(90000);

    test('MG Schema: Workbench memory target mounts split layout + scope selector + composer', async ({ page }) => {
        await awaitMainUI(page);
        const win = await openWorkbenchIterate(page, 'wb-t-memory');

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('aside.wb-sess')).toBeVisible();
        await expect(win.locator('section.wb-chat')).toBeVisible();
        await expect(win.locator('.wb-scope-seg')).toBeVisible();

        const chatText = await win.locator('.wb-chat-body').textContent();
        expect(chatText || '').toMatch(/Memory graph|记忆图|記憶圖/i);

        await closeWorkbenchIfOpen(page);
    });

    test('MG Schema: a memory turn receives the configured endpoint reply', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-memory');
        const reply = 'Memory workspace endpoint reply.';
        mock.scriptReply(reply);
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Add a new column called "mood" of type string to the character category');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-msg-ai').last()).toContainText(reply, { timeout: 60000 });
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0);
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — Orchestrator (orch target)', () => {
    test.setTimeout(90000);

    test('Orch: Orchestra Lens AI button opens Workbench orch target with split layout', async ({ page }) => {
        await awaitMainUI(page);
        const win = await openWorkbenchIterate(page);

        const orchTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /Orchestration|编排/i }).first();
        await expect(orchTab).toBeVisible({ timeout: 10000 });
        await orchTab.click();

        const lens = win.locator('.olens.ol-lens').first();
        await expect(lens).toBeVisible({ timeout: 10000 });
        const setupBtn = lens.locator('.ol-viewswitch .lw-seg-btn').filter({ hasText: /^(Setup|准备阶段|準備階段|配置)$/i }).first();
        await setupBtn.click();

        const openAiBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /Open AI Iteration Studio|打开 AI 迭代/i }).first();
        await expect(openAiBtn).toBeVisible({ timeout: 10000 });
        await openAiBtn.click();

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Orchestration|编排|編排)$/i })).toBeVisible({ timeout: 10000 });

        await closeWorkbenchIfOpen(page);
    });

    test('Orch: an orchestration turn receives the configured endpoint reply', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-orch');
        const reply = 'Orchestration workspace endpoint reply.';
        mock.scriptReply(reply);
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Add a new stage named "review" to the pipeline');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-msg-ai').last()).toContainText(reply, { timeout: 60000 });
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0);
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — CEA Card (card target)', () => {
    test.setTimeout(90000);

    test('CEA Card: bridge button opens Workbench card target and handles character state', async ({ page }) => {
        await awaitMainUI(page);
        await ensureAnyCharacterSelected(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'character_editor_assistant_settings');

        const openBtn = page.locator('#cea_open_editor_popup');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const win = page.locator('.wbench .wb-win').first();
        await expect(win).toBeVisible({ timeout: 10000 });
        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Character card|角色卡)$/i })).toBeVisible({ timeout: 10000 });
        await expect(win.locator('.wb-composer textarea.wb-input')).toBeVisible();
        await expect(win.locator('.wb-composer button.wb-send')).toBeVisible();

        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench — mobile compact layout', () => {
    test('compact preview switches without hiding its return control and keeps touch targets', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await awaitMainUI(page);
        await ensureAnyCharacterSelected(page);
        const win = await openWorkbenchIterate(page, 'wb-t-card');
        const preview = win.getByRole('button', { name: 'Preview', exact: true });
        const sessions = win.locator('.wb-chat-head button.wb-src-toggle');
        const send = win.locator('.wb-composer button.wb-send');
        await expect(win.locator('.wb-chat-body')).toContainText('Seraphina');
        for (const control of [preview, sessions, send]) {
            await expect(control).toBeVisible();
            await expect.poll(async () => {
                const box = await control.boundingBox();
                return Boolean(box && box.width >= 44 && box.height >= 44);
            }).toBe(true);
        }
        await expect(win.locator('.wb-iter-preview')).toBeHidden();
        await preview.click();
        await expect(win.locator('.wb-iter-preview')).toBeVisible();
        await expect(win.locator('.wb-card-preview')).toContainText('Seraphina');
        await expect(win.locator('.wb-chat-body')).toBeHidden();
        await expect(win.locator('.wb-composer')).toBeHidden();
        await expect(preview).toBeVisible();
        await expect(preview).toHaveAttribute('aria-pressed', 'true');
        await preview.click();
        await expect(win.locator('.wb-iter-preview')).toBeHidden();
        await expect(win.locator('.wb-chat-body')).toBeVisible();
        await expect(win.locator('.wb-composer')).toBeVisible();
        await closeWorkbenchIfOpen(page);
    });

    test('at 360px viewport: .is-compact applies, session drawer toggles over split chat', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await awaitMainUI(page);

        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const root = page.locator('.wbench').first();
        await expect(root).toHaveClass(/\bis-compact\b/, { timeout: 10000 });

        const win = root.locator('.wb-win').first();
        await expect(win).toBeVisible();

        // Session list drawer is collapsed on mobile by default; toggle button opens it.
        const sessDrawer = win.locator('aside.wb-sess');
        await expect(sessDrawer).toBeHidden();

        const sessToggle = win.locator('.wb-chat-head button.wb-src-toggle').first();
        await expect(sessToggle).toBeVisible();
        await sessToggle.click();
        await expect(sessDrawer).toHaveClass(/\bis-open\b/);
        await expect(sessDrawer).toBeVisible();

        // Close session drawer overlay and verify main chat body + composer stay usable.
        await sessDrawer.locator('.wb-sess-head button[aria-label="Off"], .wb-sess-head button[title="Off"], .wb-sess-head button').last().click();
        await expect(sessDrawer).toBeHidden();
        await expect(win.locator('.wb-chat-body')).toBeVisible();

        await closeWorkbenchIfOpen(page);
    });
});
