// Real-UI helpers for the unified Workbench (.wbench) shell and its tabs:
// Overview, Q&A (Ask), AI iteration, Change history, Settings, and embedded
// workspaces (Memory graph, Orchestration).
//
// Every helper drives genuine DOM events (clicks, fills, selectOption, keys) —
// never calling Luker.* internals or mutating extensionSettings directly.

import { closeAnyOpenTopSettingsDrawer } from './page.js';

const TAB_LABELS = {
    home: /^(Overview|总览|總覽)$/,
    ask: /^(Q&A|问问|問問)$/,
    ai: /^(AI iteration|AI 迭代)$/,
    hist: /^(Change history|改动记录|改動記錄)$/,
    settings: /^(Settings|设置|設定)$/,
    'ws:memory': /^(Memory graph|记忆图|記憶圖)$/,
    memory: /^(Memory graph|记忆图|記憶圖)$/,
    'ws:orch': /^(Orchestration|编排|編排)$/,
    orch: /^(Orchestration|编排|編排)$/,
};

const TARGET_LABELS = {
    memory: /^(Memory graph|记忆图|記憶圖)$/,
    memory_graph: /^(Graph|图谱|圖譜)$/,
    orch: /^(Orchestration|编排|編排)$/,
    preset: /^(Preset|预设|預設)$/,
    card: /^(Character card|角色卡)$/,
    world: /^(World book|世界书|世界書)$/,
};

const SCOPE_PATTERNS = {
    global: /^(Global|全局)$/,
    character: /^(Current character|当前角色|目前角色|No character card selected|未选择角色卡|未選擇角色卡)/,
    preset: /^(Current preset|当前预设|目前預設|No preset selected|未选择预设|未選擇預設)/,
    chat: /^(Current chat|当前聊天|目前聊天|No chat open|没有打开聊天|沒有打開聊天)/,
};

export function workbenchLayer(page) {
    return page.locator('.wbench').first();
}

export function workbenchWindow(page) {
    return page.locator('.wbench .wb-win').first();
}

/**
 * Open the unified Workbench window via the resident pill, the wand menu item,
 * or the Alt+W keyboard shortcut.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ via?: 'pill'|'wand'|'hotkey', timeoutMs?: number }} [opts]
 */
export async function openWorkbench(page, { via = 'pill', timeoutMs = 15_000 } = {}) {
    const win = workbenchWindow(page);
    if (await win.isVisible().catch(() => false)) {
        return win;
    }

    if (via === 'wand') {
        await closeAnyOpenTopSettingsDrawer(page).catch(() => {});
        const wandBtn = page.locator('#extensionsMenuButton').first();
        await wandBtn.waitFor({ state: 'visible', timeout: timeoutMs });
        await wandBtn.click();
        const item = page.locator('#luker_workbench_wand_item').first();
        await item.waitFor({ state: 'visible', timeout: timeoutMs });
        await item.click();
    } else if (via === 'hotkey') {
        await page.keyboard.press('Alt+w');
    } else {
        const pill = page.locator('.wbench .wb-pill').first();
        await pill.waitFor({ state: 'visible', timeout: timeoutMs });
        await pill.click();
    }

    await win.waitFor({ state: 'visible', timeout: timeoutMs });
    return win;
}

/**
 * Fold the Workbench window back to its corner pill.
 */
export async function closeWorkbench(page, { timeoutMs = 10_000 } = {}) {
    const win = workbenchWindow(page);
    if (!(await win.isVisible().catch(() => false))) return;
    await win.locator('.wb-titlebar .is-close').first().click();
    await win.waitFor({ state: 'hidden', timeout: timeoutMs });
}

/**
 * Click a left-rail tab inside Workbench (`home`, `ask`, `ai`, `hist`,
 * `settings`, `ws:memory`, `ws:orch`).
 */
