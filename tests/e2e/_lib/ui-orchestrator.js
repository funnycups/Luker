// Orchestrator Unified Workbench (Orchestra Lens) helpers — real user gestures only.

import { expect } from '@playwright/test';
import {
    closeOrchInspectorSheet,
    closeWorkbench,
    openOrchWorkspace,
    setOrchEnabled,
    setOrchMode,
} from './ui-workbench.js';

/**
 * Enable the orchestrator and pick its execution mode through Orchestra Lens,
 * then fold Workbench back to its pill so main chat controls remain unobstructed.
 */
export async function enableOrchestratorMode(page, mode, { closeAfter = true } = {}) {
    await setOrchMode(page, mode);
    await setOrchEnabled(page, true);
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Install a minimal director-mode orchestrator profile the way a user
 * brings in a shared profile: enable director mode, set tool-call retries
 * to 1, then import it through importOrchestratorPreset.
 */
export async function installMinimalDirectorProfile(page, {
    mainSystemPrompt = 'You are the test director. Use the available tools to drive the turn to completion.',
    subAgents = [],
    tools = null,
    modeSkills = { visible: [], deny: [] },
    agentSkills = { visible: [], deny: [] },
} = {}) {
    const name = 'e2e-minimal-director';
    const profile = {
        mode: 'director',
        skills: modeSkills,
        mainAgent: {
            promptPresetName: '',
            apiPresetName: '',
            systemPrompt: mainSystemPrompt,
            skills: agentSkills,
        },
        subAgents: (subAgents || []).map(a => ({
            id: String(a.id),
            description: String(a.description || ''),
            systemPrompt: String(a.systemPrompt || ''),
            promptPresetName: String(a.promptPresetName || ''),
            apiPresetName: String(a.apiPresetName || ''),
            tools: a.tools || null,
            maxRounds: a.maxRounds ?? null,
            skills: agentSkills,
        })),
        tools: tools || {
            collab: { dispatch_subagent: true, dispatch_inline_subagent: true },
        },
        maxRounds: 8,
        maxConcurrentSubagents: 4,
        maxTotalSubagentRuns: 8,
        discardOnAbort: false,
    };
    await enableOrchestratorMode(page, 'director', { closeAfter: false });
    await setOrchestratorToolCallRetries(page, 1, { closeAfter: false });
    await importOrchestratorPreset(page, { mode: 'director', name, profile, closeAfter: true });
}

const PORTABLE_PRESET_FORMATS = {
    director: 'luker_orchestrator_profile_v3',
    loop: 'luker_orchestrator_profile_v4',
    spec: 'luker_orchestrator_profile_v2',
    agenda: 'luker_orchestrator_profile_v1',
};

/**
 * Set "Tool-call retries on invalid/missing tool call" in Orchestra Lens Settings view.
 */
export async function setOrchestratorToolCallRetries(page, count, { closeAfter = true } = {}) {
    const lens = await openOrchWorkspace(page, 'settings');
    const retries = lens.locator('label.ol-form-row').filter({
        has: page.locator('span', { hasText: /Tool-call retries|工具调用重试|工具調用重試/i }),
    }).first().locator('input.ol-input').first();
    await expect(retries).toBeVisible({ timeout: 10_000 });
    await retries.fill(String(count));
    await retries.press('Tab');
    await expect(retries).toHaveValue(String(count));
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Import a portable orchestrator preset for `mode` through Orchestra Lens Setup view.
 */
export async function importOrchestratorPreset(page, { mode, name, profile, closeAfter = true } = {}) {
    const format = PORTABLE_PRESET_FORMATS[mode];
    if (!format) throw new Error(`importOrchestratorPreset: no portable format for mode ${mode}`);
    await setOrchMode(page, mode);
    const lens = await openOrchWorkspace(page, 'setup');
    const importButton = lens.locator('.ol-setup-bar button').filter({
        hasText: /^(Import|导入|導入)$/i,
    }).first();
    await expect(importButton).toBeVisible({ timeout: 10_000 });
    const chooserPromise = page.waitForEvent('filechooser');
    await importButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
        name: `${name}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format, mode, name, profile }, null, 4)),
    });
    const nameDialog = lens.locator('.ol-dialog-backdrop:not([hidden]) .ol-dialog').last();
    await expect(nameDialog).toBeVisible({ timeout: 10_000 });
    const nameInput = nameDialog.locator('input.ol-input').first();
    await nameInput.fill(name);
    await nameDialog.locator('.ol-dialog-foot button.is-primary').first().click();
    await nameDialog.waitFor({ state: 'hidden', timeout: 5000 });
    await expect(page.locator('#toast-container .toast-success, .wbench .wb-toast', { hasText: /Imported preset|已导入预设|已導入預設/i }).last()).toBeVisible({ timeout: 10_000 });
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Open the Skill Manager dialog from Orchestra Lens Setup view.
 */
export async function openOrchestratorSkillManager(page) {
    const lens = await openOrchWorkspace(page, 'setup');
    const manageBtn = lens.locator('.ol-setup-bar button').filter({
        hasText: /Manage skills|管理 Skills|管理技能/i,
    }).first();
    await expect(manageBtn).toBeVisible({ timeout: 10_000 });
    await manageBtn.click();
    const popup = page.locator('dialog.popup[open]', { has: page.locator('.luker_skill_manager') });
    await expect(popup).toBeVisible({ timeout: 15_000 });
    return popup;
}

/**
 * Select the default agent Connection profile in Orchestra Lens Settings view.
 */
export async function setOrchestratorDefaultApiProfile(page, profileName, { closeAfter = true } = {}) {
    const lens = await openOrchWorkspace(page, 'settings');
    const section = lens.locator('section.ol-setup-section').filter({
        has: page.locator('.lw-sec-title', { hasText: /Default API and prompt preset|默认 API|預設 API/i }),
    }).first();
    const apiSelect = section.locator('label.ol-form-row').filter({
        has: page.locator('span', { hasText: /Connection profile|连接配置|連線設定/i }),
    }).first().locator('select.ol-select').first();
    await expect(apiSelect).toBeVisible({ timeout: 10_000 });
    await expect(apiSelect.locator(`option[value="${profileName}"]`)).toHaveCount(1, { timeout: 10_000 });
    await apiSelect.selectOption(profileName);
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

async function selectAgentInFlow(page, agentId) {
    const lens = await openOrchWorkspace(page, 'flow');
    const card = lens.locator(`button.ol-card[data-agent="${agentId}"]`).first();
    const inspector = lens.locator('aside.ol-inspector');
    await expect(card).toBeVisible({ timeout: 10_000 });
    if ((await card.getAttribute('aria-pressed')) !== 'true' || !(await inspector.isVisible())) {
        await card.click();
    }
    await expect(inspector).toBeVisible({ timeout: 10_000 });
    return { lens, inspector };
}

/**
 * Read an agent field (default: Role prompt) from Orchestra Lens Flow inspector.
 */
export async function readOrchAgentField(page, agentId, fieldTitlePattern = /Role prompt|角色提示/i, { closeAfter = false } = {}) {
    const { inspector } = await selectAgentInFlow(page, agentId);
    const section = inspector.locator('section.ol-insp-section').filter({
        has: page.locator('.ol-section-title', { hasText: fieldTitlePattern }),
    }).first();
    await expect(section).toBeVisible({ timeout: 10_000 });
    const textarea = section.locator('textarea.ol-field-input');
    let value = '';
    if (await textarea.count() > 0) {
        await expect(textarea).toBeVisible({ timeout: 10_000 });
        value = await textarea.inputValue();
    } else {
        const promptEl = section.locator('.ol-prompt').first();
        await expect(promptEl).toBeVisible({ timeout: 10_000 });
        const cls = String(await promptEl.getAttribute('class') || '');
        value = cls.includes('is-empty') ? '' : String(await promptEl.textContent() || '');
    }
    if (closeAfter) {
        await closeWorkbench(page);
    }
    return value;
}

/**
 * Edit an agent field (default: Role prompt) in Orchestra Lens Flow inspector,
 * staging the change in Orchestra Lens drafts without saving to disk.
 */
export async function editOrchAgentField(page, agentId, nextValue, fieldTitlePattern = /Role prompt|角色提示/i, { closeAfter = false } = {}) {
    const { inspector } = await selectAgentInFlow(page, agentId);
    const section = inspector.locator('section.ol-field').filter({
        has: page.locator('.ol-section-title', { hasText: fieldTitlePattern }),
    }).first();
    await expect(section).toBeVisible({ timeout: 10_000 });
    const editBtn = section.locator('.ol-section-title .ol-insp-actions button').last();
    await editBtn.click();
    const textarea = section.locator('textarea.ol-field-input').first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill(String(nextValue));
    await expect(textarea).toHaveValue(String(nextValue));
    const done = section.locator('.ol-field-foot').getByRole('button', { name: /^(Done|完成)$/ });
    await expect(done).toBeVisible({ timeout: 10_000 });
    await done.click();
    await expect(textarea).toHaveCount(0);
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Click Save in the Orchestra Lens unsaved-edits savebar.
 */
export async function saveOrchDrafts(page, { closeAfter = false } = {}) {
    const lens = page.locator('.wbench .olens').first();
    await closeOrchInspectorSheet(lens);
    const saveBtn = lens.locator('.ol-savebar:not([hidden])').getByRole('button', { name: /^(Save|保存|儲存)$/ });
    await expect(saveBtn).toBeVisible({ timeout: 10_000 });
    await saveBtn.click();
    if (closeAfter) {
        await closeWorkbench(page);
    }
}

/**
 * Locate a Runtime limits numeric input in Orchestra Lens Settings view.
 */
export async function getOrchRuntimeLimitInput(page, labelPattern) {
    const lens = await openOrchWorkspace(page, 'settings');
    const section = lens.locator('section.ol-setup-section').filter({
        has: page.locator('.lw-sec-title', { hasText: /Runtime limits|运行上限|執行上限/i }),
    }).first();
    const input = section.locator('label.ol-form-row').filter({
        has: page.locator('span', { hasText: labelPattern }),
    }).first().locator('input.ol-input').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    return input;
}

/**
 * Open the Add Custom Tool popup from Orchestra Lens Setup view.
 */
export async function openOrchAddCustomToolPopup(page) {
    const lens = await openOrchWorkspace(page, 'setup');
    const section = lens.locator('section.ol-setup-section').filter({
        has: page.locator('.lw-sec-title', { hasText: /^(Custom tools|自定义工具|自訂工具)/i }),
    }).first();
    await expect(section).toBeVisible({ timeout: 10_000 });
    const addBtn = section.locator('.lw-sec-title .ol-insp-actions button').first();
    await addBtn.click();
    const popup = page.locator('.popup:visible:has(.luker_orch_ct_editor)');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    return popup;
}

/**
 * Click a preset-bar action button in Orchestra Lens Setup view.
 */
export async function clickOrchSetupBarButton(page, labelPattern, { closeAfter = false } = {}) {
    const lens = await openOrchWorkspace(page, 'setup');
    const btn = lens.locator('.ol-setup-bar button').filter({ hasText: labelPattern }).first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    if (closeAfter) {
        await closeWorkbench(page);
    }
}
