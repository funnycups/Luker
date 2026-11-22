// Real-UI helpers for the unified Workbench (.wbench) shell, embedded Memory
// Lens (.mlens), embedded Orchestra Lens (.olens.ol-lens), and the shared
// floating Run Dock (.rpdock.rp-dock).
//
// Every helper drives genuine DOM events (clicks, fills, selectOption, keys) —
// never calling Luker.* internals or mutating extensionSettings directly.

import { expect } from '@playwright/test';
import { closeAnyOpenTopSettingsDrawer } from './page.js';

const TAB_LABELS = {
    home: /^(Overview|总览|總覽)$/i,
    overview: /^(Overview|总览|總覽)$/i,
    ask: /^(Q&A|问问|問問)$/i,
    ai: /^(AI iteration|AI 迭代)$/i,
    iterate: /^(AI iteration|AI 迭代)$/i,
    hist: /^(Change history|改动记录|改動記錄)$/i,
    history: /^(Change history|改动记录|改動記錄)$/i,
    settings: /^(Settings|设置|設定)$/i,
    'ws:memory': /^(Memory graph|记忆图|記憶圖)$/i,
    memory: /^(Memory graph|记忆图|記憶圖)$/i,
    'ws:orch': /^(Orchestration|编排|編排)$/i,
    orch: /^(Orchestration|编排|編排)$/i,
    'ws:sd': /^(Image Generation|图像生成|圖像生成)$/i,
    sd: /^(Image Generation|图像生成|圖像生成)$/i,
};

const TARGET_ALIASES = {
    preset: 'preset',
    cpa: 'preset',
    card: 'card',
    cea: 'card',
    character: 'card',
    world: 'world',
    worldbook: 'world',
    wi: 'world',
    memory: 'memory',
    mg: 'memory',
    'mg-schema': 'memory',
    memory_graph: 'memory_graph',
    'mg-graph': 'memory_graph',
    graph: 'memory_graph',
    orch: 'orch',
    orchestrator: 'orch',
    orchestration: 'orch',
    sd: 'sd',
};

const TARGET_LABELS = {
    memory: /^(Memory graph|记忆图|記憶圖)$/i,
    memory_graph: /^(Graph|图谱|圖譜)$/i,
    orch: /^(Orchestration|编排|編排)$/i,
    preset: /^(Preset|预设|預設)$/i,
    card: /^(Character card|角色卡)$/i,
    world: /^(World book|世界书|世界書)$/i,
    sd: /^(Image Generation|图像生成|圖像生成)$/i,
};

const SCOPE_PATTERNS = {
    global: /^(Global|全局)$/i,
    character: /^(Current character|当前角色|目前角色|No character card selected|未选择角色卡|未選擇角色卡)/i,
    preset: /^(Current preset|当前预设|目前預設|No preset selected|未选择预设|未選擇預設)/i,
    chat: /^(Current chat|当前聊天|目前聊天|No chat open|没有打开聊天|沒有打開聊天)/i,
};

const MG_VIEW_MATCHERS = {
    graph: /^(Graph|图谱|圖譜)$/i,
    timeline: /^(Timeline|时间线|時間線)$/i,
    table: /^(Data table|数据表|資料表)$/i,
    schema: /^(Memory structure|记忆结构|記憶結構)$/i,
    settings: /^(Settings|设置|設定)$/i,
};

const ORCH_VIEW_MATCHERS = {
    flow: /^(Flow|流程)$/i,
    run: /^(Run|运行|執行)$/i,
    history: /^(History|历史|歷史)$/i,
    stats: /^(Stats|统计|統計)$/i,
    setup: /^(Setup|准备阶段|準備階段|配置)$/i,
    settings: /^(Settings|设置|設定)$/i,
    notes: /^(Notes|笔记|筆記)$/i,
};

const ORCH_MODE_MATCHERS = {
    spec: /^(Pipeline|流水线|流水線)$/i,
    single: /^(Single assistant|单助手|單助手)$/i,
    agenda: /^(Dispatch|调度|調度)$/i,
    loop: /^(Research loop|循环|循環|循环研究|循環研究)$/i,
    director: /^(Director team|导演|導演|导演团队|導演團隊)$/i,
};

