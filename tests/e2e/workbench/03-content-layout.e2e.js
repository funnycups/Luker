import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI, openExtensionsDrawer, openInlineDrawer, closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';
import {
    clickWandMenuItem, openWorkbench, closeWorkbench, workbenchWindow,
    switchWorkbenchTab, openOrchWorkspace,
} from '../_lib/ui-workbench.js';

// A prompt much taller than the viewport exposes flex shrinking of the list
// above the detail pane. Keep its full text in the real recorder and renderer.
const IMAGE_PROMPT = Array.from({ length: 90 }, (_, index) =>
    `Coastal chart detail ${index + 1}: a brass spyglass beside a folded map, lantern light, blue evening mist.`,
).join('\n');

let server, mock;

test.use({ actionTimeout: 15_000 });

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM();
    mock.scriptCompletion(({ toolNames }) => toolNames.includes('add_image_prompt')
        ? {
            tool: 'add_image_prompt',
            arguments: {
                prompt: IMAGE_PROMPT,
                insert_after: 'spyglass',
                insert_before: 'on the chart.',
            },
        }
        : { text: '*Ash studies the coastline in the lantern light.*' });
    server = await startServer({
        scope,
        batchKey: 'workbench',
        scenarioId: '03-content-layout',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL, api: 'custom' });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-layout.png',
        overrides: { first_mes: '*Ash places the brass spyglass on the chart.*' },
    });
});

test.afterAll(async () => {

    await test.step('Stop the upstream LLM fixture', () => mock?.stop());
});

async function selectAsh(page) {
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_print_characters_block .character_select')
        .filter({ has: page.locator('.avatar[title$="File: ash-layout.png"]') }).click();
    await expect(page.locator('#chat .mes').first()).toContainText('spyglass');
    await page.keyboard.press('Escape');
    await expect(page.locator('#right-nav-panel')).toBeHidden();
}

async function configureIllustration(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
    await page.locator('#sd_source').selectOption('auto');
    // Exercise a real backend failure, without replacing image generation or
    // the recorder. Only the upstream chat-completions response is mocked.
    await page.locator('#sd_auto_url').fill('http://127.0.0.1:1');
    await openInlineDrawer(page, 'sd_illustration_container');
    await page.locator('#sd_illustration_enabled').check();
    await page.locator('#sd_illustration_auto_generate').uncheck();
    await page.locator('#sd_illustration_api_preset').selectOption({ label: 'e2e-mock' });
    await page.locator('#sd_illustration_llm_preset').selectOption({ label: 'Default' });
    await closeAnyOpenTopSettingsDrawer(page);
}

async function expectContainedControls(root) {
    const overflow = await root.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return [...el.querySelectorAll('input:not([type="checkbox"]), textarea, select, button')]
            .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden')
            .filter(control => {
                // Horizontal tab strips intentionally scroll within their own
                // clipped viewport rather than wrapping the entire window.
                const strip = control.closest('.lw-seg, .wb-rail');
                if (strip && strip.scrollWidth > strip.clientWidth) return false;
                const rect = control.getBoundingClientRect();
                return rect.width > bounds.width + 1 || rect.right > bounds.right + 1 || rect.left < bounds.left - 1;
            })
            .map(control => ({ tag: control.tagName, text: control.textContent, class: control.className }));
    });
    expect(overflow).toEqual([]);
}

async function acknowledgeNotifications(page) {
    const notifications = page.locator('#toast-container .toast:visible');
    while (await notifications.count()) {
        const toast = await notifications.first().elementHandle();
        const close = await toast.$('.toast-close-button');
        if (close) await close.click();
        else await toast.click();
        await toast.waitForElementState('hidden');
    }
}

async function expectInsideCharacterDetail(control) {
    await expect.poll(() => control.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const pane = el.closest('.sdlens-chars-detail').getBoundingClientRect();
        const win = el.closest('.wb-win').getBoundingClientRect();
        // Scroll offsets round to device pixels while DOMRects retain fractions.
        const pixel = 1 / devicePixelRatio;
        const scrolls = [];
        for (let node = el.parentElement; node; node = node.parentElement) {
            if (node.scrollTop || node.scrollLeft) {
                scrolls.push({ className: node.className, top: node.scrollTop, left: node.scrollLeft });
            }
        }
        return [
            ['top', pane.top - rect.top],
            ['bottom', rect.bottom - pane.bottom],
            ['left', pane.left - rect.left],
            ['right', rect.right - pane.right],
            ['window-top', -win.top],
            ['window-bottom', win.bottom - innerHeight],
        ].filter(([, overflow]) => overflow > pixel)
            .map(([edge, overflow]) => ({ edge, overflow, scrolls }));
    })).toEqual([]);
}

