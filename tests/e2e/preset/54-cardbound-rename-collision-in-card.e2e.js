// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #54 — 同卡内撞名: card A 有 slot X + slot Y → 选中 X → rename → Y。
//        renameCharacterBoundPreset 应 throw, handler catch 弹 toastr.error,
//        card 上 X / Y 都保持不动, 全局目录无新文件。

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

const CARD_NAME = 'Rename Collision Aria';
const CARD_AVATAR = 'rename-collision-aria.png';
const SLOT_X = 'SlotX';
const SLOT_Y = 'SlotY';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-rename-collision',
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
                            { name: SLOT_X, preset: { temperature: 0.3, chat_completion_source: 'openai' } },
                            { name: SLOT_Y, preset: { temperature: 0.9, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT_X,
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

test.describe('#54 — card-bound rename 同卡内撞名', () => {
    test('rename X → Y (卡上已有 Y): toastr.error + X / Y 不动 + 无僵尸', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );

        const presetsDir = path.join(server.dataRoot, 'default-user/OpenAI Settings');
        const beforeFiles = new Set(fs.readdirSync(presetsDir));

        await ensureOaiDrawerOpen(page);
        await page.click('[data-preset-manager-rename="openai"]');
        const popupInput = page.locator('dialog.popup[open] .popup-input');
        await popupInput.waitFor({ state: 'visible', timeout: 5000 });
        await popupInput.fill(SLOT_Y);
        await page.click('dialog.popup[open] .popup-button-ok');

        // 等 toastr.error 出现。
        await page.waitForSelector('.toast-error, .toast.toast-error', { timeout: 5000 });

        // card 上 X + Y 都在 (原顺序)。
        const cardPresets = await page.evaluate(([cardName]) => {
            const ctx = window.SillyTavern?.getContext();
            const char = ctx?.characters?.find(c => c && c.name === cardName);
            return char?.data?.extensions?.luker?.chat_completion_preset?.presets?.map(p => p.name);
        }, [CARD_NAME]);
        expect(cardPresets).toEqual([SLOT_X, SLOT_Y]);

        // 全局目录不产僵尸。
        const afterFiles = new Set(fs.readdirSync(presetsDir));
        const added = [...afterFiles].filter(f => !beforeFiles.has(f));
        expect(added).toEqual([]);
    });
});