export function normalizeWorkbenchTarget(variant) {
    const key = String(variant || '').trim();
    const mapped = TARGET_ALIASES[key];
    if (!mapped) throw new Error(`Unknown Workbench target / variant: ${variant}`);
    return mapped;
}

export function workbenchLayer(page) {
    return page.locator('.wbench').first();
}

export function workbenchWindow(page) {
    return page.locator('.wbench .wb-win').first();
}

/**
 * Set a native `<input type="checkbox">` or ARIA switch/checkbox (`aria-checked`)
 * to `desired` via a real click only when needed.
 */
export async function setToggleState(locator, desired) {
    const target = locator.first();
    await expect(target).toBeVisible({ timeout: 10_000 });
    const want = Boolean(desired);
    const isNative = await target.evaluate((el) => el.tagName === 'INPUT' && el.type === 'checkbox');
    if (isNative) {
        const cur = await target.isChecked();
        if (cur !== want) await target.click();
        await expect.poll(() => target.isChecked(), { timeout: 5_000 }).toBe(want);
        return;
    }
    const cur = (await target.getAttribute('aria-checked')) === 'true';
    if (cur !== want) await target.click();
    await expect(target).toHaveAttribute('aria-checked', String(want), { timeout: 5_000 });
}

/**
 * Click an item inside Luker's `#extensionsMenu` wand menu, opening `#extensionsMenuButton` first if needed.
 */
export async function clickWandMenuItem(page, itemSelector) {
    await closeAnyOpenTopSettingsDrawer(page).catch(() => {});
    const item = page.locator(itemSelector).first();
    if (!(await item.isVisible().catch(() => false))) {
        const wandBtn = page.locator('#extensionsMenuButton').first();
        await expect(wandBtn).toBeVisible({ timeout: 10_000 });
        await wandBtn.click();
    }
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
}

/**
 * Open the unified Workbench window via the resident pill, wand menu item,
 * Alt+W shortcut, or CPA/CEA extension buttons.
 */
export async function openWorkbench(page, { via = 'pill', timeoutMs = 15_000 } = {}) {
    const win = workbenchWindow(page);
    if (await win.isVisible().catch(() => false)) {
        return win;
    }

    if (via === 'wand') {
        await clickWandMenuItem(page, '#luker_workbench_wand_item');
    } else if (via === 'hotkey' || via === 'shortcut') {
        await page.keyboard.press('Alt+w');
    } else if (via === 'cpa-button') {
        const btn = page.locator('#completion_preset_assistant_open').first();
        await btn.scrollIntoViewIfNeeded();
        await expect(btn).toBeVisible({ timeout: timeoutMs });
        await btn.click();
    } else if (via === 'cea-button') {
        const btn = page.locator('#cea_open_editor_popup').first();
        await btn.scrollIntoViewIfNeeded();
        await expect(btn).toBeVisible({ timeout: timeoutMs });
        await btn.click();
    } else {
        const pill = page.locator('.wbench > button.wb-pill').first();
        if (via === 'pill' || await pill.isVisible().catch(() => false)) {
            await pill.waitFor({ state: 'visible', timeout: timeoutMs });
            await pill.click();
        } else {
            await clickWandMenuItem(page, '#luker_workbench_wand_item');
        }
    }

    await win.waitFor({ state: 'visible', timeout: timeoutMs });
    return win;
}

/**
 * Fold the Workbench window back to its corner pill.
 */
export async function closeWorkbench(page, { via = 'button', timeoutMs = 10_000 } = {}) {
    const win = workbenchWindow(page);
    if (!(await win.isVisible().catch(() => false))) return;
    if (via === 'shortcut' || via === 'hotkey') {
        await page.keyboard.press('Alt+w');
    } else {
        await win.locator('.wb-titlebar .is-close').first().click();
    }
    await win.waitFor({ state: 'hidden', timeout: timeoutMs });
}

