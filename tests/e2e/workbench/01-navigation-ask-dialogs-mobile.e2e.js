// tests/e2e/workbench/01-navigation-ask-dialogs-mobile.e2e.js
//
// Workbench shell, navigation, Ask (Q&A) privacy switches + secret redaction,
// nested dialog + #toast-container z-index above .wb-win, and narrow mobile
// (<= 720px) layout verification via real UI gestures.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    bootstrapVectorsBackend,
    markOnboarded,
    writeWorldBook,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter, disableTagImportPopup } from '../character/_helpers.js';
import {
    closeWorkbench,
    openWorkbench,
    sendAskPrompt,
    switchWorkbenchTab,
    workbenchLayer,
    workbenchWindow,
} from '../_lib/ui-workbench.js';
import { openMemoryWorkspace, setMgSettings } from '../_lib/ui-mg-varops.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const SECRET_KEY = 'sk-e2etestsecretkey1234567890';
const SECRET_URL = 'https://vault.secret.example.com/v1/token';

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: ['*Ash glances over the chart.* "The lantern holds."'],
    });
    server = await startServer({
        batchKey: 'workbench',
        scenarioId: '01-nav-ask-dialogs-mobile',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
    disableTagImportPopup({ dataRoot: server.dataRoot });
    const LONG_WORLD_BOOK = 'chronicle-of-the-northern-archipelago-and-sunken-beacon-routes-vol-1';
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: LONG_WORLD_BOOK,
        entries: [{ comment: 'Beacon route', key: ['beacon'], content: 'Northern lantern markers.' }],
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-the-cartographer.png',
        overrides: {
            creator_notes: `Ledger note carries ${SECRET_KEY} and mirror ${SECRET_URL}.`,
            extensions: { world: LONG_WORLD_BOOK },
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('Workbench navigation, Ask privacy/redaction, overlays, and mobile layout', () => {
    test.setTimeout(180_000);

    test('desktop entry points, full tab navigation, Ask privacy + redaction, nested dialog, and host toast z-index', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        // 1. Entry points: pill, wand menu, Alt+W shortcut.
        await openWorkbench(page, { via: 'pill' });
        await closeWorkbench(page);
        await openWorkbench(page, { via: 'wand' });
        await closeWorkbench(page);
        await openWorkbench(page, { via: 'hotkey' });

        const win = workbenchWindow(page);

        // 2. Desktop navigation across Overview, Q&A, AI iteration, Change history, Memory graph, Orchestration, Settings.
        await switchWorkbenchTab(page, 'home');
        await expect(win.locator('.wb-h2')).toHaveText(/^(Overview|总览|總覽)$/);
        await expect(win.locator('.wb-cards .wb-card')).toHaveCount(6);

        await switchWorkbenchTab(page, 'ai');
        await expect(win.locator('.wb-ws-seg .lw-seg-btn').first()).toBeVisible();

        await switchWorkbenchTab(page, 'hist');
        await expect(win.locator('.wb-h2')).toHaveText(/^(Change history|改动记录|改動記錄)$/);

        await switchWorkbenchTab(page, 'ws:memory');
        await expect(win.locator('.mlens')).toBeVisible();

        await switchWorkbenchTab(page, 'ws:orch');
        await expect(win.locator('.olens')).toBeVisible();

        // 3. Ask privacy switches & secret redaction.
        await switchWorkbenchTab(page, 'settings');
        const inspectorRow = win.locator('.wb-setrow').filter({
            hasText: /^(Request inspector|请求记录|請求記錄)/,
        }).first();
        await inspectorRow.waitFor({ state: 'visible', timeout: 10_000 });
        const inspectorToggle = inspectorRow.locator('[role="checkbox"]').first();
        await expect(inspectorToggle).toHaveAttribute('aria-checked', 'true');
        await inspectorToggle.click();
        await expect(inspectorToggle).toHaveAttribute('aria-checked', 'false');

        const redactCheck = win.locator('[role="checkbox"]').filter({
            hasText: /Remove API keys and addresses before sending|发给 AI 前自动去掉密钥和地址|發給 AI 前自動去掉金鑰和位址/,
        }).first();
        await expect(redactCheck).toHaveAttribute('aria-checked', 'true');

        await switchWorkbenchTab(page, 'ask');
        const sideInspectorItem = win.locator('.wb-src-item').filter({
            hasText: /^(Request inspector|请求记录|請求記錄)/,
        }).first();
        await expect(sideInspectorItem).toContainText(/^(.*(Not read|不给看|不給看).*)$/);

        const beforeReqCount = mock.requests.length;
        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{ name: 'wb_read_character', arguments: { fields: ['creator_notes'] } }],
                };
            }
            return {
                toolCalls: [{
                    name: 'wb_answer',
                    arguments: {
                        text: '已检查角色卡描述，建议整理描述中的记录条目。',
                        suggest: 'card',
                        fix_prompt: '整理角色卡描述内容',
                    },
                }],
            };
        });

        await sendAskPrompt(page, 'Check Ash character description and tell me what needs cleanup.');
        mock.clearScriptedCompletion();

        const askRequests = mock.requests.slice(beforeReqCount).filter((r) => String(r.url || '').includes('chat/completions'));
        expect(askRequests.length).toBeGreaterThanOrEqual(2);

        // Inspector source was turned OFF → wb_list_requests must not be offered and overview must omit requests.
        const firstToolNames = (askRequests[0].body?.tools || []).map((t) => String(t?.function?.name || ''));
        expect(firstToolNames).not.toContain('wb_list_requests');
        const firstUserMsg = JSON.stringify(askRequests[0].body?.messages || []);
        expect(firstUserMsg).not.toContain('最近的请求');

        // Secret key and URL must be redacted before reaching the LLM.
        const secondRequestBlob = JSON.stringify(askRequests[1].body?.messages || []);
        expect(secondRequestBlob).not.toContain(SECRET_KEY);
        expect(secondRequestBlob).not.toContain('vault.secret.example.com');
        expect(secondRequestBlob).toContain('sk-***');

        // Clicking "Go edit Character card" routes to AI iteration on card with draft populated.
        const goEditBtn = win.locator('.wb-ans-acts button').first();
        await expect(goEditBtn).toBeVisible();
        await goEditBtn.click();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]')).toHaveText(/^(Character card|角色卡)$/);
        await expect(win.locator('.wb-chat .wb-input')).toHaveValue('整理角色卡描述内容');

        // 4. Nested dialog z-index & Escape isolation inside embedded Memory Lens.
        const lens = await openMemoryWorkspace(page, { subview: 'schema' });
        await lens.locator('.ml-schema-list-actions button').filter({ hasText: /^(Apply template|套用模板|套用範本)$/ }).first().click();
        const nestedDialog = lens.locator('.ml-dialog-backdrop .ml-dialog[role="alertdialog"]').first();
        await expect(nestedDialog).toBeVisible();

        const dialogBox = await nestedDialog.boundingBox();
        expect(dialogBox).toBeTruthy();
        const hitDialog = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return Boolean(el && el.closest('.ml-dialog'));
        }, { x: dialogBox.x + dialogBox.width / 2, y: dialogBox.y + dialogBox.height / 2 });
        expect(hitDialog).toBe(true);

        // Escape closes ONLY the nested dialog; Workbench window remains open.
        await page.keyboard.press('Escape');
        await expect(nestedDialog).toBeHidden();
        await expect(win).toBeVisible();

        // 5. Host #toast-container must stay visible and stacked above .wb-win.
        await setMgSettings(page, { enabled: true });
        await openMemoryWorkspace(page, { subview: 'settings' });
        await lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(Fill Missing|补充缺失向量|補充缺失向量)$/ }).first().click();

        const toast = page.locator('#toast-container .toast').first();
        await expect(toast).toBeVisible({ timeout: 10_000 });
        const stacking = await page.evaluate(() => {
            const wb = document.querySelector('.wbench');
            const tc = document.getElementById('toast-container');
            const toastEl = tc?.querySelector('.toast');
            const rect = toastEl?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
            return {
                wbZ: Number(getComputedStyle(wb).zIndex || 0),
                tcZ: Number(getComputedStyle(tc).zIndex || 0),
                hitsToast: Boolean(hit && hit.closest('#toast-container')),
            };
        });
        expect(stacking.tcZ).toBeGreaterThan(stacking.wbZ);
        expect(stacking.hitsToast).toBe(true);

        await closeWorkbench(page);
    });

    test('narrow mobile viewport (<= 720px) switches to compact bottom sheet and navigates all workspaces', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        const baselineDocScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);

        await openWorkbench(page, { via: 'pill' });
        const layer = workbenchLayer(page);
        const win = workbenchWindow(page);

        await expect(layer).toHaveClass(/is-compact/);
        await expect(layer.locator('.wb-scrim')).toBeVisible();

        const box = await win.boundingBox();
        expect(box).toBeTruthy();
        expect(box.width).toBeLessThanOrEqual(390);

        await switchWorkbenchTab(page, 'home');
        await expect(win.locator('.wb-h2')).toHaveText(/^(Overview|总览|總覽)$/);
        await expect(win.locator('.wb-cards .wb-card')).toHaveCount(6);

        const homeLayout = await page.evaluate(() => {
            const main = document.querySelector('.wbench .wb-main');
            const mainStyle = main ? getComputedStyle(main) : null;
            const cards = Array.from(document.querySelectorAll('.wbench .wb-cards .wb-card')).map((el) => {
                const r = el.getBoundingClientRect();
                return { width: Math.round(r.width), right: Math.round(r.right) };
            });
            return {
                scrollY: window.scrollY,
                docScrollHeight: document.documentElement.scrollHeight,
                topBarTop: Math.round(document.getElementById('top-bar')?.getBoundingClientRect().top ?? 0),
                mainClientW: main?.clientWidth ?? 0,
                mainScrollW: main?.scrollWidth ?? 0,
                mainOverflowX: mainStyle?.overflowX ?? '',
                mainBg: mainStyle?.backgroundColor ?? '',
                cards,
            };
        });
        expect(homeLayout.scrollY).toBe(0);
        expect(homeLayout.docScrollHeight).toBeLessThanOrEqual(baselineDocScrollHeight);
        expect(homeLayout.topBarTop).toBe(0);
        expect(homeLayout.mainOverflowX).toBe('hidden');
        expect(homeLayout.mainBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(homeLayout.mainScrollW).toBeLessThanOrEqual(homeLayout.mainClientW);
        for (const c of homeLayout.cards) {
            expect(c.width).toBeLessThanOrEqual(390);
            expect(c.right).toBeLessThanOrEqual(390);
        }

        await switchWorkbenchTab(page, 'settings');
        const settingsLayout = await page.evaluate(() => {
            const main = document.querySelector('.wbench .wb-main');
            const api = document.querySelector('.wbench .wb-api');
            return {
                mainClientW: main?.clientWidth ?? 0,
                mainScrollW: main?.scrollWidth ?? 0,
                apiRight: api ? Math.round(api.getBoundingClientRect().right) : 0,
            };
        });
        expect(settingsLayout.mainScrollW).toBeLessThanOrEqual(settingsLayout.mainClientW);
        expect(settingsLayout.apiRight).toBeLessThanOrEqual(390);

        await switchWorkbenchTab(page, 'ask');
        await expect(win.locator('.wb-chat .wb-input')).toBeVisible();

        await switchWorkbenchTab(page, 'ai');
        await expect(win.locator('.wb-chat .wb-input')).toBeVisible();

        await switchWorkbenchTab(page, 'hist');
        await expect(win.locator('.wb-h2')).toHaveText(/^(Change history|改动记录|改動記錄)$/);

        await switchWorkbenchTab(page, 'ws:memory');
        await expect(win.locator('.mlens')).toHaveClass(/is-compact/);
        await expect(win.locator('.mlens .ml-bottomnav')).toBeVisible();
        const mlensLayout = await page.evaluate(() => {
            const mlens = document.querySelector('.wbench .mlens');
            const left = mlens?.querySelector('.ml-topbar-left');
            const scrim = mlens?.querySelector('.ml-scrim');
            const right = mlens?.querySelector('.ml-topbar-right');
            return {
                clientW: mlens?.clientWidth ?? 0,
                scrollW: mlens?.scrollWidth ?? 0,
                clientH: mlens?.clientHeight ?? 0,
                scrollH: mlens?.scrollHeight ?? 0,
                leftDisplay: left ? getComputedStyle(left).display : '',
                scrimDisplay: scrim ? getComputedStyle(scrim).display : '',
                rightEdge: right ? Math.round(right.getBoundingClientRect().right) : 0,
            };
        });
        expect(mlensLayout.scrollW).toBeLessThanOrEqual(mlensLayout.clientW);
        expect(mlensLayout.scrollH).toBeLessThanOrEqual(mlensLayout.clientH);
        expect(mlensLayout.leftDisplay).toBe('none');
        expect(mlensLayout.scrimDisplay).toBe('none');
        expect(mlensLayout.rightEdge).toBeLessThanOrEqual(390);

        await switchWorkbenchTab(page, 'ws:orch');
        await expect(win.locator('.olens')).toHaveClass(/is-compact/);
        await expect(win.locator('.olens .ol-flow-head h2')).toBeVisible();
        const olensLayout = await page.evaluate(() => {
            const olens = document.querySelector('.wbench .olens');
            const left = olens?.querySelector('.ol-topbar-left');
            const seg = olens?.querySelector('.ol-viewswitch .lw-seg');
            const aiBtn = olens?.querySelector('.ol-topbar-right .lw-btn');
            const scrim = olens?.querySelector('.ol-scrim');
            const inspector = olens?.querySelector('.ol-inspector');
            const modeBtn = olens?.querySelector('.ol-mobilebar .ol-modebtn');
            const pills = Array.from(olens?.querySelectorAll('.ol-flow-meta .ol-pill') || []).map((el) => {
                const r = el.getBoundingClientRect();
                return { width: Math.round(r.width), right: Math.round(r.right) };
            });
            return {
                clientW: olens?.clientWidth ?? 0,
                scrollW: olens?.scrollWidth ?? 0,
                clientH: olens?.clientHeight ?? 0,
                scrollH: olens?.scrollHeight ?? 0,
                leftDisplay: left ? getComputedStyle(left).display : '',
                scrimDisplay: scrim ? getComputedStyle(scrim).display : '',
                inspectorDisplay: inspector ? getComputedStyle(inspector).display : '',
                segLeft: seg ? Math.round(seg.getBoundingClientRect().left) : 0,
                segRight: seg ? Math.round(seg.getBoundingClientRect().right) : 0,
                aiLeft: aiBtn ? Math.round(aiBtn.getBoundingClientRect().left) : 0,
                aiRight: aiBtn ? Math.round(aiBtn.getBoundingClientRect().right) : 0,
                modeRight: modeBtn ? Math.round(modeBtn.getBoundingClientRect().right) : 0,
                pills,
            };
        });
        expect(olensLayout.scrollW).toBeLessThanOrEqual(olensLayout.clientW);
        expect(olensLayout.scrollH).toBeLessThanOrEqual(olensLayout.clientH);
        expect(olensLayout.leftDisplay).toBe('none');
        expect(olensLayout.scrimDisplay).toBe('none');
        expect(olensLayout.inspectorDisplay).toBe('none');
        expect(olensLayout.segLeft).toBeGreaterThanOrEqual(0);
        expect(olensLayout.segRight).toBeLessThanOrEqual(olensLayout.aiLeft);
        expect(olensLayout.aiRight).toBeLessThanOrEqual(390);
        expect(olensLayout.modeRight).toBeGreaterThan(0);
        expect(olensLayout.modeRight).toBeLessThanOrEqual(390);
        expect(olensLayout.pills.length).toBeGreaterThanOrEqual(2);
        for (const p of olensLayout.pills) {
            expect(p.right).toBeLessThanOrEqual(390);
        }

        // Tapping an agent card opens the compact bottom sheet; tapping .ol-scrim closes it.
        await win.locator('.olens .ol-card').first().click();
        await expect(win.locator('.olens')).toHaveClass(/sheet-open/);
        await expect(win.locator('.olens .ol-inspector')).toBeVisible();
        await win.locator('.olens .ol-scrim').click({ position: { x: 8, y: 8 } });
        await expect(win.locator('.olens')).not.toHaveClass(/sheet-open/);
        await expect(win.locator('.olens .ol-inspector')).toBeHidden();

        await closeWorkbench(page);
        const afterClose = await page.evaluate(() => ({
            scrollY: window.scrollY,
            docScrollHeight: document.documentElement.scrollHeight,
            topBarTop: Math.round(document.getElementById('top-bar')?.getBoundingClientRect().top ?? 0),
        }));
        expect(afterClose.scrollY).toBe(0);
        expect(afterClose.docScrollHeight).toBeLessThanOrEqual(baselineDocScrollHeight);
        expect(afterClose.topBarTop).toBe(0);
    });
});
