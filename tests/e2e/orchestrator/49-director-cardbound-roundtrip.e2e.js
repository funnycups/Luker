// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #49 — Director + card-bound preset roundtrip.
//
//   Regression guard for the full failure chain of the card-bound preset
//   during a director run:
//     卡绑 preset auto-applied → 用户改 temperature + prompt_order +
//     prompts[i].content → 触发 director run → restore 后 select 落回
//     ghost option,live oai_settings 与 apply 前逐字节相等,card slot
//     body 未变,stale 全局 preset 文件未被写盘。
//
//   改前(fix 未落):restore 只调 applyByName(activeName, {forceChange})
//   而 activeName = stale 全局名 → select 落到 stale 全局 option →
//   oai_settings 被 stale 全局 body 覆盖 → 用户编辑丢失 → e2e FAIL。
//
//   改后:apply 时捕获 ghost select value,restore 时优先 $().val(ghost)
//   .trigger('change'),onSettingsPresetChange 走 usingCharacterBoundPreset
//   =true 分支从 runtimeOptions 读回正确 body → 用户编辑保留 → e2e PASS。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    installMinimalDirectorProfile,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Director Roundtrip Card';
const CARD_AVATAR = 'director-roundtrip-card.png';
const SLOT_NAME = 'CardBoundSlot';
const SLOT_TEMPERATURE = 0.37;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'orchestrator',
        scenarioId: '49-director-cardbound-roundtrip',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Card 携带一个 slot(default 已 auto-apply)。slot body 里的
    // prompts / prompt_order 让 restore 后的逐字节比对具有信号(不是
    // 全 default 的空 shape)。
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
                                name: SLOT_NAME,
                                preset: {
                                    temperature: SLOT_TEMPERATURE,
                                    chat_completion_source: 'openai',
                                    prompts: [
                                        { identifier: 'main', name: 'Main', content: 'Slot main prompt seed.' },
                                    ],
                                    prompt_order: [
                                        { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
                                    ],
                                },
                            },
                        ],
                        defaultPresetName: SLOT_NAME,
                    },
                },
            },
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#49 — director run + card-bound preset roundtrip', () => {
    test('restore falls back onto ghost option and preserves live oai_settings byte-for-byte; no stale global preset write', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // ghost auto-applied —— 直接等 DOM signal(ghost <option> :checked),
        // 不依赖 window.__characterBoundPresetState 全局(这是 openai.js
        // 内部实现细节,插件层不该 peek)。
        await page.waitForFunction(() =>
            !!document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]:checked',
            ),
        );

        // 编辑 temperature + prompts[0].content + 追加 prompt_order 条目,
        // 让 live oai_settings 显式偏离 slot 初始 body。走 DOM/input 事件
        // (temp_openai 是 openai.js 挂 change 到 oai_settings 的官方 hook),
        // 加上直接写 prompts / prompt_order 后再 trigger 一次 change 让
        // syncCharacterBoundPresetFromSettings 感知并回写 card slot。
        await page.evaluate(() => {
            const $ = window.jQuery;
            const el = document.getElementById('temp_openai');
            if (el) {
                el.value = '0.71';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const ctx = window.Luker.getContext();
            const s = ctx.chatCompletionSettings;
            if (Array.isArray(s.prompts) && s.prompts[0]) {
                s.prompts[0].content = 'User-edited main prompt (director roundtrip).';
            }
            if (Array.isArray(s.prompt_order)) {
                for (const po of s.prompt_order) {
                    if (Array.isArray(po.order)) {
                        po.order.push({ identifier: 'main', enabled: true });
                    }
                }
            }
            $('#temp_openai').trigger('change');
        });

        // 等 syncCharacterBoundPresetFromSettings 把 temperature 写进 card slot
        // AND live oai_settings.temperature 稳定在 0.71 —— 中间有 debounce +
        // sync 交叠,需同时校验两侧收敛才拿 snapshot,否则 beforeApply 可能
        // 命中 sync 半路 (live 短暂回弹到 slot 初值 0.37) 的伪状态。
        const dataRoot = server.dataRoot;

        async function readCardSlotBody() {
            return await page.evaluate(async () => {
                const ctx = window.Luker.getContext();
                const chId = ctx.characterId;
                const char = ctx.characters?.[chId];
                const presets = char?.data?.extensions?.luker?.chat_completion_preset?.presets;
                if (!Array.isArray(presets)) return null;
                return presets[0]?.preset ?? null;
            });
        }

        await expect
            .poll(async () => {
                const [slot, live] = await Promise.all([
                    readCardSlotBody(),
                    page.evaluate(() => window.Luker.getContext().chatCompletionSettings?.temp_openai),
                ]);
                return { slot: slot?.temperature, live };
            }, { timeout: 15_000 })
            .toEqual({ slot: expect.closeTo(0.71, 2), live: expect.closeTo(0.71, 2) });

        // 记录 apply 前快照:ghost select value / live oai_settings 关键字段 /
        // card slot body / stale 全局 preset 文件 mtime。
        //
        // 注意 oai_settings 的运行时键是 `temp_openai`(不是 preset body 里的
        // `temperature`); preset body <-> oai_settings 的键映射见
        // openai.js:484 settingsToUpdate。
        const beforeApply = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.chatCompletionSettings;
            return {
                ghostSelectValue: String(document.getElementById('settings_preset_openai')?.value ?? ''),
                staleGlobalName: String(s.preset_settings_openai ?? ''),
                liveSerialized: JSON.stringify({
                    temp_openai: s.temp_openai,
                    prompts: s.prompts,
                    prompt_order: s.prompt_order,
                }),
            };
        });
        expect(beforeApply.ghostSelectValue, 'ghost value must start with card-bound sentinel')
            .toMatch(/^__luker_card__::/);
        expect(beforeApply.staleGlobalName, 'stale global name captured (fallback baseline)').not.toBe('');

        const cardSlotBefore = await readCardSlotBody();
        expect(cardSlotBefore, 'card slot body present').toBeTruthy();
        const cardSlotBeforeSerialized = JSON.stringify(cardSlotBefore);

        // 记录 stale 全局 preset 文件 mtime(以及内容)—— restore 后必须原样。
        const staleGlobalPath = path.join(
            dataRoot,
            'default-user',
            'OpenAI Settings',
            `${beforeApply.staleGlobalName}.json`,
        );
        const staleExisted = fs.existsSync(staleGlobalPath);
        const staleMtimeBefore = staleExisted ? fs.statSync(staleGlobalPath).mtimeMs : null;
        const staleContentBefore = staleExisted ? fs.readFileSync(staleGlobalPath, 'utf8') : null;

        // 安装一个最小 director profile,只跑 write_message + finalize —
        // 我们要观察的是 preset swap/restore 的 side effect,不是 director
        // 的业务行为。mockLLM 脚本 2 turn 即结束。
        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'You are the roundtrip director. Respond with write_message then finalize.',
        });

        // Assertion (a) 前置准备:监听 Popup —— 若假警报未被 Task 2 消除,
        // director 会弹 unsaved-changes popup;这里必须**不弹**。
        // 我们通过 monkey-patch `Popup.prototype.show` 记录调用并**自动答
        // NEGATIVE (Discard)** 让 director 继续跑完 —— 这样即便 pre-fix 状态
        // 下 popup 触发,后续断言 (b)-(e) 也仍能观察到 restore 后的漂移
        // (否则真 popup 无点击 → 挂 → transport 层 timeout,吞掉真正的 RED
        // 信号)。ctx.callGenericPopup 是 st-context.js 每次 getContext() 都
        // 新造的函数引用,直接改 ctx 上的属性只影响那一个 ctx 对象,拦不到
        // director-preset-swap 里的调用 —— 只能在模块层 patch。
        await page.evaluate(async () => {
            window.__e2e49PopupCalls = [];
            const popupModule = await import('/scripts/popup.js');
            const origShow = popupModule.Popup.prototype.show;
            popupModule.Popup.prototype.show = function patchedShow() {
                const raw = (typeof this.content === 'string')
                    ? this.content
                    : (this?.content?.textContent ?? this?.dlg?.textContent ?? '');
                window.__e2e49PopupCalls.push({ head: String(raw).slice(0, 200) });
                // 走 origShow 之前先解决:直接返 NEGATIVE (Discard = 0)。
                // 不动 DOM,让 director 逻辑立刻继续。
                return Promise.resolve(0);
            };
            window.__e2e49RestorePopupShow = () => {
                popupModule.Popup.prototype.show = origShow;
            };
        });

        mock.scriptDirectorRun({
            route: (req) => {
                if (req.role === 'director-main') {
                    if (req.turn === 0) {
                        return {
                            tool: 'write_message',
                            arguments: { text: 'Roundtrip echo.', mode: 'replace' },
                        };
                    }
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        await sendMessageAndAwaitReply(page, 'Trigger the director once.', { timeoutMs: 90_000 });

        // Assertion (a): apply 前 popup 不弹(改动 2 让 hasUnsavedChanges 在
        // 卡绑模式下正确返 false —— slot 已同步,live vs slot 相等)。
        const popupCalls = await page.evaluate(() => window.__e2e49PopupCalls || []);
        const unsavedPresetPopups = popupCalls.filter(p =>
            /unsaved|preset|synthetic/i.test(p.head),
        );
        expect(unsavedPresetPopups, 'director must NOT prompt about unsaved preset changes').toHaveLength(0);

        // Assertion (b): restore 后 select value === apply 前 ghost value。
        const afterRestoreSelectValue = await page.evaluate(() =>
            String(document.getElementById('settings_preset_openai')?.value ?? ''),
        );
        expect(afterRestoreSelectValue, 'select value restored to the exact same ghost value')
            .toBe(beforeApply.ghostSelectValue);

        // Assertion (c): restore 后 live oai_settings 与 apply 前逐字节相等。
        const afterRestoreLive = await page.evaluate(() => {
            const s = window.Luker.getContext().chatCompletionSettings;
            return JSON.stringify({
                temp_openai: s.temp_openai,
                prompts: s.prompts,
                prompt_order: s.prompt_order,
            });
        });
        expect(afterRestoreLive, 'live oai_settings byte-identical to pre-apply snapshot')
            .toBe(beforeApply.liveSerialized);

        // Assertion (d): card slot body 未变(与 apply 前 canonicalJson 相等)。
        const cardSlotAfter = await readCardSlotBody();
        expect(JSON.stringify(cardSlotAfter), 'card slot body unchanged across the director run')
            .toBe(cardSlotBeforeSerialized);

        // Assertion (e): 无 stale global preset 被写盘(mtime / 内容 均未变)。
        if (staleExisted) {
            const staleMtimeAfter = fs.statSync(staleGlobalPath).mtimeMs;
            expect(staleMtimeAfter, 'stale global preset file mtime unchanged').toBe(staleMtimeBefore);
            const staleContentAfter = fs.readFileSync(staleGlobalPath, 'utf8');
            expect(staleContentAfter, 'stale global preset file content unchanged').toBe(staleContentBefore);
        } else {
            // 更严格的负断言:director 期间**不许**新建这个 stale 全局文件。
            expect(fs.existsSync(staleGlobalPath), 'stale global preset must NOT be created during director run')
                .toBe(false);
        }
    });
});