/**
 * Click a left-rail tab inside Workbench (`home`, `ask`, `ai`, `hist`,
 * `settings`, `ws:memory`/`memory`, `ws:orch`/`orch`).
 */
export async function switchWorkbenchTab(page, tabId, { timeoutMs = 15_000 } = {}) {
    const win = await openWorkbench(page, { timeoutMs });
    const key = String(tabId || '').trim().toLowerCase();
    const pattern = TAB_LABELS[key] || TAB_LABELS[tabId];
    if (!pattern) throw new Error(`unknown workbench tab: ${tabId}`);
    const tab = win.locator('.wb-rail .wb-tab').filter({
        has: page.locator('.wb-tab-label', { hasText: pattern }),
    }).first();
    await tab.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await tab.getAttribute('aria-selected')) !== 'true') {
        await tab.click();
    }
    await page.waitForFunction(
        ({ source, flags }) => {
            const tabs = Array.from(document.querySelectorAll('.wbench .wb-rail .wb-tab'));
            const re = new RegExp(source, flags);
            return tabs.some((el) => {
                const label = (el.querySelector('.wb-tab-label')?.textContent || el.textContent || '').trim();
                return re.test(label) && el.getAttribute('aria-selected') === 'true';
            });
        },
        { source: pattern.source, flags: pattern.flags },
        { timeout: timeoutMs },
    );
    if (key === 'ws:memory' || key === 'memory') {
        await win.locator('.mlens').first().waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (key === 'ws:orch' || key === 'orch') {
        await win.locator('.olens').first().waitFor({ state: 'visible', timeout: timeoutMs });
    }
    return win;
}

export async function selectWorkbenchTab(page, tabId, opts = {}) {
    return switchWorkbenchTab(page, tabId, opts);
}

/**
 * Select an AI iteration target (`memory`, `memory_graph`, `orch`, `preset`,
 * `card`, `world` or legacy aliases) in `.wb-ws-seg`.
 */
export async function selectIterateTarget(page, targetId, { timeoutMs = 15_000 } = {}) {
    const normalized = normalizeWorkbenchTarget(targetId);
    const pattern = TARGET_LABELS[normalized];
    if (!pattern) throw new Error(`unknown iterate target: ${targetId}`);
    const win = workbenchWindow(page);
    const seg = win.locator('.wb-ws-seg .lw-seg-btn').filter({ hasText: pattern }).first();
    await seg.waitFor({ state: 'visible', timeout: timeoutMs });
    if ((await seg.getAttribute('aria-pressed')) !== 'true') {
        await seg.click();
    }
    await page.waitForFunction(
        ({ source, flags }) => {
            const re = new RegExp(source, flags);
            const btns = Array.from(document.querySelectorAll('.wbench .wb-ws-seg .lw-seg-btn'));
            return btns.some((el) => re.test((el.textContent || '').trim()) && el.getAttribute('aria-pressed') === 'true');
        },
        { source: pattern.source, flags: pattern.flags },
        { timeout: timeoutMs },
    );
    return seg;
}

export const selectIterationTarget = selectIterateTarget;

/**
 * Select a scope (`global`, `character`, `preset`, `chat`) in `.wb-scope-seg`.
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
        ({ source, flags }) => {
            const re = new RegExp(source, flags);
            const btns = Array.from(document.querySelectorAll('.wbench .wb-scope-seg .lw-seg-btn'));
            return btns.some((el) => re.test((el.textContent || '').trim()) && el.getAttribute('aria-pressed') === 'true');
        },
        { source: pattern.source, flags: pattern.flags },
        { timeout: timeoutMs },
    );
    return seg;
}

export const selectIterationScope = selectIterateScope;

/**
 * Click "New conversation" in the AI iteration sidebar (opening compact drawer if needed).
 */
