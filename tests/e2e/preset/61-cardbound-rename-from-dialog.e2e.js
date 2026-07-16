// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #61 — 从 manage-bound-presets dialog 触发 rename: 走同一 Layer 1 API,
//        与铅笔按钮同一撞名规则, 同一 maybeApplyCharacterBoundPreset UI 重建。
//
// REAL USER-GESTURE flow:
//   1. Seed 卡 A 携带一个 slot X (default)。
//   2. 打开 char-management-dropdown → 触发 manage_character_bound_presets
//      option (与 43-bind-and-manage 同一入口)。
//   3. 点击 luker-mbp-rename 行内按钮 → 弹出 Popup.show.input →
//      Playwright fill NEW_NAME + click OK。
//   4. 断言:
//      (a) card slot 名 === NEW_NAME + default 联动;
//      (b) dialog 内新名行出现, 旧名行消失 (rerender);
//      (c) ghost <option> textContent === NEW_NAME;
//      (d) 全局目录无僵尸。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Dialog Rename Aria';
const CARD_AVATAR = 'dialog-rename-aria.png';
const OLD_NAME = 'DialogSlotX';
const NEW_NAME = 'DialogSlotZ';
const SLOT_TEMPERATURE = 0.55;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-rename-from-dialog',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: OLD_NAME, preset: { temperature: SLOT_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: OLD_NAME,
                    },
                },
            },
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Trigger a `#char-management-dropdown` option by id — same helper the
 * 43-bind-and-manage test uses to open the manage-bound-presets dialog.
 */
async function fireDropdownAction(page, optionId) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) await drawer.click();
    await page.waitForSelector('#char-management-dropdown', { state: 'attached', timeout: 5000 });
    await page.evaluate((id) => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#' + id);
        if (!opt) throw new Error(`option not present: #${id}`);
        opt.selected = true;
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, optionId);
}

test.describe('#61 — 从 dialog 触发 rename', () => {
    test('打开 dialog → 点 Rename 按钮 → 输入新名 → 断言 storage / DOM / dialog 三处同步', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );

        const presetsDir = path.join(server.dataRoot, 'default-user/OpenAI Settings');
        const beforeFiles = new Set(fs.readdirSync(presetsDir));

        // 打开 manage-bound-presets dialog (与 43-bind-and-manage 同一入口)。
        await fireDropdownAction(page, 'manage_character_bound_presets');
        const dialog = page.locator('#luker_manage_bound_presets_dialog');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        // 点该 slot 行的 Rename 按钮。
        const row = dialog.locator(`.luker-mbp-row[data-preset-name="${OLD_NAME}"]`);
        await row.locator('.luker-mbp-rename').click();

        // rename popup 弹出: 填新名 + 确认。此时同时有 manage-bound dialog
        // (POPUP_TYPE.DISPLAY) + rename input popup (POPUP_TYPE.INPUT) 两层,
        // 用 .last() 选最上层输入框。
        const popupInput = page.locator('dialog.popup[open] .popup-input').last();
        await popupInput.waitFor({ state: 'visible', timeout: 5000 });
        await popupInput.fill(NEW_NAME);
        await page.locator('dialog.popup[open] .popup-button-ok').last().click();

        // 等 dialog rerender: 新 name 出现在同一 dialog 内。
        await page.waitForSelector(
            `#luker_manage_bound_presets_dialog .luker-mbp-row[data-preset-name="${NEW_NAME}"]`,
            { state: 'visible', timeout: 5000 },
        );

        // (a) card slot 改名 + default 联动。
        const cardPresets = await page.evaluate(([cardName]) => {
            const ctx = window.SillyTavern?.getContext();
            const char = ctx?.characters?.find(c => c && c.name === cardName);
            return {
                names: char?.data?.extensions?.luker?.chat_completion_preset?.presets?.map(p => p.name),
                defaultPresetName: char?.data?.extensions?.luker?.chat_completion_preset?.defaultPresetName,
            };
        }, [CARD_NAME]);
        expect(cardPresets.names).toEqual([NEW_NAME]);
        expect(cardPresets.defaultPresetName).toBe(NEW_NAME);

        // (b) dialog 内旧名行已消失。
        const rowStillOld = await page.locator(
            `#luker_manage_bound_presets_dialog .luker-mbp-row[data-preset-name="${OLD_NAME}"]`,
        ).count();
        expect(rowStillOld).toBe(0);

        // (c) ghost optgroup 重建后 option textContent === 新名。
        const ghostText = await page.evaluate(() => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return opt?.textContent?.trim();
        });
        expect(ghostText).toBe(NEW_NAME);

        // (d) 不产僵尸全局。
        const afterFiles = new Set(fs.readdirSync(presetsDir));
        const added = [...afterFiles].filter(f => !beforeFiles.has(f));
        expect(added).toEqual([]);
    });
});