async function clickInCharacterDetail(page, control) {
    // Reveal controls by scrolling their pane, then click within its visible area.
    while (true) {
        const position = await control.evaluate(el => {
            const pane = el.closest('.sdlens-chars-detail');
            const bounds = pane.getBoundingClientRect();
            const rect = el.getBoundingClientRect();
            const top = Math.max(0, bounds.top);
            const bottom = Math.min(innerHeight, bounds.bottom);
            const delta = rect.top < top ? rect.top - top : Math.max(0, rect.bottom - bottom);
            return {
                delta,
                pixel: 1 / devicePixelRatio,
                scrollTop: pane.scrollTop,
                paneX: (Math.max(0, bounds.left) + Math.min(innerWidth, bounds.right)) / 2,
                paneY: (top + bottom) / 2,
                x: (Math.max(0, bounds.left, rect.left) + Math.min(innerWidth, bounds.right, rect.right)) / 2,
                y: (Math.max(top, rect.top) + Math.min(bottom, rect.bottom)) / 2,
            };
        });
        if (Math.abs(position.delta) <= position.pixel) {
            await page.mouse.click(position.x, position.y);
            break;
        }
        await page.mouse.move(position.paneX, position.paneY);
        await page.mouse.wheel(0, position.delta);
        await expect.poll(() => control.evaluate(el => el.closest('.sdlens-chars-detail').scrollTop))
            .not.toBe(position.scrollTop);
        // Coordinate clicks need stable geometry after compositor scrolling.
        await expect.poll(() => control.evaluate(async el => {
            const pane = el.closest('.sdlens-chars-detail');
            const before = { scroll: pane.scrollTop, top: el.getBoundingClientRect().top };
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return pane.scrollTop === before.scroll && el.getBoundingClientRect().top === before.top;
        })).toBe(true);
    }
    await expect(control).toBeFocused();
}

async function setWorkbenchTheme(page, win, theme) {
    if (await page.locator('.wbench').getAttribute('data-theme') !== theme) {
        await win.getByRole('button', { name: 'Toggle light/dark' }).click();
    }
}