export async function startNewIterationSession(page, { timeoutMs = 10_000 } = {}) {
    const win = workbenchWindow(page);
    const newBtn = win.locator('aside.wb-sess button').filter({ hasText: /New conversation|新对话|新對話/i }).first();
    if (!(await newBtn.isVisible().catch(() => false))) {
        const toggle = win.locator('.wb-src-toggle').first();
        if (await toggle.isVisible().catch(() => false)) {
            await toggle.click();
        }
    }
    await expect(newBtn).toBeVisible({ timeout: timeoutMs });
    await newBtn.click();
}

/**
 * Open Workbench directly to AI iteration for a given target (and optional scope,
 * preset mode/reference, composer toggles, or new session).
 */
export async function openWorkbenchIterate(page, targetName, {
    scope = null,
    mode,
    referencePreset,
    newSession = false,
    includeLatestReply,
    autoApply,
    via = 'pill',
    timeoutMs = 20_000,
} = {}) {
    const target = normalizeWorkbenchTarget(targetName);
    const win = await openWorkbench(page, { via, timeoutMs });
    if (via !== 'cpa-button' && via !== 'cea-button') {
        await switchWorkbenchTab(page, 'ai', { timeoutMs });
    } else {
        await switchWorkbenchTab(page, 'ai', { timeoutMs });
    }
    await selectIterateTarget(page, target, { timeoutMs });
    if (scope) {
        await selectIterateScope(page, scope, { timeoutMs });
    }

    if (target === 'preset') {
        if (mode !== undefined) {
            const modeSel = win.locator('select[data-wb-preset-control="mode"], select.wb-preset-mode-select').first();
            await expect(modeSel).toBeVisible({ timeout: 10_000 });
            await modeSel.selectOption(String(mode));
        }
        if (referencePreset !== undefined) {
            const refSel = win.locator('select[data-wb-preset-control="reference"], select.wb-preset-ref-select').first();
            await expect(refSel).toBeVisible({ timeout: 10_000 });
            if (!referencePreset) {
                await refSel.selectOption('');
            } else {
                await refSel.selectOption({ label: String(referencePreset) });
            }
        }
    }

    if (includeLatestReply !== undefined) {
        const box = win.locator('.wb-composer-opts button[role="checkbox"].lw-check').filter({
            hasText: /Include the latest reply|带上最近一条回复|帶上最近一條回覆/i,
        }).first();
        await setToggleState(box, includeLatestReply);
    }

    if (autoApply !== undefined) {
        const box = win.locator('.wb-composer-opts button[role="checkbox"].lw-check').filter({
            hasText: /Apply automatically|自动应用|自動套用/i,
        }).first();
        await setToggleState(box, autoApply);
    }

    if (newSession) {
        await startNewIterationSession(page, { timeoutMs: 10_000 });
    }

    const input = win.locator('.wb-chat .wb-input').first();
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
    return win;
}

export const openWorkbenchIteration = openWorkbenchIterate;

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
 * Send an AI Iteration prompt and wait for the live turn indicator to clear
 * (returning locators for change cards and assistant messages, whether or not
 * pending changes were produced).
 */
export async function sendWorkbenchIterationPrompt(page, prompt, opts = {}) {
    const timeout = opts.timeout ?? 45_000;
    const waitForSettle = opts.waitForSettle !== false;
    const win = workbenchWindow(page);
    await expect(win).toBeVisible({ timeout: 10_000 });

    const msgLocator = win.locator('.wb-msg-ai');
    const prevAiCount = await msgLocator.count();
    const prevChgCount = await win.locator('.wb-chg').count();

    const input = win.locator('.wb-composer textarea.wb-input, .wb-chat .wb-input').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(String(prompt ?? ''));

    const sendBtn = win.locator('.wb-composer button.wb-send, .wb-chat .wb-send').first();
    await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
    await sendBtn.click();

    if (waitForSettle) {
        await expect.poll(async () => {
            const liveCount = await win.locator('.wb-reads.is-live').count();
            const aiCount = await msgLocator.count();
            const chgCount = await win.locator('.wb-chg').count();
            const stopVisible = await win.locator('.wb-msg-ai:has(.wb-reads.is-live) button').isVisible().catch(() => false);
            if (liveCount > 0 || stopVisible) return false;
            return aiCount > prevAiCount || chgCount > prevChgCount;
        }, { timeout, intervals: [100, 250, 500] }).toBe(true);
    }

    return {
        changeCards: win.locator('.wb-chg'),
        assistantMessages: msgLocator,
    };
}

