// #103 — Switch UI language via localStorage 'language' key (the same
// surface as the dropdown in User Settings); reload; assert a few key
// labels picked up the translation; persist across restart.
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
 * Read i18n-driven title of a known drawer button by id.
 * `data-i18n="[title]Persona Management"` plus an attribute mutation
 * observer in i18n.js means the title attribute carries the translated
 * value once locale data has loaded.
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

async function setLanguageAndReload(page, baseURL, code) {
    await page.evaluate((c) => {
        if (c) localStorage.setItem('language', c);
        else localStorage.removeItem('language');
    }, code);
    await reloadAndAwait(page, baseURL);
}

test.describe('#103 — i18n language switch persists and labels translate', () => {
    test('zh-CN → zh-TW → en cycles with persistence + label assertions', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Baseline: English (or browser default). We don't care what the
        // exact baseline is — only that each switch produces the expected
        // translated string for that locale.

        // --- zh-CN ---
        await setLanguageAndReload(page, server.baseURL, 'zh-cn');
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
        await setLanguageAndReload(page, server.baseURL, 'en');
        titles = await drawerTitles(page);
        expect(titles.stored).toBe('en');
        expect(titles.persona).toBe('Persona Management');
        expect(titles.user).toBe('User Settings');

        // --- zh-TW ---
        await setLanguageAndReload(page, server.baseURL, 'zh-tw');
        titles = await drawerTitles(page);
        expect(titles.stored).toBe('zh-tw');
        expect(titles.persona, `persona title not localized to zh-TW; got "${titles.persona}"`).toBe('使用者角色管理');
        expect(titles.user, `user-settings title not localized to zh-TW; got "${titles.user}"`).toBe('使用者設定');
    });
});
