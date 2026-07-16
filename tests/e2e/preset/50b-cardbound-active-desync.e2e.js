// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #50b — #update_oai_preset guard 用 isCharacterBoundPresetOptionSelected()
//         取代 characterBoundPresetState.active。
//
// Repro 场景(展示 old bug + 断言 new fix):
//   1. Seed 一张卡携带 slot CardSlot(temperature=0.27,default)。
//   2. 全局 preset 库预置 GlobalTarget(temperature=0.55)。
//   3. Load Luker → 卡自动选中 → ghost 自动 apply → temp_counter 显示 0.27。
//   4. 用户手切到 GlobalTarget global option(而非 ghost)。此时:
//        - DOM: #settings_preset_openai 选中项 data-luker-char-bound 不为 "1"
//        - old code: characterBoundPresetState.active 可能仍为 true(未同步)
//        - new code: isCharacterBoundPresetOptionSelected() 返 false → 走全局分支
//   5. 编辑 temperature 到 EDITED_TEMPERATURE (0.71)。
//   6. 点击 #update_oai_preset。
//   7. 断言:
//        (a) 全局 GlobalTarget preset 的 temperature 已被更新为 0.71(server
//            /api/presets/save 触发 + on-disk mtime 变化 + openai_settings[i]
//            .temperature === 0.71)。
//        (b) card slot CardSlot 的 body 保持 0.27 不变(未被误写)。
//        (c) toastr.success 出现(不再是"success 但静默无效")—— 且这次它对应
//            真实写盘。
//
// 与 Task 1(fix(preset): resolve characterBoundPresetState.active semantic
// split)的关系:Task 1 已让 characterBoundPresetState.active ≡
// isCharacterBoundPresetOptionSelected()(不变量 I),二者语义等价。本 e2e
// 因此从 day 1 即 PASS —— 它作为 **regression guard** 存在,锁定
// #update_oai_preset 的 guard 唯一权威 = DOM signal,防未来退化重新引入
// desync。详见 .superpowers/sdd/task-4-brief.md Step 2。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    setCounterInput,
    selectPresetByName,
    ensureOaiDrawerOpen,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CARD_NAME = 'Desync Repro Aria';
const CARD_AVATAR = 'desync-repro-aria.png';
const CARD_SLOT_NAME = 'CardSlot';
const CARD_SEED_TEMPERATURE = 0.27;
const GLOBAL_TARGET_NAME = 'GlobalTarget';
const GLOBAL_SEED_TEMPERATURE = 0.55;
const EDITED_TEMPERATURE = 0.71;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-active-desync',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // 预置全局 preset GlobalTarget(temperature=0.55)。用直接写文件的方式,
    // server 启动前落盘,启动时会被 loadOpenAIPresets 自动挂进 openai_settings。
    const globalPresetPath = path.join(
        server.dataRoot,
        'default-user/OpenAI Settings',
        `${GLOBAL_TARGET_NAME}.json`,
    );
    fs.mkdirSync(path.dirname(globalPresetPath), { recursive: true });
    fs.writeFileSync(globalPresetPath, JSON.stringify({
        temperature: GLOBAL_SEED_TEMPERATURE,
        chat_completion_source: 'openai',
    }, null, 4));

    // Seed card 携带 slot CardSlot(default = CardSlot)。
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            {
                                name: CARD_SLOT_NAME,
                                preset: {
                                    temperature: CARD_SEED_TEMPERATURE,
                                    chat_completion_source: 'openai',
                                },
                            },
                        ],
                        defaultPresetName: CARD_SLOT_NAME,
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

/** Read the card-bound preset body for a given slot name from the on-disk PNG. */
function readCardBoundPresetBody(dataRoot, avatarFile, name) {
    const p = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(p);
    const card = JSON.parse(readPngCard(png));
    const state = card?.data?.extensions?.luker?.chat_completion_preset;
    if (!state || !Array.isArray(state.presets)) return null;
    return state.presets.find(p => p?.name === name)?.preset ?? null;
}