/**
 * Click Stop while an AI Iteration turn is running.
 */
export async function stopWorkbenchIteration(page) {
    const win = workbenchWindow(page);
    const stopBtn = win.locator('.wb-msg-ai:has(.wb-reads.is-live) button').first();
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });
    await stopBtn.click();
    await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Apply selected changes on a pending `.wb-chg` card (supports `index` and `uncheckIndices`).
 * Returns once the pending card transitions out of `is-pending`, or once a host
 * confirmation dialog (`dialog.popup[open]`, e.g. unembedded-preset preflight) opens.
 */
export async function applyWorkbenchChanges(page, opts = {}) {
    const timeout = opts.timeout ?? opts.timeoutMs ?? 30_000;
    const win = workbenchWindow(page);
    const cards = win.locator('.wb-chg.is-pending');
    await expect(cards.first()).toBeVisible({ timeout });

    const pendingBefore = await cards.count();
    const popupsBefore = await page.locator('dialog.popup[open]').count();
    const card = typeof opts.index === 'number' ? cards.nth(opts.index) : cards.last();
    if (Array.isArray(opts.uncheckIndices)) {
        const boxes = card.locator('.wb-chg-line button[role="checkbox"]');
        for (const idx of opts.uncheckIndices) {
            await setToggleState(boxes.nth(idx), false);
        }
    }

    const applyBtn = card.locator('.wb-chg-foot button.is-primary').first();
    await expect(applyBtn).toBeVisible({ timeout: 10_000 });
    await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
    await applyBtn.click();

    await expect.poll(async () => {
        if ((await page.locator('dialog.popup[open]').count()) > popupsBefore) return true;
        return (await cards.count()) < pendingBefore;
    }, { timeout, intervals: [100, 250] }).toBe(true);
}

/**
 * Click `Apply selected (N)` on the latest pending change-list card.
 */
export async function applyIterateChanges(page, { timeoutMs = 30_000 } = {}) {
    await applyWorkbenchChanges(page, { timeout: timeoutMs });
}

/**
 * Discard all changes on the latest (or indexed) pending `.wb-chg` card.
 */
export async function discardWorkbenchChanges(page, opts = {}) {
    const timeout = opts.timeout ?? opts.timeoutMs ?? 15_000;
    const win = workbenchWindow(page);
    const cards = win.locator('.wb-chg.is-pending');
    await expect(cards.first()).toBeVisible({ timeout });

    const pendingBefore = await cards.count();
    const card = typeof opts.index === 'number' ? cards.nth(opts.index) : cards.last();
    const discardBtn = card.locator('.wb-chg-foot button').filter({
        hasText: /^(Discard everything|全部放弃|全部放棄)$/i,
    }).first();
    await expect(discardBtn).toBeVisible({ timeout: 10_000 });
    await discardBtn.click();

    await expect.poll(async () => (await cards.count()) < pendingBefore, { timeout, intervals: [100, 250] }).toBe(true);
}

export async function discardIterateChanges(page, { timeoutMs = 10_000 } = {}) {
    await discardWorkbenchChanges(page, { timeout: timeoutMs });
}

/**
 * Click `Undo` on an applied/partial `.wb-chg` card inside AI iteration.
 */
export async function undoWorkbenchChangeCard(page, opts = {}) {
    const timeout = opts.timeout ?? opts.timeoutMs ?? 20_000;
    const win = workbenchWindow(page);
    const cards = win.locator('.wb-chg:is(.is-applied, .is-partial)');
    await expect(cards.first()).toBeVisible({ timeout });

    const appliedBefore = await cards.count();
    const card = typeof opts.index === 'number' ? cards.nth(opts.index) : cards.last();
    const undoBtn = card.locator('.wb-chg-foot button').filter({ hasText: /^(Undo|撤销|撤銷)$/i }).first();
    await expect(undoBtn).toBeVisible({ timeout: 10_000 });
    await undoBtn.click();

    await expect.poll(async () => (await cards.count()) < appliedBefore, { timeout, intervals: [100, 250] }).toBe(true);
}

