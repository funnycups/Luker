// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    closeExtensionsDrawer,
    closeTopDrawer,
    openExtensionsDrawer,
    openInlineDrawer,
    openTopDrawer,
} from '../_lib/page.js';
import {
    closeWorkbench,
    openMemoryWorkspace,
    openOrchWorkspace,
} from '../_lib/ui-workbench.js';

let server;
let mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['ok'] });
    server = await startServer({ batchKey: 'extensions', scenarioId: 'behavior-summary' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openSearchToolsDrawer(page) {
    const content = page.locator('#search_tools_settings > .inline-drawer-content').first();
    await content.waitFor({ state: 'attached', timeout: 5000 });
    const isHidden = await content.evaluate((el) => getComputedStyle(el).display === 'none');
    if (isHidden) {
        await page.locator('#search_tools_settings > .inline-drawer-toggle').first().click();
        await content.waitFor({ state: 'visible', timeout: 5000 });
    }
}

async function assertMobileRowStackingAndNoOverflow(page, cardSelector, containerSelector) {
    const metrics = await page.evaluate(({ cardSel, containerSel }) => {
        const cards = Array.from(document.querySelectorAll(cardSel)).filter((el) => el.offsetParent !== null);
        if (cards.length === 0) {
            return { cardCount: 0, rows: [], overflowTargets: [] };
        }
        const card = cards[0];
        const rows = Array.from(card.querySelectorAll('.luker-bsum-row')).map((row) => {
            const roleEl = row.querySelector('.luker-bsum-role');
            const textEl = row.querySelector('.luker-bsum-text');
            const roleRect = roleEl?.getBoundingClientRect();
            const textRect = textEl?.getBoundingClientRect();
            const cols = getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
            return {
                columnCount: cols.length,
                roleBottom: roleRect ? roleRect.bottom : 0,
                textTop: textRect ? textRect.top : 0,
                stacked: Boolean(roleRect && textRect && textRect.top >= roleRect.bottom - 1),
            };
        });

        const targets = [document.documentElement, card];
        const container = containerSel ? document.querySelector(containerSel) : null;
        if (container) targets.push(container);
        const overflowTargets = targets
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => ({
                tag: el.tagName,
                className: el.className,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
            }));

        return { cardCount: cards.length, rows, overflowTargets };
    }, { cardSel: cardSelector, containerSel: containerSelector });

    expect(metrics.cardCount).toBeGreaterThan(0);
    expect(metrics.rows.length).toBeGreaterThan(0);
    for (const row of metrics.rows) {
        expect(row.columnCount).toBe(1);
        expect(row.stacked).toBe(true);
    }
    expect(metrics.overflowTargets).toEqual([]);
}

test.describe('live behavior summary UI', () => {
    test.setTimeout(60_000);

    test('Workbench Lens: Memory Graph Section 1 summary, Custom modal focus, live visibility-gap warning, and hover highlight', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const lens = await openMemoryWorkspace(page, 'settings');
        const enabledSwitch = lens.locator('[data-field-key="enabled"][role="switch"]').first();
        const masterNotice = lens.locator('.luker-bsum[data-bsum-id="mg-master-notice"]');
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
        await expect(masterNotice).toHaveCount(1);
        await expect(masterNotice).toBeVisible();

        await enabledSwitch.click();
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
        await expect(masterNotice).toHaveCount(0);

        const rootHiddenDisplay = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.className = 'luker-bsum';
            probe.hidden = true;
            document.body.appendChild(probe);
            const display = getComputedStyle(probe).display;
            probe.remove();
            return display;
        });
        expect(rootHiddenDisplay).toBe('none');

        const section1 = lens.locator('[data-settings-section="extraction"]').first();
        await expect(section1).toBeVisible();

        const sectionCard = section1.locator('.luker-bsum[data-bsum-id="mg-extraction"]').first();
        await expect(sectionCard).toBeVisible();

        // Card is placed immediately below the Section 1 heading (top of section).
        const isFirstBodyChildAfterTitle = await section1.evaluate((el) => {
            const title = el.querySelector(':scope > .ml-settings-title, :scope > h3, :scope > .lw-sec-title');
            return Boolean(title && title.nextElementSibling?.matches('.luker-bsum[data-bsum-id="mg-extraction"]'));
        });
        expect(isFirstBodyChildAfterTitle).toBe(true);

        await expect(sectionCard.locator('.luker-bsum-row .luker-bsum-role')).toHaveText(['Memory update', 'Main model']);

        // Clicking floor-hiding token opens Custom Cadence & Floor Hiding modal with its input focused.
        const floorHidingToken = sectionCard.locator('button.luker-bsum-tok[data-bsum-fields="llmVisibleRecentMessages"]').first();
        await expect(floorHidingToken).toBeVisible();
        await floorHidingToken.click();

        const modal = lens.locator('.ml-custom-cadence-modal').first();
        await expect(modal).toBeVisible();

        const floorInput = modal.locator('[data-field-key="llmVisibleRecentMessages"] input').first();
        await expect(floorInput).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
            const active = document.activeElement;
            const wrap = active?.closest('[data-field-key]');
            return active?.tagName === 'INPUT' && wrap?.dataset?.fieldKey === 'llmVisibleRecentMessages';
        })).toBe(true);

        const modalCard = modal.locator('.luker-bsum[data-bsum-id="mg-custom-cadence-modal"]').first();
        await expect(modalCard).toBeVisible();
        await expect(modalCard.locator('.luker-bsum-warnings')).toBeHidden();

        // Fill 1 visible message (with default updateEvery=2 -> minRecommendedVisible=3): triggers amber visibility-gap warning live.
        await floorInput.fill('1');
        await expect(modalCard).toHaveClass(/\bis-warn\b/);
        const warnBox = modalCard.locator('.luker-bsum-warn.is-warn').first();
        await expect(warnBox).toBeVisible();
        await expect(warnBox).toContainText('Visibility gap');
        await expect(modalCard).toContainText('1 messages');

        // Fill 0 visible messages: clears visibility-gap warning and switches to full raw history.
        await floorInput.fill('0');
        await expect(modalCard.locator('.luker-bsum-warnings')).toBeHidden();
        await expect(modalCard).not.toHaveClass(/\bis-warn\b/);
        await expect(modalCard).toContainText('0 (all raw chat history)');

        // Hovering an input inside the modal activates matching token and row highlights live.
        const updateEveryInput = modal.locator('[data-field-key="updateEvery"] input').first();
        await updateEveryInput.hover();
        await expect(modalCard.locator('.luker-bsum-tok[data-bsum-fields~="updateEvery"].is-hot')).toHaveCount(1);
        await expect(modalCard.locator('.luker-bsum-row.is-row-hot')).toHaveCount(1);

        // Close modal without saving edits and verify hover link also works in Section 1 directly.
        await lens.locator('.ml-dialog-backdrop .ml-schema-modal-foot button').filter({ hasText: /^Cancel$/ }).first().click();
        await expect(modal).toBeHidden();

        await section1.locator('[data-field-key="autoExtractionEnabled"]').first().hover();
        await expect(sectionCard.locator('.luker-bsum-tok[data-bsum-fields="autoExtractionEnabled"].is-hot')).toHaveCount(1);
        await expect(sectionCard.locator('.luker-bsum-row.is-row-hot')).toHaveCount(1);

        await closeWorkbench(page);
    });

    test('Workbench Lens: Orchestrator Runtime Limits and Cross-mode Limits update live', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const lens = await openOrchWorkspace(page, 'settings');
        const runtimeCard = lens.locator('.luker-bsum[data-bsum-id="orch-runtime-limits"]').first();
        const crossModeCard = lens.locator('.luker-bsum[data-bsum-id="orch-cross-mode-limits"]').first();
        await expect(runtimeCard).toBeVisible();
        await expect(crossModeCard).toBeVisible();

        const nodeRoundsInput = lens.locator('[data-field-key="nodeIterationMaxRounds"] input').first();
        await nodeRoundsInput.fill('15');
        await expect(runtimeCard).toContainText('15 tool rounds');

        const rerunRoundsInput = lens.locator('[data-field-key="reviewRerunMaxRounds"] input').first();
        await rerunRoundsInput.fill('0');
        await expect(runtimeCard).toContainText('disabled (0)');

        const retryInput = lens.locator('[data-field-key="toolCallRetryMax"] input').first();
        await retryInput.fill('4');
        await expect(crossModeCard).toContainText('up to 4 times');

        const rpmInput = lens.locator('[data-field-key="rpmLimit"] input').first();
        await rpmInput.fill('60');
        await expect(crossModeCard).toContainText('60 RPM');

        await closeWorkbench(page);
    });

    test('Classic drawers and popup: Search Tools, Connection Profile Advanced, and Regex Editor', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 1. Search Tools classic drawer.
        await openExtensionsDrawer(page);
        await openSearchToolsDrawer(page);

        const stMainCard = page.locator('.luker-bsum[data-bsum-id="search-tools-main"]').first();
        const stLorebookCard = page.locator('.luker-bsum[data-bsum-id="search-tools-lorebook"]').first();
        await expect(stMainCard).toBeVisible();
        await expect(stLorebookCard).toBeVisible();
        await expect(stMainCard).toContainText('Tools not exposed');
        await expect(stMainCard).toContainText('Pre-request agent off');
        await expect(page.locator('#search_tools_tool_call_retry_max')).toHaveClass(/\bluker-bsum-field-dormant\b/);

        await page.locator('#search_tools_enabled').click();
        await expect(stMainCard).toContainText('Web search & visit tools exposed');
        await expect(stLorebookCard).toContainText('Existing stored entries stay injected');

        await page.locator('#search_tools_pre_request_enabled').click();
        await expect(stMainCard).toContainText('Runs automatically');
        await expect(stLorebookCard).toContainText('Writes and injects stored search entries');
        await expect(page.locator('#search_tools_tool_call_retry_max')).not.toHaveClass(/\bluker-bsum-field-dormant\b/);

        await closeExtensionsDrawer(page);

        // 2. Connection Profile Advanced drawer.
        await openTopDrawer(page, 'sys-settings-button');
        const chatProfilePanel = page.locator('#rm_api_block .connection_profile_tab_panel[data-mode="chat"]').first();
        const advDrawer = chatProfilePanel.locator('.inline-drawer').first();
        const advContent = advDrawer.locator('> .inline-drawer-content').first();
        const advHidden = await advContent.evaluate((el) => getComputedStyle(el).display === 'none');
        expect(advHidden).toBe(true);
        await advDrawer.locator('> .inline-drawer-toggle').first().click();
        await expect(advContent).toBeVisible();

        const connPlainTextCard = advContent.locator('.luker-bsum[data-bsum-id="conn-plain-text-fc"]').first();
        const connReliabilityCard = advContent.locator('.luker-bsum[data-bsum-id="conn-reliability"]').first();
        await expect(connPlainTextCard).toBeVisible();
        await expect(connReliabilityCard).toBeVisible();
        await expect(connPlainTextCard).toContainText('Plain-text function calling off');

        await page.locator('#connection_profile_function_calling_plain_text').click();
        await expect(connPlainTextCard).toContainText('Plain-text function calling on');

        const connRpmInput = page.locator('#connection_profile_rpm_limit');
        await connRpmInput.fill('30');
        await connRpmInput.press('Tab');
        await expect(connReliabilityCard).toContainText('Rate limit 30 req/min');

        await closeTopDrawer(page, 'sys-settings-button');

        // 3. Regex Editor popup.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'regex_container');
        await page.locator('#open_regex_editor').click();

        let popup = page.locator('.popup:visible').last();
        await expect(popup).toBeVisible();
        let regexCard = popup.locator('.luker-bsum[data-bsum-id="regex-editor"]');
        await expect(regexCard).toHaveCount(1);

        const wiWarning = regexCard.locator('.luker-bsum-warn.is-warn', {
            hasText: 'World Info only runs on prompt or plugin-request passes',
        });
        await expect(wiWarning).toHaveCount(0);

        await popup.locator('input[name="replace_position"][value="5"]').check();
        await expect(wiWarning).toHaveCount(1);
        await expect(wiWarning).toBeVisible();

        await popup.locator('input[name="only_format_prompt"]').check();
        await expect(wiWarning).toHaveCount(0);

        await popup.locator('.popup-button-cancel').first().click();
        await expect(popup).toBeHidden();

        // Reopen and confirm zero duplicate cards mount.
        await page.locator('#open_regex_editor').click();
        popup = page.locator('.popup:visible').last();
        await expect(popup).toBeVisible();
        regexCard = popup.locator('.luker-bsum[data-bsum-id="regex-editor"]');
        await expect(regexCard).toHaveCount(1);
        await popup.locator('.popup-button-cancel').first().click();
        await expect(popup).toBeHidden();

        await closeExtensionsDrawer(page);
    });

    test('Mobile viewport (375x812): rows stack vertically without horizontal overflow on Workbench Lens and classic drawer', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 });
        await awaitMainUI(page, server.baseURL);

        // Classic extension drawer panel at mobile width.
        await openExtensionsDrawer(page);
        await openSearchToolsDrawer(page);
        await expect(page.locator('.luker-bsum[data-bsum-id="search-tools-main"]').first()).toBeVisible();
        await assertMobileRowStackingAndNoOverflow(
            page,
            '#search_tools_settings .luker-bsum[data-bsum-id="search-tools-main"]',
            '#search_tools_settings .inline-drawer-content',
        );
        await closeExtensionsDrawer(page);

        // Workbench Lens panel at mobile width.
        const lens = await openMemoryWorkspace(page, 'settings');
        await expect(lens.locator('.luker-bsum[data-bsum-id="mg-extraction"]').first()).toBeVisible();
        await assertMobileRowStackingAndNoOverflow(
            page,
            '.wbench .luker-bsum[data-bsum-id="mg-extraction"]',
            '.wbench .ml-settings',
        );
        await closeWorkbench(page);
    });
});
