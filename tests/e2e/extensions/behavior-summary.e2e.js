// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
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

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: ['ok'] });
    server = await startServer({ scope, batchKey: 'extensions', scenarioId: 'behavior-summary' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
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

async function ensureSwitchState(switchLocator, expectedChecked) {
    const target = expectedChecked ? 'true' : 'false';
    if ((await switchLocator.getAttribute('aria-checked')) !== target) {
        await switchLocator.click();
    }
}

async function ensureCheckboxUnchecked(checkboxLocator) {
    if (await checkboxLocator.isChecked()) {
        await checkboxLocator.uncheck();
    }
}

async function ensureOrchestratorPipelineMode(lens) {
    const nodeRoundsInput = lens.locator('[data-field-key="nodeIterationMaxRounds"] input').first();
    if (!(await nodeRoundsInput.isVisible())) {
        await lens.locator('.ol-modebtn:visible').first().click();
        await lens.locator('.ol-menu-item[role="menuitemradio"]').filter({ hasText: 'Pipeline' }).first().click();
    }
    return nodeRoundsInput;
}

async function ensureEditableDarkLiteTheme(page) {
    const themeSelect = page.locator('#themes');
    await themeSelect.selectOption('Dark Lite');
    const customCssInput = page.locator('#customCSS');
    if (await customCssInput.isDisabled()) {
        await page.locator('#ui_preset_derive_button').click();
        await expect(customCssInput).toBeEnabled({ timeout: 5000 });
    }
    return customCssInput;
}

async function openProfileAgentDrawer(page) {
    const content = page.locator('#sd_illustration_profile_agent_drawer > .inline-drawer-content').first();
    await content.waitFor({ state: 'attached', timeout: 5000 });
    const isHidden = await content.evaluate((el) => getComputedStyle(el).display === 'none');
    if (isHidden) {
        await page.locator('#sd_illustration_profile_agent_drawer > .inline-drawer-toggle').first().click();
        await content.waitFor({ state: 'visible', timeout: 5000 });
    }
}

async function findLargeSiblingOverlapLayers(page) {
    const cdp = await page.context().newCDPSession(page);
    let latestLayers = [];
    const onLayerTreeChange = (ev) => {
        if (ev.layers) latestLayers = ev.layers;
    };
    try {
        cdp.on('LayerTree.layerTreeDidChange', onLayerTreeChange);
        await cdp.send('LayerTree.enable');
        const extBox = await page.locator('#rm_extensions_block').boundingBox();
        expect(extBox).not.toBeNull();
        await page.mouse.move(extBox.x + extBox.width / 2, extBox.y + extBox.height / 2);
        await page.mouse.wheel(0, 1200);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

        const overlapLayers = [];
        for (const layer of latestLayers) {
            if (!layer.drawsContent || !layer.backendNodeId || layer.height < 400) continue;
            const desc = await cdp.send('DOM.describeNode', { backendNodeId: layer.backendNodeId }).catch(() => null);
            const attrs = desc?.node?.attributes || [];
            const attrMap = {};
            for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
            const cls = attrMap.class || '';
            const tag = desc?.node?.localName || '';
            if (cls.includes('sd_illustration_row') || tag === 'hr') {
                overlapLayers.push({ tag, cls, width: layer.width, height: layer.height });
            }
        }
        return overlapLayers;
    } finally {
        cdp.off('LayerTree.layerTreeDidChange', onLayerTreeChange);
        await cdp.send('LayerTree.disable').catch(() => {});
        await cdp.detach().catch(() => {});
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
    test('Workbench Lens: Memory Graph Section 1 summary, Custom modal focus, live visibility-gap warning, and hover highlight', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const lens = await openMemoryWorkspace(page, 'settings');
        const enabledSwitch = lens.locator('[data-field-key="enabled"][role="switch"]').first();
        const masterNotice = lens.locator('.luker-bsum[data-bsum-id="mg-master-notice"]');
        await ensureSwitchState(enabledSwitch, false);
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
        await expect(masterNotice).toHaveCount(1);
        await expect(masterNotice).toBeVisible();

        await enabledSwitch.click();
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
        await expect(masterNotice).toHaveCount(0);

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

        const roleLabels = await sectionCard.locator('.luker-bsum-row .luker-bsum-role').allTextContents();
        expect(roleLabels).toHaveLength(2);
        expect(roleLabels.every(label => label.trim().length > 0)).toBe(true);
        expect(new Set(roleLabels).size).toBe(2);

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

        // Set updateEvery=2 and floorInput=1 (minRecommendedVisible=3): triggers amber visibility-gap warning live.
        const updateEveryInput = modal.locator('[data-field-key="updateEvery"] input').first();
        await updateEveryInput.fill('2');
        await floorInput.fill('1');
        await expect(modalCard).toHaveClass(/\bis-warn\b/);
        const warnBox = modalCard.locator('.luker-bsum-warn.is-warn').first();
        await expect(warnBox).toBeVisible();
        expect((await warnBox.textContent())?.trim().length).toBeGreaterThan(0);
        const modalFloorTok = modalCard.locator('.luker-bsum-tok[data-bsum-fields~="llmVisibleRecentMessages"]').first();
        await expect(modalFloorTok).toContainText('1');
        const oneMsgTokText = await modalFloorTok.textContent();

        // Fill 0 visible messages: clears visibility-gap warning and switches to full raw history.
        await floorInput.fill('0');
        await expect(modalCard.locator('.luker-bsum-warnings')).toBeHidden();
        await expect(modalCard).not.toHaveClass(/\bis-warn\b/);
        await expect(modalFloorTok).toContainText('0');
        expect(await modalFloorTok.textContent()).not.toBe(oneMsgTokText);

        // Hovering an input inside the modal activates matching token and row highlights live.
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

        // Ensure Pipeline (spec) execution mode via the real mode switcher so Spec runtime limits are active.
        const nodeRoundsInput = await ensureOrchestratorPipelineMode(lens);
        await expect(nodeRoundsInput).toBeVisible();

        await nodeRoundsInput.fill('15');
        await expect(runtimeCard.locator('.luker-bsum-tok[data-bsum-fields~="nodeIterationMaxRounds"]').first()).toContainText('15');

        const rerunRoundsInput = lens.locator('[data-field-key="reviewRerunMaxRounds"] input').first();
        const rerunTok = runtimeCard.locator('.luker-bsum-tok[data-bsum-fields~="reviewRerunMaxRounds"]').first();
        const rerunBefore = await rerunTok.textContent();
        await rerunRoundsInput.fill('0');
        await expect(rerunTok).toContainText('0');
        expect(await rerunTok.textContent()).not.toBe(rerunBefore);

        const retryInput = lens.locator('[data-field-key="toolCallRetryMax"] input').first();
        await retryInput.fill('4');
        await expect(crossModeCard.locator('.luker-bsum-tok[data-bsum-fields~="toolCallRetryMax"]').first()).toContainText('4');

        const rpmInput = lens.locator('[data-field-key="rpmLimit"] input').first();
        await rpmInput.fill('60');
        await expect(crossModeCard.locator('.luker-bsum-tok[data-bsum-fields~="rpmLimit"]').first()).toContainText('60');

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
        await ensureCheckboxUnchecked(page.locator('#search_tools_enabled'));
        await ensureCheckboxUnchecked(page.locator('#search_tools_pre_request_enabled'));
        await expect(stMainCard).toHaveClass(/\bis-dormant\b/);
        const stMainOffText = await stMainCard.textContent();
        const stLorebookOffText = await stLorebookCard.textContent();
        await expect(page.locator('#search_tools_tool_call_retry_max')).toHaveClass(/\bluker-bsum-field-dormant\b/);

        await page.locator('#search_tools_enabled').click();
        await expect(stMainCard).toHaveClass(/\bis-active\b/);
        const stMainOnText = await stMainCard.textContent();
        expect(stMainOnText).not.toBe(stMainOffText);

        await page.locator('#search_tools_pre_request_enabled').click();
        expect(await stMainCard.textContent()).not.toBe(stMainOnText);
        expect(await stLorebookCard.textContent()).not.toBe(stLorebookOffText);
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
        await ensureCheckboxUnchecked(page.locator('#connection_profile_function_calling_plain_text'));
        await expect(connPlainTextCard).toHaveClass(/\bis-dormant\b/);
        const plainTextOffText = await connPlainTextCard.textContent();

        await page.locator('#connection_profile_function_calling_plain_text').click();
        await expect(connPlainTextCard).toHaveClass(/\bis-active\b/);
        expect(await connPlainTextCard.textContent()).not.toBe(plainTextOffText);

        const connRpmInput = page.locator('#connection_profile_rpm_limit');
        await connRpmInput.fill('30');
        await connRpmInput.press('Tab');
        await expect(connReliabilityCard).toContainText('30');

        await closeTopDrawer(page, 'sys-settings-button');

        // 3. Regex Editor popup.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'regex_container');
        await page.locator('#open_regex_editor').click();

        let popup = page.locator('.popup:visible').last();
        await expect(popup).toBeVisible();
        let regexCard = popup.locator('.luker-bsum[data-bsum-id="regex-editor"]');
        await expect(regexCard).toHaveCount(1);

        const wiWarning = regexCard.locator('.luker-bsum-warn.is-warn');
        const baselineWarnCount = await wiWarning.count();

        await popup.locator('input[name="replace_position"][value="5"]').check();
        await expect(wiWarning).toHaveCount(baselineWarnCount + 1);
        await expect(wiWarning.last()).toBeVisible();

        await popup.locator('input[name="only_format_prompt"]').check();
        await expect(wiWarning).toHaveCount(baselineWarnCount);

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

    test('Mobile extensions drawer isolates scrollable textareas and skips zero-blur backdrop-filter without overriding custom CSS', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await awaitMainUI(page, server.baseURL);

        // Open Extensions drawer and expand Image Generation + AI Illustration + Character Profile Agent.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await openInlineDrawer(page, 'sd_illustration_container');
        await openProfileAgentDrawer(page);

        // Scrollable textareas inside extensions settings establish a positive stacking context.
        const textareaStyles = await page.evaluate(() => {
            const ids = [
                'sd_illustration_prompt',
                'sd_illustration_studio_prompt',
                'sd_illustration_exploration_prompt',
            ];
            return ids.map((id) => {
                const el = document.getElementById(id);
                const cs = el ? getComputedStyle(el) : null;
                return { id, position: cs?.position, zIndex: cs?.zIndex };
            });
        });
        for (const item of textareaStyles) {
            expect(item.position).toBe('relative');
            expect(Number(item.zIndex)).toBeGreaterThanOrEqual(1);
        }

        // Verify Chromium's compositor does not promote following siblings into giant overlap layers.
        const siblingOverlapLayers = await findLargeSiblingOverlapLayers(page);
        expect(siblingOverlapLayers).toEqual([]);

        // Verify blur_strength=0 turns off built-in backdrop-filter while preserving custom CSS overrides.
        await closeExtensionsDrawer(page);
        await openTopDrawer(page, 'user-settings-button');
        const customCssInput = await ensureEditableDarkLiteTheme(page);
        await ensureCheckboxUnchecked(page.locator('#fast_ui_mode'));

        const blurSlider = page.locator('#blur_strength');
        await blurSlider.fill('8');
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('rm_extensions_block')).backdropFilter))
            .toContain('blur(');

        const originalCustomCss = await customCssInput.inputValue();
        await customCssInput.fill(`${originalCustomCss}\n#chat { backdrop-filter: blur(5px); }`);
        await blurSlider.fill('0');

        await expect.poll(() => page.evaluate(() => ({
            extBackdrop: getComputedStyle(document.getElementById('rm_extensions_block')).backdropFilter,
            chatBackdrop: getComputedStyle(document.getElementById('chat')).backdropFilter,
            backdropVar: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBackdropFilter').trim(),
            backdrop2xVar: getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBackdropFilter2x').trim(),
        }))).toEqual({
            extBackdrop: 'none',
            chatBackdrop: 'blur(5px)',
            backdropVar: 'none',
            backdrop2xVar: 'none',
        });

        await customCssInput.fill(originalCustomCss);
        await closeTopDrawer(page, 'user-settings-button');
    });

    test('Classic extension drawers mount, refresh live, dim dormant fields, and cross-jump across TTS, Vectors, SD, Caption, Expressions, Translate, Quick Reply, CEA, CPA, and Hook Order', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openExtensionsDrawer(page);

        const openAnyDrawer = async (selector) => {
            const root = page.locator(selector).first();
            await root.waitFor({ state: 'attached', timeout: 10_000 });
            const isDrawerItself = await root.evaluate((el) => el.classList.contains('inline-drawer'));
            const drawer = isDrawerItself ? root : root.locator('.inline-drawer').first();
            const content = drawer.locator('> .inline-drawer-content').first();
            const hidden = await content.evaluate((el) => getComputedStyle(el).display === 'none');
            if (hidden) {
                await drawer.locator('> .inline-drawer-toggle').first().click();
                await content.waitFor({ state: 'visible', timeout: 10_000 });
            }
            return content;
        };

        // 1. TTS: narration + NPC attribution cards, live toggle + cross-scope jump to #tts_multi_voice_enabled
        await openAnyDrawer('#tts_container');
        const ttsCard1 = page.locator('.luker-bsum[data-bsum-id="tts-narration"]').first();
        const ttsCard2 = page.locator('.luker-bsum[data-bsum-id="tts-npc-attribution"]').first();
        await expect(ttsCard1).toBeVisible();
        await expect(ttsCard2).toBeVisible();
        await ensureCheckboxUnchecked(page.locator('#tts_enabled'));
        await expect(ttsCard1).toHaveClass(/\bis-dormant\b/);
        await page.locator('#tts_enabled').click();
        await expect(ttsCard1).toHaveClass(/\bis-active\b/);
        await ensureCheckboxUnchecked(page.locator('#tts_multi_voice_enabled'));
        if (!(await page.locator('#tts_npc_attribution_enabled').isChecked())) {
            await page.locator('#tts_npc_attribution_enabled').click();
        }
        await expect(ttsCard2).toHaveClass(/\bis-warn\b/);
        await ttsCard2.locator('.luker-bsum-warnings button[data-bsum-fields="multiVoiceEnabled"]').first().click();
        await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('tts_multi_voice_enabled');

        // 2. Vectors: all 4 cards mount, toggle World Info activates WI card & refreshes Shared card
        await openAnyDrawer('#vectors_container');
        const vecShared = page.locator('.luker-bsum[data-bsum-id="vectors-shared"]').first();
        const vecWi = page.locator('.luker-bsum[data-bsum-id="vectors-world-info"]').first();
        const vecFiles = page.locator('.luker-bsum[data-bsum-id="vectors-files"]').first();
        const vecChats = page.locator('.luker-bsum[data-bsum-id="vectors-chats"]').first();
        await expect(vecShared).toBeVisible();
        await expect(vecWi).toBeVisible();
        await expect(vecFiles).toBeVisible();
        await expect(vecChats).toBeVisible();
        await ensureCheckboxUnchecked(page.locator('#vectors_enabled_world_info'));
        await expect(vecWi).toHaveClass(/\bis-dormant\b/);
        await page.locator('#vectors_enabled_world_info').click();
        await expect(vecWi).toHaveClass(/\bis-active\b/);

        // 3. Stable Diffusion + AI Illustration + Profile Agent cross-drawer jump
        await openAnyDrawer('#sd_illustration_container');
        await openProfileAgentDrawer(page);
        const illMain = page.locator('.luker-bsum[data-bsum-id="sd-illustration-main"]').first();
        const illProfile = page.locator('.luker-bsum[data-bsum-id="sd-illustration-profile-agent"]').first();
        await expect(illMain).toBeVisible();
        await expect(illProfile).toBeVisible();
        const jumpCharRefBtn = illProfile.locator('button[data-bsum-fields="characterReferenceEnabled"]').first();
        await expect(jumpCharRefBtn).toBeVisible();
        await jumpCharRefBtn.click();
        await expect(page.locator('#sd_character_reference_enabled')).toBeVisible();
        await expect(page.locator('.luker-bsum[data-bsum-id="sd-mode-summary"]').first()).toBeVisible();

        // 4. Caption, Expressions, Translate, Quick Reply (global + per-set)
        await openAnyDrawer('#caption_container');
        const captionCard = page.locator('.luker-bsum[data-bsum-id="caption-settings"]').first();
        await expect(captionCard).toBeVisible();
        await page.locator('#caption_source').selectOption('multimodal');
        await expect(captionCard).toHaveClass(/\bis-active\b/);

        await openAnyDrawer('#expressions_container');
        const exprCard = page.locator('.luker-bsum[data-bsum-id="expressions-settings"]').first();
        await expect(exprCard).toBeVisible();

        await openAnyDrawer('#translation_container');
        const translateCard = page.locator('.luker-bsum[data-bsum-id="translate-settings"]').first();
        await expect(translateCard).toBeVisible();
        await page.locator('#translation_auto_mode').selectOption('responses');
        await expect(translateCard).toHaveClass(/\bis-active\b/);

        await openAnyDrawer('#qr--settings');
        const qrGlobal = page.locator('.luker-bsum[data-bsum-id="quick-reply-global"]').first();
        const qrSet = page.locator('.luker-bsum[data-bsum-id="quick-reply-set"]').first();
        await expect(qrGlobal).toBeVisible();
        await expect(qrSet).toBeVisible();

        // 5. CEA, CPA, and Hook Order
        await openAnyDrawer('#character_editor_assistant_settings');
        const ceaCard = page.locator('.luker-bsum[data-bsum-id="cea-settings-summary"]').first();
        await expect(ceaCard).toBeVisible();
        const ceaRetries = page.locator('#cea_tool_retries');
        await ceaRetries.fill('4');
        await ceaRetries.press('Tab');
        await expect(ceaCard).toContainText('4');

        await openAnyDrawer('#completion_preset_assistant_settings');
        const cpaCard = page.locator('.luker-bsum[data-bsum-id="cpa-settings-summary"]').first();
        await expect(cpaCard).toBeVisible();
        await expect(cpaCard).toContainText('3');

        await openAnyDrawer('#hook_order_settings');
        const hookCard = page.locator('.luker-bsum[data-bsum-id="hook-order-summary"]').first();
        await expect(hookCard).toBeVisible();

        await closeExtensionsDrawer(page);
    });
});