export async function undoIterateChanges(page, { timeoutMs = 15_000 } = {}) {
    await undoWorkbenchChangeCard(page, { timeout: timeoutMs });
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
    const undoBtn = item.locator('button').filter({ hasText: /^(Undo|撤销|撤銷)$/i }).first();
    await undoBtn.waitFor({ state: 'visible', timeout: timeoutMs });
    await undoBtn.click();
    await page.waitForFunction(
        (prev) => document.querySelectorAll('.wbench .wb-hist-item.is-undone').length > prev,
        beforeUndone,
        { timeout: timeoutMs },
    );
}

/**
 * Open the embedded Memory Lens workspace inside Workbench and optionally select a topbar view.
 */
export async function openMemoryWorkspace(page, view) {
    const win = await switchWorkbenchTab(page, 'memory');
    const lens = win.locator('.mlens').first();
    await expect(lens).toBeVisible({ timeout: 15_000 });

    const resolvedView = typeof view === 'object' ? (view?.subview || view?.view || '') : view;
    if (resolvedView) {
        const matcher = MG_VIEW_MATCHERS[resolvedView];
        if (!matcher) throw new Error(`Unknown Memory Lens view: ${resolvedView}`);
        const btn = lens.locator('.ml-viewswitch .lw-seg-btn').filter({ hasText: matcher }).first();
        await expect(btn).toBeVisible({ timeout: 10_000 });
        if ((await btn.getAttribute('aria-pressed')) !== 'true') {
            await btn.click();
        }
    }
    return lens;
}

/**
 * Open the embedded Orchestra Lens workspace inside Workbench and optionally select a topbar view.
 */
export async function openOrchWorkspace(page, view) {
    const win = await switchWorkbenchTab(page, 'orch');
    const lens = win.locator('.olens.ol-lens, .olens').first();
    await expect(lens).toBeVisible({ timeout: 15_000 });

    const resolvedView = typeof view === 'object' ? (view?.subview || view?.view || '') : view;
    if (resolvedView) {
        const matcher = ORCH_VIEW_MATCHERS[resolvedView];
        if (!matcher) throw new Error(`Unknown Orchestra Lens view: ${resolvedView}`);
        const btn = lens.locator('.ol-viewswitch .lw-seg-btn').filter({ hasText: matcher }).first();
        await expect(btn).toBeVisible({ timeout: 10_000 });
        if ((await btn.getAttribute('aria-pressed')) !== 'true') {
            await btn.click();
        }
    }
    return lens;
}

/**
 * Toggle the topbar Orchestrator enable switch inside Orchestra Lens.
 */
export async function setOrchEnabled(page, desired) {
    const lens = await openOrchWorkspace(page);
    const sw = lens.locator('.ol-enable button[role="switch"]:visible').first();
    await setToggleState(sw, desired);
    return sw;
}

/**
 * Switch the Orchestrator execution mode inside Orchestra Lens topbar (`.ol-modebtn` -> `[role="menuitemradio"]`).
 */
export async function setOrchMode(page, mode) {
    const matcher = ORCH_MODE_MATCHERS[mode];
    if (!matcher) throw new Error(`Unknown Orchestrator mode: ${mode}`);
    const lens = await openOrchWorkspace(page);
    const modeBtn = lens.locator('.ol-modebtn:visible').first();
    await expect(modeBtn).toBeVisible({ timeout: 10_000 });
    await modeBtn.click();

    const menuItem = lens.locator('.ol-menu:visible [role="menuitemradio"]').filter({
        has: page.locator('.ol-menu-title', { hasText: matcher }),
    }).first();
    await expect(menuItem).toBeVisible({ timeout: 10_000 });
    await menuItem.click();
}

