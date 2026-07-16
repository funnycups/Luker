// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #56 — 卡绑 ghost 选中态下,非 UI 路径触发 #delete_oai_preset 点击时,
//        onDeletePresetClick guard 拒绝执行,不会走 /api/presets/delete 误删
//        stale 全局 preset。
//
// 未加 guard 前的真实数据破坏路径:
//   1. 卡有 slot MyPreset(default,已 auto-apply ghost)。
//   2. 卡绑模式下 oai_settings.preset_settings_openai 保留 stale 全局名
//      —— fixtures 里 normalizeIterStudioSettings 明确把它 seed 成 'Default'。
//   3. 非 UI 路径 click #delete_oai_preset → confirm accept → nameToDelete
//      = 'Default'(stale 全局名)→ 调 /api/presets/delete → 真的删掉磁盘上
//      的 data/<user>/OpenAI Settings/Default.json,且当前 ghost 选中态被
//      静默 fallthrough 到下一个全局 preset。
//
// Refactor 后:isCharacterBoundPresetOptionSelected() === true → 早退,
// 无 confirm 弹窗、无 delete fetch、无文件被删。

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

const CARD_NAME = 'Delete Guard Card';
const CARD_AVATAR = 'delete-guard-card.png';
const SLOT_NAME = 'CardSlotOnly';
const SLOT_TEMPERATURE = 0.42;
// normalizeIterStudioSettings 里已经把 preset_settings_openai seed 成 'Default'
// (见 tests/e2e/preset/_helpers.js:26),ghost 进入后 stale 全局名就是它。
const STALE_GLOBAL_NAME = 'Default';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-delete-guard',
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
                            { name: SLOT_NAME, preset: { temperature: SLOT_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT_NAME,
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

test.describe('#56 — onDeletePresetClick guard 防止误删 stale 全局 preset', () => {
    test('卡绑 ghost 选中时点 #delete_oai_preset → toastr.error / 无 delete fetch / 全局文件不动', async ({ page }) => {
        // 收集所有对 /api/presets/delete 的请求 —— guard 生效时应保持为空。
        const deleteRequests = [];
        page.on('request', (req) => {
            if (req.url().includes('/api/presets/delete')) {
                deleteRequests.push({ url: req.url(), postData: req.postData() });
            }
        });

        // 保险:未加 guard 时会走 callGenericPopup 弹 confirm。callGenericPopup
        // 是 in-DOM popup 而非原生 dialog,通常不触发这个事件;但如果测试
        // 环境某个组件降级到原生 confirm(第三方脚本、alert() 等),自动
        // dismiss 掉,让 fail 路径直接落到"delete fetch 发出"的断言上,
        // 而不是卡在 dialog 弹框上超时。
        page.on('dialog', (d) => d.dismiss().catch(() => {}));

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // 等 ghost auto-apply 完成 —— slot 是 default,选卡时应立刻切到 ghost。
        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );

        // 断言前置:ghost 选中态下 oai_settings.preset_settings_openai 仍是
        // stale 全局名 —— 这是"guard 拒绝的场景"的现实前提。用 evaluate
        // 得到的名字作为权威,让 stale 文件路径不受硬编码猜测影响。
        const staleName = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.chatCompletionSettings?.preset_settings_openai;
        });
        expect(typeof staleName).toBe('string');
        expect(staleName.length).toBeGreaterThan(0);
        // fixtures seed 保证 'Default';如果哪天 seed 变了,expect 会告诉我们。
        expect(staleName).toBe(STALE_GLOBAL_NAME);

        const stalePath = path.join(
            server.dataRoot,
            'default-user',
            'OpenAI Settings',
            `${staleName}.json`,
        );
        // 若 fixtures 未 seed 此磁盘文件,主动 seed 一份 —— 让"stale 全局
        // 被误删"这条断言路径有靶子可打。
        if (!fs.existsSync(stalePath)) {
            fs.mkdirSync(path.dirname(stalePath), { recursive: true });
            fs.writeFileSync(stalePath, JSON.stringify({
                temperature: 0.7,
                chat_completion_source: 'openai',
            }, null, 4));
        }
        const mtimeBefore = fs.statSync(stalePath).mtimeMs;

        // 真实用户手势:直接 DOM click #delete_oai_preset(非 UI 常规路径,
        // 是老 openai 面板顶部的删除按钮 —— public/index.html:195)。用
        // evaluate 只是为了触发**真** DOM click 事件,遵循
        // feedback_e2e_real_user_flow.md;handler 本体走真代码路径,不 mock。
        await page.evaluate(() => {
            const el = document.getElementById('delete_oai_preset');
            if (!el) throw new Error('#delete_oai_preset not found in DOM');
            el.click();
        });

        // RED-path 强化:未加 guard 时 handler 会走 callGenericPopup 弹出
        // in-DOM confirm popup。如果不自动 accept 它,delete fetch 永远不
        // 会发出,那 (b) "无 delete fetch" 就会误 pass,test 只能靠 toast
        // 断言 fail —— 但那没证明"数据破坏路径闭合"。这里主动 accept
        // 任何刚弹出的 delete-confirm popup(仅在弹出的情况下):RED 路径
        // 里 fetch 会真的发出 → (b) 断言真 fail;GREEN 路径里 guard 早
        // 于 popup return,这个 accept 是 no-op。callGenericPopup 是异步
        // 的 —— dialog show 需要一个 microtask,等 500ms 给它时间落地。
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const popups = Array.from(document.querySelectorAll('dialog.popup[open]'));
            const deletePopup = popups.find((p) => {
                const text = p.innerText || '';
                return text.includes('Delete the preset');
            });
            if (!deletePopup) return;
            const ok = deletePopup.querySelector('.popup-button-ok');
            if (ok) ok.click();
        });
        // 给 accept 后的 fetch 一点时间到达并被 page.on('request') 捕获。
        await page.waitForTimeout(1000);

        // 断言顺序:先跑数据破坏相关断言 —— 这些才是真正想守住的不变量。
        // 如果 guard 缺失,fetch 会真的发出、stale 全局文件会真的被删,
        // 这两条断言会立刻 fail 指向数据破坏;把它们放在 toast 等待之前,
        // 避免 toast timeout 遮盖真实 bug。

        // 断言 (b):/api/presets/delete 未被调用。
        expect(deleteRequests).toEqual([]);

        // 断言 (c):stale 全局 preset 文件仍在,mtime 未变。
        expect(fs.existsSync(stalePath)).toBe(true);
        const mtimeAfter = fs.statSync(stalePath).mtimeMs;
        expect(mtimeAfter).toBe(mtimeBefore);

        // 断言 (d):card slot 结构未被破坏(数量 / 名字 / temperature 保留)。
        // 不断言 slot preset body 全字段 —— auto-apply ghost 会把 slot 的
        // preset 展开为 canonicalized 全字段版本(这是既有 auto-apply 行为,
        // 与 delete-guard 无关)。这里只 pin 与 delete-guard 直接相关的
        // 破坏面:slot 不被删、名字不变、default 指针不变、身份字段
        // (temperature)不被冲掉。
        const slotAfter = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            const char = ctx?.characters?.find(c => c && c.name === name);
            return char?.data?.extensions?.luker?.chat_completion_preset ?? null;
        }, CARD_NAME);
        expect(Array.isArray(slotAfter?.presets)).toBe(true);
        expect(slotAfter.presets).toHaveLength(1);
        expect(slotAfter.presets[0]?.name).toBe(SLOT_NAME);
        expect(slotAfter.presets[0]?.preset?.temperature).toBe(SLOT_TEMPERATURE);
        expect(slotAfter?.defaultPresetName).toBe(SLOT_NAME);

        // 断言 (e) 反证:in-DOM confirm popup **没有**出现 —— 若出现说明
        // guard 未生效,走到了 callGenericPopup 那一行。上面 accept 逻辑
        // 会把已弹出的 popup close 掉,所以这里查的是"当前时刻"是否有
        // 残留 open dialog(GREEN 时 popup 从未创建过,应该也没 close 后的
        // 残留 DOM;RED 时 popup 已被 accept close,可能有 close 后残留)。
        // 更可靠的方式:检查 accept 逻辑是否曾找到 popup —— 但那已经隐含
        // 在 (b) fetch 断言里(找到 + accept → fetch 发出 → (b) fail)。
        // 这里保留视觉断言作辅助,不作为主判据。
        const confirmVisible = await page.evaluate(() => {
            const popups = Array.from(document.querySelectorAll('dialog.popup[open]'));
            return popups.some(p => {
                const text = p.innerText || '';
                return text.includes('Delete the preset') || text.includes('删除预设') || text.includes('刪除預設');
            });
        });
        expect(confirmVisible).toBe(false);

        // 断言 (a):toastr.error 出现且含"Cannot delete"。这是最外层的
        // "用户可见反馈"层 —— guard return 前会弹 toast 告诉用户走
        // manage-bound-presets dialog。放最后:即使前面所有数据不变量
        // 都通过,若 UX 反馈缺失(guard return 但没 toast)也算 regression。
        await page.waitForSelector('#toast-container .toast-error', { timeout: 5000 });
        const toastText = await page.locator('#toast-container .toast-error').first().innerText();
        // 匹配英文原文关键片段。e2e 默认英文 locale,`t\`...\`` 返回 key
        // 本身。避免匹配含双引号的整句,截取稳定的核心动词短语。
        expect(toastText).toContain('Cannot delete');
    });
});
