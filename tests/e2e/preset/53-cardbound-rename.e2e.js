// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #53 — 基础 rename: card A 有 slot X (default, ghost 已 auto-apply) → 选中 X →
//        点铅笔按钮 → 输入 Y → 确定。走 renameCharacterBoundPreset 路径,
//        card slot 名改, defaultPresetName 联动, 全局目录无僵尸。
//
// REAL USER-GESTURE flow:
//   1. Seed 卡 A 携带一个 slot X (default, temperature=0.42)。
//   2. Load Luker → 卡自动选中 → ghost X 自动 apply。
//   3. 通过真 DOM click 触发铅笔按钮 → Popup.show.input 打开 popup →
//      Playwright fill input + click OK 按钮 (真用户手势)。
//   4. 断言:
//      (a) card slot 名 === 'Y' 且原 body 保留;
//      (b) defaultPresetName === 'Y' (联动);
//      (c) data/<user>/OpenAI Settings/ 无 X.json 无 Y.json 新文件 (不产僵尸);
//      (d) ghost <option> textContent === 'Y';
//      (e) oai_settings.preset_settings_openai 保持原 stale 全局名 (卡绑分派不动)。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, ensureOaiDrawerOpen } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Rename Test Aria';
const CARD_AVATAR = 'rename-test-aria.png';
const OLD_NAME = 'CardSlotX';
const NEW_NAME = 'CardSlotY';
const SLOT_TEMPERATURE = 0.42;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-rename',
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

test.describe('#53 — card-bound rename 走铅笔按钮', () => {
    test('rename X → Y: card slot 改名 + default 联动 + 无僵尸全局', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // 等 ghost 自动 apply (Task 1 使 active === ghost DOM-selected)。
        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );

        // 记录 stale 全局名 (rename 不应触碰它)。
        const staleGlobalName = await page.evaluate(() =>
            window.SillyTavern?.getContext()?.chatCompletionSettings?.preset_settings_openai || '',
        );

        // 记录全局 preset 目录 snapshot (rename 不应新增 X.json / Y.json)。
        const presetsDir = path.join(server.dataRoot, 'default-user/OpenAI Settings');
        const beforeFiles = new Set(fs.readdirSync(presetsDir));

        // 点铅笔按钮触发 rename popup。按钮在 AI Response Configuration
        // drawer 内 (display:none until drawer opens),先打开 drawer。
        await ensureOaiDrawerOpen(page);
        await page.click('[data-preset-manager-rename="openai"]');
        // Popup.show.input 用 POPUP_TYPE.INPUT: 输入框 class .popup-input,
        // 确认按钮 class .popup-button-ok (见 public/scripts/popup.js:251/254)。
        const popupInput = page.locator('dialog.popup[open] .popup-input');
        await popupInput.waitFor({ state: 'visible', timeout: 5000 });
        await popupInput.fill(NEW_NAME);
        await page.click('dialog.popup[open] .popup-button-ok');

        // 等 rename 完成: ghost option textContent 变 NEW_NAME。
        await page.waitForFunction(([expected]) => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return opt && opt.textContent.trim() === expected;
        }, [NEW_NAME], { timeout: 5000 });

        // (a)+(b) card slot 改名 + body 保留 + default 联动。
        const cardState = await page.evaluate(([cardName]) => {
            const ctx = window.SillyTavern?.getContext();
            const char = ctx?.characters?.find(c => c && c.name === cardName);
            const cbp = char?.data?.extensions?.luker?.chat_completion_preset;
            return {
                presets: cbp?.presets?.map(p => ({ name: p.name, temperature: p.preset?.temperature })),
                defaultPresetName: cbp?.defaultPresetName,
            };
        }, [CARD_NAME]);
        expect(cardState.presets).toEqual([{ name: NEW_NAME, temperature: SLOT_TEMPERATURE }]);
        expect(cardState.defaultPresetName).toBe(NEW_NAME);

        // (c) 全局 preset 目录不产僵尸。
        const afterFiles = new Set(fs.readdirSync(presetsDir));
        const added = [...afterFiles].filter(f => !beforeFiles.has(f));
        expect(added).toEqual([]);

        // (d) ghost option textContent 已断言过 (waitForFunction); double-check。
        const ghostText = await page.evaluate(() => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return opt?.textContent?.trim();
        });
        expect(ghostText).toBe(NEW_NAME);

        // (e) oai_settings.preset_settings_openai 保持原 stale 全局名。
        const staleAfter = await page.evaluate(() =>
            window.SillyTavern?.getContext()?.chatCompletionSettings?.preset_settings_openai || '',
        );
        expect(staleAfter).toBe(staleGlobalName);
    });
});