/**
 * Select an orchestration preset in Orchestra Lens Setup view (`.ol-setup-bar select.ol-select`).
 */
export async function selectOrchPreset(page, nameOrId, opts = {}) {
    const lens = await openOrchWorkspace(page, 'setup');
    const select = lens.locator('.ol-setup-bar select.ol-select').first();
    await expect(select).toBeVisible({ timeout: 10_000 });

    const optionValue = await select.evaluate((sel, arg) => {
        const options = Array.from(sel.options);
        const match = options.find((o) => {
            const sep = o.value.indexOf(':');
            const optScope = sep >= 0 ? o.value.slice(0, sep) : 'global';
            const optId = sep >= 0 ? o.value.slice(sep + 1) : o.value;
            if (arg.scope && optScope !== arg.scope) return false;
            return o.value === arg.target
                || optId === arg.target
                || o.textContent.trim() === arg.target
                || o.textContent.includes(arg.target);
        });
        return match ? match.value : null;
    }, { target: nameOrId, scope: opts.scope || null });

    if (!optionValue) {
        throw new Error(`Orchestrator preset option not found: ${nameOrId}`);
    }
    await select.selectOption(optionValue);
}

/**
 * Save any pending draft inside Orchestra Lens Setup/Flow view via `.ol-savebar`.
 */
export async function saveOrchDraftIfVisible(page) {
    const lens = page.locator('.wbench .olens').first();
    if (await lens.evaluate((el) => el.classList.contains('is-compact') && el.classList.contains('sheet-open')).catch(() => false)) {
        await lens.locator('.ol-scrim').first().click({ position: { x: 8, y: 8 } });
        await expect.poll(
            () => lens.evaluate((el) => el.classList.contains('sheet-open')),
            { timeout: 5_000 },
        ).toBe(false);
    }
    const saveBar = lens.locator('.ol-savebar').first();
    if (await saveBar.isVisible().catch(() => false)) {
        const saveBtn = saveBar.locator('button').filter({ hasText: /^(Save|保存|儲存)$/i }).first();
        if (await saveBtn.isVisible().catch(() => false)) {
            await saveBtn.click();
            await expect(saveBar).toBeHidden({ timeout: 10_000 });
        }
    }
}

/**
 * Locate the shared floating Run Dock (`.rpdock.rp-dock`). Optionally open it
 * via its pill (`.rpdock.rp-dock-pill`) or wand menu item (`#orchestra_lens_dock_item`).
 */
export async function getRunDock(page, opts = {}) {
    const dock = page.locator('.rpdock.rp-dock').first();
    if (opts.openIfCollapsed && !(await dock.isVisible().catch(() => false))) {
        const pill = page.locator('.rpdock.rp-dock-pill .rp-dock-pill-main, .rpdock.rp-dock-pill').first();
        if (await pill.isVisible().catch(() => false)) {
            await pill.click();
        } else {
            await clickWandMenuItem(page, '#orchestra_lens_dock_item');
        }
    }
    return dock;
}

/**
 * Wait for the topmost open Simulation Review dialog (`dialog.popup[open]` hosting `.luker-sim-review`),
 * returning a locator pinned to that specific dialog's `data-id` so closing it never races with a
 * subsequent Simulation Review popup opening immediately afterward.
 */
export async function waitForSimulationReview(page, { titlePattern = null, timeoutMs = 60_000 } = {}) {
    const candidate = page.locator('dialog.popup[open]:not([closing]):has(.luker-sim-review)').last();
    await expect(candidate).toBeVisible({ timeout: timeoutMs });
    if (titlePattern) {
        await expect(candidate.locator('.luker-sim-review-title')).toHaveText(titlePattern, { timeout: timeoutMs });
    }
    const dialogId = await candidate.getAttribute('data-id');
    return dialogId
        ? page.locator(`dialog.popup[data-id="${dialogId}"]`).first()
        : candidate;
}

/**
 * Enable Annotation mode in Simulation Review, drag-select a visible text snippet
 * via real mouse events (using read-only DOM geometry lookup), and fill the inline comment.
 */