export async function switchWorkbenchTab(page, tabId, { timeoutMs = 15_000 } = {}) {
    const win = await openWorkbench(page, { timeoutMs });
    const pattern = TAB_LABELS[tabId];
    if (!pattern) throw new Error(`unknown workbench tab: ${tabId}`);
    const tab = win.locator('.wb-rail .wb-tab').filter({
        has: page.locator('.wb-tab-label', { hasText: pattern }),
    }).first();
    await tab.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
        await tab.click();
    }
    await page.waitForFunction(
        (expected) => {
            const tabs = Array.from(document.querySelectorAll('.wbench .wb-rail .wb-tab'));
            const re = new RegExp(expected);
            return tabs.some((el) => {
                const label = (el.querySelector('.wb-tab-label')?.textContent || el.textContent || '').trim();
                return re.test(label) && el.getAttribute('aria-selected') === 'true';
            });
        },
        pattern.source,
        { timeout: timeoutMs },
    );
    if (tabId === 'ws:memory' || tabId === 'memory') {
        await win.locator('.mlens').first().waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (tabId === 'ws:orch' || tabId === 'orch') {
        await win.locator('.olens').first().waitFor({ state: 'visible', timeout: timeoutMs });
    }
}

/**
 * Select an AI iteration target (`memory`, `memory_graph`, `orch`, `preset`,
 * `card`, `world`) in the AI iteration header segmented control.
 */
export async function selectIterateTarget(page, targetId, { timeoutMs = 15_000 } = {}) {
    const pattern = TARGET_LABELS[targetId];
    if (!pattern) throw new Error(`unknown iterate target: ${targetId}`);
    const win = workbenchWindow(page);
    const seg = win.locator('.wb-ws-seg .lw-seg-btn').filter({ hasText: pattern }).first();
    await seg.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await seg.getAttribute('aria-pressed')) !== 'true') {
        await seg.click();
    }
    await page.waitForFunction(
        (source) => {
            const re = new RegExp(source);
            const btns = Array.from(document.querySelectorAll('.wbench .wb-ws-seg .lw-seg-btn'));
            return btns.some((el) => re.test((el.textContent || '').trim()) && el.getAttribute('aria-pressed') === 'true');
        },
        pattern.source,
        { timeout: timeoutMs },
    );
}

/**
 * Select a scope (`global`, `character`, `preset`, `chat`) in the AI iteration
 * header segmented control.
 */
export async function selectIterateScope(page, scope, { timeoutMs = 10_000 } = {}) {
    const pattern = SCOPE_PATTERNS[scope];
    if (!pattern) throw new Error(`unknown iterate scope: ${scope}`);
    const win = workbenchWindow(page);
    const seg = win.locator('.wb-scope-seg .lw-seg-btn').filter({ hasText: pattern }).first();
    await seg.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await seg.getAttribute('aria-pressed')) !== 'true') {
        await seg.click();
    }
    await page.waitForFunction(
        (source) => {
            const re = new RegExp(source);
            const btns = Array.from(document.querySelectorAll('.wbench .wb-scope-seg .lw-seg-btn'));
            return btns.some((el) => re.test((el.textContent || '').trim()) && el.getAttribute('aria-pressed') === 'true');
        },
        pattern.source,
        { timeout: timeoutMs },
    );
}

/**
 * Open Workbench directly to AI iteration for a given target (and optional scope).
 */
