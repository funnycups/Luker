// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #55 — 跨 origin 同名: card A slot X + global preset X → rename card X → Y。
//        与 resolveCharacterBoundPresetByName 分层设计一致 (card 优先, global fallback),
//        跨 origin 同名允许存在, rename 只改 card slot, global 完全不动。

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

const CARD_NAME = 'Rename Cross Origin Aria';
const CARD_AVATAR = 'rename-cross-origin-aria.png';
const SHARED_NAME = 'SharedNameX';
const NEW_NAME = 'RenamedToY';
const CARD_TEMPERATURE = 0.5;
const GLOBAL_TEMPERATURE = 0.7;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-rename-cross-origin',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // 预置全局同名 preset (server 启动前落盘, body 与 card 明显不同以便断言)。
    const globalPresetPath = path.join(server.dataRoot, 'default-user/OpenAI Settings', `${SHARED_NAME}.json`);
    fs.mkdirSync(path.dirname(globalPresetPath), { recursive: true });
    fs.writeFileSync(globalPresetPath, JSON.stringify({
        temperature: GLOBAL_TEMPERATURE,
        chat_completion_source: 'openai',
    }, null, 4));

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SHARED_NAME, preset: { temperature: CARD_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SHARED_NAME,
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

test.describe('#55 — card-bound rename 跨 origin 同名', () => {
    test('rename card X → Y: 成功; global X 完全不动; card 现在是 Y', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );

        const presetsDir = path.join(server.dataRoot, 'default-user/OpenAI Settings');
        const globalPresetPath = path.join(presetsDir, `${SHARED_NAME}.json`);
        const beforeMtime = fs.statSync(globalPresetPath).mtimeMs;
        const beforeContent = fs.readFileSync(globalPresetPath, 'utf-8');
        const beforeFiles = new Set(fs.readdirSync(presetsDir));

        await ensureOaiDrawerOpen(page);
        await page.click('[data-preset-manager-rename="openai"]');
        const popupInput = page.locator('dialog.popup[open] .popup-input');
        await popupInput.waitFor({ state: 'visible', timeout: 5000 });
        await popupInput.fill(NEW_NAME);
        await page.click('dialog.popup[open] .popup-button-ok');

        // 等 ghost option textContent 变 NEW_NAME。
        await page.waitForFunction(([expected]) => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return opt && opt.textContent.trim() === expected;
        }, [NEW_NAME], { timeout: 5000 });

        // (a) 成功: card 上现在是 Y。
        const cardPresets = await page.evaluate(([cardName]) => {
            const ctx = window.SillyTavern?.getContext();
            const char = ctx?.characters?.find(c => c && c.name === cardName);
            return char?.data?.extensions?.luker?.chat_completion_preset?.presets?.map(p => p.name);
        }, [CARD_NAME]);
        expect(cardPresets).toEqual([NEW_NAME]);

        // (b) global X 完全不动: 文件 mtime + 内容都不变。
        const afterMtime = fs.statSync(globalPresetPath).mtimeMs;
        const afterContent = fs.readFileSync(globalPresetPath, 'utf-8');
        expect(afterMtime).toBe(beforeMtime);
        expect(afterContent).toBe(beforeContent);

        // (c) 目录里不产 Y.json 僵尸。
        const afterFiles = new Set(fs.readdirSync(presetsDir));
        const added = [...afterFiles].filter(f => !beforeFiles.has(f));
        expect(added).toEqual([]);
    });
});