export async function annotateSimulationReviewText(page, dialog, snippet, comment = '') {
    const toggle = dialog.locator('.sim-review-annot-toggle').first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    if ((await toggle.getAttribute('data-state')) !== 'on') {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute('data-state', 'on');

    const host = dialog.locator('.luker-sim-review').first();
    const target = host.locator('pre.luker-sim-pre').filter({ hasText: snippet }).first();
    await expect(target).toBeVisible({ timeout: 10_000 });
    await target.scrollIntoViewIfNeeded();

    const coords = await target.evaluate((el, text) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const idx = node.nodeValue.indexOf(text);
            if (idx < 0) continue;
            const startRange = document.createRange();
            startRange.setStart(node, idx);
            startRange.setEnd(node, Math.min(idx + 1, node.nodeValue.length));
            const endRange = document.createRange();
            endRange.setStart(node, Math.max(idx, idx + text.length - 1));
            endRange.setEnd(node, idx + text.length);
            const startRect = startRange.getClientRects()[0] || startRange.getBoundingClientRect();
            const endRect = endRange.getClientRects()[endRange.getClientRects().length - 1] || endRange.getBoundingClientRect();
            return {
                startX: startRect.left + 1,
                startY: startRect.top + startRect.height / 2,
                endX: endRect.right - 1,
                endY: endRect.top + endRect.height / 2,
            };
        }
        return null;
    }, snippet);

    if (!coords) {
        throw new Error(`Simulation review text snippet not found: ${snippet}`);
    }

    const prevMarks = await host.locator('mark.luker-sim-annotation').count();
    await page.mouse.move(coords.startX, coords.startY);
    await page.mouse.down();
    await page.mouse.move(coords.endX, coords.endY, { steps: 6 });
    await page.mouse.up();

    const marks = host.locator('mark.luker-sim-annotation');
    await expect(marks).toHaveCount(prevMarks + 1, { timeout: 10_000 });
    const latestMark = marks.last();
    if (comment) {
        const commentInput = latestMark.locator('input.sim-review-annot-comment');
        await expect(commentInput).toBeVisible({ timeout: 5_000 });
        await commentInput.fill(comment);
    }
    return latestMark;
}

/**
 * Click Re-run simulation in Simulation Review and wait for the review DOM to re-mount.
 */
export async function rerunSimulationReview(dialog, { timeoutMs = 90_000 } = {}) {
    const prevBtn = dialog.locator('.luker-sim-rerun-btn').first();
    await expect(prevBtn).toBeVisible({ timeout: 10_000 });
    await expect(prevBtn).toBeEnabled({ timeout: 10_000 });
    const prevHandle = await dialog.locator('.luker-sim-review').first().elementHandle();
    await prevBtn.click();
    await expect.poll(async () => {
        const isDetached = await prevHandle.evaluate(el => !el.isConnected).catch(() => true);
        if (!isDetached) return false;
        const nextBtn = dialog.locator('.luker-sim-rerun-btn').first();
        return (await nextBtn.isVisible().catch(() => false)) && (await nextBtn.isEnabled().catch(() => false));
    }, { timeout: timeoutMs, intervals: [150, 300, 500] }).toBe(true);
    await prevHandle.dispose();
}

/**
 * Click Submit in Simulation Review and wait for the popup to close.
 */
export async function submitSimulationReview(dialog, { timeoutMs = 30_000 } = {}) {
    const okBtn = dialog.locator('.popup-button-ok').first();
    await expect(okBtn).toBeVisible({ timeout: 10_000 });
    await okBtn.click();
    await expect(dialog).toBeHidden({ timeout: timeoutMs });
}

/**
 * Click Cancel in Simulation Review and wait for the popup to close.
 */
export async function cancelSimulationReview(dialog, { timeoutMs = 30_000 } = {}) {
    const cancelBtn = dialog.locator('.popup-button-cancel').first();
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await expect(dialog).toBeHidden({ timeout: timeoutMs });
}