export async function openWorkbenchIterate(page, targetId, { scope = null, via = 'pill', timeoutMs = 20_000 } = {}) {
    await openWorkbench(page, { via, timeoutMs });
    await switchWorkbenchTab(page, 'ai', { timeoutMs });
    await selectIterateTarget(page, targetId, { timeoutMs });
    if (scope) {
        await selectIterateScope(page, scope, { timeoutMs });
    }
    const input = workbenchWindow(page).locator('.wb-chat .wb-input').first();
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Fill the AI iteration composer and click Send, waiting for the turn to
 * settle (and optionally for a pending `.wb-chg` card).
 */
export async function sendIteratePrompt(page, prompt, { waitFor = 'changes', timeoutMs = 60_000 } = {}) {
    const win = workbenchWindow(page);
    const input = win.locator('.wb-chat .wb-input').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(prompt);
    const sendBtn = win.locator('.wb-chat .wb-send').first();
    await sendBtn.click();

    await page.waitForFunction(
        () => {
            const btn = document.querySelector('.wbench .wb-chat .wb-send');
            const live = document.querySelector('.wbench .wb-reads.is-live');
            return Boolean(btn) && !btn.disabled && !live;
        },
        null,
        { timeout: timeoutMs },
    );

    if (waitFor === 'changes') {
        const applyBtn = win.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary').last();
        await applyBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    }
}

/**
 * Click `Apply selected (N)` on the latest pending change-list card.
 */
export async function applyIterateChanges(page, { timeoutMs = 30_000 } = {}) {
    const win = workbenchWindow(page);
    const pendingCard = win.locator('.wb-chg.is-pending').last();
    await pendingCard.waitFor({ state: 'visible', timeout: timeoutMs });
    await pendingCard.locator('.wb-chg-foot button.is-primary').first().click();
    await page.waitForFunction(
        () => !document.querySelector('.wbench .wb-chg.is-pending'),
        null,
        { timeout: timeoutMs },
    );
}

/**
 * Click `Discard everything` on the latest pending change-list card.
 */
export async function discardIterateChanges(page, { timeoutMs = 10_000 } = {}) {
    const win = workbenchWindow(page);
    const pendingCard = win.locator('.wb-chg.is-pending').last();
    await pendingCard.waitFor({ state: 'visible', timeout: timeoutMs });
    await pendingCard.locator('.wb-chg-foot button').filter({ hasText: /^(Discard everything|全部放弃|全部放棄)$/ }).first().click();
    await page.waitForFunction(
        () => !document.querySelector('.wbench .wb-chg.is-pending'),
        null,
        { timeout: timeoutMs },
    );
}

/**
 * Click `Undo` on the latest applied/partial change-list card inside AI iteration.
 */
export async function undoIterateChanges(page, { timeoutMs = 15_000 } = {}) {
    const win = workbenchWindow(page);
    const undoBtn = win.locator('.wb-chg:is(.is-applied, .is-partial) .wb-chg-foot button').filter({ hasText: /^(Undo|撤销|撤銷)$/ }).last();
    await undoBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await undoBtn.click();
    await page.waitForFunction(
        () => {
            const applied = document.querySelectorAll('.wbench .wb-chg:is(.is-applied, .is-partial)');
            return applied.length === 0;
        },
        null,
        { timeout: timeoutMs },
    );
}

/**
 * Switch to Q&A (Ask), send a question, and wait for the answer turn to settle.
 */
export async function sendAskPrompt(page, question, { timeoutMs = 60_000 } = {}) {
    await switchWorkbenchTab(page, 'ask', { timeoutMs });
    const win = workbenchWindow(page);
    const input = win.locator('.wb-chat .wb-input').first();
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(question);
    const sendBtn = win.locator('.wb-chat .wb-send').first();
    await sendBtn.click();
    await page.waitForFunction(
        () => {
            const btn = document.querySelector('.wbench .wb-chat .wb-send');
            const live = document.querySelector('.wbench .wb-reads.is-live');
            return Boolean(btn) && !btn.disabled && !live;
        },
        null,
        { timeout: timeoutMs },
    );
}

/**
 * Switch to Change history and optionally select a filter chip.
 */
export async function openChangeHistory(page, { filter = '', timeoutMs = 15_000 } = {}) {
    await switchWorkbenchTab(page, 'hist', { timeoutMs });
    const win = workbenchWindow(page);
    if (filter) {
        const chip = win.locator('.wb-filters .wb-chip').filter({ hasText: filter }).first();
        await chip.waitFor({ state: 'visible', timeout: timeoutMs });
        await chip.click();
    }
    return win;
}

/**
 * Click Undo on the topmost non-undone Change history entry.
 */
export async function undoLatestHistoryEntry(page, { timeoutMs = 15_000 } = {}) {
    const win = workbenchWindow(page);
    const beforeUndone = await win.locator('.wb-hist-item.is-undone').count();
    const item = win.locator('.wb-hist-item:not(.is-undone)').first();
    await item.waitFor({ state: 'visible', timeout: timeoutMs });
    const undoBtn = item.locator('button').filter({ hasText: /^(Undo|撤销|撤銷)$/ }).first();
    await undoBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await undoBtn.click();
    await page.waitForFunction(
        (prev) => document.querySelectorAll('.wbench .wb-hist-item.is-undone').length > prev,
        beforeUndone,
        { timeout: timeoutMs },
    );
}