test('long run details preserve the mobile run selector and embedded controls fit the window', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await awaitMainUI(page, server.baseURL);
    await selectAsh(page);
    await configureIllustration(page);
    await clickWandMenuItem(page, '#sd_illustration_generate_last');
    await expect(page.locator('#luker-sd-run-panel-pill')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => {
        const runs = window.Luker?.getContext?.().runPanel?.getRunRecorder?.()?.currents() || [];
        return runs.some(run => run.source === 'sd' && run.status === 'error');
    }, null, { timeout: 60_000 });
    await expect(page.locator('#toast-container')).toContainText('Image generation failed');
    await acknowledgeNotifications(page);

    await page.setViewportSize({ width: 375, height: 812 });
    const initialScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    const win = await openWorkbench(page);
    await win.locator('.wb-tab').filter({ hasText: /^Image Generation$/ }).click();
    const lens = win.locator('.sdlens');
    await lens.getByRole('button', { name: 'Run Traces', exact: true }).click();
    await expect(lens.locator('.sdlens-runs-list button')).toHaveCount(1);
    await expect(lens.locator('.sdlens-runs-detail pre').filter({ hasText: 'Coastal chart detail 90:' })).toHaveText(IMAGE_PROMPT);
    await expect(lens.locator('.sdlens-runs-detail h3')).toHaveText('Ash the Cartographer');

    for (const width of [375, 800, 1280]) {
        await page.setViewportSize({ width, height: 812 });
        await expect.poll(() => lens.evaluate(el => {
            const list = el.querySelector('.sdlens-runs-list');
            const card = list.querySelector('button');
            const listRect = list.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            return listRect.height >= cardRect.height
                && cardRect.top >= listRect.top
                && cardRect.bottom <= listRect.bottom;
        })).toBe(true);
        await expectContainedControls(win);
        const detail = lens.locator('.sdlens-runs-detail');
        expect(await detail.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        await detail.hover();
        await page.mouse.wheel(0, 800);
        await expect(lens.locator('.sdlens-runs-list button')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`runs-${width}.png`) });
    }

    await lens.getByRole('button', { name: 'Image Studio', exact: true }).click();
    await lens.locator('[data-sd-role="studio-new-session"]').click();
    await lens.locator('[data-sd-role="studio-input"]').fill(IMAGE_PROMPT);
    await lens.locator('[data-sd-role="studio-send"]').click();
    await expect(lens.locator('.sdlens-msg.is-assistant').last()).toContainText('Ash studies the coastline');
    await expect(lens.locator('.sdlens-msg.is-user > div').last()).toHaveText(IMAGE_PROMPT);
    for (const width of [375, 800, 1280]) {
        await page.setViewportSize({ width, height: 812 });
        await expectContainedControls(win);
        const input = lens.locator('[data-sd-role="studio-input"]');
        await input.fill('Keep the coastline visible beneath the lantern light.');
        const messages = lens.locator('.sdlens-studio-messages');
        await expect.poll(() => lens.evaluate(el => {
            const message = el.querySelector('.sdlens-msg.is-user');
            const pane = el.querySelector('.sdlens-studio-messages');
            return message.getBoundingClientRect().height > pane.clientHeight;
        })).toBe(true);
        await messages.hover();
        await page.mouse.wheel(0, await messages.evaluate(el => el.scrollHeight));
        const branch = lens.locator('.sdlens-msg.is-assistant').last().getByRole('button', { name: 'Branch from here' });
        const activeSession = lens.locator('.sdlens-session-item.is-active');
        const sessionId = await activeSession.getAttribute('data-studio-session-id');
        await branch.click();
        await expect(activeSession).not.toHaveAttribute('data-studio-session-id', sessionId);
        await expect(lens.locator('.sdlens-msg.is-user > div').last()).toHaveText(IMAGE_PROMPT);
    }

    await lens.getByRole('button', { name: 'Character Archive', exact: true }).click();
    await lens.locator('[data-sd-role="new-profile"]').first().click();
    const profileName = lens.locator('[data-sd-field="profile-name"]');
    const profileDescription = lens.locator('[data-sd-field="profile-description"]');
    await profileName.fill('Ash Coastal Survey');
    const descriptionText = 'Weatherproof blue coastal survey coat with brass fastenings and salt-marked sleeves.';
    for (const width of [375, 800, 1280]) {
        await page.setViewportSize({ width, height: 812 });
        await expect.poll(() => win.evaluate(el => {
            const layer = el.closest('.wbench').getBoundingClientRect();
            return layer.width === innerWidth && layer.height === innerHeight
                && el.getAnimations().every(animation => animation.playState !== 'running');
        })).toBe(true);
        await clickInCharacterDetail(page, profileName);
        await expectInsideCharacterDetail(profileName);
        await clickInCharacterDetail(page, profileDescription);
        await profileDescription.fill(descriptionText);
        await expectInsideCharacterDetail(profileDescription);
        await expectContainedControls(win);
    }
    await lens.locator('[data-sd-role="save-profile"]').click();
    await expect(lens.locator('.sdlens-chars-list-pane')).toContainText('Ash Coastal Survey');
    await lens.getByRole('button', { name: 'Image Studio', exact: true }).click();
    await lens.getByRole('button', { name: 'Character Archive', exact: true }).click();
    await lens.locator('.sdlens-chars-list-pane button').filter({ hasText: 'Ash Coastal Survey' }).click();
    await expect(lens.locator('[data-sd-field="profile-description"]')).toHaveValue(descriptionText);

    await page.setViewportSize({ width: 375, height: 812 });
    for (const theme of ['light', 'dark']) {
        await setWorkbenchTheme(page, win, theme);
        const orch = await openOrchWorkspace(page, 'setup');
        await expectContainedControls(win);
        const controlTheme = await orch.evaluate(root => {
            const select = root.querySelector('.ol-setup-bar select');
            const style = getComputedStyle(select);
            const surface = getComputedStyle(root);
            return {
                color: style.color,
                surfaceColor: surface.color,
                background: style.backgroundColor,
                appearance: style.appearance,
                arrow: style.backgroundImage,
            };
        });
        expect(controlTheme.color).toBe(controlTheme.surfaceColor);
        expect(controlTheme.background).toBe(theme === 'light' ? 'rgb(246, 247, 249)' : 'rgb(25, 27, 32)');
        expect(controlTheme.appearance).toBe('none');
        expect(controlTheme.arrow).not.toBe('none');
        for (const view of ['history', 'stats', 'notes', 'settings']) {
            await openOrchWorkspace(page, view);
            await expectContainedControls(win);
        }
        await switchWorkbenchTab(page, 'home');
        await expectContainedControls(win);
    }
    await closeWorkbench(page);
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(initialScroll);

    for (const locale of ['zh-cn', 'zh-tw']) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await Promise.all([
            page.waitForEvent('load'),
            page.locator('#ui_language_select').selectOption(locale),
        ]);
        await page.waitForFunction(() => document.getElementById('preloader') === null
            && performance.getEntriesByName('[init] complete').length > 0);
        await openWorkbench(page);
        await workbenchWindow(page).locator('.wb-tab').filter({ hasText: /^图像生成|^圖像生成/ }).click();
        const localizedLens = workbenchWindow(page).locator('.sdlens');
        await localizedLens.getByRole('button', { name: /运行轨迹|執行軌跡/ }).click();
        await expect(localizedLens.locator('.sdlens-runs-detail > div').first()).toContainText(/失败|失敗/);
        await expect(localizedLens.locator('.sdlens-runs-detail > div').first()).not.toContainText('error');
        await expectContainedControls(workbenchWindow(page));
        await closeWorkbench(page);
    }
});
