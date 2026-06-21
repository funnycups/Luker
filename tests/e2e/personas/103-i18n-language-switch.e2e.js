// #103 — Switch UI language via the real `#ui_language_select` dropdown
// in User Settings; the change handler calls localStorage.setItem +
// location.reload() automatically. Assert key labels picked up the
// translation; persist across server restart.
//
// Per `feedback_i18n_text_conventions`: zh-CN, zh-TW, and en must all
// render correctly. We pick stable strings ("Persona Management" and
// "User Settings") that exist in all three locales.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'i18n-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Read i18n-driven title of a known drawer button by id, plus the
 * <html lang> attribute and the persisted localStorage key.
 *
 * `data-i18n="[title]Persona Management"` + the attribute observer in
 * i18n.js means the title attribute carries the translated value once
 * locale data has loaded.
 */
async function drawerTitles(page) {
    return page.evaluate(() => {
        const personaBtn = document.querySelector('#persona-management-button .drawer-icon');
        const userBtn = document.querySelector('#user-settings-button .drawer-icon');
        const charBtn = document.querySelector('#rightNavDrawerIcon');
        return {
            persona: personaBtn?.getAttribute('title') ?? '',
            user: userBtn?.getAttribute('title') ?? '',
            character: charBtn?.getAttribute('title') ?? '',
            lang: document.documentElement.lang || '',
            stored: localStorage.getItem('language') || '',
        };
    });
}

/**
 * Open the User Settings drawer (the canonical home of #ui_language_select)
 * and select the requested language option via real .selectOption. The
 * page reloads automatically as part of the change handler.
 */
async function setLanguageViaDropdownAndReload(page, baseURL, code) {
    // Open the User Settings drawer so the language select is visible.
    const closed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count();
    if (closed > 0) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const icon = document.querySelector('#user-settings-button .drawer-icon');
            return icon && icon.classList.contains('openIcon');
        }, { timeout: 5000 }).catch(() => {});
    }

    const sel = page.locator('#ui_language_select');
    await sel.waitFor({ state: 'visible', timeout: 10_000 });
    await sel.scrollIntoViewIfNeeded().catch(() => {});

    // The change handler calls location.reload() — that races with our
    // post-select wait. Wrap in waitForFunction polling localStorage to
    // confirm the value persisted (proves the change handler fired even if
    // the reload happens before we can chain a .waitForLoadState).
    if (code === '') {
        // Empty option = browser default; the option's value is "".
        await sel.selectOption({ value: '' });
    } else {
        await sel.selectOption({ value: code });
    }

    // The change handler triggers a full page reload — wait for the
    // preloader to vanish and the UI to come back, then we re-assert.
    await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: 60_000 });
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
}

test.describe('#103 — i18n language switch via real dropdown persists and labels translate', () => {
    test('zh-CN -> zh-TW -> en cycles with persistence + label assertions', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Baseline: English (or browser default). We don't care what the
        // exact baseline is — only that each switch produces the expected
        // translated string for that locale.

        // --- zh-CN ---
        await setLanguageViaDropdownAndReload(page, server.baseURL, 'zh-cn');
        let titles = await drawerTitles(page);
        expect(titles.stored).toBe('zh-cn');
        expect(titles.lang).toBe('zh-cn');
        expect(titles.persona, `persona title not localized to zh-CN; got "${titles.persona}"`).toBe('用户设定管理');
        expect(titles.user, `user-settings title not localized to zh-CN; got "${titles.user}"`).toBe('用户设置');

        // Restart server, reload — localStorage survives reload trivially
        // but a server restart shouldn't drop us back to English either.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        titles = await drawerTitles(page);
        expect(titles.stored).toBe('zh-cn');
        expect(titles.persona).toBe('用户设定管理');

        // --- en ---
        await setLanguageViaDropdownAndReload(page, server.baseURL, 'en');
        titles = await drawerTitles(page);
        expect(titles.stored).toBe('en');
        expect(titles.persona).toBe('Persona Management');
        expect(titles.user).toBe('User Settings');

        // --- zh-TW ---
        await setLanguageViaDropdownAndReload(page, server.baseURL, 'zh-tw');
        titles = await drawerTitles(page);
        expect(titles.stored).toBe('zh-tw');
        expect(titles.persona, `persona title not localized to zh-TW; got "${titles.persona}"`).toBe('使用者角色管理');
        expect(titles.user, `user-settings title not localized to zh-TW; got "${titles.user}"`).toBe('使用者設定');
    });
});