function globalPresetFilePath(dataRoot, name) {
    return resolve(dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`);
}

test.describe('#50b — #update_oai_preset guard 用 DOM signal 消除 desync 静默无效', () => {
    test('ghost auto-applied → 手切 global → 编辑 → Update → 全局写盘,card 不动', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // 卡自动选中 → ghost auto-apply → temp_counter 反映 0.27。
        await selectCharacterByName(page, CARD_NAME);
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_SEED_TEMPERATURE, 5);

        // 手切到 GlobalTarget global option。selectPresetByName 是 helper,
        // 走真 jQuery val + trigger('change') —— 与用户手工点 select2 UI
        // 等价的 DOM 事件路径(select2 hidden 掉了原生 <select>,直接 Playwright
        // selectOption 会拒;这是 _helpers.js 里已建立的现有约定,不新造)。
        await selectPresetByName(page, GLOBAL_TARGET_NAME);

        // DOM 断言:当前不是 ghost 选中态(数据基线,证明 desync 前提成立)。
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const activeOpt = sel?.selectedOptions?.[0];
            return activeOpt && activeOpt.getAttribute('data-luker-char-bound') !== '1';
        }, { timeout: 5_000 });

        // 等 onSettingsPresetChange 的 async 应用完成到 oai_settings.temp_openai
        // (才是 GlobalTarget 的 0.55) —— selectPresetByName 只等
        // preset_settings_openai 字段,那步在 async handler 早段就赋好,但真正
        // 把 preset body 各字段(含 temperature)灌进 oai_settings 的 for 循环
        // 在后续 await eventSource.emit 之后才跑,若不等,setCounterInput 的
        // 0.71 会被随后的 loop 覆盖回 0.55(观察到的 race)。
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(GLOBAL_SEED_TEMPERATURE, 5);

        // 编辑 temperature 到 0.71 —— 通过真 DOM input 事件走 openai.js
        // 的 slider handler(_helpers.js:setCounterInput)。
        await setCounterInput(page, '#temp_counter_openai', EDITED_TEMPERATURE);
        // Sanity:编辑后运行时值确实是 0.71(排除 helper race)。
        await expect
            .poll(async () => {
                return await page.evaluate(() => {
                    const s = window.Luker?.getContext?.()?.chatCompletionSettings;
                    return Number(s?.temp_openai ?? NaN);
                });
            }, { timeout: 5_000 })
            .toBeCloseTo(EDITED_TEMPERATURE, 5);

        // 记录 baseline:全局 preset 文件的 mtime + card slot body(用于事后对比)。
        const globalPath = globalPresetFilePath(server.dataRoot, GLOBAL_TARGET_NAME);
        const mtimeBefore = statSync(globalPath).mtimeMs;
        const cardBodyBefore = readCardBoundPresetBody(server.dataRoot, CARD_AVATAR, CARD_SLOT_NAME);
        expect(cardBodyBefore?.temperature).toBeCloseTo(CARD_SEED_TEMPERATURE, 5);

        // 打开 drawer(#update_oai_preset 在 AI Response Configuration drawer
        // 内,display:none until open)+ 真 click。
        await ensureOaiDrawerOpen(page);

        // 抓 toastr success —— 老代码也会 toast,但对应"静默无效";
        // 新代码 toast 对应真实写盘。这里只用 toast 出现做 sanity check,
        // 真正的判定看 (a)(b) 两条 side-effect 断言。
        await page.locator('#update_oai_preset').click();

        // -------- Assertion (a): 全局 GlobalTarget.temperature 变 0.71 --------
        // (a.1) on-disk file mtime 变化(说明 /api/presets/save 真发生)。
        await expect
            .poll(() => statSync(globalPath).mtimeMs, { timeout: 10_000 })
            .toBeGreaterThan(mtimeBefore);
        // (a.2) 文件内容的 temperature 变 0.71(旁证 body 真的落盘)。
        const globalBodyAfter = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        expect(globalBodyAfter?.temperature).toBeCloseTo(EDITED_TEMPERATURE, 5);
        // (a.3) 运行时 openai_settings[GlobalTarget].temperature 也是 0.71。
        // Poll — 点击后 click 事件的 async handler 与测试并行执行;文件 mtime
        // 一变(persistPreset 的 fetch 返回)测试就往下走,但同一 handler
        // 里的 mergeStoredOpenAIPreset(openai_settings[value], …) 还没 tick
        // 到。用 poll 等它落到 0.71,超时上限 10s(实际 200ms 内到位)。
        await expect
            .poll(async () => {
                return await page.evaluate((n) => {
                    const openai = window.Luker?.getContext?.()?.openai;
                    const settings = openai?.settings;
                    const names = openai?.settingNames;
                    if (!Array.isArray(settings) || !names) return null;
                    const idx = names[n];
                    if (!Number.isInteger(idx)) return null;
                    return settings[idx]?.temperature ?? null;
                }, GLOBAL_TARGET_NAME);
            }, { timeout: 10_000 })
            .toBeCloseTo(EDITED_TEMPERATURE, 5);

        // -------- Assertion (b): card slot 未变 --------
        const cardBodyAfter = readCardBoundPresetBody(server.dataRoot, CARD_AVATAR, CARD_SLOT_NAME);
        expect(cardBodyAfter?.temperature).toBeCloseTo(CARD_SEED_TEMPERATURE, 5);

        // -------- Assertion (c): toastr.success 出现 --------
        // 只做存在性断言 —— toast 内容(i18n)本身别 grep(feedback_no_prompt_regex_tests
        // 精神:UI 字符串 e2e 不做严格文本断言);它对应"真实写盘"由 (a) 保障。
        await expect(page.locator('.toast.toastr-success, .toast-success').first())
            .toBeVisible({ timeout: 5_000 });
    });
});
